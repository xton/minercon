package dev.rcon.tabcomplete;

import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit tests for the pure pieces of the `rcat` path. The dispatch-as-console
 * behavior needs a live server (covered by the functional suite); here we test
 * vanilla-command detection in isolation.
 */
class TabCompletePluginTest {

    @Test
    void vanillaWrapperDetectedBySimpleName() {
        assertTrue(TabCompletePlugin.isVanillaWrapper(new VanillaCommandWrapper()));
        assertFalse(TabCompletePlugin.isVanillaWrapper(new SomePluginCommand()));
    }

    /** Simple name is "VanillaCommandWrapper" — mimics CraftBukkit's bridge type. */
    private static final class VanillaCommandWrapper extends Command {
        VanillaCommandWrapper() { super("vanilla"); }
        @Override public boolean execute(CommandSender sender, String label, String[] args) { return false; }
    }

    private static final class SomePluginCommand extends Command {
        SomePluginCommand() { super("plugin"); }
        @Override public boolean execute(CommandSender sender, String label, String[] args) { return false; }
    }
}
