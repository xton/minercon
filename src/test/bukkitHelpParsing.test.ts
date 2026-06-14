import * as assert from 'assert';
import {
    extractBukkitUsageLines,
    extractBukkitAliases,
} from '../bukkitHelpParsing';

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
