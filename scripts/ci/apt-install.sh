#!/usr/bin/env bash
# Install Ubuntu packages on a GitHub runner without hanging on a dead mirror.
# The runner's Azure mirror sometimes stops resolving (2026-11-11: apt-get sat for 60+ min),
# so every call is time-boxed with retries, and a failure falls back to archive.ubuntu.com once.
# Usage: scripts/ci/apt-install.sh <package-or-./file.deb>...
set -uo pipefail
opts=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 -o DPkg::Lock::Timeout=120)
attempt() {
  timeout 300 sudo apt-get "${opts[@]}" update &&
    timeout 900 sudo apt-get "${opts[@]}" install -y "$@"
}
attempt "$@" && exit 0
echo "::warning::apt via the runner's mirror failed; retrying against archive.ubuntu.com"
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$f" ] && sudo sed -i -E 's#mirror\+file:/etc/apt/apt-mirrors\.txt#http://archive.ubuntu.com/ubuntu/#g; s#https?://azure\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' "$f"
done
attempt "$@"
