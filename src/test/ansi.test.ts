// src/test/ansi.test.ts
//
// Tests for ansi.ts's Minecraft `§`-color-code translation, which is the
// part of this module exercised independently of the SGR constants/helpers
// (those are exercised indirectly via the modules that use them).

import * as assert from 'assert';
import { formatMinecraftColors, stripColors } from '../ansi';

suite('ansi', () => {
    test('formatMinecraftColors inserts ANSI codes and ends with reset', () => {
        const out = formatMinecraftColors('Hello §cWorld');
        assert.ok(out.includes('\x1b[91m'));
        assert.ok(out.endsWith('\x1b[0m'));
    });

    test('formatMinecraftColors collapses the "Â§" UTF-8 mojibake, leaving no orphaned "Â"', () => {
        const out = formatMinecraftColors('Hello Â§cWorld');
        assert.ok(out.includes('\x1b[91m'), 'the §c after the mojibake should still become red');
        assert.ok(!out.includes('Â'), 'the orphaned Â must not survive into the output');
        assert.ok(!out.includes('§'), 'no raw section sign should remain either');
    });

    test('stripColors removes color codes', () => {
        const stripped = stripColors('§aHello §cWorld');
        assert.strictEqual(stripped, 'Hello World');
    });
});
