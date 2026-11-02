. (Join-Path $PSScriptRoot 'breeze-common.ps1')

try {
    if (-not (Test-Path -LiteralPath $BreezePidFile -PathType Leaf) -and -not (Test-Path -LiteralPath $BreezeUiPidFile -PathType Leaf)) {
        Write-Host '没有本项目的 PID 记录，未操作任何进程。'
        exit 0
    }
    try {
        $controlLock = [IO.File]::Open((Join-Path $BreezeLogs 'control.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw '另一个启动或停止操作正在进行，请稍候再试。' }
    $executable = Get-BreezeExecutable
    foreach ($target in @(@{exe=$executable; record=$BreezePidFile}, @{exe=(Get-BreezeUiPython); record=$BreezeUiPidFile})) {
        $process = Get-BreezeTrackedProcess $target.exe $target.record
        if ($null -ne $process) {
            $process.Kill()
            if (-not $process.WaitForExit(10000)) { throw '服务未在 10 秒内退出，PID 记录已保留。' }
        }
        if (Test-Path -LiteralPath $target.record) { Remove-Item -LiteralPath $target.record }
    }
    Write-Host 'Breeze TTS 2 已停止，显存将释放。'
} catch {
    Write-Host "停止失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($controlLock) { $controlLock.Dispose() }
}
