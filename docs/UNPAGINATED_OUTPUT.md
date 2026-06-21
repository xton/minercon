# Unpaginated RCON command output (plugin-side de-pagination)

## Problem

Paper/Spigot's RCON terminal paginates most Bukkit-layer command output into
tiny pages (the `§e--------- §fHelp: Index (1/21) ...` style headers, ~9 lines
per page). `/help` is the worst offender, but any Bukkit/plugin command that
routes through `ChatPaginator` behaves the same way. Reading anything over RCON
becomes a page-by-page slog.

## Root cause (from the Bukkit/Paper source)

Pagination is **per command**, decided by the *type* of the `CommandSender`, not
by any RCON-global setting. The canonical case is Bukkit's `HelpCommand`
([`HelpCommand.java`](https://github.com/Bukkit/Bukkit/blob/master/src/main/java/org/bukkit/command/defaults/HelpCommand.java)):

```java
if (sender instanceof ConsoleCommandSender) {
    pageHeight = ChatPaginator.UNBOUNDED_PAGE_HEIGHT;   // no pagination
    pageWidth  = ChatPaginator.UNBOUNDED_PAGE_WIDTH;
} else {
    pageHeight = ChatPaginator.CLOSED_CHAT_PAGE_HEIGHT - 1;          // = 9 lines
    pageWidth  = ChatPaginator.GUARANTEED_NO_WRAP_CHAT_PAGE_WIDTH;   // = 55 cols
}
```

The condition for "no pagination" is literally **`sender instanceof
ConsoleCommandSender`**. And the RCON sender is *not* one:

- `ConsoleCommandSender extends CommandSender, Conversable`
- [`RemoteConsoleCommandSender extends CommandSender`](https://github.com/Bukkit/Bukkit/blob/master/src/main/java/org/bukkit/command/RemoteConsoleCommandSender.java)
  — a **sibling**, not a subtype.

So the physical server console (`ConsoleCommandSender`) gets unbounded output,
while RCON (`CraftRemoteConsoleCommandSender`) falls into the 9-line branch.
`CLOSED_CHAT_PAGE_HEIGHT = 10` is hardcoded in
[`ChatPaginator`](https://github.com/Bukkit/Bukkit/blob/master/src/main/java/org/bukkit/util/ChatPaginator.java).

Vanilla Brigadier commands do **not** self-paginate (this is why
`minecraft:help` already comes back in one shot — see
`docs/NO_PLUGIN_HELP_CRAWL.md`). The problem is confined to the Bukkit layer.

Aside: the project's existing `cmdusage` command already side-steps this by
reading `HelpTopic.getFullText(sender)` and emitting it raw via `sendMessage`
(`paper-plugin/.../TabCompletePlugin.java` `handleUsageCommand`). Pagination
only happens *inside* commands that call `ChatPaginator`; a plain `sendMessage`
is never paginated. That is the seam this feature generalizes.

## Chosen approach

**Option A — a plugin command that re-dispatches the wrapped command as a
`ConsoleCommandSender` and captures its output**, returning it unpaginated in a
single RCON response.

Decisions (agreed, as implemented):

- **Auto-wrap all commands in plugin mode by default, with two config
  toggles.** When the server tab-complete plugin is present *and* exposes
  `rcat`, the terminal transparently routes every server-bound command through
  it. Two `minercon.*` settings (both default-on) opt out:
  `minercon.unpaginateOutput` (stop wrapping → server pages return) and
  `minercon.terminalPager` (stop paging → dump tall output). Wired through the
  same path as `historySize`: `package.json` → `src/extension.ts` (env vars
  `MCRCON_UNPAGINATE`/`MCRCON_PAGER`) → `src/cli.ts` (`--no-unpaginate`/
  `--no-pager`) → `RconSessionHost` fields.
- **Add a client-side pager that respects the real terminal size.** Option A
  removes the *server's* hardcoded 9-line pagination, but a full `help` dump is
  still hundreds of lines. The terminal pages large output itself at the user's
  actual screen height. The pager is **append-only (`more`-style)** so the paged
  output stays in the terminal scrollback after exit — see "Client-side pager".
- **Fabric: no mod change.** Fabric/vanilla are pure Brigadier with no
  `ChatPaginator`; `/help` is already one-shot. The `rcat` capability probe
  finds no command on Fabric, so `supportsUnpaginate` stays false and the client
  never wraps. The client pager still applies. Covered by a functional test.
- **Defer option C** (client-side detect-and-fetch-all-pages for the no-plugin
  path). Tracked as future work; not in this change — but the pager built here
  is source-agnostic (`LineSource`), so option C later feeds the same pager.

### Critical design constraint: route by command type

A fake `ConsoleCommandSender` only captures output for **Bukkit-layer
commands**. Vanilla commands go through `VanillaCommandWrapper.getListener(sender)`,
which — for a `ConsoleCommandSender` — builds an NMS `CommandSourceStack` from
`getServer().createCommandSourceStack()`. That source sends feedback to the
**server console**, *not* back to our Bukkit sender, so a blind wrap-everything
would silently swallow all vanilla command output.

Therefore the plugin command **routes by command type**, decided *before*
dispatch (never double-dispatch — that would run state-changing commands twice):

| Wrapped command resolves to…                | Routing                                                        | Why |
|---|---|---|
| Bukkit `HelpCommand` / `PluginCommand` / any non-vanilla `Command` | dispatch via a **console-proxy** sender, capture, return | These are the ones that paginate; their output flows through Bukkit `sendMessage`, which the proxy captures. `instanceof ConsoleCommandSender` ⇒ unbounded. |
| `VanillaCommandWrapper` (vanilla command)   | dispatch via the **original RCON sender** unchanged           | Vanilla commands don't paginate; their output already flows back through the RCON NMS source into the response buffer. Proxying would lose it. |
| unknown command (`getCommand` ⇒ null)       | dispatch via the **original RCON sender**                     | Let the server emit its normal "Unknown command" message. |

Vanilla-wrapper detection must avoid a hard `craftbukkit` import (Spigot builds
against `spigot-api` only): check `cmd.getClass().getSimpleName()` against
`"VanillaCommandWrapper"` (and treat a `getClass().getName()` containing
`org.bukkit.craftbukkit` + `VanillaCommandWrapper` as the match). This works
identically on Paper and Spigot.

### The console-proxy sender

Implement a capturing sender that **`instanceof ConsoleCommandSender`** is true
for, delegating all real behavior to `Bukkit.getConsoleSender()` and collecting
output instead of printing it. A `java.lang.reflect.Proxy` over
`new Class[]{ ConsoleCommandSender.class }` is the cleanest form:

- Every invoked method delegates to the real `Bukkit.getConsoleSender()` …
- …**except** methods named `sendMessage` / `sendRawMessage` / `sendMessage`
  Adventure overloads, whose arguments are serialized to a legacy `§`-coded
  string and appended to a capture buffer (and **not** forwarded, so nothing is
  printed to the real server console).

Because the proxy delegates `getServer`, `getName`, `isOp`, `hasPermission`,
etc. to the real console sender, all `instanceof`, permission, and identity
behavior matches the console. **No privilege escalation:** the RCON sender
already runs at console/op level, so dispatching as console grants nothing new.

Component serialization differs per platform (separate plugin codebases, so this
is fine):

- **Paper:** `sendMessage` overloads may carry Adventure `Component`s. Serialize
  with the bundled `LegacyComponentSerializer.legacySection().serialize(component)`.
  Also handle plain `String` overloads.
- **Spigot:** handle `String` overloads and `spigot().sendMessage(BaseComponent…)`
  via `net.md_5.bungee.api.chat.BaseComponent.toLegacyText(...)`. (Bukkit's
  `HelpCommand` uses `String` `sendMessage`, so the `String` path is the one
  that matters for help; component paths cover plugin commands that use them.)

Keep `§` color codes intact — the client already runs output through
`ansi.formatMinecraftColors`.

### Plugin command surface

- New command **`rcat`** (mnemonic: "rcon — return full/cat output"),
  registered in both plugins' `plugin.yml` alongside `tabcomplete`/`cmdusage`.
- `rcat <command...>` → reconstruct the wrapped command as `String.join(" ",
  args)`, route per the table above, return captured output (one `sendMessage`
  to the original RCON sender).
- `rcat` with **no args** → emit a probe/usage marker line (see client probe
  below), mirroring how `tabcomplete` returns its usage banner.
- On any `Throwable` during the proxy path, **fall back** to dispatching the
  original command via the original RCON sender (never worse than today's
  paginated behavior) and log a warning server-side.

### Multi-packet responses

Unbounded `help` output is large (the comparable `minecraft:help` blob is
~8 KB, exceeding one 4096-byte RCON packet). `RconController`/`RconProtocol`
already reassemble multi-packet responses (see `docs/NO_PLUGIN_HELP_CRAWL.md`
and the rcon-fence handling), so the single large response returns intact. A
functional test asserts a representative large `rcat help` arrives whole.

## Client integration (`src/`)

1. **Capability probe.** Plugin presence is already detected in
   `RconSession.detectAndInitialize()` via the `tabcomplete` probe
   (`TAB_COMPLETE_PROBE_MARKER`). Add a parallel one-shot `rcat` probe there:
   send `rcat`, check the response for a new `RCAT_PROBE_MARKER` constant. Store
   the result as `private supportsUnpaginate: boolean`. This guards against
   version skew (an older plugin jar without `rcat`): if the marker is absent,
   `supportsUnpaginate` stays `false` and the client never wraps.
2. **Wrap in `executeCommand`** (`src/rconSession.ts:~849`). Replace the bare
   `controller.send(command)` with: if `this.pluginMode && this.supportsUnpaginate`,
   send `` `rcat ${command}` ``; otherwise send `command` unchanged. Extract the
   decision into a tiny pure helper, e.g.
   `wrapForUnpagination(command: string, supported: boolean): string`, so it is
   unit-testable without the session.
3. **No double-wrapping of internal sends.** The `tabcomplete`/`cmdusage`
   probes and completion fetches go through their own code paths (not
   `executeCommand`), so they are unaffected. The built-in `.`-commands are
   handled before the server send and are likewise unaffected.
4. **Marker stripping.** `rcat` returns the wrapped command's output verbatim
   (no added framing on the success path), so no client-side stripping is
   needed beyond what already happens. The no-arg probe marker is only ever seen
   by the probe, not by `executeCommand`.

## Client-side pager (respect real terminal size)

With de-pagination on, `executeCommand` can receive an arbitrarily long
response. Today it splits on `\n` and writes every line (`src/rconSession.ts`
~`849-866`), with only a coarse `LARGE_OUTPUT_LINE_THRESHOLD = 10` hint used to
clear the suggestion display. Replace the naive dump for large output with a
`less`-style pager that uses the terminal's **real** height.

### Why this is the right pairing

The server pagination was bad because it was hardcoded to 9 lines regardless of
the client. The fix is two halves: (A) stop the server from paginating, then
(B) let the *client* — which actually knows its window size via
`SessionHost.dimensions()` — paginate at the correct height, interactively.

### Trigger and state

- After a command completes, if the formatted output fits in the visible area
  (`lines.length <= rows - 1`), write it directly as today.
- Otherwise enter **pager mode**: a `private pager: PagerState | null` field,
  mirroring the existing `historySearch` mode pattern. While `pager` is set,
  `handleInput` routes keystrokes to the pager (an early branch alongside the
  existing `if (this.historySearch)` check at `~399`) instead of the line
  editor; the normal prompt is not shown until the pager exits.
- `isExecutingCommand` is cleared as usual when the command returns; the pager
  is a *post-output* interaction, so it must **not** be gated by
  `isExecutingCommand` (unlike line input). Drive it through its own branch.

### Rendering — append-only, scrollback-preserving (`src/pager.ts`)

The paged output **must remain in the terminal scrollback after the pager
exits.** A `less`-style repaint/alternate-screen pager would restore the screen
and wipe it (a regression). So the pager is **append-only**: it only ever prints
*forward*, below what's already shown. Implemented in `Pager`:

- Print the first screenful of lines normally (they enter scrollback), then draw
  a one-line status prompt on the cursor's row:
  `-- More -- (43/512)  Space: more · G: all · q: quit`.
- On advance, **erase the status line in place** (`\r\x1b[K`) and print the next
  batch below it. **Never** clear the screen (`\x1b[2J`) or switch to the
  alternate buffer (`\x1b[?1049h`) — that is the scrollback guarantee, asserted
  by `src/test/pager.test.ts`.
- Page height = `dimensions()?.rows ?? FALLBACK_ROWS` minus one status row,
  recomputed **every batch** so resizes "just work".
- Long lines: the terminal soft-wraps them; the pager only needs to *count* how
  many visual rows each occupies toward the page height. `visualRowCount(line,
  columns)` strips ANSI (`stripAnsi`) before measuring, so `§`/SGR codes don't
  count and — since we never split the line — are never broken.

### Keybindings (forward-only)

Backward viewing is the terminal's **own scrollback** (which works precisely
because nothing is ever cleared), so the pager has no back-scroll keys:

| Keys | Action |
|---|---|
| Space, `f`, PageDown (`\x1b[6~`) | next page |
| Enter, `j`, ↓ (`\x1b[B`) | down one line |
| `G` | print all remaining at once |
| `q`, Ctrl+C (`\x03`) | stop; leave shown content, restore prompt |

On exit (or reaching the end) the status line is erased; the session writes a
newline and `showPrompt()` via the pager's `onDone` callback.

### Source-agnostic design (forward-compat with option C)

The pager consumes a `LineSource` (`length()` / `lineAt(i)`, with room for a
future async `ensureUpTo(i)`), not a fixed array. Option A supplies an in-memory
`ArrayLineSource` over the full response. When option C lands, a
`LazyPageLineSource` that fetches `cmd <n>` just-in-time as the user pages slots
into the *same* pager UI unchanged.

### Disabling

Two `minercon.*` config settings, both default-on (see "Decisions"):
`minercon.unpaginateOutput` disables the `rcat` wrap (server pages return);
`minercon.terminalPager` disables paging (tall output is printed all at once).
CLI equivalents: `--no-unpaginate`, `--no-pager`.

## Edge cases & limitations (document in-code and here)

- **Async command output.** Commands that emit output from a later tick/thread
  (scheduled tasks) won't be in the buffer when dispatch returns, so `rcat` may
  capture an empty/partial result for them. `help` and the common paginators
  are synchronous. Out of scope to solve; the original-sender fallback keeps
  behavior no worse than today for the unknown/empty case is **not**
  auto-triggered (we can't distinguish "legitimately empty" from "async"), so
  this is a known limitation, noted for future work.
- **Plugin commands that gate on `instanceof Player`** rather than
  `ConsoleCommandSender` may still paginate or format for non-players when run
  as console. We fix the `ConsoleCommandSender`-checking majority (including
  `help`); we can't fix every third-party command. Documented.
- **Identity.** Wrapped Bukkit commands now see the console identity instead of
  "Rcon". Permissions are unchanged (both are console-level). Server-side audit
  logs may attribute these to console.

## Testing

### Plugin unit tests (JUnit, run by gradle `test`)

The dispatch-as-console path needs a live server, but the **pure pieces** are
extracted and unit-tested without one:

- An `OutputCapture` (or equivalently named) buffer: accumulates messages,
  joins with `\n`, preserves `§` codes. Test append/order/join.
- Component→legacy serialization helpers: Adventure is on Paper's classpath and
  `BaseComponent` on Spigot's, so construct real components and assert the
  legacy `§`-string output (paper: `LegacyComponentSerializer.legacySection()`;
  spigot: `BaseComponent.toLegacyText`).
- Vanilla-wrapper detection helper: feed it fake `Command` subclasses whose
  `getClass().getSimpleName()` is/ isn't `VanillaCommandWrapper` and assert the
  routing decision.

Wire a `test` source set + `junit-jupiter` into both `paper-plugin/build.gradle`
and `spigot-plugin/build.gradle` (`useJUnitPlatform()`). This is new test infra
for the plugins — currently they have none.

### Client unit tests (TS, existing mocha suite)

- `wrapForUnpagination`: returns `` `rcat ${cmd}` `` when supported, `cmd`
  unchanged when not; doesn't wrap empty input.
- Probe parsing: a response containing `RCAT_PROBE_MARKER` sets
  `supportsUnpaginate`; one without it leaves it false.

**Pager core** (the highest-value client tests — pure state machine, no real
terminal). Test against a fake `SessionHost` that records `write()` calls and
returns a fixed `dimensions()`:

- Enters pager only when `lines.length > rows - 1`; small output writes directly.
- First frame shows exactly `rows - 1` content lines + a status line; Space
  advances by a page; `b` goes back; bounds are clamped (no paging past
  start/end).
- `j`/`k` move one line; `g`/`G` jump to ends.
- `q` and Ctrl+C exit, leave the last frame, and restore the prompt.
- Resize: changing the fake `dimensions().rows` between keystrokes recomputes
  page height on the next render.
- ANSI-aware wrapping: a line longer than `columns` with embedded `§`/SGR codes
  counts the correct number of *visual* rows and never splits a color code.
- `LineSource` abstraction: the array-backed source returns correct
  `length()`/`lineAt(i)`; the interface admits an async `ensureUpTo` for the
  future lazy source.

### Functional tests (`src/test/functional/pluginMode.test.ts`, addonVariants = paper+plugin, spigot+plugin)

Build the plugin jar first (the suite header already documents this). Add:

- **De-pagination proof:** raw `help` response contains a `Help: Index (1/`
  pagination header; `rcat help` response does **not**, and has strictly more
  lines than the raw first page (≥ a threshold well above the 9-line page, e.g.
  > 15, and ideally ≥ raw page count × pages).
- **Completeness:** `rcat help` contains commands that the raw first page omits
  (assert several known root commands — e.g. `gamemode`, `list`, `version` —
  all present in one response).
- **Vanilla passthrough still works:** `rcat list` returns the player-count
  line; `rcat gamemode` returns a non-empty response (usage/error), proving the
  vanilla route doesn't swallow output.
- **Unknown command:** `rcat doesnotexist` returns the server's unknown-command
  message (non-empty, no plugin stack trace).
- **Large response integrity:** `rcat help` arrives as one coherent string
  (length well over a single RCON packet on a server with many commands),
  exercising multi-packet reassembly.

Optionally extend the harness to assert the **session-level** behavior (that
`RconSession.executeCommand` wraps in plugin mode), but the unit test on
`wrapForUnpagination` + the functional `rcat` tests together cover the contract
without standing up the full terminal.

## Files touched

Plugin (×2: paper, spigot):
- `*/src/main/java/dev/rcon/tabcomplete/TabCompletePlugin.java` — register
  `rcat`, add handler, console-proxy sender, capture buffer, routing,
  component serialization, fallback.
- `*/src/main/resources/plugin.yml` — declare `rcat`.
- `*/build.gradle` — add JUnit test source set.
- `*/src/test/java/...` — new unit tests for the pure helpers.

Client:
- `src/rconSession.ts` — `RCAT_PROBE_MARKER`, `supportsUnpaginate`, probe in
  `detectAndInitialize`, wrap in `executeCommand`; route large output into the
  pager; add the `pager` mode branch in `handleInput`; pager keybindings.
- new tiny module (or colocated export) for `wrapForUnpagination` + its test.
- new `src/pager.ts` (or similar) — `PagerState`, `LineSource`/`ArrayLineSource`,
  render + key handling, ANSI-aware wrapping; pure enough to unit-test with a
  fake `SessionHost`.
- `src/test/pager.test.ts` — pager core unit tests.
- `src/test/functional/pluginMode.test.ts` — functional cases above.

Docs:
- This file.
- Cross-link from `TODO.md` / `docs/ARCHITECTURE.md` as appropriate.

## Out of scope / future work

- **Option C** (no-plugin client-side detect-and-fetch-all-pages). Deferred by
  decision. When built, it supplies a `LazyPageLineSource` to the **same** pager
  built here (the just-in-time fetch becomes the source's `ensureUpTo`), so no
  new pager UI is needed.
- Capturing **async** command output.
- Fixing third-party commands that paginate on `instanceof Player`.
- A user-facing toggle to get raw paginated output (decided against).
</content>
