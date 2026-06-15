// src/test/displayArgumentHint.test.ts
import * as assert from 'assert';
import { formatArgumentHint } from '../displayArgumentHint';

suite('formatArgumentHint', () => {
  test('returns null when there is no usage text', () => {
    assert.strictEqual(formatArgumentHint('', '/gamemode '), null);
  });

  test('derives the command prefix from the usage string itself, with a leading slash', () => {
    const d = formatArgumentHint('gamemode <mode> [<target>]', '/gamemode ');
    assert.strictEqual(d!.commandPrefixText, '/gamemode');
    assert.deepStrictEqual(d!.tokens, ['<mode>', '[<target>]']);
  });

  test('multi-word literal prefixes (subcommands) are included in the command path', () => {
    const d = formatArgumentHint('mvp config <property> <value>', '/mvp config ');
    assert.strictEqual(d!.commandPrefixText, '/mvp config');
    assert.deepStrictEqual(d!.tokens, ['<property>', '<value>']);
  });

  test('still typing the command/subcommand: currentArgIndex is -1', () => {
    const d = formatArgumentHint('gamemode <mode> [<target>]', '/gamemo');
    assert.strictEqual(d!.currentArgIndex, -1);
  });

  test('trailing space after the command: ready for the first argument', () => {
    const d = formatArgumentHint('gamemode <mode> [<target>]', '/gamemode ');
    assert.strictEqual(d!.currentArgIndex, 0);
  });

  test('mid-way through typing the first argument: still on argument 0', () => {
    const d = formatArgumentHint('gamemode <mode> [<target>]', '/gamemode crea');
    assert.strictEqual(d!.currentArgIndex, 0);
  });

  test('trailing space after the first argument: argument 0 completed, on argument 1', () => {
    const d = formatArgumentHint('gamemode <mode> [<target>]', '/gamemode creative ');
    assert.strictEqual(d!.currentArgIndex, 1);
  });

  test('usage with no argument tokens at all: empty token list', () => {
    const d = formatArgumentHint('reload', '/reload');
    assert.deepStrictEqual(d!.tokens, []);
    assert.strictEqual(d!.commandPrefixText, '/reload');
  });

  test('past the end of the documented arguments: currentArgIndex beyond tokens', () => {
    const d = formatArgumentHint('gamemode <mode>', '/gamemode creative extra ');
    assert.strictEqual(d!.currentArgIndex, 2);
  });
});
