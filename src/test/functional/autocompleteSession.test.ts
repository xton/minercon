// Functional tests: end-to-end tab-completion and usage-hint rendering,
// driven through a real RconSession (the same orchestrator used by the VS
// Code terminal and the CLI) against a real server-side tabcomplete
// plugin/mod. Where pluginMode.test.ts checks the raw `tabcomplete`/
// `cmdusage` RCON commands and the completions backend in isolation, this
// file exercises the full completion engine — live-as-you-type suggestions,
// Tab cycling, paging, argument-hint display, and Escape — and asserts on the
// actual ANSI output a terminal would receive.
//
// Requires the relevant jar to be built first:
//   paper+plugin / spigot+plugin: cd plugin && ./gradlew build
//   fabric+mod:                   cd fabric-mod && ./gradlew build

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { RconSession, RconSessionHost } from '../../rconSession';
import { Logger } from '../../logger';
import { addonVariants, PASSWORD } from './variants';
import { startServer, stopServer, connectionParams } from './harness';

const silent: Logger = { info: () => {}, warning: () => {}, error: () => {}, debug: () => {} };

// Game modes available in every vanilla-compatible server (1.21.4).
const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];

/** Polls until `predicate` is true, or fails with a clear message after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

interface Harness {
  session: RconSession;
  writes: string[];
  output(): string;
}

/** Feeds `text` through `handleInput` one character at a time, like a real terminal would. */
function type(h: Harness, text: string): void {
  for (const ch of text) {
    h.session.handleInput(ch);
  }
}

for (const variant of addonVariants) {
  suite(`[${variant.name}] autocomplete session`, function () {
    this.timeout(variant.startupTimeoutMs + 60_000);

    let container: StartedTestContainer;
    let host: string;
    let port: number;
    let cacheDir: string;

    suiteSetup(async function () {
      this.timeout(variant.startupTimeoutMs);
      container = await startServer(variant);
      ({ host, port } = connectionParams(container));
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-autocomplete-test-'));
    });

    suiteTeardown(async () => {
      await stopServer(container);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    // Each test gets a fresh RconController + RconSession for isolation — a
    // failure in one test won't leave the shared connection or completion
    // engine state in a bad place for the rest.
    async function openSession(): Promise<{ ctrl: RconController; h: Harness }> {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();

      const writes: string[] = [];
      const sessionHost: RconSessionHost = {
        write: (text) => writes.push(text),
        close: () => {},
        clipboard: {
          readText: () => Promise.resolve(''),
          writeText: () => Promise.resolve(),
        },
        cacheDir,
        dimensions: () => undefined,
      };

      const session = new RconSession(ctrl, host, port, PASSWORD, silent, sessionHost);
      const h: Harness = { session, writes, output: () => writes.join('') };

      session.open();
      await waitUntil(() => h.output().includes('tab-complete plugin detected'));
      h.writes.length = 0;

      return { ctrl, h };
    }

    /** Dumps the in-progress line into the output (via Ctrl+L) and extracts the word following "/gamemode ", if any. */
    function currentGamemodeArg(h: Harness): string | undefined {
      h.writes.length = 0;
      h.session.handleInput('\x0c');
      const match = h.output().match(/\/gamemode (\w+)/);
      return match?.[1];
    }

    test('typing "/gamemode " shows the four game mode completions', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/gamemode ');
      await waitUntil(() => h.output().includes('Page 1/'));

      const out = h.output();
      for (const mode of GAME_MODES) {
        assert.ok(out.includes(mode), `expected "${mode}" in suggestion list, got: ${JSON.stringify(out)}`);
      }
      assert.ok(out.includes('\x1b[93m→ '), 'highlights the selected suggestion');

      await ctrl.disconnect().catch(() => {});
    });

    test('Tab applies a suggestion to the line and cycles on repeated presses', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/gamemode ');
      await waitUntil(() => h.output().includes('Page 1/'));

      h.session.handleInput('\t');
      const first = currentGamemodeArg(h);
      assert.ok(first && GAME_MODES.includes(first), `expected a game mode after Tab, got: ${JSON.stringify(h.output())}`);

      h.session.handleInput('\t');
      const second = currentGamemodeArg(h);
      assert.ok(second && GAME_MODES.includes(second), `expected a game mode after second Tab, got: ${JSON.stringify(h.output())}`);
      assert.notStrictEqual(second, first, 'a second Tab should cycle to a different suggestion');

      await ctrl.disconnect().catch(() => {});
    });

    test('typing a full command highlights the next argument in the usage hint', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/gamemode survival ');
      await waitUntil(() => h.output().includes('\x1b[1;97m'));

      const out = h.output();
      assert.ok(out.includes('gamemode'), `usage hint should reference "gamemode", got: ${JSON.stringify(out)}`);
      // <target> is an optional trailing argument: the paper/spigot plugin
      // and the fabric mod both emit getSmartUsage's compact form now, so it
      // must arrive bracketed as "[<target>]" — the bare "<target>" ladder
      // form would mean a regression to getAllUsage.
      assert.ok(out.includes('\x1b[1;97m[<target>]'), `expected "[<target>]" to be highlighted as the current argument, got: ${JSON.stringify(out)}`);

      await ctrl.disconnect().catch(() => {});
    });

    test('Escape closes the suggestion list and restores the pre-completion line', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/gamemode ');
      await waitUntil(() => h.output().includes('Page 1/'));

      h.session.handleInput('\t');
      await waitUntil(() => currentGamemodeArg(h) !== undefined);

      h.session.handleInput('\x1b');
      const arg = currentGamemodeArg(h);
      assert.strictEqual(arg, undefined, `expected the line to be restored to "/gamemode ", got: ${JSON.stringify(h.output())}`);

      await ctrl.disconnect().catch(() => {});
    });

    test('typing "/difficulty " shows the four difficulty levels', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/difficulty ');
      await waitUntil(() => h.output().includes('Page 1/'));

      const out = h.output();
      for (const level of ['peaceful', 'easy', 'normal', 'hard']) {
        assert.ok(out.includes(level), `expected "${level}" in suggestion list, got: ${JSON.stringify(out)}`);
      }

      await ctrl.disconnect().catch(() => {});
    });

    test('typing "/time set " shows time-of-day presets', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/time set ');
      await waitUntil(() => h.output().includes('Page 1/'));

      const out = h.output();
      for (const preset of ['day', 'night', 'noon', 'midnight']) {
        assert.ok(out.includes(preset), `expected "${preset}" in suggestion list, got: ${JSON.stringify(out)}`);
      }

      await ctrl.disconnect().catch(() => {});
    });

    test('typing "/weather " shows weather types', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/weather ');
      await waitUntil(() => h.output().includes('Page 1/'));

      const out = h.output();
      for (const weatherType of ['clear', 'rain', 'thunder']) {
        assert.ok(out.includes(weatherType), `expected "${weatherType}" in suggestion list, got: ${JSON.stringify(out)}`);
      }

      await ctrl.disconnect().catch(() => {});
    });

    test('typing "/gamerule " shows a paginated list of game rules', async () => {
      const { ctrl, h } = await openSession();
      type(h, '/gamerule ');
      await waitUntil(() => h.output().includes('Page 1/'));

      const out = h.output();
      assert.ok(out.includes('more below'), `expected a pagination indicator, got: ${JSON.stringify(out)}`);
      assert.ok(out.includes('doDaylightCycle'), `expected "doDaylightCycle" in suggestion list, got: ${JSON.stringify(out)}`);

      await ctrl.disconnect().catch(() => {});
    });
  });
}
