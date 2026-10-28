@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 先确认 Breeze TTS 已启动（Breeze TTS 的启动脚本（见 tts-mac/ 或你自己的安装目录））
node server.mjs
pause
