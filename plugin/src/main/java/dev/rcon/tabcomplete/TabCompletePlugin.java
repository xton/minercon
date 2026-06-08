package dev.rcon.tabcomplete;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.suggestion.Suggestion;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.context.ParsedCommandNode;
import com.mojang.brigadier.tree.CommandNode;
import com.mojang.brigadier.tree.LiteralCommandNode;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.plugin.java.JavaPlugin;

import java.lang.reflect.Method;
import java.util.List;

public class TabCompletePlugin extends JavaPlugin {

    private Object nmsServer;
    private Object bukkitCommandMap;
    private Method createSourceStack;
    @SuppressWarnings("rawtypes")
    private CommandDispatcher dispatcher;

    @Override
    @SuppressWarnings("rawtypes")
    public void onEnable() {
        try {
            Object craftServer = Bukkit.getServer();
            nmsServer = craftServer.getClass().getMethod("getServer").invoke(craftServer);
            bukkitCommandMap = craftServer.getClass().getMethod("getCommandMap").invoke(craftServer);
            createSourceStack = nmsServer.getClass().getMethod("createCommandSourceStack");
            Object commands = nmsServer.getClass().getMethod("getCommands").invoke(nmsServer);
            dispatcher = (CommandDispatcher) commands.getClass().getMethod("getDispatcher").invoke(commands);
        } catch (Exception e) {
            getLogger().severe("Failed to get Brigadier dispatcher: " + e.getMessage());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        getCommand("tabcomplete").setExecutor(this::handleCommand);
        getCommand("cmdusage").setExecutor(this::handleUsageCommand);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
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
            Object source = createSourceStack.invoke(nmsServer);
            ParseResults results = dispatcher.parse(partial, source);

            // Walk parsed nodes to build the canonical prefix and find the deepest node.
            StringBuilder prefixBuilder = new StringBuilder();
            CommandNode deepestNode = null;
            String rootCommandName = null;
            for (Object pn : results.getContext().getNodes()) {
                CommandNode node = ((ParsedCommandNode) pn).getNode();
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
                Method getCmd = bukkitCommandMap.getClass().getMethod("getCommand", String.class);
                org.bukkit.command.Command bc = (org.bukkit.command.Command) getCmd.invoke(bukkitCommandMap, rootCommandName);
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

            // When the deepest parsed node is an argument (user has typed past the last
            // subcommand), drop the empty-string entry — it means "executable here with no
            // more args" but the user is clearly trying to type more.
            StringBuilder sb = new StringBuilder();
            for (String usage : usages) {
                if (usage.isEmpty() && deepestIsArgument) continue;
                if (!sb.isEmpty()) sb.append("\n");
                sb.append(usage.isEmpty() ? prefix : prefix + " " + usage);
            }
            sender.sendMessage(sb.isEmpty() ? prefix : sb.toString());
        } catch (Exception e) {
            sender.sendMessage("Error getting usage: " + e.getMessage());
        }
        return true;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
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
        // A lone "-" (no real command parts) means "request root completions" —
        // the partial must be "" rather than " ", since Brigadier suggests by
        // prefix-matching the remaining string and no command name starts with a space.
        String partial = effectiveArgs.length == 0 ? "" : String.join(" ", effectiveArgs) + trailingSpace;

        try {
            Object source = createSourceStack.invoke(nmsServer);
            ParseResults results = dispatcher.parse(partial, source);
            Suggestions suggestions = (Suggestions) dispatcher.getCompletionSuggestions(results).join();
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
