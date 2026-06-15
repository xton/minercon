// Functional tests: local-mode tab completion (the /help crawl + command tree).
// Run against every non-plugin variant — plugin mode is tested separately.

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { LocalCommandTree } from '../../localCommandTree';
import { silentLogger } from '../support/testLogger';
import { nonPluginVariants } from './variants';
import { startServer, stopServer, connectionParams } from './harness';

const silent = silentLogger();

// Commands present on every Minecraft server regardless of variant.
const UNIVERSAL_COMMANDS = ['list', 'help', 'gamemode', 'time', 'weather'];

// Builds a `LocalCommandTree` against `cacheDir` - if an earlier test in
// this suite already populated the cache, this loads instantly with no RCON
// calls; otherwise it performs the full /help crawl.
async function loadCommandTree(host: string, port: number, cacheDir: string): Promise<LocalCommandTree> {
  const ctrl = new RconController(host, port, 'testpassword', silent);
  await ctrl.connect();
  const commandTree = new LocalCommandTree(
    (cmd) => ctrl.send(cmd).then(r => r ?? ''),
    silent,
    cacheDir,
    host,
    port
  );
  await commandTree.initialize();
  await ctrl.disconnect();
  return commandTree;
}

for (const variant of nonPluginVariants) {
  suite(`[${variant.name}] local mode`, function () {
    // /help crawl can make 100+ RCON calls — allow generous time on top of container startup.
    this.timeout(variant.startupTimeoutMs + 180_000);

    let container: StartedTestContainer;
    let host: string;
    let port: number;
    let cacheDir: string;

    suiteSetup(async function () {
      this.timeout(variant.startupTimeoutMs);
      container = await startServer(variant);
      ({ host, port } = connectionParams(container));
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-functional-'));
    });

    suiteTeardown(async () => {
      await stopServer(container);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    test('/help 1 returns a non-empty response', async () => {
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();
      const response = await ctrl.send('help 1');
      assert.ok(typeof response === 'string' && response.length > 0, 'expected /help output');
      await ctrl.disconnect();
    });

    test('LocalCommandTree initializes without error', async function () {
      // The crawl visits every command — budget extra time.
      this.timeout(180_000);
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();
      const commandTree = new LocalCommandTree(
        (cmd) => ctrl.send(cmd).then(r => r ?? ''),
        silent,
        cacheDir,
        host,
        port
      );
      await commandTree.initialize();
      assert.ok(commandTree.isReady, 'expected isReady after initialize()');
      await ctrl.disconnect();
    });

    test('command tree contains universal Minecraft commands', async function () {
      this.timeout(180_000);
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();
      const commandTree = new LocalCommandTree(
        (cmd) => ctrl.send(cmd).then(r => r ?? ''),
        silent,
        cacheDir,
        host,
        port
      );
      await commandTree.initialize();
      await ctrl.disconnect();

      for (const cmd of UNIVERSAL_COMMANDS) {
        const result = commandTree.getSuggestions(`/${cmd}`);
        assert.ok(
          result.suggestions.includes(cmd) || result.suggestions.some(s => s.startsWith(cmd)),
          `expected "${cmd}" in suggestions for input "/${cmd}", got: ${JSON.stringify(result.suggestions.slice(0, 10))}`
        );
      }
    });

    // The following tests exercise the merged /help + minecraft:help crawl
    // (see docs/technical/NO_PLUGIN_HELP_CRAWL.md). They run after the
    // "initializes without error" test above has populated the cache, so
    // loadCommandTree() here is fast (no RCON calls).

    test('gamemode has a required <gamemode> argument and an optional <target> argument', async function () {
      this.timeout(180_000);
      const commandTree = await loadCommandTree(host, port, cacheDir);
      const result = commandTree.getSuggestions('/gamemode ');
      assert.strictEqual(result.argumentHelp, '<gamemode> [<target>]');
    });

    test('team list has a [<team>] parameter', async function () {
      this.timeout(180_000);
      const commandTree = await loadCommandTree(host, port, cacheDir);
      const result = commandTree.getSuggestions('/team list ');
      assert.strictEqual(result.argumentHelp, '[<team>]');
    });

    test('gamerule has dozens of rule variants, each with a [<value>] parameter', async function () {
      this.timeout(180_000);
      const commandTree = await loadCommandTree(host, port, cacheDir);
      const root = commandTree.getSuggestions('/gamerule ');
      assert.ok(
        root.suggestions.length > 30,
        `expected dozens of gamerule variants, got ${root.suggestions.length}: ${JSON.stringify(root.suggestions)}`
      );
      for (const rule of root.suggestions) {
        const detail = commandTree.getSuggestions(`/gamerule ${rule} `);
        assert.strictEqual(
          detail.argumentHelp, '[<value>]',
          `expected "gamerule ${rule}" to have a [<value>] parameter, got "${detail.argumentHelp}"`
        );
      }
    });

    if (variant.name === 'vanilla' || variant.name === 'fabric') {
      test('root command set comes from /help: modern commands present, removed commands absent', async function () {
        this.timeout(180_000);
        const commandTree = await loadCommandTree(host, port, cacheDir);
        assert.ok(commandTree.getSuggestions('/me').suggestions.includes('me'), 'expected "me" command');
        assert.ok(commandTree.getSuggestions('/random').suggestions.includes('random'), 'expected "random" command');
        assert.ok(commandTree.getSuggestions('/transfer').suggestions.includes('transfer'), 'expected "transfer" command');
        assert.ok(!commandTree.getSuggestions('/testfor').suggestions.includes('testfor'), '"testfor" no longer exists');
        assert.ok(!commandTree.getSuggestions('/achievement').suggestions.includes('achievement'), '"achievement" no longer exists');
      });
    }

    if (variant.name === 'paper' || variant.name === 'spigot') {
      test('version and reload get real usage info, not the generic "args" placeholder', async function () {
        this.timeout(180_000);
        const commandTree = await loadCommandTree(host, port, cacheDir);
        const version = commandTree.getSuggestions('/version ');
        assert.notStrictEqual(version.argumentHelp, '[<args>]', `version: ${version.argumentHelp}`);
        const reload = commandTree.getSuggestions('/reload ');
        assert.notStrictEqual(reload.argumentHelp, '[<args>]', `reload: ${reload.argumentHelp}`);
      });
    }

    test('cache loads on second initialize() without making RCON calls', async function () {
      this.timeout(180_000);
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();

      // First pass: populate cache
      const first = new LocalCommandTree(
        (cmd) => ctrl.send(cmd).then(r => r ?? ''),
        silent,
        cacheDir,
        host,
        port
      );
      await first.initialize();

      // Second pass: new instance, same cacheDir — should load from cache.
      // We verify by substituting a sendCommand that throws, so any real
      // network call would fail the test.
      const second = new LocalCommandTree(
        async (_cmd) => { throw new Error('should not make RCON calls when loading from cache'); },
        silent,
        cacheDir,
        host,
        port
      );
      await second.initialize();
      assert.ok(second.isReady, 'expected isReady when loading from cache');

      await ctrl.disconnect();
    });
  });
}
