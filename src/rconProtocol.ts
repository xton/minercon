// src/rconProtocol.ts
import * as net from 'net';
import { EventEmitter } from 'events';
import { Logger } from './logger';

// RCON packet types
enum PacketType {
  AUTH = 3,
  AUTH_RESPONSE = 2,
  COMMAND = 2,
  RESPONSE = 0
}

// RCON packet structure
interface RconPacket {
  size: number;
  id: number;
  type: number;
  body: string;
}

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

export class RconProtocol extends EventEmitter {
  private socket: SocketLike | null = null;
  private host: string;
  private port: number;
  private password: string;
  private logger: Logger;
  private readonly createSocket: () => SocketLike;

  private authenticated: boolean = false;
  private requestId: number = 0;
  private responseBuffer: Buffer = Buffer.alloc(0);
  
  // For tracking requests and responses
  private pendingRequests: Map<number, {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    command: string;
    fragments: string[];
    timeout?: NodeJS.Timeout;
    sendFence?: () => void;
  }> = new Map();
  
  // Configuration
  private readonly RESPONSE_TIMEOUT = 10000; // 10 seconds for command responses
  
  constructor(
    host: string,
    port: number,
    password: string,
    logger: Logger,
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
        const error = new Error('Connection timeout');
        this.logger.warning('Socket timeout');
        this.emit('error', error);
        this.disconnect();
      });
      
      // Handle close
      this.socket.on('close', () => {
        this.logger.info('Connection closed');
        this.authenticated = false;
        this.emit('close');

        for (const [, request] of this.pendingRequests) {
          if (request.timeout) {
            clearTimeout(request.timeout);
          }
          // Deliver any accumulated fragments if the server closed mid-response
          // (e.g. the final fragment was exactly MAX_PACKET_SIZE bytes and we
          // were still waiting for more).
          if (request.fragments.length > 0) {
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
      }, 5000);
      
      this.pendingRequests.set(authId, {
        resolve: (_response: string) => {
          clearTimeout(authTimeout);
          this.authenticated = true;
          this.logger.info('Authentication successful');
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(authTimeout);
          reject(error);
        },
        command: 'auth',
        fragments: [],
        timeout: authTimeout
      });
      
      // Send auth packet
      const packet = this.createPacket(authId, PacketType.AUTH, this.password);
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
        command: command,
        fragments: [],
        timeout: timeout,
        // Sent on the first response fragment — ensures the server has started
        // replying before we ask it to process the fence packet.
        sendFence: () => {
          if (this.socket) {
            const dummyPacket = this.createPacket(dummyId, PacketType.COMMAND, '');
            this.socket.write(dummyPacket);
          }
        },
      });

      this.pendingRequests.set(dummyId, {
        resolve: () => {
          const mainRequest = this.pendingRequests.get(requestId);
          if (mainRequest) {
            mainRequest.resolve(mainRequest.fragments.join(''));
          }
        },
        reject: () => {},
        command: 'dummy',
        fragments: [],
      });

      const commandPacket = this.createPacket(requestId, PacketType.COMMAND, command);
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

  /**
   * Handle a parsed packet
   */
  private handlePacket(packet: RconPacket): void {
    // Special handling for auth responses
    if (packet.id === -1) {
      // Authentication failed
      for (const [id, request] of this.pendingRequests) {
        if (request.command === 'auth') {
          request.reject(new Error('Authentication failed'));
          this.pendingRequests.delete(id);
          break;
        }
      }
      return;
    }
    
    // Find the corresponding request
    const request = this.pendingRequests.get(packet.id);
    if (!request) {
      // Might be an auth response packet (they send two packets)
      // Check if this is following an auth request
      for (const [id, req] of this.pendingRequests) {
        if (req.command === 'auth' && packet.type === PacketType.AUTH_RESPONSE) {
          // This is the auth response
          req.resolve('');
          this.pendingRequests.delete(id);
          return;
        }
      }
      
      this.logger.warning(`Received packet with unknown request ID: ${packet.id}`);
      return;
    }
    
    // Handle based on packet type
    if (packet.type === PacketType.RESPONSE) {
      if (request.command === 'auth') {
        // First of the two auth-acknowledgement packets — ignore it; the
        // AUTH_RESPONSE packet that follows is what we actually resolve on.
        return;
      }
      if (request.sendFence) {
        request.sendFence();
        request.sendFence = undefined;
      }
      request.fragments.push(packet.body);
      if (request.command === 'dummy') {
        request.resolve('');
      }
    } else if (packet.type === PacketType.AUTH_RESPONSE) {
      // Auth response — resolve and clean up so the auth entry doesn't linger
      // in pendingRequests where the close handler could re-fire it.
      if (request.command === 'auth') {
        this.pendingRequests.delete(packet.id);
        request.resolve('');
      }
    }
  }

  /**
   * Create an RCON packet
   */
  private createPacket(id: number, type: PacketType, body: string): Buffer {
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
      for (const [id, request] of this.pendingRequests) {
        if (request.timeout) {
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
   * Check if connected
   */
  public isConnected(): boolean {
    return this.socket !== null && this.authenticated;
  }
}