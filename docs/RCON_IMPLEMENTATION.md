# Technical Documentation: RCON Protocol Implementation

## Problem Statement

The Minecraft RCON protocol splits large responses into 4096-byte packets. The previous `rcon-client` library couldn't properly reassemble these fragments, causing commands like `/help` to be truncated. This document explains how our custom implementation (`src/rconProtocol.ts`, wrapped by `src/rconClient.ts`) solves this problem.

## Solution: Deferred Fence Packet

### The Challenge
When receiving fragmented responses, there's no built-in way to know when all fragments have arrived. The protocol doesn't include a "last packet" flag or total size header.

### Our Approach
We use the classic "double-packet"/dummy-packet technique: send a dummy packet with a known ID after our main request. Requests are guaranteed to be processed in order, so we know that when we receive the dummy packet's response then we've received all of our main request's response.

Minercon's implementation diverges from jaketcooper's with one twist: the dummy ("fence") packet is sent only after the *first* fragment of the real response has arrived, not immediately after the command.

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

This was discovered while building a functional test using local containers where latency is very, very low.

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

## Debugging

Run the CLI with `--log-level debug` (or set `MCRCON_LOG_LEVEL=debug`) to get per-command `send`/`recv` logging from `RconController.sendNow`, including elapsed time and response size:

```
[DEBUG] send: help
[DEBUG] recv (+42ms): help -> 8213 chars
```

## Server Variations of `/help`
- **Vanilla**: standard help format
- **Spigot/Paper**: includes plugin commands; accepts the `minecraft:` namespace prefix
- **Fabric**: modded commands included; rejects the `minecraft:` namespace prefix
- **Custom**: unpredictable formats — see `docs/NO_PLUGIN_HELP_CRAWL.md` for how `commandTreeCrawler.ts` copes

## References

- [Source RCON Protocol](https://developer.valvesoftware.com/wiki/Source_RCON_Protocol)
- [Minecraft Wiki: RCON](https://minecraft.wiki/w/RCON)
