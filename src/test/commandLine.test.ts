import * as assert from 'assert';
import { splitCommandLine } from '../commandLine';

suite('splitCommandLine', () => {
    test('splits a slash command into words, dropping the leading slash', () => {
        assert.deepStrictEqual(splitCommandLine('/gamemode creative'), {
            parts: ['gamemode', 'creative'],
            hasTrailingSpace: false,
        });
    });

    test('a trailing space is reported separately from the words', () => {
        assert.deepStrictEqual(splitCommandLine('/gamemode '), {
            parts: ['gamemode'],
            hasTrailingSpace: true,
        });
    });

    test('a bare slash has no words', () => {
        assert.deepStrictEqual(splitCommandLine('/'), { parts: [], hasTrailingSpace: false });
        assert.deepStrictEqual(splitCommandLine('/ '), { parts: [], hasTrailingSpace: true });
    });

    test('runs of whitespace collapse and empties are dropped', () => {
        assert.deepStrictEqual(splitCommandLine('/give   @p  stone').parts, ['give', '@p', 'stone']);
    });

    test('only a single leading slash is stripped; input need not start with one', () => {
        assert.deepStrictEqual(splitCommandLine('gamemode creative').parts, ['gamemode', 'creative']);
        // A second slash is part of the word (e.g. a namespaced path), not stripped.
        assert.deepStrictEqual(splitCommandLine('//foo').parts, ['/foo']);
    });

    test('selectors, NBT, and coordinates pass through as whole words (no grammar tokenization)', () => {
        assert.deepStrictEqual(
            splitCommandLine('/execute as @e[type=cow] run say {text:"hi there"}').parts,
            ['execute', 'as', '@e[type=cow]', 'run', 'say', '{text:"hi', 'there"}']
        );
        // A half-typed bracket is just text - no depth tracking to throw off.
        assert.deepStrictEqual(splitCommandLine('/give @p stone[').parts, ['give', '@p', 'stone[']);
    });

    test('empty input', () => {
        assert.deepStrictEqual(splitCommandLine(''), { parts: [], hasTrailingSpace: false });
    });
});
