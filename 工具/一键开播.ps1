# 一键开播：依次启动语音、弹幕服务、导演程序，打开直播画面和控制台，最后打开直播伴侣。
# 已经在运行的部分会跳过，重复双击也没关系。
$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = '鲸月咖啡厅 · 一键开播'
$Root = Split-Path $PSScriptRoot -Parent
$Proto = Join-Path $Root '原型'
$Breeze = if ($env:BREEZE_DIR) { $env:BREEZE_DIR } else { 'C:\breeze-tts2' }   # Breeze TTS 安装目录，可用环境变量 BREEZE_DIR 指定
$DouyinLive = Join-Path $PSScriptRoot 'douyinLive-v2.3.2\app'
$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$ChromeProfile = 'Default'                                     # 装了“抖音弹幕转发”插件的 Chrome 账号
$Mate = 'D:\Program Files (x86)\webcast_mate\直播伴侣 Launcher.exe'
$OverlayProfile = Join-Path $PSScriptRoot '画面浏览器'          # 直播画面专用的独立 Chrome 配置
$Server = 'http://127.0.0.1:7860'

function Step($n, $text) { Write-Host "`n[$n/6] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "      ✓ $text" -ForegroundColor Green }
function Up($url) {
  try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; return $true } catch { return $false }
}
function WaitUp($url, $seconds, $what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) { if (Up $url) { return } ; Start-Sleep -Milliseconds 500 }
  throw "$what 在 $seconds 秒内没有启动成功。"
}

try {
  Write-Host '鲸月咖啡厅 · 一键开播' -ForegroundColor Yellow

  Step 1 '语音（Breeze TTS）'
  if (Up 'http://127.0.0.1:8082/health') { Ok '已经在运行' }
  else {
    & (Join-Path $Breeze 'start-breeze.ps1') -Model F16 -NoBrowser
    if (-not (Up 'http://127.0.0.1:8082/health')) { throw 'Breeze TTS 没有启动成功，请看上面的提示。' }
    Ok '已启动'
  }

  Step 2 '抖音弹幕服务（douyinLive）'
  if (Up 'http://127.0.0.1:1088/health') { Ok '已经在运行' }
  else {
    Start-Process -FilePath (Join-Path $DouyinLive 'douyinLive.exe') -ArgumentList '--config', '.\config.yaml' -WorkingDirectory $DouyinLive -WindowStyle Minimized
    WaitUp 'http://127.0.0.1:1088/health' 20 'douyinLive'
    Ok '已启动（最小化窗口，别关）'
  }

  Step 3 '导演和画面程序'
  if (Up "$Server/api/config") { Ok '已经在运行' }
  else {
    Start-Process -FilePath 'node' -ArgumentList ('"' + (Join-Path $Proto 'server.mjs') + '"') -WorkingDirectory $Proto -WindowStyle Minimized
    WaitUp "$Server/api/config" 40 '导演程序'
    Ok '已启动（最小化窗口，别关）'
  }

  Step 4 '直播间房间号'
  $room = (Invoke-RestMethod "$Server/api/douyin/config").roomId
  if (-not $room) {
    Write-Host '      第一次使用：请输入你的直播间房间号（在网页打开自己的直播间，live.douyin.com/ 后面那串数字）。' -ForegroundColor Yellow
    while ($room -notmatch '^\d{6,20}$') { $room = (Read-Host '      房间号').Trim() }
    $body = [Text.Encoding]::UTF8.GetBytes((@{ roomId = $room } | ConvertTo-Json))
    Invoke-RestMethod "$Server/api/douyin" -Method Post -Body $body -ContentType 'application/json' | Out-Null
  }
  Ok "房间号 $room（要改的话在控制台里改）"

  Step 5 '打开直播画面和控制台'
  $overlayOpen = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$OverlayProfile*" }
  if ($overlayOpen) { Ok '直播画面窗口已经开着' }
  else {
    # 独立的 Chrome 配置，才能让这个窗口不点击就自动出声（不影响你平时用的 Chrome）。
    Start-Process $Chrome -ArgumentList "--user-data-dir=`"$OverlayProfile`"", '--no-first-run', '--autoplay-policy=no-user-gesture-required',
      '--window-position=0,0', '--window-size=1920,1080', "--app=$Server/?autostart=1"
    Ok '直播画面已打开（窗口标题：鲸月咖啡厅 · 直播画面），会自动开演'
  }
  Start-Process $Chrome -ArgumentList "--profile-directory=$ChromeProfile", "$Server/control"
  Ok '控制台已在你的 Chrome 里打开'

  Step 6 '打开直播伴侣'
  if (Get-Process -Name '直播伴侣*' -ErrorAction SilentlyContinue) { Ok '直播伴侣已经开着' }
  else { Start-Process $Mate; Ok '已打开' }

  Write-Host @"

────────────────────────────────────────────
接下来在直播伴侣里：
  · 第一次用：添加素材 → 窗口捕获 → 选「鲸月咖啡厅 · 直播画面」，声音选“系统声音”。
    以后直播伴侣会记住这个场景，不用再设。
  · 点「开始直播」。
────────────────────────────────────────────
"@ -ForegroundColor Yellow
  Read-Host '开播之后回到这里按回车，我会在 Chrome 里打开你的直播间页面（插件会自动静音它、开始转发弹幕和礼物）'
  Start-Process $Chrome -ArgumentList "--profile-directory=$ChromeProfile", "https://live.douyin.com/$room"
  Ok '直播间页面已打开。控制台里“抖音数据源”两路都在收数据，就全部接通了。'
  Write-Host "`n下播时：先在直播伴侣里结束直播，再双击桌面上的「一键下播」。这个窗口可以关了。" -ForegroundColor Yellow
  Read-Host '按回车关闭'
}
catch {
  Write-Host "`n出错了：$($_.Exception.Message)" -ForegroundColor Red
  Read-Host '按回车关闭'
}
