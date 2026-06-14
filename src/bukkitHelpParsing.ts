// src/bukkitHelpParsing.ts
//
// Pure parsing of Bukkit's hand-written `/help <command>` pages - a
// "§e--------- §fHelp: /<cmd> ----...§e" banner line followed by
// `Description:`/`Usage:`/`Aliases:` lines. This is a different grammar from
// the flat Brigadier `/cmd <args>` blobs `helpTextParsing.ts` handles
// (`minecraft:help`, vanilla's plain `help`): on a server where the
// `minecraft:` namespace is supported (Paper/Spigot), `help <path>` is
// *always* one of these pages, for every command - vanilla-backed or
// Bukkit-added alike - so no shape-sniffing is needed to decide which parser
// applies, only `LocalCommandTree.supportsMinecraftNamespace`.
//
// No state, no IO — every export here is a deterministic function of its
// arguments.

import { stripColors } from './ansi';

/**
 * Extract the `Usage: ...` line(s) from a Bukkit-style `/help <command>`
 * response (e.g. "Description: ...\nUsage: /version [plugin name]\nAliases:
 * ..."), normalized so each reads as `<commandPath> ...` for `parseHelpLines`.
 * Returns `[]` if there's no Usage line, or if its content is just the bare
 * command name with nothing after it — the generic response Bukkit gives for
 * Brigadier-backed (vanilla) commands ("Description: A Mojang provided
 * command.\nUsage: <name>"), which carries no argument info.
 */
export function extractBukkitUsageLines(helpText: string, commandPath: string): string[] {
  const lines = stripColors(helpText).split('\n').map(line => line.trim());
  const usageIndex = lines.findIndex(line => /^Usage:\s*/i.test(line));
  if (usageIndex === -1) {
    return [];
  }

  const result: string[] = [lines[usageIndex].replace(/^Usage:\s*/i, '')];
  for (let i = usageIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^[A-Za-z][A-Za-z ]*:/.test(line) || line.startsWith('---')) {
      break;
    }
    result.push(line);
  }

  const normalizedPath = commandPath.toLowerCase();
  return result.filter(line => line.replace(/^\//, '').toLowerCase() !== normalizedPath);
}

/**
 * Extract alias names from a Bukkit-style `/help <command>` response's
 * `Aliases: a, b, c` line (e.g. "Description: ...\nUsage: ...\nAliases: ver,
 * about"). Returns `[]` if there's no Aliases line.
 */
export function extractBukkitAliases(helpText: string): string[] {
  const lines = stripColors(helpText).split('\n').map(line => line.trim());
  const aliasesLine = lines.find(line => /^Aliases:\s*/i.test(line));
  if (!aliasesLine) {
    return [];
  }

  return aliasesLine.replace(/^Aliases:\s*/i, '')
    .split(',')
    .map(alias => alias.trim())
    .filter(alias => alias.length > 0);
}
