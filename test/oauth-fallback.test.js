import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { createCompanion } from '../src/server.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'subby-oauth-'));
  const store = new Store(directory, randomBytes(32).toString('base64'));
  const config = { baseUrl: 'http://localhost:3030', clientId: 'fixture-client', clientSecret: 'private-client-secret' };
  const twitch = { token: async () => ({ access_token: 'private-access', refresh_token: 'private-refresh', scope: ['channel:read:subscriptions'] }), identity: async () => ({ id: '123', login: 'creator', display_name: 'Creator' }), start: () => {}, maintain: async () => {} };
  const app = createCompanion(store, config, twitch); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const address = 'http://127.0.0.1:' + app.server.address().port;
  return {
    store, config, address,
    post: (path, input, headers = {}) => fetch(address + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(input), redirect: 'manual' }),
    close: async () => { await app.close(); store.close(); const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('subby-oauth-')); rmSync(target, { recursive: true, force: true }); }
  };
}
function directLink(html) { return new URL(html.match(/id="twitch-fallback"[^>]+href="([^"]+)"/)[1].replace(/&amp;/g, '&')); }

test('direct Twitch fallback bypasses the form redirect and retains browser-bound state and explicit confirmation', async () => {
  const app = await fixture();
  try {
    const pair = app.store.pair(null, [], 'Fallback world');
    const page = await fetch(app.address + '/link?code=' + pair.code), cookie = page.headers.get('set-cookie').split(';')[0], html = await page.text();
    const location = directLink(html), state = location.searchParams.get('state'), csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
    assert.ok(html.indexOf('Continue with Twitch') < html.indexOf('id="twitch-fallback"'));
    assert.match(html, /Show Twitch sign-in URL/); assert.match(html, /<textarea[^>]+readonly/); assert.match(html, /id="code"[^>]+readonly/);
    assert.equal(location.origin, 'https://id.twitch.tv'); assert.equal(location.pathname, '/oauth2/authorize');
    assert.equal(location.searchParams.get('redirect_uri'), app.config.baseUrl + '/oauth/callback');
    assert.equal(location.searchParams.get('scope'), 'channel:read:subscriptions'); assert.equal(location.searchParams.get('response_type'), 'code');
    assert.equal(location.searchParams.has('client_secret'), false); assert.doesNotMatch(html, /private-client-secret|private-access|private-refresh/);
    assert.ok(app.store.oauth(state, cookie.slice('subby_link='.length)));
    assert.equal((await fetch(app.address + '/oauth/callback?state=' + state + '&code=fixture')).status, 400);
    const callback = await fetch(app.address + '/oauth/callback?state=' + state + '&code=fixture', { headers: { Cookie: cookie } });
    assert.equal(callback.status, 200); assert.match(await callback.text(), /Yes, connect this channel/); assert.equal(app.store.accounts().length, 0);
    assert.equal((await app.post('/link/confirm', { csrf, state }, { Cookie: cookie, Origin: app.config.baseUrl })).status, 200);
    assert.equal(app.store.accounts().length, 1);
    assert.equal((await fetch(app.address + '/oauth/callback?state=' + state + '&code=fixture', { headers: { Cookie: cookie } })).status, 400);
  } finally { await app.close(); }
});

test('manually entered pairing codes get a direct-link page with CSRF and expiry checks', async () => {
  const app = await fixture();
  try {
    const pair = app.store.pair(null, [], 'Typed code');
    const page = await fetch(app.address + '/link'), cookie = page.headers.get('set-cookie').split(';')[0], html = await page.text();
    const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
    assert.match(html, /name="manual" value="1"/); assert.doesNotMatch(html, /id="code"[^>]+readonly/);
    assert.equal((await app.post('/oauth/start', { csrf, code: pair.code, manual: '1' }, { Cookie: cookie, Origin: 'https://attacker.invalid' })).status, 400);
    const response = await app.post('/oauth/start', { csrf, code: pair.code, manual: '1' }, { Cookie: cookie, Origin: app.config.baseUrl });
    assert.equal(response.status, 200); assert.equal(response.headers.has('location'), false);
    const fallback = directLink(await response.text()), state = fallback.searchParams.get('state');
    assert.equal(fallback.origin, 'https://id.twitch.tv'); assert.ok(app.store.oauth(state, cookie.slice('subby_link='.length)));
    assert.equal(app.store.accounts().length, 0);
    app.store.db.prepare('UPDATE pairings SET expires=0 WHERE instance=?').run(pair.instanceId);
    const expired = await app.post('/oauth/start', { csrf, code: pair.code, manual: '1' }, { Cookie: cookie, Origin: app.config.baseUrl });
    assert.equal(expired.status, 400); assert.doesNotMatch(await expired.text(), /id="twitch-fallback"/);
    const expiredPage = await fetch(app.address + '/link?code=' + pair.code);
    assert.doesNotMatch(await expiredPage.text(), /id="twitch-fallback"/);
  } finally { await app.close(); }
});
