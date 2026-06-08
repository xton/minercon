// src/test/fixtures/rcon/synthetic.ts
//
// A hand-built stand-in for a recorded conversation — written so the replay
// suite (and the harness itself) has something byte-exact to run against
// without a live server. It walks through the exact same three-step script
// as a real recording would (script.ts) and is wire-format-correct (built
// with the encode helpers in support/rconWireFormat.ts, which deliberately
// duplicate `RconProtocol`'s framing rather than reuse it — see that file's
// header comment for why).
//
// Once someone runs `npm run record-rcon-fixtures` against a real server,
// its output can live alongside this one — the replay suite runs every
// fixture in this directory through the same assertions. This file is the
// floor, not a substitute for the real thing: it encodes *our* understanding
// of the protocol, so it can't catch the kind of surprise a real server
// produces (unusual fragmentation boundaries, locale quirks in error text,
// a server that skips the empty pre-auth-response packet, etc).

import { RconFixture, RconFrame } from '../../support/fakeSocket';
import { RconPacketType, encodeRconPacket, concatPackets, splitIntoChunks } from '../../support/rconWireFormat';

const PASSWORD = 'test-password';

const LIST_RESPONSE = 'There are 2 of a max of 20 players online: Steve, Alex';
const HELP_FRAGMENT_1 = '/advancement (grant|revoke) ...\n'.repeat(125);   // 4000 bytes — big enough that RconProtocol can't mistake it for the last fragment
const HELP_FRAGMENT_2 = '/xp (add|set|query) <targets> ...\n'.repeat(18); // 612 bytes — the tail end of the response
const HELP_RESPONSE = HELP_FRAGMENT_1 + HELP_FRAGMENT_2;
const UNKNOWN_COMMAND_RESPONSE =
  'Unknown or incomplete command, see below for error\n' +
  'this-command-does-not-exist-zzz12345\n' +
  '<--[HERE]';

const frames: RconFrame[] = [];
function sent(id: number, type: RconPacketType, body: string): void {
  frames.push({ direction: 'sent', data: encodeRconPacket(id, type, body) });
}
function received(...chunks: Buffer[]): void {
  for (const data of chunks) { frames.push({ direction: 'received', data }); }
}

// ── connect + authenticate (request id 1) ──
// Real servers reply with an empty SERVERDATA_RESPONSE_VALUE (type 0)
// immediately followed by SERVERDATA_AUTH_RESPONSE (type 2) — both id 1.
// `RconProtocol.handlePacket` only resolves on the second.
sent(1, RconPacketType.AUTH, PASSWORD);
received(concatPackets(
  encodeRconPacket(1, RconPacketType.RESPONSE, ''),
  encodeRconPacket(1, RconPacketType.AUTH_RESPONSE, ''),
));

// ── send('list') — short, single-packet response (request id 2, dummy id 3) ──
sent(2, RconPacketType.COMMAND, 'list');
sent(3, RconPacketType.COMMAND, '');
received(
  encodeRconPacket(2, RconPacketType.RESPONSE, LIST_RESPONSE),
  encodeRconPacket(3, RconPacketType.RESPONSE, ''),
);

// ── send('minecraft:help') — long response, fragmented across packets
//    *and* across `data` events (request id 4, dummy id 5) ──
// Splitting the first fragment's bytes across two `data` chunks, and
// delivering the second fragment's packet in the same chunk as the tail of
// the first, exercises both halves of `handleData`'s reassembly buffer:
// completing a partial packet, and draining multiple complete packets that
// arrived back-to-back in one read.
sent(4, RconPacketType.COMMAND, 'minecraft:help');
sent(5, RconPacketType.COMMAND, '');
const helpPacket1 = encodeRconPacket(4, RconPacketType.RESPONSE, HELP_FRAGMENT_1);
const helpPacket2 = encodeRconPacket(4, RconPacketType.RESPONSE, HELP_FRAGMENT_2);
// however many pieces this comes back as, deliver the first on its own and
// fold the rest in with the next packet — generic regardless of chunk count
const [helpPacket1Head, ...helpPacket1Rest] = splitIntoChunks(helpPacket1, 2000);
received(
  helpPacket1Head,
  concatPackets(...helpPacket1Rest, helpPacket2),
  encodeRconPacket(5, RconPacketType.RESPONSE, ''),
);

// ── send(<unknown command>) — server's error-response shape (request id 6, dummy id 7) ──
sent(6, RconPacketType.COMMAND, 'this-command-does-not-exist-zzz12345');
sent(7, RconPacketType.COMMAND, '');
received(
  encodeRconPacket(6, RconPacketType.RESPONSE, UNKNOWN_COMMAND_RESPONSE),
  encodeRconPacket(7, RconPacketType.RESPONSE, ''),
);

export const password = PASSWORD;

export const fixture: RconFixture = {
  description: 'Hand-built happy-path conversation: auth, a short response, a fragmented response, and an unknown-command response.',
  frames,
  expectedResponses: [LIST_RESPONSE, HELP_RESPONSE, UNKNOWN_COMMAND_RESPONSE],
};
