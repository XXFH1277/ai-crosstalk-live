param(
    [ValidateSet('F16', 'Q8')][string]$Model,
    [switch]$NoBrowser
)
. (Join-Path $PSScriptRoot 'breeze-common.ps1')

try {
    New-Item -ItemType Directory -Path $BreezeLogs -Force | Out-Null
    try {
        $controlLock = [IO.File]::Open((Join-Path $BreezeLogs 'control.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw '另一个启动或停止操作正在进行，请稍候再试。' }
    $executable = Get-BreezeExecutable
    $modelPath = Get-BreezeModel $Model
    $existing = Get-BreezeTrackedProcess $executable
    if ($null -ne $existing) {
        $state = Get-Content -LiteralPath $BreezePidFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]::Equals([string]$state.model, $modelPath, [StringComparison]::OrdinalIgnoreCase)) {
            if (-not (Test-BreezeHealth)) {
                throw '本项目进程已运行，但尚未就绪。请检查 logs 日志，或先运行停止入口后重试。'
            }
            Ensure-BreezeWebUi
            Write-Host "Breeze TTS 2 已运行：$BreezeUrl"
            Write-Host "模型：$modelPath"
            if (-not $NoBrowser) { Start-Process $BreezeUrl }
            exit 0
        }
        Write-Host '正在停止当前模型并切换到所选模型……'
        $existing.Kill()
        if (-not $existing.WaitForExit(10000)) { throw '原服务未在 10 秒内退出，未加载新模型。' }
        Remove-Item -LiteralPath $BreezePidFile
    }
    if (Test-Path -LiteralPath $BreezePidFile) { Remove-Item -LiteralPath $BreezePidFile }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 8081,8082 -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        throw '语音端口 8081 或 8082 已被占用。请先关闭占用端口的服务，再运行启动入口。'
    }
    $voices = Join-Path $BreezeRoot 'voices'
    New-Item -ItemType Directory -Path $voices -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $BreezeLogs "server-$stamp.stdout.log"
    $stderr = Join-Path $BreezeLogs "server-$stamp.stderr.log"
    $arguments = @(('"' + $modelPath + '"'), '--host', '127.0.0.1', '--port', '8082', '--ws-port', '8081', '--webui', '--voices-dir', ('"' + $voices + '"'))
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $BreezeRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    @{
        processId = $process.Id
        executable = $executable
        startedAtUtc = $process.StartTime.ToUniversalTime().ToString('o')
        model = $modelPath
        stdout = $stdout
        stderr = $stderr
    } | ConvertTo-Json | Set-Content -LiteralPath $BreezePidFile -Encoding UTF8
    Write-Host '正在加载模型并预热，最多等待 120 秒……'
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while ([DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) {
            Remove-Item -LiteralPath $BreezePidFile -ErrorAction SilentlyContinue
            throw "服务提前退出，退出码 $($process.ExitCode)。日志：$stderr"
        }
        if (Test-BreezeHealth) {
            Ensure-BreezeWebUi
            Write-Host "Breeze TTS 2 已就绪：$BreezeUrl"
            Write-Host "模型：$modelPath"
            if (-not $NoBrowser) { Start-Process $BreezeUrl }
            exit 0
        }
        Start-Sleep -Seconds 1
    }
    throw "120 秒内尚未就绪。进程保留以便排查，可用停止入口关闭。日志：$stderr"
} catch {
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    if ($stderr -and (Test-Path -LiteralPath $stderr)) {
        Get-Content -LiteralPath $stderr -Tail 15 -Encoding UTF8
    }
    exit 1
} finally {
    if ($controlLock) { $controlLock.Dispose() }
}
