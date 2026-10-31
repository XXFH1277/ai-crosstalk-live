# 仅管理本项目后台，不按进程名批量结束 Node 或 Java。
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$ProjectProto = Join-Path $ProjectRoot '原型'
$ProjectRuntime = Join-Path $ProjectProto 'runtime'
function Get-BackendSpec([ValidateSet('director','game')][string]$Kind) {
  if($Kind -eq 'director'){return @{Port=7860;File=(Join-Path $ProjectProto 'server.mjs');Label='相声后台'}}
  return @{Port=7861;File=(Join-Path $ProjectProto 'minecraft\server.mjs');Label='游戏后台'}
}
function Read-Backend([string]$Kind) {
  $spec=Get-BackendSpec $Kind
  try {
    $state=Invoke-RestMethod "http://127.0.0.1:$($spec.Port)/api/state" -TimeoutSec 2
    if($Kind -eq 'game' -and $state.instance -and $null -ne $state.ai -and @($state.bots).Count -eq 2){return $state}
    if($Kind -eq 'director' -and $null -ne $state.overlayReady -and $null -ne $state.replyDanmaku -and $null -ne $state.douyin){return $state}
  } catch {}
  return $null
}
function Test-BackendIdentity($Process,[string]$File,[bool]$Listening,[bool]$Healthy) {
  if($Process.Name -ne 'node.exe'){return $false}
  $command=[string]$Process.CommandLine
  $absolute='(?i)^(?:"[^"\r\n]*node\.exe"|\S*node(?:\.exe)?)\s+"?'+[regex]::Escape($File)+'"?\s*$'
  if($command -match $absolute){return $true}
  # 旧服务使用相对脚本名时，必须同时验证监听端口及专属状态结构。
  return $Listening -and $Healthy -and ($command -match '(?i)^(?:"[^"\r\n]*node\.exe"|\S*node(?:\.exe)?)\s+"?server\.mjs"?\s*$')
}
function Get-BackendProcesses([string]$Kind) {
  $spec=Get-BackendSpec $Kind
  $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $spec.Port -ErrorAction SilentlyContinue)
  $healthy=$null -ne (Read-Backend $Kind)
  $found=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { Test-BackendIdentity $_ $spec.File ($listeners.OwningProcess -contains $_.ProcessId) $healthy })
  foreach($listener in $listeners){if($found.ProcessId -notcontains $listener.OwningProcess){throw "$($spec.Label)端口被无法确认归属的程序占用，未结束任何陌生进程。"}}
  return $found
}
function Enter-CompanionLock {
  New-Item -ItemType Directory -Path $ProjectRuntime -Force | Out-Null
  try{return [IO.File]::Open((Join-Path $ProjectRuntime 'companion-control.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
  catch{throw '另一个启动或下播操作还未完成，请稍候再试。'}
}
function Ensure-Backend([string]$Kind) {
  $spec=Get-BackendSpec $Kind
  if($null -ne (Read-Backend $Kind)){Write-Host "  $($spec.Label)：已在运行，直接复用" -ForegroundColor Green;return}
  $existing=@(Get-BackendProcesses $Kind)
  if(-not $existing.Count){
    $node=(Get-Command node -ErrorAction Stop).Source
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $null=Start-Process -FilePath $node -ArgumentList ('"'+$spec.File+'"') -WorkingDirectory (Split-Path $spec.File -Parent) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $ProjectRuntime "$Kind-$stamp.log") -RedirectStandardError (Join-Path $ProjectRuntime "$Kind-$stamp-error.log")
  }
  $deadline=(Get-Date).AddSeconds(70)
  while((Get-Date) -lt $deadline){if($null -ne (Read-Backend $Kind)){Write-Host "  $($spec.Label)：已就绪" -ForegroundColor Green;return};Start-Sleep -Milliseconds 600}
  throw "$($spec.Label)尚未就绪，查看 原型/runtime 中最新的 $Kind 日志；重复点击不会再次启动同一服务。"
}
function Stop-Backend([string]$Kind) {
  $spec=Get-BackendSpec $Kind
  $processes=@(Get-BackendProcesses $Kind)
  if(-not $processes.Count){Write-Host "  $($spec.Label)：没在运行";return}
  if($Kind -eq 'game' -and $null -ne (Read-Backend 'game')){$null=Invoke-RestMethod 'http://127.0.0.1:7861/api/command' -Method Post -ContentType 'application/json' -Body '{"action":"disconnect"}' -TimeoutSec 5}
  foreach($process in $processes){
    $fresh=Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)"
    if($fresh -and $fresh.CreationDate -ne $process.CreationDate){throw '进程编号已变化，停止关闭操作。'}
    if($fresh){Stop-Process -Id $process.ProcessId -ErrorAction Stop;Wait-Process -Id $process.ProcessId -Timeout 8 -ErrorAction SilentlyContinue}
  }
  Write-Host "  $($spec.Label)：已关闭"
}
function Test-LocalHealth([string]$Url) {try{$null=Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 2;return $true}catch{return $false}}
function Find-GameBrowser {
  $candidates=@('C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',(Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe','C:\Program Files\Microsoft\Edge\Application\msedge.exe')
  foreach($path in $candidates){if(Test-Path -LiteralPath $path){return $path}}
  throw '需要 Chrome 或 Edge 才能使用置顶双人窗，请安装其中一个浏览器后再运行。'
}
