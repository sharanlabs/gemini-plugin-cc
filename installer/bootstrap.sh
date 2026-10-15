#!/bin/sh
set -eu
installer_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" = '--dry-run' ]; then
  printf '%s\n' 'Bootstrap plan: use Node.js 20+ already installed, otherwise download private Node.js 24.22.0 from nodejs.org and verify the pinned SHA-256 before extraction. No files or downloads created.'
  if command -v node >/dev/null 2>&1; then node "$installer_dir/install.mjs" --dry-run; fi
  exit 0
fi
if [ "$(uname -s)" != Darwin ]; then printf '%s\n' 'Use this installer on macOS. See README for other platforms.'; exit 2; fi
node_bin=''
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then node_bin=$(command -v node); fi
if [ -z "$node_bin" ]; then
  case "$(uname -m)" in
    arm64) arch=arm64; expected=6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5 ;;
    x86_64) arch=x64; expected=495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91 ;;
    *) printf '%s\n' 'Unsupported CPU architecture.'; exit 2 ;;
  esac
  runtime_parent="$HOME/.local/share/gemini-plugin-cc/runtimes"
  check_path="$runtime_parent"
  while [ "$check_path" != / ]; do
    if [ -L "$check_path" ]; then printf '%s\n' 'Refusing symbolic-link installation path.'; exit 1; fi
    check_path=$(dirname -- "$check_path")
  done
  runtime="$runtime_parent/node-v24.22.0-darwin-$arch"
  node_bin="$runtime/bin/node"
  if [ ! -x "$node_bin" ]; then
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT HUP INT TERM
    archive="node-v24.22.0-darwin-$arch.tar.gz"
    printf '%s\n' 'Downloading private Node.js from nodejs.org; your existing software is preserved.'
    curl --proto '=https' --tlsv1.2 -fLS "https://nodejs.org/download/release/v24.22.0/$archive" -o "$temporary/$archive"
    actual=$(shasum -a 256 "$temporary/$archive" | cut -d ' ' -f 1)
    if [ "$actual" != "$expected" ]; then printf '%s\n' 'Node.js checksum mismatch. Installation stopped.'; exit 1; fi
    tar -xzf "$temporary/$archive" -C "$temporary"
    mkdir -p "$runtime_parent"
    if [ -e "$runtime" ]; then printf '%s\n' 'Incomplete Node runtime exists. Inspect it before retrying.'; exit 1; fi
    mv "$temporary/node-v24.22.0-darwin-$arch" "$runtime"
  fi
  "$node_bin" -e 'process.exit(process.version === "v24.22.0" ? 0 : 1)'
fi
export PATH="$(dirname -- "$node_bin"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
set +e
"$node_bin" "$installer_dir/install.mjs"
result=$?
set -e
if [ "$result" = 2 ]; then
  printf '%s\n' 'Setup needs Git and/or Claude Code. Opening the official setup pages; install missing tools, then double-click Install.command again.'
  if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then open 'https://git-scm.com/downloads/mac'; fi
  if ! command -v claude >/dev/null 2>&1; then open 'https://code.claude.com/docs/en/setup'; fi
fi
if [ "$result" = 0 ] && [ "${CI:-}" != true ]; then open "$HOME/.local/share/gemini-plugin-cc"; fi
exit "$result"
