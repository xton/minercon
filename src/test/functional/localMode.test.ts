// Functional tests: local-mode tab completion (the /help crawl + command tree).
// Run against every non-plugin variant — plugin mode is tested separately.

import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { CommandAutocomplete } from '../../commandAutocomplete';
import { Logger } from '../../logger';
import { nonPluginVariants } from './variants';
import { startServer, connectionParams } from './harness';

const silent: Logger = { info: () => {}, warning: () => {}, error: () => {} };

// Commands present on every Minecraft server regardless of variant.
const UNIVERSAL_COMMANDS = ['list', 'help', 'gamemode', 'time', 'weather'];

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
      await container?.stop();
      fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    test('/help 1 returns a non-empty response', async () => {
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();
      const response = await ctrl.send('help 1');
      assert.ok(typeof response === 'string' && response.length > 0, 'expected /help output');
      await ctrl.disconnect();
    });

    test('CommandAutocomplete initializes without error', async function () {
      // The crawl visits every command — budget extra time.
      this.timeout(180_000);
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();
      const autocomplete = new CommandAutocomplete(
        (cmd) => ctrl.send(cmd).then(r => r ?? ''),
        silent,
        cacheDir,
        host,
        port
      );
      await autocomplete.initialize();
      assert.ok(autocomplete.isReady, 'expected isReady after initialize()');
      await ctrl.disconnect();
    });

    test('command tree contains universal Minecraft commands', async function () {
      this.timeout(180_000);
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();
      const autocomplete = new CommandAutocomplete(
        (cmd) => ctrl.send(cmd).then(r => r ?? ''),
        silent,
        cacheDir,
        host,
        port
      );
      await autocomplete.initialize();
      await ctrl.disconnect();

      for (const cmd of UNIVERSAL_COMMANDS) {
        const result = autocomplete.getSuggestions(cmd);
        assert.ok(
          result.suggestions.includes(cmd) || result.suggestions.some(s => s.startsWith(cmd)),
          `expected "${cmd}" in suggestions for input "${cmd}", got: ${JSON.stringify(result.suggestions.slice(0, 10))}`
        );
      }
    });

    test('cache loads on second initialize() without making RCON calls', async function () {
      this.timeout(180_000);
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();

      // First pass: populate cache
      const first = new CommandAutocomplete(
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
      const second = new CommandAutocomplete(
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
