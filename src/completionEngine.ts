// src/completionEngine.ts
//
// Pure decision core for server-side ("plugin mode") tab completion.
//
// This module knows nothing about VS Code, sockets, or wall-clock time — it's
// a reducer: (Machine, Event) -> { machine: Machine, effects: Effect[] }. The
// shell (RconSession) feeds it terminal events plus its own clock, and
// executes the Effects it returns (RCON sends, ANSI writes, applying text to
// the line). That makes every async race and timing rule in here something
// you can drive with a scripted event sequence in a test, rather than
// something that happens to you against a real server at 2am.

// ─────────────────────────── pure query helpers ───────────────────────────

/**
 * Builds the argument string to send to the `tabcomplete` plugin command for
 * a given input line, or null if the line isn't a command at all.
 *
 * A trailing "-" is the plugin's convention for "the user typed a trailing
 * space here" (some RCON clients strip trailing whitespace before it reaches
 * the plugin). A bare "-" with no other parts asks for root-level completions:
 * Brigadier suggests by prefix-matching the *remaining* input, and an empty
 * remaining string matches every root command name.
 */
export function buildCompletionsQuery(input: string): string | null {
  if (!input.startsWith('/')) { return null; }
  const withoutSlash = input.slice(1);
  const trimmed = withoutSlash.trim();
  const hasTrailingSpace = withoutSlash.endsWith(' ');
  const parts = trimmed.split(/\s+/).filter(p => p.length > 0);

  if (parts.length === 0) { return '-'; }
  return hasTrailingSpace ? `${parts.join(' ')} -` : parts.join(' ');
}

/** Builds the argument string for `cmdusage`, or null if there's nothing to ask about yet. */
export function buildUsageQuery(input: string): string | null {
  if (!input.startsWith('/')) { return null; }
  const withoutSlash = input.slice(1).trim();
  return withoutSlash.length > 0 ? withoutSlash : null;
}

/**
 * Splices a raw completion candidate (e.g. "adventure", "distance=", "[")
 * into the line as typed so far, the same way a real client reconciles a
 * server-suggested replacement against partial input.
 *
 * The server only ever hands back the candidate text — never which part of
 * the line it replaces — and that part isn't reliably "the last
 * space-delimited word": selector/NBT syntax nests further completion
 * boundaries inside a single token (typing "@a[dist" and completing to
 * "@a[distance=" should only replace "dist"; typing the *complete* selector
 * "@a" and getting "[" appended makes "@a[", where nothing of "@a" overlaps
 * the candidate at all).
 *
 * So instead of guessing where the word boundary is, this finds the longest
 * suffix of what's typed that the candidate continues (a prefix-overlap,
 * checked longest-first so e.g. "dist" wins over the shorter-but-also-
 * matching "t"), and splices the candidate in over just that overlap. An
 * overlap of zero naturally degrades to appending — exactly right for
 * refinement suggestions ("@a" + "[") and for completions chosen right after
 * a trailing space ("adventure " + "@a").
 */
export function applySuggestion(line: string, suggestionText: string): string {
  let overlap = 0;
  for (let len = Math.min(line.length, suggestionText.length); len > 0; len--) {
    if (suggestionText.startsWith(line.slice(line.length - len))) {
      overlap = len;
      break;
    }
  }
  return line.slice(0, line.length - overlap) + suggestionText;
}

/** The longest string every item in `items` starts with (`''` if `items` is empty). */
export function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) { return ''; }
  let prefix = items[0];
  for (let i = 1; i < items.length && prefix.length > 0; i++) {
    let len = 0;
    const max = Math.min(prefix.length, items[i].length);
    while (len < max && prefix[len] === items[i][len]) { len++; }
    prefix = prefix.slice(0, len);
  }
  return prefix;
}

/** Every failure/meta message from both `tabcomplete` and `cmdusage` starts with "(". */
function isFailureResponse(response: string | undefined): boolean {
  return !response || response.trim().startsWith('(');
}

/**
 * `cmdusage` echoes the command's help text verbatim, Minecraft `§` color
 * codes and all (e.g. "§b§bmvp create§b §a <portal-name> [destination]"). The
 * hint display applies its own ANSI styling on top of the plain usage string,
 * so any embedded color codes need to come out here, at the parsing boundary
 * — otherwise they show up as literal `§b` noise mixed in with our own escapes.
 */
function stripMinecraftColorCodes(text: string): string {
  // Handle both § and Â§ encodings (UTF-8 mangling some servers produce).
  return text.replace(/[§Â]§[0-9a-fklmnor]/g, '').replace(/§[0-9a-fklmnor]/g, '');
}

export function parseCompletionsResponse(response: string | undefined): string[] {
  if (isFailureResponse(response)) { return []; }
  return response!.split('\n').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * `cmdusage` resolves an input to one of three shapes: a clean failure like
 * "(too broad — use /help mvp or provide a subcommand)" (caught above), a
 * single matching command's usage line, or — when the input is still an
 * ambiguous prefix of multiple subcommands (e.g. "mvp c" matching both "mvp
 * create" and "mvp config") — one usage line per candidate, newline-separated.
 *
 * Only the single-match shape represents *the* usage for what's been typed —
 * multiple candidates means the command still hasn't resolved to one thing,
 * so (same as the explicit failure case) there's nothing unambiguous to show
 * yet. This is the actual "is there a single usage line" signal — the server
 * already does the resolution; we just need to recognize its shape.
 */
export function parseUsageResponse(response: string | undefined): string {
  if (isFailureResponse(response)) { return ''; }

  const lines = response!.split('\n')
    .map(line => stripMinecraftColorCodes(line).trim())
    .filter(line => line.length > 0);

  return lines.length === 1 ? lines[0] : '';
}

// ─────────────────────────────── state types ───────────────────────────────

export type Usage =
  | { kind: 'none' }
  | { kind: 'loading'; forQuery: string }
  | { kind: 'ready'; forQuery: string; text: string };

function usageMatches(usage: Usage, line: string): boolean {
  return usage.kind !== 'none' && usage.forQuery === line;
}

/**
 * Once a command has resolved to a single usage line, that usage stays valid
 * across further keystrokes that only change the *arguments* — the command
 * portion itself doesn't change, and `formatArgumentHint` already recomputes
 * which argument is highlighted purely from `(usage, line)`. "Covers" means
 * the cached query's words are a prefix of the current line's words, i.e. the
 * command portion hasn't changed (only what comes after it has, or the user
 * is still extending it). An empty-text usage (ambiguous prefix or "too
 * broad") never covers anything — there's nothing resolved to stick to, so
 * the next natural pause point should ask again.
 */
function usageCoversLine(usage: Usage, line: string): boolean {
  if (usage.kind !== 'ready' || usage.text === '') { return false; }
  const cachedWords = usage.forQuery.trim().split(/\s+/).filter(w => w.length > 0);
  const lineWords = line.trim().split(/\s+/).filter(w => w.length > 0);
  if (lineWords.length < cachedWords.length) { return false; }
  return cachedWords.every((word, i) => word === lineWords[i]);
}

export type Mode =
  // showing live as the user types; nothing has been spliced into the line yet
  | { kind: 'preview' }
  // Tab applied a suggestion; further Tab/Shift-Tab advance through the list.
  // `lastAdvanceAt` drives the "quick re-press cycles instead of re-deriving" window.
  | { kind: 'cycling'; lastAdvanceAt: number };

export type FetchPurpose =
  | { kind: 'completions'; reason: 'typing' | 'tab' | 'shiftTab' }
  | { kind: 'usage' };

/** What the user wants once the in-flight fetch frees up — supersedes whatever was queued before it. */
export type Queued = { line: string; reason: CompletionsReason };

export type FetchState =
  | { kind: 'idle' }
  | {
      kind: 'busy';
      requestId: number;
      purpose: FetchPurpose;
      forLine: string;
      /** Newest request that arrived while this one was outstanding — act on it once this resolves. */
      queued: Queued | null;
    };

export type Phase =
  | { kind: 'closed' }
  | {
      kind: 'open';
      query: string;        // the input `items` (and `usage`, once loaded) are valid for —
                            // also what Escape restores the line to while cycling
      items: string[];
      selectedIndex: number;
      usage: Usage;
      mode: Mode;
    };

export type OpenPhase = Extract<Phase, { kind: 'open' }>;

export interface Machine {
  seq: number;             // monotonic counter; next value handed out as a requestId
  phase: Phase;
  fetch: FetchState;
}

export function createMachine(): Machine {
  return { seq: 0, phase: { kind: 'closed' }, fetch: { kind: 'idle' } };
}

// ──────────────────────────────── effects ────────────────────────────────
// Declarative descriptions of side effects. The reducer never touches the
// network, the clock, or the terminal — the shell executes these.

export type Effect =
  | { kind: 'fetchCompletions'; requestId: number; query: string }
  | { kind: 'fetchUsage'; requestId: number; query: string }
  | { kind: 'applySuggestion'; text: string }
  | { kind: 'render'; items: string[]; selectedIndex: number; usage: string | null }
  | { kind: 'hide' }
  | { kind: 'restoreLine'; text: string };

// ───────────────────────────────── events ─────────────────────────────────
// Everything the machine can react to — user input, server replies, and time
// itself, delivered explicitly rather than read off Date.now() mid-handler.

export type Event =
  | { kind: 'lineChanged'; line: string }
  | { kind: 'tab'; line: string; now: number }
  | { kind: 'shiftTab'; line: string; now: number }
  | { kind: 'arrow'; direction: 'up' | 'down' }
  /** Jump/page operations land here too — they're shell-side windowing concerns,
   *  but the shell still needs to keep the machine's selection in sync so a
   *  later Tab knows which item is "currently selected". */
  | { kind: 'selectIndex'; index: number }
  | { kind: 'escape' }
  | { kind: 'completionsResult'; requestId: number; items: string[]; now: number }
  | { kind: 'usageResult'; requestId: number; text: string };

// ─────────────────────────────── the reducer ───────────────────────────────

export interface StepResult { machine: Machine; effects: Effect[]; }

export function step(m: Machine, event: Event): StepResult {
  switch (event.kind) {
    case 'lineChanged':       return onLineChanged(m, event.line);
    case 'tab':               return onTabOrShiftTab(m, event.line, event.now, 'tab');
    case 'shiftTab':          return onTabOrShiftTab(m, event.line, event.now, 'shiftTab');
    case 'arrow':             return onArrow(m, event.direction);
    case 'selectIndex':       return onSelectIndex(m, event.index);
    case 'escape':            return onEscape(m);
    case 'completionsResult': return onCompletionsResult(m, event.requestId, event.items, event.now);
    case 'usageResult':       return onUsageResult(m, event.requestId, event.text);
  }
}

function unchanged(m: Machine): StepResult { return { machine: m, effects: [] }; }

function renderEffect(phase: OpenPhase): Effect {
  return {
    kind: 'render',
    items: phase.items,
    selectedIndex: phase.selectedIndex,
    usage: phase.usage.kind === 'ready' ? phase.usage.text : null,
  };
}

function closeAndHide(m: Machine): StepResult {
  return { machine: { seq: m.seq, phase: { kind: 'closed' }, fetch: { kind: 'idle' } }, effects: [{ kind: 'hide' }] };
}

type CompletionsReason = Extract<FetchPurpose, { kind: 'completions' }>['reason'];

/** Issue a fresh `tabcomplete` fetch for `line` (used for first-time queries and re-derives after a queued line wins). */
function fetchCompletionsFor(m: Machine, line: string, reason: CompletionsReason): StepResult {
  const query = buildCompletionsQuery(line);
  if (query === null) { return closeAndHide(m); }
  const requestId = m.seq + 1;
  const machine: Machine = {
    seq: requestId,
    phase: m.phase,
    fetch: { kind: 'busy', requestId, purpose: { kind: 'completions', reason }, forLine: line, queued: null },
  };
  return { machine, effects: [{ kind: 'fetchCompletions', requestId, query }] };
}

// ── lineChanged: the user typed or erased a character ──

function onLineChanged(m: Machine, line: string): StepResult {
  const query = buildCompletionsQuery(line);

  if (query === null) {
    if (m.phase.kind === 'closed' && m.fetch.kind === 'idle') { return unchanged(m); }
    return closeAndHide(m);
  }

  if (m.fetch.kind === 'busy') {
    // RCON serializes requests — only one fetch in flight at a time. Remember
    // the newest input and refetch for it once the outstanding one resolves.
    return { machine: { ...m, fetch: { ...m.fetch, queued: { line, reason: 'typing' } } }, effects: [] };
  }

  return fetchCompletionsFor(m, line, 'typing');
}

// ── tab / shiftTab ──

function onTabOrShiftTab(m: Machine, line: string, now: number, which: 'tab' | 'shiftTab'): StepResult {
  const query = buildCompletionsQuery(line);
  if (query === null) {
    return m.phase.kind === 'open'
      ? { machine: { ...m, phase: { kind: 'closed' } }, effects: [{ kind: 'hide' }] }
      : unchanged(m);
  }

  const phase = m.phase;
  const delta = which === 'tab' ? 1 : -1;

  // Quick re-press while already cycling: just advance through the list —
  // `now` (not Date.now()) drives the "is this a quick re-press" check.
  if (phase.kind === 'open' && phase.mode.kind === 'cycling' && phase.items.length > 0
      && (now - phase.mode.lastAdvanceAt) < 500) {
    return advance(m, phase, phase.selectedIndex, delta, now);
  }

  // We already have fresh items for exactly this input — they were pulled
  // live as the user typed, so there's no need to hit the server again.
  if (phase.kind === 'open' && phase.query === line && phase.items.length > 0) {
    // First Tab with multiple candidates: if they share a prefix longer than
    // what's typed, complete to that prefix (bash-style) and leave the list
    // open — a follow-up Tab with nothing further to gain falls through to
    // cycling below. A single candidate's "common prefix" is itself, but
    // that case is left to the cycling branch, which already fills it in
    // (and fetches its usage line) on the first press.
    if (which === 'tab' && phase.items.length > 1) {
      const lcp = longestCommonPrefix(phase.items);
      const completed = applySuggestion(line, lcp);
      if (completed !== line) {
        const newPhase: OpenPhase = { ...phase, query: completed };
        return { machine: { ...m, phase: newPhase }, effects: [{ kind: 'applySuggestion', text: lcp }, renderEffect(newPhase)] };
      }
    }

    // Tab keeps the existing selection (e.g. from arrow keys); Shift-Tab steps
    // back from it — both rules match the pre-refactor behavior.
    const base = (phase.selectedIndex >= 0 && phase.selectedIndex < phase.items.length) ? phase.selectedIndex : 0;
    const initialDelta = which === 'tab' ? 0 : -1;
    return advance(m, phase, base, initialDelta, now, /* maybeFetchUsage */ true);
  }

  // Need fresh completions from the server, but only one fetch at a time —
  // e.g. a background usage fetch may still be outstanding. Remember what the
  // user actually wants and act on it the moment the wire frees up, rather
  // than silently swallowing the keypress.
  if (m.fetch.kind === 'busy') {
    return { machine: { ...m, fetch: { ...m.fetch, queued: { line, reason: which } } }, effects: [] };
  }
  return fetchCompletionsFor(m, line, which);
}

function advance(m: Machine, phase: OpenPhase, baseIndex: number, delta: number, now: number, maybeFetchUsage = false): StepResult {
  const selectedIndex = (baseIndex + delta + phase.items.length) % phase.items.length;
  let newPhase: OpenPhase = { ...phase, selectedIndex, mode: { kind: 'cycling', lastAdvanceAt: now } };
  let machine: Machine = { ...m, phase: newPhase };

  const effects: Effect[] = [{ kind: 'applySuggestion', text: phase.items[selectedIndex] }];

  // The usage line is purely supplementary — fetch it in the background
  // (once the wire is free) rather than making the user wait on it before
  // the completion itself is applied.
  if (maybeFetchUsage && !usageMatches(newPhase.usage, phase.query) && m.fetch.kind === 'idle') {
    const usageQuery = buildUsageQuery(phase.query);
    if (usageQuery !== null) {
      const requestId = m.seq + 1;
      newPhase = { ...newPhase, usage: { kind: 'loading', forQuery: phase.query } };
      machine = { seq: requestId, phase: newPhase, fetch: { kind: 'busy', requestId, purpose: { kind: 'usage' }, forLine: phase.query, queued: null } };
      effects.push({ kind: 'fetchUsage', requestId, query: usageQuery });
    }
  }

  effects.push(renderEffect(newPhase));
  return { machine, effects };
}

// ── arrow keys: browse the list without committing to anything ──

function onArrow(m: Machine, direction: 'up' | 'down'): StepResult {
  if (m.phase.kind !== 'open' || m.phase.items.length === 0) { return unchanged(m); }
  const { items, selectedIndex } = m.phase;
  const delta = direction === 'down' ? 1 : -1;
  const next = (selectedIndex + delta + items.length) % items.length;
  const newPhase: OpenPhase = { ...m.phase, selectedIndex: next, mode: { kind: 'preview' } };
  return { machine: { ...m, phase: newPhase }, effects: [renderEffect(newPhase)] };
}

// ── jump/page: shell-computed target index, same "just browsing" semantics as arrows ──

function onSelectIndex(m: Machine, index: number): StepResult {
  if (m.phase.kind !== 'open' || index < 0 || index >= m.phase.items.length) { return unchanged(m); }
  const newPhase: OpenPhase = { ...m.phase, selectedIndex: index, mode: { kind: 'preview' } };
  return { machine: { ...m, phase: newPhase }, effects: [renderEffect(newPhase)] };
}

// ── escape: close, restoring the pre-completion line if we'd applied one ──

function onEscape(m: Machine): StepResult {
  if (m.phase.kind !== 'open') { return unchanged(m); }
  const effects: Effect[] = [];
  if (m.phase.mode.kind === 'cycling') {
    effects.push({ kind: 'restoreLine', text: m.phase.query });
  }
  effects.push({ kind: 'hide' });
  return { machine: { ...m, phase: { kind: 'closed' } }, effects };
}

// ── server replies ──

function onCompletionsResult(m: Machine, requestId: number, items: string[], now: number): StepResult {
  if (m.fetch.kind !== 'busy' || m.fetch.requestId !== requestId || m.fetch.purpose.kind !== 'completions') {
    return unchanged(m); // stale/superseded response — ignore
  }
  const { forLine, queued, purpose } = m.fetch;

  if (queued !== null) {
    // The user has since moved on to different input (or pressed Tab again) —
    // discard these results and immediately act on what they actually want now.
    return fetchCompletionsFor(m, queued.line, queued.reason);
  }

  if (items.length === 0) {
    if (purpose.reason !== 'typing') { return closeAndHide(m); }

    // No completions for this input, but it still looks like a command in
    // progress — rather than closing, show what argument comes next (e.g.
    // "/gamemode creative " has no completions for the target selector, but
    // there's still a usage hint worth displaying). Mirrors the "open with an
    // empty item list, fill in usage in the background" shape used elsewhere.
    const usageQuery = buildUsageQuery(forLine);
    if (usageQuery === null) { return closeAndHide(m); }

    const usageRequestId = m.seq + 1;
    const phase: OpenPhase = {
      kind: 'open', query: forLine, items: [], selectedIndex: -1,
      usage: { kind: 'loading', forQuery: forLine }, mode: { kind: 'preview' },
    };
    return {
      machine: { seq: usageRequestId, phase, fetch: { kind: 'busy', requestId: usageRequestId, purpose: { kind: 'usage' }, forLine, queued: null } },
      effects: [{ kind: 'fetchUsage', requestId: usageRequestId, query: usageQuery }, renderEffect(phase)],
    };
  }

  if (purpose.reason === 'typing') {
    // Preserve the existing selection across re-fetches if still in range —
    // keeps arrow-key navigation stable while the user keeps typing.
    const previous = m.phase.kind === 'open' ? m.phase.selectedIndex : -1;
    const selectedIndex = (previous >= 0 && previous < items.length) ? previous : 0;

    // Sticky usage: once a command has resolved to a single usage line, keep
    // showing it across further keystrokes within that same command — only
    // the highlighted argument changes, which formatArgumentHint derives
    // purely from (usage, line), no fetch needed. A new command (or one that
    // hasn't resolved yet) starts fresh — the old usage no longer applies.
    const carriedUsage: Usage = (m.phase.kind === 'open' && usageCoversLine(m.phase.usage, forLine))
      ? m.phase.usage
      : { kind: 'none' };

    const basePhase: OpenPhase = { kind: 'open', query: forLine, items, selectedIndex, usage: carriedUsage, mode: { kind: 'preview' } };

    // Nothing resolved for this command yet, but the line looks like a
    // natural pause point — the user just finished a token (trailing space),
    // the same "word boundary" signal the empty-completions hint-phase above
    // keys off. Worth asking whether it's now resolved to a single command.
    // (Asking on *every* keystroke would double the round trips per
    // character typed — the sticky cache plus this pause-point trigger keeps
    // it to roughly one usage fetch per command, not one per character.)
    if (carriedUsage.kind === 'none' && forLine.endsWith(' ')) {
      const usageQuery = buildUsageQuery(forLine);
      if (usageQuery !== null) {
        const usageRequestId = m.seq + 1;
        const phase: OpenPhase = { ...basePhase, usage: { kind: 'loading', forQuery: forLine } };
        return {
          machine: { seq: usageRequestId, phase, fetch: { kind: 'busy', requestId: usageRequestId, purpose: { kind: 'usage' }, forLine, queued: null } },
          effects: [{ kind: 'fetchUsage', requestId: usageRequestId, query: usageQuery }, renderEffect(phase)],
        };
      }
    }

    return { machine: { ...m, phase: basePhase, fetch: { kind: 'idle' } }, effects: [renderEffect(basePhase)] };
  }

  // First Tab landing fresh completions for multiple candidates: same
  // common-prefix completion as the "items already on hand" path in
  // onTabOrShiftTab, just reached via a server round trip instead.
  if (purpose.reason === 'tab' && items.length > 1) {
    const lcp = longestCommonPrefix(items);
    const completed = applySuggestion(forLine, lcp);
    if (completed !== forLine) {
      const phase: OpenPhase = {
        kind: 'open', query: completed, items, selectedIndex: 0,
        usage: { kind: 'none' }, mode: { kind: 'preview' },
      };
      return { machine: { ...m, phase, fetch: { kind: 'idle' } }, effects: [{ kind: 'applySuggestion', text: lcp }, renderEffect(phase)] };
    }
  }

  // purpose.reason is 'tab' or 'shiftTab': apply a suggestion right away and
  // enter cycling mode; fetch the usage line afterwards without blocking on it.
  const selectedIndex = purpose.reason === 'shiftTab' ? items.length - 1 : 0;
  const basePhase: OpenPhase = {
    kind: 'open', query: forLine, items, selectedIndex,
    usage: { kind: 'none' }, mode: { kind: 'cycling', lastAdvanceAt: now },
  };
  const effects: Effect[] = [{ kind: 'applySuggestion', text: items[selectedIndex] }];

  const usageQuery = buildUsageQuery(forLine);
  if (usageQuery === null) {
    effects.push(renderEffect(basePhase));
    return { machine: { ...m, phase: basePhase, fetch: { kind: 'idle' } }, effects };
  }

  const usageRequestId = m.seq + 1;
  const phase: OpenPhase = { ...basePhase, usage: { kind: 'loading', forQuery: forLine } };
  effects.push({ kind: 'fetchUsage', requestId: usageRequestId, query: usageQuery });
  effects.push(renderEffect(phase));
  return {
    machine: { seq: usageRequestId, phase, fetch: { kind: 'busy', requestId: usageRequestId, purpose: { kind: 'usage' }, forLine, queued: null } },
    effects,
  };
}

function onUsageResult(m: Machine, requestId: number, text: string): StepResult {
  if (m.fetch.kind !== 'busy' || m.fetch.requestId !== requestId || m.fetch.purpose.kind !== 'usage') {
    return unchanged(m);
  }
  const { forLine, queued } = m.fetch;

  if (queued !== null) {
    return fetchCompletionsFor(m, queued.line, queued.reason);
  }

  if (m.phase.kind !== 'open' || m.phase.query !== forLine) {
    // The list has moved on (closed, or now showing a different query) — discard.
    return { machine: { ...m, fetch: { kind: 'idle' } }, effects: [] };
  }

  const phase: OpenPhase = { ...m.phase, usage: { kind: 'ready', forQuery: forLine, text } };
  return { machine: { ...m, phase, fetch: { kind: 'idle' } }, effects: [renderEffect(phase)] };
}
