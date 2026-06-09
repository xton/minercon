// src/test/support/fakeSocket.ts
//
// The "replay" half of the record/replay harness. A `FakeSocket` is loaded
// with a `script` — the ordered sequence of byte chunks a real socket sent
// and received during a recorded conversation (see recordingSocket.ts) — and
// plays it back on cue: when `RconProtocol` writes the bytes the script says
// it wrote next, the fake emits the `data`/`close` events that followed in
// the recording.
//
// This only works because `RconProtocol` is deterministic in how it talks:
// given the same sequence of `connect()`/`send(cmd)` calls, it generates the
// same request IDs and byte-identical packets every time (see
// fixtures/rconScript.ts for why that determinism is load-bearing here). So
// byte-for-byte playback — no rewriting of IDs or re-framing — is enough to
// reproduce a real server's side of the conversation.
//
// Cross-checking what gets written against the script (rather than just
// blindly feeding back responses) is what turns this into a regression guard
// on `createPacket`/the auth handshake/size-based fragmentation termination:
// if the protocol's wire format ever drifts from what was recorded,
// `assertSatisfied()` fails with a clear diff instead of the test either
// hanging (waiting on a response that never comes) or silently passing
// against a conversation that no longer matches reality.

import { EventEmitter } from 'events';
import { SocketLike } from '../../rconProtocol';

export type RconFrame =
  | { direction: 'sent'; data: Buffer }
  | { direction: 'received'; data: Buffer }
  | { direction: 'close' };

/** A recorded (or hand-authored) conversation, plus what `RconProtocol.send` should resolve to for each step of the script that drives it (see fixtures/rconScript.ts). */
export interface RconFixture {
  description: string;
  frames: RconFrame[];
  expectedResponses: string[];
}

/** JSON/source-friendly form of `RconFrame` — what `recordRconFixtures.ts` emits and checked-in fixture modules import-and-decode (see e.g. fixtures/rcon/synthetic.ts for the hand-built shape these mirror). */
export interface EncodedFrame {
  direction: 'sent' | 'received' | 'close';
  data?: string; // base64 — present for 'sent'/'received', absent for 'close'
}

export function encodeFrames(frames: readonly RconFrame[]): EncodedFrame[] {
  return frames.map(frame => frame.direction === 'close'
    ? { direction: 'close' }
    : { direction: frame.direction, data: frame.data.toString('base64') });
}

export function decodeFrames(encoded: readonly EncodedFrame[]): RconFrame[] {
  return encoded.map(frame => frame.direction === 'close'
    ? { direction: 'close' }
    : { direction: frame.direction, data: Buffer.from(frame.data ?? '', 'base64') });
}

export class FakeSocket extends EventEmitter implements SocketLike {
  private cursor = 0;
  private pumping = false;
  private readonly mismatches: string[] = [];

  constructor(private readonly script: readonly RconFrame[]) {
    super();
  }

  connect(_port: number, _host: string): void {
    setImmediate(() => {
      this.emit('connect');
      this.pump();
    });
  }

  setKeepAlive(_enable?: boolean, _initialDelay?: number): void {
    // no-op — nothing in the script depends on TCP keepalive
  }

  write(data: Buffer): void {
    const expected = this.script[this.cursor];
    if (!expected || expected.direction !== 'sent' || !expected.data.equals(data)) {
      this.mismatches.push(
        `frame ${this.cursor}: RconProtocol wrote ${data.toString('hex')}, ` +
        `but the recorded conversation expected ${this.describe(expected)}`
      );
      // Keep going rather than wedging the playback on the first mismatch —
      // assertSatisfied() is what surfaces this as a test failure.
    }
    this.cursor++;
    this.pump();
  }

  destroy(): void {
    this.emit('close');
  }

  /** Throws with a readable diff if the conversation diverged or wasn't fully played out — call from a test's teardown to confirm the recording was actually exercised end-to-end. */
  assertSatisfied(): void {
    if (this.mismatches.length > 0) {
      throw new Error(`FakeSocket: recorded conversation diverged from what RconProtocol did:\n${this.mismatches.join('\n')}`);
    }
    const remaining = this.script.slice(this.cursor).filter(frame => frame.direction !== 'close');
    if (remaining.length > 0) {
      throw new Error(`FakeSocket: ${remaining.length} scripted frame(s) were never reached (RconProtocol stopped talking early)`);
    }
  }

  private describe(frame: RconFrame | undefined): string {
    if (!frame) { return 'end of recorded conversation'; }
    if (frame.direction === 'close') { return 'connection close'; }
    return `${frame.direction} ${frame.data.toString('hex')}`;
  }

  /**
   * Emits whatever `received`/`close` frames come next in the script,
   * stopping at the next `sent` frame (which waits for a matching `write`).
   * Each emission is deferred via `setImmediate` — both to mirror the
   * async, one-chunk-per-tick nature of real socket I/O (which is exactly
   * what `RconProtocol.handleData`'s reassembly buffer needs to be exercised
   * against) and to keep long fragmented-response fixtures from recursing
   * synchronously through `handleData` → `pump` → `handleData` ...
   */
  private pump(): void {
    if (this.pumping) { return; }
    this.pumping = true;

    const step = (): void => {
      if (this.cursor >= this.script.length) { this.pumping = false; return; }

      const frame = this.script[this.cursor];
      if (frame.direction === 'sent') { this.pumping = false; return; }

      this.cursor++;
      if (frame.direction === 'received') {
        this.emit('data', frame.data);
        setImmediate(step);
      } else {
        this.emit('close');
        this.pumping = false;
      }
    };

    setImmediate(step);
  }
}
