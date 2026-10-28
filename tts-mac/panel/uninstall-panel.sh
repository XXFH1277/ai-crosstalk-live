#!/bin/bash
# Removes the desktop panel's LaunchAgent and Desktop page. Does not touch
# models, voices or the TTS itself (run Stop-Breeze.command to stop those).
set -euo pipefail
LABEL=com.breeze-tts2.panel
/bin/launchctl bootout "gui/$(/usr/bin/id -u)/$LABEL" 2>/dev/null || true
/bin/rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/Desktop/Breeze TTS 控制台.html"
printf '已移除桌面控制面板及其后台控制服务。\n'
