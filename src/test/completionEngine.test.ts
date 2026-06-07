// src/test/completionEngine.test.ts
import * as assert from 'assert';
import {
  buildCompletionsQuery, buildUsageQuery, parseCompletionsResponse, parseUsageResponse,
  createMachine, step, Machine, Effect, Event,
} from '../completionEngine';

// ─── helpers for driving the reducer through a scripted sequence ───

function run(machine: Machine, events: Event[]): { machine: Machine; effects: Effect[][] } {
  const effects: Effect[][] = [];
  for (const e of events) {
    const result = step(machine, e);
    machine = result.machine;
    effects.push(result.effects);
  }
  return { machine, effects };
}

function kinds(effects: Effect[]): string[] {
  return effects.map(e => e.kind);
}

function find<K extends Effect['kind']>(effects: Effect[], kind: K): Extract<Effect, { kind: K }> | undefined {
  return effects.find(e => e.kind === kind) as any;
}

// ───────────────────────────── pure helpers ─────────────────────────────

suite('completionEngine: query builders', () => {
  const cases: [string, string | null][] = [
    ['', null],
    ['gamemode', null],                  // no leading slash
    ['/', '-'],                          // bare slash → root completions
    ['/   ', '-'],                       // whitespace-only → still root completions
    ['/gamemode', 'gamemode'],
    ['/gamemode ', 'gamemode -'],        // trailing space → "-" marker
    ['/gamemode sur', 'gamemode sur'],
    ['/gamemode  survival', 'gamemode survival'],   // collapses internal whitespace, like Brigadier does
  ];

  for (const [input, expected] of cases) {
    test(`buildCompletionsQuery(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(buildCompletionsQuery(input), expected);
    });
  }

  const usageCases: [string, string | null][] = [
    ['', null],
    ['gamemode', null],
    ['/', null],            // nothing typed yet — no point asking for usage
    ['/   ', null],
    ['/gamemode', 'gamemode'],
    ['/gamemode sur', 'gamemode sur'],
  ];

  for (const [input, expected] of usageCases) {
    test(`buildUsageQuery(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(buildUsageQuery(input), expected);
    });
  }
});

suite('completionEngine: response parsing', () => {
  test('parseCompletionsResponse splits, trims and drops blanks', () => {
    assert.deepStrictEqual(parseCompletionsResponse('survival\ncreative\n'), ['survival', 'creative']);
    assert.deepStrictEqual(parseCompletionsResponse('  a  \n\n b '), ['a', 'b']);
  });

  test('parseCompletionsResponse treats "(" messages and empty/undefined as no completions', () => {
    assert.deepStrictEqual(parseCompletionsResponse('(no completions)'), []);
    assert.deepStrictEqual(parseCompletionsResponse(''), []);
    assert.deepStrictEqual(parseCompletionsResponse(undefined), []);
  });

  test('parseUsageResponse trims real text, blanks out "(" messages', () => {
    assert.strictEqual(parseUsageResponse('  /gamemode <mode> [<target>]  '), '/gamemode <mode> [<target>]');
    assert.strictEqual(parseUsageResponse('(no command found — provide a more specific input)'), '');
    assert.strictEqual(parseUsageResponse(undefined), '');
  });
});

// ───────────────────────────── the state machine ─────────────────────────────

suite('completionEngine: typing flow', () => {
  test('typing a command issues exactly one fetch and opens with results', () => {
    let m = createMachine();
    let r = step(m, { kind: 'lineChanged', line: '/gamemode ' });
    m = r.machine;
    assert.deepStrictEqual(kinds(r.effects), ['fetchCompletions']);
    const fetchEffect = find(r.effects, 'fetchCompletions')!;
    assert.strictEqual(fetchEffect.query, 'gamemode -');

    r = step(m, { kind: 'completionsResult', requestId: fetchEffect.requestId, items: ['survival', 'creative'], now: 1000 });
    m = r.machine;
    assert.strictEqual(m.phase.kind, 'open');
    if (m.phase.kind === 'open') {
      assert.deepStrictEqual(m.phase.items, ['survival', 'creative']);
      assert.strictEqual(m.phase.selectedIndex, 0);
      assert.strictEqual(m.phase.mode.kind, 'preview');     // not applied to the line — just previewed
      assert.strictEqual(m.phase.usage.kind, 'none');       // usage isn't fetched while just typing
    }
    const render = find(r.effects, 'render')!;
    assert.deepStrictEqual(render.items, ['survival', 'creative']);
    assert.strictEqual(render.usage, null);
  });

  test('empty completions response closes the list', () => {
    let m = createMachine();
    let r = step(m, { kind: 'lineChanged', line: '/bogus' });
    m = r.machine;
    const fetchId = find(r.effects, 'fetchCompletions')!.requestId;

    r = step(m, { kind: 'completionsResult', requestId: fetchId, items: [], now: 1000 });
    m = r.machine;
    assert.strictEqual(m.phase.kind, 'closed');
    assert.deepStrictEqual(kinds(r.effects), ['hide']);
  });

  test('moving off a command line closes and hides without ever fetching', () => {
    let m = createMachine();
    let r = step(m, { kind: 'lineChanged', line: 'not a command' });
    assert.strictEqual(r.machine.phase.kind, 'closed');
    assert.deepStrictEqual(kinds(r.effects), []);   // was already closed/idle — no spurious hide

    // Open it first, then close it
    m = step(m, { kind: 'lineChanged', line: '/gamemode' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival'], now: 1 }).machine;
    assert.strictEqual(m.phase.kind, 'open');

    r = step(m, { kind: 'lineChanged', line: '' });
    assert.strictEqual(r.machine.phase.kind, 'closed');
    assert.deepStrictEqual(kinds(r.effects), ['hide']);
  });

  test('preserves the selected index across re-fetches while typing, if still in range', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    let fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative', 'adventure'], now: 1 }).machine;

    // user arrows down to "creative"
    m = step(m, { kind: 'arrow', direction: 'down' }).machine;
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.selectedIndex : -1, 1);

    // keeps typing — triggers a re-fetch
    m = step(m, { kind: 'lineChanged', line: '/gamemode c' }).machine;
    fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['creative'], now: 2 }).machine;

    // index 1 is now out of range for a 1-item list — falls back to 0
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.selectedIndex : -1, 0);
  });
});

suite('completionEngine: serialized fetching (no concurrent RCON sends)', () => {
  test('typing while a fetch is in flight queues the newest line instead of issuing a second request', () => {
    let m = createMachine();
    let r = step(m, { kind: 'lineChanged', line: '/gamemode' });
    m = r.machine;
    const firstFetchId = find(r.effects, 'fetchCompletions')!.requestId;
    assert.strictEqual(m.fetch.kind, 'busy');

    // two more keystrokes arrive before the server responds
    r = step(m, { kind: 'lineChanged', line: '/gamemode ' });
    assert.deepStrictEqual(r.effects, []);    // no second fetch effect emitted
    m = r.machine;
    r = step(m, { kind: 'lineChanged', line: '/gamemode s' });
    assert.deepStrictEqual(r.effects, []);
    m = r.machine;
    assert.deepStrictEqual(m.fetch.kind === 'busy' ? m.fetch.queued : null, { line: '/gamemode s', reason: 'typing' });

    // the original (now-stale) response arrives — discarded, and the queued line is fetched instead
    r = step(m, { kind: 'completionsResult', requestId: firstFetchId, items: ['(should be discarded)'], now: 1 });
    m = r.machine;
    assert.strictEqual(kinds(r.effects).length, 1);
    const requeried = find(r.effects, 'fetchCompletions')!;
    assert.strictEqual(requeried.query, 'gamemode s');
    assert.notStrictEqual(requeried.requestId, firstFetchId);
  });

  test('a stale response with a mismatched requestId is ignored entirely', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode' }).machine;
    const before = m;

    const r = step(m, { kind: 'completionsResult', requestId: 99999, items: ['ignored'], now: 1 });
    assert.deepStrictEqual(r.effects, []);
    assert.deepStrictEqual(r.machine, before);
  });
});

suite('completionEngine: Tab / Shift-Tab', () => {
  function openWithItems(items: string[]): Machine {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    return step(m, { kind: 'completionsResult', requestId: fetchId, items, now: 1 }).machine;
  }

  test('Tab reuses already-fetched suggestions for the current line — no extra round trip', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    assert.strictEqual(m.fetch.kind, 'idle');

    const r = step(m, { kind: 'tab', line: '/gamemode ', now: 1000 });
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'fetchUsage', 'render']);
    assert.strictEqual(find(r.effects, 'fetchCompletions'), undefined);   // <-- the bug we found: must not re-query
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'survival');
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.mode.kind : '', 'cycling');
  });

  test('Tab keeps an arrow-key selection instead of resetting to the first item', () => {
    let m = openWithItems(['survival', 'creative', 'adventure']);
    m = step(m, { kind: 'arrow', direction: 'down' }).machine;   // select "creative" (index 1)
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.selectedIndex : -1, 1);

    const r = step(m, { kind: 'tab', line: '/gamemode ', now: 1000 });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'creative');
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.selectedIndex : -1, 1);
  });

  test('Tab on a fresh line fetches, applies the first suggestion immediately, and fetches usage afterward without blocking', () => {
    let m = createMachine();
    let r = step(m, { kind: 'tab', line: '/gamemode ', now: 1000 });
    m = r.machine;
    const completionsFetch = find(r.effects, 'fetchCompletions')!;
    assert.strictEqual(completionsFetch.query, 'gamemode -');
    assert.strictEqual(find(r.effects, 'applySuggestion'), undefined);   // nothing to apply yet — still waiting on the server

    r = step(m, { kind: 'completionsResult', requestId: completionsFetch.requestId, items: ['survival', 'creative'], now: 1500 });
    m = r.machine;
    // Applied right away — usage fetch is a trailing effect, not a gate
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'fetchUsage', 'render']);
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'survival');
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.mode.kind : '', 'cycling');

    const usageFetch = find(r.effects, 'fetchUsage')!;
    r = step(m, { kind: 'usageResult', requestId: usageFetch.requestId, text: '/gamemode <mode> [<target>]' });
    const render = find(r.effects, 'render')!;
    assert.strictEqual(render.usage, '/gamemode <mode> [<target>]');
  });

  test('quick re-press while cycling just advances; a slow re-press re-derives from the current line', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    let r = step(m, { kind: 'tab', line: '/gamemode ', now: 1000 });           // → cycling, index 0 ("survival")
    let cur = r.machine;
    const usageFetchId = find(r.effects, 'fetchUsage')!.requestId;
    // resolve the background usage fetch so the wire is free for what follows
    cur = step(cur, { kind: 'usageResult', requestId: usageFetchId, text: '/gamemode <mode>' }).machine;

    r = step(cur, { kind: 'tab', line: '/gamemode survival', now: 1100 });     // 100ms later: quick re-press, advance
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'render']);
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'creative');
    cur = r.machine;

    // 800ms after that advance — too slow to be "cycling"; treated as a fresh line and re-derives
    r = step(cur, { kind: 'tab', line: '/gamemode creative', now: 1900 });
    assert.deepStrictEqual(kinds(r.effects), ['fetchCompletions']);
    assert.strictEqual(find(r.effects, 'fetchCompletions')!.query, 'gamemode creative');
  });

  test('a re-derive request that arrives while the wire is busy is queued, not dropped, and fires once it frees up', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    // Tab applies "survival" immediately and kicks off a background usage fetch —
    // the wire is now busy with something the user didn't directly ask to wait on.
    let r = step(m, { kind: 'tab', line: '/gamemode ', now: 1000 });
    let cur = r.machine;
    const usageFetch = find(r.effects, 'fetchUsage')!;
    assert.strictEqual(cur.fetch.kind, 'busy');

    // 800ms later (past the cycling window) the user has typed past the cached
    // items and presses Tab again wanting fresh completions for the new line —
    // but the wire is still tied up with that usage fetch.
    r = step(cur, { kind: 'tab', line: '/gamemode creative ', now: 1800 });
    assert.deepStrictEqual(r.effects, [], 'must not be dropped silently nor issue a second concurrent fetch');
    cur = r.machine;
    assert.deepStrictEqual(cur.fetch.kind === 'busy' ? cur.fetch.queued : null, { line: '/gamemode creative ', reason: 'tab' });

    // once the usage reply lands, the queued Tab request fires immediately
    r = step(cur, { kind: 'usageResult', requestId: usageFetch.requestId, text: '(discarded — superseded)' });
    assert.deepStrictEqual(kinds(r.effects), ['fetchCompletions']);
    const requeried = find(r.effects, 'fetchCompletions')!;
    assert.strictEqual(requeried.query, 'gamemode creative -');
  });

  test('Shift-Tab on a freshly-opened list steps backward from the current selection (wrapping to the end)', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    const r = step(m, { kind: 'shiftTab', line: '/gamemode ', now: 1000 });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'adventure');  // wrapped from index 0 to length-1
  });

  test('a second Tab press while a fetch is already in flight is queued (not a second concurrent request) and fires on resolution', () => {
    let m = createMachine();
    let r = step(m, { kind: 'tab', line: '/gamemode', now: 1000 });
    m = r.machine;
    const firstId = find(r.effects, 'fetchCompletions')!.requestId;
    assert.strictEqual(m.fetch.kind, 'busy');

    r = step(m, { kind: 'tab', line: '/gamemode s', now: 1050 });
    assert.deepStrictEqual(r.effects, [], 'no second concurrent fetchCompletions effect');
    m = r.machine;
    assert.strictEqual(m.fetch.kind === 'busy' ? m.fetch.requestId : -1, firstId);   // original request untouched
    assert.deepStrictEqual(m.fetch.kind === 'busy' ? m.fetch.queued : null, { line: '/gamemode s', reason: 'tab' });

    r = step(m, { kind: 'completionsResult', requestId: firstId, items: ['(stale — discarded)'], now: 1100 });
    assert.deepStrictEqual(kinds(r.effects), ['fetchCompletions']);
    assert.strictEqual(find(r.effects, 'fetchCompletions')!.query, 'gamemode s');
  });
});

suite('completionEngine: usage staleness', () => {
  test('a usage result for a query the user has moved on from is discarded', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    let fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative'], now: 1 }).machine;

    let r = step(m, { kind: 'tab', line: '/gamemode ', now: 100 });
    m = r.machine;
    const usageFetchId = find(r.effects, 'fetchUsage')!.requestId;

    // user keeps typing before the usage reply comes back
    r = step(m, { kind: 'lineChanged', line: '/gamemode survival ' });
    m = r.machine;

    // stale usage reply for the old query arrives — must not be rendered
    r = step(m, { kind: 'usageResult', requestId: usageFetchId, text: '/gamemode <mode>' });
    const render = find(r.effects, 'render');
    assert.ok(!render || render.usage === null, 'stale usage must never reach the display');
  });
});

suite('completionEngine: arrow keys and escape', () => {
  function openCycling(items: string[]): Machine {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items, now: 1 }).machine;
    return step(m, { kind: 'tab', line: '/gamemode ', now: 1000 }).machine;
  }

  test('arrow keys browse without entering cycling mode, and wrap at both ends', () => {
    let m = openWithItems3();
    m = step(m, { kind: 'arrow', direction: 'up' }).machine;     // wraps from 0 to last
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.selectedIndex : -1, 2);
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.mode.kind : '', 'preview');

    m = step(m, { kind: 'arrow', direction: 'down' }).machine;   // wraps from last (2) back to 0
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.selectedIndex : -1, 0);

    function openWithItems3(): Machine {
      let mm = createMachine();
      mm = step(mm, { kind: 'lineChanged', line: '/gamemode ' }).machine;
      const fetchId = (mm.fetch.kind === 'busy') ? mm.fetch.requestId : -1;
      return step(mm, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative', 'adventure'], now: 1 }).machine;
    }
  });

  test('selectIndex jumps directly to an index (used by Home/End/PageUp/PageDown) without entering cycling mode', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative', 'adventure'], now: 1 }).machine;

    let r = step(m, { kind: 'selectIndex', index: 2 });
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.selectedIndex : -1, 2);
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.mode.kind : '', 'preview');
    assert.deepStrictEqual(kinds(r.effects), ['render']);

    // out-of-range indices are ignored — the shell can't desync the machine this way
    r = step(r.machine, { kind: 'selectIndex', index: 99 });
    assert.deepStrictEqual(r.effects, []);
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.selectedIndex : -1, 2);
  });

  test('escape while cycling restores the pre-completion line and hides', () => {
    const m = openCycling(['survival', 'creative']);
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.mode.kind : '', 'cycling');

    const r = step(m, { kind: 'escape' });
    assert.deepStrictEqual(kinds(r.effects), ['restoreLine', 'hide']);
    assert.strictEqual(find(r.effects, 'restoreLine')!.text, '/gamemode ');
    assert.strictEqual(r.machine.phase.kind, 'closed');
  });

  test('escape while only previewing (nothing applied yet) just hides — nothing to restore', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival'], now: 1 }).machine;

    const r = step(m, { kind: 'escape' });
    assert.deepStrictEqual(kinds(r.effects), ['hide']);
  });
});
