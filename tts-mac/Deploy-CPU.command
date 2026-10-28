#!/bin/bash
ROOT=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")" && pwd -P)
/bin/bash "$ROOT/mac-entry.sh" deploy --cpu-only "$@"
status=$?
if [ -t 0 ]; then printf '\n按回车关闭此窗口……'; read -r _; fi
exit "$status"
