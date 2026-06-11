#!/usr/bin/env node
// src/cli.ts — standalone CLI entry point for the Minercon terminal.
// Compiles to out/cli.js; the build script copies it to out/minercon.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { parseArgs } from 'util';
import { RconController } from './rconClient';
import { RconSession, RconSessionHost } from './rconSession';
import { Logger } from './logger';
import { readConfig, writeConfig, parsePort, resolveHost, resolvePort, resolvePassword, resolveHistorySize } from './cliConfig';
import * as ansi from './ansi';

// ── Config file ──────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.config', 'minercon');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── TTY helpers ──────────────────────────────────────────────────────────────

/** Toggles raw mode on stdin, if it's a TTY (a no-op otherwise, e.g. when piped). */
function setRawMode(mode: boolean): void {
  if (process.stdin.isTTY) {
    (process.stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void }).setRawMode(mode);
  }
}

// ── Logger ───────────────────────────────────────────────────────────────────

function createCliLogger(logFile?: string): Logger {
  let stream: fs.WriteStream | undefined;
  if (logFile) {
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  function write(level: string, color: string, msg: string): void {
    const line = `${ansi.style(color, level)} ${msg}\n`;
    if (stream) {
      stream.write(`${level} ${msg}\n`);
    } else {
      process.stderr.write(line);
    }
  }

  return {
    error:   (msg) => write('ERROR', ansi.RED, msg),
    warning: (msg) => write('WARN',  ansi.YELLOW, msg),
    info:    (msg) => write('INFO',  ansi.CYAN, msg),
  };
}

// ── Masked password prompt ────────────────────────────────────────────────────

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: undefined });
    // Put stdin in non-echo mode for the duration of the prompt
    setRawMode(true);
    let password = '';
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const handler = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.removeListener('data', handler);
          rl.close();
          setRawMode(false);
          process.stdout.write('\n');
          resolve(password);
          return;
        } else if (ch === '\x7f' || ch === '\b') {
          password = password.slice(0, -1);
        } else if (ch.charCodeAt(0) >= 32) {
          password += ch;
        }
      }
    };
    process.stdin.on('data', handler);
  });
}

// ── Arg prompt ───────────────────────────────────────────────────────────────

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      password: { type: 'string', short: 'p' },
      save:     { type: 'boolean', default: false },
      'log-file': { type: 'string' },
      'history-size': { type: 'string' },
      'no-plugin': { type: 'boolean', default: false },
      help:     { type: 'boolean', short: 'h', default: false },
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
      '  --log-file <path>     Append log output to a file instead of stderr',
      '  --history-size <n>    Number of commands to remember in history (default: 100)',
      '  --no-plugin           Skip the server-side tab-complete plugin probe (manual testing only;',
      '                        not persisted to config)',
      '  -h, --help            Show this help',
      '',
      'Environment:',
      '  MCRCON_PASSWORD       RCON password (used if --password is not given)',
      '  MCRCON_LOG_FILE       Log file path (used if --log-file is not given)',
      '  MCRCON_HISTORY_SIZE   History size (used if --history-size is not given)',
      '',
    ].join('\n'));
    process.exit(0);
  }

  const logger = createCliLogger((values['log-file'] as string | undefined) ?? process.env['MCRCON_LOG_FILE']);
  const savedConfig = readConfig(CONFIG_FILE);

  // Resolve host
  let host = resolveHost(positionals[0], savedConfig);
  if (!host) {
    host = await promptLine('RCON host (e.g. 127.0.0.1): ');
  }
  if (!host) {
    process.stderr.write('Error: host is required\n');
    process.exit(1);
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
    const raw = await promptLine('RCON port [25575]: ');
    if (!raw) {
      port = 25575;
    } else {
      const parsed = parsePort(raw);
      if (parsed === null) {
        process.stderr.write(`Error: invalid port: ${raw}\n`);
        process.exit(1);
      }
      port = parsed;
    }
  }

  // Resolve password — never saved to disk
  let password = resolvePassword(values.password as string | undefined, process.env['MCRCON_PASSWORD']);
  if (!password) {
    password = await promptPassword(`RCON password for ${host}:${port}: `);
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
    process.stderr.write(`${ansi.cyan('INFO')} Saved ${host}:${port} (history size ${historySize}) to ${CONFIG_FILE}\n`);
  }

  // ── Establish connection ──────────────────────────────────────────────────

  const controller = new RconController(host, port, password, logger);
  process.stderr.write(`${ansi.cyan('INFO')} Connecting to ${host}:${port}...\n`);

  try {
    await controller.connect();
  } catch (err) {
    process.stderr.write(`${ansi.red('ERROR')} Failed to connect: ${err}\n`);
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
      readText:  () => Promise.resolve(pasteboard),
      writeText: (text) => { pasteboard = text; return Promise.resolve(); },
    },
    cacheDir,
    dimensions: () =>
      process.stdout.columns && process.stdout.rows
        ? { columns: process.stdout.columns, rows: process.stdout.rows }
        : undefined,
    historySize,
    disablePlugin: values['no-plugin'] as boolean,
  };

  const session = new RconSession(controller, host, port, password, logger, sessionHost);

  // ── TTY / signal setup ────────────────────────────────────────────────────

  let tornDown = false;

  function teardown(): void {
    if (tornDown) { return; }
    tornDown = true;
    setRawMode(false);
    process.stdin.pause();
    session.close();
  }

  process.on('exit', teardown);
  process.on('SIGINT',  () => { teardown(); process.exit(0); });
  process.on('SIGTERM', () => { teardown(); process.exit(0); });

  setRawMode(true);
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
  process.stderr.write(`${ansi.red('ERROR')} ${err}\n`);
  process.exit(1);
});
