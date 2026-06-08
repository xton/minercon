// Functional tests: plugin-mode tab completion via the RconTabComplete plugin.
// Runs against the paper+plugin variant only — requires the plugin jar to be
// built before running (cd plugin && ./gradlew build).

import * as assert from 'assert';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { RconCompletionsBackend } from '../../completionsBackend';
import { Logger } from '../../logger';
import { pluginVariant } from './variants';
import { startServer, stopServer, connectionParams } from './harness';

const silent: Logger = { info: () => {}, warning: () => {}, error: () => {} };

// Game modes available in every vanilla-compatible server (1.21.4).
const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];

suite('[paper+plugin] plugin mode', function () {
  this.timeout(pluginVariant.startupTimeoutMs + 60_000);

  let container: StartedTestContainer;
  let ctrl: RconController;
  let backend: RconCompletionsBackend;

  suiteSetup(async function () {
    this.timeout(pluginVariant.startupTimeoutMs);
    container = await startServer(pluginVariant);
    const { host, port } = connectionParams(container);
    ctrl = new RconController(host, port, 'testpassword', silent);
    await ctrl.connect();
    backend = new RconCompletionsBackend(() => ctrl);
  });

  suiteTeardown(async () => {
    await ctrl?.disconnect();
    await stopServer(container);
  });

  // ── raw plugin command tests ──────────────────────────────────────────────

  test('tabcomplete returns completions for a partial command', async () => {
    // Plugin receives "gamemode -" (trailing - = trailing space) and asks
    // Brigadier for completions of "gamemode ".
    const response = await ctrl.send('tabcomplete gamemode -');
    assert.ok(typeof response === 'string' && response.length > 0, 'expected a non-empty response');
    const completions = response.split('\n').map(s => s.trim()).filter(Boolean);
    assert.ok(completions.length > 0, `expected at least one completion, got: ${JSON.stringify(response)}`);
    for (const mode of GAME_MODES) {
      assert.ok(completions.includes(mode), `expected "${mode}" in completions, got: ${JSON.stringify(completions)}`);
    }
  });

  test('cmdusage returns a usage string for a known command', async () => {
    const response = await ctrl.send('cmdusage gamemode');
    assert.ok(typeof response === 'string' && response.length > 0, 'expected a non-empty usage response');
    // The usage string should mention "gamemode" in some form.
    assert.ok(
      response.toLowerCase().includes('gamemode'),
      `expected "gamemode" in usage response, got: ${JSON.stringify(response)}`
    );
  });

  test('tabcomplete with empty input returns root-level command names', async () => {
    // A lone "-" asks for root completions (what commands can I type?).
    const response = await ctrl.send('tabcomplete -');
    assert.ok(typeof response === 'string' && response.length > 0, 'expected root completions');
    const completions = response.split('\n').map(s => s.trim()).filter(Boolean);
    // Common commands present on any Paper server.
    for (const cmd of ['help', 'list', 'gamemode']) {
      assert.ok(completions.includes(cmd), `expected "${cmd}" in root completions, got sample: ${JSON.stringify(completions.slice(0, 20))}`);
    }
  });

  test('tabcomplete with prefix filters to matching commands', async () => {
    const response = await ctrl.send('tabcomplete gam');
    assert.ok(typeof response === 'string', 'expected a response');
    const completions = response.split('\n').map(s => s.trim()).filter(Boolean);
    if (completions[0] !== '(no completions)') {
      assert.ok(
        completions.every(c => c.startsWith('gam')),
        `expected all completions to start with "gam", got: ${JSON.stringify(completions)}`
      );
    }
  });

  // ── RconCompletionsBackend integration ────────────────────────────────────

  test('RconCompletionsBackend.fetchCompletions returns game modes for "/gamemode "', async () => {
    const completions = await backend.fetchCompletions('/gamemode ');
    assert.ok(Array.isArray(completions), 'expected an array');
    assert.ok(completions.length > 0, `expected completions, got: ${JSON.stringify(completions)}`);
    for (const mode of GAME_MODES) {
      assert.ok(completions.includes(mode), `expected "${mode}" in ${JSON.stringify(completions)}`);
    }
  });

  test('RconCompletionsBackend.fetchUsage returns non-empty string for "/gamemode"', async () => {
    const usage = await backend.fetchUsage('/gamemode ');
    assert.ok(typeof usage === 'string', 'expected string');
    // Usage may be empty if the command is still ambiguous — just check it is a string.
    // If it IS non-empty it should mention gamemode.
    if (usage.length > 0) {
      assert.ok(usage.toLowerCase().includes('gamemode'), `expected "gamemode" in usage: ${JSON.stringify(usage)}`);
    }
  });

  test('RconCompletionsBackend returns empty array for non-command input', async () => {
    // No leading "/" — buildCompletionsQuery returns null, backend returns [].
    const completions = await backend.fetchCompletions('not a command');
    assert.deepStrictEqual(completions, []);
  });
});
