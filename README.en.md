# dsh-plugin-manager-pro

> A local plugin manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): a **standalone plugin page** (visual plugin management) plus a **standalone brick-rescue toolchain**.

![badge](https://img.shields.io/badge/dsh-0.1.7-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-plugin-manager-pro?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-plugin-manager-pro)

> Community plugin — not an official DSH package. npm: `dsh-plugin-manager-pro` · GitHub: [nonentity303/dsh-plugin-manager](https://github.com/nonentity303/dsh-plugin-manager) · Cross-platform (Windows / macOS / Linux).
>
> **Published release 0.9.1** (npm `latest`); the repo's `package.json` `version` is now **`0.9.1-rc2`** — a **pre-release** shipped under the **`next`** dist-tag (`npm i dsh-plugin-manager-pro@next`) that does **not** move `latest`; the previous published release is 0.9.0 (npm + GitHub Releases, 2026-09-30).
> Check what is published any time with `npm view dsh-plugin-manager-pro version`; tags: <https://github.com/nonentity303/dsh-plugin-manager/tags>.
> ⚠️ A brand-new release is blocked by pnpm's 24 h cool-down (`minimumReleaseAge`) — pin the version explicitly if it does not install (see "Install" below).

![Standalone plugin page: sidebar entry "Plugin manager" + five sections](https://raw.githubusercontent.com/nonentity303/dsh-plugin-manager/master/docs/images/pm-090-official2.png)

<sub>**Figure 1** · the 0.9 standalone plugin page (captured in an isolated rehearsal environment on DSH **0.1.7-rc.2**, 2026-09-28): the sidebar entry "Plugin manager" and the five section tabs — Official built-ins (optional) · All plugins · Market · Operations & scenarios · Maintenance. Source image: `docs/images/pm-090-official2.png`.</sub>

---

## 🧭 Why this manager exists: the official page does the basics, this one covers the rest

Since DSH **0.1.6** the plugin manager is part of the engine itself: a host service `@deepseek-ai/dsh-plugin-manager` (a new `id: plugin-manager` row in the `dsh-base` bundle) plus a client page `@deepseek-ai/dsh-client-ui-plugin-manager`.¹³

This manager is not "one more plugin list". It **takes over that page and adds what the official one does not do**: a complete install/uninstall loop (impact preview → transactional uninstall → rollback on failure → one-click undo), operation history and named scenarios, and **rescue when the engine itself will not start**.

### Capability comparison

| Capability | Official built-in page (DSH 0.1.7) | LX2000WASD/dsh-web-plugin-manager (**discontinued**) | This manager (0.9.1) |
|---|---|---|---|
| Starts on DSH 0.1.7 | ✅ shipped with the engine | ❌ breaks the profile since 0.1.6 (loader entry id collision)¹ | ✅ verified on 0.1.7-rc.2: rehearsal + clean-environment install⁴ |
| Transactional uninstall (impact preview → backup → remove → pre-boot self-check → rollback) | ❌ only bundle layer add/remove (`installBundle` / `removeBundle`); no preview, no undo³ | ⚠️ can uninstall (incl. bundles) but **not transactionally**: failures only say "restart to take effect", recovery means editing `cordis.patch.yml` by hand¹ | ✅ full loop, plus **one-click undo**⁴ |
| Automatic rollback | ⚠️ restores profile files when a bundle install/remove fails³ | ⚠️ quality gate + rollback for install/update; **none for uninstall**¹ | ✅ rollback on uninstall *and* on "auto-install from the downloads folder"⁴ |
| Standalone rescue (works when the engine is down) | ❌ the rescue page is served by the engine, so it dies with it⁵ | ❌ no standalone daemon/launcher; its own "known limitations" say the auto-restart chain can hang and needs manual recovery¹ | ✅ 3081 launcher + 3082 rescue service, independent of the main process⁴ |
| Operation history / undo | ❌ | ❌ not in its feature list or CLI¹ | ✅ last 20 operations, one-click undo⁴ |
| GitHub Releases | — (released with the engine) | **0** | **11** (incl. v0.9.0 with a tgz asset)² |

**Sources** (each one verifiable):

1. Competitor README (announcement + feature list + known limitations + CLI): <https://raw.githubusercontent.com/LX2000WASD/dsh-web-plugin-manager/master/README.md> (mirror if raw is unreachable: <https://cdn.jsdelivr.net/gh/LX2000WASD/dsh-web-plugin-manager@master/README.md>) · repo <https://github.com/LX2000WASD/dsh-web-plugin-manager>. It contains `TypeError: duplicate loader entry id: plugin-manager` and "do not install on 0.1.6-alpha.2 or later".
2. GitHub API, measured 2026-10-03: competitor `releases` → `[]` (<https://api.github.com/repos/LX2000WASD/dsh-web-plugin-manager/releases>); this repo → **11** releases, latest `v0.9.0` (2026-09-30) with asset `dsh-plugin-manager-pro-0.9.0.tgz` (<https://api.github.com/repos/nonentity303/dsh-plugin-manager/releases>).
3. Official page capability surface (0.1.7-rc.2) = the 12 remote methods of `@deepseek-ai/dsh-plugin-manager`: `listPlugins` / `listBundles` / `registries` / `inspect` / `setPluginEnabled` / `setBundleEnabled` / `installBundle` / `waitForInstall` / `cancelInstall` / `removeBundle` / `listVersionExemptions` / `setVersionExemption` (<https://www.npmjs.com/package/@deepseek-ai/dsh-plugin-manager>); the page itself is <https://www.npmjs.com/package/@deepseek-ai/dsh-client-ui-plugin-manager>. There are **no** impact preview, history/undo, scenarios or rescue methods.
4. This repository: `cordis.patch.yml` (disable the built-in page, insert our own row id), `lib/index.js` (uninstall transaction, history, sidecar), `bin/rescue-daemon.mjs` · `bin/open-boot.mjs` · `bin/dsh-boot.mjs` (matching `package.json` `bin`); 0.1.7-rc.2 evidence in `docs/releases/RELEASE_NOTES_0.8.3-1.md` and `docs/releases/0.9.0.md`.
5. `/rescue` is registered by **our host code** through the engine's `webServer` — hence it dies with the engine. That is exactly why the standalone services exist (`bin/rescue-daemon.mjs` header, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

### "Why the old manager died" — and why this one is alive

Since DSH 0.1.6 a third-party manager hits the same wall: **declare a loader entry id that the official bundle already uses and the profile crashes on startup**:

```
TypeError: duplicate loader entry id: plugin-manager
```

The leading competitor [LX2000WASD/dsh-web-plugin-manager](https://github.com/LX2000WASD/dsh-web-plugin-manager) (measured 2026-10-03: 68 stars / 3 forks / last push 2026-09-20 / **0 releases**) left the field that way: in 2026-09 it announced end-of-maintenance on its README front page ("for DSH <= 0.1.5-rc.2", "**do not install on 0.1.6-alpha.2 or later**").¹

**This manager hit the same pit and survived** — by not fighting over the id:

| What it does | Where |
|---|---|
| ① Disable the built-in page row: `- id: ui-plugin-manager` / `disabled: true` | `cordis.patch.yml` (in the package) |
| ② Insert its own row with its own id `plugin-manager-pro` — **never the official `plugin-manager`** | `cordis.patch.yml` |
| ③ Register into `main` (key=`plugins`) and `sidebar.panellist` (id=`plugins`) and declare the 7 `plugins.*` child slots the built-in page used to own (so third-party config cards have a real home) | `src/client.jsx` |

Verified on **DSH 0.1.7-rc.2**: the engine boots cleanly, the sidebar shows "Plugin manager" and all five sections — that is Figure 1.

> **Which version should I install?** DSH **0.1.6 or later → 0.9.1** (to try the pre-release: `npm i dsh-plugin-manager-pro@next` = **0.9.1-rc2**, shipped under the `next` dist-tag, does not move `latest`); **old engines (before 0.1.6) → 0.8.2**. Full matrix under "Requirements".

![Impact preview of a transactional uninstall plus the rescue/diagnostics entries in the same card](https://raw.githubusercontent.com/nonentity303/dsh-plugin-manager/master/docs/images/pm4-uninstall-preview.png)

<sub>**Figure 2** · the **impact preview** of a transactional uninstall (rehearsal environment, 2026-09-28): what will be removed and what is affected, before `package.json` is touched; the same "diagnostics" card also carries the rescue entries (`Repair engine` / `Restart engine` / `Pre-boot self-check` / `auto-quarantine failing plugins`). Source image: `docs/images/pm4-uninstall-preview.png`.</sub>

---

## ✨ Highlights

- **Standalone plugin page** (v0.9.0): a first-level sidebar entry "Plugin manager" instead of a tab inside Settings — see plugins, install, **configure**, uninstall and rescue on one page, in five sections: **Official built-ins (optional) · All plugins · Market · Operations & scenarios · Maintenance**.
- **Third-party config entries have a home** (v0.9.0): after taking over the built-in page, plugin-registered config cards still work — one summary line in the row, and the plugin's own full config card when expanded.
- **Transactional uninstall** (v0.8): impact preview (dependents / entries / toggle rows) → backup → remove → pre-boot self-check → **automatic rollback on failure**; **one-click undo** afterwards.
- **Operation history + scenarios** (v0.8): the last 20 operations are undoable; save a plugin combination as a named scenario and switch with a change preview.
- **Rescue decoupled from the engine** (v0.7+): with the engine down, the **3081 launcher (with a built-in rescue page) and the 3082 rescue service** still self-check, repair and start it.
- **Browser as launcher**: set your home page to `http://127.0.0.1:3081/` (`http://localhost:3081/` works the same way) — opening the browser runs self-check → repair → start → jumps to the main UI.
- **Local write endpoints are guarded** (v0.9.1): same-origin `Origin` (same-host, same-port allowlist: `127.0.0.1` / `localhost` / `[::1]`) + one-time token + single-flight, so a third-party page cannot start/stop anything; `--status` also appends a `health.log` line (7 days / 1000 lines).
- **Multi-source update aggregation**: npm registry / dshfind / GitHub / custom mirrors queried in parallel, with rate-limit circuit breaking and the highest version winning.

---

## 📋 Feature overview (v0.9.1)

### Plugin page (sidebar "Plugin manager")

Five sections, switching keeps your scroll position:

| Section | Contents |
|---|---|
| **Official built-ins (optional)** | Engine-provided bundles that are disabled by default (one-click enable/disable) + official plugins with their own config page + version exemptions |
| **All plugins** | Plugin list: search, collapsible groups, origin filter, enable/disable, inline config, inline uninstall, version & origin, manual origin override |
| **Market** | dshfind curated catalog (browse by category / search / sort), one-click install; falls back to GitHub search when offline |
| **Operations & scenarios** | Transactional uninstall with impact preview, **pre-uninstall health check**, operation history undo, scenarios |
| **Maintenance** | Update sources, pre-boot self-check, rescue center entries, downloads folder |

### Plugin list

- **Collapsible groups** by necessity (🔴 required / 🟡 recommended / 🟢 optional) with enable counters and update badges; search expands automatically.
- **Origin classification**: built into the architecture vs user-installed (`dsh plugin add` / market), with filter chips and row badges.
- **Manual origin override** per row (npm / GitHub / local / built-in), persisted.
- **Status at a glance**: 🔴 error/needs attention · 🟡 update available · ⚪ disabled · 🟢 enabled, plus name, summary, necessity, installed→latest version, origin and a toggle.
- **Automatic one-line summaries** from a built-in catalog, or from `README.zh.md` / `package.json.description` / `README.md`.
- **Architecture protection**: rows the web layer deliberately disables (e.g. `tool-fs`) and UI skeleton plugins cannot be toggled (🔒 with a reason).
- **Third-party config cards** (v0.9.0): entries registered through `plugins.row.config` (per row) and `plugins.bundle.config` (per bundle) are rendered inline; plugins without a config registration get no empty button.

### Transactional uninstall, history and scenarios

- **Impact preview**: dependents (reverse `dependencies` / `peerDependencies` graph), entries to be removed, toggle rows to be cleaned, bundle declarations.
- **Pre-uninstall health check** (v0.9.1): a verdict line (**safe / caution / risky** + one-line reason) and three checks — ① broken dependencies (high for `dependencies`/`peerDependencies`, info for optional/recommended; downgraded when the dependent is itself depended on) ② **patch residue** in `cordis.patch.yml` (report only — never auto-deleted) ③ **service / port conflicts** (`dsh.services` / `service` / `provides` / `ports`).
- **The transaction**: back up `package.json` + `cordis.patch.yml` (`.rescue-bak-*`) → `pnpm remove` + drop bundles/toggle rows → run the pre-boot self-check → **roll back on any failure** (restore backups + reinstall dependencies). Directories locked by Windows are queued in `pendingRemovals` and retried on the next start.
- **Before uninstalling the manager itself**, the package's own `bin/open-boot.mjs --uninstall` is called first (older versions have no such flag → recorded as "skipped", never blocking).
- **Operation history**: the last 20 operations (uninstall / toggle / quarantine / scenario / reset), one-click undo, persisted across restarts.
- **Scenarios**: save the current enable/disable state under a name and apply it later, with a change preview first.

### Updates and downloads

- **Parallel multi-source lookups**; highest version wins, ties picked at random.
- **Circuit breaking**: GitHub API 403/429 cools down for 10 minutes; full refresh runs 8 concurrent queries and results are cached for 30 minutes (a cache hit returns instantly; refresh duration depends on your network and the number of enabled sources).
- **Download order**: ① native browser download (hidden iframe, capturable by download managers) → ② external downloader → ③ built-in fallback (HTTP / aria2c / P2P magnet·torrent).
- **Auto-install from the downloads folder**: drop `.tgz` / `.tar.gz` into `$DSH_HOME\downloads`; manifest validation + pre-boot self-check, rollback on failure and a `.failed` stamp so it is not retried forever.

### Market

- Catalog endpoint `https://awesome-dsh-plugin.com/plugins.json` (`CATALOG_URL` in `lib/index.js`) with localized descriptions / stars / categories; entry count changes upstream; 10-minute host cache. Falls back to GitHub `topic:dsh-plugin` search when offline.
- **Zero round-trips**: the catalog is fetched once; search / category chips / sort / paging happen client-side.
- **One-click install**: npm-backed entries install straight from the registry; GitHub repos go through the built-in downloader; two-step confirmation; ✓ badge when installed.
- **Post-install validation**: `dsh.bundle` / `dsh.client` manifests are verified and rolled back if broken; pnpm hoist drift and `minimumReleaseAge` traps are recovered automatically.

### Rescue

- **Standalone rescue page `/rescue`**: self-contained HTML that talks straight to the host gateway, usable even when the UI is broken (diagnose / quarantine / repair / restart / uninstall).
- **Floating rescue button** (🛟, bottom right) as an entry point when the settings page is broken.
- **Auto-quarantine**: optional (**off by default**) and only for plugins that fail repeatedly; UI skeleton and infrastructure entries are protected and never disabled automatically.
- **Pre-boot self-check**: `verifyProfile` / `fixProfile` — broken bundles can take the engine down at boot; one-click check and quarantine repair.
- **Runtime quarantine**: when a plugin is incompatible with the engine, the loader can take the whole tree down (a static check cannot see it) — open-boot / rescue-daemon / dsh-boot parse the boot log, quarantine the failing entry and retry; quarantine rows are backed up and reversible.

![Maintenance → rescue: the diagnostics card](https://raw.githubusercontent.com/nonentity303/dsh-plugin-manager/master/docs/images/pm-maintenance-rescue.png)

<sub>**Figure 3** · the rescue side (same rehearsal environment, 2026-09-28): the "diagnostics" card in Maintenance with `Repair engine`, `Restart engine`, `Pre-boot self-check`, `auto-quarantine failing plugins`, and the list of uninstallable profile dependencies. Source image: `docs/images/pm-maintenance-rescue.png`.</sub>

### 🧰 Standalone rescue toolchain

> A classic rescue page is registered by the engine — **when the engine is down, so is the rescue page**. Since v0.7 the rescue capability runs independently of the main process. No new dependencies (plain Node + the existing `yaml`).

| Tool | What it does | Usage |
|---|---|---|
| `bin/open-boot.mjs` | **The single web entry + resident supervisor** (3081): `/` is the "open the browser and it starts" page, **`/rescue` is the rescue page** (with `/rescue/api/*`). Set it as your home page (`127.0.0.1` / `localhost` / `[::1]` are equivalent as long as the port matches). It stays hidden and only pops a visible progress window when the engine really needs starting (`--no-window` disables that). Health = **HTTP handshake + identity fingerprint**; write endpoints are guarded by **Origin + one-time token**; `--uninstall` cleans everything (stop supervisor → remove autostart → remove shims → clear pid; exit codes 0 = completed / 1 = error / **2 = ownership unconfirmed** — nothing stopped, pid file kept) | `npx dsh-pm-launcher` |
| `bin/rescue-daemon.mjs` | **Independent backup rescue service** (default port **3082**): self-contained rescue page + `verify/fix/start/stop/status` API, no engine dependency. `stop` first verifies pid and port ownership (`{"force":true}` to force). **No longer competes with the 3081 launcher** (an occupied port is a hard error, never a silent port shift) | `npx dsh-pm-rescue` |
| `bin/dsh-boot.mjs` / `.cmd` | **Steam-style boot sequence**: verify → auto-quarantine broken plugins → start → wait for health. `--repair-only` (self-check + repair only, no start), `--pause`, `--help`; exit codes 0 = ready / 1 = failed to start / 2 = repair incomplete. Immediate failures (bad command, port conflict) return at once with the absolute log path | `npx dsh-pm-boot` (double-clickable equivalent on Windows: `bin\dsh-boot.cmd` inside the package) |

#### Resident launcher and autostart

| Command | Effect |
|---|---|
| `npx dsh-pm-launcher --supervise [--interval 60] [--heartbeat-min 10]` | **Resident supervisor**: quietly keeps 3081 alive; a lock port (`port+1000`) guarantees a single instance; only a failed HTTP handshake triggers a start — healthy instances are never killed. Writes four kinds of log lines (state change / heartbeat / exit / uncaught exception) to `profile/open-boot-supervisor.log` |
| `npx dsh-pm-launcher --ensure` | One-shot: make sure the port has this launcher (exit 0/1) |
| `npx dsh-pm-launcher --status` | **Status self-check + health trail**: launcher (handshake + identity) / supervisor (lock port ownership) / engine (3080 handshake) / pid file / cwd / logs and last heartbeat; exit 0 = launcher healthy. Reports the occupying pid when the port belongs to someone else. **Appends a `health.log` line every run** (7 days / 1000 lines kept) |
| `npx dsh-pm-launcher --install-autostart` | **Install autostart** (Windows): writes `HKCU\...\Run\DSHWebFront` plus `open-boot-autostart.vbs` (silent resident on login) and `open-boot-ui.vbs` (ensure 3081 then open the browser). The wrapper scripts are pure ASCII and self-resolve their path, so non-ASCII user names or profile paths with spaces no longer break |
| `npx dsh-pm-launcher --uninstall-autostart` / `--autostart-status` | Remove / inspect autostart (shim presence, supervisor liveness, whether the port is this launcher). Idempotent (exit 0) when nothing is installed |
| `npx dsh-pm-launcher --uninstall` | **Uninstall loop (R13)**: stop this profile's supervisor (three-fold ownership check: pid file + lock port `port+1000` + process image; refuses and never touches other processes) → delete **all** `DSHWeb*` Run values (including the legacy `DSHWebRescue`) → delete both `.vbs` shims → clear `.open-boot.pid` (logs kept). Exit codes: **0** = completed (including a confirmed "nothing to clean") / **1** = error / **2** = **ownership unconfirmed** (`netstat`/`tasklist` probes unavailable: no process stopped, pid file kept, never reports "uninstall complete"). Still idempotent; the engine on 3080 is left alone. The manager calls it before uninstalling itself |
| `npx dsh-pm-launcher --help` / `npx dsh-pm-boot --help` | Show usage (unknown flags are reported, not silently ignored) |

After installation the three commands come from the `bin` field of `package.json` (`dsh-pm-launcher` / `dsh-pm-boot` / `dsh-pm-rescue`). `npx` works without installing, and you can always run the file inside the package (path is independent of cwd):

```sh
node "$DSH_HOME/profiles/web/node_modules/dsh-plugin-manager-pro/bin/open-boot.mjs" --status
```

- **Shared modules**: `lib/preflight.mjs` (standalone self-check/repair, same logic as the host's `verifyProfile`/`fixProfile`), `lib/enginectl.mjs` (engine probing/start/stop/pid management + the write-endpoint guards).
- **Troubleshooting**: engine will not start → ① open `http://127.0.0.1:3081/` (`http://localhost:3081/` is equivalent) → "check → repair → start"; ② `npx dsh-pm-boot --repair-only` to see the quarantine list; ③ `npx dsh-pm-launcher --status` for the real state of launcher/supervisor/engine plus the last `health.log` line; ④ interactive start with `npx dsh-pm-boot`.
- **Full command/exit-code tables, the four `--uninstall` steps and a troubleshooting table**: [docs/LAUNCHER.md](docs/LAUNCHER.md). Architecture and slot contract: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **Health semantics and the safety of "stop engine"**: ready = **HTTP handshake succeeded and the response carries a DSH identity fingerprint** (a bare TCP listener is never considered healthy). So when 3080, 3081 or 3082 is occupied by something else, the tools **fail loudly instead of pretending to be ready** and never shift ports silently. `stopEngine()` runs three checks first (pid alive / process image is node·dsh / the port owner matches the recorded pid) and refuses otherwise, explaining why on the rescue page (a "force stop" button — or `POST /api/stop {"force":true}` — is available there). Pid files: `.rescue-daemon.pid` (engine) and `.open-boot.pid` (launcher), both JSON.
>
> **Working directory**: the engine and launcher use a **stable cwd** (your home directory by default; override with `--cwd <dir>` or `DSH_ENGINE_CWD`). Early versions put the cwd inside the package, which locked the directory during self-update/uninstall (`ERR_PNPM_EPERM`).

---

## Requirements

- Windows 10/11 · macOS · Linux (`/rescue` and the three CLI tools are cross-platform; **`--install-autostart` is Windows-only**, on macOS/Linux use `--supervise` with your own service manager).
- Node.js ≥ 18 · DeepSeek Harness `dsh` (global or via npx) · `pnpm` (required by `dsh plugin` and the update features).
  - **`engines.node` in `package.json` is the only statement of record** (currently `>=18.0.0`). Note: **0.9.1 fails to load on Node 18/20** (a top-level named import of `node:module`'s `findPackageJSON`, which only exists since Node **22.14** → link-time `SyntaxError`, the whole plugin never loads); **on Node 18/20 use 0.9.1-rc2 or newer** — it uses a namespace import + runtime feature detection + a fallback resolver, guarded by the static gate `node tools/dev/compat-scan.mjs --root .` (measured on this version: `blocker=0`, exit 0; on the published 0.9.1 tarball: `blocker=1`).
- **The engine version decides which manager version you install** (table below) — installing the wrong one means no plugin page, or a profile that will not start.

### Engine compatibility matrix (engine × manager)

| Your DSH engine | Manager version | Status | Verified | Notes / sources |
|---|---|---|---|---|
| **0.1.7-rc.2** | **0.9.1** (published) · **0.9.1-rc2** (pre-release, `next` dist-tag) | ✅ works | 0.9.0: 2026-09-28 rehearsal + clean-environment install; 0.9.1: all four test suites green; **0.9.1-rc2 (pre-release)**: launcher suite independently verified **448 checks / 418 OK / 30 SKIP(env) / 0 FAIL**, exit 0 (2026-10-07; all 30 SKIPs are sandbox boundaries, **not product failures**); static compat gate `compat-scan` on the candidate tarball **exit 0 / blocker 0** (the published 0.9.1 tarball reports blocker 1 / exit 2); it also carries the performance fixes (client bundle **792,931 → 255,903 B**, host hot-snapshot median **18.8 → 1.1 ms**); **the count of record is the output of `node test-launcher.mjs --strict`** (it moves with the tree) | Isolated rehearsal environment (separate `DSH_HOME` + ports): engine boots cleanly, sidebar "Plugin manager", all five sections (Figures 1–3 come from it). Sources: `docs/releases/0.9.0.md`, `docs/releases/0.9.0-verify.md`, `docs/releases/RELEASE_NOTES_0.8.3-1.md`, [docs/RELEASING.md](docs/RELEASING.md) |
| **0.1.6 and later** (incl. 0.1.6-alpha.2) | **0.9.1** (recommended) / **0.9.1-rc2** (pre-release) | ✅ recommended (takes over the built-in page) | 0.1.7-rc.2 verified; **0.1.6-alpha.x not tested individually** | The official page became part of the engine in 0.1.6; the `ui-plugin-manager` row our `cordis.patch.yml` disables is exactly that page (`@deepseek-ai/dsh-client-ui-plugin-manager`) |
| **0.1.0-rc.6 ~ 0.1.5** (engines before 0.1.6) | **0.8.2** | ✅ works (legacy "Settings → Plugins" tab) | 0.8.2 released 2026-09-04; the pre-upgrade baseline on this machine was engine 0.1.1-rc.2 + 0.8.x | 0.8.x and 0.9 are two different clients (`docs/releases/0.9.0.md` ⑤); **the 0.1.5 line was not tested individually** |
| **0.1.7-rc.2** | **0.8.2 / early 0.8.3 builds** | ❌ plugin never activates | measured in the 2026-09-28 rehearsal | Two independent causes: ① since 0.1.7 the typert strict codec must provide a `create()` factory; ② `dsh.client.inject` referenced `@deepseek-ai/dsh-client-runtime`, removed in 0.1.7. Fixed in 0.8.3-1 and 0.9.x |
| **0.1.6 and later** | **any third-party manager that declares the same loader entry id** (e.g. LX2000WASD 0.6.x) | ❌ profile will not start | competitor announcement, 2026-09 | `TypeError: duplicate loader entry id: plugin-manager` (the official `dsh-base` row id is `plugin-manager`); this manager uses its own id `plugin-manager-pro` |
| Already on 0.9.x with an engine before 0.1.6 | rollback: `dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2` | ⚠️ recovery path | — | see the rollback command under "Install" |

> **One line**: **newer engines want 0.9.1; only very old engines (before 0.1.6) need 0.8.2.** The 0.1.6 boundary is the only certain one; the transitional 0.1.6-alpha.x versions were not tested individually.
> **On Node 18/20 (or to try the pre-release) install `0.9.1-rc2`**: `npm i dsh-plugin-manager-pro@next` — 0.9.1 **fails to load on Node 18/20**, which is the first blocker this pre-release fixes (see `docs/releases/0.9.1-rc2.md`).
> The "verified" records come from the rehearsal environment, the clean-environment install report and the real-machine install archive (`docs/releases/0.9.0-verify.md`; developer workspace `upgrade-rehearsal/`, `audit/install-090/` — the latter two are not part of the npm package). The process is repeated for every engine patch release per `docs/RELEASING.md`.

## 🔐 Permissions and data scope

> What does it actually touch? Everything it reads or writes stays inside your **local profile directory** and the **update sources you configure**: no account, no cloud, no telemetry. Every write is preceded by a `.rescue-bak-*` backup and goes through an atomic "temp file + rename".

| Data | Purpose | Leaves the machine? |
|---|---|---|
| `~/.dsh/profiles/<name>/package.json` | read the installed plugin list (`dependencies` / `dsh.bundle` / `dsh.client`); written back by install/uninstall/scenario operations (backed up first) | No |
| `~/.dsh/profiles/<name>/cordis.patch.yml` | read/write enable-state and quarantine rows (only rows carrying the `Managed by dsh-plugin-manager-pro` marker; backed up first) | No |
| `~/.dsh/profiles/<name>/plugin-manager.json` (sidecar) | operation history (last 20), scenarios, manual origin overrides, pending removals, update-source config | No |
| `~/.dsh/profiles/<name>/node_modules/**` | read the dependency graph and package summaries; uninstall/quarantine deletes package directories via `pnpm` (Windows file locks are queued for the next start) | No (pnpm talks to the registry during install/uninstall) |
| `~/.dsh/profiles/<name>/vendor/downloads/*.tgz` | archive staging for browser downloads; archives still referenced by dependencies are never deleted | No |
| `$DSH_HOME/downloads/*` | "auto-install from the downloads folder" scans archives and writes `.installed` / `.failed` stamps | No |
| Local npm global root (Windows `%APPDATA%\npm`, macOS/Linux `npm root -g` and common paths) | **read-only**: locate the engine-provided `@deepseek-ai/*` packages and extract plugin summaries | No |
| Update sources: npm registry (`registry.npmjs.org` by default), dshfind, GitHub, mirrors you add (e.g. `registry.npmmirror.com`) | query versions and download archives | **Queries only** (GET metadata / archives) — no local data is uploaded |
| GitHub API: `api.github.com`, `raw.githubusercontent.com`, `codeload.github.com` | read releases and repository `package.json`, download tgz | same |
| Catalog `awesome-dsh-plugin.com/plugins.json` | market catalog (10-minute host cache) | same |
| Loopback ports `3080` / `3081` / `3082` (+ lock `4081 = 3081+1000`) | main UI / launcher + rescue page / backup rescue service / single-instance lock — bound to `127.0.0.1` only | No (never leaves the machine) |
| Windows registry `HKCU\...\Run\DSHWebFront` + profile `open-boot-autostart.vbs`, `open-boot-ui.vbs` | written **only when you explicitly run `--install-autostart`**; cleaned by `npx dsh-pm-launcher --uninstall-autostart` (or `--uninstall`) | No |
| Profile `.rescue-daemon.pid`, `.open-boot.pid`, `rescue-daemon.log`, `open-boot-supervisor.log`, `health.log` | pids, logs and the self-check trail (`health.log` keeps 7 days / 1000 lines) | No |

> **What it never touches**: conversation content, `settings.yaml`, `.credentials.yaml` (API keys) — there is no code path reading them in `lib/`.

## Install

> **Install from npm** (`dsh plugin … add` is pnpm underneath and reuses the engine-provided `@deepseek-ai/*`).

```sh
# 1) recommended (engine >= 0.1.6)
dsh plugin --profile web add dsh-plugin-manager-pro

# 2) right after a release (or during the 24 h cool-down) — pin the version, always reliable
dsh plugin --profile web add dsh-plugin-manager-pro@0.9.1

# 2b) pre-release: try 0.9.1-rc2 (shipped under the `next` dist-tag, does not move `latest`; use this on Node 18/20)
dsh plugin --profile web add dsh-plugin-manager-pro@0.9.1-rc2
# equivalent npm form: npm i dsh-plugin-manager-pro@next

# 3) offline tarball (downloaded from the GitHub Release page, or built with npm pack)
dsh plugin --profile web add ./dsh-plugin-manager-pro-0.9.1.tgz

# old engines (0.1.0-rc.6 ~ 0.1.5), or when 0.9.x does not take effect: roll back to the legacy UI
dsh plugin --profile web add dsh-plugin-manager-pro@0.8.2

# restart the web engine to load the client bundle
dsh web
```

> **Does not install / still shows the old UI?** Two usual causes: ① the engine loads client bundles **at startup** — restart `dsh web`; ② pnpm 11's **24 h cool-down** (`minimumReleaseAge`, default 1440 minutes) refuses versions published today unless you pin them (you can also add `dsh-plugin-manager-pro@0.9.1` to `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`).

After installing: the sidebar shows the first-level entry **"Plugin manager"** (the built-in page is disabled and taken over by this package's patch). 🛟 in the bottom right opens the rescue center; the engine-hosted rescue page is `http://127.0.0.1:3080/rescue`.

> ### Why `dsh plugin --profile web add` and not `npm install` in the directory?
>
> - This is a **plugin for the DSH engine** and needs modules the engine provides (`@deepseek-ai/*`). `dsh plugin add` uses **pnpm**, and the profile disables `autoInstallPeers`, so the engine's copy is reused instead of being installed twice.
> - The engine's `@deepseek-ai/*` packages are **pre-release versions** on npm (`-rc.*` / `-alpha.*`) with a messy version history (e.g. `dsh-home-paths` `latest` is stuck at `0.0.1-rc.3` while engines ship `0.1.7-rc.2`). Installing this package with **npm** makes npm resolve those pre-release ranges with its own peer rules — behaviour differs per npm version (a warning, or a hard `ERESOLVE`). **That is a fact about the engine's packages, not a defect of this plugin**; this package's own runtime dependencies are just `yaml` and `zod`.
> - If your npm config is strict about pre-release peers, add `--legacy-peer-deps`.
> - Conclusion: **always install into a profile with `dsh plugin … add`**; `npm install` is only for the devDependencies of this repository (see "Development and tests").

Uninstall:

```sh
dsh plugin --profile web remove dsh-plugin-manager-pro   # calls --uninstall below to clean autostart/supervisor/shims first
npx dsh-pm-launcher --uninstall-autostart                # Windows: remove autostart (idempotent)
npx dsh-pm-launcher --uninstall                          # optional: remove every launcher trace (stop supervisor + delete DSHWeb* + shims + pid)
```

## Rescue quick reference

| Situation | What to do |
|---|---|
| Engine is fine, UI is broken | `http://127.0.0.1:3080/rescue` (rescue page / 🛟 button) |
| Engine will not start | `http://127.0.0.1:3081/rescue` (the launcher's rescue page; `/` is the "open and it starts" page; `http://localhost:3081/…` is equivalent) → check → repair → start. Independent backup entry: `npx dsh-pm-rescue` (port **3082**) |
| Want "open the browser and it starts" | Set your home page to `http://127.0.0.1:3081/` (`http://localhost:3081/` is equivalent — same host and port); make it resident with `npx dsh-pm-launcher --install-autostart` |
| Want 3081 resident without windows | `npx dsh-pm-launcher --supervise` (silent; a visible window appears only when the engine must be started; `--no-window` disables it) |
| Want the state of 3080/3081/3082/4081 | `npx dsh-pm-launcher --status` (launcher identity / lock ownership / engine handshake / pid files / last heartbeat) and one `health.log` line |
| Remove every launcher trace | `npx dsh-pm-launcher --uninstall` (exit codes 0 = completed / 1 = error / **2 = ownership unconfirmed**: nothing is stopped and the pid file is kept — re-run from a session where `netstat`/`tasklist` work; the engine on 3080 and the logs stay) |
| Port 3081 serves someone else's page | The port belongs to another process: `--status` reports the pid; kill it or change `--port` and update your home page (the tool **never** shifts ports silently) |
| Command-line check & start | `npx dsh-pm-boot` (start) or `npx dsh-pm-boot --repair-only` (check + repair only); on Windows double-click `bin\dsh-boot.cmd` inside the package |
| Installed but the UI is still old | The engine loads client bundles at startup — restart `dsh web` (or let the launcher restart the engine) |
| Toggling a plugin does not change anything | The engine applies entries at startup: the change is written immediately but needs an engine restart (the UI tells you when) |

---

## How it works

- **Host** (`lib/index.js`): reads live Cordis loader state (enabled / runtime phase / error) and exposes remote methods through the Typert gateway (list / setEnabled / update / verifyProfile / fixProfile / marketCatalog / …). Convergence is judged from real engine fields (`Entry.disabled` / `_initTask` / `fiber.state`) and honestly reports "restart required" instead of pretending.
- **Plugin page takeover** (`src/client.jsx` + `cordis.patch.yml`): registers into `main` (key=`plugins`) and `sidebar.panellist` (id=`plugins`), disables the built-in `ui-plugin-manager` row and declares the 7 `plugins.*` child slots; the three that third-party plugins really use (`plugins.row.config` / `plugins.bundle.config` / `plugins.item`) have real render exits — **an unregistered key never produces an empty button**.
- **Toggle persistence**: rows written into the profile's `cordis.patch.yml`, always carrying the `Managed by dsh-plugin-manager-pro` marker so user-owned patch rows are never touched.
- **Update aggregation** (`lib/aggregate.js` + `compare-versions.js`): parallel sources → highest version → random tie-break; 10-minute circuit breaking on 403/429; full pre-release support.
- **Downloader** (`lib/downloader.js`): streaming HTTP; magnet/.torrent prefer an external downloader (cross-platform where/which) → built-in webtorrent → manual import.
- **Cross-platform** (`lib/platform.js`): npm global root via `%APPDATA%\npm` on Windows, `npm root -g` plus common paths and nvm directories elsewhere (10-minute cache).
- **Standalone rescue** (`lib/preflight.mjs` + `lib/enginectl.mjs`): plain-Node self-check/repair and engine lifecycle shared by all three CLI tools; port split: 3081 launcher (single web entry with `/rescue`), 3082 backup rescue service, 4081 supervisor lock.
- **Local write-endpoint guards** (v0.9.1, `lib/enginectl.mjs`: `newApiToken` / `allowedOriginsOf` / `guardWriteRequest` / `createSingleFlight`): the local write endpoints (`POST /api/boot`, `/rescue/api/start|fix|stop`) require a **same-origin `Origin`** — the same-host, same-port allowlist `127.0.0.1` / `localhost` / `[::1]`, **never derived from the `Host` header** (`localhost:3081` and `127.0.0.1:3081` are equivalent; another port is not) — plus a page-injected one-time token (`X-DSH-PM-Token`, 48 hex chars, never written to disk, rotated on every start); a missing `Origin` (local tools) still requires the token, otherwise 401. Boot/start are single-flighted (a concurrent second request gets 409), so a third-party web page cannot start/stop anything. Read endpoints (`GET /api/status|verify`) stay open for local tools.
- **Health trail**: `--status` appends `OK|FAIL boot=…@3081 engine=…@3080` to `profile/health.log` (7 days / 1000 lines).
- **Protected entries**: the manager itself, loader infrastructure, webserver/connection/ui-layout etc. cannot be toggled; the rescue and auto-quarantine protection sets share one source, and auto-quarantine additionally needs repeated failures.
- **Deep dive**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (process diagram, slot contract, sidecar fields, uninstall transaction) and [docs/LAUNCHER.md](docs/LAUNCHER.md) (command/exit-code tables).

---

## Development and tests

```sh
npm install                                  # if npm blocks the esbuild install script: npm approve-scripts esbuild
npm run build                                # bundle the browser side → lib/client.js
npm test                                     # build + bundle + render + integration + launcher
node test-launcher.mjs --strict               # launcher tests (random ports + temp profile, never touches a real profile/registry)
node tools/test-host-fixes.mjs                # host-side regression assertions
npm run check:vendor                          # vendor consistency (per-file sha256 inside the tgz == working tree)
npm run pack                                  # build + npm pack
node tools/dev/gen-changelog.mjs              # regenerate CHANGELOG.md from docs/releases/*.md
node tools/dev/gen-changelog.mjs --check      # verify CHANGELOG.md is up to date (exit 1 when stale)
```

Docs: [docs/RELEASING.md](docs/RELEASING.md) (release flow), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/LAUNCHER.md](docs/LAUNCHER.md), [CHANGELOG.md](CHANGELOG.md) (generated) and [docs/releases/](docs/releases/).

## FAQ

| Symptom | Cause & fix |
|---|---|
| Installed but the UI is still the old one / no new page | Client bundles load at engine startup: **restart `dsh web`** (or let the launcher restart the engine) |
| Plugin state does not change after toggling | The engine applies entries at startup: written to config immediately, **effective after an engine restart** |
| `dsh plugin add` says "Already up to date" | pnpm caches tarballs by version: **bump the version** before adding again |
| Engine will not start (broken bundle in `package.json`) | Open `http://127.0.0.1:3081/rescue` → check → repair → start; or `npx dsh-pm-boot --repair-only` |
| No `/rescue` on 3081 | 0.9.0 and earlier only had the rescue flow on the launcher's `/` (or on the 3082 service). 0.9.1 serves `/rescue` and `/rescue/api/*` on 3081 — upgrade the plugin |
| Worried a third-party page can trigger start/stop | It cannot: write endpoints require a **same-origin `Origin`** — same host *and* the same port only, i.e. `127.0.0.1` / `localhost` / `[::1]`, **never derived from the `Host`/`Referer` header** — plus a one-time token (`X-DSH-PM-Token`; a missing `Origin` still needs it, otherwise 401), and they are single-flighted (403 / 401 / 409) — see [docs/LAUNCHER.md](docs/LAUNCHER.md) §4 |
| Browser reports `waiting for service: remote.xxx` | A client `inject` must not include its own remote (deadlock); inject only keeps `["slots","locale","remote"]` |
| A third-party plugin has no ⚙ config entry | Since 0.9.0 entries are generated for its registered slots; if the plugin has not adopted the 0.1.7 slots yet, report it to the plugin author |
| P2P magnet links will not download | Install aria2c (auto-detected) or webtorrent, or import the file manually into your download manager |

## License

MIT. The patch-persistence approach is inspired by [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager) (MIT).

---

## 中文

中文说明（主文档）：[README.md](README.md) — 与本文的功能清单与命令保持一致。
