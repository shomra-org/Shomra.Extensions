# NoFly — AI Security (VS Code & Cursor)

Gate and fix AI artifacts — MCP servers, Skills, slash commands, hooks, and
rules files (`CLAUDE.md`, `.cursorrules`, …) — without leaving your editor. The
extension is a thin front-end over the `nofly` CLI (`NoFly.Agent/`):
one engine, two faces.

## What it does

- **Inline diagnostics.** On save (and on open) the artifact you're editing is
  gated; findings show up as squiggles **on the exact offending line** with the
  rule and the fix. Runs **local-first**, so you get a verdict with no backend;
  enroll (`nofly init`) to layer your org policy on top.
- **One-click fix.** A `NoFly: Fix this file (AI)` quick-fix (lightbulb) on any
  flagged artifact generates a minimal fix and applies it in place — clean undo,
  nothing committed or pushed.
- **Explain a finding.** `NoFly: Explain findings (AI)` distils each finding into
  why-it-matters + a one-line exploit + an honest false-positive read (Output →
  NoFly) — for when you think the gate is wrong.
- **Known-vulnerable model detection.** As you save Python, notebooks, or JS/TS,
  the extension scans for AI models you load (`from_pretrained("gpt2")`,
  `hf_hub_download`, `SentenceTransformer`, …) and looks each up in the **NoFly
  Model Index**. Models with known vulnerabilities get a squiggle **on the load
  line** — with the verdict, risk and CWEs — and a `View model in the Model Index`
  quick-fix that opens its security page. Both the bare (`gpt2`) and canonical
  (`openai-community/gpt2`) ids resolve. Toggle with `nofly.checkModels`.
- **Status bar.** Shows `⛨ NoFly` / `N blocked` for the workspace; click to
  re-scan everything.
- **Commands** (`Ctrl/Cmd-Shift-P` → "NoFly"): Check Workspace, Check This File,
  Check AI Models in This File, Fix This File, Install Runtime Firewall.

## Requirements

**None — the extension bundles the `nofly` CLI and runs it with VS Code's own
Node runtime.** Install it and it works; there's nothing to set up.

If you *do* have a global `nofly` on your PATH (e.g. `npm i -g @nofly/agent`,
enrolled with your org key), the extension prefers it automatically so enrolled
and org-policy features light up. To pin a specific build instead, point
**Settings → `nofly.executable`** at a script:

```
node C:/Users/you/…/Dragox/NoFly.Agent/nofly.mjs
```

(A value ending in `.mjs`/`.js` is run with Node automatically.) `Fix This File`
additionally needs enrollment (`nofly init --key shm_live_…`), because the AI
fix is generated on the platform with your org key — no provider key ever sits
on the dev machine.

## Install

### From a `.vsix` (works in both VS Code and Cursor)

```bash
cd Dragox.Extension
npm install
npm run compile
npx @vscode/vsce package        # → nofly-<version>.vsix (version from package.json)
```

- **VS Code:** Extensions view → `⋯` → *Install from VSIX…*, or
  `code --install-extension nofly-<version>.vsix`.
- **Cursor:** Extensions view → `⋯` → *Install from VSIX…*, or
  `cursor --install-extension nofly-<version>.vsix`.

### Develop it

Open this folder in VS Code and press **F5** to launch an Extension Development
Host with the extension loaded.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `nofly.executable` | `nofly` | CLI command or absolute path (`.mjs`/`.js` → run with Node). |
| `nofly.checkOnSave` | `true` | Gate an artifact when you save it. |
| `nofly.checkOnOpen` | `true` | Gate an artifact when you open it. |
| `nofly.checkWorkspaceOnStartup` | `false` | Sweep the whole workspace once on window open. |

## How it maps to the CLI

| In the editor | Under the hood |
|---|---|
| Save an artifact | `nofly gate <file> --json` → diagnostics (on `finding.line`) |
| Check Workspace / status bar | `nofly check <folder> --json` |
| Fix this file (lightbulb) | `nofly fix <file> --json` → applied as an edit |
| Explain findings (lightbulb) | `nofly why <file> --json` → Output → NoFly |
| Install Runtime Firewall | `nofly install-hook` (in a terminal) |

Because the CLI does the analysis, the extension stays tiny and always agrees
with what your CI and pre-commit gate see.
