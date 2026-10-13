import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import { hash, secret } from './store.js';
import { scopes, clean } from './catalog.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cookieValue = request => request.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('subby_link='))?.slice(11);
const stylesheet = readFileSync(new URL('../web/style.css', import.meta.url));

export function createCompanion(store, config, twitch) {
  const clients = new Map(), rates = new Map(), recoveries = new Map();
  const base = new URL(config.baseUrl), secure = base.protocol === 'https:';
  const json = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  const html = (response, title, body, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Subby</title><link rel="stylesheet" href="/style.css"></head><body><main><a class="brand" href="/">Subby<span>Companion</span></a><h1>${escape(title)}</h1>${body}<footer>Subscriber names, written for you.</footer></main></body></html>`);
  };
  const error = (response, message, status = 400) => json(response, status, { error: message });
  async function body(request) {
    let size = 0, parts = [];
    for await (const part of request) { size += part.length; if (size > 8192) throw new Error('Request too large.'); parts.push(part); }
    const text = Buffer.concat(parts).toString('utf8');
    return request.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text || '{}');
  }
  function authenticate(request, id) {
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    return store.instance(id, token);
  }
  function rate(request, key, max) {
    const id = request.socket.remoteAddress + ':' + key, now = Date.now();
    let entry = rates.get(id);
    if (!entry || entry.reset < now) { entry = { reset: now + 60000, n: 0 }; rates.set(id, entry); }
    if (++entry.n > max) throw new Error('Too many attempts. Wait a minute and try again.');
  }
  function cookie(response, value) {
    response.setHeader('Set-Cookie', `subby_link=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}`);
  }
  function csrf(request, input) {
    const value = cookieValue(request);
    if (!value || input.csrf !== hash(value) || request.headers.origin !== base.origin) throw new Error('This page expired. Open the pairing link again.');
    return value;
  }
  function authorize(response, state, events) {
    const location = new URL('https://id.twitch.tv/oauth2/authorize');
    location.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: base.origin + '/oauth/callback', scope: scopes(events).join(' '), state, force_verify: 'true' });
    response.writeHead(303, { Location: location.toString() }); response.end();
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self' https://id.twitch.tv https://www.twitch.tv; frame-ancestors 'none'; base-uri 'none'");
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(request.url, base);
      if (url.pathname === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok', protocol: 1 });
      if (url.pathname === '/style.css' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); response.end(stylesheet); return; }
      if (url.pathname === '/' && request.method === 'GET') return html(response, 'Your Twitch, your Minecraft book.', '<p>Connect from Minecraft with <strong>/subby connect</strong>, then open the private link it gives you.</p><a class="button" href="/link">Enter a pairing code</a><p class="muted">Twitch sign-in stays in your browser. Subby never asks for your Twitch password in Minecraft.</p>');
      if (url.pathname === '/v1/pair' && request.method === 'POST') {
        rate(request, 'pair', 10);
        if (!config.clientId || !config.clientSecret) return error(response, 'The Companion operator has not configured Twitch sign-in yet.', 503);
        const input = await body(request);
        const existing = input.instanceId ? authenticate(request, input.instanceId) : null;
        if (input.instanceId && !store.db.prepare('SELECT 1 FROM instances WHERE id=?').get(input.instanceId)) return error(response, 'This unlinked installation expired. Request a fresh pairing code.', 410);
        if (input.instanceId && !existing) return error(response, 'Invalid installation credentials.', 401);
        const expectedChannel = String(input.expectedChannel ?? '');
        if (expectedChannel && !/^[0-9]{1,64}$/.test(expectedChannel)) throw new Error('Invalid expected Twitch channel.');
        const pair = store.pair(existing, input.events, clean(input.label ?? 'Minecraft', 64), expectedChannel);
        pair.link = base.origin + '/link?code=' + pair.code;
        return json(response, 200, pair);
      }
      if (url.pathname === '/link' && request.method === 'GET') {
        rate(request, 'link', 60);
        const inputCode = url.searchParams.get('code') ?? '';
        const nonce = secret(); cookie(response, nonce);
        const pair = inputCode ? store.pairing(inputCode) : null;
        const introduction = pair ? `<p>Link Twitch to <strong>${escape(pair.label)}</strong>. Match this code to the one shown in Minecraft.</p><div class="code">${escape(inputCode.toUpperCase())}</div>` : '<p>Enter the private pairing code shown in Minecraft. Codes expire after ten minutes.</p>';
        return html(response, 'Connect your Twitch account', `${introduction}<form method="post" action="/oauth/start"><input type="hidden" name="csrf" value="${hash(nonce)}"><label for="code">Minecraft pairing code</label><input id="code" name="code" required maxlength="11" value="${escape(inputCode)}" autocomplete="off" spellcheck="false"><button>Continue with Twitch</button></form><p class="muted">Only link an installation you control. Anyone managing that Minecraft installation can read the events you allow.</p>`);
      }
      if (url.pathname === '/oauth/start' && request.method === 'POST') {
        rate(request, 'oauth', 20);
        const input = await body(request), nonce = csrf(request, input), pair = store.pairing(input.code);
        if (!pair) throw new Error('That pairing code expired or was not found. Run /subby connect again.');
        const events = [...new Set([...JSON.parse(pair.events), ...(pair.channel ? store.events(pair.channel) : [])])];
        const state = store.beginOAuth(pair, nonce);
        authorize(response, state, events); return;
      }
      if (url.pathname === '/oauth/callback' && request.method === 'GET') {
        rate(request, 'callback', 20);
        const state = url.searchParams.get('state'), nonce = cookieValue(request), oauth = store.oauth(state, nonce);
        if (!oauth || oauth.pending) throw new Error('This sign-in expired or was already used. Start again in Minecraft.');
        if (url.searchParams.has('error')) throw new Error('Twitch sign-in was cancelled. You can reconnect from Minecraft whenever you are ready.');
        if (!url.searchParams.get('code')) throw new Error('Twitch did not provide a sign-in code.');
        if (!store.reserveOAuth(state)) throw new Error('This sign-in was already used.');
        const tokens = await twitch.token({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: base.origin + '/oauth/callback' });
        const user = await twitch.identity(tokens);
        const pair = store.pairingHash(oauth.code);
        if (!pair) throw new Error('This pairing code expired.');
        const requiredEvents = [...new Set([...JSON.parse(pair.events), ...store.events(user.id)])];
        if (scopes(requiredEvents).some(scope => !(tokens.scope ?? []).includes(scope))) {
          if (state.startsWith('r_')) throw new Error('Twitch did not approve the required permissions. Start again from Minecraft.');
          const replacement = store.beginOAuth(pair, nonce, true);
          store.db.prepare('DELETE FROM oauth WHERE state=?').run(oauth.state);
          authorize(response, replacement, requiredEvents); return;
        }
        store.pending(state, { user, tokens });
        return html(response, 'Is this your channel?', `<p>You signed in as <strong>${escape(user.display_name)}</strong>.</p><p>Confirm to let this Minecraft installation receive the Twitch events you approved.</p><form method="post" action="/link/confirm"><input type="hidden" name="csrf" value="${hash(nonce)}"><input type="hidden" name="state" value="${escape(state)}"><button>Yes, connect this channel</button></form><p class="muted">Wrong account? Close this page and start again from Minecraft.</p>`);
      }
      if (url.pathname === '/link/confirm' && request.method === 'POST') {
        const input = await body(request), nonce = csrf(request, input);
        const linked = store.link(input.state, nonce);
        twitch.start(linked.channel); notify(linked.channel);
        return html(response, 'You’re connected.', `<div class="success">✓ ${escape(linked.name)}</div><p>Return to Minecraft and get your subscriber book from the Subby menu. Names will appear as subscription events arrive.</p><p class="muted">You can disconnect or remove this sign-in from Minecraft at any time.</p>`);
      }
      if (url.pathname === '/v1/unlink' && request.method === 'POST') {
        const input = await body(request), instance = authenticate(request, input.instanceId);
        if (!store.db.prepare('SELECT 1 FROM instances WHERE id=?').get(input.instanceId ?? '')) return error(response, 'This installation was already removed.', 410);
        if (!instance) return error(response, 'Invalid installation credentials.', 401);
        store.unlink(instance.id); clients.get(instance.id)?.close(1000, 'Unlinked');
        await twitch.maintain(); return json(response, 200, { unlinked: true });
      }
      if (url.pathname === '/v1/bot' && request.method === 'POST') {
        const input = await body(request), instance = authenticate(request, input.instanceId);
        if (!instance) return error(response, 'Invalid installation credentials.', 401);
        if (input.enabled && !instance.events.includes('bot')) throw new Error('Enable the optional bot permission and reconnect first.');
        if (!['silent', 'cute', 'professional', 'chaotic', 'custom'].includes(input.style ?? 'silent')) throw new Error('Choose a supported bot style.');
        const bot = { enabled: input.enabled === true, style: input.style ?? 'silent', template: clean(input.template ?? '', 450) };
        store.db.prepare('UPDATE instances SET bot=? WHERE id=?').run(JSON.stringify(bot), instance.id);
        return json(response, 200, { saved: true });
      }
      if (url.pathname === '/v1/recover' && request.method === 'POST') {
        rate(request, 'recover', 2);
        const input = await body(request), instance = authenticate(request, input.instanceId);
        if (!instance?.channel) return error(response, 'Invalid or unlinked installation credentials.', 401);
        if (recoveries.has(instance.channel)) return error(response, 'This channel already has a recovery in progress.', 409);
        const job = twitch.recover(instance).catch(() => { store.status(instance.channel, 'Recovery interrupted. Names already received are kept; retry when ready.'); notify(instance.channel); }).finally(() => recoveries.delete(instance.channel));
        recoveries.set(instance.channel, job);
        return json(response, 200, { queued: true });
      }
      return error(response, 'Page not found.', 404);
    } catch (e) {
      if (response.headersSent) { response.destroy(); return; }
      const safe = /^(Choose |This |That |Twitch |Invalid |Too many |Enable |The |Request |Could not |An optional |Delivery |Only )/.test(e.message) ? e.message : 'The request could not be completed. Try again from Minecraft.';
      const path = request.url?.split('?')[0] ?? '';
      if (path.startsWith('/link') || path.startsWith('/oauth')) html(response, 'Let’s try that again.', `<p>${escape(safe)}</p><a class="button" href="/link">Return to pairing</a><p class="muted">You can get a fresh code with /subby connect in Minecraft.</p>`, 400);
      else error(response, safe);
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, base), instance = authenticate(request, url.searchParams.get('instanceId'));
      if (url.pathname === '/v1/events' && !store.db.prepare('SELECT 1 FROM instances WHERE id=?').get(url.searchParams.get('instanceId') ?? '')) { socket.end('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n'); return; }
      if (url.pathname !== '/v1/events' || !instance || request.headers.origin) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
      sockets.handleUpgrade(request, socket, head, ws => {
        clients.get(instance.id)?.close(1000, 'Replaced by a new Minecraft connection');
        clients.set(instance.id, ws); ws.instance = instance; ws.inflight = new Set(); ws.after = 0; ws.alive = true;
        ws.send(JSON.stringify({ type: 'welcome', protocol: 1 }));
        ws.on('pong', () => { ws.alive = true; });
        ws.on('error', () => {});
        ws.on('message', bytes => {
          try {
            const message = JSON.parse(bytes.toString());
            if (message.type !== 'ack' || !Number.isSafeInteger(message.seq) || !ws.inflight.has(message.seq)) throw new Error();
            store.ack(instance.id, message.seq); ws.inflight.delete(message.seq); pump(ws);
          } catch { ws.close(1008, 'Invalid acknowledgement'); }
        });
        ws.on('close', () => { if (clients.get(instance.id) === ws) clients.delete(instance.id); });
        status(ws); pump(ws);
      });
    } catch { socket.destroy(); }
  });
  function status(ws) {
    const instance = store.db.prepare('SELECT channel,events FROM instances WHERE id=?').get(ws.instance.id);
    const account = instance?.channel ? store.db.prepare('SELECT name,status FROM accounts WHERE id=?').get(instance.channel) : null;
    const missing = !!account && scopes(JSON.parse(instance.events)).some(scope => !(store.tokens(instance.channel).scope ?? []).includes(scope));
    const approvalRequired = missing || !!account && !/^Listening/.test(account.status) && /permission|needs to be renewed|sign in again|validation failed|account changed/i.test(account.status);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'status', linked: !!account, approvalRequired, channel: account?.name ?? '', status: missing ? 'Approve optional permissions; subscriber book keeps listening' : account?.status ?? 'Waiting for browser sign-in', buffered: store.count(ws.instance.id) }));
  }
  function pump(ws) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1024 * 1024) return;
    for (const row of store.outstanding(ws.instance.id, ws.after, 100 - ws.inflight.size)) {
      ws.inflight.add(row.seq); ws.after = row.seq;
      ws.send(JSON.stringify({ type: 'event', seq: row.seq, event: JSON.parse(row.event) }));
    }
  }
  function notify(channel) {
    for (const ws of clients.values()) {
      const instance = store.db.prepare('SELECT channel FROM instances WHERE id=?').get(ws.instance.id);
      if (instance?.channel === channel) { status(ws); pump(ws); }
    }
  }
  const heartbeat = setInterval(() => {
    for (const ws of clients.values()) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); status(ws); pump(ws); }
    }
    store.prune();
    for (const [id, ws] of clients) if (!store.db.prepare('SELECT 1 FROM instances WHERE id=?').get(id)) ws.close(1000, 'Pairing expired');
    for (const [id, entry] of rates) if (entry.reset < Date.now()) rates.delete(id);
  }, 30000);
  heartbeat.unref();
  return { server, notify, close: async () => { clearInterval(heartbeat); for (const ws of clients.values()) ws.terminate(); sockets.close(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled(recoveries.values()); } };
}
