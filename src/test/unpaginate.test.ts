// src/test/unpaginate.test.ts
//
// Tests for the pure client-side de-pagination helpers: the command wrapper and
// the `rcat` capability-probe parser.

import * as assert from 'assert';
import { wrapForUnpagination, responseSupportsRcat, RCAT_PROBE_MARKER } from '../unpaginate';

suite('wrapForUnpagination', () => {
  test('wraps with rcat when supported', () => {
    assert.strictEqual(wrapForUnpagination('help', true), 'rcat help');
  });

  test('preserves arguments', () => {
    assert.strictEqual(wrapForUnpagination('help gamemode', true), 'rcat help gamemode');
  });

  test('passes through unchanged when not supported', () => {
    assert.strictEqual(wrapForUnpagination('help', false), 'help');
  });

  test('never wraps empty or whitespace-only input', () => {
    assert.strictEqual(wrapForUnpagination('', true), '');
    assert.strictEqual(wrapForUnpagination('   ', true), '   ');
  });
});

suite('responseSupportsRcat', () => {
  test('true when the probe marker is present', () => {
    assert.ok(responseSupportsRcat(`${RCAT_PROBE_MARKER}\nUsage: /rcat <command...>`));
  });

  test('false for an unrelated / unknown-command response', () => {
    assert.ok(!responseSupportsRcat('Unknown command. Type "/help" for help.'));
  });

  test('false for undefined/empty', () => {
    assert.ok(!responseSupportsRcat(undefined));
    assert.ok(!responseSupportsRcat(''));
  });
});
