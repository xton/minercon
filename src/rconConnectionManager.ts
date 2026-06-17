// src/rconConnectionManager.ts
//
// Owns the RCON connection lifecycle: the live `RconController` (recreated on
// each reconnect attempt), connection/reconnection status, and the
// exponential-backoff retry loop. Pulled out of RconTerminal as part of the
// mega-module split — see lineEditor.ts / displaySuggestion.ts for the sibling
// extractions and their rationale.
//
// `RconSession` keeps `detectAndInitialize`/`initializeCommands` (they're
// about the autocomplete command-tree and `pluginMode`, a different concern
// that happens to run at similar times) but reads connection status and reaches
// the live controller through this class, and is notified via `onReconnected`
// when it should reload the command tree.

import type { ConsolaInstance } from 'consola';
import { RconController } from './rconClient';
import { errorMessage } from './logger';
import * as ansi from './ansi';

export interface RconConnectionManagerHost {
  write(text: string): void;
  showPrompt(): void;
  onReconnected(): void;
}

/** Builds the `RconController` used for a (re)connection attempt — overridable in tests so `attemptReconnect()` doesn't open a real socket. */
export type ControllerFactory = (host: string, port: number, password: string, logger: ConsolaInstance) => RconController;

const defaultControllerFactory: ControllerFactory = (host, port, password, logger) =>
  new RconController(host, port, password, logger);

export class RconConnectionManager {
  private _controller: RconController;
  // Intent-level connection state: whether the session currently considers
  // itself connected, driven by the lifecycle transitions here (initial
  // connect, `disconnect`, `reportConnectionLost`, successful reconnect). This
  // is what the UI/prompt reads, and is deliberately distinct from the live
  // socket truth in `RconController.isConnected()` — the two can briefly differ
  // mid-reconnect (e.g. this is `false` while a new socket is being dialed).
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
    private readonly logger: ConsolaInstance,
    controller: RconController,
    private readonly host: RconConnectionManagerHost,
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

  /** Resets the reconnect-attempt counter, backoff delay, and any pending reconnect timer back to their initial state. */
  private resetReconnectState(): void {
    this.reconnectAttempts = 0;
    this.reconnectDelay = 2000;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  /**
   * Records that an in-flight command discovered the connection is gone, and
   * schedules an auto-reconnect attempt shortly after. The "Connection
   * lost..." message itself stays with the caller (`executeCommand` accounts
   * for it in its output-line bookkeeping).
   */
  reportConnectionLost(): void {
    this._isConnected = false;
    this.resetReconnectState();

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.attemptReconnect();
    }, 1000);
  }

  disconnect(): void {
    // No key-chord echo here: this runs for the typed /disconnect built-in.
    // Ctrl+D echoes its own ^D in RconSession.handleCtrlD before closing.
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

    this.resetReconnectState();
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
      this.resetReconnectState();

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
        this.resetReconnectState();

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
