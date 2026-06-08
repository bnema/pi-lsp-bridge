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

## Use

Ask Pi to inspect diagnostics, or call the tool directly:

```text
Show current diagnostics for this project.
```

## Develop

```bash
npm install
npm run typecheck
pi -e .
```
