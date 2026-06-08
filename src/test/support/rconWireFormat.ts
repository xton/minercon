// src/test/support/rconWireFormat.ts
//
// Minimal RCON packet encode/decode — deliberately separate from (and a
// duplicate of) `RconProtocol`'s private `createPacket`/`parsePacket`. That
// duplication is the point: these are the primitives fixture authors use to
// hand-build byte-exact wire conversations, so they need to exist
// independently of the implementation under test (otherwise a bug in
// `createPacket` could "pass" by being baked into both the fixture and the
// code that builds it).

export enum RconPacketType {
  AUTH = 3,
  AUTH_RESPONSE = 2,
  COMMAND = 2,
  RESPONSE = 0,
}

/** Encodes a single RCON packet exactly as the wire protocol specifies: 4-byte LE size prefix, id, type, body, two null terminators. */
export function encodeRconPacket(id: number, type: RconPacketType, body: string): Buffer {
  const bodyLength = Buffer.byteLength(body, 'utf8');
  const size = 4 + 4 + bodyLength + 2;
  const buffer = Buffer.alloc(4 + size);

  buffer.writeInt32LE(size, 0);
  buffer.writeInt32LE(id, 4);
  buffer.writeInt32LE(type, 8);
  buffer.write(body, 12, bodyLength, 'utf8');
  // null terminators are already zero from Buffer.alloc

  return buffer;
}

/** Concatenates several encoded packets into one chunk — for fixtures that model a server coalescing multiple packets into a single `data` event. */
export function concatPackets(...packets: Buffer[]): Buffer {
  return Buffer.concat(packets);
}

/** Splits a buffer into fixed-size pieces — for fixtures that model the server (or the network) splitting one packet across several `data` events, exercising `RconProtocol.handleData`'s reassembly buffer. */
export function splitIntoChunks(data: Buffer, chunkSize: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
  }
  return chunks;
}
