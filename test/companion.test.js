import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { Store } from '../src/store.js';
import { createCompanion } from '../src/server.js';
import { Twitch } from '../src/twitch.js';
import { normalize, selectedEvents, scopes } from '../src/catalog.js';

const key = () => randomBytes(32).toString('base64');
function removeTemporary(directory) {
  const target = resolve(directory);
  assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('subby-'));
  rmSync(target, { recursive: true, force: true });
}
const entry = (id = 'event-1', channel = '123') => ({ messageId: id, broadcasterId: channel, userId: '456', name: 'PixelFox', kind: 'sub', tier: '1000', months: 1, receivedAt: new Date().toISOString(), details: { login: 'pixelfox' } });
function linked(store, events = []) {
  const pair = store.pair(null, events, 'Test world');
  const cookie = 'private-cookie', state = store.beginOAuth(store.pairing(pair.code), cookie);
  store.reserveOAuth(state);
  store.pending(state, { user: { id: '123', login: 'creator', display_name: 'Creator' }, tokens: { access_token: 'private-access', refresh_token: 'private-refresh', scope: scopes(selectedEvents(events)), expiresAt: Date.now() + 3600000, validatedAt: Date.now() } });
  store.link(state, cookie); return pair;
}
async function until(check, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('default permissions are subscriptions only and optional normalization is explicit', () => {
  assert.deepEqual(scopes(selectedEvents()), ['channel:read:subscriptions']);
  assert.ok(scopes(selectedEvents(['bits'])).includes('bits:read'));
  assert.throws(() => selectedEvents(['unsupported']));
  const message = { metadata: { message_id: 'id', message_timestamp: '2026-10-13T10:00:00Z' }, payload: { subscription: { type: 'channel.subscribe' }, event: { broadcaster_user_id: '123', user_id: '456', user_name: 'Pixel§Fox\n', user_login: 'pixelfox', tier: '1000', is_gift: true } } };
  assert.equal(normalize(message).kind, 'gift'); assert.equal(normalize(message).name, 'PixelFox');
  assert.equal(normalize(message).details.gifter, undefined);
  message.payload.subscription.type = 'channel.chat.message'; message.payload.event = { broadcaster_user_id: '123', chatter_user_id: '789', chatter_user_name: 'Chatter', chatter_user_login: 'chatter' };
  assert.equal(normalize(message).userId, '789');
});

test('tokens are encrypted, duplicate events suppressed, acknowledgements and outage backlog survive restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), encryption = key();
  let store = new Store(directory, encryption);
  try {
    const pair = linked(store);
    assert.equal(store.instance(pair.instanceId, 'wrong'), null);
    assert.ok(store.deliver(entry())); assert.equal(store.deliver(entry()), false);
    assert.equal(store.count(pair.instanceId), 1);
    store.close(); store = new Store(directory, encryption);
    assert.equal(store.count(pair.instanceId), 1);
    const row = store.outstanding(pair.instanceId)[0]; assert.equal(JSON.parse(row.event).name, 'PixelFox');
    store.ack(pair.instanceId, row.seq); assert.equal(store.count(pair.instanceId), 0);
    assert.ok(!store.db.prepare('SELECT tokens FROM accounts').get().tokens.includes('private-access'));
    assert.equal(store.tokens('123').refresh_token, 'private-refresh');
    assert.throws(() => new Store(directory, key()));
    store.unlink(pair.instanceId); assert.equal(store.accounts().length, 0);
  } finally { store.close(); removeTemporary(directory); }
});

test('browser pairing requires matching cookie, CSRF, confirmation and cannot silently switch channel', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key());
  const config = { baseUrl: 'http://localhost:3030', clientId: 'client', clientSecret: 'secret' };
  let started = 0;
  const twitch = { token: async () => ({ access_token: 'private-access', refresh_token: 'private-refresh', scope: ['channel:read:subscriptions'] }), identity: async () => ({ id: '123', login: 'creator', display_name: 'Creator' }), start: () => started++, maintain: async () => {} };
  const app = createCompanion(store, config, twitch);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, input, headers = {}) => fetch(address + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input), redirect: 'manual' });
  try {
    const pair = await (await post('/v1/pair', { events: [] })).json();
    const page = await fetch(address + '/link?code=' + pair.code), cookie = page.headers.get('set-cookie').split(';')[0];
    const formSources = response => response.headers.get('content-security-policy').split(';').map(value => value.trim()).find(value => value.startsWith('form-action ')).split(/\s+/).slice(1);
    assert.deepEqual(formSources(page), ["'self'", 'https://id.twitch.tv', 'https://www.twitch.tv']);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
    assert.equal((await post('/oauth/start', { code: pair.code, csrf }, { Cookie: cookie, Origin: 'https://attacker.invalid' })).status, 400);
    const begin = await post('/oauth/start', { code: pair.code, csrf }, { Cookie: cookie, Origin: config.baseUrl });
    assert.equal(begin.status, 303);
    const location = new URL(begin.headers.get('location')), state = location.searchParams.get('state');
    assert.equal(location.origin, 'https://id.twitch.tv');
    assert.equal(location.pathname, '/oauth2/authorize');
    assert.deepEqual(formSources(begin), formSources(page));
    assert.equal(location.searchParams.get('scope'), 'channel:read:subscriptions');
    assert.equal((await fetch(address + '/oauth/callback?state=' + state + '&code=code')).status, 400);
    const callback = await fetch(address + '/oauth/callback?state=' + state + '&code=code', { headers: { Cookie: cookie } });
    assert.match(await callback.text(), /Creator/);
    assert.equal(store.accounts().length, 0);
    assert.equal((await post('/link/confirm', { csrf, state }, { Cookie: cookie, Origin: config.baseUrl })).status, 200);
    assert.equal(started, 1); assert.equal(store.accounts().length, 1);
    assert.equal((await post('/link/confirm', { csrf, state }, { Cookie: cookie, Origin: config.baseUrl })).status, 400);
    assert.equal((await post('/v1/pair', { instanceId: pair.instanceId })).status, 401);
    assert.equal((await post('/v1/unlink', { instanceId: pair.instanceId }, { Authorization: 'Bearer ' + pair.token })).status, 200);
    assert.equal(store.accounts().length, 0);
  } finally { await app.close(); store.close(); removeTemporary(directory); }
});

test('authenticated WebSocket replays only unacknowledged events and isolates installations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key());
  const config = { baseUrl: 'http://localhost:3030', clientId: 'client', clientSecret: 'secret' };
  const app = createCompanion(store, config, {}); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const pair = linked(store), other = store.pair(null, [], 'Other world');
  const address = 'ws://127.0.0.1:' + app.server.address().port + '/v1/events?instanceId=';
  let socket;
  async function connect() {
    const received = [];
    socket = new WebSocket(address + pair.instanceId, { headers: { Authorization: 'Bearer ' + pair.token } });
    socket.on('message', data => received.push(JSON.parse(data.toString()))); await once(socket, 'open'); return received;
  }
  try {
    store.deliver(entry('one')); store.deliver(entry('two'));
    let messages = await connect(); await until(() => messages.filter(m => m.type === 'event').length === 2);
    const first = messages.find(m => m.type === 'event'); socket.send(JSON.stringify({ type: 'ack', seq: first.seq }));
    await until(() => store.count(pair.instanceId) === 1);
    socket.terminate(); await once(socket, 'close');
    messages = await connect(); await until(() => messages.some(m => m.type === 'event'));
    assert.equal(messages.filter(m => m.type === 'event').length, 1);
    assert.equal(messages.find(m => m.type === 'event').event.messageId, 'two');
    assert.equal(store.count(other.instanceId), 0);
    socket.send(JSON.stringify({ type: 'ack', seq: first.seq })); await once(socket, 'close');
  } finally { socket?.terminate(); await app.close(); store.close(); removeTemporary(directory); }
});

test('real local EventSub socket subscribes minimally and normalizes duplicate notifications once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key()), pair = linked(store);
  const hub = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(hub, 'listening');
  const requests = [], delivered = [];
  const twitch = new Twitch(store, { clientId: 'client', clientSecret: 'secret' }, channel => delivered.push(channel), {
    socketUrl: 'ws://127.0.0.1:' + hub.address().port,
    fetch: async (url, request) => { requests.push(JSON.parse(request.body)); return new Response('{}', { status: 202 }); }
  });
  hub.on('connection', socket => {
    socket.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'session', keepalive_timeout_seconds: 10 } } }));
    const notification = { metadata: { message_type: 'notification', message_id: 'real', message_timestamp: new Date().toISOString() }, payload: { subscription: { type: 'channel.subscribe' }, event: { broadcaster_user_id: '123', user_id: '456', user_name: 'PixelFox', user_login: 'pixelfox', tier: '1000', is_gift: false } } };
    socket.send(JSON.stringify(notification)); socket.send(JSON.stringify(notification));
  });
  try {
    twitch.start('123'); await until(() => delivered.length === 1);
    assert.deepEqual(requests.map(r => r.type).sort(), ['channel.subscribe', 'channel.subscription.message']);
    assert.equal(store.count(pair.instanceId), 1);
    assert.equal(requests[0].transport.session_id, 'session');
  } finally { await twitch.close(); await new Promise(resolve => hub.close(resolve)); store.close(); removeTemporary(directory); }
});

test('recovery uses current subscriptions, unknown historic months, and only the requesting installation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key());
  const pair = linked(store), other = linked(store);
  const twitch = new Twitch(store, { clientId: 'client', clientSecret: 'secret' }, () => {}, {
    fetch: async (url, request) => {
      assert.equal(request.method, 'GET'); assert.ok(url.includes('broadcaster_id=123'));
      return Response.json({ data: [{ user_id: '456', user_name: 'Viewer', user_login: 'viewer', tier: '2000', gifter_name: '' }], pagination: {} });
    }
  });
  try {
    assert.equal(await twitch.recover(store.instance(pair.instanceId, pair.token)), 1);
    assert.equal(await twitch.recover(store.instance(pair.instanceId, pair.token)), 0);
    assert.equal(store.count(other.instanceId), 0);
    const event = JSON.parse(store.outstanding(pair.instanceId)[0].event); assert.equal(event.months, 0); assert.equal(event.details.timestamp_known, 'false'); assert.equal(event.kind, 'sync');
  } finally { await twitch.close(); store.close(); removeTemporary(directory); }
});

test('chat controls require moderator badges and feedback remains opt in', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key()), pair = linked(store, ['bot']);
  const sent = [];
  store.db.prepare('UPDATE instances SET bot=? WHERE id=?').run(JSON.stringify({ enabled: true, style: 'silent' }), pair.instanceId);
  const twitch = new Twitch(store, { clientId: 'client', clientSecret: 'secret' }, () => {}, { fetch: async (url, request) => { sent.push(JSON.parse(request.body)); return Response.json({ data: [{ is_sent: true }] }); } });
  try {
    const event = { ...entry('chat-1'), kind: 'first_chat' };
    await twitch.chat({ chatter_user_id: '456', badges: [], message: { text: '!subby pause' } }, event); assert.equal(store.count(pair.instanceId), 0); assert.equal(sent.length, 0);
    const authorized = { ...event, messageId: 'chat-2' };
    await twitch.chat({ chatter_user_id: '456', badges: [{ set_id: 'moderator' }], message: { text: '!subby pause' } }, authorized);
    const command = JSON.parse(store.outstanding(pair.instanceId)[0].event); assert.equal(command.kind, 'control'); assert.equal(command.details.command, 'pause');
    assert.equal(sent.length, 1); twitch.botLast.clear();
    await twitch.chat({ chatter_user_id: '456', badges: [{ set_id: 'moderator' }], message: { text: '!subby pause' } }, authorized);
    assert.equal(sent.length, 1); await twitch.feedback(entry('sub-1')); assert.equal(sent.length, 1);
  } finally { await twitch.close(); store.close(); removeTemporary(directory); }
});

test('expired tokens refresh once under concurrent requests and are validated before use', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key()); linked(store);
  const tokens = store.tokens('123'); tokens.expiresAt = 0; store.saveTokens('123', tokens);
  let refreshes = 0, validations = 0;
  const twitch = new Twitch(store, { clientId: 'client', clientSecret: 'secret' }, () => {}, { fetch: async url => {
    if (url.endsWith('/token')) { refreshes++; return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600, scope: ['channel:read:subscriptions'] }); }
    validations++; return Response.json({ client_id: 'client', user_id: '123', scopes: ['channel:read:subscriptions'], expires_in: 3600 });
  } });
  try {
    const results = await Promise.all([twitch.access('123'), twitch.access('123'), twitch.access('123')]);
    assert.equal(refreshes, 1); assert.equal(validations, 1); assert.ok(results.every(t => t.access_token === 'rotated-access')); assert.equal(store.tokens('123').refresh_token, 'rotated-refresh');
  } finally { await twitch.close(); store.close(); removeTemporary(directory); }
});

test('pairing another installation preserves permissions needed by the existing installation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key()), previous = linked(store, ['bits']);
  const pair = store.pair(null, [], 'Second world'), config = { baseUrl: 'http://localhost:3030', clientId: 'client', clientSecret: 'secret' };
  let tokenCalls = 0;
  const twitch = { token: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', scope: ++tokenCalls === 1 ? ['channel:read:subscriptions'] : ['channel:read:subscriptions', 'bits:read'] }), identity: async () => ({ id: '123', login: 'creator', display_name: 'Creator' }), start: () => {}, maintain: async () => {} };
  const app = createCompanion(store, config, twitch); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = 'http://127.0.0.1:' + app.server.address().port;
  try {
    const page = await fetch(address + '/link?code=' + pair.code), cookie = page.headers.get('set-cookie').split(';')[0], csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
    const begin = await fetch(address + '/oauth/start', { method: 'POST', headers: { Cookie: cookie, Origin: config.baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pair.code, csrf }), redirect: 'manual' });
    const state = new URL(begin.headers.get('location')).searchParams.get('state');
    const retry = await fetch(address + '/oauth/callback?state=' + state + '&code=first', { headers: { Cookie: cookie }, redirect: 'manual' }); assert.equal(retry.status, 303);
    const redirected = new URL(retry.headers.get('location')); assert.ok(redirected.searchParams.get('scope').includes('bits:read'));
    const secondState = redirected.searchParams.get('state');
    assert.equal((await fetch(address + '/oauth/callback?state=' + secondState + '&code=second', { headers: { Cookie: cookie } })).status, 200);
    const confirm = await fetch(address + '/link/confirm', { method: 'POST', headers: { Cookie: cookie, Origin: config.baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ csrf, state: secondState }) }); assert.equal(confirm.status, 200);
    assert.ok(store.tokens('123').scope.includes('bits:read')); assert.ok(store.instance(previous.instanceId, previous.token).events.includes('bits')); assert.ok(!store.instance(pair.instanceId, pair.token).events.includes('bits'));
  } finally { await app.close(); store.close(); removeTemporary(directory); }
});

test('pending optional permissions do not stop subscriptions or replace a live Twitch socket', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key()); linked(store, ['bits']);
  const tokens = store.tokens('123'); tokens.scope = ['channel:read:subscriptions']; store.saveTokens('123', tokens);
  const hub = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(hub, 'listening');
  let connections = 0; const requests = [];
  hub.on('connection', socket => { connections++; socket.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'stable-session', keepalive_timeout_seconds: 30 } } })); });
  const twitch = new Twitch(store, { clientId: 'client', clientSecret: 'secret' }, () => {}, { socketUrl: 'ws://127.0.0.1:' + hub.address().port, fetch: async (url, request) => { const body = JSON.parse(request.body); requests.push(body); return Response.json({ data: [{ id: body.type }] }, { status: 202 }); } });
  try {
    twitch.start('123'); await until(() => twitch.connections.get('123')?.welcomed);
    assert.deepEqual(requests.map(r => r.type).sort(), ['channel.subscribe', 'channel.subscription.message']);
    assert.match(store.accounts()[0].status, /^Listening/);
    const approved = store.tokens('123'); approved.scope.push('bits:read'); store.saveTokens('123', approved); twitch.start('123');
    await until(() => requests.length === 3); assert.equal(requests[2].type, 'channel.cheer'); assert.equal(connections, 1);
  } finally { await twitch.close(); await new Promise(resolve => hub.close(resolve)); store.close(); removeTemporary(directory); }
});

test('a preserved Minecraft library cannot be linked to a different Twitch account', () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key());
  try {
    const pair = store.pair(null, [], 'Existing library', '123'), state = store.beginOAuth(store.pairing(pair.code), 'cookie');
    store.reserveOAuth(state); store.pending(state, { user: { id: '999', login: 'different', display_name: 'Different' }, tokens: { access_token: 'access', refresh_token: 'refresh', scope: ['channel:read:subscriptions'] } });
    assert.throws(() => store.link(state, 'cookie'), /another Twitch channel/); assert.equal(store.accounts().length, 0); assert.equal(store.instance(pair.instanceId, pair.token).channel, null);
  } finally { store.close(); removeTemporary(directory); }
});

test('slow optional chat feedback never delays saving a subscription', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'subby-')), store = new Store(directory, key()), pair = linked(store, ['bot']);
  store.db.prepare('UPDATE instances SET bot=? WHERE id=?').run(JSON.stringify({ enabled: true, style: 'cute' }), pair.instanceId);
  let finishReply;
  const twitch = new Twitch(store, { clientId: 'client', clientSecret: 'secret' }, () => {}, { fetch: () => new Promise(resolve => { finishReply = resolve; }) });
  try {
    const notification = { metadata: { message_type: 'notification', message_id: 'priority-book', message_timestamp: new Date().toISOString() }, payload: { subscription: { type: 'channel.subscribe' }, event: { broadcaster_user_id: '123', user_id: '456', user_name: 'Viewer', user_login: 'viewer', tier: '1000', is_gift: false } } };
    await twitch.notification(notification, '123'); assert.equal(store.count(pair.instanceId), 1);
    await until(() => finishReply); finishReply(Response.json({ data: [{ is_sent: true }] }));
  } finally { if (finishReply) finishReply(Response.json({ data: [] })); await twitch.close(); store.close(); removeTemporary(directory); }
});
