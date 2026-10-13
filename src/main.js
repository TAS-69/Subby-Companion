import { Store } from './store.js';
import { Twitch } from './twitch.js';
import { createCompanion } from './server.js';
import { createConsole } from './console.js';

const config = {
  baseUrl: process.env.SUBBY_BASE_URL ?? 'http://localhost:3030',
  clientId: process.env.TWITCH_CLIENT_ID ?? '', clientSecret: process.env.TWITCH_CLIENT_SECRET ?? ''
};
const base = new URL(config.baseUrl);
if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Use an HTTPS public origin or HTTP localhost for SUBBY_BASE_URL.');
const store = new Store(process.env.SUBBY_DATA_DIR ?? './data', process.env.SUBBY_ENCRYPTION_KEY ?? '');
let app;
const twitch = new Twitch(store, config, channel => app.notify(channel));
app = createCompanion(store, config, twitch);
const operatorConsole = createConsole(store, app, { stop });
const port = Number(process.env.SUBBY_PORT ?? 3030);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SUBBY_PORT must be between 1 and 65535.');
app.server.listen(port, process.env.SUBBY_HOST ?? '127.0.0.1', () => {
  console.log('Subby Companion: Listening on ' + config.baseUrl);
  twitch.maintain().catch(() => console.error('Twitch connection could not start.'));
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  operatorConsole.close();
  await Promise.all([twitch.close(), app.close()]); store.close();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
