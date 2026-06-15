# Argument-hint / usage display — user stories

This is a working doc to pin down exactly when and how the "argument hint"
display (the structured usage line shown below the prompt — e.g. typing
`/gamemode creative ` shows `/gamemode <mode> <target>` with `<target>`
highlighted and a "Player name or @selector" hint underneath) should appear,
update, and disappear.

The goal is to agree on expected behavior story-by-story, then make the
engine/shell match it and add reducer tests that pin each one down — so
"flaky" becomes "specified, and tested."

Each story has a status marker:
- ✅ — behavior we believe is already agreed and correct
- ❓ — open question; needs a decision
- 🐛 — a specific mechanism that looks like it would *cause* flakiness

Add notes / ✅-or-✗ / alternative phrasing inline as we talk through these.

## Quick mechanics refresher (for grounding the discussion)

- The engine tracks `usage` as `none | loading | ready` per "open" phase, keyed
  by the query it was fetched for (`forQuery`).
- `cmdusage <query>` replies with one of three shapes: a `(...)` failure (query
  too broad / no such command), **multiple** newline-separated usage lines (one
  per matching candidate, when the query is an ambiguous prefix), or **exactly
  one** usage line when the query resolves unambiguously to a single command.
  `parseUsageResponse` collapses the first two down to `''` — only the
  single-line case is a usable usage — so "the command portion is fully
  resolved" is a parse-time fact about the *response text*, not a fact about
  how many argument-level completions remain.
- The render rule: **show the suggestion list whenever there are completions,
  and show the argument hint underneath it whenever `usage` has resolved to
  that one usable line** — independent of how many items are in the list.
  Typing `/mvp ` shows a long subcommand list with no hint (the `cmdusage`
  reply for `mvp` is the ambiguous multi-line shape, so `usage` stays empty);
  typing `/mvp create ` (or any further argument of it) shows the hint, because
  `cmdusage mvp create` resolves to one line and that resolution is cached and
  reused for as long as the line stays within that command (see story 4).
- A hint-only phase opens when a `typing`-triggered completions fetch comes
  back empty but the line still looks like a command in progress — the engine
  immediately kicks off a `cmdusage` fetch and renders with `usage: null`
  (nothing shown yet) until that resolves.

---

## 1. Suggestions exist → show the list (plus the hint, once the command resolves)

**Given** the user is typing a command and the server has completions to offer
**When** the completions response is non-empty
**Then** the suggestion list is shown. The hint is shown stacked underneath it
as soon as — and for as long as — `usage` has resolved to a single usable
`cmdusage` line for the command path the user is in. This is **not** about how
many *items* are in the list: `/mvp c` can show a two-line suggestion list
(`create`, `config`) with no hint (the command is still ambiguous — `cmdusage`
itself replies with two candidate lines), while `/mvp create <portal-name> ` can
show a long argument-completion list *with* the hint stacked below it, because
by then `mvp create` has resolved to exactly one usage line.

Status: ✅ — revised twice at the user's request. First pass gated the combo on
`items.length === 1`; the user then clarified the actual intent is "a single
*usage* line," which only the response text itself can answer (an ambiguous
prefix can easily produce a short item list with no resolved usage, and a
resolved command can have many argument completions). Implemented by having
`parseUsageResponse` parse the `cmdusage` reply into `''` (ambiguous/failure —
multiple or zero candidate lines) or the one resolved line, and by having
`executeEngineEffect`'s `render` case in `rconTerminal.ts` append the hint's
content lines to the list's whenever `effect.usage` is non-null — both drawn in
one frame by `renderSuggestionArea`.

---

## 2. No suggestions, but the command has usage → show the hint

**Given** the user has typed past the point where completions exist (e.g.
`/gamemode creative ` — nothing to complete for the target selector)
**When** the completions response comes back empty but `cmdusage` has something
to say
**Then** the argument-hint display appears in place of the (empty) list.

Status: ✅ — this is the new hint-only phase we just added.

---

## 3. Transitioning from list → hint: what fills the gap?

**Given** the suggestion list is currently showing (e.g. for `/gamemode cr`)
**When** the user types the character that empties the completions (e.g.
finishes `creative` and types a space)
**Then** there's necessarily a moment where the old list is no longer valid and
the new hint's usage text hasn't arrived yet (`usage: loading` renders as
nothing).

**❓ Open question — what should the user see during that gap?**
- (a) Nothing — list vanishes, blank area, then hint pops in once usage
  resolves (this is what the engine does today)
- (b) A lightweight placeholder (e.g. a dimmed `…` or the command prefix alone)
  so the display area doesn't collapse/jump
- (c) Keep the *old* list visible until the hint is ready, then swap — trades a
  flash of stale content for never showing "nothing"

This gap — and the analogous one in the other direction (hint → list) — is a
strong candidate for what reads as "flaky": the suggestion area's height and
content both change abruptly, more than once, for a single keystroke.

---

## 4. Typing within an argument: should the hint stay put?

**Given** the argument hint is showing for `/gamemode creative ` (hint: "Player
name or @selector...")
**When** the user keeps typing the same argument (e.g. `/gamemode creative @a`,
then `@a[`, then `@a[type=`)
**Then** the hint should keep showing the *same* usage line — recomputing only
which argument is bolded and which contextual hint applies — without
re-fetching `cmdusage` on every keystroke.

Status: ✅ — implemented as "sticky" usage caching plus pause-point fetching:
- `usageCoversLine(usage, line)` (`completionEngine.ts`) treats a previously
  resolved, non-empty `usage` as still valid for the current line as long as
  the line's words start with the cached query's words — i.e. the user is
  still within the same resolved command, just typing/editing arguments. While
  it covers the line, the engine carries the cached `usage` forward instead of
  re-fetching, and `formatArgumentHint` (which already recomputes purely from
  `(usage, line)`, no fetch needed) does the rest live.
- The engine only goes back to the server when the cached usage *stops*
  covering the line (the user backed out of the resolved command into a
  different one — story 5), and even then only at a "natural pause point": the
  line ending in a space. Typing mid-token doesn't trigger a fetch; finishing a
  word and hitting space does — exactly the moments where the resolved command
  could plausibly have changed.
- This generalizes the *old* local-mode backend's "sticky cached usage per
  command" behavior (`commandArgumentCache` / `cachedCommand`+`cachedHelp` in
  `LocalCompletionBackend`) to the engine, without keying on the literal
  command name — `usageCoversLine`'s word-prefix check naturally handles
  multi-word command paths like `mvp create` the same way.

---

## 5. Switching commands: the old hint must not linger

**Given** the hint is showing for `/gamemode ...`
**When** the user clears the line and starts a different command, e.g. `/tp `
**Then** `/gamemode`'s hint must disappear — showing it while `/tp`'s usage
loads would be actively misleading (wrong argument names, wrong hint text).

Status: ✅ should hold today (a new `forLine`/phase always supersedes), and
**must keep holding** if we change story 4's caching to be command-keyed rather
than line-keyed — the cache key needs to invalidate on command change, the way
the old `cachedCommand !== commandName` check did.

---

## 6. Usage fetched during Tab-cycling — no longer necessarily dead work

**Given** the user presses Tab, gets a list of completions, and is cycling
through them (`mode: cycling`, `items.length > 0`)
**When** `advance()` decides to prefetch `cmdusage` in the background "so it's
ready"
**Then** — this *used* to look like dead work, since usage could never be
displayed while `items.length > 0` (the list always won per the old story 1).
**Now that story 1 has been revised** so the hint shows alongside the list
whenever `usage` has resolved to a single usable line (regardless of item
count), this prefetch is exactly what lets that combo render without a
"loading" gap the moment `cmdusage` resolves — it's load-bearing, not
speculative.

It overlaps with — and is now mostly subsumed by — the pause-point fetching
from story 4: `onCompletionsResult`'s `typing` branch already kicks off the
same `cmdusage` fetch as soon as a non-empty completions reply lands for a
line ending in a space (and `usageCoversLine` skips it if a sticky cache
already covers the line), so by the time the user reaches for Tab the usage is
often already in flight or resolved. `advance()`'s own prefetch
(`usageMatches`-gated, so it also skips a known-for-this-exact-line usage)
mainly still earns its keep on the `Tab`-from-a-fresh-line path, where there's
no prior `typing` round trip to have triggered it. Not worth removing or
further tuning unless it's observed to cause lag.

---

## 7. Escape / hide

**Given** either the list or the hint is showing
**When** the user presses Escape
**Then** restore the pre-Tab line if a suggestion had been applied (`cycling`),
otherwise just hide — no restore needed if nothing was ever spliced in
(`preview`).

Status: ✅ — already specified and covered by reducer tests
("escape while cycling restores...", "escape while only previewing...").

---

## Rendering mechanics — how the hint itself gets drawn

The stories above are about *when* the hint should appear. These are about
*how* it's painted to the terminal — grounded in a side-by-side read of
`showSuggestionList` and `showArgumentHint` (`rconTerminal.ts`), which paint
the two mutually-exclusive displays into the same screen real estate using
slightly different (and, it turns out, slightly inconsistent) ANSI choreography.

### 8. The hint's height changes depending on whether there's a contextual tip

**Given** the argument hint is showing
**When** the current argument has a contextual hint string (e.g. "Player name
or @selector...") vs. one that doesn't (unrecognized shape, or past the end of
documented arguments)
**Then** the display is 2 lines tall vs. 1 — it grows and shrinks as the user
moves between argument positions (and the suggestion list, separately, grows
and shrinks with its item count).

**❓** Is the clear-then-redraw cycle (`clearSuggestionDisplay` → draw N lines)
enough to make that resize feel clean, or does shrinking from 2 → 1 line leave
a stray blank/ghost line until the next full redraw overwrites it? This is
worth actually watching happen — height changes are exactly the kind of thing
that reads as "jumpy" even when each individual frame is drawn correctly.

---

### 9. ✅ (fixed) The list and the hint don't end their last line the same way

**Given** either display is the last thing painted before control returns to
the prompt
**When** comparing how each writes its final line:
- `showSuggestionList`'s last line (the `[n/total] Page x/y` indicator) has **no
  trailing `\r\n`** — the cursor parks on that line, then `\x1b8` restores it.
- `showArgumentHint`'s last line (the hint line, or the usage line if there's
  no hint) **does** end with `\r\n` — the cursor drops one line further before
  `\x1b8` restores it.

That's an extra implicit blank line specific to the hint path. Near the bottom
of the viewport, writing past the last row forces a scroll that the list path
never triggers — a very plausible cause of "the screen jumped" specifically
when switching from the list to the hint (or vice versa).

**Fix applied:** `showArgumentHint` no longer writes a trailing `\r\n` after
its last content line — both renderers now end identically (cursor parked on
the last content line, restored from there via `\x1b8`).

---

### 10. ✅ (fixed) The two renderers compute `suggestionListLines` inconsistently

**Given** both renderers need to record how many lines they painted, so the
*next* clear knows how much to erase
**When** comparing the bookkeeping:
- `showSuggestionList` starts `lineCount = 1` to mean "the line I'm about to
  write," increments per additional line, and stores `suggestionListLines =
  lineCount` (count of lines actually written).
- `showArgumentHint` *also* starts `lineCount = 1`, but that initial 1 doesn't
  correspond to a written line (the usage line bumps it to 2, the optional hint
  line to 3) — so it has to store `suggestionListLines = lineCount - 1` to land
  on the right number.

Both arrive at a correct count *today*, but via incompatible conventions for
what `lineCount` means. That's exactly the kind of thing that silently breaks
the next time either method grows a line (forget the matching `± 1` and you get
a stray uncleared line — a literal on-screen "ghost" of the previous display,
which would absolutely read as "flaky usage display").

**Fix applied:** `showArgumentHint` now follows the same convention as
`showSuggestionList` — `lineCount = 1` accounts for the line that's always
written (the usage line), each *additional* line increments it, and
`suggestionListLines = lineCount` stores the raw count directly (no `- 1`).

---

### 11. ✅ (fixed) Both renderers still carry their own (now-dead) "clear the old area" step

**Given** `executeEngineEffect`'s `render` case now calls
`this.clearSuggestionDisplay()` unconditionally *before* delegating to either
`showSuggestionList` or `showArgumentHint` (so the screen is always blank when
either one starts drawing)
**When** either of those methods *also* checks `if (this.suggestionListLines >
0)` and runs its own "clear the previous N lines" dance first
**Then** that branch is now always false — `clearSuggestionDisplay` already
zeroed `suggestionListLines` — so it's dead code in both methods, left over
from when each renderer was responsible for clearing its own prior frame.

Harmless today, but it's a duplicate of the very logic that story 10 shows is
easy to get subtly wrong, sitting right next to the (also slightly different —
see the `\r` vs. nothing after the loop, the `\x1b[2K` vs. `\x1b[K`) live
version in `clearSuggestionDisplay`. The next person debugging "why is there a
leftover line" has two divergent copies to reconcile.

**Fix applied:** deleted the in-method "clear old area" block from *both*
`showSuggestionList` and `showArgumentHint`. `clearSuggestionDisplay` — called
once, centrally, by the dispatcher — is now the single source of truth for
"erase whatever was there before."

---

### 12. ✅ (resolved by redesign) The "concealed text" alignment trick — does it hold up everywhere?

**Originally:** both displays left-padded their first content line with the
text the user had already typed, rendered in SGR-8 ("conceal"), purely so the
list/hint visually lined up under the real input without being duplicated —
raising a portability question (some terminals don't honor SGR 8, and would
show the typed text a second time).

**Resolved for the hint:** per the new "always show the literal usage line"
design (see story 13), `showArgumentHint` no longer conceals or substitutes
anything — it always renders the full, literal usage string, so there's no
alignment trick left to worry about for this display. `showSuggestionList`
still uses SGR-8 concealment for its own alignment purposes; that's now the
*only* place story 12's question would still apply, and it's unchanged by this
round of fixes.

---

### 13. ✅ (redesigned) Do the list and the hint *look* like the same feature?

**Was:** the list highlighted the selected item in yellow with a `→` and
grayed out the rest, while the hint concealed already-typed argument text and
substituted the user's literal characters for the matching placeholder tokens
— two fairly different visual languages sharing one area.

**Redesign applied:** at the user's request, `showArgumentHint` now always
renders the *entire* usage string literally (e.g. `/gamemode <mode>
[<target>]`) — nothing is concealed or substituted — with only the argument
the user is currently editing rendered in bold white; the command prefix and
every other argument token are gray. This sidesteps the original "do these
read as one feature" question by making the hint simpler and more literal
rather than by matching the list's yellow/arrow styling — the hint no longer
tries to visually mirror what the user typed at all, it just always shows the
command's full shape and points at where you are in it.

---

## Suggested next step

Stories **9, 10, 11 are now fixed**, **12/13 resolved** by redesigning the hint
to always show the literal usage string (bolding only the argument currently
being edited, instead of concealing/substituting typed text), **1 revised and
implemented** around "single resolved usage line" (parsed from the `cmdusage`
response, not item count), and **4 implemented** as sticky usage caching
(`usageCoversLine`) plus pause-point fetching — which in turn made **6** mostly
moot (the pause-point fetch usually beats the cycling-mode prefetch to it). See
each story above for what changed.

What's left: **3** ("what fills the gap during a transition") is still an open
judgment call — worth watching for in actual use now that 1/4 are settled and
the gap should be rarer/shorter. **8** (hint height changing between 1 and 2
lines) is a similar "watch and see" — both are softer UX-feel questions that
are easier to judge once the bigger behavioral pieces are in place and stable.
