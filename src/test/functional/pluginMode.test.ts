// Functional tests: addon-mode tab completion via the RconTabComplete plugin
// (Paper, Spigot) or Fabric mod. Runs against every variant that carries an
// addon — requires the relevant jar to be built first:
//   paper+plugin / spigot+plugin: cd plugin && ./gradlew build
//   fabric+mod:                   cd fabric-mod && ./gradlew build

import * as assert from 'assert';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { RconCompletionsBackend } from '../../completionsBackend';
import { Logger } from '../../logger';
import { addonVariants } from './variants';
import { startServer, stopServer, connectionParams } from './harness';

const silent: Logger = { info: () => {}, warning: () => {}, error: () => {} };

// Game modes available in every vanilla-compatible server (1.21.4).
const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];

for (const variant of addonVariants) {
  suite(`[${variant.name}] plugin mode`, function () {
    this.timeout(variant.startupTimeoutMs + 60_000);

    let container: StartedTestContainer;
    let host: string;
    let port: number;

    suiteSetup(async function () {
      this.timeout(variant.startupTimeoutMs);
      container = await startServer(variant);
      ({ host, port } = connectionParams(container));
    });

    suiteTeardown(async () => {
      await stopServer(container);
    });

    // Each test gets a fresh RconController for isolation — a failure in one
    // test won't leave the shared connection in a bad state for the rest.
    async function connect(): Promise<RconController> {
      const ctrl = new RconController(host, port, 'testpassword', silent);
      await ctrl.connect();
      return ctrl;
    }

    // ── raw plugin/mod command tests ──────────────────────────────────────────

    test('tabcomplete returns completions for a partial command', async () => {
      const ctrl = await connect();
      const response = await ctrl.send('tabcomplete gamemode -');
      assert.ok(typeof response === 'string' && response.length > 0, 'expected a non-empty response');
      const completions = response.split('\n').map(s => s.trim()).filter(Boolean);
      assert.ok(completions.length > 0, `expected at least one completion, got: ${JSON.stringify(response)}`);
      for (const mode of GAME_MODES) {
        assert.ok(completions.includes(mode), `expected "${mode}" in completions, got: ${JSON.stringify(completions)}`);
      }
      await ctrl.disconnect().catch(() => {});
    });

    test('cmdusage returns a usage string for a known command', async () => {
      const ctrl = await connect();
      const response = await ctrl.send('cmdusage gamemode');
      assert.ok(typeof response === 'string' && response.length > 0, 'expected a non-empty usage response');
      assert.ok(
        response.toLowerCase().includes('gamemode'),
        `expected "gamemode" in usage response, got: ${JSON.stringify(response)}`
      );
      await ctrl.disconnect().catch(() => {});
    });

    test('tabcomplete with empty input returns root-level command names', async () => {
      const ctrl = await connect();
      const response = await ctrl.send('tabcomplete -');
      assert.ok(typeof response === 'string' && response.length > 0, 'expected root completions');
      const completions = response.split('\n').map(s => s.trim()).filter(Boolean);
      for (const cmd of ['help', 'list', 'gamemode']) {
        assert.ok(completions.includes(cmd), `expected "${cmd}" in root completions, got sample: ${JSON.stringify(completions.slice(0, 20))}`);
      }
      await ctrl.disconnect().catch(() => {});
    });

    test('tabcomplete with prefix filters to matching commands', async () => {
      const ctrl = await connect();
      const response = await ctrl.send('tabcomplete gam');
      assert.ok(typeof response === 'string', 'expected a response');
      const completions = response.split('\n').map(s => s.trim()).filter(Boolean);
      if (completions.length > 0 && completions[0] !== '(no completions)') {
        assert.ok(
          completions.every(c => c.startsWith('gam')),
          `expected all completions to start with "gam", got: ${JSON.stringify(completions)}`
        );
      }
      await ctrl.disconnect().catch(() => {});
    });

    // ── RconCompletionsBackend integration ────────────────────────────────────

    test('RconCompletionsBackend.fetchCompletions returns game modes for "/gamemode "', async () => {
      const ctrl = await connect();
      const backend = new RconCompletionsBackend(() => ctrl);
      const completions = await backend.fetchCompletions('/gamemode ');
      assert.ok(Array.isArray(completions), 'expected an array');
      assert.ok(completions.length > 0, `expected completions, got: ${JSON.stringify(completions)}`);
      for (const mode of GAME_MODES) {
        assert.ok(completions.includes(mode), `expected "${mode}" in ${JSON.stringify(completions)}`);
      }
      await ctrl.disconnect().catch(() => {});
    });

    test('RconCompletionsBackend.fetchUsage returns non-empty string for "/gamemode"', async () => {
      const ctrl = await connect();
      const backend = new RconCompletionsBackend(() => ctrl);
      const usage = await backend.fetchUsage('/gamemode ');
      assert.ok(typeof usage === 'string', 'expected string');
      if (usage.length > 0) {
        assert.ok(usage.toLowerCase().includes('gamemode'), `expected "gamemode" in usage: ${JSON.stringify(usage)}`);
      }
      await ctrl.disconnect().catch(() => {});
    });

    test('RconCompletionsBackend returns empty array for non-command input', async () => {
      const ctrl = await connect();
      const backend = new RconCompletionsBackend(() => ctrl);
      const completions = await backend.fetchCompletions('not a command');
      assert.deepStrictEqual(completions, []);
      await ctrl.disconnect().catch(() => {});
    });
  });
}
