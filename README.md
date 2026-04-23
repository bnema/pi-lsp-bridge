# pi-lsp-bridge

Minimal, data-driven diagnostics bridge for [pi](https://github.com/badlogic/pi-mono).

It keeps background diagnostics available to the main agent without baking language-specific logic into the extension runtime.

## Goals

- Prefer **repo configuration** over hardcoded assumptions
- Support both **LSP** diagnostics and **repo-configured linters/CLI tools**
- Feed diagnostics back to pi in three ways:
  - after `read` / `edit` / `write`
  - as compact prompt context before a new user turn
  - through a `diagnostics` tool callable by the model
- Avoid background thrash with **debounce**, **cooldown**, **idle suspend**, and **orphan cleanup**

## Install in pi

Install from GitHub:

```bash
pi install https://github.com/bnema/pi-lsp-bridge
```

Update an existing install:

```bash
pi update https://github.com/bnema/pi-lsp-bridge
```

Remove an existing install:

```bash
pi remove https://github.com/bnema/pi-lsp-bridge
```

Try it for one session without installing:

```bash
pi -e https://github.com/bnema/pi-lsp-bridge
```

## Local development

From this directory:

```bash
npm install
```

Then either install it as a local package:

```bash
pi install .
```

Or load it once for the current session:

```bash
pi -e .
```

## Repo config

Preferred file:

```text
.pi/lsp-bridge.json
```

Fallback:

```text
pi-lsp-bridge.json
```

Example:

```json
{
  "$schema": "./node_modules/pi-lsp-bridge/schemas/repo-config.schema.json",
  "autoDetect": true,
  "debug": false,
  "status": {
    "symbols": "nerdfont"
  },
  "lifecycle": {
    "idleSuspendMs": 600000,
    "injectCooldownMs": 10000
  },
  "providers": [
    "gopls",
    "golangci-lint",
    {
      "id": "eslint",
      "command": "eslint",
      "args": ["--format", "json"]
    }
  ]
}
```

Set `"status": { "symbols": "text" }` to use compact plain-text labels instead of Nerd Font glyphs.

You can also override it per session with:

```bash
PI_LSP_BRIDGE_STATUS_SYMBOLS=text pi -e .
```

Enable debug logging with either repo config or an environment variable:

```json
{
  "debug": true
}
```

```bash
PI_LSP_BRIDGE_DEBUG=1 pi -e .
```

When debug logging is enabled, the bridge writes a per-session pino log to:

```text
$XDG_STATE_HOME/pi-lsp-bridge/<session-id>.log
```

or, if `XDG_STATE_HOME` is unset:

```text
~/.local/state/pi-lsp-bridge/<session-id>.log
```

The status bar only shows active providers (`starting`, `running`, `cooldown`). Inactive ones such as missing, stopped, backoff, or disabled are hidden.

On startup, the bridge eagerly starts only providers with strong repo signals (for example `go.mod`, `Cargo.toml`, `tsconfig.json`, package dependencies, or explicit config markers). Generic extension-only providers such as Markdown, JSON, YAML, HTML, or CSS wait until a matching file is touched.

Status-bar counts are intentionally compact: they emphasize errors and warnings. Hints and info remain available through the diagnostics tool and prompt summaries.

`vendor/` is always ignored. Vendored dependencies are treated as external code and are never scanned, scheduled, or surfaced as actionable diagnostics.

## OpenCode compatibility

If a repo already has `.opencode.json` with an `lsp` section, `pi-lsp-bridge` uses it as an override layer before fallback autodetection.

## Commands

- `/lsp-status` — show current bridge status
- `/lsp-restart` — restart provider processes

## Tool

- `diagnostics` — inspect merged current diagnostics by file or provider

## Current provider model

The runtime is generic. Providers are selected from a data registry based on repo markers, file extensions, package dependencies, and repo config.

The shipped default registry currently includes broad support entries for:

- TypeScript / JavaScript via `typescript-language-server` / `vtsls`
- Go via `gopls`
- Rust via `rust-analyzer`
- Python via `pyright-langserver` or `pylsp`
- C/C++ via `clangd`
- YAML / JSON / HTML / CSS / Markdown / shell
- ESLint, golangci-lint, and Ruff as supplemental CLI diagnostics

The architecture is intentionally data-driven so new providers can be added without adding language-specific control flow to the extension.

## Runtime safety

The bridge tries hard not to eat the user's RAM:

- LSP refreshes are debounced
- workspace linters are run in the background and not awaited on every edit
- LSP documents are capped with an LRU budget
- providers suspend after idle time
- crashed providers enter backoff / disable states
- child processes are tracked in a temp registry and swept on next startup if pi died badly

## Notes

- This is a minimal first pass focused on diagnostics, not completions/code actions.
- Repo-wide CLI tool support is intentionally conservative.
- If a repo needs a specific server or executable path, prefer declaring it in `.pi/lsp-bridge.json`.
