#!/usr/bin/env node
// src/cli.ts — standalone CLI entry point for the Minercon terminal.
// Compiles to out/cli.js; the build script copies it to out/minercon.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from 'util';
import { createConsola } from 'consola';
import { text, password as passwordPrompt, isCancel, cancel, updateSettings } from '@clack/prompts';
import { RconController } from './rconClient';
import { RconSession, RconSessionHost } from './rconSession';
import { readConfig, writeConfig, parsePort, resolveHost, resolvePort, resolvePassword, resolveHistorySize, resolveLogLevel } from './cliConfig';

// ── Config file ──────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.config', 'minercon');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Prompt cancellation ──────────────────────────────────────────────────────

/** Unwraps a clack prompt result, exiting cleanly if the user cancelled (Ctrl+C/Esc). */
function unwrap(result: string | symbol): string {
  if (isCancel(result)) {
    cancel('Cancelled.');
    process.exit(0);
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      password: { type: 'string', short: 'p' },
      save: { type: 'boolean', default: false },
      'log-file': { type: 'string' },
      'log-level': { type: 'string' },
      'history-size': { type: 'string' },
      'no-plugin': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    process.stdout.write([
      'Usage: minercon [host] [port] [options]',
      '',
      'Options:',
      '  -p, --password <pw>   RCON password (also: MCRCON_PASSWORD env var)',
      '  --save                Save host/port/history-size to ~/.config/minercon/config.json',
      '  --log-file <path>     Write log output to a file instead of the console',
      '  --log-level <level>   consola log level, e.g. debug, info, warn, error (default: info)',
      '  --history-size <n>    Number of commands to remember in history (default: 100)',
      '  --no-plugin           Skip the server-side tab-complete plugin probe (manual testing only;',
      '                        not persisted to config)',
      '  -h, --help            Show this help',
      '',
      'Environment:',
      '  MCRCON_PASSWORD       RCON password (used if --password is not given)',
      '  MCRCON_LOG_FILE       Log file path (used if --log-file is not given)',
      '  MCRCON_LOG_LEVEL      Log level (used if --log-level is not given)',
      '  MCRCON_HISTORY_SIZE   History size (used if --history-size is not given)',
      '',
    ].join('\n'));
    process.exit(0);
  }

  if (!process.stdin.isTTY) {
    process.stderr.write('Error: minercon is an interactive terminal and does not support piped input\n');
    process.exit(1);
  }

  const logLevelResolution = resolveLogLevel(values['log-level'] as string | undefined, process.env['MCRCON_LOG_LEVEL']);
  if ('error' in logLevelResolution) {
    process.stderr.write(`Error: ${logLevelResolution.error}\n`);
    process.exit(1);
  }

  const logFilePath = (values['log-file'] as string | undefined) ?? process.env['MCRCON_LOG_FILE'];
  const logStream = logFilePath
    ? (fs.createWriteStream(logFilePath, { flags: 'a' }) as unknown as NodeJS.WriteStream)
    : undefined;

  updateSettings({ withGuide: false });
  const logger = createConsola({
    level: logLevelResolution.level,
    ...(logStream ? { stdout: logStream, stderr: logStream } : {}),
  });
  const savedConfig = readConfig(CONFIG_FILE);

  // Resolve host
  let host = resolveHost(positionals[0], savedConfig);
  if (!host) {
    host = unwrap(await text({
      message: 'RCON host (e.g. 127.0.0.1):',
      validate: (value) => {
        if (!value || value.trim() === '') { return 'host is required'; }
      },
    })).trim();
  }

  // Resolve port
  let port: number;
  const portResolution = resolvePort(positionals[1], savedConfig);
  if (portResolution && 'error' in portResolution) {
    process.stderr.write(`Error: ${portResolution.error}\n`);
    process.exit(1);
  } else if (portResolution) {
    port = portResolution.port;
  } else {
    const raw = unwrap(await text({
      message: 'RCON port',
      placeholder: '25575',
      defaultValue: '25575',
      validate: (value) => {
        if (value && parsePort(value) === null) { return `invalid port: ${value}`; }
      },
    }));
    const parsed = parsePort(raw);
    if (parsed === null) {
      process.stderr.write(`Error: invalid port: ${raw}\n`);
      process.exit(1);
    }
    port = parsed;
  }

  // Resolve password — never saved to disk
  let password = resolvePassword(values.password as string | undefined, process.env['MCRCON_PASSWORD']);
  if (!password) {
    password = unwrap(await passwordPrompt({ message: `RCON password for ${host}:${port}:` }));
  }

  // Resolve history size
  const historySizeResolution = resolveHistorySize(values['history-size'] as string | undefined, process.env['MCRCON_HISTORY_SIZE'], savedConfig);
  if ('error' in historySizeResolution) {
    process.stderr.write(`Error: ${historySizeResolution.error}\n`);
    process.exit(1);
  }
  const historySize = historySizeResolution.historySize;

  if (values.save) {
    writeConfig(CONFIG_FILE, { host, port, historySize });
    logger.info(`Saved ${host}:${port} (history size ${historySize}) to ${CONFIG_FILE}`);
  }

  // ── Establish connection ──────────────────────────────────────────────────

  const controller = new RconController(host, port, password, logger);
  logger.info(`Connecting to ${host}:${port}...`);

  try {
    await controller.connect();
  } catch (err) {
    logger.error(`Failed to connect: ${err}`);
    process.exit(1);
  }

  // ── Build session host ────────────────────────────────────────────────────

  let pasteboard = '';

  // Cache lives in the same config dir as config.json
  const cacheDir = CONFIG_DIR;

  const sessionHost: RconSessionHost = {
    write: (text) => process.stdout.write(text),
    close: (code) => {
      teardown();
      process.exit(code);
    },
    clipboard: {
      readText: () => Promise.resolve(pasteboard),
      writeText: (text) => { pasteboard = text; return Promise.resolve(); },
    },
    cacheDir,
    dimensions: () =>
      process.stdout.columns && process.stdout.rows
        ? { columns: process.stdout.columns, rows: process.stdout.rows }
        : undefined,
    historySize,
    disablePlugin: values['no-plugin'] as boolean,
    logToFile: logFilePath !== undefined,
  };

  const session = new RconSession(controller, host, port, password, logger, sessionHost);

  // ── TTY / signal setup ────────────────────────────────────────────────────

  let tornDown = false;

  function teardown(): void {
    if (tornDown) { return; }
    tornDown = true;
    process.stdin.setRawMode(false);
    process.stdin.pause();
    session.close();
  }

  process.on('exit', teardown);
  process.on('SIGINT', () => { teardown(); process.exit(0); });
  process.on('SIGTERM', () => { teardown(); process.exit(0); });

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdout.on('resize', () => {
    // dimensions() reads process.stdout.columns/rows live — nothing to do here
  });

  process.stdin.on('data', (chunk: string) => {
    session.handleInput(chunk);
  });

  // Open the session (writes the welcome banner and starts the plugin probe)
  session.open();
}

main().catch((err) => {
  process.stderr.write(`Error: ${err}\n`);
  process.exit(1);
});
