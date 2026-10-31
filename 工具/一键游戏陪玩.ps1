param([switch]$NoBrowser,[switch]$NoPause,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$Host.UI.RawUI.WindowTitle='鲸云社 · 一键游戏陪玩'
. (Join-Path $PSScriptRoot '陪玩服务.ps1')
$lock=$null
try {
  Write-Host '鲸云社 · 一键游戏陪玩' -ForegroundColor Cyan
  $browser=Find-GameBrowser
  if($CheckOnly){foreach($kind in @('director','game')){$spec=Get-BackendSpec $kind;$processes=@(Get-BackendProcesses $kind);Write-Host "$($spec.Label)：确认本项目进程 $($processes.Count) 个"};Write-Host "浏览器：$browser";return}
  $lock=Enter-CompanionLock
  Write-Host '[1/4] 准备 F16 语音'
  $breezeStarter='<Breeze 安装目录>\start-breeze.ps1'
  if(-not (Test-Path -LiteralPath $breezeStarter)){throw '找不到 Breeze F16 启动脚本。'}
  # 子进程隔离外部脚本的 exit，避免提前结束本入口。
  & powershell.exe -NoProfile -File $breezeStarter -Model F16 -NoBrowser
  if($LASTEXITCODE -ne 0 -or -not (Test-LocalHealth 'http://127.0.0.1:8082/health')){throw 'F16 语音未就绪，请检查 Breeze。'}
  Write-Host '[2/4] 准备弹幕服务'
  $dyDir=Join-Path $PSScriptRoot 'douyinLive-v2.3.2\app'
  if(-not (Test-LocalHealth 'http://127.0.0.1:1088/health')){
    $dyExe=Join-Path $dyDir 'douyinLive.exe'
    $existing=@(Get-CimInstance Win32_Process -Filter "Name='douyinLive.exe'" | Where-Object ExecutablePath -EQ $dyExe)
    if((Test-Path -LiteralPath $dyExe) -and -not $existing.Count){$null=Start-Process -FilePath $dyExe -ArgumentList '--config','.\config.yaml' -WorkingDirectory $dyDir -WindowStyle Hidden -PassThru}
    $deadline=(Get-Date).AddSeconds(15)
    while((Get-Date) -lt $deadline -and -not (Test-LocalHealth 'http://127.0.0.1:1088/health')){Start-Sleep -Milliseconds 500}
  }
  if(-not (Test-LocalHealth 'http://127.0.0.1:1088/health')){Write-Host '  弹幕服务未就绪；仍可游戏和讲段子，直播弹幕需检查 douyinLive。' -ForegroundColor Yellow}
  Write-Host '[3/4] 准备相声与游戏后台'
  Ensure-Backend 'director';Ensure-Backend 'game'
  $game=Read-Backend 'game'
  if($null -eq $game.entertainment){throw '游戏后台仍是旧版本，请先运行一键下播再重开。'}
  Write-Host '[4/4] 打开游戏导演台'
  if(-not $NoBrowser){Start-Process -FilePath $browser -ArgumentList '--new-window','http://127.0.0.1:7861/'}
  Write-Host "`n已就绪。打开 Minecraft 测试世界 → 对局域网开放 → 填端口 → 两人入服 → 开启声音和 AI。" -ForegroundColor Green
  Write-Host '再点「打开置顶双人窗」。保留 Chrome/Edge 导演台，不用在 Codex 内置浏览器重复开启 AI。'
  Write-Host '结束后运行原来的「一键下播」，也会停止陪玩并释放语音显存；游戏存档和直播伴侣由你操作。'
} catch {Write-Host "启动未完成：$($_.Exception.Message)" -ForegroundColor Red;if($NoPause){exit 1}}
finally {if($lock){$lock.Dispose()}}
if(-not $NoPause -and -not $CheckOnly){$null=Read-Host '按回车关闭启动说明'}
