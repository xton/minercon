import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '../logger';
import { CommandAutocomplete, CommandNode } from '../commandAutocomplete';
import { ParameterType, Parameter, isGenericArgsPlaceholder } from '../helpTextParsing';

// Real responses captured from a live Paper 1.21.4 (no plugins) and a live
// Vanilla/Fabric 1.21.4 server, see docs/technical/NO_PLUGIN_HELP_CRAWL.md and
// helpTextParsing.test.ts (same fixtures, used there to test the individual
// parsing helpers).

const NAMESPACE_ERROR = 'Unknown or incomplete command, see below for errorminecraft:help<--[HERE]';
const NOT_FOUND = 'Unknown command or insufficient permissions';

const VERSION_HELP =
  '§e--------- §fHelp: /version §e------------------------\n'
  + '§6Description: §fGets the version of this server including\n'
  + '§fany plugins in use\n'
  + '§f§6Usage: §f/version [plugin name]\n'
  + '§f§6Aliases: §fver, about';

const RELOAD_HELP =
  '§e--------- §fHelp: /reload §e-------------------------\n'
  + '§6Description: §fReloads the server configuration and\n'
  + '§fplugins\n'
  + '§f§6Usage: §f/reload [permissions|commands|confirm]\n'
  + '§f§6Aliases: §frl';

const PLUGINS_HELP =
  '§e--------- §fHelp: /plugins §e------------------------\n'
  + '§6Description: §fGets a list of plugins running on the\n'
  + '§fserver\n'
  + '§f§6Usage: §f/plugins\n'
  + '§f§6Aliases: §fpl';

const GENERIC_VANILLA_HELP = (cmd: string) =>
  `§e--------- §fHelp: /${cmd} §e-----------------------\n`
  + '§6Description: §fA Mojang provided command.\n'
  + `§f§6Usage: §f${cmd}`;

function silentLogger(): Logger {
  return { error: () => undefined, warning: () => undefined, info: () => undefined };
}

/**
 * Build a `sendCommand` fake from an exact-match response table, recording
 * every command sent (in order) into `calls` and falling back to `NOT_FOUND`
 * for anything not in the table.
 */
function fakeSendCommand(responses: Map<string, string>, calls: string[]): (command: string) => Promise<string> {
  return async (command: string): Promise<string> => {
    calls.push(command);
    return responses.get(command) ?? NOT_FOUND;
  };
}

function createAutocomplete(sendCommand: (command: string) => Promise<string>): CommandAutocomplete {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-cmdauto-test-'));
  return new CommandAutocomplete(sendCommand, silentLogger(), cacheDir, 'host', 25575);
}

function findChoice(parameters: Parameter[], name: string): Parameter {
  const choiceList = parameters.find(p => p.type === ParameterType.CHOICE_LIST);
  const direct = parameters.find(p => p.type === ParameterType.SUBCOMMAND && p.name === name);
  if (direct) { return direct; }
  const choice = choiceList?.choices?.find(c => c.name === name);
  assert.ok(choice, `expected a "${name}" subcommand among ${JSON.stringify(parameters.map(p => p.name))}`);
  return choice!;
}

suite('CommandAutocomplete - no-plugin help crawl', () => {
  suite('vanilla/fabric (no minecraft: namespace)', () => {
    const responses = new Map<string, string>([
      ['minecraft:help', NAMESPACE_ERROR],
      // Real vanilla 1.21.4 `help` packs every command's syntax onto one line
      // with no separators between entries - exercised here (rather than
      // `.join('\n')`) so this fixture would have caught the runaway-recursion
      // bug fixed this session (mergeHelpSources used to skip the `/`-resplit
      // for `helpResponse`).
      ['help', [
        '/gamemode <gamemode> [<target>]',
        '/me <action>',
        '/random value <range>',
        '/transfer <hostname> [<port>] [<player>]',
        '/team list [<team>]',
        '/team add <team> [<displayName>]',
        '/gamerule announceAdvancements [<value>]',
        '/gamerule doDaylightCycle [<value>]',
        '/gamerule logAdminCommands [<value>]',
      ].join('')],
      ['help gamemode', '/gamemode <gamemode> [<target>]'],
      // Real vanilla `help gamerule` (51 rules in reality, trimmed here):
      // concatenated, no separators.
      ['help gamerule', [
        '/gamerule announceAdvancements [<value>]',
        '/gamerule doDaylightCycle [<value>]',
        '/gamerule logAdminCommands [<value>]',
      ].join('')],
      // Real vanilla `help team`: concatenated, no separators.
      ['help team', [
        '/team list [<team>]',
        '/team add <team> [<displayName>]',
      ].join('')],
      ['help team list', '/team list [<team>]'],
      ['help team add', '/team add <team> [<displayName>]'],
    ]);

    let calls: string[];
    let nodes: Map<string, CommandNode>;

    setup(async () => {
      calls = [];
      const autocomplete = createAutocomplete(fakeSendCommand(responses, calls));
      await autocomplete.initialize();
      nodes = (autocomplete as any).rootCommands as Map<string, CommandNode>;
    });

    test('root command list comes from /help, not the hardcoded fallback', () => {
      assert.ok(nodes.has('me'), 'expected "me" (modern command, missing from the hardcoded fallback)');
      assert.ok(nodes.has('random'), 'expected "random" (modern command, missing from the hardcoded fallback)');
      assert.ok(nodes.has('transfer'), 'expected "transfer" (modern command, missing from the hardcoded fallback)');
      assert.ok(!nodes.has('testfor'), '"testfor" no longer exists and should not be in the tree');
      assert.ok(!nodes.has('achievement'), '"achievement" no longer exists and should not be in the tree');
    });

    test('minecraft:help is only probed once (for namespace detection)', () => {
      const mcHelpCalls = calls.filter(c => c.startsWith('minecraft:help'));
      assert.deepStrictEqual(mcHelpCalls, ['minecraft:help']);
    });

    test('gamemode gets full <gamemode>/[<target>] syntax from /help', () => {
      const params = nodes.get('gamemode')!.parameters;
      assert.deepStrictEqual(params, [
        { type: ParameterType.ARGUMENT, name: 'gamemode', optional: false, position: 0 },
        { type: ParameterType.ARGUMENT, name: 'target', optional: true, position: 1 },
      ]);
    });

    test('gamerule gets all rule variants, each with a [<value>] parameter', () => {
      const params = nodes.get('gamerule')!.parameters;
      const choiceList = params.find(p => p.type === ParameterType.CHOICE_LIST);
      assert.ok(choiceList, 'expected gamerule to be a CHOICE_LIST of rule variants');
      const names = choiceList!.choices!.map(c => c.name);
      assert.deepStrictEqual(names, ['announceAdvancements', 'doDaylightCycle', 'logAdminCommands']);
      for (const choice of choiceList!.choices!) {
        assert.deepStrictEqual(choice.members, [
          { type: ParameterType.ARGUMENT, name: 'value', optional: true, position: 0 },
        ]);
      }
    });

    test('team list has a [<team>] parameter, found via "help team list" at depth 2', () => {
      const teamParams = nodes.get('team')!.parameters;
      const list = findChoice(teamParams, 'list');
      assert.deepStrictEqual(list.members, [
        { type: ParameterType.ARGUMENT, name: 'team', optional: true, position: 0 },
      ]);
    });
  });

  suite('paper/spigot (minecraft: namespace supported)', () => {
    const responses = new Map<string, string>([
      ['minecraft:help', [
        '/gamemode <gamemode> [<target>]',
        '/gamerule announceAdvancements [<value>]',
        '/gamerule doDaylightCycle [<value>]',
        '/gamerule logAdminCommands [<value>]',
        '/team list [<team>]',
        '/team add <team> [<displayName>]',
        '/version [<args>]',
        '/reload [<args>]',
        '/plugins [<args>]',
      ].join('')],

      ['help gamemode', GENERIC_VANILLA_HELP('gamemode')],
      ['minecraft:help gamemode', '/gamemode <gamemode> [<target>]'],

      ['help gamerule', GENERIC_VANILLA_HELP('gamerule')],
      ['minecraft:help gamerule', [
        '/gamerule announceAdvancements [<value>]',
        '/gamerule doDaylightCycle [<value>]',
        '/gamerule logAdminCommands [<value>]',
      ].join('')],

      ['help team', '§cNo help for team'],
      ['minecraft:help team', [
        '/team list [<team>]',
        '/team add <team> [<displayName>]',
      ].join('')],
      ['help team list', '§cNo help for team list'],
      ['minecraft:help team list', '/team list [<team>]'],
      ['help team add', '§cNo help for team add'],
      ['minecraft:help team add', '/team add <team> [<displayName>]'],

      ['help version', VERSION_HELP],
      ['minecraft:help version', '/version [<args>]'],

      ['help reload', RELOAD_HELP],
      ['minecraft:help reload', '/reload [<args>]'],

      ['help plugins', PLUGINS_HELP],
      ['minecraft:help plugins', '/plugins [<args>]'],
    ]);

    let calls: string[];
    let nodes: Map<string, CommandNode>;

    setup(async () => {
      calls = [];
      const autocomplete = createAutocomplete(fakeSendCommand(responses, calls));
      await autocomplete.initialize();
      nodes = (autocomplete as any).rootCommands as Map<string, CommandNode>;
    });

    test('root command list comes from minecraft:help', () => {
      assert.ok(nodes.has('gamemode'));
      assert.ok(nodes.has('gamerule'));
      assert.ok(nodes.has('team'));
      assert.ok(nodes.has('version'));
      assert.ok(nodes.has('reload'));
      assert.ok(nodes.has('plugins'));
    });

    test('gamemode gets <gamemode>/[<target>] from minecraft:help, not the generic placeholder', () => {
      const params = nodes.get('gamemode')!.parameters;
      assert.deepStrictEqual(params, [
        { type: ParameterType.ARGUMENT, name: 'gamemode', optional: false, position: 0 },
        { type: ParameterType.ARGUMENT, name: 'target', optional: true, position: 1 },
      ]);
    });

    test('gamerule gets all rule variants from minecraft:help, each retaining its [<value>] parameter', () => {
      const params = nodes.get('gamerule')!.parameters;
      const choiceList = params.find(p => p.type === ParameterType.CHOICE_LIST);
      assert.ok(choiceList, 'expected gamerule to be a CHOICE_LIST of rule variants');
      const names = choiceList!.choices!.map(c => c.name);
      assert.deepStrictEqual(names, ['announceAdvancements', 'doDaylightCycle', 'logAdminCommands']);
      for (const choice of choiceList!.choices!) {
        // help gamerule <rule> isn't itself a help topic - the [<value>]
        // parameter discovered from the root minecraft:help blob must
        // survive the loadSubcommandDetails recursion unscathed.
        assert.deepStrictEqual(choice.members, [
          { type: ParameterType.ARGUMENT, name: 'value', optional: true, position: 0 },
        ]);
      }
    });

    test('team list/add get full parameters via minecraft:help at depth 2', () => {
      const teamParams = nodes.get('team')!.parameters;
      const list = findChoice(teamParams, 'list');
      assert.deepStrictEqual(list.members, [
        { type: ParameterType.ARGUMENT, name: 'team', optional: true, position: 0 },
      ]);
      const add = findChoice(teamParams, 'add');
      assert.deepStrictEqual(add.members, [
        { type: ParameterType.ARGUMENT, name: 'team', optional: false, position: 0 },
        { type: ParameterType.ARGUMENT, name: 'displayName', optional: true, position: 1 },
      ]);
    });

    test('version falls back to its Bukkit "Usage: [plugin name]" line, not the generic args placeholder', () => {
      const params = nodes.get('version')!.parameters;
      assert.strictEqual(params.length, 1);
      assert.strictEqual(params[0].type, ParameterType.SUBCOMMAND);
      assert.strictEqual(params[0].name, 'plugin name');
    });

    test('reload falls back to its Bukkit "Usage: [permissions|commands|confirm]" line, not the generic args placeholder', () => {
      const params = nodes.get('reload')!.parameters;
      assert.strictEqual(params.length, 1);
      assert.ok(!isGenericArgsPlaceholder(params), 'reload should not end up with the generic "args" placeholder');
    });

    test('plugins ends up with no parameters (bare command, no Usage args)', () => {
      assert.deepStrictEqual(nodes.get('plugins')!.parameters, []);
    });

    test('Bukkit "Aliases:" lines are expanded into rootCommands, sharing the canonical node', () => {
      assert.strictEqual(nodes.get('ver'), nodes.get('version'));
      assert.strictEqual(nodes.get('about'), nodes.get('version'));
      assert.strictEqual(nodes.get('rl'), nodes.get('reload'));
      assert.strictEqual(nodes.get('pl'), nodes.get('plugins'));
    });
  });

  suite('vanilla "minecraft:help" alias redirects ("/tp -> teleport")', () => {
    // Real Paper 1.21.4 minecraft:help responses include redirect lines for
    // vanilla command aliases (see src/test/fixtures/rcon/xton.ts), e.g.
    // "/tp -> teleport". These describe an alias of "teleport", not a
    // separate root command.
    const responses = new Map<string, string>([
      ['minecraft:help', [
        '/teleport <targets>',
        '/tp -> teleport',
      ].join('')],
      ['help teleport', GENERIC_VANILLA_HELP('teleport')],
      ['minecraft:help teleport', '/teleport <targets>'],
    ]);

    let nodes: Map<string, CommandNode>;

    setup(async () => {
      const autocomplete = createAutocomplete(fakeSendCommand(responses, []));
      await autocomplete.initialize();
      nodes = (autocomplete as any).rootCommands as Map<string, CommandNode>;
    });

    test('"/tp -> teleport" does not create its own incomplete rootCommands entry', () => {
      assert.ok(nodes.has('teleport'));
      assert.ok(nodes.has('tp'));
    });

    test('"tp" shares teleport\'s fully-loaded node', () => {
      assert.strictEqual(nodes.get('tp'), nodes.get('teleport'));
      assert.deepStrictEqual(nodes.get('tp')!.parameters, [
        { type: ParameterType.ARGUMENT, name: 'targets', optional: false, position: 0 },
      ]);
    });
  });

  suite('Bukkit "Usage:" line with a literal "/" inside brackets (e.g. "[home/away]")', () => {
    // Plugin-added commands' Usage lines are hand-written and inconsistent -
    // a "/" can appear inside an optional-argument bracket, not just as a
    // separator between concatenated entries. The "---" banner line (caught
    // by looksLikeBukkitHelpPage) routes this through extractBukkitUsageLines,
    // which extracts the Usage line verbatim instead of re-splitting on "/".
    const WARP_HELP =
      '§e--------- §fHelp: /warp §e-------------------------\n'
      + '§6Description: §fTeleport to a warp\n'
      + '§f§6Usage: §f/warp <name> [home/away]\n'
      + '§f§6Aliases: §fwp';

    const responses = new Map<string, string>([
      ['minecraft:help', '/warp [<args>]'],
      ['help warp', WARP_HELP],
      ['minecraft:help warp', NOT_FOUND],
    ]);

    let nodes: Map<string, CommandNode>;

    setup(async () => {
      const autocomplete = createAutocomplete(fakeSendCommand(responses, []));
      await autocomplete.initialize();
      nodes = (autocomplete as any).rootCommands as Map<string, CommandNode>;
    });

    test('the "/" inside "[home/away]" is preserved as one literal, not split into separate entries', () => {
      const params = nodes.get('warp')!.parameters;
      assert.deepStrictEqual(params, [
        { type: ParameterType.ARGUMENT, name: 'name', optional: false, position: 0 },
        { type: ParameterType.LITERAL, literal: 'home/away', optional: true, position: 1 },
      ]);
    });

    test('"Aliases: wp" is expanded into rootCommands, sharing the warp node', () => {
      assert.strictEqual(nodes.get('wp'), nodes.get('warp'));
    });
  });
});
