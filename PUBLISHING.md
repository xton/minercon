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
- [ ] **Write the missing CHANGELOG entries** — CHANGELOG stops at 2.2.0
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

- [ ] Create/verify npm account with 2FA; `npm login`.
- [ ] `npm publish --dry-run`, then `npm publish` (unscoped packages are
  public by default). Verify with a cold `npm install -g minercon` on a
  clean machine/container and run against a real server.
- [ ] Tag `v3.0.0` and create a GitHub Release; attach the `.vsix`, the
  plugin jar, and the fabric mod jar so non-npm users have direct downloads.
- [ ] (Nice) Set up a GitHub Actions release workflow that publishes on tag
  with `npm publish --provenance` — the provenance badge is a real trust
  signal for a tool that takes server passwords.

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
- [ ] **Show HN** — "Show HN: Minercon – a Minecraft RCON terminal with tab
  completion". HN loves the technical meat: the double-packet fragmentation
  fence and the /help-crawl Brigadier reverse-engineering
  (docs/NO_PLUGIN_HELP_CRAWL.md is most of a blog post already).
  Consider polishing that into a post and submitting the post instead of the
  repo.
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

## 6. Relationship with the original author (jaketcooper/Minecraft-rcon)

There's no legal todo — MIT is satisfied by the preserved LICENSE copyright
line and the README Acknowledgements (both already in place). The rest is
courtesy, which costs little and occasionally pays off big:

- [ ] **Send a friendly heads-up** (GitHub issue on his repo, or email if
  listed): the fork lives on, got renamed to Minercon, here's what it became,
  he's credited in README + LICENSE — and a thank-you. No ask attached.
- [ ] **Offer a cross-link**: if his project is dormant, he may be happy to
  add "actively maintained fork: minercon" to his README — that converts his
  existing installs/stars into your funnel. His call; offer once.
- [ ] If he engages, add him to `contributors` in package.json and the
  release notes. If he doesn't respond, the existing attribution is already
  correct and sufficient — proceed.
- [ ] Keep the branding distinct (already done — different name, icon, and
  description), so Marketplace/npm listings can't be confused with his.
