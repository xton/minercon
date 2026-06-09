// src/test/rconProtocol.test.ts
//
// Replay half of the record/replay harness (see support/fakeSocket.ts and
// support/recordingSocket.ts for the design rationale, and
// fixtures/rcon/script.ts for why the conversation script must be shared and
// exact). Each fixture below is a byte-exact wire conversation — either
// hand-built (synthetic.ts) or recorded against a real server with
// `npm run record-rcon-fixtures` — replayed through a `FakeSocket` so the
// whole stack (auth handshake, packet framing, fragmentation reassembly,
// double-packet termination, error responses) gets exercised deterministically
// and offline.
//
// To register a freshly recorded fixture: run the recorder, review the
// generated src/test/fixtures/rcon/<name>.ts, then add it to FIXTURES below.

import * as assert from 'assert';
import { Logger } from '../logger';
import { RconProtocol } from '../rconProtocol';
import { FakeSocket, RconFixture } from './support/fakeSocket';
import { RconPacketType, encodeRconPacket } from './support/rconWireFormat';
import { RCON_CONVERSATION_SCRIPT } from './fixtures/rcon/script';
import * as synthetic from './fixtures/rcon/synthetic';
import * as xton from './fixtures/rcon/xton';

function silentLogger(): Logger {
  return { info: () => {}, warning: () => {}, error: () => {} };
}

interface NamedFixture {
  name: string;
  fixture: RconFixture;
  password: string;
}

const FIXTURES: NamedFixture[] = [
  { name: 'synthetic', fixture: synthetic.fixture, password: synthetic.password },
  { name: 'xton', fixture: xton.fixture, password: xton.password },
];

suite('rconProtocol: replaying recorded conversations', () => {
  for (const { name, fixture, password } of FIXTURES) {
    test(`${name}: ${fixture.description}`, async () => {
      const socket = new FakeSocket(fixture.frames);
      const protocol = new RconProtocol('fixture-host', 25575, password, silentLogger(), () => socket);

      await protocol.connect();
      assert.strictEqual(protocol.isConnected(), true, 'should be connected and authenticated after replaying the auth handshake');

      assert.strictEqual(
        RCON_CONVERSATION_SCRIPT.length, fixture.expectedResponses.length,
        'fixture.expectedResponses must have one entry per step of the canonical script — did the script change since this fixture was captured?'
      );

      for (let i = 0; i < RCON_CONVERSATION_SCRIPT.length; i++) {
        const response = await protocol.send(RCON_CONVERSATION_SCRIPT[i]);
        assert.strictEqual(response, fixture.expectedResponses[i], `response to "${RCON_CONVERSATION_SCRIPT[i]}" should match what was recorded`);
      }

      await protocol.disconnect();
      socket.assertSatisfied();
    });
  }
});

suite('rconProtocol: connection dropped mid-request', () => {
  test('rejects in-flight commands and reports disconnected when the server closes the socket', async () => {
    const password = 'fixture-password';

    // Hand-authored — this isn't something a recorder can capture on demand
    // (you can't ask a real server to drop the connection at a precise
    // moment), so it's built directly from the wire-format primitives:
    // a normal auth handshake, the command packet `send('list')` emits,
    // and then... nothing. The server just hangs up.
    // The fence is only sent after the first response fragment arrives, so
    // it never appears here — the server closed before replying at all.
    const socket = new FakeSocket([
      { direction: 'sent', data: encodeRconPacket(1, RconPacketType.AUTH, password) },
      { direction: 'received', data: Buffer.concat([
        encodeRconPacket(1, RconPacketType.RESPONSE, ''),
        encodeRconPacket(1, RconPacketType.AUTH_RESPONSE, ''),
      ]) },
      { direction: 'sent', data: encodeRconPacket(2, RconPacketType.COMMAND, 'list') },
      { direction: 'close' },
    ]);
    const protocol = new RconProtocol('fixture-host', 25575, password, silentLogger(), () => socket);

    await protocol.connect();
    assert.strictEqual(protocol.isConnected(), true);

    await assert.rejects(protocol.send('list'), /Connection closed/, 'an in-flight command should be rejected, not left hanging, when the connection drops');
    assert.strictEqual(protocol.isConnected(), false, 'should report disconnected once the socket has closed');
  });
});
