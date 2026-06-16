import * as assert from 'assert';
import {
    extractBukkitUsageLines,
    extractBukkitAliases,
} from '../commandTreeParsingBukkit';

suite('extractBukkitUsageLines', () => {
    test('extracts a real Bukkit-added command\'s usage line (version)', () => {
        const helpText = '§e--------- §fHelp: /version §e------------------------\n'
            + '§6Description: §fGets the version of this server including\n'
            + '§fany plugins in use\n'
            + '§f§6Usage: §f/version [plugin name]\n'
            + '§f§6Aliases: §fver, about';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'version'), ['/version [plugin name]']);
    });

    test('extracts a multi-token usage line (reload)', () => {
        const helpText = '§e--------- §fHelp: /reload §e-------------------------\n'
            + '§6Description: §fReloads the server configuration and\n'
            + '§fplugins\n'
            + '§f§6Usage: §f/reload [permissions|commands|confirm]\n'
            + '§f§6Aliases: §frl';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'reload'), ['/reload [permissions|commands|confirm]']);
    });

    test('returns [] for the generic vanilla-command response (gamemode)', () => {
        const helpText = '§e--------- §fHelp: /gamemode §e-----------------------\n'
            + '§6Description: §fA Mojang provided command.\n'
            + '§f§6Usage: §fgamemode';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'gamemode'), []);
    });

    test('returns [] for "No help for X" (no Usage line at all)', () => {
        assert.deepStrictEqual(extractBukkitUsageLines('§cNo help for team list', 'team list'), []);
    });

    test('returns [] for a bare command with no arguments (plugins)', () => {
        const helpText = '§e--------- §fHelp: /plugins §e------------------------\n'
            + '§6Description: §fGets a list of plugins running on the\n'
            + '§fserver\n'
            + '§f§6Usage: §f/plugins\n'
            + '§f§6Aliases: §fpl';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'plugins'), []);
    });

    test('extracts subcommand usages from a "Showing help for X" plugin page (mvp)', () => {
        // Real Paper response for a multi-subcommand plugin that registers each
        // subcommand as its own help topic instead of a single Usage: string.
        const helpText =
            '--------- Help: /mvp (1/3) ----------------------------\n'
            + '=== Showing help for mvp ===\n'
            + 'mvp modify [portal] <property> <value> - Allows you to modify all values\n'
            + 'that can be set.\n'
            + 'mvp debug [on|off] - Instead of teleporting you to a\n'
            + 'place when you walk into a portal you will see the\n'
            + 'details about it. This command toggles.\n'
            + 'mvp select <portal> - Selects a portal so you can perform\n'
            + 'multiple modifications on it.\n'
            + 'mvp wand [enable|disable|toggle] - Gives you the wand';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'mvp'), [
            'mvp modify [portal] <property> <value>',
            'mvp debug [on|off]',
            'mvp select <portal>',
            'mvp wand [enable|disable|toggle]',
        ]);
    });

    test('"Showing help for X" strips description at correct bracket depth', () => {
        // ` - ` inside brackets (e.g. [a-b]) must not trigger early truncation.
        const helpText =
            '=== Showing help for test ===\n'
            + 'test go <from-x> <to-x> - Moves from x to x\n'
            + 'test list - Lists entries';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'test'), [
            'test go <from-x> <to-x>',
            'test list',
        ]);
    });

    test('"Showing help for X" returns [] when no subcommand lines match', () => {
        const helpText =
            '=== Showing help for foo ===\n'
            + 'foo - The foo plugin. Use /foo help for assistance.';
        assert.deepStrictEqual(extractBukkitUsageLines(helpText, 'foo'), []);
    });
});

suite('extractBukkitAliases', () => {
    test('extracts multiple comma-separated aliases (version)', () => {
        const helpText = '§e--------- §fHelp: /version §e------------------------\n'
            + '§6Description: §fGets the version of this server including\n'
            + '§fany plugins in use\n'
            + '§f§6Usage: §f/version [plugin name]\n'
            + '§f§6Aliases: §fver, about';
        assert.deepStrictEqual(extractBukkitAliases(helpText), ['ver', 'about']);
    });

    test('extracts a single alias (reload)', () => {
        const helpText = '§e--------- §fHelp: /reload §e-------------------------\n'
            + '§6Description: §fReloads the server configuration and\n'
            + '§fplugins\n'
            + '§f§6Usage: §f/reload [permissions|commands|confirm]\n'
            + '§f§6Aliases: §frl';
        assert.deepStrictEqual(extractBukkitAliases(helpText), ['rl']);
    });

    test('returns [] for the generic vanilla-command response (no Aliases line)', () => {
        const helpText = '§e--------- §fHelp: /gamemode §e-----------------------\n'
            + '§6Description: §fA Mojang provided command.\n'
            + '§f§6Usage: §fgamemode';
        assert.deepStrictEqual(extractBukkitAliases(helpText), []);
    });

    test('returns [] for a flat concatenated Brigadier blob', () => {
        assert.deepStrictEqual(extractBukkitAliases('/gamemode <gamemode> [<target>]'), []);
    });
});
