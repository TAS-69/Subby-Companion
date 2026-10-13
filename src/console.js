import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { clean } from './catalog.js';
import { hash } from './store.js';

export function createConsole(store, app, { input = process.stdin, write = console.log, stop = () => {} } = {}) {
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  const channels = () => store.db.prepare('SELECT id,login FROM accounts WHERE id IN (SELECT channel FROM instances) ORDER BY login').all();
  const installations = channel => store.db.prepare('SELECT id,label FROM instances WHERE channel=? ORDER BY id').all(channel);
  const fail = message => { const error = new Error(message); error.consoleMessage = true; throw error; };
  function target(selector) {
    if (selector) {
      const instance = store.db.prepare('SELECT i.id AS instance,i.channel,a.login FROM instances i JOIN accounts a ON a.id=i.channel WHERE i.id=?').get(selector);
      if (instance) return { channel: instance.channel, login: instance.login, instances: [{ id: instance.instance }] };
      const name = selector.replace(/^@/, '').toLowerCase();
      const matches = channels().filter(channel => channel.id === name || channel.login.toLowerCase() === name);
      if (matches.length !== 1) fail('Choose a linked Twitch username or installation ID from subby channels.');
      return { channel: matches[0].id, login: matches[0].login, instances: installations(matches[0].id) };
    }
    const linked = channels();
    if (!linked.length) fail('Connect a Twitch channel from Minecraft first.');
    if (linked.length !== 1) fail('More than one channel is linked. Use subby test sub <channel> [viewer] [tier].');
    return { channel: linked[0].id, login: linked[0].login, instances: installations(linked[0].id) };
  }
  function command(value) {
    const line = String(value).trim().replace(/^\//, '');
    if (!line) return;
    try {
      if (/^(stop|exit|quit)$/i.test(line)) { write('Subby: stopping Companion.'); Promise.resolve(stop()).catch(() => write('Subby: shutdown could not finish cleanly.')); return; }
      if (line.length > 512) fail('Console command is too long. Type subby help.');
      const parts = line.split(/\s+/), verb = parts[1]?.toLowerCase();
      if (parts[0].toLowerCase() !== 'subby') fail('Unknown console command. Type subby help.');
      if ((!verb || verb === 'help') && parts.length <= 2) {
        write('Subby console commands:');
        write('  subby channels');
        write('  subby test sub [channel-or-instance-id] [viewer] [tier 1-3]');
        write('Omit the channel only when exactly one is linked. Defaults: TestViewer, Tier 1.');
        write('Tests add marked [TEST] entries to Minecraft books and may run normal matching rules.'); return;
      }
      if (verb === 'channels' && parts.length === 2) {
        const linked = channels();
        if (!linked.length) { write('Subby: no Twitch channels linked. Connect from Minecraft first.'); return; }
        for (const channel of linked) {
          write('Subby channel: ' + clean(channel.login, 64));
          for (const instance of installations(channel.id)) write('  ' + instance.id + ' | ' + clean(instance.label, 64) + ' | ' + (app.connected(instance.id) ? 'Minecraft connected' : 'Minecraft offline') + ' | ' + store.count(instance.id) + ' pending');
        }
        return;
      }
      if (verb !== 'test' || parts[2]?.toLowerCase() !== 'sub' || parts.length > 6) fail('Use subby test sub [channel-or-instance-id] [viewer] [tier 1-3].');
      const viewer = parts[4] ?? 'TestViewer', tier = parts[5] ?? '1';
      if (!/^[A-Za-z0-9_]{1,25}$/.test(viewer)) fail('Test viewer names must use 1-25 letters, digits, or underscores.');
      if (!/^[1-3]$/.test(tier)) fail('Choose test subscription tier 1, 2, or 3.');
      const selected = target(parts[3]);
      const login = 'subby_test_' + viewer.toLowerCase();
      const event = { messageId: 'console-test-' + randomUUID(), broadcasterId: selected.channel, userId: 'subby-test-' + hash(selected.channel + ':' + login).slice(0, 40), name: '[TEST] ' + viewer, kind: 'sub', tier: tier + '000', months: 1, receivedAt: new Date().toISOString(), details: { login, simulated: 'true', source: 'companion_console' } };
      store.deliver(event, selected.instances.length === 1 ? selected.instances[0].id : undefined);
      app.notify(selected.channel);
      const connected = selected.instances.filter(instance => app.connected(instance.id)).length;
      write('Subby: queued ' + event.name + ' for ' + clean(selected.login, 64) + ' in ' + selected.instances.length + ' Minecraft installation(s); ' + connected + ' currently connected. Offline installations receive it on reconnect.');
      write('This adds a marked book entry and may run matching rules. Hide its name in Minecraft with /subby remove ' + login + '.');
    } catch (error) {
      write('Subby: ' + (error.consoleMessage || error.message?.startsWith('Delivery buffer full;') ? error.message : 'Console command could not finish. Check storage and try again.'));
    }
  }
  lines.on('line', command);
  lines.on('error', () => write('Subby: console input is unavailable; event delivery continues.'));
  write('Subby console ready. Type subby help for commands.');
  return { command, close: () => { lines.close(); input.unref?.(); } };
}
