#!/bin/bash
# Installs the desktop control panel: a per-user LaunchAgent running
# panel/control_server.py on 127.0.0.1, plus the HTML page on the Desktop.
set -euo pipefail

PANEL=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")" && pwd -P)
ROOT=$(/usr/bin/dirname "$PANEL")
PYTHON="$ROOT/runtime/python/bin/python3"
PORT=${BREEZE_PANEL_PORT:-8079}
LABEL=com.breeze-tts2.panel
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DESKTOP_HTML="$HOME/Desktop/Breeze TTS 控制台.html"

[ -x "$PYTHON" ] || { printf '尚未部署包内 Python，请先运行“一键部署.command”。\n' >&2; exit 1; }

if [ ! -s "$PANEL/token" ]; then
  (umask 077; "$PYTHON" -I -c 'import secrets; print(secrets.token_urlsafe(24))' > "$PANEL/token")
fi
/bin/chmod 600 "$PANEL/token"
/bin/mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

"$PYTHON" -I - "$PLIST" "$LABEL" "$PYTHON" "$PANEL/control_server.py" "$ROOT" "$PORT" <<'PY'
import plistlib, sys
plist, label, python, script, root, port = sys.argv[1:]
with open(plist, 'wb') as handle:
    plistlib.dump({
        'Label': label,
        'ProgramArguments': [python, '-I', '-u', script],
        'WorkingDirectory': root,
        'EnvironmentVariables': {'BREEZE_PANEL_PORT': port},
        'RunAtLoad': True,
        'KeepAlive': True,
        'ProcessType': 'Interactive',
        'StandardOutPath': f'{root}/logs/panel.stdout.log',
        'StandardErrorPath': f'{root}/logs/panel.stderr.log',
    }, handle)
PY

DOMAIN="gui/$(/usr/bin/id -u)"
/bin/launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
/bin/launchctl bootstrap "$DOMAIN" "$PLIST"

"$PYTHON" -I - "$PANEL/panel.html" "$DESKTOP_HTML" "$PANEL/token" "$PORT" "$ROOT" <<'PY'
import html, sys
from pathlib import Path
source, target, token_file, port, root = sys.argv[1:]
text = Path(source).read_text(encoding='utf-8')
text = (text.replace('__TOKEN__', Path(token_file).read_text(encoding='utf-8').strip())
            .replace('__PORT__', port).replace('__ROOT__', html.escape(root)))
Path(target).write_text(text, encoding='utf-8')
PY

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if /usr/bin/curl -fsS -H "X-Panel-Token: $(/bin/cat "$PANEL/token")" "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
    printf '控制服务已运行：127.0.0.1:%s\n桌面面板：%s\n' "$PORT" "$DESKTOP_HTML"
    exit 0
  fi
  /bin/sleep 0.5
done
printf '控制服务未能响应，请查看 %s/logs/panel.stderr.log\n' "$ROOT" >&2
exit 1
