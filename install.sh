#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_HOME="${PI_HOME:-$HOME/.pi}"
CONFIG_DIR="$HOME/.config/kitty-agent-state"

mkdir -p "$PI_HOME/agent/extensions" "$CONFIG_DIR"
cp "$ROOT/agent/extensions/kitty-agent-state.ts" "$PI_HOME/agent/extensions/kitty-agent-state.ts"

if [ ! -f "$CONFIG_DIR/config.json" ]; then
  cp "$ROOT/examples/config.json" "$CONFIG_DIR/config.json"
fi

cat <<EOF
Installed kitty-agent-state.

Next steps:
1. Ensure ~/.pi/agent/settings.json loads ./extensions/kitty-agent-state.ts.
2. Run /reload inside Pi.
3. Optional config: $CONFIG_DIR/config.json
EOF
