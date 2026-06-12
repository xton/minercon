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
import { FakeSocket, RconFixture, RconFrame } from './support/fakeSocket';
import { RconPacketType, encodeRconPacket, splitIntoChunks } from './support/rconWireFormat';
import { RCON_CONVERSATION_SCRIPT } from './fixtures/rcon/script';
import * as synthetic from './fixtures/rcon/synthetic';
import * as xton from './fixtures/rcon/xton';

function silentLogger(): Logger {
  return { info: () => {}, warning: () => {}, error: () => {}, debug: () => {} };
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

suite('rconProtocol: adversarial / malformed packets', () => {
  /** A normal auth handshake (request id 1) — shared setup for tests below that get past auth and exercise the post-auth packet handling. */
  const authFrames = (password: string): RconFrame[] => [
    { direction: 'sent', data: encodeRconPacket(1, RconPacketType.AUTH, password) },
    { direction: 'received', data: Buffer.concat([
      encodeRconPacket(1, RconPacketType.RESPONSE, ''),
      encodeRconPacket(1, RconPacketType.AUTH_RESPONSE, ''),
    ]) },
  ];

  test('connect() rejects with "Authentication failed" when the server reports a bad password (id -1)', async () => {
    const password = 'wrong-password';

    // Real servers respond to a failed auth with a single SERVERDATA_AUTH_RESPONSE
    // packet whose id is -1 (instead of echoing the request id).
    const socket = new FakeSocket([
      { direction: 'sent', data: encodeRconPacket(1, RconPacketType.AUTH, password) },
      { direction: 'received', data: encodeRconPacket(-1, RconPacketType.AUTH_RESPONSE, '') },
    ]);
    const protocol = new RconProtocol('fixture-host', 25575, password, silentLogger(), () => socket);

    await assert.rejects(protocol.connect(), /Authentication failed/);
    assert.strictEqual(protocol.isConnected(), false);

    socket.assertSatisfied();
  });

  test('a packet with an implausibly small declared size is logged and skipped without disrupting the packets around it', async () => {
    const password = 'fixture-password';
    const errors: string[] = [];
    const logger: Logger = { info: () => {}, warning: () => {}, error: (msg) => errors.push(msg), debug: () => {} };

    // Declares a 1-byte packet (size + 4 = 5 bytes total) — too small for
    // parsePacket's 14-byte minimum, so handleData's catch block fires.
    const garbage = Buffer.alloc(5);
    garbage.writeInt32LE(1, 0);

    const socket = new FakeSocket([
      ...authFrames(password),
      { direction: 'sent', data: encodeRconPacket(2, RconPacketType.COMMAND, 'list') },
      // The garbage packet is immediately followed, in the same chunk, by the
      // real response — handleData must recover and parse it correctly.
      { direction: 'received', data: Buffer.concat([garbage, encodeRconPacket(2, RconPacketType.RESPONSE, 'ok')]) },
      { direction: 'sent', data: encodeRconPacket(3, RconPacketType.COMMAND, '') },
      { direction: 'received', data: encodeRconPacket(3, RconPacketType.RESPONSE, '') },
    ]);
    const protocol = new RconProtocol('fixture-host', 25575, password, logger, () => socket);

    await protocol.connect();
    const response = await protocol.send('list');
    assert.strictEqual(response, 'ok', 'the real response is still parsed correctly after the malformed packet');
    assert.ok(errors.some(e => e.includes('Packet too small')), 'the malformed packet is logged as an error');

    socket.assertSatisfied();
    await protocol.disconnect();
  });

  test('an unsolicited response packet with an unknown request ID is logged and ignored', async () => {
    const password = 'fixture-password';
    const warnings: string[] = [];
    const logger: Logger = { info: () => {}, warning: (msg) => warnings.push(msg), error: () => {}, debug: () => {} };

    const socket = new FakeSocket([
      ...authFrames(password),
      { direction: 'sent', data: encodeRconPacket(2, RconPacketType.COMMAND, 'list') },
      // A stray packet for a request ID nothing is waiting on (e.g. a
      // duplicate/late response), arriving in the same chunk as the real one.
      { direction: 'received', data: Buffer.concat([
        encodeRconPacket(999, RconPacketType.RESPONSE, 'unexpected'),
        encodeRconPacket(2, RconPacketType.RESPONSE, 'ok'),
      ]) },
      { direction: 'sent', data: encodeRconPacket(3, RconPacketType.COMMAND, '') },
      { direction: 'received', data: encodeRconPacket(3, RconPacketType.RESPONSE, '') },
    ]);
    const protocol = new RconProtocol('fixture-host', 25575, password, logger, () => socket);

    await protocol.connect();
    const response = await protocol.send('list');
    assert.strictEqual(response, 'ok', 'the real response is still delivered despite the stray packet');
    assert.ok(warnings.some(w => w.includes('999')), 'the stray packet is logged with its unknown request ID');

    socket.assertSatisfied();
    await protocol.disconnect();
  });

  test('an incomplete packet header followed by connection close still rejects the in-flight command with "Connection closed"', async () => {
    const password = 'fixture-password';

    // Declares a packet far larger than ever arrives, then the server hangs up.
    const incompleteHeader = Buffer.alloc(4);
    incompleteHeader.writeInt32LE(9999, 0);

    const socket = new FakeSocket([
      ...authFrames(password),
      { direction: 'sent', data: encodeRconPacket(2, RconPacketType.COMMAND, 'list') },
      { direction: 'received', data: incompleteHeader },
      { direction: 'close' },
    ]);
    const protocol = new RconProtocol('fixture-host', 25575, password, silentLogger(), () => socket);

    await protocol.connect();
    await assert.rejects(protocol.send('list'), /Connection closed/);
    assert.strictEqual(protocol.isConnected(), false);
  });

  test('a response packet split into single-byte chunks across many data events is reassembled correctly', async () => {
    const password = 'fixture-password';
    const responseBody = 'reassembled one byte at a time';

    const responsePacket = encodeRconPacket(2, RconPacketType.RESPONSE, responseBody);
    const byteFrames: RconFrame[] = splitIntoChunks(responsePacket, 1).map(data => ({ direction: 'received', data }));

    const socket = new FakeSocket([
      ...authFrames(password),
      { direction: 'sent', data: encodeRconPacket(2, RconPacketType.COMMAND, 'list') },
      ...byteFrames,
      { direction: 'sent', data: encodeRconPacket(3, RconPacketType.COMMAND, '') },
      { direction: 'received', data: encodeRconPacket(3, RconPacketType.RESPONSE, '') },
    ]);
    const protocol = new RconProtocol('fixture-host', 25575, password, silentLogger(), () => socket);

    await protocol.connect();
    const response = await protocol.send('list');
    assert.strictEqual(response, responseBody);

    socket.assertSatisfied();
    await protocol.disconnect();
  });
});
