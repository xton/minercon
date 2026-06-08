// src/test/extension.test.ts
//
// `extension.ts` is ~100% vscode-API orchestration (input boxes, secrets,
// terminal/profile creation, output channels) with no pure logic to extract —
// unlike the other modules covered in this suite. Meaningfully testing
// activate()/createRconTerminalProfile()/connectToRcon() would mean mocking
// large swaths of the `vscode` API, mostly asserting that those mocks were
// called in the right order rather than exercising real behavior. Decided
// against, the same way §7 (readline-style REPL library) was — see TODO.md.
//
// This smoke test just confirms the module loads under the real vscode host
// and exposes the activation entry points the runtime expects.

import * as assert from 'assert';
import * as myExtension from '../extension';

suite('Extension Test Suite', () => {
	test('exports activate and deactivate', () => {
		assert.strictEqual(typeof myExtension.activate, 'function');
		assert.strictEqual(typeof myExtension.deactivate, 'function');
	});
});
