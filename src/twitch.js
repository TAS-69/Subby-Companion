import WebSocket from 'ws';
import { normalize, subscriptions, scopes, clean } from './catalog.js';

const API = 'https://api.twitch.tv/helix/';
const OAUTH = 'https://id.twitch.tv/oauth2/';
const SOCKET = 'wss://eventsub.wss.twitch.tv/ws';

export class Twitch {
  constructor(store, config, delivered, dependencies = {}) {
    this.store = store; this.config = config; this.delivered = delivered;
    this.fetch = dependencies.fetch ?? fetch;
    this.WebSocket = dependencies.WebSocket ?? WebSocket;
    this.socketUrl = dependencies.socketUrl ?? SOCKET;
    this.connections = new Map(); this.stopped = false;
    this.accessRequests = new Map();
    this.refreshRequests = new Map();
    this.requests = new Set();
    this.timer = setInterval(() => this.maintain().catch(() => {}), 60000);
    this.timer.unref();
    this.botLast = new Map();
  }
  async token(parameters) {
    const response = await this.fetch(OAUTH + 'token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...parameters }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Twitch sign-in needs to be renewed.');
    const token = await response.json();
    if (!token.access_token || !token.refresh_token) throw new Error('Twitch did not return a complete sign-in.');
    return { ...token, expiresAt: Date.now() + token.expires_in * 1000, validatedAt: 0 };
  }
  async validate(tokens) {
    const response = await this.fetch(OAUTH + 'validate', { headers: { Authorization: 'OAuth ' + tokens.access_token }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { const error = new Error('Twitch sign-in needs to be renewed.'); error.unauthorized = response.status === 401; throw error; }
    const data = await response.json();
    if (data.client_id !== this.config.clientId || !data.user_id) throw new Error('Twitch account validation failed.');
    return data;
  }
  async identity(tokens) {
    const validated = await this.validate(tokens);
    tokens.scope = validated.scopes; tokens.validatedAt = Date.now();
    const response = await this.fetch(API + 'users', { headers: { Authorization: 'Bearer ' + tokens.access_token, 'Client-Id': this.config.clientId }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Could not read the Twitch account.');
    const user = (await response.json()).data?.[0];
    if (!user || user.id !== validated.user_id) throw new Error('Twitch account validation failed.');
    return user;
  }
  async access(channel) {
    if (!this.accessRequests.has(channel)) this.accessRequests.set(channel, this.loadAccess(channel).finally(() => this.accessRequests.delete(channel)));
    return this.accessRequests.get(channel);
  }
  async loadAccess(channel) {
    let tokens = this.store.tokens(channel);
    if (tokens.expiresAt < Date.now() + 120000) {
      tokens = await this.refresh(channel, tokens.access_token);
    }
    if (tokens.validatedAt < Date.now() - 55 * 60000) {
      let data;
      try { data = await this.validate(tokens); }
      catch (error) { if (!error.unauthorized) throw error; tokens = await this.refresh(channel, tokens.access_token); data = await this.validate(tokens); }
      if (data.user_id !== channel) throw new Error('Twitch account changed. Sign in again.');
      tokens.scope = data.scopes; tokens.validatedAt = Date.now(); this.store.saveTokens(channel, tokens);
    }
    return tokens;
  }
  async refresh(channel, staleAccess) {
    const current = this.store.tokens(channel);
    if (current.access_token !== staleAccess) return current;
    if (!this.refreshRequests.has(channel)) this.refreshRequests.set(channel, this.token({ grant_type: 'refresh_token', refresh_token: current.refresh_token }).then(tokens => { this.store.saveTokens(channel, tokens); return tokens; }).finally(() => this.refreshRequests.delete(channel)));
    return this.refreshRequests.get(channel);
  }
  async api(channel, path, body, retry = true) {
    return this.request(channel, path, body, 'POST', retry);
  }
  async request(channel, path, body, method = 'GET', retry = true) {
    if (this.stopped) throw new Error('Twitch connection is stopping.');
    const job = this.performRequest(channel, path, body, method, retry);
    this.requests.add(job);
    try { return await job; } finally { this.requests.delete(job); }
  }
  async performRequest(channel, path, body, method, retry) {
    const tokens = await this.access(channel);
    const response = await this.fetch(API + path, {
      method, headers: { Authorization: 'Bearer ' + tokens.access_token, 'Client-Id': this.config.clientId, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    if (response.status === 401 && retry) {
      await this.refresh(channel, tokens.access_token);
      return this.request(channel, path, body, method, false);
    }
    if (response.status === 429) {
      const reset = Number(response.headers.get('ratelimit-reset')) * 1000;
      const error = new Error('Twitch rate limit; retrying shortly.');
      error.retryAfter = Math.max(1000, Math.min(60000, reset - Date.now() || 30000)); throw error;
    }
    if (!response.ok && response.status !== 409) { const error = new Error(response.status === 403 ? 'An optional permission is missing. Reconnect from Minecraft to approve it.' : 'Twitch request failed (' + response.status + ').'); error.permissionMissing = response.status === 403; throw error; }
    return response;
  }
  async recover(instance) {
    let after = '', count = 0, scanned = 0;
    do {
      const query = new URLSearchParams({ broadcaster_id: instance.channel, first: '100', ...(after ? { after } : {}) });
      const response = await this.request(instance.channel, 'subscriptions?' + query);
      const page = await response.json();
      scanned += page.data?.length ?? 0;
      for (const user of page.data ?? []) {
        const event = { messageId: 'recovery:' + instance.id + ':' + user.user_id, broadcasterId: instance.channel, userId: user.user_id, name: clean(user.user_name, 64), kind: 'sync', tier: user.tier, months: 0, receivedAt: new Date().toISOString(), details: { login: clean(user.user_login, 64), recovered: 'true', timestamp_known: 'false', gifter: clean(user.gifter_name, 64), gifter_login: clean(user.gifter_login, 64) } };
        if (this.store.deliver(event, instance.id)) count++;
      }
      after = page.pagination?.cursor ?? '';
      this.store.status(instance.channel, 'Recovering current subscribers: ' + count); this.delivered(instance.channel);
    } while (after && scanned < 100000 && !this.stopped);
    this.store.status(instance.channel, after ? 'Recovery paused at buffer limit. Reconnect Minecraft and retry.' : 'Listening; recovered ' + count + ' current subscribers');
    this.delivered(instance.channel);
    return count;
  }
  async maintain() {
    if (this.stopped) return;
    const active = new Set(this.store.accounts().map(a => a.id));
    for (const [id, connection] of this.connections) if (!active.has(id)) { this.stopConnection(connection); this.connections.delete(id); }
    for (const id of active) {
      const connection = this.connections.get(id);
      if (!connection) this.start(id);
      else if (connection.welcomed && !connection.refreshing) {
        connection.refreshing = true;
        this.access(id).catch(() => this.fail(connection, 'Twitch sign-in needs to be renewed.')).finally(() => { connection.refreshing = false; });
      }
    }
  }
  start(channel) {
    if (this.stopped) return;
    const previous = this.connections.get(channel);
    if (previous?.welcomed) { previous.chain = previous.chain.then(() => this.subscribe(previous)).catch(error => this.fail(previous, error.message, error.retryAfter)); return; }
    if (previous) this.stopConnection(previous);
    const connection = { channel, attempts: 0, closed: false, sockets: new Set(), chain: Promise.resolve() };
    this.connections.set(channel, connection);
    this.open(connection, this.socketUrl, false);
  }
  async subscribe(connection) {
    const events = this.store.events(connection.channel), tokens = await this.access(connection.channel);
    const granted = new Set(tokens.scope ?? []);
    if (!granted.has('channel:read:subscriptions')) throw new Error('Subscription permission missing. Sign in again.');
    const available = events.filter(event => scopes([event]).every(scope => granted.has(scope)));
    const definitions = subscriptions(available, connection.channel);
    let pending = available.length !== events.length;
    connection.subscriptions ??= new Map();
    for (const [type, id] of connection.subscriptions) if (!definitions.some(d => d.type === type)) {
      await this.request(connection.channel, 'eventsub/subscriptions?id=' + encodeURIComponent(id), undefined, 'DELETE'); connection.subscriptions.delete(type);
    }
    for (const definition of definitions) {
      if (connection.subscriptions.has(definition.type)) continue;
      try {
        const response = await this.api(connection.channel, 'eventsub/subscriptions', { ...definition, transport: { method: 'websocket', session_id: connection.sessionId } });
        if (response.status !== 409) { const result = await response.json(); if (result.data?.[0]?.id) connection.subscriptions.set(definition.type, result.data[0].id); }
      } catch (error) { if (error.permissionMissing && !['channel.subscribe', 'channel.subscription.message'].includes(definition.type)) pending = true; else throw error; }
    }
    if (!this.stopped) this.store.status(connection.channel, pending ? 'Listening; optional permission approval pending' : 'Listening');
  }
  stopConnection(connection) {
    connection.closed = true; clearTimeout(connection.retry);
    for (const socket of connection.sockets) { clearTimeout(socket.watchdog); socket.terminate(); }
  }
  fail(connection, status, delay) {
    if (connection.closed || this.stopped || connection.retry) return;
    this.store.status(connection.channel, status); connection.welcomed = false;
    for (const socket of connection.sockets) { clearTimeout(socket.watchdog); socket.terminate(); }
    connection.sockets.clear();
    connection.retry = setTimeout(() => {
      connection.retry = null; this.open(connection, this.socketUrl, false);
    }, delay ?? Math.min(60000, 1000 * 2 ** Math.min(connection.attempts++, 6)) + Math.floor(Math.random() * 1000));
    connection.retry.unref();
  }
  open(connection, url, transferred) {
    if (connection.closed || this.stopped) return;
    const socket = new this.WebSocket(url, { maxPayload: 1024 * 1024 });
    connection.sockets.add(socket);
    const watch = ms => { clearTimeout(socket.watchdog); socket.watchdog = setTimeout(() => this.fail(connection, 'Reconnecting to Twitch'), ms); socket.watchdog.unref(); };
    watch(15000);
    socket.on('message', bytes => {
      connection.chain = connection.chain.then(async () => {
        if (connection.closed) return;
        const message = JSON.parse(bytes.toString());
        if (message.metadata?.message_type === 'session_welcome') {
          const session = message.payload.session;
          socket.welcomed = true; watch((session.keepalive_timeout_seconds ?? 10) * 1000 + 5000);
          socket.keepalive = (session.keepalive_timeout_seconds ?? 10) * 1000 + 5000;
          if (!transferred) {
            connection.sessionId = session.id; connection.subscriptions = new Map(); await this.subscribe(connection);
          }
          else connection.sessionId = session.id;
          connection.welcomed = true; connection.attempts = 0;
          for (const old of connection.sockets) if (old !== socket) { clearTimeout(old.watchdog); old.close(); connection.sockets.delete(old); }
        } else {
          watch(socket.keepalive ?? 15000);
          if (message.metadata?.message_type === 'session_reconnect') {
            const next = new URL(message.payload.session.reconnect_url);
            if (next.protocol !== 'wss:' || next.hostname !== 'eventsub.wss.twitch.tv' || (next.port && next.port !== '443')) throw new Error('Invalid Twitch reconnect address.');
            this.open(connection, next.toString(), true);
          } else if (message.metadata?.message_type === 'revocation') {
            const tokens = this.store.tokens(connection.channel); tokens.validatedAt = 0; this.store.saveTokens(connection.channel, tokens);
            connection.subscriptions?.delete(message.payload.subscription?.type);
            await this.subscribe(connection);
          }
          else if (message.metadata?.message_type === 'notification') await this.notification(message, connection.channel);
        }
      }).catch(error => this.fail(connection, error.message, error.retryAfter));
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(socket.watchdog); connection.sockets.delete(socket);
      if (!connection.closed && connection.sockets.size === 0) this.fail(connection, 'Reconnecting to Twitch');
    });
  }
  async notification(message, expectedChannel) {
    const event = normalize(message);
    if (!event) return;
    if (expectedChannel && event.broadcasterId !== expectedChannel) throw new Error('Twitch sent an event for a different channel.');
    if (message.payload.subscription.type === 'channel.chat.message') {
      const raw = message.payload.event;
      const first = this.store.firstChat(event.broadcasterId, event.userId);
      this.chat(raw, event).catch(() => {});
      if (!first || !this.store.events(event.broadcasterId).includes('first_chat')) return;
      event.kind = 'first_chat';
    }
    if (this.store.deliver(event)) {
      this.delivered(event.broadcasterId);
      if (['sub', 'resub', 'gift'].includes(event.kind)) this.feedback(event).catch(() => {});
    }
  }
  bot(channel) {
    const row = this.store.db.prepare('SELECT bot FROM instances WHERE channel=? AND json_extract(bot,\'$.enabled\')=1 ORDER BY id LIMIT 1').get(channel);
    return row ? JSON.parse(row.bot) : null;
  }
  async say(channel, text) {
    if (Date.now() - (this.botLast.get(channel) ?? 0) < 5000) return;
    this.botLast.set(channel, Date.now());
    try { await this.api(channel, 'chat/messages', { broadcaster_id: channel, sender_id: channel, message: clean(text, 450) }); }
    catch { if (!this.stopped) this.store.status(channel, 'Listening; optional chat reply unavailable'); }
  }
  async feedback(event) {
    const bot = this.bot(event.broadcasterId);
    if (!bot || bot.style === 'silent') return;
    const templates = { cute: '♥ {user} has been added to the book!', professional: '{user}, thank you for subscribing. Your name is in the subscriber book.', chaotic: '{user} joined the book. The library grows stronger.' };
    const template = bot.style === 'custom' ? bot.template : templates[bot.style];
    if (template) await this.say(event.broadcasterId, template.replace(/\{(user|months)\}/g, (_, key) => key === 'user' ? event.name : String(event.months)));
  }
  async chat(raw, event) {
    if (!this.bot(event.broadcasterId)) return;
    const text = raw.message?.text?.trim().toLowerCase();
    if (text !== '!book' && text !== '!supporters' && !text?.startsWith('!subby')) return;
    if (!this.store.claimBot(event.broadcasterId, event.messageId)) return;
    if (text === '!book') return this.say(event.broadcasterId, 'Subscriber names are saved in our Minecraft book. Thank you for supporting the stream!');
    if (text === '!supporters') return this.say(event.broadcasterId, 'Our subscriber book celebrates the viewers who support this stream.');
    if (!text?.startsWith('!subby')) return;
    const moderator = raw.chatter_user_id === event.broadcasterId || raw.badges?.some(b => b.set_id === 'moderator' || b.set_id === 'broadcaster');
    if (!moderator) return;
    const command = text.split(/\s+/)[1] ?? 'status';
    if (command === 'pause' || command === 'resume') {
      const control = { ...event, kind: 'control', details: { command } };
      if (this.store.deliver(control)) this.delivered(event.broadcasterId);
      await this.say(event.broadcasterId, 'Subby effects ' + (command === 'pause' ? 'paused. Names keep recording.' : 'resumed.'));
    } else if (command === 'status') {
      const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM instances WHERE channel=?').get(event.broadcasterId).n;
      await this.say(event.broadcasterId, 'Subby is listening. Linked Minecraft installations: ' + count + '.');
    } else if (command === 'lastsub') {
      const last = this.store.lastSub(event.broadcasterId);
      await this.say(event.broadcasterId, last ? 'Latest subscriber: ' + last.name : 'No subscribers recorded yet.');
    }
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    for (const connection of this.connections.values()) this.stopConnection(connection);
    this.connections.clear();
    await Promise.allSettled([...this.requests, ...this.accessRequests.values(), ...this.refreshRequests.values()]);
  }
}
