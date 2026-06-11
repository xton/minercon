// src/rconTerminal.ts
//
// Thin vscode.Pseudoterminal adapter over RconSession. All interactive logic
// lives in RconSession (rconSession.ts); this file is just the VS Code glue:
// EventEmitters, clipboard, extension context, and Pseudoterminal forwarding.

import * as vscode from 'vscode';
import { RconController } from './rconClient';
import { RconSession, RconSessionHost } from './rconSession';
import { Logger } from './logger';

export class RconTerminal implements vscode.Pseudoterminal {
  private writeEmitter = new vscode.EventEmitter<string>();
  onDidWrite: vscode.Event<string> = this.writeEmitter.event;

  private closeEmitter = new vscode.EventEmitter<number>();
  onDidClose: vscode.Event<number> = this.closeEmitter.event;

  private session: RconSession;
  private dims: vscode.TerminalDimensions | undefined;

  constructor(
    controller: RconController,
    host: string,
    port: number,
    password: string,
    logger: Logger,
    context: vscode.ExtensionContext
  ) {
    const sessionHost: RconSessionHost = {
      write: (text) => this.writeEmitter.fire(text),
      close: (code) => this.closeEmitter.fire(code),
      clipboard: {
        readText: () => Promise.resolve(vscode.env.clipboard.readText()),
        writeText: (text) => Promise.resolve(vscode.env.clipboard.writeText(text)),
      },
      cacheDir: context.globalStorageUri.fsPath,
      dimensions: () => this.dims ? { columns: this.dims.columns, rows: this.dims.rows } : undefined,
      historySize: vscode.workspace.getConfiguration('minercon').get<number>('historySize', 100),
    };

    this.session = new RconSession(controller, host, port, password, logger, sessionHost);
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    this.dims = initialDimensions;
    this.session.open();
  }

  close(): void {
    this.session.close();
  }

  handleInput(data: string): void {
    this.session.handleInput(data);
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.dims = dimensions;
  }
}
