// src/connectionManager.ts
//
// Owns the RCON connection lifecycle: the live `RconController` (recreated on
// each reconnect attempt), connection/reconnection status, and the
// exponential-backoff retry loop. Pulled out of RconTerminal as part of the
// mega-module split — see lineEditor.ts / suggestionDisplay.ts for the sibling
// extractions and their rationale.
//
// `RconSession` keeps `detectAndInitialize`/`initializeCommands` (they're
// about the autocomplete command-tree and `pluginMode`, a different concern
// that happens to run at similar times) but reads connection status and reaches
// the live controller through this class, and is notified via `onReconnected`
// when it should reload the command tree.

import { RconController } from './rconClient';
import { Logger, errorMessage } from './logger';
import * as ansi from './ansi';

export interface ConnectionManagerHost {
  write(text: string): void;
  showPrompt(): void;
  onReconnected(): void;
}

/** Builds the `RconController` used for a (re)connection attempt — overridable in tests so `attemptReconnect()` doesn't open a real socket. */
export type ControllerFactory = (host: string, port: number, password: string, logger: Logger) => RconController;

const defaultControllerFactory: ControllerFactory = (host, port, password, logger) =>
  new RconController(host, port, password, logger);

export class ConnectionManager {
  private _controller: RconController;
  private _isConnected: boolean = true;
  private _isReconnecting: boolean = false;
  private reconnectAttempts: number = 0;
  private readonly maxReconnectAttempts: number = 5;
  private reconnectDelay: number = 2000;
  private reconnectTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly serverHost: string,
    private readonly serverPort: number,
    private readonly password: string,
    private readonly logger: Logger,
    controller: RconController,
    private readonly host: ConnectionManagerHost,
    private readonly controllerFactory: ControllerFactory = defaultControllerFactory,
  ) {
    this._controller = controller;
  }

  get controller(): RconController {
    return this._controller;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get isReconnecting(): boolean {
    return this._isReconnecting;
  }

  /**
   * Records that an in-flight command discovered the connection is gone, and
   * schedules an auto-reconnect attempt shortly after. The "Connection
   * lost..." message itself stays with the caller (`executeCommand` accounts
   * for it in its output-line bookkeeping).
   */
  reportConnectionLost(): void {
    this._isConnected = false;
    this.reconnectAttempts = 0;
    this.reconnectDelay = 2000;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.attemptReconnect();
    }, 1000);
  }

  disconnect(): void {
    this.host.write('^D\r\n');
    this.host.write('Disconnecting...\r\n');

    // Clear any pending reconnect
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      this._controller.disconnect();
    } catch (err) {
      this.logger.error(`Error during disconnect: ${err}`);
    }

    this._isConnected = false;
    this._isReconnecting = false;
    this.host.write('Connection closed. Type ' + ansi.yellow('/reconnect') + ' to reconnect.\r\n\r\n');
    this.host.showPrompt();
  }

  async manualReconnect(): Promise<void> {
    if (this._isReconnecting) {
      this.host.write(ansi.yellow('Already reconnecting...') + '\r\n\r\n');
      this.host.showPrompt();
      return;
    }

    this.reconnectAttempts = 0;
    this.reconnectDelay = 2000;
    await this.attemptReconnect();
  }

  private async attemptReconnect(): Promise<void> {
    if (this._isReconnecting) {
      return;
    }

    if (this._isConnected) {
      this.host.write(ansi.green('Already connected.') + '\r\n\r\n');
      this.host.showPrompt();
      return;
    }

    this._isReconnecting = true;
    this.reconnectAttempts++;

    const attemptText = this.reconnectAttempts > 1 ? ` (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})` : '';
    this.host.write(ansi.yellow('Reconnecting to ' + this.serverHost + ':' + this.serverPort + attemptText + '...') + '\r\n');

    try {
      // Disconnect existing controller
      try {
        await this._controller.disconnect();
      } catch (err) {
        // Ignore disconnect errors during reconnect
      }

      // Create new controller
      this._controller = this.controllerFactory(this.serverHost, this.serverPort, this.password, this.logger);
      await this._controller.connect();

      this._isConnected = true;
      this._isReconnecting = false;
      this.reconnectAttempts = 0;
      this.reconnectDelay = 2000;

      // Clear any pending timeout
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      this.host.write(ansi.boldGreen('✓ Reconnected successfully!') + '\r\n\r\n');

      // Reload commands after reconnection
      this.host.onReconnected();
    } catch (err) {
      this._isReconnecting = false;

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.host.write(ansi.red('✗ Connection failed: ' + errorMessage(err)) + '\r\n');
        this.host.write(ansi.yellow('Retrying in ' + (this.reconnectDelay / 1000) + ' seconds...') + '\r\n');

        // Clear any existing timeout
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
        }

        this.reconnectTimeout = setTimeout(() => {
          this.reconnectTimeout = null;
          this.attemptReconnect();
        }, this.reconnectDelay);

        // Exponential backoff with max delay
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 32000);
      } else {
        // Max attempts reached
        this.host.write(ansi.boldRed('✗ Reconnection failed after ' + this.maxReconnectAttempts + ' attempts.') + '\r\n');
        this.host.write('Type ' + ansi.yellow('/reconnect') + ' to try again.\r\n\r\n');
        this.reconnectAttempts = 0;
        this.reconnectDelay = 2000;

        // Clear timeout
        if (this.reconnectTimeout) {
          clearTimeout(this.reconnectTimeout);
          this.reconnectTimeout = null;
        }

        this.host.showPrompt();
      }
    }
  }

  /** Tears down any pending reconnect timer and disconnects the controller — used by `RconSession.close()`. */
  dispose(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    try {
      this._controller.disconnect();
    } catch (err) {
      this.logger.error(`Error during close: ${err}`);
    }
  }
}
