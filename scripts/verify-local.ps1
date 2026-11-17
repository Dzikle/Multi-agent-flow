# Repeatable local acceptance gate; run from the repository root under Node 22.
# A separately installed Playwright module/Chromium is required for browser checks.
$ErrorActionPreference = 'Stop'
$evidenceRoot = Join-Path (Get-Location) 'docs/verification-evidence/final'
New-Item -ItemType Directory -Force $evidenceRoot | Out-Null
$commands = [System.Collections.Generic.List[object]]::new()
function Invoke-VerificationCommand {
    param([string]$Name, [string]$Executable, [string[]]$Arguments)
    $logPath = Join-Path $evidenceRoot ($Name + '.txt')
    [System.IO.File]::WriteAllText($logPath, '')
    & $Executable @Arguments 2>&1 | Tee-Object -FilePath $logPath
    $result = $LASTEXITCODE
    $logText = Get-Content -LiteralPath $logPath -Raw
    if ($logText) {[System.IO.File]::WriteAllText($logPath, $logText.TrimEnd([char[]]"`r`n") + [Environment]::NewLine)}
    $commands.Add(@{command=($Executable + ' ' + ($Arguments -join ' '));exit_code=$result;log=$logPath;finished_at=[DateTime]::UtcNow.ToString('o')})
    $commands | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $evidenceRoot 'commands.json')
    if ($result -ne 0) {throw "$Name failed with exit code $result"}
}
Invoke-VerificationCommand 'node-version' 'node' @('--version')
Invoke-VerificationCommand 'npm-version' 'npm.cmd' @('--version')
Invoke-VerificationCommand 'clean-install' 'npm.cmd' @('ci')
Invoke-VerificationCommand 'build' 'npm.cmd' @('run','build')
Invoke-VerificationCommand 'tests' 'npm.cmd' @('test')
Invoke-VerificationCommand 'audit' 'npm.cmd' @('audit')
Invoke-VerificationCommand 'standalone' 'node' @('scripts/verify-standalone.mjs','docs/verification-evidence/final/standalone')
Invoke-VerificationCommand 'browser' 'node' @('--import','tsx','scripts/verify-browser.mjs')
Invoke-VerificationCommand 'diff-check' 'git' @('diff','--check')
