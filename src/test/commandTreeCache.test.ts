import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { silentLogger } from './support/testLogger';
import { CommandTreeCache } from '../commandTreeCache';
import { CommandNode } from '../localCommandTree';
import { ParameterType } from '../helpTextParsing';

function sampleCommands(): Map<string, CommandNode> {
    return new Map([
        ['gamemode', {
            name: 'gamemode',
            parameters: [{ type: ParameterType.ARGUMENT, name: 'mode', optional: false, position: 0 }],
            isComplete: true,
        }],
    ]);
}

// Reaches into the cache directory to mutate the persisted JSON directly,
// so we can exercise the version/server/age guards in `load()` without
// depending on how `CommandTreeCache` derives its file name internally.
function rewriteCacheFile(storageDir: string, mutate: (raw: any) => void): void {
    const cacheDir = path.join(storageDir, 'command-cache');
    const [fileName] = fs.readdirSync(cacheDir);
    const filePath = path.join(cacheDir, fileName);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    mutate(raw);
    fs.writeFileSync(filePath, JSON.stringify(raw));
}

suite('CommandTreeCache', () => {
    let storageDir: string;

    setup(() => {
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-cache-test-'));
    });

    teardown(() => {
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    test('load returns null when no cache file exists yet', () => {
        const cache = new CommandTreeCache(path.join(storageDir, 'command-cache'), 'host', 25575, silentLogger());
        assert.strictEqual(cache.load(), null);
    });

    test('save then load round-trips the command tree', () => {
        const cache = new CommandTreeCache(path.join(storageDir, 'command-cache'), 'host', 25575, silentLogger());
        const rootCommands = sampleCommands();

        cache.save(rootCommands);
        const loaded = cache.load();

        assert.ok(loaded);
        assert.deepStrictEqual(Array.from(loaded!.entries()), Array.from(rootCommands.entries()));
    });

    test('rejects a cache written by a different protocol version', () => {
        const cache = new CommandTreeCache(path.join(storageDir, 'command-cache'), 'host', 25575, silentLogger());
        cache.save(sampleCommands());

        rewriteCacheFile(storageDir, raw => { raw.version = '0.0.0'; });

        assert.strictEqual(cache.load(), null);
    });

    test('rejects a cache written for a different server identifier', () => {
        const cache = new CommandTreeCache(path.join(storageDir, 'command-cache'), 'host', 25575, silentLogger());
        cache.save(sampleCommands());

        rewriteCacheFile(storageDir, raw => { raw.serverIdentifier = 'other-host:25575'; });

        assert.strictEqual(cache.load(), null);
    });

    test('rejects a cache older than the max age', () => {
        const cache = new CommandTreeCache(path.join(storageDir, 'command-cache'), 'host', 25575, silentLogger());
        cache.save(sampleCommands());

        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
        rewriteCacheFile(storageDir, raw => { raw.lastUpdated = eightDaysAgo; });

        assert.strictEqual(cache.load(), null);
    });

    test('getInfo reports no cache before saving, and an existing one after', () => {
        const cache = new CommandTreeCache(path.join(storageDir, 'command-cache'), 'host', 25575, silentLogger());
        assert.strictEqual(cache.getInfo().exists, false);

        cache.save(sampleCommands());

        const info = cache.getInfo();
        assert.strictEqual(info.exists, true);
        assert.ok(info.lastUpdated instanceof Date);
    });

    test('clear deletes the cache file so load and getInfo see it as gone', () => {
        const cache = new CommandTreeCache(path.join(storageDir, 'command-cache'), 'host', 25575, silentLogger());
        cache.save(sampleCommands());
        assert.strictEqual(cache.getInfo().exists, true);

        cache.clear();

        assert.strictEqual(cache.getInfo().exists, false);
        assert.strictEqual(cache.load(), null);
    });
});
