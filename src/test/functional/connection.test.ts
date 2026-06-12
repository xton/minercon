// Functional tests: RCON connection and authentication, run against every
// server variant (vanilla, paper, paper+plugin, spigot, fabric).
// Each suite starts a fresh container, runs its tests, then stops it.

import * as assert from 'assert';
import { StartedTestContainer } from 'testcontainers';
import { RconController } from '../../rconClient';
import { Logger } from '../../logger';
import { variants, PASSWORD } from './variants';
import { startServer, stopServer, connectionParams } from './harness';

const silent: Logger = { info: () => {}, warning: () => {}, error: () => {}, debug: () => {} };

for (const variant of variants) {
  suite(`[${variant.name}] connection`, function () {
    // Covers the container startup time + test execution.
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

    test('authenticates with correct password', async () => {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();
      assert.ok(ctrl.isConnected());
      await ctrl.disconnect();
    });

    test('rejects wrong password', async () => {
      const ctrl = new RconController(host, port, 'wrongpassword', silent);
      await assert.rejects(() => ctrl.connect(), /Authentication failed/i);
    });

    test('sends a command and receives a string response', async () => {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();
      const response = await ctrl.send('list');
      assert.ok(typeof response === 'string', `expected string, got ${JSON.stringify(response)}`);
      assert.ok(response.length > 0, 'expected non-empty response');
      await ctrl.disconnect();
    });

    test('multiple sequential commands all succeed', async () => {
      const ctrl = new RconController(host, port, PASSWORD, silent);
      await ctrl.connect();
      for (const cmd of ['list', 'help 1', 'time query daytime']) {
        const r = await ctrl.send(cmd);
        assert.ok(typeof r === 'string', `command "${cmd}" returned non-string: ${JSON.stringify(r)}`);
      }
      await ctrl.disconnect();
    });
  });
}
