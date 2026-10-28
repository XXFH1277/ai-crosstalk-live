# 一键下播：关掉导演程序、弹幕服务、直播画面窗口和 Breeze TTS（释放显存）。直播伴侣不动。
$Host.UI.RawUI.WindowTitle = '鲸月咖啡厅 · 一键下播'
$Root = Split-Path $PSScriptRoot -Parent
$OverlayProfile = Join-Path $PSScriptRoot '画面浏览器'

function Stop-Matching($name, $test, $label) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object $test
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host ("  {0}：{1}" -f $label, $(if ($procs) { '已关闭' } else { '没在运行' }))
}

Write-Host '鲸月咖啡厅 · 一键下播' -ForegroundColor Yellow
# The room id stays in config.json for next time; stopping the server is enough to stop receiving.
Stop-Matching 'node.exe' { $_.CommandLine -like "*$Root\原型\server.mjs*" } '导演和画面程序'
Stop-Matching 'douyinLive.exe' { $_.ExecutablePath -like "$PSScriptRoot\*" } '抖音弹幕服务'
Stop-Matching 'chrome.exe' { $_.CommandLine -like "*$OverlayProfile*" } '直播画面窗口'
& (Join-Path $(if ($env:BREEZE_DIR) { $env:BREEZE_DIR } else { 'C:\breeze-tts2' }) 'stop-breeze.ps1') | Out-Null
Write-Host '  语音（Breeze TTS）：已关闭，显存已释放'
Write-Host "`n直播伴侣没有动，请自己确认已经结束直播。" -ForegroundColor Yellow
Start-Sleep -Seconds 4
