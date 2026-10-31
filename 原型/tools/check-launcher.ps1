$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '..\..\工具\陪玩服务.ps1')
function Assert($Condition,$Message){if(-not $Condition){throw $Message}}
$file=(Get-BackendSpec 'game').File
$process=[pscustomobject]@{Name='node.exe';CommandLine=('"C:\Program Files\nodejs\node.exe" "'+$file+'"')}
Assert (Test-BackendIdentity $process $file $false $false) '完整路径应识别'
$process.CommandLine='"C:\Program Files\nodejs\node.exe" server.mjs'
Assert (Test-BackendIdentity $process $file $true $true) '旧相对路径需允许迁移'
Assert (-not (Test-BackendIdentity $process $file $false $true)) '不占目标端口的相对路径不得关闭'
Assert (-not (Test-BackendIdentity $process $file $true $false)) '专属接口未验证不得关闭'
$process.CommandLine='node other.js "'+$file+'"'
Assert (-not (Test-BackendIdentity $process $file $true $true)) '其他脚本参数里带项目路径不能冒充项目进程'
$process.Name='java.exe'
Assert (-not (Test-BackendIdentity $process $file $true $true)) '不得关闭 Minecraft'

# 以下测试用假进程和假 HTTP，禁止启动或结束真实程序。
$script:stopped=@();$script:commands=@();$script:starts=0
$script:fixture=[pscustomobject]@{Name='node.exe';CommandLine=('node "'+$file+'"');ProcessId=12345;CreationDate='same'}
function Get-BackendProcesses {return $script:fixture}
function Get-CimInstance {param($Filter);return $script:fixture}
function Read-Backend {return @{instance='fake';ai=@{};bots=@(1,2)}}
function Invoke-RestMethod {param($Uri,$Method,$ContentType,$Body,$TimeoutSec);$script:commands+=$Body;return @{}}
function Stop-Process {param($Id,$ErrorAction);$script:stopped+=$Id}
function Wait-Process {param($Id,$Timeout,$ErrorAction)}
function Start-Process {throw '离线测试不得启动真实程序'}
Stop-Backend 'game'
Assert ($script:commands[0] -eq '{"action":"disconnect"}') '结束进程前先停止 AI 并断开 bot'
Assert ($script:stopped.Count -eq 1 -and $script:stopped[0] -eq 12345) '只能关闭已确认的目标'
Ensure-Backend 'game'
function Get-CimInstance {param($Filter);return [pscustomobject]@{CreationDate='changed'}}
$caught=$false
try{Stop-Backend 'game'}catch{$caught=$true}
Assert $caught 'PID 复用必须拒绝'
Assert ($script:stopped.Count -eq 1) 'PID 变化后不得结束新进程'

$script:reads=0;$script:started=$null
function Read-Backend {$script:reads++;if($script:reads -ge 2){return @{instance='fake'}};return $null}
function Get-BackendProcesses {return @()}
function Start-Process {param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError);$script:started=@{Args=$ArgumentList;Style=$WindowStyle};return @{Id=9876}}
Ensure-Backend 'game'
Assert ($script:started.Style -eq 'Hidden') '后台必须隐藏启动'
Assert ($script:started.Args -eq ('"'+$file+'"')) '冷启动必须使用本项目绝对脚本路径'

$paths=@('..\..\工具\一键游戏陪玩.ps1','..\..\工具\一键下播.ps1','..\..\工具\陪玩服务.ps1')
foreach($relative in $paths){$tokens=$null;$parseErrors=$null;$null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $relative),[ref]$tokens,[ref]$parseErrors);Assert (-not $parseErrors.Count) 'PowerShell 语法错误'}
Write-Host 'PASS 一键入口：归属验证、旧进程兼容、复用服务、先断开 bot、PID 变化拒绝和脚本语法'
