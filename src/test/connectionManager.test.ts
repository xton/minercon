// src/test/connectionManager.test.ts
//
// Tests for ConnectionManager's auto-reconnect/backoff state machine.
//
// Previously a deliberate gap (see rconSession.test.ts): attemptReconnect()
// constructed a real RconController directly, so exercising it would open a
// live socket. ConnectionManager now accepts a `controllerFactory`, so tests
// can supply fake controllers whose connect()/disconnect() behavior — and
// timing — is fully controlled.
//
// reportConnectionLost()/attemptReconnect() schedule retries via
// setTimeout/clearTimeout with delays that grow from 1s up to 32s — far too
// slow to wait out for real. installFakeTimers() below replaces the global
// setTimeout/clearTimeout with a synchronous, manually-driven queue so the
// whole backoff sequence can be driven instantly.

import * as assert from 'assert';
import { Logger } from '../logger';
import { RconController } from '../rconClient';
import { ConnectionManager, ConnectionManagerHost, ControllerFactory } from '../connectionManager';

function silentLogger(): Logger {
  return { error: () => undefined, warning: () => undefined, info: () => undefined };
}

class FakeController {
  connectCalls = 0;
  disconnectCalls = 0;
  private connected: boolean;

  constructor(private readonly connectImpl: () => Promise<void>, initiallyConnected: boolean) {
    this.connected = initiallyConnected;
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    await this.connectImpl();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.connected = false;
  }

  isConnected(): boolean { return this.connected; }
  async send(): Promise<string | undefined> { return ''; }
}

/** Replaces global setTimeout/clearTimeout with a manually-driven queue so backoff delays don't actually elapse. */
function installFakeTimers() {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();

  global.setTimeout = ((callback: () => void, delay?: number) => {
    const id = nextId++;
    pending.set(id, { callback, delay: delay ?? 0 });
    return id as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout;

  global.clearTimeout = ((id: unknown) => {
    pending.delete(id as number);
  }) as unknown as typeof clearTimeout;

  return {
    restore(): void {
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
    },
    /** Fires every timer pending right now, in scheduling order. Newly-scheduled timers from those callbacks are left for the next round. */
    fireAll(): void {
      const toFire = [...pending.values()];
      pending.clear();
      for (const entry of toFire) {
        entry.callback();
      }
    },
    pendingDelays(): number[] {
      return [...pending.values()].map(e => e.delay);
    },
  };
}

/** Lets queued microtasks (the awaits inside attemptReconnect) settle before inspecting state. */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

interface Harness {
  manager: ConnectionManager;
  writes: string[];
  reconnectedCalls: number;
  controllers: FakeController[];
}

/**
 * `connectResults` provides one connect-behavior per reconnect attempt
 * (cycled if there are more attempts than entries): `'ok'` resolves
 * connect(), `'fail'` rejects it.
 */
function createHarness(connectResults: ('ok' | 'fail')[]): Harness {
  const writes: string[] = [];
  let reconnectedCalls = 0;
  const controllers: FakeController[] = [];

  const initialController = new FakeController(() => Promise.resolve(), true);
  controllers.push(initialController);

  let factoryCalls = 0;
  const controllerFactory: ControllerFactory = () => {
    const result = connectResults[Math.min(factoryCalls, connectResults.length - 1)];
    factoryCalls++;
    const ctrl = new FakeController(
      () => (result === 'ok' ? Promise.resolve() : Promise.reject(new Error('connect failed'))),
      false,
    );
    controllers.push(ctrl);
    return ctrl as unknown as RconController;
  };

  const host: ConnectionManagerHost = {
    write: (text) => writes.push(text),
    showPrompt: () => {},
    onReconnected: () => { reconnectedCalls++; },
  };

  const manager = new ConnectionManager(
    'localhost', 25575, 'pw', silentLogger(),
    initialController as unknown as RconController,
    host,
    controllerFactory,
  );

  return { manager, writes, get reconnectedCalls() { return reconnectedCalls; }, controllers };
}

suite('ConnectionManager auto-reconnect/backoff', () => {
  let timers: ReturnType<typeof installFakeTimers>;

  setup(() => {
    timers = installFakeTimers();
  });

  teardown(() => {
    timers.restore();
  });

  test('reportConnectionLost marks the connection as down and schedules a reconnect after 1s', () => {
    const h = createHarness(['ok']);
    h.manager.reportConnectionLost();

    assert.strictEqual(h.manager.isConnected, false);
    assert.deepStrictEqual(timers.pendingDelays(), [1000]);
  });

  test('a successful first attempt reconnects, replaces the controller, and notifies the host', async () => {
    const h = createHarness(['ok']);
    h.manager.reportConnectionLost();

    timers.fireAll(); // fires the 1s reportConnectionLost timer -> attemptReconnect()
    await flushMicrotasks();

    assert.strictEqual(h.manager.isConnected, true);
    assert.strictEqual(h.manager.isReconnecting, false);
    assert.strictEqual(h.reconnectedCalls, 1);
    assert.ok(h.controllers[0].disconnectCalls >= 1, 'the old controller is disconnected');
    assert.strictEqual(h.controllers[1].connectCalls, 1, 'the new controller is connected');
    assert.deepStrictEqual(timers.pendingDelays(), [], 'no retry is scheduled after success');
    assert.ok(h.writes.join('').includes('Reconnected successfully'));
  });

  test('failed attempts back off exponentially: 1s, then 2s, 4s, 8s, 16s between attempts', async () => {
    const h = createHarness(['fail', 'fail', 'fail', 'fail', 'fail']);
    h.manager.reportConnectionLost();

    assert.deepStrictEqual(timers.pendingDelays(), [1000]);

    timers.fireAll(); // attempt 1
    await flushMicrotasks();
    assert.strictEqual(h.manager.isConnected, false);
    assert.strictEqual(h.manager.isReconnecting, false);
    assert.deepStrictEqual(timers.pendingDelays(), [2000]);

    timers.fireAll(); // attempt 2
    await flushMicrotasks();
    assert.deepStrictEqual(timers.pendingDelays(), [4000]);

    timers.fireAll(); // attempt 3
    await flushMicrotasks();
    assert.deepStrictEqual(timers.pendingDelays(), [8000]);

    timers.fireAll(); // attempt 4
    await flushMicrotasks();
    assert.deepStrictEqual(timers.pendingDelays(), [16000]);
  });

  test('after maxReconnectAttempts (5) failures, retries stop and the user is told to /reconnect', async () => {
    const h = createHarness(['fail', 'fail', 'fail', 'fail', 'fail']);
    h.manager.reportConnectionLost();

    timers.fireAll(); // attempt 1 (1s)
    await flushMicrotasks();
    timers.fireAll(); // attempt 2 (2s)
    await flushMicrotasks();
    timers.fireAll(); // attempt 3 (4s)
    await flushMicrotasks();
    timers.fireAll(); // attempt 4 (8s)
    await flushMicrotasks();
    timers.fireAll(); // attempt 5 (16s) — final attempt
    await flushMicrotasks();

    assert.strictEqual(h.manager.isConnected, false);
    assert.strictEqual(h.manager.isReconnecting, false);
    assert.deepStrictEqual(timers.pendingDelays(), [], 'no further retry is scheduled');
    assert.ok(h.writes.join('').includes('Reconnection failed after 5 attempts'));
    assert.ok(h.writes.join('').includes('/reconnect'));
    assert.strictEqual(h.reconnectedCalls, 0);
  });

  test('a later attempt can succeed after earlier failures, resetting attempts and delay', async () => {
    const h = createHarness(['fail', 'fail', 'ok']);
    h.manager.reportConnectionLost();

    timers.fireAll(); // attempt 1: fails, schedules 2s retry
    await flushMicrotasks();
    timers.fireAll(); // attempt 2: fails, schedules 4s retry
    await flushMicrotasks();
    timers.fireAll(); // attempt 3: succeeds
    await flushMicrotasks();

    assert.strictEqual(h.manager.isConnected, true);
    assert.strictEqual(h.reconnectedCalls, 1);
    assert.deepStrictEqual(timers.pendingDelays(), []);

    // A subsequent connection loss starts the backoff over from 1s/2s, not
    // from where the previous sequence left off.
    h.manager.reportConnectionLost();
    assert.deepStrictEqual(timers.pendingDelays(), [1000]);
  });

  test('manualReconnect resets attempts/delay, connects immediately, and clears any pending reconnect timer', async () => {
    const h = createHarness(['ok']);
    h.manager.reportConnectionLost();
    assert.deepStrictEqual(timers.pendingDelays(), [1000]);

    await h.manager.manualReconnect();

    assert.strictEqual(h.manager.isConnected, true);
    assert.strictEqual(h.reconnectedCalls, 1);
    assert.deepStrictEqual(timers.pendingDelays(), [], 'the pending auto-reconnect timer is cleared on success');
    assert.ok(h.writes.join('').includes('Reconnected successfully'));
  });

  test('manualReconnect while already reconnecting is a no-op that tells the user', async () => {
    const h = createHarness(['fail', 'ok']);
    h.manager.reportConnectionLost();

    timers.fireAll(); // attempt 1 starts; FakeController.connect() rejects only after a microtask
    // attemptReconnect() sets isReconnecting synchronously before its first await.
    assert.strictEqual(h.manager.isReconnecting, true);

    await h.manager.manualReconnect();
    assert.ok(h.writes.join('').includes('Already reconnecting...'));

    await flushMicrotasks();
    assert.strictEqual(h.manager.isReconnecting, false);
  });

  test('disconnect() clears any pending reconnect timer and tears down the controller', () => {
    const h = createHarness(['ok']);
    h.manager.reportConnectionLost();
    assert.deepStrictEqual(timers.pendingDelays(), [1000]);

    h.manager.disconnect();

    assert.strictEqual(h.manager.isConnected, false);
    assert.strictEqual(h.manager.isReconnecting, false);
    assert.deepStrictEqual(timers.pendingDelays(), [], 'pending reconnect timer is cleared');
    assert.ok(h.controllers[0].disconnectCalls >= 1);
    assert.ok(h.writes.join('').includes('Connection closed'));
  });

  test('dispose() clears any pending reconnect timer and disconnects the controller', () => {
    const h = createHarness(['ok']);
    h.manager.reportConnectionLost();
    assert.deepStrictEqual(timers.pendingDelays(), [1000]);

    h.manager.dispose();

    assert.deepStrictEqual(timers.pendingDelays(), []);
    assert.ok(h.controllers[0].disconnectCalls >= 1);
  });
});
