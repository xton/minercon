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
import org.bukkit.command.CommandMap;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.plugin.java.JavaPlugin;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;

public class TabCompletePlugin extends JavaPlugin {

    // Single line the RCON client greps for to confirm the server supports the
    // `rcat` unpaginated-output wrapper (older plugin jars won't emit it).
    static final String RCAT_PROBE_MARKER = "rcat: returns unpaginated command output";

    private Object nmsServer;
    private Object bukkitCommandMap;
    private Method createSourceStack;
    @SuppressWarnings("rawtypes")
    private CommandDispatcher dispatcher;

    @Override
    @SuppressWarnings("rawtypes")
    public void onEnable() {
        // Register executors first so commands always respond — even if the
        // Brigadier NMS setup below fails, the handlers fall back to Bukkit's
        // built-in CommandMap.tabComplete() so the plugin remains useful on
        // servers (e.g. Spigot) where the NMS reflection chain differs.
        getCommand("tabcomplete").setExecutor(this::handleCommand);
        getCommand("cmdusage").setExecutor(this::handleUsageCommand);
        getCommand("rcat").setExecutor(this::handleRcatCommand);

        try {
            Object craftServer = Bukkit.getServer();
            nmsServer = craftServer.getClass().getMethod("getServer").invoke(craftServer);
            bukkitCommandMap = craftServer.getClass().getMethod("getCommandMap").invoke(craftServer);
            try {
                // Mojang-mapped path (Paper and other fully-mapped servers).
                createSourceStack = nmsServer.getClass().getMethod("createCommandSourceStack");
                Object commands = nmsServer.getClass().getMethod("getCommands").invoke(nmsServer);
                dispatcher = (CommandDispatcher) commands.getClass().getMethod("getDispatcher").invoke(commands);
            } catch (NoSuchMethodException notMojangMapped) {
                // Spigot's reobfuscated server jar uses a hybrid mapping where
                // these methods exist under different (partially obfuscated)
                // names that vary by Minecraft version. Locate them
                // structurally instead, by return type rather than name.
                findDispatcherAndSourceReflectively();
            }
        } catch (Exception e) {
            getLogger().warning("Could not access Brigadier dispatcher via NMS: " + e);
            getLogger().warning("tabcomplete will fall back to Bukkit CommandMap completions.");
            // dispatcher stays null; handlers detect this and use the fallback
        }
    }

    /**
     * Locates the Brigadier {@link CommandDispatcher} and a usable parse()
     * source object on servers (e.g. Spigot) where the Mojang-mapped
     * {@code createCommandSourceStack}/{@code getCommands().getDispatcher()}
     * accessors don't exist by those names.
     *
     * <p>{@code com.mojang.brigadier.CommandDispatcher} itself ships as its own
     * library and is never obfuscated, so it can be found by return type: scan
     * the server's no-arg methods for one whose return type has a no-arg method
     * returning a {@code CommandDispatcher}. The source object's type (Spigot's
     * {@code CommandListenerWrapper}, Mojang's {@code CommandSourceStack}) is
     * obfuscated, so it's found by trial: the first no-arg NMS-typed getter on
     * the server whose result {@link CommandDispatcher#parse} accepts.
     */
    @SuppressWarnings("rawtypes")
    private void findDispatcherAndSourceReflectively() throws Exception {
        Class<?> nmsClass = nmsServer.getClass();

        Method commandsGetter = null;
        Method dispatcherGetter = null;
        CommandDispatcher foundDispatcher = null;
        for (Method m : nmsClass.getMethods()) {
            if (m.getParameterCount() != 0) continue;
            Class<?> returnType = m.getReturnType();
            if (returnType.isPrimitive() || returnType == void.class) continue;
            for (Method nested : returnType.getMethods()) {
                if (nested.getParameterCount() != 0 || nested.getReturnType() != CommandDispatcher.class) continue;
                try {
                    Object commandsObj = m.invoke(nmsServer);
                    CommandDispatcher candidate = (CommandDispatcher) nested.invoke(commandsObj);
                    // The real command dispatcher has hundreds of registered
                    // root commands; reject smaller dispatchers some other
                    // subsystem (e.g. custom functions) might expose.
                    if (candidate.getRoot().getChildren().size() > 50) {
                        commandsGetter = m;
                        dispatcherGetter = nested;
                        foundDispatcher = candidate;
                        break;
                    }
                } catch (Exception ignored) {
                    // not the right accessor pair — keep looking
                }
            }
            if (foundDispatcher != null) break;
        }
        if (foundDispatcher == null) {
            throw new NoSuchMethodException("could not locate the Brigadier CommandDispatcher by return type");
        }

        Method foundSourceMethod = null;
        for (Method m : nmsClass.getMethods()) {
            if (m.getParameterCount() != 0) continue;
            if (!m.getReturnType().getName().startsWith("net.minecraft.")) continue;
            try {
                Object candidate = m.invoke(nmsServer);
                if (candidate == null) continue;
                // "gamemode" requires a real CommandSourceStack-equivalent: its
                // permission-requirement predicate casts source to that type, so
                // an unrelated NMS object throws here (e.g. ClassCastException)
                // and we move on to the next candidate.
                ParseResults probe = foundDispatcher.parse("gamemode", candidate);
                List<ParsedCommandNode> nodes = probe.getContext().getNodes();
                if (nodes.isEmpty() || !"gamemode".equals(nodes.get(0).getNode().getName())) continue;
                foundSourceMethod = m;
                break;
            } catch (Exception ignored) {
                // not a usable source type — keep looking
            }
        }
        if (foundSourceMethod == null) {
            throw new NoSuchMethodException("could not locate a createCommandSourceStack() equivalent");
        }

        dispatcher = foundDispatcher;
        createSourceStack = foundSourceMethod;
        getLogger().info("Located Brigadier dispatcher via " + commandsGetter.getName() + "()." + dispatcherGetter.getName()
                + "() and command source via " + foundSourceMethod.getName() + "() (non-Mojang-mapped server jar).");
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

        if (dispatcher == null) {
            // Fallback: look up the first word in the Bukkit CommandMap and
            // return its registered usage string. Less detailed than Brigadier
            // but works on servers where NMS access is unavailable.
            try {
                String rootName = args[0].toLowerCase();
                Method getCmd = bukkitCommandMap.getClass().getMethod("getCommand", String.class);
                org.bukkit.command.Command bc = (org.bukkit.command.Command) getCmd.invoke(bukkitCommandMap, rootName);
                if (bc != null) {
                    String usage = bc.getUsage().replace("<command>", bc.getName());
                    sender.sendMessage(usage.isEmpty() ? "/" + bc.getName() : usage);
                } else {
                    sender.sendMessage("(no command found: " + rootName + ")");
                }
            } catch (Exception e) {
                sender.sendMessage("Error getting usage: " + e.getMessage());
            }
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

            // getAllUsage's "ladder" expands optional trailing arguments into one
            // line per depth (e.g. "clear", "clear <targets>", "clear <targets>
            // <item>", ...), which the RCON client can't distinguish from genuine
            // ambiguity. getSmartUsage instead collapses those into a single
            // "[<param>]"-bracketed usage string, matching minecraft:help's
            // compact form (e.g. "clear [<targets>] [<item>]"). Each entry in the
            // returned map is a genuinely distinct continuation (e.g. different
            // subcommand branches), so multiple entries become separate lines -
            // that's the real-ambiguity case the client still treats as unresolved.
            Map<CommandNode, String> smartUsages = dispatcher.getSmartUsage(deepestNode, source);
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
     * single RCON response. Bukkit-layer commands (notably `/help`) paginate to
     * ~9 lines because the RCON sender is a `RemoteConsoleCommandSender`, not a
     * `ConsoleCommandSender` — Bukkit's `HelpCommand` only takes the unbounded
     * branch for the latter. We re-dispatch through a transparent
     * `ConsoleCommandSender` proxy (see {@link #dispatchAsConsole}) so the
     * unbounded branch is taken while output still flows back through RCON.
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
            Command target = ((CommandMap) bukkitCommandMap).getCommand(rootName);

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
            // Dispatch through a console proxy that forwards output back to the
            // RCON sender (unbounded, and the result reaches RCON as usual).
            dispatchAsConsole(sender, commandLine);
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
     * classpath).
     */
    static boolean isVanillaWrapper(Command command) {
        return command.getClass().getSimpleName().equals("VanillaCommandWrapper");
    }

    /**
     * Dispatches {@code commandLine} as if from the console, *transparently*: a
     * {@link ConsoleCommandSender} proxy forwards every method to the real RCON
     * {@code rconSender}. Two effects: (1) `instanceof ConsoleCommandSender` is
     * now true, so Bukkit's pagination takes the unbounded branch; (2) every
     * message the command sends — via `sendMessage` or `sender.spigot()` — is
     * forwarded to the RCON sender and so flows back through the RCON response,
     * exactly like a vanilla command.
     *
     * <p>This replaces an earlier capture-and-resend proxy that delegated
     * non-`sendMessage` calls to {@link Bukkit#getConsoleSender()}: any command
     * that emitted output through a path the proxy didn't intercept (notably
     * `sender.spigot().sendMessage(...)`) printed to the *server log* and
     * returned an empty RCON response. Forwarding everything to the RCON sender
     * removes that whole class of leak.
     *
     * <p>{@link ConsoleCommandSender} adds the {@code Conversable} methods that a
     * {@code RemoteConsoleCommandSender} doesn't implement, so those are handled
     * here (raw messages forwarded to `sendMessage`; sane defaults otherwise).
     */
    private void dispatchAsConsole(CommandSender rconSender, String commandLine) {
        ConsoleCommandSender proxy = (ConsoleCommandSender) Proxy.newProxyInstance(
                ConsoleCommandSender.class.getClassLoader(),
                new Class[]{ ConsoleCommandSender.class },
                (p, method, methodArgs) -> {
                    if (method.getDeclaringClass().isInstance(rconSender)) {
                        return method.invoke(rconSender, methodArgs);
                    }
                    // Methods from interfaces the RCON sender lacks (Conversable).
                    if (method.getName().equals("sendRawMessage") && methodArgs != null) {
                        for (Object arg : methodArgs) {
                            if (arg instanceof String) {
                                rconSender.sendMessage((String) arg);
                            }
                        }
                        return null;
                    }
                    return method.getReturnType() == boolean.class ? Boolean.FALSE : null;
                });

        Bukkit.dispatchCommand(proxy, commandLine);
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
        // A lone "-" (no real command parts) means "request root completions".
        String partial = effectiveArgs.length == 0 ? "" : String.join(" ", effectiveArgs) + trailingSpace;

        // Fast path: Brigadier dispatcher available (Paper and compatible servers).
        if (dispatcher != null) {
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
                return true;
            } catch (Exception e) {
                sender.sendMessage("Error getting completions: " + e.getMessage());
                return true;
            }
        }

        // Fallback: Brigadier not available — use Bukkit's built-in CommandMap
        // tab-completion. Available on all Bukkit-based servers (Spigot etc.).
        try {
            CommandMap map = (CommandMap) bukkitCommandMap;
            // CommandMap.tabComplete(sender, "") returns all root commands when
            // the input has no space (prefix-matching against all known names).
            List<String> completions = map.tabComplete(sender, partial);
            if (completions == null || completions.isEmpty()) {
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
