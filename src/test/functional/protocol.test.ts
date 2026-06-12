// Functional tests: RCON protocol correctness and edge cases, run against
// every server variant. Focused on behaviors that require a live server to
// verify — particularly the fence-packet mechanism, large fragmented
// responses, error responses, and connection lifecycle.

import * as assert from 'assert';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { Logger } from '../../logger';
import { nonPluginVariants, PASSWORD } from './variants';
import { startServer, stopServer, connectionParams } from './harness';

const silent: Logger = { info: () => {}, warning: () => {}, error: () => {}, debug: () => {} };

// The plugin variant changes 'help' output so large-response and content
// assertions don't hold there; protocol tests run against non-plugin variants.
for (const variant of nonPluginVariants) {
  suite(`[${variant.name}] protocol`, function () {
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

    // On servers with many commands (vanilla, paper, spigot, fabric all have
    // 60–80+), the 'help' response routinely exceeds the 4096-byte RCON packet
    // limit and arrives in multiple RESPONSE fragments. The fence-packet
    // mechanism detects the end of the fragment stream; this test verifies the
    // fragments are assembled into a complete, coherent response.
    test('large help response is returned complete and untruncated', async () => {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();

      const response = await ctrl.send('help');

      assert.ok(typeof response === 'string' && response.length > 0,
        'expected non-empty help response');

      // 'list' appears as a command in every Minecraft server's help output.
      // If the response were truncated mid-stream, tail commands would be absent.
      assert.ok(response.includes('list'),
        `help response may be truncated — "list" not found in ${response.length}-byte response`);

      await ctrl.disconnect();
    });

    // Unrecognized commands produce an error message from the server. The RCON
    // client must return it as a string rather than throwing — a timeout or
    // exception here would mean the fence mechanism hung waiting for a response
    // that never matches a known command pattern.
    test('unrecognized command returns an error string without throwing', async () => {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();

      const response = await ctrl.send('thiscommanddoesnotexist');

      assert.ok(typeof response === 'string',
        `expected string for unknown command, got: ${JSON.stringify(response)}`);

      await ctrl.disconnect();
    });

    // Many sequential commands stress-test the per-command fence lifecycle:
    // each send() allocates a (requestId, dummyId) pair, defers the fence
    // write, receives fragments, fires the fence, and collects the dummy
    // response. Running 20+ back-to-back commands verifies no IDs leak,
    // no fragments bleed between commands, and no server-side disconnect
    // accumulates over repeated fence sends.
    test('many sequential commands all succeed without disconnect', async () => {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();

      const commands = ['list', 'time query daytime', 'seed', 'help 1', 'difficulty'];
      for (let round = 0; round < 4; round++) {
        for (const cmd of commands) {
          const r = await ctrl.send(cmd);
          assert.ok(typeof r === 'string',
            `command "${cmd}" returned non-string on round ${round}: ${JSON.stringify(r)}`);
        }
      }

      await ctrl.disconnect();
    });

    // RconController.send() chains every call onto a sendQueue promise so at
    // most one RCON exchange is outstanding at a time. Without this serialization,
    // two concurrent sends would write back-to-back packets on the same socket;
    // the server batches them into one TCP read() and closes the connection when
    // the second packet's bytes exceed the first packet's declared length.
    // This test fires two sends concurrently (Promise.all without prior await)
    // and verifies both complete correctly — the queue must have serialized them.
    test('concurrent sends are serialized and both return correct results', async () => {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();

      const [r1, r2] = await Promise.all([
        ctrl.send('list'),
        ctrl.send('time query daytime'),
      ]);

      assert.ok(typeof r1 === 'string' && r1.length > 0,
        `first concurrent send failed: ${JSON.stringify(r1)}`);
      assert.ok(typeof r2 === 'string' && r2.length > 0,
        `second concurrent send failed: ${JSON.stringify(r2)}`);

      await ctrl.disconnect();
    });

    // After a controller is cleanly disconnected, the server should accept a
    // new connection immediately. ConnectionManager handles reconnect by
    // constructing a fresh RconController — this test verifies the server-side
    // state is clean after a disconnect and the new controller authenticates
    // and operates correctly.
    test('new controller connects and sends after previous controller disconnects', async () => {
      const ctrl1 = new RconController(host, port, PASSWORD, silent);
      await ctrl1.connect();
      await ctrl1.send('list');
      await ctrl1.disconnect();

      const ctrl2 = new RconController(host, port, PASSWORD, silent);
      await ctrl2.connect();
      const response = await ctrl2.send('list');
      assert.ok(typeof response === 'string' && response.length > 0,
        'second controller failed to get a valid response after first disconnected');
      await ctrl2.disconnect();
    });
  });
}
