// src/test/cli.test.ts
//
// Tests for the CLI's pure, non-interactive logic: config file read/write
// and host/port/password resolution precedence. These all live in
// cliConfig.ts specifically so they can be imported and unit-tested without
// triggering cli.ts's top-level main() call (which needs a real TTY/argv).
// Argv parsing and interactive prompting/connection setup are covered by the
// manual smoke-test described in the plan.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfig, writeConfig, parsePort, resolveHost, resolvePort, resolvePassword, parseHistorySize, resolveHistorySize, resolveLogLevel } from '../cliConfig';
import { createTerminalWriter, createCliLogger } from '../terminalOutput';

suite('CLI config', () => {
    let tmpDir: string;
    let configFile: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-cli-test-'));
        configFile = path.join(tmpDir, 'config.json');
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('readConfig returns empty object when no file exists', () => {
        const cfg = readConfig(configFile);
        assert.deepStrictEqual(cfg, {});
    });

    test('writeConfig persists host and port; readConfig reads them back', () => {
        writeConfig(configFile, { host: '10.0.0.1', port: 25575 });
        const cfg = readConfig(configFile);
        assert.strictEqual(cfg.host, '10.0.0.1');
        assert.strictEqual(cfg.port, 25575);
    });

    test('writeConfig creates parent directories if they do not exist', () => {
        const nested = path.join(tmpDir, 'a', 'b', 'config.json');
        assert.doesNotThrow(() => writeConfig(nested, { host: 'mc.example.com', port: 1234 }));
        assert.ok(fs.existsSync(nested));
    });

    test('writeConfig never includes a password field', () => {
        writeConfig(configFile, { host: 'h', port: 1 });
        const raw = fs.readFileSync(configFile, 'utf8');
        assert.ok(!raw.includes('password'), 'password must not appear in the config file');
    });

    test('readConfig returns partial config when only host is stored', () => {
        writeConfig(configFile, { host: 'mc.example.com' });
        const cfg = readConfig(configFile);
        assert.strictEqual(cfg.host, 'mc.example.com');
        assert.strictEqual(cfg.port, undefined);
    });

    test('readConfig tolerates malformed JSON by returning empty object', () => {
        fs.writeFileSync(configFile, '{ not valid json }', 'utf8');
        const cfg = readConfig(configFile);
        assert.deepStrictEqual(cfg, {});
    });
});

suite('CLI parsePort', () => {
    test('accepts ports within the valid range', () => {
        assert.strictEqual(parsePort('1'), 1);
        assert.strictEqual(parsePort('25575'), 25575);
        assert.strictEqual(parsePort('65535'), 65535);
    });

    test('rejects 0, negative, and out-of-range ports', () => {
        assert.strictEqual(parsePort('0'), null);
        assert.strictEqual(parsePort('-1'), null);
        assert.strictEqual(parsePort('65536'), null);
    });

    test('rejects non-numeric input', () => {
        assert.strictEqual(parsePort('not-a-port'), null);
        assert.strictEqual(parsePort(''), null);
    });
});

suite('CLI resolveHost', () => {
    test('prefers a positional host over the saved config', () => {
        assert.strictEqual(resolveHost('10.0.0.1', { host: '10.0.0.2' }), '10.0.0.1');
    });

    test('falls back to the saved config when no positional host is given', () => {
        assert.strictEqual(resolveHost(undefined, { host: '10.0.0.2' }), '10.0.0.2');
    });

    test('returns undefined when neither a positional host nor a saved one is available', () => {
        assert.strictEqual(resolveHost(undefined, {}), undefined);
    });
});

suite('CLI resolvePort', () => {
    test('uses a valid positional port over the saved config', () => {
        assert.deepStrictEqual(resolvePort('25576', { port: 25575 }), { port: 25576 });
    });

    test('returns an error for an invalid positional port', () => {
        assert.deepStrictEqual(resolvePort('not-a-port', { port: 25575 }), { error: 'invalid port: not-a-port' });
        assert.deepStrictEqual(resolvePort('70000', {}), { error: 'invalid port: 70000' });
    });

    test('falls back to the saved config when no positional port is given', () => {
        assert.deepStrictEqual(resolvePort(undefined, { port: 25575 }), { port: 25575 });
    });

    test('returns undefined (prompt needed) when neither is available', () => {
        assert.strictEqual(resolvePort(undefined, {}), undefined);
    });
});

suite('CLI resolvePassword', () => {
    test('prefers the --password flag over the env var', () => {
        assert.strictEqual(resolvePassword('flag-pw', 'env-pw'), 'flag-pw');
    });

    test('falls back to the env var when no flag is given', () => {
        assert.strictEqual(resolvePassword(undefined, 'env-pw'), 'env-pw');
    });

    test('returns undefined (prompt needed) when neither is available', () => {
        assert.strictEqual(resolvePassword(undefined, undefined), undefined);
    });

    test('treats an empty-string flag as not provided', () => {
        assert.strictEqual(resolvePassword('', 'env-pw'), 'env-pw');
    });
});

suite('CLI parseHistorySize', () => {
    test('accepts positive integers', () => {
        assert.strictEqual(parseHistorySize('1'), 1);
        assert.strictEqual(parseHistorySize('250'), 250);
    });

    test('rejects 0, negative, and non-numeric input', () => {
        assert.strictEqual(parseHistorySize('0'), null);
        assert.strictEqual(parseHistorySize('-5'), null);
        assert.strictEqual(parseHistorySize('not-a-number'), null);
        assert.strictEqual(parseHistorySize(''), null);
    });

    test('rejects non-integer input', () => {
        assert.strictEqual(parseHistorySize('1.5'), null);
        assert.strictEqual(parseHistorySize('100abc'), null);
    });
});

suite('CLI resolveHistorySize', () => {
    test('prefers the --history-size flag over the env var and saved config', () => {
        assert.deepStrictEqual(resolveHistorySize('50', '75', { historySize: 200 }), { historySize: 50 });
    });

    test('falls back to the env var when no flag is given', () => {
        assert.deepStrictEqual(resolveHistorySize(undefined, '75', { historySize: 200 }), { historySize: 75 });
    });

    test('falls back to the saved config when neither flag nor env var is given', () => {
        assert.deepStrictEqual(resolveHistorySize(undefined, undefined, { historySize: 200 }), { historySize: 200 });
    });

    test('defaults to 100 when nothing is set', () => {
        assert.deepStrictEqual(resolveHistorySize(undefined, undefined, {}), { historySize: 100 });
    });

    test('returns an error for an invalid value', () => {
        assert.deepStrictEqual(resolveHistorySize('not-a-number', undefined, {}), { error: 'invalid history size: not-a-number' });
    });
});

suite('CLI resolveLogLevel', () => {
    test('prefers the --log-level flag over the env var', () => {
        assert.deepStrictEqual(resolveLogLevel('debug', 'warning'), { logLevel: 'debug' });
    });

    test('falls back to the env var when no flag is given', () => {
        assert.deepStrictEqual(resolveLogLevel(undefined, 'error'), { logLevel: 'error' });
    });

    test('defaults to "info" when neither is set', () => {
        assert.deepStrictEqual(resolveLogLevel(undefined, undefined), { logLevel: 'info' });
    });

    test('returns an error for an invalid value', () => {
        assert.deepStrictEqual(
            resolveLogLevel('verbose', undefined),
            { error: 'invalid log level: verbose (expected one of: debug, info, warning, error)' },
        );
    });
});

suite('terminal output coordination', () => {
    let written: string[];
    let terminal: ReturnType<typeof createTerminalWriter>;

    setup(() => {
        written = [];
        terminal = createTerminalWriter((text) => written.push(text));
    });

    test('a log line is written as-is when there is no in-progress redraw', () => {
        terminal.writeLogLine('INFO hello\n');
        assert.deepStrictEqual(written, ['INFO hello\n']);
    });

    test('a log line clears and redraws an in-progress status line (progress bar) beneath it', () => {
        // Simulates rconSession's progress bar: '\r\x1b[K' followed by the bar text, with no trailing newline.
        terminal.write('\r\x1b[K');
        terminal.write('[####] 50%');

        terminal.writeLogLine('INFO loading minecraft:advancement\n');

        assert.deepStrictEqual(written, [
            '\r\x1b[K',
            '[####] 50%',
            '\r\x1b[KINFO loading minecraft:advancement\n\x1b[K[####] 50%',
        ]);
    });

    test('a completed line (ending in \\n) is not redrawn by a later log line', () => {
        terminal.write('Connected to host:port\r\n\r\n');

        terminal.writeLogLine('INFO ready\n');

        assert.deepStrictEqual(written, [
            'Connected to host:port\r\n\r\n',
            'INFO ready\n',
        ]);
    });
});

suite('createCliLogger', () => {
    test('writes colored, level-prefixed lines through the terminal writer by default', () => {
        const written: string[] = [];
        const terminal = createTerminalWriter((text) => written.push(text));
        const logger = createCliLogger(terminal);

        logger.info('hello');

        assert.strictEqual(written.length, 1);
        assert.match(written[0], /INFO/);
        assert.match(written[0], /hello\n$/);
    });

    test('writes plain lines to a log file instead, when given', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-cli-logfile-test-'));
        const logFile = path.join(tmpDir, 'cli.log');
        try {
            const written: string[] = [];
            const terminal = createTerminalWriter((text) => written.push(text));
            const logger = createCliLogger(terminal, logFile);

            logger.warning('careful');
            await new Promise((resolve) => setTimeout(resolve, 0));

            assert.deepStrictEqual(written, []);
            assert.strictEqual(fs.readFileSync(logFile, 'utf8'), 'WARN careful\n');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('debug messages are dropped at the default ("info") log level', () => {
        const written: string[] = [];
        const terminal = createTerminalWriter((text) => written.push(text));
        const logger = createCliLogger(terminal);

        logger.debug('verbose detail');

        assert.deepStrictEqual(written, []);
    });

    test('debug messages are written, with a millisecond-resolution timestamp, at the "debug" log level', () => {
        const written: string[] = [];
        const terminal = createTerminalWriter((text) => written.push(text));
        const logger = createCliLogger(terminal, undefined, 'debug');

        logger.debug('verbose detail');

        assert.strictEqual(written.length, 1);
        assert.match(written[0], /\d{2}:\d{2}:\d{2}\.\d{3} .*DEBUG/);
        assert.match(written[0], /verbose detail\n$/);
    });

    test('info messages are still written at the "debug" log level', () => {
        const written: string[] = [];
        const terminal = createTerminalWriter((text) => written.push(text));
        const logger = createCliLogger(terminal, undefined, 'debug');

        logger.info('hello');

        assert.strictEqual(written.length, 1);
        assert.match(written[0], /INFO/);
    });

    test('info messages are dropped at the "warning" log level', () => {
        const written: string[] = [];
        const terminal = createTerminalWriter((text) => written.push(text));
        const logger = createCliLogger(terminal, undefined, 'warning');

        logger.info('hello');
        logger.warning('careful');

        assert.strictEqual(written.length, 1);
        assert.match(written[0], /WARN/);
    });
});
