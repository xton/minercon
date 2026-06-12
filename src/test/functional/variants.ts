export const PASSWORD = 'testpassword';
export const RCON_PORT = 25575;
export const MC_VERSION = '1.21.4';

// In CI, the Spigot pre-built image (ghcr.io/xton/minercon/spigot-prebuilt:VERSION)
// is set via SPIGOT_IMAGE so BuildTools doesn't run during tests. Locally, fall
// back to itzg/minecraft-server and let it build on first pull (slow, one-time).
// Spigot 1.21.4 supports Java up to version 24; use the java21 image tag to
// avoid the "Unsupported Java" exit that occurs when the default itzg image
// ships a newer JVM (e.g. Java 25).
const SPIGOT_IMAGE = process.env.SPIGOT_IMAGE ?? 'itzg/minecraft-server:java21';

export interface ServerVariant {
  name: string;
  image: string;
  type: string;
  version: string;
  hasPlugin: boolean;  // Bukkit plugin deployed to /data/plugins/
  hasMod: boolean;     // Fabric mod deployed to /data/mods/
  startupTimeoutMs: number;
}

export const variants: ServerVariant[] = [
  { name: 'vanilla',        image: 'itzg/minecraft-server', type: 'VANILLA', version: MC_VERSION, hasPlugin: false, hasMod: false, startupTimeoutMs: 300_000 },
  { name: 'paper',          image: 'itzg/minecraft-server', type: 'PAPER',   version: MC_VERSION, hasPlugin: false, hasMod: false, startupTimeoutMs: 300_000 },
  { name: 'paper+plugin',   image: 'itzg/minecraft-server', type: 'PAPER',   version: MC_VERSION, hasPlugin: true,  hasMod: false, startupTimeoutMs: 300_000 },
  { name: 'spigot',         image: SPIGOT_IMAGE,            type: 'SPIGOT',  version: MC_VERSION, hasPlugin: false, hasMod: false, startupTimeoutMs: 300_000 },
  { name: 'spigot+plugin',  image: SPIGOT_IMAGE,            type: 'SPIGOT',  version: MC_VERSION, hasPlugin: true,  hasMod: false, startupTimeoutMs: 300_000 },
  { name: 'fabric',         image: 'itzg/minecraft-server', type: 'FABRIC',  version: MC_VERSION, hasPlugin: false, hasMod: false, startupTimeoutMs: 300_000 },
  { name: 'fabric+mod',     image: 'itzg/minecraft-server', type: 'FABRIC',  version: MC_VERSION, hasPlugin: false, hasMod: true,  startupTimeoutMs: 300_000 },
];

export const nonPluginVariants = variants.filter(v => !v.hasPlugin && !v.hasMod);
export const addonVariants = variants.filter(v => v.hasPlugin || v.hasMod);
