import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
const required = ['SUBBY_BASE_URL', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'SUBBY_ENCRYPTION_KEY'];
const missing = required.filter(name => !process.env[name]?.trim());
if (missing.length) throw new Error('Hosting setup incomplete. Set ' + missing.join(', ') + ' in your server environment or private .env file.');
const base = new URL(process.env.SUBBY_BASE_URL);
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('SUBBY_BASE_URL must be your public HTTPS origin, for example https://subby.example.com.');
process.env.SUBBY_HOST = '0.0.0.0';
process.env.SUBBY_PORT = process.env.SERVER_PORT ?? process.env.SUBBY_PORT ?? '3030';
await import('./src/main.js');
