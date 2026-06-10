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
import { readConfig, writeConfig, parsePort, resolveHost, resolvePort, resolvePassword } from '../cliConfig';

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
