param(
  [int]$Port = 8788,
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid web port.' }
if ($OpenBrowser) {
  Start-Sleep -Seconds 2
  Start-Process -FilePath "http://127.0.0.1:$Port"
  exit 0
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverFile = Join-Path $projectRoot 'src\web\server.mjs'
$processes = @(Get-CimInstance Win32_Process)
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique)
$targets = @($processes | Where-Object {
  $_.Name -eq 'node.exe' -and $_.CommandLine -and (
    $_.CommandLine.Replace('/', '\').IndexOf($serverFile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
    ($listeners -contains $_.ProcessId)
  )
})

# Kill the watch supervisor as well, otherwise it can restart the listening child.
foreach ($target in $targets) {
  $parent = $processes | Where-Object ProcessId -eq $target.ParentProcessId | Select-Object -First 1
  if ($parent -and $parent.Name -eq 'node.exe' -and
      $parent.CommandLine -match '--watch\b' -and $parent.CommandLine -match 'src[\\/]web[\\/]server\.mjs') {
    $targets += $parent
  }
}
$targetIds = @($targets | Select-Object -ExpandProperty ProcessId -Unique)
$treeIds = @($targetIds)
do {
  $children = @($processes | Where-Object {
    $treeIds -contains $_.ParentProcessId -and $treeIds -notcontains $_.ProcessId
  } | Select-Object -ExpandProperty ProcessId)
  $treeIds += $children
} while ($children.Count -gt 0)

foreach ($processId in @($targetIds + $treeIds | Select-Object -Unique)) {
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
    Write-Host "[..] Stopping previous web service (PID $processId)..."
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

