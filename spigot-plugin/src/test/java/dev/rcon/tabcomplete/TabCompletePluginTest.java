package dev.rcon.tabcomplete;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Unit tests for the pure pieces of the `rcat` path. The HelpMap read needs a
 * live server (covered by the functional suite); here we test help-command
 * detection in isolation.
 */
class TabCompletePluginTest {

    @Test
    void recognizesHelpAliases() {
        assertTrue(TabCompletePlugin.isHelpCommand("help"));
        assertTrue(TabCompletePlugin.isHelpCommand("?"));
        assertTrue(TabCompletePlugin.isHelpCommand("bukkit:help"));
        assertTrue(TabCompletePlugin.isHelpCommand("bukkit:?"));
    }

    @Test
    void rejectsNonHelpCommands() {
        assertFalse(TabCompletePlugin.isHelpCommand("list"));
        assertFalse(TabCompletePlugin.isHelpCommand("gamemode"));
        assertFalse(TabCompletePlugin.isHelpCommand("helpop"));
        assertFalse(TabCompletePlugin.isHelpCommand(""));
    }
}
