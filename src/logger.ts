// src/logger.ts
//
// A small, level-aware logging seam that decouples the rest of the codebase
// from `vscode.OutputChannel` — most call sites only ever used it to call
// `appendLine` for diagnostic messages, which leaks a VS Code implementation
// detail into classes (RconProtocol, RconController, CommandAutocomplete,
// RconTerminal, ConnectionManager, ...) that are otherwise just talking to a
// socket or a terminal. Depending on this interface instead means those
// classes could run against any host that can produce one.

import * as vscode from 'vscode';

export interface Logger {
  error(message: string): void;
  warning(message: string): void;
  info(message: string): void;
}

/** Wraps a VS Code output channel as a `Logger` — the one place that bridges the two. */
export function createOutputChannelLogger(channel: vscode.OutputChannel): Logger {
  return {
    error: (message) => channel.appendLine(`[error] ${message}`),
    warning: (message) => channel.appendLine(`[warning] ${message}`),
    info: (message) => channel.appendLine(message),
  };
}
