// Functional tests: addon-mode tab completion via the Paper/Spigot
// TabComplete plugin or Fabric mod. Runs against every variant that carries
// an addon — requires the relevant jar to be built first:
//   paper+plugin:  cd paper-plugin && ./gradlew build
//   spigot+plugin: cd spigot-plugin && ./gradlew build
//   fabric+mod:    cd fabric-mod && ./gradlew build

import * as assert from 'assert';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { RconCompletionBackend } from '../../completionBackend';
import { responseSupportsRcat } from '../../unpaginate';
import { silentLogger } from '../support/testLogger';
import { addonVariants } from './variants';
import { startServer, stopServer, connectionParams } from './harness';

const silent = silentLogger();

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

    // ── RconCompletionBackend integration ────────────────────────────────────

    test('RconCompletionBackend.fetchCompletions returns game modes for "/gamemode "', async () => {
      const ctrl = await connect();
      const backend = new RconCompletionBackend(() => ctrl);
      const completions = await backend.fetchCompletions('/gamemode ');
      assert.ok(Array.isArray(completions), 'expected an array');
      assert.ok(completions.length > 0, `expected completions, got: ${JSON.stringify(completions)}`);
      for (const mode of GAME_MODES) {
        assert.ok(completions.includes(mode), `expected "${mode}" in ${JSON.stringify(completions)}`);
      }
      await ctrl.disconnect().catch(() => {});
    });

    test('RconCompletionBackend.fetchUsage returns non-empty string for "/gamemode"', async () => {
      const ctrl = await connect();
      const backend = new RconCompletionBackend(() => ctrl);
      const usage = await backend.fetchUsage('/gamemode ');
      assert.ok(typeof usage === 'string', 'expected string');
      if (usage.length > 0) {
        assert.ok(usage.toLowerCase().includes('gamemode'), `expected "gamemode" in usage: ${JSON.stringify(usage)}`);
      }
      await ctrl.disconnect().catch(() => {});
    });

    test('RconCompletionBackend returns empty array for non-command input', async () => {
      const ctrl = await connect();
      const backend = new RconCompletionBackend(() => ctrl);
      const completions = await backend.fetchCompletions('not a command');
      assert.deepStrictEqual(completions, []);
      await ctrl.disconnect().catch(() => {});
    });

    // ── rcat unpaginated-output wrapper ───────────────────────────────────────
    //
    // Bukkit-family servers (Paper/Spigot) paginate `/help` to ~9-line pages for
    // the RCON sender; `rcat help` re-dispatches as a console sender so the full
    // list comes back unpaginated. Fabric is pure Brigadier — nothing paginates
    // and the mod ships no `rcat` — so these are gated on server type.
    const isBukkit = variant.type === 'PAPER' || variant.type === 'SPIGOT';

    if (isBukkit) {
      test('rcat strips Bukkit pagination from /help', async () => {
        const ctrl = await connect();
        const raw = await ctrl.send('help');
        const wrapped = await ctrl.send('rcat help');

        // Regression guard: the de-pagination once sent help to the *server log*
        // and returned nothing ("(no response)"); a related regression would be
        // a single ~9-line page leaking back. The full, de-paginated help index
        // is the whole command list — multiple KB — so assert it's substantially
        // large, not merely non-empty (a single page is only a few hundred bytes).
        assert.ok(wrapped.length > 1000, `rcat help should return the full (multi-KB) command index, got ${wrapped.length} bytes (output leaked to the server log, or still paginated?)`);
        assert.ok(/Help: Index \(1\//i.test(raw), `expected raw /help to be paginated, got: ${JSON.stringify(raw.slice(0, 200))}`);
        assert.ok(!/Help: Index \(1\//i.test(wrapped), `rcat help should not carry a pagination header, got: ${JSON.stringify(wrapped.slice(0, 200))}`);

        const rawLines = raw.split('\n').filter(Boolean).length;
        const wrappedLines = wrapped.split('\n').filter(Boolean).length;
        assert.ok(wrappedLines > rawLines, `rcat help (${wrappedLines} lines) should have more than one raw page (${rawLines} lines)`);
        await ctrl.disconnect().catch(() => {});
      });

      test('rcat help is complete and arrives whole across RCON packets', async () => {
        const ctrl = await connect();
        const wrapped = await ctrl.send('rcat help');
        // Many commands across the alphabet in one response → exercises the
        // multi-packet reassembly (a single RCON packet caps at 4096 bytes).
        assert.ok(wrapped.length > 4096, `expected a large multi-packet response, got ${wrapped.length} bytes`);
        const lower = wrapped.toLowerCase();
        for (const cmd of ['ban', 'gamemode', 'help', 'list', 'whitelist']) {
          assert.ok(lower.includes(cmd), `expected "${cmd}" somewhere in the full help, missing from rcat output`);
        }
        await ctrl.disconnect().catch(() => {});
      });

      test('rcat passes vanilla commands through with their output intact', async () => {
        const ctrl = await connect();
        const list = await ctrl.send('rcat list');
        assert.ok(/players? online/i.test(list), `expected a player-list line, got: ${JSON.stringify(list)}`);
        const gamemode = await ctrl.send('rcat gamemode');
        assert.ok(typeof gamemode === 'string' && gamemode.trim().length > 0, 'expected non-empty output for rcat gamemode');
        await ctrl.disconnect().catch(() => {});
      });

      test('rcat on an unknown command reports it cleanly (no plugin crash)', async () => {
        const ctrl = await connect();
        const response = await ctrl.send('rcat thiscommanddoesnotexist');
        assert.ok(typeof response === 'string' && response.trim().length > 0, 'expected a response');
        assert.ok(!/Exception|stack trace|\bat dev\.rcon\b/i.test(response), `unexpected error trace: ${JSON.stringify(response)}`);
        await ctrl.disconnect().catch(() => {});
      });

      test('the rcat capability probe reports support', async () => {
        const ctrl = await connect();
        const probe = await ctrl.send('rcat');
        assert.ok(responseSupportsRcat(probe), `expected the rcat probe marker, got: ${JSON.stringify(probe)}`);
        await ctrl.disconnect().catch(() => {});
      });
    } else {
      // Fabric: confirm there is nothing to de-paginate server-side and that the
      // client correctly declines to wrap (no `rcat` command exists).
      test('Fabric /help is not paginated and rcat is unsupported', async () => {
        const ctrl = await connect();
        const help = await ctrl.send('help');
        assert.ok(!/Help: Index \(1\//i.test(help), `Fabric /help should be one-shot, got: ${JSON.stringify(help.slice(0, 200))}`);
        const probe = await ctrl.send('rcat');
        assert.ok(!responseSupportsRcat(probe), 'Fabric has no rcat command, so the probe must report unsupported');
        await ctrl.disconnect().catch(() => {});
      });
    }
  });
}
