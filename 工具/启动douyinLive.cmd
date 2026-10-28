@echo off
chcp 65001 >nul
cd /d "%~dp0douyinLive-v2.3.2\app"
echo douyinLive 抖音弹幕服务（本机 1088 端口，已配置访问密钥）。直播期间不要关闭这个窗口。
douyinLive.exe --config .\config.yaml
pause
