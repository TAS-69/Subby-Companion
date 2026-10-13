import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Store } from '../src/store.js';
import { createCompanion } from '../src/server.js';
import { createConsole } from '../src/console.js';

function temporary() { return mkdtempSync(join(tmpdir(), 'subby-console-')); }
function remove(directory) {
  directory = resolve(directory); assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('subby-console-'));
  rmSync(directory, { recursive: true, force: true });
}
function link(store, id, login, label) {
  const pair = store.pair(null, [], label), cookie = 'fixture-cookie';
  const state = store.beginOAuth(store.pairing(pair.code), cookie); store.reserveOAuth(state);
  store.pending(state, { user: { id, login, display_name: login }, tokens: { access_token: 'private-access', refresh_token: 'private-refresh', scope: ['channel:read:subscriptions'], expiresAt: Date.now() + 3600000, validatedAt: Date.now() } });
  store.link(state, cookie); return pair;
}
async function until(check) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for console delivery.'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('Falix stdin simulation follows authenticated delivery, isolates channels, and buffers offline installations', async () => {
  const directory = temporary(), encryption = randomBytes(32).toString('base64');
  let store = new Store(directory, encryption), app, operator, socket;
  try {
    const online = link(store, '123', 'creator', 'Survival'), offline = link(store, '123', 'creator', 'Hardcore'), other = link(store, '456', 'other', 'Other channel');
    app = createCompanion(store, { baseUrl: 'http://localhost:3030', clientId: 'fixture', clientSecret: 'secret' }, {});
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const messages = [], output = [], input = new PassThrough();
    socket = new WebSocket('ws://127.0.0.1:' + app.server.address().port + '/v1/events?instanceId=' + online.instanceId, { headers: { Authorization: 'Bearer ' + online.token } });
    socket.on('message', bytes => messages.push(JSON.parse(bytes))); await once(socket, 'open');
    operator = createConsole(store, app, { input, write: line => output.push(line) });
    input.write('subby test sub CREATOR TestViewer 2\n');
    await until(() => messages.some(message => message.type === 'event'));
    const frame = messages.find(message => message.type === 'event'), event = frame.event;
    assert.equal(event.kind, 'sub'); assert.equal(event.name, '[TEST] TestViewer'); assert.equal(event.tier, '2000'); assert.equal(event.months, 1);
    assert.equal(event.broadcasterId, '123'); assert.match(event.userId, /^subby-test-[a-f0-9]{40}$/);
    assert.equal(event.details.login, 'subby_test_testviewer'); assert.equal(event.details.simulated, 'true'); assert.ok(Date.parse(event.receivedAt));
    assert.equal(store.count(offline.instanceId), 1); assert.equal(store.count(other.instanceId), 0);
    assert.match(output.join('\n'), /2 Minecraft installation\(s\); 1 currently connected/);
    assert.doesNotMatch(output.join('\n'), /private-access|private-refresh/);
    socket.send(JSON.stringify({ type: 'ack', seq: frame.seq })); await until(() => store.count(online.instanceId) === 0);
    operator.close(); operator = null; socket.terminate(); await app.close(); app = null; store.close();
    store = new Store(directory, encryption);
    assert.equal(store.count(online.instanceId), 0); assert.equal(store.count(offline.instanceId), 1);
    assert.equal(JSON.parse(store.outstanding(offline.instanceId)[0].event).name, '[TEST] TestViewer');
  } finally { operator?.close(); socket?.terminate(); if (app) await app.close(); store.close(); remove(directory); }
});

test('console simulation requires an unambiguous linked target and validates inputs without executing arbitrary text', () => {
  const directory = temporary(), store = new Store(directory, randomBytes(32).toString('base64'));
  const output = [], input = new PassThrough(); let stopped = 0;
  const operator = createConsole(store, { notify: () => {}, connected: () => false }, { input, write: line => output.push(line), stop: () => stopped++ });
  try {
    operator.command('subby test sub'); assert.match(output.at(-1), /Connect a Twitch channel/);
    const first = link(store, '123', 'creator', 'Survival');
    operator.command('subby test sub');
    const initial = JSON.parse(store.outstanding(first.instanceId)[0].event);
    assert.equal(initial.name, '[TEST] TestViewer'); assert.equal(initial.tier, '1000');
    const second = link(store, '456', 'other', 'Other channel');
    for (const command of ['subby test sub', 'subby test sub unknown TestViewer', 'subby test sub creator Bad;Name', 'subby test sub creator TestViewer 0', 'subby test sub creator TestViewer 4', 'subby test gift creator TestViewer', 'process.exit()', 'subby test sub creator TestViewer 1 extra']) operator.command(command);
    assert.equal(store.count(first.instanceId), 1); assert.equal(store.count(second.instanceId), 0); assert.equal(stopped, 0);
    operator.command('subby test sub ' + second.instanceId + ' CustomViewer 3');
    assert.equal(store.count(second.instanceId), 1); assert.equal(JSON.parse(store.outstanding(second.instanceId)[0].event).tier, '3000');
    operator.command('subby test sub creator TestViewer 1');
    const repeated = JSON.parse(store.outstanding(first.instanceId)[1].event);
    assert.equal(repeated.userId, initial.userId); assert.notEqual(repeated.messageId, initial.messageId);
    operator.command('subby channels'); assert.match(output.join('\n'), new RegExp(first.instanceId)); assert.match(output.join('\n'), /Minecraft offline/);
    operator.command('stop'); assert.equal(stopped, 1);
  } finally { operator.close(); store.close(); remove(directory); }
});
