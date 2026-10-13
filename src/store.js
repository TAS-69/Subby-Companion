import { DatabaseSync } from 'node:sqlite';
import { createHash, createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { selectedEvents } from './catalog.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');

export class Store {
  constructor(directory, key) {
    this.key = Buffer.from(key, 'base64');
    if (this.key.length !== 32) throw new Error('SUBBY_ENCRYPTION_KEY must contain a base64 encoded 32 byte key.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'subby.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, login TEXT NOT NULL, name TEXT NOT NULL, tokens TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Connecting');
      CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY, token TEXT NOT NULL, channel TEXT, events TEXT NOT NULL, label TEXT NOT NULL, bot TEXT NOT NULL DEFAULT '{}', expected_channel TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS pairings(code TEXT PRIMARY KEY, instance TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth(state TEXT PRIMARY KEY, code TEXT NOT NULL, cookie TEXT NOT NULL, expires INTEGER NOT NULL, pending TEXT);
      CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, event TEXT NOT NULL, ack INTEGER, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS outstanding ON deliveries(instance, ack, seq);
      CREATE TABLE IF NOT EXISTS seen(channel TEXT NOT NULL, id TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(channel,id));
      CREATE TABLE IF NOT EXISTS chatters(channel TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY(channel,user));`);
    if (!this.db.prepare('PRAGMA table_info(instances)').all().some(column => column.name === 'expected_channel')) this.db.exec("ALTER TABLE instances ADD COLUMN expected_channel TEXT NOT NULL DEFAULT ''");
    try { for (const row of this.db.prepare('SELECT tokens FROM accounts').all()) this.decrypt(row.tokens); }
    catch { this.db.close(); throw new Error('The encryption key does not match the saved Twitch sign-ins. Restore the original key.'); }
  }
  encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  decrypt(value) {
    const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  instance(id, token) {
    if (!token || typeof id !== 'string') return null;
    const instance = this.db.prepare('SELECT * FROM instances WHERE id=? AND token=?').get(id, hash(token));
    return instance ? { ...instance, events: JSON.parse(instance.events), bot: JSON.parse(instance.bot) } : null;
  }
  pair(existing, events, label, expectedChannel = '') {
    events = selectedEvents(events);
    return this.transaction(() => {
      const id = existing?.id ?? randomUUID(), token = existing ? undefined : secret();
      if (!existing && this.db.prepare('SELECT COUNT(*) AS n FROM instances WHERE channel IS NULL').get().n >= 10000) throw new Error('Too many pending installations. Try again later.');
      if (!existing) this.db.prepare('INSERT INTO instances(id,token,events,label,expected_channel) VALUES(?,?,?,?,?)').run(id, hash(token), JSON.stringify(events), label.slice(0, 64), expectedChannel);
      else {
        if (existing.expected_channel && existing.expected_channel !== expectedChannel) throw new Error('This Minecraft library belongs to another Twitch channel.');
        this.db.prepare('UPDATE instances SET events=?,expected_channel=? WHERE id=?').run(JSON.stringify(events), expectedChannel, id);
      }
      this.db.prepare('DELETE FROM pairings WHERE instance=?').run(id);
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const bytes = randomBytes(10), code = [...bytes].map(b => alphabet[b % alphabet.length]).join('');
      const expires = Date.now() + 600000;
      this.db.prepare('INSERT INTO pairings VALUES(?,?,?)').run(hash(code), id, expires);
      return { instanceId: id, token, code: code.slice(0, 5) + '-' + code.slice(5), expiresAt: expires };
    });
  }
  pairing(code) {
    return this.pairingHash(hash(String(code).toUpperCase().replace(/[^A-Z0-9]/g, '')));
  }
  pairingHash(code) { return this.db.prepare('SELECT p.*,i.label,i.events,i.channel FROM pairings p JOIN instances i ON i.id=p.instance WHERE p.code=? AND p.expires>?').get(code, Date.now()); }
  beginOAuth(pair, cookie, retry = false) {
    const state = (retry ? 'r_' : 's_') + secret();
    this.db.prepare('INSERT INTO oauth(state,code,cookie,expires) VALUES(?,?,?,?)').run(hash(state), pair.code, hash(cookie), Date.now() + 600000);
    return state;
  }
  oauth(state, cookie) {
    if (!state || !cookie) return null;
    return this.db.prepare('SELECT * FROM oauth WHERE state=? AND cookie=? AND expires>?').get(hash(state), hash(cookie), Date.now());
  }
  reserveOAuth(state) { return this.db.prepare('UPDATE oauth SET pending=? WHERE state=? AND pending IS NULL').run(this.encrypt({ exchanging: true }), hash(state)).changes > 0; }
  pending(state, value) { this.db.prepare('UPDATE oauth SET pending=? WHERE state=?').run(this.encrypt(value), hash(state)); }
  link(state, cookie) {
    return this.transaction(() => {
      const oauth = this.oauth(state, cookie);
      if (!oauth?.pending) throw new Error('This sign-in expired. Start again in Minecraft.');
      const pair = this.db.prepare('SELECT * FROM pairings WHERE code=? AND expires>?').get(oauth.code, Date.now());
      if (!pair) throw new Error('This pairing code expired.');
      const { user, tokens } = this.decrypt(oauth.pending);
      if (!user || !tokens) throw new Error('Twitch sign-in has not finished yet.');
      this.db.prepare('INSERT INTO accounts(id,login,name,tokens) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET login=excluded.login,name=excluded.name,tokens=excluded.tokens,status=\'Connecting\'').run(user.id, user.login, user.display_name, this.encrypt(tokens));
      const current = this.db.prepare('SELECT channel,expected_channel FROM instances WHERE id=?').get(pair.instance);
      if (current.expected_channel && current.expected_channel !== user.id) throw new Error('This Minecraft library belongs to another Twitch channel. Create a separate Subby profile.');
      if (current.channel && current.channel !== user.id) throw new Error('This installation is already linked to another channel. Unlink it in Minecraft first.');
      this.db.prepare('UPDATE instances SET channel=? WHERE id=?').run(user.id, pair.instance);
      this.db.prepare('DELETE FROM pairings WHERE code=?').run(oauth.code);
      this.db.prepare('DELETE FROM oauth WHERE state=?').run(oauth.state);
      return { channel: user.id, instance: pair.instance, name: user.display_name };
    });
  }
  accounts() { return this.db.prepare('SELECT * FROM accounts WHERE id IN (SELECT channel FROM instances)').all(); }
  events(channel) {
    return [...new Set(this.db.prepare('SELECT events FROM instances WHERE channel=?').all(channel).flatMap(row => JSON.parse(row.events)))];
  }
  tokens(channel) { return this.decrypt(this.db.prepare('SELECT tokens FROM accounts WHERE id=?').get(channel).tokens); }
  saveTokens(channel, tokens) { this.db.prepare('UPDATE accounts SET tokens=? WHERE id=?').run(this.encrypt(tokens), channel); }
  status(channel, status) { this.db.prepare('UPDATE accounts SET status=? WHERE id=?').run(status, channel); }
  deliver(event, onlyInstance) {
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM seen WHERE channel=? AND id=?').get(event.broadcasterId, event.messageId)) return false;
      const targets = this.db.prepare('SELECT * FROM instances WHERE channel=?').all(event.broadcasterId).filter(i => (!onlyInstance || i.id === onlyInstance) && (JSON.parse(i.events).includes(event.kind) || event.kind === 'control' || event.kind === 'sync'));
      for (const target of targets) {
        if (this.count(target.id) >= 100000) throw new Error('Delivery buffer full; reconnect Minecraft to drain it.');
        this.db.prepare('INSERT INTO deliveries(instance,event,created) VALUES(?,?,?)').run(target.id, JSON.stringify(event), Date.now());
      }
      this.db.prepare('INSERT INTO seen VALUES(?,?,?)').run(event.broadcasterId, event.messageId, Date.now());
      return true;
    });
  }
  firstChat(channel, user) { return this.db.prepare('INSERT OR IGNORE INTO chatters VALUES(?,?)').run(channel, user).changes > 0; }
  claimBot(channel, id) { return this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?,?)').run(channel, 'bot:' + id, Date.now()).changes > 0; }
  count(id) { return this.db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE instance=? AND ack IS NULL').get(id).n; }
  outstanding(id, after = 0, limit = 100) { return this.db.prepare('SELECT seq,event FROM deliveries WHERE instance=? AND ack IS NULL AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit); }
  ack(id, seq) { this.db.prepare('UPDATE deliveries SET ack=? WHERE instance=? AND seq=? AND ack IS NULL').run(Date.now(), id, seq); }
  lastSub(channel) {
    const row = this.db.prepare('SELECT event FROM deliveries d JOIN instances i ON i.id=d.instance WHERE i.channel=? AND json_extract(d.event,\'$.kind\') IN (\'sub\',\'resub\',\'gift\') ORDER BY d.seq DESC LIMIT 1').get(channel);
    return row ? JSON.parse(row.event) : null;
  }
  unlink(id) {
    this.transaction(() => {
      const channel = this.db.prepare('SELECT channel FROM instances WHERE id=?').get(id)?.channel;
      this.db.prepare('DELETE FROM instances WHERE id=?').run(id);
      if (channel && !this.db.prepare('SELECT 1 FROM instances WHERE channel=?').get(channel)) this.db.prepare('DELETE FROM accounts WHERE id=?').run(channel);
    });
  }
  prune() {
    const cutoff = Date.now() - 30 * 86400000;
    this.db.prepare('DELETE FROM deliveries WHERE ack<?').run(cutoff);
    this.db.prepare('DELETE FROM seen WHERE created<?').run(cutoff);
    this.db.prepare('DELETE FROM pairings WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM oauth WHERE expires<?').run(Date.now());
    this.db.prepare('DELETE FROM instances WHERE channel IS NULL AND id NOT IN (SELECT instance FROM pairings)').run();
  }
  close() { this.db.close(); }
}
