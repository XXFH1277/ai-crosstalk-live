#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")" && pwd -P)
cd "$ROOT"
action=${1:-start}
if [ "$#" -gt 0 ]; then shift; fi

case "$action" in
  deploy) exec /bin/bash "$ROOT/deploy-mac.sh" "$@" ;;
  check) exec /bin/bash "$ROOT/deploy-mac.sh" --check-only ;;
esac

if [ "$(/usr/bin/uname -s)" != Darwin ] || [ "$(/usr/bin/uname -m)" != arm64 ] || [ "$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
  printf '请在原生 Apple Silicon Mac 上运行本入口，终端不要启用 Rosetta。\n' >&2
  exit 1
fi
if [ "$action" = apple-tools ]; then
  printf '将打开 Apple 官方编译工具安装提示；请在系统窗口自行完成安装。\n'
  exec /usr/bin/xcode-select --install
fi
PYTHON="$ROOT/runtime/python/bin/python3"
if [ ! -x "$PYTHON" ]; then
  printf '尚未准备本包 Python。请先双击“一键部署.command”。\n' >&2
  exit 1
fi
case "$action" in
  start) exec "$PYTHON" -I "$ROOT/mac_runtime.py" start "$@" ;;
  stop) exec "$PYTHON" -I "$ROOT/mac_runtime.py" stop "$@" ;;
  status) exec "$PYTHON" -I "$ROOT/mac_runtime.py" status "$@" ;;
  diagnose) exec "$PYTHON" -I "$ROOT/mac_runtime.py" diagnose "$@" ;;
  self-test) exec "$PYTHON" -I "$ROOT/mac_runtime.py" self-test "$@" ;;
  *) printf 'Unknown action: %s\n' "$action" >&2; exit 2 ;;
esac
