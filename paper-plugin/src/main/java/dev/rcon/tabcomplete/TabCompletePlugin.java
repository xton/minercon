package dev.rcon.tabcomplete;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.suggestion.Suggestion;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.context.ParsedCommandNode;
import com.mojang.brigadier.tree.CommandNode;
import com.mojang.brigadier.tree.LiteralCommandNode;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.legacy.LegacyComponentSerializer;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import org.bukkit.Bukkit;
import org.bukkit.craftbukkit.CraftServer;
import org.bukkit.command.Command;
import org.bukkit.command.CommandMap;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.plugin.java.JavaPlugin;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class TabCompletePlugin extends JavaPlugin {

    // Single line the RCON client greps for to confirm the server supports the
    // `rcat` unpaginated-output wrapper (older plugin jars won't emit it).
    static final String RCAT_PROBE_MARKER = "rcat: returns unpaginated command output";

    private MinecraftServer nmsServer;
    private CommandDispatcher<CommandSourceStack> dispatcher;
    private CommandMap bukkitCommandMap;

    @Override
    public void onEnable() {
        getCommand("tabcomplete").setExecutor(this::handleCommand);
        getCommand("cmdusage").setExecutor(this::handleUsageCommand);
        getCommand("rcat").setExecutor(this::handleRcatCommand);

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

    /**
     * Runs the wrapped command and returns its full, *unpaginated* output in a
     * single RCON response. Paper/Spigot's Bukkit-layer commands (notably
     * `/help`) paginate to ~9 lines because the RCON sender is a
     * `RemoteConsoleCommandSender`, not a `ConsoleCommandSender` — Bukkit's
     * `HelpCommand` only takes the unbounded branch for the latter. We
     * re-dispatch through a `ConsoleCommandSender` proxy so the unbounded branch
     * is taken, capturing the output and returning it here.
     */
    private boolean handleRcatCommand(CommandSender sender, Command cmd, String label, String[] args) {
        if (args.length == 0) {
            sender.sendMessage(RCAT_PROBE_MARKER);
            sender.sendMessage("Usage: /" + label + " <command...>");
            sender.sendMessage("Runs the command and returns its full, unpaginated output.");
            return true;
        }

        String commandLine = String.join(" ", args);
        if (commandLine.startsWith("/")) {
            commandLine = commandLine.substring(1);
        }

        try {
            String rootName = commandLine.split("\\s+", 2)[0].toLowerCase();
            Command target = bukkitCommandMap.getCommand(rootName);

            if (target == null || isVanillaWrapper(target)) {
                // Unknown command, or a vanilla (Brigadier) command. Vanilla
                // commands don't paginate, and their output flows back through
                // the RCON sender's own NMS source — running them through the
                // console proxy would route that output to the *server console*
                // and lose it. Dispatch as-is.
                Bukkit.dispatchCommand(sender, commandLine);
                return true;
            }

            // A Bukkit/plugin command (HelpCommand, PluginCommand, ...) — these
            // are the ones that paginate on `instanceof ConsoleCommandSender`.
            // Dispatch as a console proxy and capture the (unbounded) output.
            String captured = dispatchCapturingAsConsole(commandLine);
            if (!captured.isEmpty()) {
                sender.sendMessage(captured);
            }
            return true;
        } catch (Throwable t) {
            // Never worse than today: fall back to the normal (paginated) path.
            getLogger().warning("rcat fell back to direct dispatch for '" + commandLine + "': " + t);
            try {
                Bukkit.dispatchCommand(sender, commandLine);
            } catch (Throwable inner) {
                sender.sendMessage("Error running command: " + inner.getMessage());
            }
            return true;
        }
    }

    /**
     * True if {@code command} is the CraftBukkit bridge that exposes a vanilla
     * Brigadier command through the Bukkit CommandMap. Matched by simple class
     * name so this compiles against `spigot-api` (no craftbukkit on the
     * classpath) as well as Paper.
     */
    static boolean isVanillaWrapper(Command command) {
        return command.getClass().getSimpleName().equals("VanillaCommandWrapper");
    }

    /**
     * Dispatches {@code commandLine} through a {@link ConsoleCommandSender}
     * proxy that captures everything sent to it instead of printing it. The
     * proxy delegates every other method to the real console sender, so
     * `instanceof ConsoleCommandSender`, permissions, and identity all behave
     * like the console (no privilege change — RCON is already console-level).
     */
    private String dispatchCapturingAsConsole(String commandLine) {
        final List<String> captured = new ArrayList<>();
        final ConsoleCommandSender realConsole = Bukkit.getConsoleSender();

        ConsoleCommandSender proxy = (ConsoleCommandSender) Proxy.newProxyInstance(
                ConsoleCommandSender.class.getClassLoader(),
                new Class[]{ ConsoleCommandSender.class },
                (p, method, methodArgs) -> {
                    String name = method.getName();
                    if (name.equals("sendMessage") || name.equals("sendRawMessage")) {
                        if (methodArgs != null) {
                            for (Object arg : methodArgs) {
                                appendMessageArg(captured, arg);
                            }
                        }
                        return null; // capture only; never echo to the real console
                    }
                    return method.invoke(realConsole, methodArgs);
                });

        Bukkit.dispatchCommand(proxy, commandLine);
        return String.join("\n", captured);
    }

    /**
     * Appends the textual content of one `sendMessage`/`sendRawMessage` argument
     * to {@code out}, normalizing to legacy `§`-coded strings. Handles plain
     * Strings, String[] (one entry per line), and Adventure Components;
     * non-text args (UUID sender id, MessageType, ...) contribute nothing.
     */
    static void appendMessageArg(List<String> out, Object arg) {
        if (arg == null) {
            return;
        }
        if (arg instanceof String) {
            out.add((String) arg);
        } else if (arg instanceof String[]) {
            for (String s : (String[]) arg) {
                if (s != null) {
                    out.add(s);
                }
            }
        } else if (arg instanceof Component) {
            out.add(LegacyComponentSerializer.legacySection().serialize((Component) arg));
        }
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
