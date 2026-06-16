// src/test/completionEngine.test.ts
import * as assert from 'assert';
import {
  buildCompletionsQuery, buildUsageQuery, parseCompletionsResponse, parseUsageResponse,
  applySuggestion, longestCommonPrefix,
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

suite('completionEngine: applySuggestion (splicing a candidate into the typed line)', () => {
  const cases: [string, string, string, string][] = [
    [
      'replaces a partial first-word command name (overlap across the leading "/")',
      '/gam', 'gamemode', '/gamemode'
    ],
    [
      'replaces a partial argument word mid-line',
      '/gamemode adv', 'adventure', '/gamemode adventure'
    ],
    [
      'no overlap across a trailing space — appends as a new word',
      '/gamemode adventure ', '@a', '/gamemode adventure @a'
    ],
    [
      'no overlap with a complete token — appends a refinement onto it ("@a" + "[")',
      '/gamemode adventure @a', '[', '/gamemode adventure @a['
    ],
    [
      'overlap on a sub-token nested inside selector syntax — replaces only "dist", not "@a[dist"',
      '/gamemode adventure @a[dist', 'distance=', '/gamemode adventure @a[distance='
    ],
    [
      'longest matching overlap wins over a shorter one ("dist" over the trailing "t")',
      '/effect give @a minecraft:regen', 'regeneration', '/effect give @a minecraft:regeneration'
    ],
    [
      'candidate shorter than and unrelated to what was typed — appends',
      '/gamemode survival @a', 'x', '/gamemode survival @ax'
    ],
  ];

  for (const [description, line, suggestion, expected] of cases) {
    test(`${description}: applySuggestion(${JSON.stringify(line)}, ${JSON.stringify(suggestion)}) === ${JSON.stringify(expected)}`, () => {
      assert.strictEqual(applySuggestion(line, suggestion), expected);
    });
  }
});

suite('completionEngine: longestCommonPrefix', () => {
  test('shared prefix across multiple items', () => {
    assert.strictEqual(longestCommonPrefix(['minecraft:diamond_sword', 'minecraft:diamond_pickaxe']), 'minecraft:diamond_');
  });

  test('one item is a prefix of the other', () => {
    assert.strictEqual(longestCommonPrefix(['survival', 'survivalists']), 'survival');
  });

  test('no shared prefix at all', () => {
    assert.strictEqual(longestCommonPrefix(['survival', 'creative']), '');
  });

  test('a single item is its own common prefix', () => {
    assert.strictEqual(longestCommonPrefix(['survival']), 'survival');
  });

  test('empty list', () => {
    assert.strictEqual(longestCommonPrefix([]), '');
  });
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

  test('parseUsageResponse strips embedded Minecraft color codes', () => {
    assert.strictEqual(
      parseUsageResponse('§b§bmvp create§b §a <portal-name> [destination]'),
      'mvp create  <portal-name> [destination]'
    );
    assert.strictEqual(parseUsageResponse('§4/kill §c<target>'), '/kill <target>');
  });

  test('parseUsageResponse: an ambiguous prefix yields one usage line per candidate — not yet resolved, so no usage to show', () => {
    assert.strictEqual(
      parseUsageResponse(
        'mvp create <portal-name> [destination] - Creates a new portal.\n' +
        'mvp config <property> [value] - Allows you to set Global MV Portals Variables.'
      ),
      ''
    );
  });

  test('parseUsageResponse: a resolved single-match response (with trailing description) yields that one usage line', () => {
    assert.strictEqual(
      parseUsageResponse('mvp create <portal-name> [destination] - Creates a new portal, assuming you have a region selected.'),
      'mvp create <portal-name> [destination] - Creates a new portal, assuming you have a region selected.'
    );
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

    r = step(m, { kind: 'completionsResult', requestId: fetchEffect.requestId, items: ['survival', 'creative'] });
    m = r.machine;
    assert.strictEqual(m.phase.kind, 'open');
    if (m.phase.kind === 'open') {
      assert.deepStrictEqual(m.phase.items, ['survival', 'creative']);
      assert.strictEqual(m.phase.selectedIndex, 0);
      assert.strictEqual(m.phase.mode.kind, 'preview');     // not applied to the line — just previewed
      // The line ends with a space — a natural pause point — so the engine
      // also kicks off a usage fetch in the background, to show alongside
      // the list once/if it resolves to a single command.
      assert.strictEqual(m.phase.usage.kind, 'loading');
    }
    assert.deepStrictEqual(kinds(r.effects), ['fetchUsage', 'render']);
    const render = find(r.effects, 'render')!;
    assert.deepStrictEqual(render.items, ['survival', 'creative']);
    assert.strictEqual(render.usage, null);               // usage not back yet
  });

  test('empty completions with nothing to show usage for closes the list', () => {
    let m = createMachine();
    let r = step(m, { kind: 'lineChanged', line: '/' });
    m = r.machine;
    const fetchId = find(r.effects, 'fetchCompletions')!.requestId;

    r = step(m, { kind: 'completionsResult', requestId: fetchId, items: [] });
    m = r.machine;
    assert.strictEqual(m.phase.kind, 'closed');
    assert.deepStrictEqual(kinds(r.effects), ['hide']);
  });

  test('empty completions but a usage line to show opens a hint-only display instead of closing', () => {
    let m = createMachine();
    let r = step(m, { kind: 'lineChanged', line: '/gamemode creative ' });
    m = r.machine;
    const fetchId = find(r.effects, 'fetchCompletions')!.requestId;

    r = step(m, { kind: 'completionsResult', requestId: fetchId, items: [] });
    m = r.machine;
    assert.strictEqual(m.phase.kind, 'open');
    if (m.phase.kind === 'open') {
      assert.deepStrictEqual(m.phase.items, []);
      assert.strictEqual(m.phase.usage.kind, 'loading');
    }
    assert.deepStrictEqual(kinds(r.effects), ['fetchUsage', 'render']);
    const usageFetch = find(r.effects, 'fetchUsage')!;
    assert.strictEqual(usageFetch.query, 'gamemode creative');
    const render = find(r.effects, 'render')!;
    assert.deepStrictEqual(render.items, []);
    assert.strictEqual(render.usage, null);     // not loaded yet

    // usage arrives — re-renders with the hint text, list still empty
    r = step(m, { kind: 'usageResult', requestId: usageFetch.requestId, text: 'gamemode <mode> [<target>]' });
    m = r.machine;
    if (m.phase.kind === 'open') {
      assert.strictEqual(m.phase.usage.kind, 'ready');
    }
    const render2 = find(r.effects, 'render')!;
    assert.deepStrictEqual(render2.items, []);
    assert.strictEqual(render2.usage, 'gamemode <mode> [<target>]');
  });

  test('Tab on a line with no completions and no prior list does nothing (no hint phase from Tab)', () => {
    let m = createMachine();
    let r = step(m, { kind: 'tab', line: '/gamemode creative ' });
    m = r.machine;
    const fetchId = find(r.effects, 'fetchCompletions')!.requestId;

    r = step(m, { kind: 'completionsResult', requestId: fetchId, items: [] });
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
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival'] }).machine;
    assert.strictEqual(m.phase.kind, 'open');

    r = step(m, { kind: 'lineChanged', line: '' });
    assert.strictEqual(r.machine.phase.kind, 'closed');
    assert.deepStrictEqual(kinds(r.effects), ['hide']);
  });

  test('preserves the selected index across re-fetches while typing, if still in range', () => {
    let m = createMachine();
    // No trailing space — keeps this test focused on selection-index
    // preservation rather than the "natural pause point" usage fetch that a
    // trailing space would also trigger (covered separately).
    m = step(m, { kind: 'lineChanged', line: '/gamemode' }).machine;
    let fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative', 'adventure'] }).machine;

    // user arrows down to "creative"
    m = step(m, { kind: 'arrow', direction: 'down' }).machine;
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.selectedIndex : -1, 1);

    // keeps typing — triggers a re-fetch
    m = step(m, { kind: 'lineChanged', line: '/gamemode c' }).machine;
    fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['creative'] }).machine;

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
    r = step(m, { kind: 'completionsResult', requestId: firstFetchId, items: ['(should be discarded)'] });
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

    const r = step(m, { kind: 'completionsResult', requestId: 99999, items: ['ignored'] });
    assert.deepStrictEqual(r.effects, []);
    assert.deepStrictEqual(r.machine, before);
  });
});

/** Opens the suggestion list for "/gamemode " with the given items, as if fetched live while typing. */
function openWithItems(items: string[]): Machine {
  let m = createMachine();
  m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
  const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
  m = step(m, { kind: 'completionsResult', requestId: fetchId, items }).machine;

  // The trailing space is a "natural pause point" — the engine now also
  // kicks off a background usage fetch right away. Resolve it (empty —
  // "gamemode" alone isn't a fully resolved usage) so the returned machine
  // is idle, the way these Tab-focused tests expect; usage behavior itself
  // is covered by the usage-staleness and rendering-flow tests.
  if (m.fetch.kind === 'busy' && m.fetch.purpose.kind === 'usage') {
    m = step(m, { kind: 'usageResult', requestId: m.fetch.requestId, text: '' }).machine;
  }
  return m;
}

suite('completionEngine: Tab / Shift-Tab', () => {
  test('Tab reuses already-fetched suggestions for the current line — no extra round trip', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    assert.strictEqual(m.fetch.kind, 'idle');

    const r = step(m, { kind: 'tab', line: '/gamemode ' });
    // Usage for "/gamemode " was already fetched at the pause point when the
    // list opened (see openWithItems) — Tab reuses that too, so neither a
    // completions re-query nor a fresh usage fetch should appear here.
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'render']);
    assert.strictEqual(find(r.effects, 'fetchCompletions'), undefined);   // <-- the bug we found: must not re-query
    assert.strictEqual(find(r.effects, 'fetchUsage'), undefined);          // <-- nor re-fetch usage for a known line
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'survival');
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.mode.kind : '', 'cycling');
  });

  test('Tab keeps an arrow-key selection instead of resetting to the first item', () => {
    let m = openWithItems(['survival', 'creative', 'adventure']);
    m = step(m, { kind: 'arrow', direction: 'down' }).machine;   // select "creative" (index 1)
    assert.strictEqual(m.phase.kind === 'open' ? m.phase.selectedIndex : -1, 1);

    const r = step(m, { kind: 'tab', line: '/gamemode ' });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'creative');
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.selectedIndex : -1, 1);
  });

  test('Tab on a fresh line fetches, applies the first suggestion immediately, and fetches usage afterward without blocking', () => {
    let m = createMachine();
    let r = step(m, { kind: 'tab', line: '/gamemode ' });
    m = r.machine;
    const completionsFetch = find(r.effects, 'fetchCompletions')!;
    assert.strictEqual(completionsFetch.query, 'gamemode -');
    assert.strictEqual(find(r.effects, 'applySuggestion'), undefined);   // nothing to apply yet — still waiting on the server

    r = step(m, { kind: 'completionsResult', requestId: completionsFetch.requestId, items: ['survival', 'creative'] });
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

  test('repeated Tab presses cycle through the items, with no dependency on elapsed time', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    let r = step(m, { kind: 'tab', line: '/gamemode ' });           // → cycling, index 0 ("survival")
    let cur = r.machine;
    // Usage for "/gamemode " was already fetched at the pause point when the
    // list opened (see openWithItems) — Tab reuses it, so the wire is
    // already free for what follows; nothing to resolve here.
    assert.strictEqual(cur.fetch.kind, 'idle');

    r = step(cur, { kind: 'tab', line: '/gamemode survival' });     // re-press, nothing typed since: advance
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'render']);
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'creative');
    cur = r.machine;

    // however long this takes, nothing was typed since "creative" was applied
    // — still advances rather than re-deriving
    r = step(cur, { kind: 'tab', line: '/gamemode creative' });
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'render']);
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'adventure');
  });

  test('a Tab press whose line no longer matches the last-applied suggestion re-derives, even immediately', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    const r = step(m, { kind: 'tab', line: '/gamemode ' });         // → cycling, index 0 ("survival")
    const cur = r.machine;
    assert.strictEqual(cur.fetch.kind, 'idle');

    // the user edited the line instead of pressing Tab again — even though no
    // time has passed, the line no longer matches "/gamemode survival", so
    // this re-derives for the new line rather than cycling
    const r2 = step(cur, { kind: 'tab', line: '/gamemode survival ' });
    assert.deepStrictEqual(kinds(r2.effects), ['fetchCompletions']);
    assert.strictEqual(find(r2.effects, 'fetchCompletions')!.query, 'gamemode survival -');
  });

  test('a re-derive request that arrives while the wire is busy is queued, not dropped, and fires once it frees up', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;

    // The trailing space is a "natural pause point" — completions coming back
    // also kicks off a background usage fetch right away, leaving the wire
    // busy with something the user didn't directly ask to wait on.
    let r = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative', 'adventure'] });
    let cur = r.machine;
    const usageFetch = find(r.effects, 'fetchUsage')!;
    assert.strictEqual(cur.fetch.kind, 'busy');

    // The user has typed past the cached items and presses Tab wanting fresh
    // completions for the new line — but the wire is still tied up with that
    // usage fetch.
    r = step(cur, { kind: 'tab', line: '/gamemode creative ' });
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
    const r = step(m, { kind: 'shiftTab', line: '/gamemode ' });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'adventure');  // wrapped from index 0 to length-1
  });

  test('a second Tab press while a fetch is already in flight is queued (not a second concurrent request) and fires on resolution', () => {
    let m = createMachine();
    let r = step(m, { kind: 'tab', line: '/gamemode' });
    m = r.machine;
    const firstId = find(r.effects, 'fetchCompletions')!.requestId;
    assert.strictEqual(m.fetch.kind, 'busy');

    r = step(m, { kind: 'tab', line: '/gamemode s' });
    assert.deepStrictEqual(r.effects, [], 'no second concurrent fetchCompletions effect');
    m = r.machine;
    assert.strictEqual(m.fetch.kind === 'busy' ? m.fetch.requestId : -1, firstId);   // original request untouched
    assert.deepStrictEqual(m.fetch.kind === 'busy' ? m.fetch.queued : null, { line: '/gamemode s', reason: 'tab' });

    r = step(m, { kind: 'completionsResult', requestId: firstId, items: ['(stale — discarded)'] });
    assert.deepStrictEqual(kinds(r.effects), ['fetchCompletions']);
    assert.strictEqual(find(r.effects, 'fetchCompletions')!.query, 'gamemode s');
  });
});

suite('completionEngine: Tab common-prefix completion', () => {
  test('items already on hand: first Tab completes to their shared prefix; a follow-up Tab then cycles 1st, 2nd, ...', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/give @a minecraft:diamond' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, {
      kind: 'completionsResult', requestId: fetchId,
      items: ['minecraft:diamond_sword', 'minecraft:diamond_pickaxe'],
    }).machine;
    assert.strictEqual(m.fetch.kind, 'idle');

    // First Tab: complete to the shared "minecraft:diamond_" prefix, nothing
    // committed to a specific item yet.
    let r = step(m, { kind: 'tab', line: '/give @a minecraft:diamond' });
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'render']);
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'minecraft:diamond_');
    let phase = r.machine.phase;
    assert.strictEqual(phase.kind === 'open' ? phase.mode.kind : '', 'preview');
    assert.strictEqual(phase.kind === 'open' ? phase.query : '', '/give @a minecraft:diamond_');

    // Second Tab: nothing left to gain from the prefix — falls through to
    // cycling, applying the first full suggestion.
    r = step(r.machine, { kind: 'tab', line: '/give @a minecraft:diamond_' });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'minecraft:diamond_sword');
    phase = r.machine.phase;
    assert.strictEqual(phase.kind === 'open' ? phase.mode.kind : '', 'cycling');

    // Third Tab: nothing typed since "minecraft:diamond_sword" was applied —
    // cycles to the second suggestion.
    r = step(r.machine, { kind: 'tab', line: '/give @a minecraft:diamond_sword' });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'minecraft:diamond_pickaxe');
  });

  test('fresh fetch from Tab: results sharing a longer common prefix complete to that prefix instead of the first match', () => {
    let m = createMachine();
    let r = step(m, { kind: 'tab', line: '/give @a minecraft:diamond' });
    m = r.machine;
    const fetchEffect = find(r.effects, 'fetchCompletions')!;

    r = step(m, {
      kind: 'completionsResult', requestId: fetchEffect.requestId,
      items: ['minecraft:diamond_sword', 'minecraft:diamond_pickaxe'],
    });
    assert.deepStrictEqual(kinds(r.effects), ['applySuggestion', 'render']);
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'minecraft:diamond_');
    const phase = r.machine.phase;
    assert.strictEqual(phase.kind === 'open' ? phase.mode.kind : '', 'preview');
    assert.strictEqual(phase.kind === 'open' ? phase.query : '', '/give @a minecraft:diamond_');
  });

  test('a single suggestion is filled in entirely on the first Tab — no common-prefix detour', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/give @a minecraft:diamond_sw' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, {
      kind: 'completionsResult', requestId: fetchId,
      items: ['minecraft:diamond_sword'],
    }).machine;
    assert.strictEqual(m.fetch.kind, 'idle');

    const r = step(m, { kind: 'tab', line: '/give @a minecraft:diamond_sw' });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'minecraft:diamond_sword');
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.mode.kind : '', 'cycling');
  });

  test('items with no shared prefix beyond what is typed: first Tab cycles straight to the first item (existing behavior)', () => {
    const m = openWithItems(['survival', 'creative', 'adventure']);
    const r = step(m, { kind: 'tab', line: '/gamemode ' });
    assert.strictEqual(find(r.effects, 'applySuggestion')!.text, 'survival');
    assert.strictEqual(r.machine.phase.kind === 'open' ? r.machine.phase.mode.kind : '', 'cycling');
  });
});

suite('completionEngine: usage staleness', () => {
  test('a usage result for a query the user has moved on from is discarded', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    let fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;

    // The trailing space is a "natural pause point" — completions coming
    // back with a non-empty list also kicks off a background usage fetch
    // right away (rather than waiting for Tab), since at this point the
    // engine doesn't yet know whether "gamemode" resolves to a single usage.
    let r = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative'] });
    m = r.machine;
    const usageFetchId = find(r.effects, 'fetchUsage')!.requestId;
    assert.strictEqual(m.fetch.kind === 'busy' ? m.fetch.purpose.kind : '', 'usage');

    // user keeps typing before the usage reply comes back
    r = step(m, { kind: 'lineChanged', line: '/gamemode survival ' });
    m = r.machine;

    // stale usage reply for the old query arrives — must not be rendered
    r = step(m, { kind: 'usageResult', requestId: usageFetchId, text: '/gamemode <mode>' });
    const render = find(r.effects, 'render');
    assert.ok(!render || render.usage === null, 'stale usage must never reach the display');
  });

  test('a choice-list usage is not carried forward once the user has typed into that choice', () => {
    // Scenario: /mv has many subcommands shown as a choice list in the usage hint.
    // Once the user types "/mv worldborder" they have navigated into one choice —
    // the parent-level "(worldborder|generators|...)" hint must be discarded so a
    // new, more-specific fetch can happen rather than showing the wrong usage.
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/mv ' }).machine;
    let fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;

    // Completions arrive for "/mv " and kick off a usage fetch at this pause point.
    let r = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['worldborder', 'generators', 'gamerule'] });
    m = r.machine;
    const usageFetch = find(r.effects, 'fetchUsage')!;
    assert.ok(usageFetch, 'engine must fetch usage at trailing-space pause point');

    // Usage arrives with a choice-list — the parent-level "/mv" hub usage.
    r = step(m, { kind: 'usageResult', requestId: usageFetch.requestId, text: 'mv (worldborder|generators|gamerule)' });
    m = r.machine;
    assert.strictEqual(m.phase.kind === 'open' ? (m.phase.usage.kind === 'ready' ? m.phase.usage.text : null) : null,
      'mv (worldborder|generators|gamerule)');

    // User types "worldborder" — navigating into one of those choices.
    r = step(m, { kind: 'lineChanged', line: '/mv worldborder' });
    m = r.machine;
    fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    r = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['worldborder'] });
    m = r.machine;

    // The render must not carry the stale choice-list usage forward.
    const render = find(r.effects, 'render')!;
    assert.strictEqual(render.usage, null, 'choice-list usage must not be shown after the user has typed into that choice');
  });

  test('an argument-based usage IS carried forward as the user types argument values', () => {
    // Scenario: "gamemode <mode> [<target>]" is valid for any line that starts
    // with "/gamemode " — the user typing a mode value or target should keep
    // showing the usage hint, just with a different highlighted token.
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    let fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;

    let r = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative'] });
    m = r.machine;
    const usageFetch = find(r.effects, 'fetchUsage')!;

    r = step(m, { kind: 'usageResult', requestId: usageFetch.requestId, text: 'gamemode <mode> [<target>]' });
    m = r.machine;

    // User types "creative" — still on the same argument position.
    r = step(m, { kind: 'lineChanged', line: '/gamemode creative' });
    m = r.machine;
    fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    r = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['creative'] });
    m = r.machine;

    // Argument-based usage must be carried forward — no new fetch needed.
    const render = find(r.effects, 'render')!;
    assert.strictEqual(render.usage, 'gamemode <mode> [<target>]', 'argument-based usage must persist across argument-value keystrokes');
    assert.strictEqual(find(r.effects, 'fetchUsage'), undefined, 'must not re-fetch usage for a command already resolved');
  });
});

suite('completionEngine: arrow keys and escape', () => {
  function openCycling(items: string[]): Machine {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items }).machine;
    return step(m, { kind: 'tab', line: '/gamemode ' }).machine;
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
      return step(mm, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative', 'adventure'] }).machine;
    }
  });

  test('selectIndex jumps directly to an index (used by Home/End/PageUp/PageDown) without entering cycling mode', () => {
    let m = createMachine();
    m = step(m, { kind: 'lineChanged', line: '/gamemode ' }).machine;
    const fetchId = (m.fetch.kind === 'busy') ? m.fetch.requestId : -1;
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival', 'creative', 'adventure'] }).machine;

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
    m = step(m, { kind: 'completionsResult', requestId: fetchId, items: ['survival'] }).machine;

    const r = step(m, { kind: 'escape' });
    assert.deepStrictEqual(kinds(r.effects), ['hide']);
  });
});
