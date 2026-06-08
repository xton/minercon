# Minecraft RCON Terminal

A full-featured RCON client for Minecraft servers — available both as a
**VS Code extension** (integrated terminal panel) and as a **standalone CLI
tool** (`rcon-minecraft`) that runs in any terminal.

![Version](https://img.shields.io/badge/version-3.0.0-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.95.0-green)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

---

## Features

**Command completion**
- Real-time suggestions as you type, cycling with Tab / Shift+Tab
- Argument hints showing the full usage signature of the current command
- Works with vanilla, Bukkit/Spigot/Paper, and plugin-extended servers
- When the [RconTabComplete plugin](plugin/) is installed on your server,
  completions come directly from the server (fastest, most accurate). Without
  it, the extension builds a local command tree by crawling `/help` output once
  per server and caching it.

**Emacs-style line editing**
- Full cursor movement, word-jump, selection, and kill/yank (kill ring shared
  with system clipboard in VS Code; in-process kill ring in the CLI)
- Scrollable command history, persistent across reconnects

**Minecraft color codes** — server responses render with full `§` color support

**Robust connection handling** — exponential-backoff auto-reconnect on drop;
TCP keepalive to detect silent disconnects

**No response truncation** — custom RCON protocol implementation handles
fragmented multi-packet responses correctly (vanilla server `/help` returns
300+ commands in full)

---

## Server setup

Add these lines to `server.properties` and restart:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=your-secure-password
```

The password is only needed at connect time and is never written to disk by
this tool.

---

## VS Code extension

### Installation

Search **"Minecraft RCON Terminal"** in the VS Code Extensions panel, or
install from a `.vsix` file:

```
Ctrl+Shift+P → Extensions: Install from VSIX...
```

### Connecting

| Command (Ctrl+Shift+P) | Description |
|---|---|
| Minecraft RCON: Connect to Server | Connect using saved defaults, or prompt if none saved |
| Minecraft RCON: Connect with New Credentials | Always prompt for host, port, and password |
| Minecraft RCON: Save Current Connection as Default | Save the current connection's host and port; password goes to VS Code's secure secret storage |

You can also open a terminal via the **Terminal** menu → **New Terminal** →
select **Minecraft Server** from the terminal profile picker.

Multiple RCON terminals can be open simultaneously, each to a different server.

### VS Code settings

```json
{
  "minecraftRcon.defaultHost": "localhost",
  "minecraftRcon.defaultPort": 25575
}
```

The password is not stored in settings — it lives in VS Code's encrypted
secret storage.

---

## CLI tool

### Installation

```sh
npm install -g minecraft-rcon
```

Or, after cloning and building locally:

```sh
npm run compile
node out/rcon-minecraft --help
```

### Usage

```
rcon-minecraft [host] [port] [options]

Options:
  -p, --password <pw>   RCON password
  --save                Save host/port to ~/.config/minecraft-rcon/config.json
  --log-file <path>     Write log output to a file instead of stderr
  -h, --help            Show help

Environment variables:
  MCRCON_PASSWORD       RCON password (used when --password is not given)
  MCRCON_LOG_FILE       Log file path (used when --log-file is not given)
```

**Password handling:** the CLI never writes the password to disk. Supply it
with `--password`, the `MCRCON_PASSWORD` environment variable, or leave both
unset and you will be prompted with masked input.

**Saved host/port:** `--save` writes host and port (never the password) to
`~/.config/minecraft-rcon/config.json`. On subsequent invocations, those
values are used as defaults so you can just run `rcon-minecraft` with no
arguments.

**Kill/yank:** the CLI uses an in-process kill ring (Ctrl+K stashes text;
Ctrl+Y yanks it back). The kill ring is not connected to the system clipboard.
Ctrl+X / Ctrl+C-with-selection do the same within the session.

**Log output:** diagnostic messages go to stderr by default, colored by level.
Use `--log-file` to redirect them to a file (useful when stderr would
interfere with piped output).

### Quick examples

```sh
# One-off connection (prompts for password)
rcon-minecraft localhost 25575

# Password from environment
MCRCON_PASSWORD=secret rcon-minecraft mc.example.com

# Save host/port for future sessions
rcon-minecraft mc.example.com 25575 --password secret --save

# Next time, no arguments needed
rcon-minecraft
```

---

## Keyboard shortcuts

### Navigation and completion

| Key | Action |
|---|---|
| `Tab` | Fetch / cycle to next suggestion |
| `Shift+Tab` | Cycle to previous suggestion |
| `Up` / `Ctrl+P` | Previous command in history (or move up in suggestion list) |
| `Down` / `Ctrl+N` | Next command in history (or move down in suggestion list) |
| `Page Up` / `Page Down` | Page through suggestion list |
| `Esc` | Close suggestion list; if already closed, clear the line |
| `Enter` | Submit the current command |

### Cursor movement

| Key | Action |
|---|---|
| `Left` / `Ctrl+B` | Move left one character |
| `Right` / `Ctrl+F` | Move right one character |
| `Ctrl+Left` / `Alt+B` | Move left one word |
| `Ctrl+Right` / `Alt+F` | Move right one word |
| `Home` / `Ctrl+A` | Move to start of line |
| `End` / `Ctrl+E` | Move to end of line |

### Selection

| Key | Action |
|---|---|
| `Shift+Left` | Extend selection left |
| `Shift+Right` | Extend selection right |
| `Ctrl+Shift+Left` | Extend selection left by word |
| `Ctrl+Shift+Right` | Extend selection right by word |
| `Shift+Home` | Select to start of line |
| `Shift+End` | Select to end of line |

### Editing

| Key | Action |
|---|---|
| `Backspace` | Delete character before cursor |
| `Delete` | Delete character after cursor |
| `Ctrl+T` | Transpose characters around cursor |
| `Ctrl+K` | Kill (cut) from cursor to end of line → kill ring |
| `Ctrl+U` | Kill from cursor to start of line → kill ring |
| `Ctrl+W` / `Alt+Backspace` | Kill word before cursor → kill ring |
| `Alt+D` | Kill word after cursor → kill ring |
| `Ctrl+Y` | Yank (paste) from kill ring |
| `Ctrl+X` | Cut selection → kill ring |
| `Ctrl+C` | Copy selection → kill ring (if text selected); otherwise echo `^C` and clear line |
| `Ctrl+V` | Paste from kill ring |

In VS Code mode the kill ring is the system clipboard, so killed/copied text
can be pasted into other applications. In the CLI the kill ring is
session-local.

### Terminal control

| Key | Action |
|---|---|
| `Ctrl+L` | Clear screen and redraw |
| `Ctrl+D` | Disconnect and exit |

---

## Built-in commands

These are handled by the terminal itself and never sent to the server.

| Command | Description |
|---|---|
| `/help` | Show this list of built-in commands and keyboard shortcuts |
| `/clear` | Clear the terminal screen |
| `/reconnect` | Manually reconnect to the server |
| `/disconnect` | Disconnect (stays open; use `Ctrl+D` to also exit) |
| `/reload-commands` | Force a fresh crawl of the server's command tree (local mode only) |
| `/clear-cache` | Delete the cached command tree for this server (local mode only) |
| `/cache-info` | Show the age and location of the cached command tree |

Any command that does **not** start with `/`, or that starts with `/` but is
not in the list above, is sent directly to the server as an RCON command.

---

## Tab completion modes

The terminal detects which mode to use automatically when it first connects.

**Plugin mode** (preferred) — requires the [RconTabComplete plugin](plugin/)
installed on your server. Completions are fetched live from the server as you
type, identical to in-game tab completion.

**Local mode** (fallback) — the terminal fetches and parses your server's
`/help` output once, builds a command tree, and caches it to disk. Subsequent
connections load from cache (nearly instant). Use `/reload-commands` to
refresh after a server update.

Cache location:
- VS Code: `<extension global storage>/command-cache/<host>_<port>.json`
- CLI: `~/.config/minecraft-rcon/command-cache/<host>_<port>.json`

---

## Building and installing the RconTabComplete plugin

The server-side plugin lives in [`plugin/`](plugin/). It requires Java 21 and
a Paper 1.21+ server.

**Build:**

```sh
cd plugin
./gradlew build
```

The built jar ends up at `plugin/build/libs/paper-tabcomplete-1.0.0.jar`.

**Install:** drop the jar into your server's `plugins/` directory and restart.
No configuration is needed — the plugin activates automatically and exposes the
`/tabcomplete` and `/cmdusage` RCON commands that this client uses.

---

## Troubleshooting

**"Connection refused"** — verify `enable-rcon=true` in `server.properties`
and that the RCON port is not blocked by a firewall.

**"Authentication failed"** — double-check `rcon.password` in
`server.properties`. Passwords are case-sensitive.

**Autocomplete not working in local mode**
1. `/clear-cache` to discard the old tree
2. `/reload-commands` to re-crawl
3. Check that your account has permission to run `/help` on the server
4. In VS Code, check View → Output → Minecraft RCON for crawl diagnostics

**Truncated responses** — this was a bug in versions before v2.0, which used
an external library with a 4096-byte limit. The current implementation has no
such limit.

**Suggestion display looks wrong** — try `/clear` to redraw the screen. If
the issue persists in the CLI, ensure your terminal reports correct dimensions
(`echo $COLUMNS $LINES`).

---

## Contributing

```sh
git clone https://github.com/xton/Minecraft-rcon.git
cd Minecraft-rcon
npm install
npm run compile
npm test
```

The test suite runs inside VS Code's extension host. Run it with `npm test`; no
live server is required — the RCON layer has a record/replay fixture harness.

See [CHANGELOG.md](CHANGELOG.md) for version history and
[CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

---

## Acknowledgements

This project began as [jaketcooper/Minecraft-rcon](https://github.com/jaketcooper/Minecraft-rcon),
which provided the initial RCON protocol implementation and VS Code extension
scaffold. The interactive terminal experience, tab completion, line editing, and
standalone CLI were developed from there with significant help from
[Claude](https://claude.ai).

---

## License

MIT — see [LICENSE](LICENSE).
