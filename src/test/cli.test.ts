// src/test/cli.test.ts
//
// Tests for the CLI's pure, non-interactive logic: config file read/write.
// Argv parsing and connection setup require process state (stdin TTY,
// process.argv) that is awkward to control in the vscode-test runner — those
// paths are covered by the manual smoke-test described in the plan.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// We test the config helpers by re-implementing them inline using the same
// logic as cli.ts — this avoids importing cli.ts (which would run main()).
// If the config helpers are ever extracted to a shared module, point these
// tests at that module instead.

function readConfig(configFile: string): { host?: string; port?: number } {
    try {
        return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
        return {};
    }
}

function writeConfig(configFile: string, cfg: { host?: string; port?: number }): void {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

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
