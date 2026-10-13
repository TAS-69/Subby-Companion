import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { exportHosting } from '../scripts/export-hosting.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function temporary() { return mkdtempSync(join(tmpdir(), 'subby-hosting-')); }
function cleanup(directory) {
  directory = resolve(directory);
  assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('subby-hosting-'));
  rmSync(directory, { recursive: true, force: true });
}
function files(directory, prefix = '') {
  return readdirSync(directory).flatMap(name => lstatSync(join(directory, name)).isDirectory() ? files(join(directory, name), prefix + name + '/') : [prefix + name]).sort();
}
function environment() {
  const result = { ...process.env };
  for (const name of Object.keys(result)) if (name.startsWith('SUBBY_') || name.startsWith('TWITCH_') || name === 'SERVER_PORT') delete result[name];
  return result;
}

test('hosting export includes only runtime files and excludes development scripts, data, and private settings', () => {
  const directory = temporary();
  try {
    exportHosting(source, directory);
    assert.deepEqual(files(directory), ['.env.example', '.gitignore', 'LICENSE', 'index.js', 'package-lock.json', 'package.json', 'src/catalog.js', 'src/console.js', 'src/main.js', 'src/server.js', 'src/store.js', 'src/twitch.js', 'web/style.css'].sort());
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'package.json'))).scripts, { start: 'node index.js' });
    assert.equal(JSON.parse(readFileSync(join(directory, 'package.json'))).devDependencies, undefined);
    assert.match(readFileSync(join(directory, '.env.example'), 'utf8'), /^SUBBY_BASE_URL=\s*$/m);
    assert.throws(() => exportHosting(source, directory), /empty/);
    assert.throws(() => exportHosting(source, source), /separate/);
  } finally { cleanup(directory); }
});

test('hosting launcher loads private settings, honors the Falix port, and serves health over a non-loopback binding', async () => {
  const directory = temporary(); let child;
  try {
    exportHosting(source, directory);
    cpSync(join(source, 'node_modules/ws'), join(directory, 'node_modules/ws'), { recursive: true });
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    writeFileSync(join(directory, '.env'), 'SUBBY_BASE_URL=https://subby.example.com\nTWITCH_CLIENT_ID=fixture-client\nTWITCH_CLIENT_SECRET=fixture-secret\nSUBBY_ENCRYPTION_KEY=' + randomBytes(32).toString('base64') + '\nSUBBY_PORT=1\nSUBBY_HOST=192.0.2.1\n');
    child = spawn(process.execPath, ['index.js'], { cwd: directory, env: { ...environment(), SERVER_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit'); let output = '';
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    const deadline = Date.now() + 10000; let response;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Hosting exited: ' + output);
      try { response = await fetch('http://127.0.0.1:' + port + '/health'); if (response.ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(response?.ok, output); assert.deepEqual(await response.json(), { status: 'ok', protocol: 1 });
    assert.match(output, /Listening/); assert.doesNotMatch(output, /fixture-secret/);
    child.stdin.write('subby help\n');
    const consoleDeadline = Date.now() + 3000;
    while (!output.includes('subby test sub') && Date.now() < consoleDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(output, /subby test sub/);
    child.stdin.write('stop\n');
    const stopDeadline = Date.now() + 3000;
    while (child.exitCode === null && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(child.exitCode, 0, output); assert.match(output, /stopping Companion/);
    await exited; child = null;
  } finally { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } cleanup(directory); }
});

test('hosting launcher rejects incomplete settings and public HTTP before opening a service', async () => {
  const directory = temporary();
  try {
    exportHosting(source, directory);
    async function run(settings) {
      const child = spawn(process.execPath, ['index.js'], { cwd: directory, env: { ...environment(), ...settings }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stderr.on('data', chunk => output += chunk);
      const [code] = await once(child, 'exit'); return { code, output };
    }
    const missing = await run({}); assert.notEqual(missing.code, 0); assert.match(missing.output, /Hosting setup incomplete/);
    const insecure = await run({ SUBBY_BASE_URL: 'http://subby.example.com', TWITCH_CLIENT_ID: 'fixture-client', TWITCH_CLIENT_SECRET: 'fixture-secret', SUBBY_ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    assert.notEqual(insecure.code, 0); assert.match(insecure.output, /public HTTPS origin/);
  } finally { cleanup(directory); }
});
