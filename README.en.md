<p align="center"><img src="docs/images/logo.svg" width="88" height="88" alt="DSH engine drydock"></p>

# DSH engine drydock (dsh-drydock)

> **When the engine won't start, it is still there.** A **boot-time reliability toolchain** for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness): standalone processes and ports for pre-boot self-check, broken-plugin quarantine and engine rescue (3081 / 3082), plus a tidy plugin manager.
>
> The official page and plugin markets handle **getting plugins in**; the drydock handles **what happens afterwards** — undo a bad install, rescue a dead engine. *It fixes this boot; we fix why the next one would break.*

![badge](https://img.shields.io/badge/dsh-0.1.7+-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/npm/v/dsh-drydock?color=orange) ![npm](https://img.shields.io/npm/dt/dsh-drydock)

> Community plugin — not an official DSH package. npm: `dsh-drydock` (formerly `dsh-plugin-manager-pro`, which is deprecated on npm but not deleted; kept for installing historical versions) · GitHub: [nonentity303/dsh-drydock](https://github.com/nonentity303/dsh-drydock) · Cross-platform (Windows / macOS / Linux).
>
> **Current version: 1.1.0-desktop.2** (desktop channel; `npm view dsh-drydock dist-tags`; tags: <https://github.com/nonentity303/dsh-drydock/tags>).
> ⚠️ A brand-new release is blocked by pnpm's **24 h cool-down** (`minimumReleaseAge`) — pin the version explicitly if it does not install (see "Install" below).

## Four signature features

### ① Standalone rescue toolchain — works when the engine does not
The 3081 launcher (`/` boot page, `/plugins` fallback manager, `/rescue` rescue page) and the 3082 backup rescue daemon run in **separate processes and ports**, independent of the Cordis runtime; `verify / fix / start / stop / status` return explicit exit codes (0 ready / 1 start failed / 2 repair incomplete) and are script-callable. → [docs/RESCUE.md](docs/RESCUE.md)

### ② Transactional uninstall / rollback / one-click undo
Impact preview + pre-uninstall verdict (safe / caution / risky) → backup → remove → verify every step → **automatic rollback on any failure**; Windows file-lock leftovers are queued in `pendingRemovals` and retried on the next start; the last 20 operations are undoable and plugin combinations can be saved as **named scenarios**. → [docs/USAGE.md](docs/USAGE.md)

### ③ Update-source trust model + download provenance
Defaults are npm official `registry.npmjs.org` / GitHub official repo / npmmirror, and **the registry version is authoritative**; custom sources are `authoritative: false` by default and **fallback only** (never mixed with the official ones); `http://` sources are allowed but labelled "**plaintext · fallback only**" and need explicit `authoritative: true` + `allowInsecure: true` to take part in version decisions; only `@deepseek-ai/*` uses the `next` track; auto-install from the downloads folder requires a matching **provenance** record (name + version + source + digest, valid 7 days). → [docs/SECURITY.md](docs/SECURITY.md)

### ④ 3081 fallback page + cross-platform Chinese UI
With the engine down, `http://127.0.0.1:3081/plugins` still enables / disables, updates, uninstalls and restarts it; fully localised (Chinese) UI, light/dark theme following the system; Windows / macOS / Linux (`--install-autostart` is Windows-only). → [docs/USAGE.md](docs/USAGE.md)

## Install (30 seconds)

```sh
# Recommended: pin the version so pnpm's 24 h cool-down cannot block it
dsh plugin --profile web add dsh-drydock@1.0.4

# Restart the web engine (client bundles load at engine startup)
dsh web
```

Then use the sidebar **"Plugin manager"** on `http://127.0.0.1:3080`, or the fallback page `http://127.0.0.1:3081/plugins`. Set your browser home page to `http://127.0.0.1:3081/` and opening the browser self-checks, repairs and starts the engine.

- **Do not want a profile install?** `npx dsh-drydock` runs the 3081 launcher, `npx dsh-drydock-boot --repair-only` self-checks and repairs, `npx dsh-drydock-rescue` runs the 3082 backup rescue.
- **Did not install / still the old UI?** ① client bundles load at startup — **restart `dsh web`**; ② pin the version during the 24 h cool-down (or add `dsh-drydock@1.0.4` to `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`). Full install / update / uninstall / rollback / offline tgz / autostart: [docs/INSTALL.md](docs/INSTALL.md).

## Upgrade check (users on pre-0.9.1 builds)

> ⛔ **`dsh-plugin-manager-pro` releases before 0.9.1 (including `0.9.1-rc2`) are retired**: they carry known supply-chain risk and crash on load with Node < 22.14. npm now shows a **strengthened deprecation notice** (packages are not deleted; historical versions remain installable but should not be used).

Upgrade with one command:

```sh
dsh plugin --profile web remove dsh-plugin-manager-pro   # drop the old package
dsh plugin --profile web add dsh-drydock@^1.0.4          # the only recommended entry
dsh web                                                   # restart to apply
```

`dsh-drydock` is the only recommended package name; rollback inside 1.0.x uses the same name (e.g. `dsh-drydock@1.0.3`). The engine must be ≥ 0.1.7-rc.2; older engines should stay on their historical release. See [docs/INSTALL.md](docs/INSTALL.md) and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Entries

| Entry | Address | Purpose |
| --- | --- | --- |
| Manager (3080) | `http://127.0.0.1:3080` → sidebar "Plugin manager" | Everyday entry: list / install / configure / uninstall / rescue |
| Fallback page (3081) | `http://127.0.0.1:3081/plugins` | Available with the engine down: toggle / update / uninstall / health check / restart |
| Boot page (3081) | `http://127.0.0.1:3081/` | Open and it self-checks → repairs → starts (best as browser home page) |
| Rescue page (3081) | `http://127.0.0.1:3081/rescue` | verify / fix / start / stop / status |
| Rescue button 🛟 | bottom-right of 3080 | Draggable, remembered position; entry when settings are broken |

> The engine also serves `/rescue` at `http://127.0.0.1:3080/rescue`, but it goes through host admission: **entering from inside the app** (rescue button / plugin page) works; typing it in the address bar is an origin-less top-level navigation and gets 403. Use the 3081 page when the engine is down.

## Requirements

- Windows 10/11 · macOS · Linux (rescue toolchain and all three bins are cross-platform; **autostart management is Windows-only**).
- Node.js: `engines.node` declares `>=18.0.0` (not tightened in this release), but Node 18 is EOL and pnpm 11 no longer supports 18/20/21 — **run Node 22 LTS or newer**.
- DSH `dsh` ≥ `0.1.7-rc.2` (`<0.3.0-0`) and `pnpm` (`dsh plugin` and updates depend on it).
- Loopback ports `3080` (engine) · `3081` (launcher) · `3082` (backup rescue) · `4081` (supervisor lock = 3081+1000), all bound to `127.0.0.1`.

Details: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Docs

The detailed docs are currently **Chinese only** — English deep-dive docs have **not been split yet**; `README.en.md` is a condensed entry and links below point to the Chinese docs.

| Doc | Content |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Install / update / uninstall / rollback / offline tgz / 24 h cool-down / autostart / ports / upgrading from the old package |
| [docs/USAGE.md](docs/USAGE.md) | Carriers, origin three-way sections and tabs, transactional uninstall, history, scenarios, updates & downloads, market, fallback page |
| [docs/SECURITY.md](docs/SECURITY.md) | Permissions and data scope, update-source trust model, download provenance, write-endpoint guards, admission, threat model |
| [docs/RESCUE.md](docs/RESCUE.md) | Standalone rescue toolchain, rescue quick reference, 3081 API, how it works, 3082 |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | Requirements, engine compatibility matrix, Node, platforms and ports |
| [docs/FAQ.md](docs/FAQ.md) | FAQ and troubleshooting (including old-package upgrades) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Three-process architecture, slot contract, sidecar fields, uninstall transaction |
| [docs/LAUNCHER.md](docs/LAUNCHER.md) | All CLI commands and exit codes, `--uninstall` loop, write-endpoint guards |
| [CHANGELOG.md](CHANGELOG.md) | Version history (generated) |
| [docs/releases/](docs/releases/) | Per-release notes ([1.0.4](docs/releases/1.0.4.md)) |
| [docs/README-full.md](docs/README-full.md) | v0.9.1-era full archive — **not the current manual** |

## License

MIT. The patch-persistence approach is inspired by [hrhgit/deepseek-harness-plugin-manager](https://github.com/hrhgit/deepseek-harness-plugin-manager) (MIT).

Chinese (main) documentation: [README.md](README.md).
