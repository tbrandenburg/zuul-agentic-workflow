#!/usr/bin/env bash
# Seed the bare git repos served by the gitserver container:
#  - zuul-config.git: pushed from zuul/zuul-config-src (config-project)
#  - agent-runs.git: seeded with an initial empty commit on refs/heads/agent-runs
#
# Idempotent: safe to re-run against an already-seeded gitserver-repos dir.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOS_DIR="$ROOT_DIR/gitserver-repos"
CONFIG_SRC="$ROOT_DIR/zuul-config"

mkdir -p "$REPOS_DIR"

if [ ! -d "$REPOS_DIR/zuul-config.git" ]; then
  git init --bare -q "$REPOS_DIR/zuul-config.git"
  git --git-dir="$REPOS_DIR/zuul-config.git" symbolic-ref HEAD refs/heads/master
fi

if [ ! -d "$REPOS_DIR/agent-runs.git" ]; then
  git init --bare -q "$REPOS_DIR/agent-runs.git"
  git --git-dir="$REPOS_DIR/agent-runs.git" symbolic-ref HEAD refs/heads/agent-runs
fi

pushd "$CONFIG_SRC" >/dev/null
if [ ! -d .git ]; then
  if git --git-dir="$REPOS_DIR/zuul-config.git" rev-parse --verify -q master >/dev/null 2>&1; then
    # Bare repo already has history (e.g. re-running after a fresh checkout of
    # this source tree) - adopt it so we push a fast-forward, not a rewrite.
    git init -q -b master
    git remote add origin "$REPOS_DIR/zuul-config.git"
    git fetch -q origin master
    git reset -q --soft origin/master
  else
    git init -q -b master
    git remote add origin "$REPOS_DIR/zuul-config.git" 2>/dev/null || true
  fi
fi
git add -A
if ! git diff --cached --quiet; then
  git -c user.email=poc@local -c user.name=poc commit -q -m "zuul-config update"
fi
git push -q origin master
popd >/dev/null

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
if ! git --git-dir="$REPOS_DIR/agent-runs.git" show-ref --verify --quiet refs/heads/agent-runs; then
  git init -q -b agent-runs "$WORKDIR/agent-runs-seed"
  pushd "$WORKDIR/agent-runs-seed" >/dev/null
  git -c user.email=poc@local -c user.name=poc commit -q --allow-empty \
    -m "seed: initialize agent-runs branch"
  git remote add origin "$REPOS_DIR/agent-runs.git"
  git push -q origin agent-runs
  popd >/dev/null
fi

echo "Seeded gitserver-repos/zuul-config.git and gitserver-repos/agent-runs.git"
