package dev.rcon.tabcomplete;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.suggestion.Suggestion;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.context.ParsedCommandNode;
import com.mojang.brigadier.tree.CommandNode;
import com.mojang.brigadier.tree.LiteralCommandNode;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import org.bukkit.Bukkit;
import org.bukkit.craftbukkit.CraftServer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandMap;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;

import java.util.List;
import java.util.Map;

public class TabCompletePlugin extends JavaPlugin {

    private MinecraftServer nmsServer;
    private CommandDispatcher<CommandSourceStack> dispatcher;
    private CommandMap bukkitCommandMap;

    @Override
    public void onEnable() {
        getCommand("tabcomplete").setExecutor(this::handleCommand);
        getCommand("cmdusage").setExecutor(this::handleUsageCommand);

        CraftServer craftServer = (CraftServer) Bukkit.getServer();
        nmsServer = craftServer.getServer();
        bukkitCommandMap = craftServer.getCommandMap();
        dispatcher = nmsServer.getCommands().getDispatcher();
    }

    private boolean handleUsageCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage("Usage: /" + label + " <partial command...>");
            sender.sendMessage("Returns usage syntax for the command at the given position.");
            sender.sendMessage("Example: /" + label + " gamemode");
            sender.sendMessage("Example: /" + label + " gamemode crea");
            return true;
        }

        String partial = String.join(" ", args);

        try {
            CommandSourceStack source = nmsServer.createCommandSourceStack();
            ParseResults<CommandSourceStack> results = dispatcher.parse(partial, source);

            // Walk parsed nodes to build the canonical prefix and find the deepest node.
            StringBuilder prefixBuilder = new StringBuilder();
            CommandNode<CommandSourceStack> deepestNode = null;
            String rootCommandName = null;
            for (ParsedCommandNode<CommandSourceStack> pn : results.getContext().getNodes()) {
                CommandNode<CommandSourceStack> node = pn.getNode();
                if (!prefixBuilder.isEmpty()) prefixBuilder.append(" ");
                prefixBuilder.append(node.getUsageText());
                deepestNode = node;
                if (rootCommandName == null && node instanceof LiteralCommandNode) {
                    rootCommandName = node.getName();
                }
            }

            if (deepestNode == null) {
                sender.sendMessage("(no command found — provide a more specific input)");
                return true;
            }

            String prefix = prefixBuilder.toString();
            String[] usages = dispatcher.getAllUsage(deepestNode, source, false);

            // Legacy Bukkit commands appear in Brigadier as a single generic "args" greedy-
            // string node. Detect this whether the cursor is at the literal or inside the arg.
            boolean deepestIsArgument = !(deepestNode instanceof LiteralCommandNode);
            boolean isGenericWrapper = rootCommandName != null && (
                    (!deepestIsArgument && java.util.Arrays.stream(usages).allMatch(u -> u.isEmpty() || u.equals("<args>")))
                    || (deepestIsArgument && deepestNode.getName().equals("args")));
            if (isGenericWrapper) {
                Command bc = bukkitCommandMap.getCommand(rootCommandName);
                if (bc != null) {
                    org.bukkit.help.HelpTopic topic = Bukkit.getHelpMap().getHelpTopic("/" + rootCommandName);
                    String text;
                    if (topic != null) {
                        String fullText = topic.getFullText(sender);
                        String typedArgs = partial.length() > rootCommandName.length() + 1
                                ? partial.substring(rootCommandName.length() + 1)
                                : "";
                        if (typedArgs.isEmpty()) {
                            String cmdPrefix = rootCommandName.toLowerCase() + " ";
                            StringBuilder usageLines = new StringBuilder();
                            int count = 0;
                            for (String line : fullText.split("\n")) {
                                if (line.replaceAll("§[0-9a-fk-orA-FK-OR]", "").toLowerCase().startsWith(cmdPrefix)) {
                                    if (!usageLines.isEmpty()) usageLines.append("\n");
                                    usageLines.append(line);
                                    count++;
                                }
                            }
                            text = count == 0 ? fullText
                                    : count == 1 ? usageLines.toString()
                                    : "(too broad — use /help " + rootCommandName + " or provide a subcommand)";
                        } else {
                            // Back off one word at a time so that value args like
                            // "mvp config maxPortals" still match "mvp config <property>".
                            String[] words = typedArgs.split(" ");
                            String found = null;
                            for (int i = words.length; i >= 1; i--) {
                                String filterPrefix = (rootCommandName + " " +
                                        String.join(" ", java.util.Arrays.copyOfRange(words, 0, i))).toLowerCase();
                                StringBuilder filtered = new StringBuilder();
                                for (String line : fullText.split("\n")) {
                                    if (line.replaceAll("§[0-9a-fk-orA-FK-OR]", "").toLowerCase().startsWith(filterPrefix)) {
                                        if (!filtered.isEmpty()) filtered.append("\n");
                                        filtered.append(line);
                                    }
                                }
                                if (!filtered.isEmpty()) {
                                    found = filtered.toString();
                                    break;
                                }
                            }
                            text = (found != null) ? found : "(no matching subcommand: " + typedArgs + ")";
                        }
                    } else {
                        text = bc.getUsage().replace("<command>", bc.getName());
                    }
                    sender.sendMessage(text);
                    return true;
                }
            }

            // getAllUsage's "ladder" expands optional trailing arguments into one
            // line per depth (e.g. "clear", "clear <targets>", "clear <targets>
            // <item>", ...), which the RCON client can't distinguish from genuine
            // ambiguity. getSmartUsage instead collapses those into a single
            // "[<param>]"-bracketed usage string, matching minecraft:help's
            // compact form (e.g. "clear [<targets>] [<item>]"). Each entry in the
            // returned map is a genuinely distinct continuation (e.g. different
            // subcommand branches), so multiple entries become separate lines -
            // that's the real-ambiguity case the client still treats as unresolved.
            Map<CommandNode<CommandSourceStack>, String> smartUsages = dispatcher.getSmartUsage(deepestNode, source);
            if (smartUsages.isEmpty()) {
                sender.sendMessage(prefix);
            } else {
                StringBuilder sb = new StringBuilder();
                for (String usage : smartUsages.values()) {
                    if (!sb.isEmpty()) sb.append("\n");
                    sb.append(prefix).append(" ").append(usage);
                }
                sender.sendMessage(sb.toString());
            }
        } catch (Exception e) {
            sender.sendMessage("Error getting usage: " + e.getMessage());
        }
        return true;
    }

    private boolean handleCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage("Usage: /" + label + " <partial command...>");
            sender.sendMessage("Returns tab completions for a partial command string.");
            sender.sendMessage("Use a trailing - to request completions after a space.");
            sender.sendMessage("Example: /" + label + " give @p");
            sender.sendMessage("Example: /" + label + " gamemode -");
            return true;
        }

        // Bukkit preserves trailing empty strings (split with -1 limit), so
        // "mv tp " arrives as ["mv", "tp", ""] and rejoins correctly as "mv tp ".
        // A trailing "-" is a placeholder for a trailing space for clients that strip it.
        String[] effectiveArgs = args;
        String trailingSpace = "";
        if (args[args.length - 1].equals("-")) {
            effectiveArgs = java.util.Arrays.copyOf(args, args.length - 1);
            trailingSpace = " ";
        }
        // A lone "-" (no real command parts) means "request root completions".
        String partial = effectiveArgs.length == 0 ? "" : String.join(" ", effectiveArgs) + trailingSpace;

        try {
            CommandSourceStack source = nmsServer.createCommandSourceStack();
            ParseResults<CommandSourceStack> results = dispatcher.parse(partial, source);
            Suggestions suggestions = dispatcher.getCompletionSuggestions(results).join();
            List<String> completions = suggestions.getList().stream()
                    .map(Suggestion::getText)
                    .toList();

            if (completions.isEmpty()) {
                sender.sendMessage("(no completions)");
            } else {
                sender.sendMessage(String.join("\n", completions));
            }
        } catch (Exception e) {
            sender.sendMessage("Error getting completions: " + e.getMessage());
        }
        return true;
    }
}
