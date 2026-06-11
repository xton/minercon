import * as assert from 'assert';
import { searchHistory, startHistorySearch, setHistorySearchQuery, cycleHistorySearch } from '../historySearch';

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
