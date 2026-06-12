// src/test/support/fakeController.ts
//
// Shared RconController test double for rconSession.test.ts and
// rconTerminal.test.ts. Both drive RconSession (directly, or via the
// Pseudoterminal adapter) through a scripted `send()` implementation and
// then inspect `sendCalls`/`disconnectCalls`/`connected`.
//
// `defaultSend`/`PLUGIN_PROBE_RESPONSE` answer 'tabcomplete' with the magic
// probe string that causes detectAndInitialize to skip the entire
// command-tree-crawl and land immediately on the prompt.

export const PLUGIN_PROBE_RESPONSE = 'Returns tab completions for a partial command string. Usage: /tabcomplete <text>';

export type SendImpl = (cmd: string) => string | Promise<string | undefined> | undefined;

export function defaultSend(cmd: string): string {
    return cmd === 'tabcomplete' ? PLUGIN_PROBE_RESPONSE : '';
}

export class FakeController {
    sendCalls: string[] = [];
    disconnectCalls = 0;
    connected = true;

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
export async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
