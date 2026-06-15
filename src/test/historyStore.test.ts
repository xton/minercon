import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { silentLogger } from './support/testLogger';
import { HistoryStore, searchHistory, startHistorySearch, setHistorySearchQuery, cycleHistorySearch } from '../historyStore';

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

    test('stores history as one entry per line', () => {
        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        store.save(['help', 'gamemode creative']);

        const file = path.join(cacheDir, 'host_25575_history.txt');
        assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'help\ngamemode creative\n');
    });

    test('strips newlines from entries when saving', () => {
        const store = new HistoryStore(cacheDir, 'host', 25575, silentLogger());
        store.save(['help\nrm -rf /\r\n', 'gamemode creative']);

        assert.deepStrictEqual(store.load(), ['helprm -rf /', 'gamemode creative']);
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

suite('historySearch', () => {
    suite('searchHistory', () => {
        test('an empty query returns all entries, most-recent-first', () => {
            const history = ['help', 'gamemode creative', 'tp @s ~ ~10 ~'];
            assert.deepStrictEqual(searchHistory(history, ''), ['tp @s ~ ~10 ~', 'gamemode creative', 'help']);
        });

        test('filters case-insensitively', () => {
            const history = ['help', 'Gamemode creative', 'tp @s ~ ~10 ~'];
            assert.deepStrictEqual(searchHistory(history, 'GAME'), ['Gamemode creative']);
        });

        test('matches substrings anywhere in the entry', () => {
            const history = ['gamemode creative', 'gamemode survival'];
            assert.deepStrictEqual(searchHistory(history, 'mode'), ['gamemode survival', 'gamemode creative']);
        });

        test('deduplicates repeated entries, keeping the most recent occurrence', () => {
            const history = ['help', 'gamemode creative', 'help'];
            assert.deepStrictEqual(searchHistory(history, 'help'), ['help']);
        });

        test('returns an empty array when nothing matches', () => {
            const history = ['help', 'gamemode creative'];
            assert.deepStrictEqual(searchHistory(history, 'xyz'), []);
        });
    });

    suite('startHistorySearch', () => {
        test('starts with an empty query and the full deduplicated history', () => {
            const history = ['help', 'gamemode creative'];
            const state = startHistorySearch(history, 'current line');

            assert.strictEqual(state.query, '');
            assert.deepStrictEqual(state.items, ['gamemode creative', 'help']);
            assert.strictEqual(state.selectedIndex, 0);
            assert.strictEqual(state.originalLine, 'current line');
        });
    });

    suite('setHistorySearchQuery', () => {
        test('re-filters items and resets the selection to the first match', () => {
            const history = ['help', 'gamemode creative', 'gamemode survival'];
            let state = startHistorySearch(history, '');
            state = cycleHistorySearch(state, 1);
            assert.notStrictEqual(state.selectedIndex, 0);

            state = setHistorySearchQuery(history, state, 'gamemode');

            assert.strictEqual(state.query, 'gamemode');
            assert.deepStrictEqual(state.items, ['gamemode survival', 'gamemode creative']);
            assert.strictEqual(state.selectedIndex, 0);
        });

        test('preserves originalLine across query changes', () => {
            const history = ['help'];
            const state = setHistorySearchQuery(history, startHistorySearch(history, 'current line'), 'h');
            assert.strictEqual(state.originalLine, 'current line');
        });
    });

    suite('cycleHistorySearch', () => {
        test('cycles forward through items, wrapping around', () => {
            const history = ['a', 'b', 'c'];
            let state = startHistorySearch(history, '');
            assert.strictEqual(state.items[state.selectedIndex], 'c');

            state = cycleHistorySearch(state, 1);
            assert.strictEqual(state.items[state.selectedIndex], 'b');

            state = cycleHistorySearch(state, 1);
            assert.strictEqual(state.items[state.selectedIndex], 'a');

            state = cycleHistorySearch(state, 1);
            assert.strictEqual(state.items[state.selectedIndex], 'c');
        });

        test('cycles backward through items, wrapping around', () => {
            const history = ['a', 'b', 'c'];
            let state = startHistorySearch(history, '');
            assert.strictEqual(state.items[state.selectedIndex], 'c');

            state = cycleHistorySearch(state, -1);
            assert.strictEqual(state.items[state.selectedIndex], 'a');
        });

        test('is a no-op when there are no items', () => {
            const state = startHistorySearch([], '');
            assert.deepStrictEqual(cycleHistorySearch(state, 1), state);
        });
    });
});
