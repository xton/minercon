package dev.rcon.tabcomplete;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.ParseResults;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.ParsedCommandNode;
import com.mojang.brigadier.suggestion.Suggestions;
import com.mojang.brigadier.tree.CommandNode;
import com.mojang.brigadier.tree.LiteralCommandNode;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

import java.util.stream.Collectors;

public class TabcompleteMod implements ModInitializer {

    @Override
    public void onInitialize() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> {
            registerTabcomplete(dispatcher);
            registerCmdusage(dispatcher);
        });
    }

    private static void registerTabcomplete(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(
            Commands.literal("tabcomplete")
                .executes(ctx -> {
                    ctx.getSource().sendSuccess(() -> Component.literal(
                        "Usage: /tabcomplete <partial command...>\n" +
                        "Returns tab completions for a partial command string.\n" +
                        "Use a trailing - to request completions after a space.\n" +
                        "Example: /tabcomplete gamemode -\n" +
                        "Example: /tabcomplete gam"
                    ), false);
                    return 1;
                })
                .then(Commands.argument("partial", StringArgumentType.greedyString())
                    .executes(ctx -> {
                        String raw = StringArgumentType.getString(ctx, "partial");

                        // A trailing "-" is a placeholder for a trailing space: clients
                        // that strip trailing whitespace send "-" to mean "after a space".
                        String trailingSpace = "";
                        if (raw.equals("-")) {
                            raw = "";
                        } else if (raw.endsWith(" -")) {
                            raw = raw.substring(0, raw.length() - 2);
                            trailingSpace = " ";
                        }
                        String partial = raw + trailingSpace;

                        CommandSourceStack source = ctx.getSource();
                        ParseResults<CommandSourceStack> results = dispatcher.parse(partial, source);
                        Suggestions suggestions = dispatcher.getCompletionSuggestions(results).join();

                        String output = suggestions.getList().isEmpty()
                            ? "(no completions)"
                            : suggestions.getList().stream()
                                .map(s -> s.getText())
                                .collect(Collectors.joining("\n"));

                        ctx.getSource().sendSuccess(() -> Component.literal(output), false);
                        return 1;
                    }))
        );
    }

    private static void registerCmdusage(CommandDispatcher<CommandSourceStack> dispatcher) {
        dispatcher.register(
            Commands.literal("cmdusage")
                .executes(ctx -> {
                    ctx.getSource().sendSuccess(() -> Component.literal(
                        "Usage: /cmdusage <command...>\n" +
                        "Returns usage syntax for the command at the given position.\n" +
                        "Example: /cmdusage gamemode\n" +
                        "Example: /cmdusage gamemode crea"
                    ), false);
                    return 1;
                })
                .then(Commands.argument("command", StringArgumentType.greedyString())
                    .executes(ctx -> {
                        String partial = StringArgumentType.getString(ctx, "command");
                        CommandSourceStack source = ctx.getSource();
                        ParseResults<CommandSourceStack> results = dispatcher.parse(partial, source);

                        StringBuilder prefixBuilder = new StringBuilder();
                        CommandNode<CommandSourceStack> deepestNode = null;
                        for (ParsedCommandNode<CommandSourceStack> pn : results.getContext().getNodes()) {
                            CommandNode<CommandSourceStack> node = pn.getNode();
                            if (!prefixBuilder.isEmpty()) prefixBuilder.append(" ");
                            prefixBuilder.append(node.getUsageText());
                            deepestNode = node;
                        }

                        if (deepestNode == null) {
                            ctx.getSource().sendSuccess(
                                () -> Component.literal("(no command found — provide a more specific input)"),
                                false);
                            return 1;
                        }

                        String prefix = prefixBuilder.toString();
                        String[] usages = dispatcher.getAllUsage(deepestNode, source, false);
                        boolean deepestIsArgument = !(deepestNode instanceof LiteralCommandNode);

                        StringBuilder sb = new StringBuilder();
                        for (String usage : usages) {
                            if (usage.isEmpty() && deepestIsArgument) continue;
                            if (!sb.isEmpty()) sb.append("\n");
                            sb.append(usage.isEmpty() ? prefix : prefix + " " + usage);
                        }

                        String result = sb.isEmpty() ? prefix : sb.toString();
                        ctx.getSource().sendSuccess(() -> Component.literal(result), false);
                        return 1;
                    }))
        );
    }
}
