// src/test/rconTerminal.test.ts
//
// `RconTerminal` glues `LineEditor`, `SuggestionDisplay`, `ConnectionManager`,
// `CommandAutocomplete`, and the `completionEngine` state machine together —
// it's the orchestration `extension.ts` lacks (see that file's test, closed
// as decided-against), but with one crucial difference: putting the terminal
// in *plugin mode* (the server-side `RconTabComplete` probe succeeds) skips
// the entire command-tree-crawling startup path. What's left is a small,
// fast, fully-isolated surface — `handleInput`'s key dispatch, the
// `/`-command router in `handleEnter`, and `executeCommand`'s response/error
// handling — that's genuinely worth driving end-to-end and observing through
// `onDidWrite`, the way `lineEditor.test.ts` drives `LineEditor` through a
// `FakeHost`.
//
// One deliberate gap: we never produce a "connection lost"-shaped error from
// the fake controller. `ConnectionManager.reportConnectionLost` schedules a
// reconnect that constructs a brand-new *real* `RconController` (it isn't
// behind an injection seam — see TODO.md), which would attempt a live socket
// connection from the test run. The "not connected" guard in `executeCommand`
// is exercised instead via `/disconnect`, which is side-effect-free.

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import { RconController } from '../rconClient';
import { RconTerminal } from '../rconTerminal';

function silentLogger(): Logger {
    return { error: () => undefined, warning: () => undefined, info: () => undefined };
}

function fakeContext(storageDir: string): vscode.ExtensionContext {
    return { globalStorageUri: { fsPath: storageDir } } as unknown as vscode.ExtensionContext;
}

const PLUGIN_PROBE_RESPONSE = 'Returns tab completions for a partial command string. Usage: /tabcomplete <text>';

type SendImpl = (cmd: string) => string | Promise<string | undefined> | undefined;

function defaultSend(cmd: string): string {
    return cmd === 'tabcomplete' ? PLUGIN_PROBE_RESPONSE : '';
}

class FakeController {
    sendCalls: string[] = [];
    disconnectCalls = 0;
    private connected = true;

    constructor(private sendImpl: SendImpl) {}

    async send(cmd: string): Promise<string | undefined> {
        this.sendCalls.push(cmd);
        return this.sendImpl(cmd);
    }

    async disconnect(): Promise<void> { this.disconnectCalls++; this.connected = false; }
    async connect(): Promise<void> { this.connected = true; }
    isConnected(): boolean { return this.connected; }
}

/** Polls until `predicate` is true, or fails with a clear message after `timeoutMs`. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

interface Harness {
    terminal: RconTerminal;
    controller: FakeController;
    writes: string[];
    output(): string;
}

/** Feeds `text` through `handleInput` one character at a time, like a real terminal would. */
function type(h: Harness, text: string): void {
    for (const ch of text) {
        h.terminal.handleInput(ch);
    }
}

/** Opens the terminal and waits for the server-side plugin probe to land it on the prompt. */
async function openInPluginMode(h: Harness): Promise<void> {
    h.terminal.open(undefined);
    await waitUntil(() => h.output().includes('tab-complete plugin detected'));
    h.writes.length = 0;
    h.controller.sendCalls.length = 0;
}

suite('RconTerminal', () => {
    let storageDir: string;
    let activeTerminal: RconTerminal | undefined;

    setup(() => {
        storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-terminal-test-'));
        activeTerminal = undefined;
    });

    teardown(() => {
        activeTerminal?.close();
        fs.rmSync(storageDir, { recursive: true, force: true });
    });

    function createHarness(sendImpl: SendImpl = defaultSend): Harness {
        const controller = new FakeController(sendImpl);
        const writes: string[] = [];
        const terminal = new RconTerminal(
            controller as unknown as RconController,
            'localhost', 25575, 'pw',
            silentLogger(),
            fakeContext(storageDir),
        );
        terminal.onDidWrite(text => writes.push(text));
        activeTerminal = terminal;
        return { terminal, controller, writes, output: () => writes.join('') };
    }

    test('open writes the welcome banner, probes for the tab-complete plugin, and switches to plugin mode', async () => {
        const h = createHarness();
        h.terminal.open(undefined);
        await waitUntil(() => h.output().includes('tab-complete plugin detected'));

        const out = h.output();
        assert.ok(out.includes('Minercon Terminal'), 'shows the welcome banner');
        assert.ok(out.includes('localhost:25575'), 'reports the connection target');
        assert.ok(h.controller.sendCalls.includes('tabcomplete'), 'probes for the server-side plugin');
        assert.ok(out.includes('\x1b[32m>\x1b[0m '), 'lands on the connected prompt');
    });

    test('typed characters assemble into a line, and Enter sends it as an RCON command', async () => {
        const h = createHarness(cmd => cmd === 'tabcomplete' ? PLUGIN_PROBE_RESPONSE : 'Teleported Steve to 0 64 0');
        await openInPluginMode(h);

        type(h, 'tp Steve 0 64 0');
        h.terminal.handleInput('\r');

        await waitUntil(() => h.controller.sendCalls.includes('tp Steve 0 64 0'));
        await waitUntil(() => h.output().includes('Teleported Steve to 0 64 0'));
        assert.ok(h.output().includes('\x1b[32m>\x1b[0m '), 'shows the prompt again once the command completes');
    });

    test('an empty server reply is rendered as "(no response)"', async () => {
        const h = createHarness(cmd => cmd === 'tabcomplete' ? PLUGIN_PROBE_RESPONSE : '');
        await openInPluginMode(h);

        type(h, 'say nothing');
        h.terminal.handleInput('\r');

        await waitUntil(() => h.output().includes('(no response)'));
    });

    test('Escape clears the current line, so Enter on it sends nothing', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'this should be discarded');
        h.terminal.handleInput('\x1b');
        h.terminal.handleInput('\r');

        await waitUntil(() => h.output().includes('\x1b[32m>\x1b[0m '));
        assert.deepStrictEqual(h.controller.sendCalls, [], 'the discarded line was never sent');
    });

    test('Ctrl+C on a non-empty line echoes ^C and clears it without sending anything', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'unsent');
        h.terminal.handleInput('\x03');
        await waitUntil(() => h.output().includes('^C\r\n'));

        h.terminal.handleInput('\r');
        await waitUntil(() => h.output().includes('\x1b[32m>\x1b[0m '));
        assert.deepStrictEqual(h.controller.sendCalls, [], 'nothing was sent to the server');
    });

    test('Ctrl+L clears the screen and redraws the banner, prompt, and in-progress line', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, 'partial');
        h.writes.length = 0;
        h.terminal.handleInput('\x0c');

        const out = h.output();
        assert.ok(out.includes('\x1b[2J\x1b[H'), 'clears the screen');
        assert.ok(out.includes('Minercon Terminal'), 'redraws the welcome banner');
        assert.ok(out.includes('partial'), 'redraws the in-progress line');
    });

    test('Tab drives the completion engine, which fetches through the active (server-side) backend', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/say hel');
        h.terminal.handleInput('\t');

        await waitUntil(() => h.controller.sendCalls.includes('tabcomplete say hel'));
    });

    test('/help prints the built-in command reference without touching the server', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/help');
        h.terminal.handleInput('\r');

        await waitUntil(() => h.output().includes('Built-in Commands'));
        assert.ok(h.output().includes('/reconnect'), 'lists the built-in commands');
        // Typing "/help" itself triggers live-as-you-type "tabcomplete -" fetches
        // (any "/..." line does — that's the engine's normal typing-flow behavior,
        // exercised by the Tab test below). What we care about here is that the
        // *command itself* never reaches the server as an RCON command — it's
        // intercepted by handleEnter's built-in-command router before that.
        const rconCommands = h.controller.sendCalls.filter(c => !c.startsWith('tabcomplete'));
        assert.deepStrictEqual(rconCommands, [], 'the built-in command is handled locally, not sent to the server');
    });

    test('/clear clears the screen without sending an RCON command', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/clear');
        h.terminal.handleInput('\r');

        await waitUntil(() => h.output().includes('\x1b[2J\x1b[H'));
        // See the /help test above re: live-typing "tabcomplete -" fetches.
        const rconCommands = h.controller.sendCalls.filter(c => !c.startsWith('tabcomplete'));
        assert.deepStrictEqual(rconCommands, [], 'the built-in command is handled locally, not sent to the server');
    });

    test('/disconnect tears down the connection through the connection manager', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/disconnect');
        h.terminal.handleInput('\r');

        await waitUntil(() => h.controller.disconnectCalls > 0);
        assert.ok(h.output().includes('Connection closed'), 'reports the closed connection');
    });

    test('executeCommand refuses to run RCON commands while disconnected', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        type(h, '/disconnect');
        h.terminal.handleInput('\r');
        await waitUntil(() => h.controller.disconnectCalls > 0);
        h.writes.length = 0;
        h.controller.sendCalls.length = 0;

        type(h, 'say hi');
        h.terminal.handleInput('\r');

        await waitUntil(() => h.output().includes('Not connected'));
        assert.deepStrictEqual(h.controller.sendCalls, [], 'the command was never sent');
    });

    test('close tears down the connection manager, which disconnects the controller', async () => {
        const h = createHarness();
        await openInPluginMode(h);

        h.terminal.close();

        assert.ok(h.controller.disconnectCalls > 0);
    });
});
