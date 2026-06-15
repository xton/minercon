import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { silentLogger } from './support/testLogger';
import { LocalCommandTree, CommandNode } from '../localCommandTree';
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

function createCommandTree(sendCommand: (command: string) => Promise<string>): LocalCommandTree {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcon-cmdauto-test-'));
  return new LocalCommandTree(sendCommand, silentLogger(), cacheDir, 'host', 25575);
}

function findChoice(parameters: Parameter[], name: string): Parameter {
  const choiceList = parameters.find(p => p.type === ParameterType.CHOICE_LIST);
  const direct = parameters.find(p => p.type === ParameterType.SUBCOMMAND && p.name === name);
  if (direct) { return direct; }
  const choice = choiceList?.choices?.find(c => c.name === name);
  assert.ok(choice, `expected a "${name}" subcommand among ${JSON.stringify(parameters.map(p => p.name))}`);
  return choice!;
}

suite('LocalCommandTree - no-plugin help crawl', () => {
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
      const commandTree = createCommandTree(fakeSendCommand(responses, calls));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
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

    test('team list has a [<team>] parameter, trusted from "help" without a depth-2 fetch', () => {
      const teamParams = nodes.get('team')!.parameters;
      const list = findChoice(teamParams, 'list');
      assert.deepStrictEqual(list.members, [
        { type: ParameterType.ARGUMENT, name: 'team', optional: true, position: 0 },
      ]);
    });

    test('subcommand variants with usable arguments are trusted, without a per-subcommand help fetch', () => {
      assert.ok(!calls.includes('help gamerule announceAdvancements'), 'gamerule rules already have a [<value>] parameter from "help"');
      assert.ok(!calls.includes('help gamerule doDaylightCycle'));
      assert.ok(!calls.includes('help gamerule logAdminCommands'));
      assert.ok(!calls.includes('help team list'), 'team list already has a [<team>] parameter from "help"');
      assert.ok(!calls.includes('help team add'), 'team add already has <team>/[<displayName>] parameters from "help"');
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
      const commandTree = createCommandTree(fakeSendCommand(responses, calls));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
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

    test('team list/add get full parameters from minecraft:help, trusted without a depth-2 fetch', () => {
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
      assert.ok(!calls.includes('help team list') && !calls.includes('minecraft:help team list'));
      assert.ok(!calls.includes('help team add') && !calls.includes('minecraft:help team add'));
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

    test('redundant "help <cmd>" fetches are skipped once minecraft:help already has full info', () => {
      // gamemode/gamerule/team's root minecraft:help summaries already carry
      // real syntax, confirmed by minecraft:help <cmd> itself - no need for
      // Bukkit's generic "help <cmd>" page too.
      assert.ok(!calls.includes('help gamemode'), 'help gamemode');
      assert.ok(!calls.includes('help gamerule'), 'help gamerule');
      assert.ok(!calls.includes('help team'), 'help team');
    });

    test('redundant "minecraft:help <cmd>" fetches are skipped once Bukkit\'s help already has full info', () => {
      // version/reload's root minecraft:help summaries are just the generic
      // "[<args>]" placeholder, so Bukkit's "help <cmd>" is tried first - and
      // its real Usage line is enough on its own.
      assert.ok(!calls.includes('minecraft:help version'), 'minecraft:help version');
      assert.ok(!calls.includes('minecraft:help reload'), 'minecraft:help reload');
    });
  });

  suite('subcommand variants: trust usage from "help" unless it is bogus', () => {
    // "/foo bar <baz>" gives "bar" a real [<baz>] parameter directly - no
    // further fetch needed. "/foo qux" gives "qux" no parameters at all
    // (a bare literal), which isn't enough to know its real syntax, so
    // "help foo qux" must still be fetched to discover its "<args>" argument.
    const responses = new Map<string, string>([
      ['minecraft:help', NAMESPACE_ERROR],
      ['help', '/foo'],
      ['help foo', ['/foo bar <baz>', '/foo qux'].join('')],
      ['help foo qux', '/foo qux <detail>'],
    ]);

    let calls: string[];
    let nodes: Map<string, CommandNode>;

    setup(async () => {
      calls = [];
      const commandTree = createCommandTree(fakeSendCommand(responses, calls));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
    });

    test('a variant with a real parameter is trusted without a per-subcommand help fetch', () => {
      const bar = findChoice(nodes.get('foo')!.parameters, 'bar');
      assert.deepStrictEqual(bar.members, [
        { type: ParameterType.ARGUMENT, name: 'baz', optional: false, position: 0 },
      ]);
      assert.ok(!calls.includes('help foo bar'), `expected no "help foo bar" fetch, got: ${JSON.stringify(calls)}`);
    });

    test('a bare-literal variant (no usable arguments) falls back to a per-subcommand help fetch', () => {
      const qux = findChoice(nodes.get('foo')!.parameters, 'qux');
      assert.deepStrictEqual(qux.members, [
        { type: ParameterType.ARGUMENT, name: 'detail', optional: false, position: 0 },
      ]);
      assert.ok(calls.includes('help foo qux'), `expected a "help foo qux" fetch, got: ${JSON.stringify(calls)}`);
    });
  });

  suite('minecraft:gamerule: namespace-duplicated rule names from minecraft:help', () => {
    // Real Paper 1.21.4 `minecraft:help minecraft:gamerule` (and
    // `minecraft:help gamerule`) lists every rule TWICE - once bare (e.g.
    // "advance_time") and once minecraft:-prefixed (e.g.
    // "minecraft:advance_time") - each with its own real [<value>]
    // parameter. Both must be trusted without a further per-rule help fetch,
    // even though the rule "name" itself contains a `:`.
    const responses = new Map<string, string>([
      ['minecraft:help', [
        '/gamerule (advance_time|minecraft:advance_time|locator_bar|minecraft:locator_bar)',
        '/minecraft:gamerule (advance_time|minecraft:advance_time|locator_bar|minecraft:locator_bar)',
      ].join('')],
      ['help gamerule', GENERIC_VANILLA_HELP('gamerule')],
      ['minecraft:help gamerule', [
        '/gamerule advance_time [<value>]',
        '/gamerule minecraft:advance_time [<value>]',
        '/gamerule locator_bar [<value>]',
        '/gamerule minecraft:locator_bar [<value>]',
      ].join('')],
      ['help minecraft:gamerule', GENERIC_VANILLA_HELP('minecraft:gamerule')],
      ['minecraft:help minecraft:gamerule', [
        '/minecraft:gamerule advance_time [<value>]',
        '/minecraft:gamerule minecraft:advance_time [<value>]',
        '/minecraft:gamerule locator_bar [<value>]',
        '/minecraft:gamerule minecraft:locator_bar [<value>]',
      ].join('')],
    ]);

    let calls: string[];
    let nodes: Map<string, CommandNode>;

    setup(async () => {
      calls = [];
      const commandTree = createCommandTree(fakeSendCommand(responses, calls));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
    });

    test('both gamerule and minecraft:gamerule list each rule with usable [<value>] members', () => {
      for (const cmd of ['gamerule', 'minecraft:gamerule']) {
        const params = nodes.get(cmd)!.parameters;
        const choiceList = params.find(p => p.type === ParameterType.CHOICE_LIST);
        assert.ok(choiceList, `expected ${cmd} to be a CHOICE_LIST of rule variants`);
        const names = choiceList!.choices!.map(c => c.name);
        assert.deepStrictEqual(names, ['advance_time', 'minecraft:advance_time', 'locator_bar', 'minecraft:locator_bar']);
        for (const choice of choiceList!.choices!) {
          assert.deepStrictEqual(choice.members, [
            { type: ParameterType.ARGUMENT, name: 'value', optional: true, position: 0 },
          ]);
        }
      }
    });

    test('no per-rule help fetches for either bare or minecraft:-prefixed rule names', () => {
      const extraFetches = calls.filter(c => /^(help|minecraft:help) (gamerule|minecraft:gamerule) /.test(c));
      assert.deepStrictEqual(extraFetches, [], `expected no per-rule fetches, got: ${JSON.stringify(extraFetches)}`);
    });
  });

  suite('minecraft:difficulty: enum-valued argument expressed as one "[value]" line per choice', () => {
    // Real Paper 1.21.4 `minecraft:help minecraft:difficulty` lists each
    // difficulty level on its own "/minecraft:difficulty [value]" line -
    // each parsed as a variant whose name came from a [bracketed] token with
    // no further tokens (empty members). These are literal enum VALUES for
    // difficulty's argument, not subcommand verbs with their own syntax:
    // "minecraft:help minecraft:difficulty <value>" returns empty and "help
    // minecraft:difficulty <value>" returns "not found" - both wasted round
    // trips that should be skipped.
    const responses = new Map<string, string>([
      ['minecraft:help', '/minecraft:difficulty [peaceful|easy|normal|hard]'],
      ['help minecraft:difficulty', GENERIC_VANILLA_HELP('minecraft:difficulty')],
      ['minecraft:help minecraft:difficulty', [
        '/minecraft:difficulty [peaceful]',
        '/minecraft:difficulty [easy]',
        '/minecraft:difficulty [normal]',
        '/minecraft:difficulty [hard]',
      ].join('')],
    ]);

    let calls: string[];
    let nodes: Map<string, CommandNode>;

    setup(async () => {
      calls = [];
      const commandTree = createCommandTree(fakeSendCommand(responses, calls));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
    });

    test('minecraft:difficulty becomes a CHOICE_LIST of complete, argument-free value variants', () => {
      const params = nodes.get('minecraft:difficulty')!.parameters;
      const choiceList = params.find(p => p.type === ParameterType.CHOICE_LIST);
      assert.ok(choiceList, 'expected minecraft:difficulty to be a CHOICE_LIST of value variants');
      const names = choiceList!.choices!.map(c => c.name);
      assert.deepStrictEqual(names, ['peaceful', 'easy', 'normal', 'hard']);
      for (const choice of choiceList!.choices!) {
        assert.strictEqual(choice.isComplete, true);
        assert.deepStrictEqual(choice.members, []);
      }
    });

    test('no per-value help fetches for the difficulty levels', () => {
      const extraFetches = calls.filter(c => /^(help|minecraft:help) minecraft:difficulty /.test(c));
      assert.deepStrictEqual(extraFetches, [], `expected no per-value fetches, got: ${JSON.stringify(extraFetches)}`);
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
      const commandTree = createCommandTree(fakeSendCommand(responses, []));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
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
    // separator between concatenated entries. Since `minecraft:help warp`
    // here is just the generic `[<args>]` placeholder with no real usage,
    // mergeHelpSources falls back to extractBukkitUsageLines, which extracts
    // the Bukkit "Usage:" line verbatim instead of re-splitting on "/".
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
      const commandTree = createCommandTree(fakeSendCommand(responses, []));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
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

  suite('namespaced commands ("ingest everything")', () => {
    // Real `minecraft:help` dumps include both a bare command and one or
    // more namespaced duplicates (e.g. "/version [<plugin>]" and
    // "/bukkit:version [<plugin>]"), plus alias redirects that themselves
    // come in both forms ("/tell -> msg" and "/minecraft:tell -> msg"). Per
    // "do not strip namespace prefixes or ignore namespaced commands", every
    // one of these becomes its own first-class root command.
    const responses = new Map<string, string>([
      ['minecraft:help', [
        '/advancement (grant|revoke)',
        '/minecraft:advancement (grant|revoke)',
        '/msg <targets> <message>',
        '/minecraft:msg <targets> <message>',
        '/tell -> msg',
        '/minecraft:tell -> msg',
        '/help [<args>]',
        '/bukkit:help [<args>]',
        '/minecraft:help [<command>]',
      ].join('')],

      // Namespaced commands are loaded first - their minecraft:help <path>
      // responses carry full syntax, so "help <path>" is never even checked.
      ['minecraft:help minecraft:advancement', '/minecraft:advancement (grant|revoke)'],
      ['minecraft:help minecraft:msg', '/minecraft:msg <targets> <message>'],
    ]);

    let calls: string[];
    let nodes: Map<string, CommandNode>;

    setup(async () => {
      calls = [];
      const commandTree = createCommandTree(fakeSendCommand(responses, calls));
      await commandTree.initialize();
      nodes = (commandTree as any).rootCommands as Map<string, CommandNode>;
    });

    test('namespaced commands become their own root entries, distinct from their bare counterparts', () => {
      assert.ok(nodes.has('advancement'));
      assert.ok(nodes.has('minecraft:advancement'));
      assert.notStrictEqual(nodes.get('advancement'), nodes.get('minecraft:advancement'));

      assert.ok(nodes.has('msg'));
      assert.ok(nodes.has('minecraft:msg'));
      assert.notStrictEqual(nodes.get('msg'), nodes.get('minecraft:msg'));
    });

    test('multiple namespaces contributing the same command (help/bukkit:help) are all ingested', () => {
      assert.ok(nodes.has('help'));
      assert.ok(nodes.has('bukkit:help'));
      assert.ok(nodes.has('minecraft:help'));
    });

    test('alias redirects preserve namespace prefixes ("minecraft:tell" and "tell" both alias "msg")', () => {
      assert.strictEqual(nodes.get('tell'), nodes.get('msg'));
      assert.strictEqual(nodes.get('minecraft:tell'), nodes.get('msg'));
    });

    test('bare commands reuse their namespaced sibling\'s parameters without re-fetching', () => {
      const advancement = nodes.get('advancement')!.parameters;
      const minecraftAdvancement = nodes.get('minecraft:advancement')!.parameters;
      assert.deepStrictEqual(advancement, minecraftAdvancement);
      assert.deepStrictEqual(advancement, [
        {
          type: ParameterType.CHOICE_LIST,
          optional: false,
          position: 0,
          choices: [
            { type: ParameterType.LITERAL, literal: 'grant', optional: false, position: 0 },
            { type: ParameterType.LITERAL, literal: 'revoke', optional: false, position: 1 },
          ],
        },
      ]);

      assert.deepStrictEqual(nodes.get('msg')!.parameters, nodes.get('minecraft:msg')!.parameters);
      assert.deepStrictEqual(nodes.get('msg')!.parameters, [
        { type: ParameterType.ARGUMENT, name: 'targets', optional: false, position: 0 },
        { type: ParameterType.ARGUMENT, name: 'message', optional: false, position: 1 },
      ]);

      assert.ok(!calls.includes('help advancement'), '"advancement" should not be fetched - reused from "minecraft:advancement"');
      assert.ok(!calls.includes('minecraft:help advancement'), '"advancement" should not be fetched - reused from "minecraft:advancement"');
      assert.ok(!calls.includes('help msg'), '"msg" should not be fetched - reused from "minecraft:msg"');
      assert.ok(!calls.includes('minecraft:help msg'), '"msg" should not be fetched - reused from "minecraft:msg"');
    });
  });
});
