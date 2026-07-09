param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 3001,
  [string]$Path = "/agents",
  [int]$TimeoutSeconds = 45,
  [switch]$Webpack,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Split-Path -Parent $scriptRoot
$baseUrl = "http://${HostName}:${Port}"
$targetUrl = if ($Path.StartsWith("/")) { "${baseUrl}${Path}" } else { "${baseUrl}/${Path}" }
$nodeModulesPath = Join-Path $appRoot "node_modules"
$useWebpack = $Webpack

if (-not $useWebpack -and (Test-Path -LiteralPath $nodeModulesPath)) {
  $nodeModulesItem = Get-Item -LiteralPath $nodeModulesPath -ErrorAction SilentlyContinue
  if ($null -ne $nodeModulesItem -and ($nodeModulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    $useWebpack = $true
  }
}

function Test-LocalRoute {
  param([string]$Url)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
    return @{
      Ok = $true
      StatusCode = [int]$response.StatusCode
      Length = [int]$response.Content.Length
    }
  } catch {
    return @{
      Ok = $false
      Error = $_.Exception.Message
    }
  }
}

function Write-Ready {
  param($Result)

  Write-Host "READY $targetUrl status=$($Result.StatusCode) length=$($Result.Length)"
}

$initial = Test-LocalRoute -Url $targetUrl
if ($initial.Ok) {
  Write-Ready -Result $initial
  exit 0
}

if ($NoStart) {
  Write-Error "No local server responded at $targetUrl"
  exit 1
}

$escapedAppRoot = $appRoot.Replace("'", "''")
$devArgs = "--hostname $HostName --port $Port"
if ($useWebpack) {
  $devArgs += " --webpack"
}

$command = "Set-Location -LiteralPath '$escapedAppRoot'; npm.cmd run dev -- $devArgs"

# Keep the dev server in its own PowerShell window. In Codex sandboxed tool calls,
# background child processes can be reaped after the command exits.
$process = Start-Process `
  -FilePath "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $command) `
  -WindowStyle Minimized `
  -PassThru

Write-Host "STARTED pid=$($process.Id) url=$targetUrl"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Seconds 1
  $result = Test-LocalRoute -Url $targetUrl
  if ($result.Ok) {
    Write-Ready -Result $result
    exit 0
  }
} while ((Get-Date) -lt $deadline)

Write-Error "Started pid=$($process.Id), but $targetUrl did not respond within ${TimeoutSeconds}s."
exit 1
