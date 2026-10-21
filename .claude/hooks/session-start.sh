#!/bin/bash
# SessionStart hook for Claude Code cloud sessions.
# Installs the Claude Code tooling this project relies on, so every new cloud
# session has it without any local setup. Idempotent: anything already present
# is skipped, so resumed sessions and cached containers start quickly.
set -euo pipefail

# Only run in Claude Code cloud sessions.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

log() { echo "[session-start] $*" >&2; }

# TypeScript language server, required by the typescript-lsp plugin.
# typescript-language-server needs tsserver.js, which TypeScript 7 (the native
# Go compiler) no longer ships, so the global fallback stays on TypeScript 6.
if ! command -v typescript-language-server >/dev/null 2>&1 \
  || [ ! -f "$(npm root -g)/typescript/lib/tsserver.js" ]; then
  log "Installing typescript-language-server and typescript@6"
  npm install -g typescript-language-server typescript@6 >/dev/null 2>&1 \
    || log "WARNING: typescript-language-server install failed"
fi

if ! command -v claude >/dev/null 2>&1; then
  log "claude CLI not found; skipping plugin installation"
  exit 0
fi

# Caveman marketplace (third-party, github.com/JuliusBrussee/caveman).
if ! claude plugin marketplace list 2>/dev/null | grep -q "JuliusBrussee/caveman"; then
  log "Adding the caveman marketplace"
  claude plugin marketplace add JuliusBrussee/caveman >/dev/null 2>&1 \
    || log "WARNING: could not add the caveman marketplace"
fi

installed="$(claude plugin list --json 2>/dev/null || echo '[]')"

plugins=(
  "caveman@caveman"
  "frontend-design@anthropic-plugin-directory"
  "playwright@anthropic-plugin-directory"
  "context7@anthropic-plugin-directory"
  "typescript-lsp@anthropic-plugin-directory"
  "pyright-lsp@anthropic-plugin-directory"
)

for plugin in "${plugins[@]}"; do
  if printf '%s' "$installed" | grep -q "\"id\": \"${plugin}\""; then
    continue
  fi
  log "Installing plugin ${plugin}"
  claude plugin install "$plugin" >/dev/null 2>&1 \
    || log "WARNING: could not install ${plugin}"
done

exit 0
