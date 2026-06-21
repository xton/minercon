# Publishing & audience roadmap

Everything between "works great locally" and "strangers use it". Roughly in
order. npm name check (2026-06-12): **`minercon` is unclaimed on the npm
registry** — grab it early.

## 1. Pre-flight: make the package publishable

- [x] **Fix the npm tarball** — `files` whitelist added (`out/*.js`,
  `out/minercon`, `images/icon.png`, `CHANGELOG.md`); tarball now ships
  29 files / 285 KB instead of 129 files / 1.2 MB. `prepublishOnly:
  "npm run compile"` added so the compiled tree is always fresh on
  publish.
- [x] **Fill in package.json metadata** — `author`, `keywords`, `homepage`,
  `bugs`, `repository.url` (git+https form), `engines.node: ">=18"`.
- [x] **Add `--version` to the CLI** — `-V`/`--version` reads from
  `package.json` at runtime; works for both `out/` and `dist/` install
  paths.
- [x] **Write the missing CHANGELOG entries** — CHANGELOG stops at 2.2.0
  (2025-10-03) but the package says 3.0.0; everything since (the standalone
  CLI, plugin mode + RconTabComplete, the help-crawl local mode, Ctrl+R,
  history persistence, `--no-plugin`, ...) is the actual launch story.
  The 3.0.0 entry is effectively the announcement post — write it well once,
  reuse it everywhere.
- [x] **LICENSE: add copyright line** — `Copyright (c) 2026 xton` added
  alongside Jake T Cooper's notice.
- [x] **Delete `.github/FUNDING.yml`** — was the unfilled template.
- [x] **Windows compile fix** — replaced `cp`/`chmod` in the compile script
  with `scripts/post-compile.js` (cross-platform Node script); CI added
  (`windows-smoke.yml`) covering compile, `--version`, `--help`, non-TTY
  rejection, and unit tests on `windows-latest`. Note: Linux container
  tests (real RCON connection) can't run on Windows CI runners — Docker
  Desktop isn't available there; test the connection manually on a Windows
  machine with Docker Desktop installed.
- [ ] **Refresh the demo media** — `images/demo-autocomplete.gif` predates
  argument hints/Ctrl+R; record one ~20s GIF (or asciinema for the CLI)
  showing: connect → type `/give` → live suggestions → Tab cycling →
  argument hint. This single asset gets reused in README, Marketplace,
  Reddit, and HN.

## 2. Publish to npm

The tag-driven release pipeline (`.github/workflows/release.yml`) now handles
the publish, provenance, and GitHub Release in one shot — the remaining manual
work is one-time account + trusted-publisher setup. `npm publish --dry-run`
already produces a clean 33-file / 94 kB tarball.

- [ ] **Create/verify the npm account** with 2FA, then configure **trusted
  publishing** (OIDC) instead of a long-lived token — npm → the `minercon`
  package → Settings → Publishing access → add a GitHub Actions trusted
  publisher with org/user `xton`, repository `minercon`, workflow filename
  `release.yml`, environment blank. CI then publishes via a short-lived OIDC
  token (no `NPM_TOKEN` secret, no `npm login`, no 2FA prompt), and provenance
  is attached automatically.
- [x] **Release workflow** — `.github/workflows/release.yml` runs on a `v*`
  tag: it checks the tag matches `package.json`, runs unit tests, builds the
  paper/spigot/fabric jars, runs `npm publish --provenance --access public`
  (the provenance attestation is a real trust signal for a tool that takes
  server passwords), and creates a GitHub Release with the jars + the published
  `.tgz` attached for non-npm users.
- [ ] **Cut the release**: `git tag v3.0.0 && git push origin v3.0.0`. After it
  lands, verify with a cold `npm install -g minercon` on a clean
  machine/container and run against a real server.
- [ ] **Attach the `.vsix`** to the GitHub Release once §3 adds the `publisher`
  field to `package.json` (`vsce package` fails without it, so the mod/plugin
  jars ship in §2 and the `.vsix` follows in §3).

## 3. Publish to the VS Code Marketplace

The Marketplace is run through Azure DevOps; the steps are:

- [ ] **Create a publisher**: sign in at
  https://marketplace.visualstudio.com/manage with a Microsoft account →
  "Create publisher" → pick the publisher ID (e.g. `xton`) and display name.
- [ ] **Create a PAT**: at https://dev.azure.com → user settings → Personal
  Access Tokens → new token with org "All accessible organizations" and the
  **Marketplace → Manage** scope. (This is the step everyone fumbles —
  the scope must be Marketplace/Manage, not the defaults.)
- [ ] **Add Marketplace fields to package.json**: `"publisher": "<your-id>"`
  (required — packaging fails without it), and improve the listing:
  `keywords` show in Marketplace search, `galleryBanner` colors the header,
  `icon` is already set. Consider whether `categories: ["Other"]` is right
  (there's no great category for terminals; "Other" is what similar
  extensions use).
- [ ] **Create `.vscodeignore`** — without it the `.vsix` bundles everything
  (src, tests, docker/, plugin/, fabric-mod/, docs/). Exclude all of those;
  `vsce ls` shows exactly what will ship. (There are no runtime deps, so no
  bundler is needed — the compiled `out/` is already self-contained.)
- [ ] **Package and publish**: `npm i -g @vscode/vsce` → `vsce package`
  (produces `minercon-3.0.0.vsix`; install it locally via "Install from
  VSIX" as a final check) → `vsce login <publisher>` with the PAT →
  `vsce publish`. Subsequent releases: `vsce publish minor` bumps and
  publishes in one step.
- [ ] **Also publish to Open VSX** (https://open-vsx.org, `npx ovsx publish`)
  — it's the registry used by VSCodium, Gitpod, and many Cursor/forks
  setups; it's ~10 minutes of extra work for a real chunk of audience.
- [ ] README *is* the listing page — make sure the demo GIF is near the top
  and image links are absolute URLs (Marketplace can't resolve repo-relative
  paths for some setups; `vsce` rewrites most but verify the rendered page).

## 4. Publish the server-side addon where admins actually look

Plugin mode is the best experience, and plugin sites are themselves
discovery channels that link back to the client:

- [ ] **Hangar** (hangar.papermc.io) for the Paper/Spigot plugin — the
  modern Paper-ecosystem registry.
- [ ] **Modrinth** for both the plugin and the fabric mod (Modrinth hosts
  plugins now too, and is where Fabric users live).
- [ ] **SpigotMC resources** — older crowd but still the biggest plugin
  audience; the resource page doubles as a place people ask questions.
- [ ] Give the addon README a clear "this powers tab completion for the
  Minercon client → link" pitch (the naming unification from §12 is done).

## 5. Announce / find an audience

**Audience reality check**: the target user is someone on managed Minecraft
hosting (Apex, Shockbyte, BisectHosting, etc.) who gets RCON from their
provider but not SSH — hobbyist server operators, not professional admins.
Serious admins SSH to their servers and look down on RCON; they are not the
audience. r/admincraft skews heavily toward that crowd and also has a
community prohibition on AI-generated code, so it's off the table entirely.

Order matters: have npm + Marketplace + GitHub Release all live *before*
posting anywhere, then announce within a few days while it's fresh.

- [ ] **r/MinecraftCommands** — people who live in command syntax; the
  argument-hint/tab-completion angle lands well here, and this sub skews
  toward users who rely on the tools their host gives them (i.e. RCON).
  This is the single highest-value Reddit post.
- [ ] **r/feedthebeast** (modded servers — the Fabric mod angle) and
  **r/vscode** (the extension angle) as secondary posts, reworded per
  audience, spaced out by a week or so.
- [ ] **r/Minecraft** or **r/admincraft**-adjacent communities — not
  r/admincraft itself (AI code ban), but subreddits for specific server
  types (e.g. r/feedthebeast, r/MCPE) where managed-hosting users congregate.
  Keep messaging practical: "if your host gives you RCON but not SSH, this
  gives you a real terminal."
- [ ] **Hosting-provider communities** — forums, Discord servers, and help
  threads for popular managed hosts (Apex, Shockbyte, BisectHosting). These
  users have RCON but no SSH, which is exactly the audience; many hosts have
  a "third-party tools" or "resources" channel.
- [ ] **Discord servers**: PaperMC (#plugins / tooling channels) and
  Fabric's discord (for the mod). Skip the Admincraft discord — same
  professional-admin skew as r/admincraft. Ask-don't-spam: most have a
  showcase channel.
- [ ] **Awesome lists** — PR to awesome-minecraft / awesome-vscode style
  lists once the listing pages look good.
- [ ] After launch: enable GitHub Discussions (or point people at issues),
  and watch the Marketplace Q&A tab — answered questions are marketing.

