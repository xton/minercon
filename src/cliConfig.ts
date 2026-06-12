// src/cliConfig.ts
//
// Pure helpers for the CLI's connection-config resolution: the saved
// host/port config file, port validation, and the precedence rules for
// host/port/password (CLI args → saved config / env var → prompt). Kept
// separate from cli.ts (which wires these into argv parsing, prompts, and
// process I/O) so the precedence logic can be unit-tested without spawning a
// process or touching stdin/stdout.

import * as fs from 'fs';
import * as path from 'path';
import { LogLevel, LOG_LEVELS, isLogLevel } from './logger';

export interface Config {
  host?: string;
  port?: number;
  historySize?: number;
}

export function readConfig(configFile: string): Config {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8')) as Config;
  } catch {
    return {};
  }
}

export function writeConfig(configFile: string, cfg: Config): void {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Parses a port string, returning null if it isn't a valid TCP port (1-65535). */
export function parsePort(raw: string): number | null {
  const port = parseInt(raw, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

/** Resolves the RCON host from a positional CLI arg and the saved config, or undefined if the user must be prompted. */
export function resolveHost(positionalHost: string | undefined, savedConfig: Config): string | undefined {
  return positionalHost || savedConfig.host;
}

export type PortResolution = { port: number } | { error: string };

/**
 * Resolves the RCON port from a positional CLI arg and the saved config.
 *  - `{ port }` if resolved from the arg or the saved config
 *  - `{ error }` if a positional port arg was given but isn't a valid port
 *  - `undefined` if the user must be prompted (with a default of 25575)
 */
export function resolvePort(positionalPort: string | undefined, savedConfig: Config): PortResolution | undefined {
  if (positionalPort !== undefined) {
    const port = parsePort(positionalPort);
    return port !== null ? { port } : { error: `invalid port: ${positionalPort}` };
  }
  if (savedConfig.port !== undefined) {
    return { port: savedConfig.port };
  }
  return undefined;
}

/** Resolves the RCON password from the --password flag and MCRCON_PASSWORD env var, or undefined if the user must be prompted. */
export function resolvePassword(flagPassword: string | undefined, envPassword: string | undefined): string | undefined {
  return flagPassword || envPassword || undefined;
}

/** Parses a history size string, returning null if it isn't a positive integer. */
export function parseHistorySize(raw: string): number | null {
  const size = parseInt(raw, 10);
  if (isNaN(size) || size < 1 || String(size) !== raw.trim()) {
    return null;
  }
  return size;
}

export type HistorySizeResolution = { historySize: number } | { error: string };

/**
 * Resolves the number of history entries to remember from the --history-size
 * flag, MCRCON_HISTORY_SIZE env var, and saved config, in that order, falling
 * back to 100 if none are set. Returns `{ error }` if a value was given but
 * isn't a positive integer.
 */
export function resolveHistorySize(flagValue: string | undefined, envValue: string | undefined, savedConfig: Config): HistorySizeResolution {
  const raw = flagValue || envValue;
  if (raw !== undefined) {
    const parsed = parseHistorySize(raw);
    return parsed !== null ? { historySize: parsed } : { error: `invalid history size: ${raw}` };
  }
  if (savedConfig.historySize !== undefined) {
    return { historySize: savedConfig.historySize };
  }
  return { historySize: 100 };
}

export type LogLevelResolution = { logLevel: LogLevel } | { error: string };

/**
 * Resolves the log level from the --log-level flag or MCRCON_LOG_LEVEL env
 * var, in that order, falling back to "info" if neither is set. Returns
 * `{ error }` if a value was given but isn't one of LOG_LEVELS.
 */
export function resolveLogLevel(flagValue: string | undefined, envValue: string | undefined): LogLevelResolution {
  const raw = flagValue || envValue;
  if (raw === undefined) {
    return { logLevel: 'info' };
  }
  return isLogLevel(raw) ? { logLevel: raw } : { error: `invalid log level: ${raw} (expected one of: ${LOG_LEVELS.join(', ')})` };
}
