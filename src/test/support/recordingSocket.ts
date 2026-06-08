// src/test/support/recordingSocket.ts
//
// The "record" half of the record/replay harness. A `RecordingSocket` is a
// transparent tee around a real `net.Socket`: every byte `RconProtocol`
// writes, and every `data`/`close` event the real server produces, passes
// through unchanged but is also appended to `frames` in order — exactly the
// `RconFrame[]` shape `FakeSocket` (fakeSocket.ts) plays back later.
//
// Driving `RconProtocol` against this (via the same canonical script —
// fixtures/rconScript.ts — that the replay tests use) against a real server
// is how fixtures get (re)generated. See recordRconFixtures.ts for the CLI
// that wires this up and serializes the result to a checked-in fixture file.

import * as net from 'net';
import { EventEmitter } from 'events';
import { SocketLike } from '../../rconProtocol';
import { RconFrame } from './fakeSocket';

export class RecordingSocket extends EventEmitter implements SocketLike {
  readonly frames: RconFrame[] = [];
  private readonly inner: net.Socket = new net.Socket();

  constructor() {
    super();

    this.inner.on('data', (data: Buffer) => {
      this.frames.push({ direction: 'received', data: Buffer.from(data) });
      this.emit('data', data);
    });
    this.inner.on('close', () => {
      this.frames.push({ direction: 'close' });
      this.emit('close');
    });
    // Forwarded so RconProtocol's own listeners still fire — not recorded,
    // since they carry no wire bytes and FakeSocket doesn't need to replay them.
    this.inner.on('connect', () => this.emit('connect'));
    this.inner.on('error', (error: Error) => this.emit('error', error));
    this.inner.on('timeout', () => this.emit('timeout'));
  }

  connect(port: number, host: string): void {
    this.inner.connect(port, host);
  }

  setKeepAlive(enable?: boolean, initialDelay?: number): void {
    this.inner.setKeepAlive(enable, initialDelay);
  }

  write(data: Buffer): void {
    this.frames.push({ direction: 'sent', data: Buffer.from(data) });
    this.inner.write(data);
  }

  destroy(): void {
    this.inner.destroy();
  }
}
