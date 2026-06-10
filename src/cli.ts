#!/usr/bin/env node
// src/cli.ts — standalone CLI entry point for the Minecraft RCON terminal.
// Compiles to out/cli.js; the build script copies it to out/rcon-minecraft.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { parseArgs } from 'util';
import { RconController } from './rconClient';
import { RconSession, RconSessionHost } from './rconSession';
import { Logger } from './logger';
import { readConfig, writeConfig, parsePort, resolveHost, resolvePort, resolvePassword } from './cliConfig';

// ── Config file ──────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(os.homedir(), '.config', 'minecraft-rcon');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ── Logger ───────────────────────────────────────────────────────────────────

function createCliLogger(logFile?: string): Logger {
  let stream: fs.WriteStream | undefined;
  if (logFile) {
    stream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  function write(level: string, color: string, msg: string): void {
    const line = `${color}${level}\x1b[0m ${msg}\n`;
    if (stream) {
      stream.write(`${level} ${msg}\n`);
    } else {
      process.stderr.write(line);
    }
  }

  return {
    error:   (msg) => write('ERROR', '\x1b[31m', msg),
    warning: (msg) => write('WARN',  '\x1b[33m', msg),
    info:    (msg) => write('INFO',  '\x1b[36m', msg),
  };
}

// ── Masked password prompt ────────────────────────────────────────────────────

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: undefined });
    // Put stdin in non-echo mode for the duration of the prompt
    if (process.stdin.isTTY) {
      (process.stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void }).setRawMode(true);
    }
    let password = '';
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const handler = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.removeListener('data', handler);
          rl.close();
          if (process.stdin.isTTY) {
            (process.stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void }).setRawMode(false);
          }
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
      help:     { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    process.stdout.write([
      'Usage: rcon-minecraft [host] [port] [options]',
      '',
      'Options:',
      '  -p, --password <pw>   RCON password (also: MCRCON_PASSWORD env var)',
      '  --save                Save host/port to ~/.config/minecraft-rcon/config.json',
      '  --log-file <path>     Append log output to a file instead of stderr',
      '  -h, --help            Show this help',
      '',
      'Environment:',
      '  MCRCON_PASSWORD       RCON password (used if --password is not given)',
      '  MCRCON_LOG_FILE       Log file path (used if --log-file is not given)',
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

  if (values.save) {
    writeConfig(CONFIG_FILE, { host, port });
    process.stderr.write(`\x1b[36mINFO\x1b[0m Saved ${host}:${port} to ${CONFIG_FILE}\n`);
  }

  // ── Establish connection ──────────────────────────────────────────────────

  const controller = new RconController(host, port, password, logger);
  process.stderr.write(`\x1b[36mINFO\x1b[0m Connecting to ${host}:${port}...\n`);

  try {
    await controller.connect();
  } catch (err) {
    process.stderr.write(`\x1b[31mERROR\x1b[0m Failed to connect: ${err}\n`);
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
  };

  const session = new RconSession(controller, host, port, password, logger, sessionHost);

  // ── TTY / signal setup ────────────────────────────────────────────────────

  let tornDown = false;

  function teardown(): void {
    if (tornDown) { return; }
    tornDown = true;
    if (process.stdin.isTTY) {
      (process.stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void }).setRawMode(false);
    }
    process.stdin.pause();
    session.close();
  }

  process.on('exit', teardown);
  process.on('SIGINT',  () => { teardown(); process.exit(0); });
  process.on('SIGTERM', () => { teardown(); process.exit(0); });

  if (process.stdin.isTTY) {
    (process.stdin as NodeJS.ReadStream & { setRawMode(mode: boolean): void }).setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdout.on('resize', () => {
    // dimensions() reads process.stdout.columns/rows live — nothing to do here
  });

  process.stdin.on('data', (chunk: string) => {
    session.handleInput(chunk);
  });

  // Open the session (writes the welcome banner and starts the plugin probe)
  session.open(sessionHost.dimensions());
}

main().catch((err) => {
  process.stderr.write(`\x1b[31mERROR\x1b[0m ${err}\n`);
  process.exit(1);
});
