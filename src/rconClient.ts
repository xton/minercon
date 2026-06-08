// src/rconClient.ts
import { RconProtocol } from './rconProtocol';
import { Logger } from './logger';

export class RconController {
  private host: string;
  private port: number;
  private password: string;
  private client: RconProtocol | null = null;
  private logger: Logger;

  constructor(host: string, port: number, password: string, logger: Logger) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.logger = logger;
  }

  public async connect(): Promise<void> {
    this.client = new RconProtocol(this.host, this.port, this.password, this.logger);

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

  public async send(cmd: string): Promise<string | undefined> {
    if (!this.client) { throw new Error('Not connected'); }
    try {
      const res = await this.client.send(cmd);

      if (typeof res !== 'string' && res !== undefined) {
        this.logger.warning(`Received non-string response: ${JSON.stringify(res)}`);
      }

      return typeof res === 'string' ? res : JSON.stringify(res);
    } catch (err: any) {
      this.logger.error('Error sending command: ' + String(err.message ?? err));
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