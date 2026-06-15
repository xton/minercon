// src/test/rconSession.test.ts
//
// Tests for RconSession — the host-agnostic RCON session orchestrator and
// the source-of-truth for session behavior. `cli.ts` is the only
// `RconSessionHost` implementation (the VS Code extension runs the built CLI
// as its terminal's process rather than driving a session in-process), so
// this suite — driving RconSession through a FakeHost — is the primary
// coverage for session behavior.
//
// The plugin-mode shortcut: a FakeController that answers 'tabcomplete' with
// the magic probe string causes detectAndInitialize to skip the entire
// command-tree-crawl and land immediately on the prompt.
//
// The auto-reconnect path is exercised by passing a `controllerFactory` to
// `createHarness`/`RconSession`, so `ConnectionManager.attemptReconnect` gets
// a fresh `FakeController` instead of constructing a real `RconController`
// (see "connection lost → auto-reconnect → onReconnected reloads commands").

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../logger';
import { RconController } from '../rconClient';
import { RconSession, RconSessionHost } from '../rconSession';
import { ControllerFactory } from '../connectionManager';
import { FakeController, PLUGIN_PROBE_RESPONSE, SendImpl, defaultSend, waitUntil } from './support/fakeController';

function silentLogger(): Logger {
    return { error: () => undefined, warning: () => undefined, info: () => undefined, debug: () => undefined };
}

interface Harness {
    session: RconSession;
    controller: FakeController;
    writes: string[];
    closes: number[];
    output(): string;
}

/** Feeds `text` through `handleInput` one character at a time, like a real terminal would. */
function type(h: Harness, text: string): void {
    for (const ch of text) {
        h.session.handleInput(ch);
    }
}

/** Opens the session and waits for the server-side plugin probe to land it on the prompt. */
async function openInPluginMode(h: Harness): Promise<void> {
    h.session.open();
    await waitUntil(() => h.output().includes('tab-complete plugin detected'));
    h.writes.length = 0;
    h.controller.sendCalls.length = 0;
}

suite('RconSession', () => {
    let storageDir: string;
    let activeSession: RconSession | undefined;

    setup(() => {
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-session-test-'));
        activeSession = undefined;
    });

    teardown(() => {
        activeSession?.close();
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    function createHarness(sendImpl: SendImpl = defaultSend, dimensions: () => { columns: number; rows: number } | undefined = () => undefined, historySize?: number, disablePlugin?: boolean, controllerFactory?: ControllerFactory): Harness {
        const controller = new FakeController(sendImpl);
        const writes: string[] = [];
        const closes: number[] = [];
        let pasteboard = '';

        const sessionHost: RconSessionHost = {
            write: (text) => writes.push(text),
            close: (code) => closes.push(code),
            clipboard: {
                readText:  () => Promise.resolve(pasteboard),
                writeText: (text) => { pasteboard = text; return Promise.resolve(); },
            },
            cacheDir: storageDir,
            dimensions,
            historySize,
            disablePlugin,
        };

        const session = new RconSession(
            controller as unknown as RconController,
            'localhost', 25575, 'pw',
            silentLogger(),
            sessionHost,
            controllerFactory,
        );
        activeSession = session;
        return { session, controller, writes, closes, output: () => writes.join('') };
    }

    test('open writes the welcome banner, probes for the tab-complete plugin, and switches to plugin mode', async () => {
        const h = createHarness();
        h.session.open();
        await waitUntil(() => h.output().includes('tab-complete plugin detected'));

        const out = h.output();
        assert.ok(out.includes('Minercon Terminal'), 'shows the welcome banner');
        assert.ok(out.includes('localhost:25575'), 'reports the connection target');
        assert.ok(h.controller.sendCalls.includes('tabcomplete'), 'probes for the server-side plugin');
        assert.ok(out.includes('\x1b[32m>\x1b[0m '), 'lands on the connected prompt');
    });

    test('disablePlugin skips the tab-complete plugin probe and goes straight to local completions', async () => {
        const h = createHarness(defaultSend, () => undefined, undefined, true);
        h.session.open();

        await waitUntil(() => h.output().includes('Loading server commands'));

        assert.ok(h.output().includes('plugin probe disabled'), 'reports that the probe was skipped');
        assert.ok(!h.controller.sendCalls.includes('tabcomplete'), 'never probes for the server-side plugin');
    });

    test('typed characters assemble into a line, and Enter sends it as an RCON command', async () => {
        const h = createHarness(cmd => cmd === 'tabcomplete' ? PLUGIN_PROBE_RESPONSE : 'Teleported Steve to 0 64 0');
        await openInPluginMode(h);

        type(h, 'tp Steve 0 64 0');
        h.session.handleInput('\r');

        await waitUntil(() => h.controller.sendCalls.includes('tp Steve 0 64 0'));
        await waitUntil(() => h.output().includes('Teleported Steve to 0 64 0'));
        assert.ok(h.output().includes('\x1b[32m>\x1b[0m '), 'shows the prompt again once the command completes');
    });

    test('an empty server reply is rendered as "(no response)"', async () => {
        const h = createHarness(cmd => cmd === 'tabcomplete' ? PLUGIN_PROBE_RESPONSE : '');
        await openInPluginMode(h);

        type(h, 'say nothing');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('(no response)'));
    });

    test('Escape clears the current line, so Enter on it sends nothing', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'this should be discarded');
        h.session.handleInput('\x1b');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('\x1b[32m>\x1b[0m '));
        assert.deepStrictEqual(h.controller.sendCalls, [], 'the discarded line was never sent');
    });

    test('Ctrl+C on a non-empty line echoes ^C and clears it without sending anything', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'unsent');
        h.session.handleInput('\x03');
        await waitUntil(() => h.output().includes('^C\r\n'));

        h.session.handleInput('\r');
        await waitUntil(() => h.output().includes('\x1b[32m>\x1b[0m '));
        assert.deepStrictEqual(h.controller.sendCalls, [], 'nothing was sent to the server');
    });

    test('Ctrl+L clears the screen and redraws the banner, prompt, and in-progress line', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'partial');
        h.writes.length = 0;
        h.session.handleInput('\x0c');

        const out = h.output();
        assert.ok(out.includes('\x1b[2J\x1b[H'), 'clears the screen');
        assert.ok(out.includes('Minercon Terminal'), 'redraws the welcome banner');
        assert.ok(out.includes('partial'), 'redraws the in-progress line');
    });

    test('Tab drives the completion engine, which fetches through the active (server-side) backend', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/say hel');
        h.session.handleInput('\t');

        await waitUntil(() => h.controller.sendCalls.includes('tabcomplete say hel'));
    });

    test('when the typed line wraps onto a second terminal row, the suggestion popup\'s cursor restoration accounts for the wrap', async () => {
        const h = createHarness(
            cmd => cmd === 'tabcomplete' ? PLUGIN_PROBE_RESPONSE
                 : cmd.startsWith('tabcomplete ') ? 'minecraft:diamond_sword\nminecraft:diamond_pickaxe'
                 : '',
            () => ({ columns: 20, rows: 10 }),
        );
        await openInPluginMode(h);

        const line = '/give @a minecraft:diamond';
        type(h, line);
        h.session.handleInput('\t');

        await waitUntil(() => h.output().includes('diamond_sword'));

        // Tab auto-applies the first match, extending the line - read it back
        // rather than re-deriving applySuggestion's behavior here.
        const finalLine = (h.session as unknown as { lineEditor: { line: string } }).lineEditor.line;

        // promptWidth ("> ") + cursor (end of line) — the raw, wrap-unaware offset.
        const rawColumn = 2 + finalLine.length;
        const wrappedColumn = rawColumn % 20;
        assert.notStrictEqual(wrappedColumn, rawColumn, 'sanity check: this line is long enough to wrap on a 20-column terminal');

        assert.ok(h.output().includes(`\x1b[${wrappedColumn}C`), 'cursor restoration uses the column on the wrapped row');
        assert.ok(!h.output().includes(`\x1b[${rawColumn}C`), 'cursor restoration does not use the raw, un-wrapped offset');
    });

    test('/help prints the built-in command reference without touching the server', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/help');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('Built-in Commands'));
        assert.ok(h.output().includes('/reconnect'), 'lists the built-in commands');
        // Typing "/help" triggers live-as-you-type "tabcomplete -" fetches
        // (any "/..." line does — exercised by the Tab test). What matters here
        // is that the command itself never reaches the server as an RCON command.
        const rconCommands = h.controller.sendCalls.filter(c => !c.startsWith('tabcomplete'));
        assert.deepStrictEqual(rconCommands, [], 'the built-in command is handled locally, not sent to the server');
    });

    test('/clear clears the screen without sending an RCON command', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/clear');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('\x1b[2J\x1b[H'));
        const rconCommands = h.controller.sendCalls.filter(c => !c.startsWith('tabcomplete'));
        assert.deepStrictEqual(rconCommands, [], 'the built-in command is handled locally, not sent to the server');
    });

    test('/disconnect tears down the connection through the connection manager', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/disconnect');
        h.session.handleInput('\r');

        await waitUntil(() => h.controller.disconnectCalls > 0);
        assert.ok(h.output().includes('Connection closed'), 'reports the closed connection');
    });

    test('executeCommand refuses to run RCON commands while disconnected', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/disconnect');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.disconnectCalls > 0);
        h.writes.length = 0;
        h.controller.sendCalls.length = 0;

        type(h, 'say hi');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('Not connected'));
        assert.deepStrictEqual(h.controller.sendCalls, [], 'the command was never sent');
    });

    test('a failed command on a still-live connection shows the error without reconnecting', async () => {
        // A slow command's "Command timeout" used to substring-match 'timeout'
        // and tear down a healthy connection. The signal is the controller's
        // actual socket state, not the error text.
        const h = createHarness(cmd => {
            if (cmd === 'tabcomplete') { return PLUGIN_PROBE_RESPONSE; }
            throw new Error('Command timeout: list');
        });
        await openInPluginMode(h);

        type(h, 'list');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('Error: Command timeout: list'));
        assert.ok(!h.output().includes('Connection lost'), 'a live connection must not be torn down');
    });

    test('a failed command on a dead connection reports the loss and starts auto-reconnect', async () => {
        const h = createHarness(cmd => {
            if (cmd === 'tabcomplete') { return PLUGIN_PROBE_RESPONSE; }
            throw new Error('Connection closed');
        });
        await openInPluginMode(h);
        h.controller.connected = false; // the socket died out from under us

        type(h, 'list');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('Connection lost. Auto-reconnecting...'));
    });

    test('connection lost → auto-reconnect → onReconnected reloads commands', async () => {
        let reconnectController: FakeController | undefined;
        const h = createHarness(
            cmd => {
                if (cmd === 'tabcomplete') { return PLUGIN_PROBE_RESPONSE; }
                throw new Error('Connection closed');
            },
            () => undefined,
            undefined,
            undefined,
            () => {
                reconnectController = new FakeController(defaultSend);
                return reconnectController as unknown as RconController;
            }
        );
        await openInPluginMode(h);
        h.controller.connected = false; // the socket died out from under us

        type(h, 'list');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('Connection lost. Auto-reconnecting...'));
        // reportConnectionLost's auto-reconnect fires after a 1s delay.
        await waitUntil(() => h.output().includes('Reconnected successfully'), 3000);

        assert.ok(reconnectController, 'controllerFactory built the replacement controller');
        await waitUntil(() => h.output().includes('Failed to load commands'), 3000);
        assert.ok(
            reconnectController!.sendCalls.some(c => c.includes('help')),
            'onReconnected reloaded the command tree through the new controller'
        );
    });

    test('Ctrl+K stashes killed text so Ctrl+Y yanks it back', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        // Kill to end of line, then yank it back
        type(h, 'hello world');
        h.session.handleInput('\x01'); // Ctrl+A: move to start
        h.session.handleInput('\x0b'); // Ctrl+K: kill to end → stashes 'hello world'
        h.writes.length = 0;
        h.session.handleInput('\x19'); // Ctrl+Y: yank from kill stash
        await waitUntil(() => h.output().includes('hello world'));
    });

    test('close tears down the connection manager, which disconnects the controller', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        h.session.close();

        assert.ok(h.controller.disconnectCalls > 0);
    });

    test('/history prints previously run commands without sending an RCON command', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'say one');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say one'));

        type(h, 'say two');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say two'));

        h.writes.length = 0;
        h.controller.sendCalls.length = 0;

        type(h, '/history');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('say two'));
        assert.ok(h.output().includes('say one'), 'lists earlier commands too');
        const rconCommands = h.controller.sendCalls.filter(c => !c.startsWith('tabcomplete'));
        assert.deepStrictEqual(rconCommands, [], 'the built-in command is handled locally, not sent to the server');
    });

    test('/history reports when there is nothing yet', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/history');
        h.session.handleInput('\r');

        await waitUntil(() => h.output().includes('no history yet'));
    });

    test('built-in commands are recorded in history and recallable via Up, just like server commands', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/help');
        h.session.handleInput('\r');
        await waitUntil(() => h.output().includes('Built-in Commands:'));

        h.writes.length = 0;
        h.session.handleInput('\x10'); // Ctrl+P / Up: recall the last entry
        await waitUntil(() => h.output().includes('/help'));
        h.session.handleInput('\r'); // clear the recalled line again

        h.writes.length = 0;
        type(h, '/history');
        h.session.handleInput('\r');
        await waitUntil(() => h.output().includes('/help'));
    });

    test('Ctrl+R opens a search popup showing recent history, newest first', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'say one');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say one'));

        type(h, 'say two');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say two'));

        h.writes.length = 0;
        h.session.handleInput('\x12'); // Ctrl+R

        await waitUntil(() => h.output().includes('reverse-i-search'));
        const out = h.output();
        assert.ok(out.includes('say two'), 'shows the most recent command');
        assert.ok(out.includes('say one'), 'shows earlier commands too');
    });

    test('Ctrl+R then typing narrows the match list to the query', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'say hello');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say hello'));

        type(h, 'gamemode creative');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('gamemode creative'));

        h.session.handleInput('\x12'); // Ctrl+R
        h.writes.length = 0;
        type(h, 'gamemode');

        await waitUntil(() => h.output().includes('gamemode creative'));
        assert.ok(!h.output().includes('say hello'), 'no longer shows the non-matching entry');
    });

    test('Tab and Shift-Tab cycle through history search matches like Ctrl+R/Up and Down', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'say one');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say one'));

        type(h, 'say two');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say two'));

        h.session.handleInput('\x12'); // Ctrl+R: opens on the most recent entry, "say two"
        await waitUntil(() => h.output().includes('reverse-i-search'));

        h.session.handleInput('\t'); // Tab: cycle to the next-older match, "say one"
        h.writes.length = 0;
        h.session.handleInput('\r'); // accept

        assert.ok(h.output().includes('say one'), 'Tab cycled to the older match before accepting');

        h.session.handleInput('\x12'); // Ctrl+R again: opens back on "say two"
        await waitUntil(() => h.output().includes('reverse-i-search'));

        h.session.handleInput('\t');     // Tab: cycle to "say one"
        h.session.handleInput('\x1b[Z'); // Shift-Tab: cycle back to "say two"
        h.writes.length = 0;
        h.session.handleInput('\r'); // accept

        assert.ok(h.output().includes('say two'), 'Shift-Tab cycled back to the newer match before accepting');
    });

    test('Ctrl+R then Enter loads the selected match into the line without executing it', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'say hello');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say hello'));

        h.session.handleInput('\x12'); // Ctrl+R
        await waitUntil(() => h.output().includes('reverse-i-search'));
        h.controller.sendCalls.length = 0;
        h.writes.length = 0;

        h.session.handleInput('\r'); // Enter: accept the match

        assert.ok(h.output().includes('say hello'), 'loads the matched command back onto the line');
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepStrictEqual(h.controller.sendCalls.filter(c => !c.startsWith('tabcomplete')), [], 'Enter loads the line for editing, it does not run the command');
    });

    test('Ctrl+R then Escape restores the line that was being typed', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'say hello');
        h.session.handleInput('\r');
        await waitUntil(() => h.controller.sendCalls.includes('say hello'));

        type(h, 'partial input');
        h.session.handleInput('\x12'); // Ctrl+R
        await waitUntil(() => h.output().includes('reverse-i-search'));
        h.writes.length = 0;

        h.session.handleInput('\x1b'); // Escape: cancel

        assert.ok(h.output().includes('partial input'), 'restores the line that was being typed');
    });

    test('command history persists to disk and is loaded by a later session for the same server', async () => {
        const h1 = createHarness();
        await openInPluginMode(h1);

        type(h1, 'say persisted');
        h1.session.handleInput('\r');
        await waitUntil(() => h1.controller.sendCalls.includes('say persisted'));
        h1.session.close();

        const h2 = createHarness();
        await openInPluginMode(h2);

        h2.session.handleInput('\x12'); // Ctrl+R
        await waitUntil(() => h2.output().includes('reverse-i-search'));
        assert.ok(h2.output().includes('say persisted'), 'second session loaded history saved by the first');
    });

    test('a custom historySize caps both /history and what gets persisted to disk', async () => {
        const h1 = createHarness(defaultSend, () => undefined, 2);
        await openInPluginMode(h1);

        type(h1, 'say one');
        h1.session.handleInput('\r');
        await waitUntil(() => h1.controller.sendCalls.includes('say one'));

        type(h1, 'say two');
        h1.session.handleInput('\r');
        await waitUntil(() => h1.controller.sendCalls.includes('say two'));

        type(h1, 'say three');
        h1.session.handleInput('\r');
        await waitUntil(() => h1.controller.sendCalls.includes('say three'));

        h1.writes.length = 0;
        type(h1, '/history');
        h1.session.handleInput('\r');
        await waitUntil(() => h1.output().includes('say three'));
        assert.ok(h1.output().includes('say two'), 'keeps the most recent entries');
        assert.ok(!h1.output().includes('say one'), 'drops entries beyond the configured cap');
        h1.session.close();

        const h2 = createHarness(defaultSend, () => undefined, 2);
        await openInPluginMode(h2);

        h2.session.handleInput('\x12'); // Ctrl+R
        await waitUntil(() => h2.output().includes('reverse-i-search'));
        // /history was itself recorded after displaying (see handleEnter), so
        // it now occupies the second slot, evicting "say two".
        assert.ok(h2.output().includes('/history'), 'running /history itself is recorded too, and persists');
        assert.ok(h2.output().includes('say three'), 'persisted history respects the configured cap');
        assert.ok(!h2.output().includes('say two'), 'persisted history respects the configured cap');
        assert.ok(!h2.output().includes('say one'), 'persisted history respects the configured cap');
    });
});
