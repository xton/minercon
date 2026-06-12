// src/logger.ts
//
// A small, level-aware logging seam that decouples the rest of the codebase
// from `vscode.OutputChannel` — most call sites only ever used it to call
// `appendLine` for diagnostic messages, which leaks a VS Code implementation
// detail into classes (RconProtocol, RconController, CommandAutocomplete,
// RconSession, ConnectionManager, ...) that are otherwise just talking to a
// socket or a terminal. Depending on this interface instead means those
// classes could run against any host that can produce one.

export interface Logger {
  error(message: string): void;
  warning(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

/** Severity order, most-verbose first — used to filter messages against a configured threshold. */
export const LOG_LEVELS = ['debug', 'info', 'warning', 'error'] as const;

export type LogLevel = typeof LOG_LEVELS[number];

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** True if a message at `level` should be emitted when the configured threshold is `threshold`. */
export function meetsLogLevel(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold);
}

/**
 * Safely render a caught `unknown` value as a string for logging/display —
 * `Error`s contribute their `message`, anything else is stringified directly.
 * Replaces the `(err as any).message ?? err` pattern that was scattered
 * across every catch block that needed to report what went wrong.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
