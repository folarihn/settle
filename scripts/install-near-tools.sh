#!/usr/bin/env bash
# Installs pinned cargo-near and/or near-cli-rs release binaries on Linux x86_64,
# verifying each tarball against a SHA-256 pinned here (not one fetched at run time).
# Usage: scripts/install-near-tools.sh cargo-near|near-cli [more...]
set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

install() {
  local url="$1" sha="$2" member="$3" name="$4"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$WORK/pkg.tar.gz" "$url"
  echo "${sha}  $WORK/pkg.tar.gz" | sha256sum --check --strict -
  tar -xzf "$WORK/pkg.tar.gz" -C "$WORK" "$member"
  install -m 0755 "$WORK/$member" "$BIN_DIR/$name"
  echo "installed $name from $url"
}

for tool in "$@"; do
  case "$tool" in
    cargo-near)
      install https://github.com/near/cargo-near/releases/download/cargo-near-v0.22.0/cargo-near-x86_64-unknown-linux-gnu.tar.gz \
        9429064e30a427e96523f539cb255f3688d2345e5000d7d4e4873a8247247d1a \
        cargo-near-x86_64-unknown-linux-gnu/cargo-near cargo-near ;;
    near-cli)
      install https://github.com/near/near-cli-rs/releases/download/v0.30.1/near-cli-rs-x86_64-unknown-linux-gnu.tar.gz \
        996e9f390d1cc446d17ea24e39c48f6ff906507f2d1dba96fc41f596a7e5de14 \
        near-cli-rs-x86_64-unknown-linux-gnu/near near ;;
    *) echo "unknown tool: $tool" >&2; exit 2 ;;
  esac
done
if [ -n "${GITHUB_PATH:-}" ]; then echo "$BIN_DIR" >> "$GITHUB_PATH"; fi
