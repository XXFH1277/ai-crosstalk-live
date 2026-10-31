# 先在直播伴侣结束直播；不操作推流按钮或 Minecraft 存档。
param([switch]$CheckOnly,[switch]$NoPause)
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='鲸云社 · 一键下播 / 结束陪玩'
. (Join-Path $PSScriptRoot '陪玩服务.ps1')
$lock=$null
function Stop-Matching($Name,$Test,$Label) {
  $processes=@(Get-CimInstance Win32_Process -Filter "Name='$Name'" | Where-Object $Test)
  foreach($process in $processes){Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue}
  Write-Host ("  {0}：{1}" -f $Label,$(if($processes.Count){'已关闭'}else{'没在运行'}))
}
try {
  Write-Host '鲸云社 · 一键下播 / 结束陪玩' -ForegroundColor Cyan
  if($CheckOnly){foreach($kind in @('game','director')){$spec=Get-BackendSpec $kind;$processes=@(Get-BackendProcesses $kind);Write-Host "$($spec.Label)：将关闭 $($processes.Count) 个本项目进程（本次只检查）"};return}
  $lock=Enter-CompanionLock
  Stop-Backend 'game'
  Stop-Backend 'director'
  $dyExe=Join-Path $PSScriptRoot 'douyinLive-v2.3.2\app\douyinLive.exe'
  Stop-Matching 'douyinLive.exe' { $_.ExecutablePath -eq $dyExe } '抖音弹幕服务'
  # 保留原下播入口关闭独立画面窗口的行为，不读取或修改浏览器配置目录。
  $overlayProfile=Join-Path $PSScriptRoot '画面浏览器'
  Stop-Matching 'chrome.exe' { $_.CommandLine -like "*$overlayProfile*" } '独立相声直播画面'
  & powershell.exe -NoProfile -File '<Breeze 安装目录>\stop-breeze.ps1'
  if($LASTEXITCODE -ne 0){throw '语音停止失败，请检查 Breeze。'}
  Write-Host '  语音已关闭。游戏导演台网页可自行关闭，下次一键陪玩会重新打开。' -ForegroundColor Green
  Write-Host '直播伴侣和 Minecraft 未关闭，请自己确认推流已结束并保存游戏。' -ForegroundColor Yellow
} catch {Write-Host "下播未完成：$($_.Exception.Message)" -ForegroundColor Red;if($NoPause){exit 1}else{$null=Read-Host '按回车关闭'}}
finally {if($lock){$lock.Dispose()}}
if(-not $NoPause -and -not $CheckOnly){Start-Sleep -Seconds 4}

