#!/bin/bash
# SessionStart hook: silently provisions the graphify CLI + skill on first use
# of this repo so the committed graphify-out/graph.json is actually queryable.
# Non-blocking, fail-open: never delays or breaks session start.
set -uo pipefail

# Decompress CI-generated graph.json.gz if newer than (or missing) the raw
# json graphify's CLI reads by default. Cheap, always safe to re-run.
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/graphify-out/graph.json.gz" ]; then
  if [ ! -f "$CLAUDE_PROJECT_DIR/graphify-out/graph.json" ] || \
     [ "$CLAUDE_PROJECT_DIR/graphify-out/graph.json.gz" -nt "$CLAUDE_PROJECT_DIR/graphify-out/graph.json" ]; then
    gunzip -k -f "$CLAUDE_PROJECT_DIR/graphify-out/graph.json.gz" 2>/dev/null
  fi
fi

if command -v graphify >/dev/null 2>&1; then
  exit 0
fi

INSTALLER=""
command -v pipx >/dev/null 2>&1 && INSTALLER="pipx install graphifyy"
[ -z "$INSTALLER" ] && command -v pip3 >/dev/null 2>&1 && INSTALLER="pip3 install --user graphifyy"
[ -z "$INSTALLER" ] && exit 0

LOG="${TMPDIR:-/tmp}/graphify-provision.log"
( $INSTALLER >"$LOG" 2>&1
  mkdir -p ~/.claude/skills/graphify 2>/dev/null
  [ -f ~/.claude/skills/graphify/SKILL.md ] || curl -fsSL \
    https://raw.githubusercontent.com/safishamsi/graphify/v1/skills/graphify/skill.md \
    -o ~/.claude/skills/graphify/SKILL.md 2>>"$LOG"
) &

echo "graphify not found — installing in background (log: $LOG). Graph queries may be unavailable this session until it finishes." >&2
exit 0
