// src/rconProtocol.ts
import * as net from 'net';
import { EventEmitter } from 'events';
import type { ConsolaInstance } from 'consola';

// RCON packet type tags. The wire protocol reuses the value 2 for two
// different things depending on direction (SERVERDATA_EXECCOMMAND when we send,
// SERVERDATA_AUTH_RESPONSE when the server replies), so they live in separate
// enums: nothing in this file ever compares an outgoing tag to an incoming one,
// which keeps that shared value from being mistaken for a single meaning.
enum OutgoingType {
  AUTH = 3,        // SERVERDATA_AUTH
  COMMAND = 2,     // SERVERDATA_EXECCOMMAND
}

enum IncomingType {
  RESPONSE = 0,        // SERVERDATA_RESPONSE_VALUE
  AUTH_RESPONSE = 2,   // SERVERDATA_AUTH_RESPONSE
}

// RCON packet structure
interface RconPacket {
  size: number;
  id: number;
  type: number;
  body: string;
}

/**
 * One outstanding request awaiting its reply, keyed in `pendingRequests` by
 * the request id we sent. The three kinds have genuinely different lifecycles,
 * so they're a discriminated union rather than one bag with optional fields:
 *
 * - `auth`: the login handshake; resolves/rejects the `connect()` promise.
 * - `command`: a real command. Accumulates response `fragments`, and on its
 *   first fragment fires `sendFence` to send the empty "fence" command whose
 *   reply marks the end of this command's (possibly multi-packet) response.
 * - `fence`: that trailing empty command. Its reply means every fragment of
 *   the command it follows has arrived, so its `resolve` settles that command.
 */
type PendingRequest =
  | { kind: 'auth'; resolve: () => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  | {
      kind: 'command';
      command: string;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
      fragments: string[];
      sendFence?: () => void;
    }
  | { kind: 'fence'; resolve: () => void; reject: (error: Error) => void };

/**
 * The slice of `net.Socket` that `RconProtocol` actually drives — narrow
 * enough that tests can hand it a fake (see src/test/support/fakeSocket.ts)
 * instead of opening a real TCP connection. `net.Socket` satisfies this
 * structurally, so production code needs no changes.
 */
export interface SocketLike extends EventEmitter {
  connect(port: number, host: string): void;
  setKeepAlive(enable?: boolean, initialDelay?: number): void;
  write(data: Buffer): void;
  destroy(): void;
}

/** The events `RconProtocol` emits, with their listener signatures. */
export interface RconProtocolEvents {
  error: (error: Error) => void;
  close: () => void;
}

// Declaration-merged onto the class below so `on`/`once`/`off`/`emit` are
// typed against `RconProtocolEvents` — known events get checked listener
// signatures and argument types, instead of EventEmitter's `(...args: any[])`.
export interface RconProtocol {
  on<E extends keyof RconProtocolEvents>(event: E, listener: RconProtocolEvents[E]): this;
  once<E extends keyof RconProtocolEvents>(event: E, listener: RconProtocolEvents[E]): this;
  off<E extends keyof RconProtocolEvents>(event: E, listener: RconProtocolEvents[E]): this;
  emit<E extends keyof RconProtocolEvents>(event: E, ...args: Parameters<RconProtocolEvents[E]>): boolean;
}

export class RconProtocol extends EventEmitter {
  private socket: SocketLike | null = null;
  private host: string;
  private port: number;
  private password: string;
  private logger: ConsolaInstance;
  private readonly createSocket: () => SocketLike;

  private authenticated: boolean = false;
  private requestId: number = 0;
  private responseBuffer: Buffer = Buffer.alloc(0);
  
  // For tracking requests and responses
  private pendingRequests: Map<number, PendingRequest> = new Map();
  
  // Configuration
  private readonly RESPONSE_TIMEOUT = 10000; // 10 seconds for command responses
  private readonly AUTH_TIMEOUT = 5000;      // 5 seconds for the login handshake
  
  constructor(
    host: string,
    port: number,
    password: string,
    logger: ConsolaInstance,
    // Defaults to a real socket; tests substitute a `SocketLike` fake here
    // (record/replay harness — see src/test/rconProtocol.test.ts) so the
    // wire protocol can be exercised without a live server.
    createSocket: () => SocketLike = () => new net.Socket(),
  ) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
    this.logger = logger;
    this.createSocket = createSocket;
  }

  /**
   * Connect to the RCON server
   */
  public async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = this.createSocket();

      // Enable TCP keepalive to prevent idle connection drops
      // This sends periodic probes to keep the connection alive through NAT/firewalls
      this.socket.setKeepAlive(true, 60000); // Send keepalive probes every 60 seconds
      
      // Don't set a socket timeout - let the connection stay open indefinitely
      // The keepalive will handle detecting dead connections
      
      // Handle connection
      this.socket.once('connect', async () => {
        this.logger.info(`Connected to ${this.host}:${this.port}`);
        
        try {
          await this.authenticate();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      
      // Handle data
      this.socket.on('data', (data: Buffer) => {
        this.handleData(data);
      });
      
      // Handle errors
      this.socket.on('error', (error: Error) => {
        this.logger.error(`Socket error: ${error.message}`);
        this.emit('error', error);
        reject(error);
      });
      
      // Handle timeout (shouldn't happen now that we removed setTimeout)
      this.socket.on('timeout', () => {
        this.logger.warn('Socket timeout — calling disconnect()');
        const error = new Error('Connection timeout');
        this.emit('error', error);
        this.disconnect();
      });
      
      // Handle close
      this.socket.on('close', () => {
        const pending = [...this.pendingRequests.values()]
          .map(r => r.kind === 'command' ? r.command : r.kind)
          .join(', ');
        this.logger.info(`Connection closed (pending: ${pending || 'none'})`);
        this.authenticated = false;
        this.emit('close');

        for (const [, request] of this.pendingRequests) {
          if (request.kind !== 'fence') {
            clearTimeout(request.timeout);
          }
          // Deliver any accumulated fragments if the server closed mid-response
          // (e.g. the final fragment was exactly one full packet and we were
          // still waiting for more).
          if (request.kind === 'command' && request.fragments.length > 0) {
            request.resolve(request.fragments.join(''));
          } else {
            request.reject(new Error('Connection closed'));
          }
        }
        this.pendingRequests.clear();
      });
      
      // Connect
      this.socket.connect(this.port, this.host);
    });
  }

  /**
   * Authenticate with the RCON server
   */
  private async authenticate(): Promise<void> {
    if (!this.socket) {
      throw new Error('Not connected');
    }

    return new Promise((resolve, reject) => {
      const authId = this.getNextRequestId();
      
      // Set up auth response handler
      const authTimeout = setTimeout(() => {
        this.pendingRequests.delete(authId);
        reject(new Error('Authentication timeout'));
      }, this.AUTH_TIMEOUT);
      
      this.pendingRequests.set(authId, {
        kind: 'auth',
        resolve: () => {
          clearTimeout(authTimeout);
          this.authenticated = true;
          this.logger.info('Authentication successful');
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(authTimeout);
          reject(error);
        },
        timeout: authTimeout
      });

      // Send auth packet
      const packet = this.createPacket(authId, OutgoingType.AUTH, this.password);
      if (this.socket) {
        this.socket.write(packet);
      }
    });
  }

  /**
   * Send a command to the server
   */
  public async send(command: string): Promise<string> {
    if (!this.socket || !this.authenticated) {
      throw new Error('Not connected or authenticated');
    }

    // Use the double-packet technique for detecting end of fragmented
    // responses: send the real command, then — once the first response
    // fragment arrives — send an empty "fence" command. RCON processes
    // commands in order, so when the fence response arrives all real
    // fragments have already been received. Sending the fence only after
    // the first fragment (via sendFence below) ensures the server has
    // started replying before it sees the fence, which prevents servers
    // from treating two back-to-back packets with no intervening response
    // as a protocol error and closing the connection.
    return new Promise((resolve, reject) => {
      const requestId = this.getNextRequestId();
      const dummyId = this.getNextRequestId();

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.pendingRequests.delete(dummyId);
        reject(new Error(`Command timeout: ${command}`));
      }, this.RESPONSE_TIMEOUT);

      this.pendingRequests.set(requestId, {
        kind: 'command',
        command: command,
        resolve: (response: string) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          this.pendingRequests.delete(dummyId);
          resolve(response);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          this.pendingRequests.delete(requestId);
          this.pendingRequests.delete(dummyId);
          reject(error);
        },
        timeout: timeout,
        fragments: [],
        // Sent on the first response fragment — ensures the fence arrives in
        // its own TCP read() on the server, not batched with the command packet.
        // RconClient.run() closes the connection if read() returns more bytes
        // than the first packet's length field, so back-to-back writes that
        // arrive in one read() cause an immediate disconnect.
        sendFence: () => {
          if (this.socket) {
            const dummyPacket = this.createPacket(dummyId, OutgoingType.COMMAND, '');
            this.socket.write(dummyPacket);
          }
        },
      });

      this.pendingRequests.set(dummyId, {
        kind: 'fence',
        resolve: () => {
          const mainRequest = this.pendingRequests.get(requestId);
          if (mainRequest && mainRequest.kind === 'command') {
            mainRequest.resolve(mainRequest.fragments.join(''));
          }
        },
        reject: () => {},
      });

      const commandPacket = this.createPacket(requestId, OutgoingType.COMMAND, command);
      if (this.socket) {
        this.socket.write(commandPacket);
      }
    });
  }

  /**
   * Handle incoming data from the socket
   */
  private handleData(data: Buffer): void {
    // Append to buffer
    this.responseBuffer = Buffer.concat([this.responseBuffer, data]);
    
    // Process complete packets
    while (this.responseBuffer.length >= 4) {
      // Read packet size (first 4 bytes, little-endian)
      const size = this.responseBuffer.readInt32LE(0);
      
      // Check if we have the complete packet
      if (this.responseBuffer.length < size + 4) {
        // Wait for more data
        break;
      }
      
      // Extract the packet
      const packetBuffer = this.responseBuffer.subarray(0, size + 4);
      this.responseBuffer = this.responseBuffer.subarray(size + 4);
      
      // Parse the packet
      try {
        const packet = this.parsePacket(packetBuffer);
        this.handlePacket(packet);
      } catch (error) {
        this.logger.error(`Error parsing packet: ${error}`);
      }
    }
  }

  /** The single in-flight auth request, if any, with the id it's keyed under. */
  private findAuthRequest(): { id: number; request: Extract<PendingRequest, { kind: 'auth' }> } | undefined {
    for (const [id, request] of this.pendingRequests) {
      if (request.kind === 'auth') {
        return { id, request };
      }
    }
    return undefined;
  }

  /**
   * Handle a parsed packet
   */
  private handlePacket(packet: RconPacket): void {
    // Failed auth: the server replies with id -1 rather than echoing the id we
    // sent, so we can't look it up — find the pending auth request directly.
    if (packet.id === -1) {
      const auth = this.findAuthRequest();
      if (auth) {
        this.pendingRequests.delete(auth.id);
        auth.request.reject(new Error('Authentication failed'));
      }
      return;
    }

    const request = this.pendingRequests.get(packet.id);
    if (!request) {
      // Some servers don't echo our auth id on the AUTH_RESPONSE packet — if an
      // auth handshake is in flight, this unmatched response is it.
      if (packet.type === IncomingType.AUTH_RESPONSE) {
        const auth = this.findAuthRequest();
        if (auth) {
          this.pendingRequests.delete(auth.id);
          auth.request.resolve();
          return;
        }
      }
      this.logger.warn(`Received packet with unknown request ID: ${packet.id}`);
      return;
    }

    switch (request.kind) {
      case 'auth':
        // Auth gets two packets: an empty RESPONSE_VALUE we ignore, then the
        // AUTH_RESPONSE we resolve on. Delete on resolve so the entry doesn't
        // linger where the close handler could re-fire it.
        if (packet.type === IncomingType.AUTH_RESPONSE) {
          this.pendingRequests.delete(packet.id);
          request.resolve();
        }
        return;

      case 'command':
        if (packet.type !== IncomingType.RESPONSE) { return; }
        // First fragment in: send the fence so its reply can mark the end of
        // this (possibly multi-packet) response.
        if (request.sendFence) {
          request.sendFence();
          request.sendFence = undefined;
        }
        request.fragments.push(packet.body);
        return;

      case 'fence':
        // The fence's reply means every fragment of the command it follows has
        // arrived; its resolve settles that command (and clears both entries).
        if (packet.type !== IncomingType.RESPONSE) { return; }
        request.resolve();
        return;
    }
  }

  /**
   * Create an RCON packet
   */
  private createPacket(id: number, type: OutgoingType, body: string): Buffer {
    // Calculate size (4 bytes ID + 4 bytes type + body + 2 null terminators)
    const bodyLength = Buffer.byteLength(body, 'utf8');
    const size = 4 + 4 + bodyLength + 2;
    
    // Create buffer (size field + packet content)
    const buffer = Buffer.alloc(4 + size);
    
    // Write size (little-endian)
    buffer.writeInt32LE(size, 0);
    
    // Write ID (little-endian)
    buffer.writeInt32LE(id, 4);
    
    // Write type (little-endian)
    buffer.writeInt32LE(type, 8);
    
    // Write body
    buffer.write(body, 12, bodyLength, 'utf8');
    
    // Null terminators are already 0 from Buffer.alloc
    
    return buffer;
  }

  /**
   * Parse a packet from a buffer
   */
  private parsePacket(buffer: Buffer): RconPacket {
    if (buffer.length < 14) {
      throw new Error('Packet too small');
    }
    
    const size = buffer.readInt32LE(0);
    const id = buffer.readInt32LE(4);
    const type = buffer.readInt32LE(8);
    
    // Read body (from byte 12 to size + 2, excluding null terminators)
    const bodyEnd = Math.min(12 + size - 10, buffer.length - 2);
    const body = buffer.toString('utf8', 12, bodyEnd);
    
    return { size, id, type, body };
  }

  /**
   * Get the next request ID
   */
  private getNextRequestId(): number {
    return ++this.requestId;
  }

  /**
   * Disconnect from the server
   */
  public async disconnect(): Promise<void> {
    if (this.socket) {
      this.authenticated = false;

      // Clear pending requests
      for (const [, request] of this.pendingRequests) {
        if (request.kind !== 'fence') {
          clearTimeout(request.timeout);
        }
        request.reject(new Error('Disconnected'));
      }
      this.pendingRequests.clear();

      // Close socket
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * The lowest-level connection truth: an open socket that has authenticated.
   * `RconController.isConnected()` forwards to this; `RconConnectionManager`
   * keeps a separate intent-level flag that can briefly diverge during reconnects.
   */
  public isConnected(): boolean {
    return this.socket !== null && this.authenticated;
  }
}