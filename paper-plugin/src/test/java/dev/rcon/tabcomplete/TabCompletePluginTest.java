package dev.rcon.tabcomplete;

import net.kyori.adventure.text.Component;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit tests for the pure pieces of the `rcat` path. The dispatch-as-console
 * behavior needs a live server (covered by the functional suite); here we test
 * the message-capture serialization and vanilla-command detection in isolation.
 */
class TabCompletePluginTest {

    @Test
    void appendString() {
        List<String> out = new ArrayList<>();
        TabCompletePlugin.appendMessageArg(out, "hello");
        assertEquals(List.of("hello"), out);
    }

    @Test
    void appendStringArrayOneEntryPerLine() {
        List<String> out = new ArrayList<>();
        TabCompletePlugin.appendMessageArg(out, new String[]{ "a", "b", "c" });
        assertEquals(List.of("a", "b", "c"), out);
    }

    @Test
    void appendPreservesColorCodes() {
        List<String> out = new ArrayList<>();
        TabCompletePlugin.appendMessageArg(out, "§eHelp: Index");
        assertEquals(List.of("§eHelp: Index"), out);
    }

    @Test
    void appendComponentSerializesToLegacySection() {
        List<String> out = new ArrayList<>();
        TabCompletePlugin.appendMessageArg(out, Component.text("plain"));
        assertEquals(List.of("plain"), out);
    }

    @Test
    void appendNullAddsNothing() {
        List<String> out = new ArrayList<>();
        TabCompletePlugin.appendMessageArg(out, null);
        assertTrue(out.isEmpty());
    }

    @Test
    void appendOrderAndJoin() {
        List<String> out = new ArrayList<>();
        TabCompletePlugin.appendMessageArg(out, "line1");
        TabCompletePlugin.appendMessageArg(out, new String[]{ "line2", "line3" });
        assertEquals("line1\nline2\nline3", String.join("\n", out));
    }

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
