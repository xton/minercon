// src/test/completionBackend.test.ts
//
// LocalCompletionBackend.fetchUsage builds a usage line in the same shape
// as the server's `cmdusage` response (commandPath + argumentHelp), so
// formatArgumentHint can derive the "/command" prefix from it. Bug: in
// no-plugin mode this prefix was missing entirely (e.g. "/ [<targets>]
// [<item>]" instead of "/clear [<targets>] [<item>]"), for every command,
// because fetchUsage returned just argumentHelp with nothing prepended.

import * as assert from 'assert';
import { LocalCompletionBackend } from '../completionBackend';
import { CommandTreeCrawler } from '../commandTreeCrawler';
import { SuggestionResult } from '../commandTreeSuggestions';

function fakeCommandTree(getSuggestions: (input: string) => SuggestionResult): CommandTreeCrawler {
  return { getSuggestions } as unknown as CommandTreeCrawler;
}

suite('LocalCompletionBackend.fetchUsage', () => {
  test('prepends commandPath to argumentHelp ("clear [<targets>] [<item>]", not "[<targets>] [<item>]")', async () => {
    const backend = new LocalCompletionBackend(fakeCommandTree(() =>
      ({ suggestions: [], argumentHelp: '[<targets>] [<item>]', commandPath: 'clear' })
    ));

    assert.strictEqual(await backend.fetchUsage('/clear '), 'clear [<targets>] [<item>]');
  });

  test('preserves a namespace prefix in the usage line ("minecraft:clear [<targets>] [<item>]")', async () => {
    const backend = new LocalCompletionBackend(fakeCommandTree(() =>
      ({ suggestions: [], argumentHelp: '[<targets>] [<item>]', commandPath: 'minecraft:clear' })
    ));

    assert.strictEqual(await backend.fetchUsage('/minecraft:clear '), 'minecraft:clear [<targets>] [<item>]');
  });

  test('a command with no arguments shows just its commandPath ("reload"), not an empty string', async () => {
    const backend = new LocalCompletionBackend(fakeCommandTree(() =>
      ({ suggestions: [], argumentHelp: '', commandPath: 'reload' })
    ));

    assert.strictEqual(await backend.fetchUsage('/reload '), 'reload');
  });

  test('once a full usage is cached for a command, a later empty result keeps showing it', async () => {
    let argumentHelp = '<property> <value>';
    const backend = new LocalCompletionBackend(fakeCommandTree(() =>
      ({ suggestions: [], argumentHelp, commandPath: 'mvp modify' })
    ));

    assert.strictEqual(await backend.fetchUsage('/mvp modify '), 'mvp modify <property> <value>');

    // Simulate navigation falling off the end of the known parameters once
    // the user starts typing a free-form argument value.
    argumentHelp = '';
    assert.strictEqual(await backend.fetchUsage('/mvp modify someproperty '), 'mvp modify <property> <value>');
  });

  test('switching to a different command resets the cache', async () => {
    let response: SuggestionResult = { suggestions: [], argumentHelp: '<property> <value>', commandPath: 'mvp modify' };
    const backend = new LocalCompletionBackend(fakeCommandTree(() => response));

    assert.strictEqual(await backend.fetchUsage('/mvp modify '), 'mvp modify <property> <value>');

    response = { suggestions: [], argumentHelp: '[<targets>] [<item>]', commandPath: 'clear' };
    assert.strictEqual(await backend.fetchUsage('/clear '), 'clear [<targets>] [<item>]');
  });

  test('returns empty string when there is nothing to show yet (still typing the command name)', async () => {
    const backend = new LocalCompletionBackend(fakeCommandTree(() =>
      ({ suggestions: ['clear', 'clone'], argumentHelp: undefined, commandPath: undefined })
    ));

    assert.strictEqual(await backend.fetchUsage('/cl'), '');
  });

  test('navigating into a subcommand updates the usage to the more specific path', async () => {
    // Bug regression: the first usage seen for a root command ("mv") was cached
    // and returned for all deeper paths ("mv worldborder"), because the cache key
    // was the root command name rather than the full commandPath.
    let response: SuggestionResult = {
      suggestions: [],
      argumentHelp: '(worldborder|generators|gamerule)',
      commandPath: 'mv',
    };
    const backend = new LocalCompletionBackend(fakeCommandTree(() => response));

    assert.strictEqual(await backend.fetchUsage('/mv '), 'mv (worldborder|generators|gamerule)');

    // User navigates into the "worldborder" subcommand — getSuggestions now
    // returns a more specific commandPath and argumentHelp.
    response = {
      suggestions: [],
      argumentHelp: 'damage buffer <distance> [world]',
      commandPath: 'mv worldborder',
    };
    assert.strictEqual(await backend.fetchUsage('/mv worldborder '), 'mv worldborder damage buffer <distance> [world]');
  });

  test('anti-flicker: usage stays stable when the same commandPath yields no argumentHelp (free-form arg)', async () => {
    // Once a specific subcommand path has been resolved, the hint must keep
    // showing even while the user is typing a free-form argument whose value
    // isn't in the tree (argumentHelp becomes '' or undefined).
    let response: SuggestionResult = {
      suggestions: [],
      argumentHelp: 'damage buffer <distance> [world]',
      commandPath: 'mv worldborder',
    };
    const backend = new LocalCompletionBackend(fakeCommandTree(() => response));

    assert.strictEqual(await backend.fetchUsage('/mv worldborder '), 'mv worldborder damage buffer <distance> [world]');

    response = { suggestions: [], argumentHelp: '', commandPath: 'mv worldborder' };
    assert.strictEqual(await backend.fetchUsage('/mv worldborder damage buffer '), 'mv worldborder damage buffer <distance> [world]');
  });
});
