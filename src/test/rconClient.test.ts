// src/test/rconClient.test.ts
//
// `RconController` is a thin wrapper around `RconProtocol`, but it owns one
// genuinely important piece of stateful logic: `sendQueue` serializes every
// `send` so at most one RCON exchange is ever in flight (see the comment on
// `sendQueue` in rconClient.ts — concurrent sends make the server hang up).
// `RconProtocol` itself is exercised byte-exact via the record/replay harness
// (rconProtocol.test.ts), so here we substitute a lightweight `FakeProtocol`
// through the `createProtocol` seam (mirroring `RconProtocol`'s own
// `createSocket` injection) and test the controller's own behavior in
// isolation: queueing/serialization, error containment, and event wiring.

import * as assert from 'assert';
import { EventEmitter } from 'events';
import { RconController } from '../rconClient';
import { RconProtocol } from '../rconProtocol';
import { recordingLogger } from './support/testLogger';

class FakeProtocol extends EventEmitter {
    connected = false;
    sendCalls: string[] = [];
    disconnectCalls = 0;

    constructor(private sendImpl: (cmd: string) => Promise<string>) {
        super();
    }

    async connect(): Promise<void> { this.connected = true; }

    async send(cmd: string): Promise<string> {
        this.sendCalls.push(cmd);
        return this.sendImpl(cmd);
    }

    async disconnect(): Promise<void> {
        this.disconnectCalls++;
        this.connected = false;
    }

    isConnected(): boolean { return this.connected; }
}

function setup(sendImpl: (cmd: string) => Promise<string> = async (cmd) => `done:${cmd}`) {
    const { logger, calls } = recordingLogger();

    let lastProtocol: FakeProtocol | undefined;
    const controller = new RconController('host', 25575, 'pw', logger, () => {
        lastProtocol = new FakeProtocol(sendImpl);
        return lastProtocol as unknown as RconProtocol;
    });

    return { controller, calls, protocol: () => lastProtocol! };
}

suite('RconController: connection lifecycle', () => {
    test('isConnected is false, and disconnect a no-op, before connecting', async () => {
        const { controller } = setup();
        assert.strictEqual(controller.isConnected(), false);
        await controller.disconnect(); // should not throw
        assert.strictEqual(controller.isConnected(), false);
    });

    test('connect establishes the underlying protocol and reflects its connected state', async () => {
        const { controller, protocol } = setup();
        await controller.connect();
        assert.strictEqual(controller.isConnected(), true);
        assert.strictEqual(protocol().connected, true);
    });

    test('connect wires up an error handler that logs protocol errors', async () => {
        const { controller, protocol, calls } = setup();
        await controller.connect();

        protocol().emit('error', new Error('socket exploded'));

        assert.ok(calls.error.some(([m]) => String(m).includes('socket exploded')), `expected an error log mentioning the failure, got: ${JSON.stringify(calls.error)}`);
    });

    test('a "close" event from the protocol clears the client, so isConnected goes false and sends are rejected', async () => {
        const { controller, protocol } = setup();
        await controller.connect();

        protocol().emit('close');

        assert.strictEqual(controller.isConnected(), false);
        await assert.rejects(controller.send('list'), /Not connected/);
    });

    test('disconnect delegates to the protocol, swallows its errors, and clears the client', async () => {
        const { controller, protocol } = setup();
        await controller.connect();
        protocol().disconnect = async () => { throw new Error('disconnect blew up'); };

        await controller.disconnect(); // should not throw

        assert.strictEqual(controller.isConnected(), false);
    });
});

suite('RconController: send', () => {
    test('rejects with "Not connected" when called before connect', async () => {
        const { controller } = setup();
        await assert.rejects(controller.send('list'), /Not connected/);
    });

    test('serializes commands through the queue — a second call waits for the first to finish', async () => {
        let resolveFirst: (value: string) => void = () => {};
        const firstGate = new Promise<string>((resolve) => { resolveFirst = resolve; });
        let secondStarted = false;

        const { controller, protocol } = setup(async (cmd) => {
            if (cmd === 'first') { return firstGate; }
            secondStarted = true;
            return `done:${cmd}`;
        });
        await controller.connect();

        const firstPromise = controller.send('first');
        const secondPromise = controller.send('second');

        // However many microtask ticks pass, "second" cannot have started —
        // it's chained behind "first" resolving, not merely scheduled later.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        assert.strictEqual(secondStarted, false, 'the second command must not start until the first resolves');

        resolveFirst('done:first');
        assert.strictEqual(await firstPromise, 'done:first');
        assert.strictEqual(await secondPromise, 'done:second');
        assert.deepStrictEqual(protocol().sendCalls, ['first', 'second']);
    });

    test('a rejected command is reported but does not wedge the queue for subsequent sends', async () => {
        const { controller, calls } = setup(async (cmd) => {
            if (cmd === 'boom') { throw new Error('kaboom'); }
            return `done:${cmd}`;
        });
        await controller.connect();

        await assert.rejects(controller.send('boom'), /kaboom/);
        assert.ok(calls.error.some(([m]) => String(m).includes('kaboom')), `expected an error log mentioning the failure, got: ${JSON.stringify(calls.error)}`);

        assert.strictEqual(await controller.send('after'), 'done:after');
    });

    test('logs a debug line for the send and a debug line for the recv, with the elapsed time', async () => {
        const { controller, calls } = setup(async (cmd) => `done:${cmd}`);
        await controller.connect();

        await controller.send('list');

        assert.ok(calls.debug.some(([m]) => m === 'send: list'), `expected a "send: list" debug line, got: ${JSON.stringify(calls.debug)}`);
        assert.ok(
            calls.debug.some(([m]) => typeof m === 'string' && /^recv \(\+\d+ms\): list -> \d+ chars$/.test(m)),
            `expected a "recv (+Nms): list -> N chars" debug line, got: ${JSON.stringify(calls.debug)}`,
        );
    });
});
