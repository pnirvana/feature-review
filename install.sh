#!/usr/bin/env bash
# Links fr, the feature-review skill and the review-preparing agent into the places Pi
# (with pi-herdr-subagents) and the shell look for them. Safe to run again.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
bin_dir="${BIN_DIR:-$HOME/.local/bin}"

mkdir -p "$pi_dir/skills" "$pi_dir/agents" "$bin_dir"
ln -sfn "$here/agent/skill/feature-review" "$pi_dir/skills/feature-review"
for f in "$here"/agent/agents/*.md; do
  ln -sfn "$f" "$pi_dir/agents/$(basename "$f")"
done
ln -sfn "$here/bin/fr.mjs" "$bin_dir/fr"

echo "skill   -> $pi_dir/skills/feature-review"
echo "agent   -> $pi_dir/agents/feature-review-prep.md"
echo "command -> $bin_dir/fr"
command -v fr >/dev/null || echo "note: $bin_dir is not on PATH"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 25 ? 0 : 1)' 2>/dev/null || echo "note: fr needs Node 25 or newer (node --version)"
