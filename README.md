# pi-lsp-bridge

Collect background diagnostics for Pi from LSPs and repo-configured linters.

## What it does

- Runs language servers and configured diagnostic commands in the background.
- Debounces and cools down checks to avoid noisy background work.
- Injects compact diagnostics before user turns.
- Adds the `diagnostics` tool for explicit inspection.
- Keeps language-specific behavior in repo config instead of hardcoding it in the extension.

## Install

```bash
pi install git:github.com/bnema/pi-lsp-bridge
```

## Configure

Preferred config file:

```text
.pi/lsp-bridge.json
```

Fallback:

```text
pi-lsp-bridge.json
```

Config defines diagnostic providers, LSP commands, linter commands, file globs, cooldowns, and formatting rules. Repo config is preferred over extension defaults.

Compact example:

```json
{
  "$schema": "./node_modules/pi-lsp-bridge/schemas/repo-config.schema.json",
  "autoDetect": true,
  "debug": false,
  "status": { "symbols": "nerdfont" },
  "lifecycle": {
    "idleSuspendMs": 600000,
    "injectCooldownMs": 10000
  },
  "providers": [
    "gopls",
    "golangci-lint",
    { "id": "eslint", "command": "eslint", "args": ["--format", "json"] }
  ]
}
```

Environment overrides:

- `PI_LSP_BRIDGE_STATUS_SYMBOLS=text` uses compact plain-text status labels.
- `PI_LSP_BRIDGE_DEBUG=1` enables per-session debug logs under `$XDG_STATE_HOME/pi-lsp-bridge/` or `~/.local/state/pi-lsp-bridge/`.

## Commands

```text
/lsp-status
/lsp-restart
```

## Tool

Use the `diagnostics` tool to inspect current merged diagnostics:

```json
{
  "path": "src/index.ts",
  "providerId": "tsc",
  "maxItems": 50
}
```

All fields are optional. Without arguments, it returns bounded project diagnostics.

## Runtime safety

The bridge uses debounce, cooldown, idle suspend, and orphan cleanup to avoid background thrash. It supports LSP diagnostics and repo-configured CLI/linter providers.

Notes and limitations:

- `vendor/` is always ignored.
- Existing `.opencode.json` `lsp` config can act as an override layer before fallback autodetection.
- Default providers cover common TypeScript/JavaScript, Go, Rust, Python, C/C++, markup, shell, ESLint, golangci-lint, and Ruff diagnostics.
- This extension surfaces diagnostics only, not completions or code actions.

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
