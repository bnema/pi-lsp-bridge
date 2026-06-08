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

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
