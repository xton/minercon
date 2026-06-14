# Technical Documentation: RCON Protocol Implementation

## Problem Statement

The Minecraft RCON protocol splits large responses into 4096-byte packets. The previous `rcon-client` library couldn't properly reassemble these fragments, causing commands like `/help` to be truncated. This document explains how our custom implementation (`src/rconProtocol.ts`, wrapped by `src/rconClient.ts`) solves this problem.

## Solution: Deferred Fence Packet

### The Challenge
When receiving fragmented responses, there's no built-in way to know when all fragments have arrived. The protocol doesn't include a "last packet" flag or total size header.

### Our Approach
We use the classic "double-packet"/dummy-packet technique, with one twist: the dummy ("fence") packet is sent only after the *first* fragment of the real response has arrived, not immediately after the command.

```
1. Send actual command (ID: 1) → "help"
2. Wait for the first response fragment with ID: 1
3. Only now: send an empty dummy command (ID: 2)
4. Receive remaining fragments with ID: 1 → accumulate
5. Receive response with ID: 2 → ID: 1 is complete
6. Return accumulated response for ID: 1
```

This is implemented as a `sendFence` callback stored on the pending request and invoked the first time `handlePacket` sees a `RESPONSE_VALUE` fragment for that request.

### Why This Works — and Why the Timing Matters
The RCON server processes commands sequentially, so once we receive the response to our dummy packet, all fragments of the previous command have already been sent. That part of the classic technique is unchanged.

The deferral exists because of a real-server bug: some servers' RCON connection handlers (confirmed against Paper/Spigot's `RconClient.run()`) read from the socket and compare the bytes read against the *first* packet's declared size. If our "command" and "fence" writes are batched by TCP into a single `read()` (which `net.Socket.write()` calls are free to do when issued back-to-back), the byte count won't match the first packet's size field and the server closes the connection with "Thread RCON Client ... shutting down" — before it even looks at the fence's packet type.

By waiting for the first response fragment before writing the fence, a TCP round trip has already happened, so the fence packet arrives in its own `read()`. This is why the fence is **type 2 (`SERVERDATA_EXECCOMMAND`)**, not type 0 — all known client implementations use an empty `EXECCOMMAND` as the fence, and the type itself isn't what was causing disconnects; the batching was.

## Packet Structure

Each RCON packet follows this structure:

```
+--------+--------+--------+--------+---------+
| Size   | ID     | Type   | Body   | Padding |
| 4 bytes| 4 bytes| 4 bytes| n bytes| 2 bytes |
+--------+--------+--------+--------+---------+
```

- **Size**: Packet size (little-endian int32) - excludes the size field itself
- **ID**: Request ID for matching responses (little-endian int32)
- **Type**: Packet type (see below)
- **Body**: UTF-8 encoded string
- **Padding**: Two null bytes (0x00 0x00)

### Packet Types

| Type | Name | Direction | Purpose |
|------|------|-----------|---------|
| 3 | SERVERDATA_AUTH | Client→Server | Authentication request |
| 2 | SERVERDATA_AUTH_RESPONSE | Server→Client | Auth response |
| 2 | SERVERDATA_EXECCOMMAND | Client→Server | Execute command (and our fence) |
| 0 | SERVERDATA_RESPONSE_VALUE | Server→Client | Command response |

Note that `AUTH_RESPONSE` and `EXECCOMMAND` share the value `2` — this is part of the upstream protocol, not a bug. `handlePacket` disambiguates using the pending request's `command` field (`'auth'` vs. anything else).

## Implementation Details

### Key Components

#### 1. Socket Management
`RconProtocol` depends only on `SocketLike`, the narrow slice of `net.Socket` it actually uses (`connect`, `setKeepAlive`, `write`, `destroy`, plus the `EventEmitter` event surface). Production code defaults to a real `net.Socket`; tests inject a `FakeSocket` (see "Testing" below).

```typescript
export class RconProtocol extends EventEmitter {
  private socket: SocketLike | null = null;
  private authenticated: boolean = false;
  private readonly createSocket: () => SocketLike;
}
```

#### 2. Request Tracking
```typescript
private pendingRequests: Map<number, {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  command: string;
  fragments: string[];
  timeout?: NodeJS.Timeout;
  sendFence?: () => void;
}> = new Map();
```

#### 3. Fragment Accumulation and Fence Dispatch
```typescript
private handlePacket(packet: RconPacket): void {
  const request = this.pendingRequests.get(packet.id);
  if (!request) { /* ... */ }

  if (packet.type === PacketType.RESPONSE) {
    if (request.sendFence) {
      request.sendFence();
      request.sendFence = undefined;
    }
    request.fragments.push(packet.body);
    if (request.command === 'dummy') {
      request.resolve('');
    }
  }
}
```

### Connection Flow

1. **Connect**: Establish TCP socket connection, enable `SO_KEEPALIVE` (60s interval) to survive idle NAT/firewall drops
2. **Authenticate**: Send an `AUTH` packet with the password
3. **Verify**: The `AUTH_RESPONSE` packet (ID = -1 means failure) resolves or rejects the connect promise
4. **Ready**: Can now send commands

### Command Execution Flow

1. **Generate IDs**: Allocate a request ID and a dummy/fence ID
2. **Send Command**: Encode and write the command packet
3. **Accumulate**: Collect `RESPONSE_VALUE` fragments for the request ID
4. **Send Fence (deferred)**: On the *first* fragment, write the empty fence packet
5. **Detect Complete**: The fence's own response signals that all real fragments arrived
6. **Return Result**: Concatenate and return the accumulated fragments
7. **Cleanup**: If the connection closes mid-response with fragments already accumulated, resolve with what was received rather than rejecting

## Error Handling

### Timeout Management
- Authentication timeout: 5 seconds
- Command response timeout: 10 seconds (`RESPONSE_TIMEOUT` in `rconProtocol.ts`), covering both the command and its fence round trip

### Error Recovery
- Socket `error`/`close` events reject or resolve all pending requests (resolving with any partial fragments already received)
- `RconController` (`rconClient.ts`) wraps `RconProtocol` and serializes all `send()` calls through a `sendQueue`, so a failed or slow command can't wedge later ones
- `ConnectionManager` (`connectionManager.ts`) owns reconnection: exponential backoff (1s → 32s, capped at 5 attempts) when the connection is lost

### Edge Cases Handled
- Server closes connection mid-response (partial fragments returned)
- Malformed/undersized packets (`parsePacket` throws, logged and skipped)
- Authentication with an empty password
- Very large responses split across many fragments

## Performance Considerations

### Memory Management
- Fragments accumulated in an array per pending request, cleared once resolved
- Maximum response size limited only by available memory

### Network
- `SO_KEEPALIVE` enabled (60s) for connection stability through idle periods
- No `setNoDelay`/Nagle-disabling — not needed since commands are sent one at a time

### Concurrency
- `RconProtocol` itself can track multiple pending requests by ID
- In practice, `RconController.sendQueue` **deliberately serializes** every `send()` — at most one command (plus its fence) is ever in flight. This is load-bearing: concurrent exchanges over the same socket cause some servers to close the connection (see `sendQueue`'s comment in `rconClient.ts`)

## Testing

### Record/Replay Harness (`rconProtocol.test.ts`)
`RconProtocol`'s wire-level behavior — auth handshake, packet framing, fragmentation reassembly, deferred-fence completion detection, error responses — is tested byte-exact via a record/replay harness:

- `support/recordingSocket.ts` wraps a real socket to capture a live conversation as a `RconFixture` (run via `npm run record-rcon-fixtures`)
- `support/fakeSocket.ts` (`FakeSocket`) replays a fixture's frames against `RconProtocol` with no real network
- Fixtures live in `src/test/fixtures/rcon/` (e.g. `synthetic.ts` for hand-built edge cases, `xton.ts` for a recorded real-server conversation)

### `RconController` Tests (`rconClient.test.ts`)
`RconController`'s own logic — `sendQueue` serialization, error containment (a rejected send doesn't wedge the queue), `Not connected` guards, and event wiring — is tested against a lightweight `FakeProtocol` injected via the same `createProtocol` seam pattern as `RconProtocol`'s `createSocket`.

### Manual Testing
```bash
# Fragmentation
/help                    # Should show 300+ commands, fully reassembled

# Special characters
/say Hello §aWorld§r!    # Color codes preserved
```

## Debugging

Run the CLI with `--log-level debug` (or set `MCRCON_LOG_LEVEL=debug`) to get per-command `send`/`recv` logging from `RconController.sendNow`, including elapsed time and response size:

```
[DEBUG] send: help
[DEBUG] recv (+42ms): help -> 8213 chars
```

### Common Issues

| Symptom | Likely Cause | Solution |
|---------|-------------|----------|
| Timeout on large commands | Slow server, or response never triggers the fence | Increase `RESPONSE_TIMEOUT`, check `--log-level debug` |
| Auth fails | Wrong password | Check `server.properties` |
| Connection drops right after a command | Fence sent before first fragment (regression) | Confirm `sendFence` deferral logic in `handlePacket` |
| Connection drops | Network issue / firewall | Check keepalive, firewall rules |

## Protocol Quirks

### Minecraft-Specific Behaviors
- Color codes use the `§` character — see `src/ansi.ts` for stripping/translation to ANSI
- Some servers limit RCON command access
- Help output format varies by server type (vanilla / Spigot / Paper / Fabric)
- Maximum packet payload is 4096 bytes

### Server Variations
- **Vanilla**: standard help format
- **Spigot/Paper**: includes plugin commands; accepts the `minecraft:` namespace prefix
- **Fabric**: modded commands included; rejects the `minecraft:` namespace prefix
- **Custom**: unpredictable formats — see `docs/technical/NO_PLUGIN_HELP_CRAWL.md` for how `localCommandTree.ts` copes

## Comparison with Alternatives

### `rcon-client` Library
- ❌ Truncates at 4096 bytes
- ❌ No fragmentation support

### Our Implementation
- ✅ Full fragmentation reassembly via deferred fence
- ✅ Survives the `RconClient.run()` batching bug present in some servers
- ✅ Partial-result delivery on mid-response disconnect

### Other Approaches Considered
1. **Timeout-based**: wait *N* seconds for more packets — ❌ slow and unreliable
2. **Size heuristic**: assume exactly-4096-byte responses are incomplete — ❌ false positives on responses that happen to be exactly 4096 bytes
3. **Immediate double-packet** (fence sent right after the command, no deferral) — ❌ causes some servers to disconnect (see "Why This Works" above)
4. **Deferred double-packet** (chosen) — ✅ reliable across vanilla, Spigot, and Paper

## Future Improvements

### Potential Enhancements
1. Response caching at the protocol level
2. Compression for very large responses

### Known Limitations
- No encryption (RCON protocol limitation — plaintext password and traffic)
- No built-in rate limiting
- Commands are processed one at a time per connection (by design — see "Concurrency" above)

## References

- [Source RCON Protocol](https://developer.valvesoftware.com/wiki/Source_RCON_Protocol)
- [Minecraft Wiki: RCON](https://minecraft.wiki/w/RCON)

## Code Location

- `src/rconProtocol.ts` — wire protocol: framing, auth, fragmentation, deferred fence
  - `connect()` / `disconnect()` / `isConnected()`
  - `send()` — the public command API
  - `handleData()` — buffers incoming bytes and slices out complete packets
  - `handlePacket()` — dispatches a parsed packet to its pending request, fires the deferred fence
  - `createPacket()` / `parsePacket()` — packet encode/decode
- `src/rconClient.ts` (`RconController`) — adds the serialized `sendQueue` and debug logging on top of `RconProtocol`
