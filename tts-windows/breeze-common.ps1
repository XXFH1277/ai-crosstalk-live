$ErrorActionPreference = 'Stop'
$BreezeRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$BreezeRuntime = Join-Path $BreezeRoot 'runtime'
$BreezeLogs = Join-Path $BreezeRoot 'logs'
$BreezePidFile = Join-Path $BreezeLogs 'server.pid'
$BreezeUiPidFile = Join-Path $BreezeLogs 'ui.pid'
$BreezeUrl = 'http://127.0.0.1:8080'
$BreezeBackendUrl = 'http://127.0.0.1:8082'

function Get-BreezeExecutable {
    $files = @(Get-ChildItem -LiteralPath $BreezeRuntime -Filter 'breeze-server.exe' -File -Recurse)
    if ($files.Count -ne 1) {
        throw "runtime 目录必须只有一个 breeze-server.exe，当前找到 $($files.Count) 个。"
    }
    $prefix = $BreezeRuntime.TrimEnd('\') + '\'
    if (-not $files[0].FullName.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw '程序路径不在本项目 runtime 目录内。'
    }
    return $files[0].FullName
}

function Get-BreezeModel([string]$SelectedModel) {
    $configPath = Join-Path $BreezeRoot 'config.json'
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $relative = [string]$config.model
    if ($SelectedModel -eq 'F16') { $relative = 'breeze-tts-2-f16.gguf' }
    if ($SelectedModel -eq 'Q8') { $relative = 'breeze-tts-2-q8_0.gguf' }
    if ([string]::IsNullOrWhiteSpace($relative) -or [IO.Path]::IsPathRooted($relative)) {
        throw 'config.json 的 model 必须是 models 目录内的相对路径或文件名。'
    }
    $relative = $relative.Replace('/', '\')
    if ($relative.StartsWith('models\', [StringComparison]::OrdinalIgnoreCase)) {
        $relative = $relative.Substring(7)
    }
    $models = Join-Path $BreezeRoot 'models'
    $path = [IO.Path]::GetFullPath((Join-Path $models $relative))
    if (-not $path.StartsWith($models.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '模型路径不能超出本项目 models 目录。'
    }
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "模型文件不存在：$path。请等待模型下载完成。"
    }
    if ([IO.Path]::GetExtension($path) -ne '.gguf') {
        throw 'model 必须指向 .gguf 模型文件。'
    }
    return $path
}

function Get-BreezeTrackedProcess([string]$ExpectedExecutable, [string]$PidFile = $BreezePidFile) {
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) { return $null }
    $state = Get-Content -LiteralPath $PidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $state.processId -or -not $state.executable -or -not $state.startedAtUtc) {
        throw "PID 记录格式无效：$PidFile。未操作任何进程。"
    }
    if (-not [string]::Equals([string]$state.executable, $ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'PID 记录中的程序路径与本项目 runtime 不一致。未操作任何进程。'
    }
    $process = Get-Process -Id ([int]$state.processId) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$state.processId)"
    if ($null -eq $details -or -not $details.ExecutablePath) {
        throw '无法核实记录进程的程序路径。未操作任何进程。'
    }
    if (-not [string]::Equals([string]$details.ExecutablePath, $ExpectedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    $expectedStart = [DateTime]::Parse([string]$state.startedAtUtc).ToUniversalTime()
    if ($process.StartTime.ToUniversalTime().Ticks -ne $expectedStart.Ticks) { return $null }
    return $process
}

function Test-BreezeHealth {
    try {
        $health = Invoke-RestMethod -Uri "$BreezeBackendUrl/health" -TimeoutSec 2
        return ($health.status -eq 'ok' -and $health.sample_rate -eq 24000)
    } catch { return $false }
}

function Get-BreezeUiPython {
    return (Get-Command python.exe -ErrorAction Stop).Source
}

function Test-BreezeUiHealth {
    try {
        $health = Invoke-RestMethod -Uri "$BreezeUrl/ui-health" -TimeoutSec 2
        return ($health.status -eq 'ok' -and $health.locale -eq 'zh-CN')
    } catch { return $false }
}

function Ensure-BreezeWebUi {
    $pythonPath = Get-BreezeUiPython
    $uiProcess = Get-BreezeTrackedProcess $pythonPath $BreezeUiPidFile
    if ($null -ne $uiProcess) {
        if (Test-BreezeUiHealth) { return }
        throw '中文网页进程已运行但未就绪，请运行停止入口后重试。'
    }
    if (@(Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue).Count -gt 0) {
        throw '网页端口 8080 已被其他程序占用。'
    }
    $uiScript = Join-Path $BreezeRoot 'ui_server.py'
    foreach ($asset in @('index.html', 'app.js', 'style.css')) {
        if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $BreezeRoot 'webui-zh') $asset))) {
            throw "中文网页文件缺失：$asset"
        }
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $BreezeLogs "ui-$stamp.stdout.log"
    $stderr = Join-Path $BreezeLogs "ui-$stamp.stderr.log"
    $uiProcess = Start-Process -FilePath $pythonPath -ArgumentList @('-u', ('"' + $uiScript + '"')) -WorkingDirectory $BreezeRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    @{
        processId = $uiProcess.Id
        executable = $pythonPath
        startedAtUtc = $uiProcess.StartTime.ToUniversalTime().ToString('o')
        script = $uiScript
        stdout = $stdout
        stderr = $stderr
    } | ConvertTo-Json | Set-Content -LiteralPath $BreezeUiPidFile -Encoding UTF8
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        $uiProcess.Refresh()
        if ($uiProcess.HasExited) { throw "中文网页启动失败，请查看 $stderr" }
        if (Test-BreezeUiHealth) { return }
        Start-Sleep -Milliseconds 200
    }
    throw "中文网页未能及时就绪，请查看 $stderr"
}
