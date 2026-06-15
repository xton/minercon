import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { silentLogger } from './support/testLogger';
import { HistoryStore } from '../historyStore';

suite('HistoryStore', () => {
    let cacheDir: string;

    setup(() => {
        cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-history-test-'));
    });

    teardown(() => {
        fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    test('load returns an empty array when no history file exists yet', () => {
        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        assert.deepStrictEqual(store.load(), []);
    });

    test('save then load round-trips entries in order', () => {
        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        const entries = ['help', 'gamemode creative', 'tp @s ~ ~10 ~'];

        store.save(entries);

        const reloaded = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        assert.deepStrictEqual(reloaded.load(), entries);
    });

    test('different servers in the same cache directory get separate history files', () => {
        const storeA = new HistoryStore(cacheDir, 'host-a', 25575, silentLogger());
        const storeB = new HistoryStore(cacheDir, 'host-b', 25575, silentLogger());

        storeA.save(['command-a']);
        storeB.save(['command-b']);

        assert.deepStrictEqual(storeA.load(), ['command-a']);
        assert.deepStrictEqual(storeB.load(), ['command-b']);
    });

    test('rejects a history file written by a different version', () => {
        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        store.save(['help']);

        const file = path.join(cacheDir, 'host_25575_history.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        raw.version = 999;
        fs.writeFileSync(file, JSON.stringify(raw));

        assert.deepStrictEqual(store.load(), []);
    });

    test('returns an empty array for malformed JSON', () => {
        const file = path.join(cacheDir, 'host_25575_history.json');
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(file, '{ not valid json');

        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        assert.deepStrictEqual(store.load(), []);
    });

    test('truncates to the most recent entries when saving more than the cap', () => {
        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        const entries = Array.from({ length: 150 }, (_, i) => `command-${i}`);

        store.save(entries);

        const loaded = store.load();
        assert.strictEqual(loaded.length, 100);
        assert.deepStrictEqual(loaded, entries.slice(-100));
    });

    test('a custom maxEntries caps both save and load', () => {
        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger(), 5);
        const entries = Array.from({ length: 10 }, (_, i) => `command-${i}`);

        store.save(entries);

        assert.deepStrictEqual(store.load(), entries.slice(-5));
    });

    test('a smaller maxEntries on reload truncates previously saved history', () => {
        const wide = new HistoryStore(cacheDir, 'host', 25575, silentLogger(), 10);
        wide.save(Array.from({ length: 10 }, (_, i) => `command-${i}`));

        const narrow = new HistoryStore(cacheDir, 'host', 25575, silentLogger(), 3);
        assert.deepStrictEqual(narrow.load(), ['command-7', 'command-8', 'command-9']);
    });

    test('save creates the cache directory if it does not exist', () => {
        const nestedDir = path.join(cacheDir, 'nested', 'cache');
        const store = new HistoryStore(nestedDir, 'host', 25575, silentLogger());

        store.save(['help']);

        assert.strictEqual(store.load().length, 1);
    });
});
