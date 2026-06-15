// src/rconClient.ts
import type { ConsolaInstance } from 'consola';
import { RconProtocol } from './rconProtocol';
import { errorMessage } from './logger';

export class RconController {
  private host: string;
  private port: number;
  private password: string;
  private client: RconProtocol | null = null;
  private logger: ConsolaInstance;

  // Serializes every `send` through this controller — completions/usage
  // fetches and actual command execution all funnel through here (see
  // RconCompletionsBackend, LocalCommandTree, RconSession.executeCommand).
  // Without this, e.g. hitting Enter on "/mvp list" while its argument-hint
  // "cmdusage mvp list" round trip is still in flight fires two concurrent
  // RCON exchanges over the same socket — which the server doesn't tolerate
  // and answers by closing the connection. Chaining onto this promise (and
  // swallowing its rejection so one failed command doesn't wedge the queue)
  // guarantees at most one command is ever outstanding at a time.
  private sendQueue: Promise<unknown> = Promise.resolve();

  private readonly createProtocol: (host: string, port: number, password: string, logger: ConsolaInstance) => RconProtocol;

  constructor(
    host: string,
    port: number,
    password: string,
    logger: ConsolaInstance,
    // Defaults to a real RconProtocol; tests substitute a fake here so the
    // queue-serialization/error-handling logic can be exercised without a
    // live server (mirrors RconProtocol's own `createSocket` seam).
    createProtocol: (host: string, port: number, password: string, logger: ConsolaInstance) => RconProtocol
      = (h, p, pw, l) => new RconProtocol(h, p, pw, l),
  ) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.logger = logger;
    this.createProtocol = createProtocol;
  }

  public async connect(): Promise<void> {
    this.client = this.createProtocol(this.host, this.port, this.password, this.logger);

    // Set up error handler
    this.client.on('error', (error: Error) => {
      this.logger.error(`RCON error: ${error.message}`);
    });

    // Set up close handler
    this.client.on('close', () => {
      this.logger.info('RCON connection closed');
      this.client = null;
    });

    await this.client.connect();
    this.logger.info('RCON session established.');
  }

  public send(cmd: string): Promise<string | undefined> {
    const result = this.sendQueue.then(() => this.sendNow(cmd));
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  private async sendNow(cmd: string): Promise<string | undefined> {
    if (!this.client) { throw new Error('Not connected'); }
    const sentAt = Date.now();
    this.logger.debug(`send: ${cmd}`);
    try {
      const res = await this.client.send(cmd);
      const elapsedMs = Date.now() - sentAt;

      if (typeof res !== 'string' && res !== undefined) {
        this.logger.warn(`Received non-string response: ${JSON.stringify(res)}`);
      }

      // JSON.stringify(undefined) is undefined, not a string — fall back to
      // '' so the debug line's result.length can't throw.
      const result = typeof res === 'string' ? res : JSON.stringify(res) ?? '';
      this.logger.debug(`recv (+${elapsedMs}ms): ${cmd} -> ${result.length} chars`);
      return result;
    } catch (err) {
      this.logger.error('Error sending command: ' + errorMessage(err));
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.client) { return; }
    try {
      await this.client.disconnect();
    } catch (e) {
      // ignore
    }
    this.client = null;
  }

  public isConnected(): boolean {
    return this.client !== null && this.client.isConnected();
  }
}