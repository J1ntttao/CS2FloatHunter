<#
.SYNOPSIS
  手动录入市场 Cookie（PowerShell 入口，负责读剪贴板）。

.DESCRIPTION
  为什么要这个包装脚本：当前沙箱禁止 Node 派生子进程（EPERM），
  所以 Node 自己读不了剪贴板。PowerShell 读剪贴板后以 --string 传给 Node。

  典型用法（推荐）：在 Chrome 里按 F12 → Network → 刷新 → 点任意一个 buff 请求
  → Request Headers → 复制整行 Cookie 的值 → 运行本脚本，直接回车即可。

.EXAMPLE
  pwsh -File scripts\set-cookies.ps1 -Site buff
  pwsh -File scripts\set-cookies.ps1 -Site steam -FromFile cookies.txt
#>
[CmdletBinding()]
param(
  [ValidateSet('buff', 'steam', 'cs2up')]
  [string]$Site = 'buff',
  [string]$FromFile,
  [string]$String
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot

$labels = @{ buff = 'BUFF'; steam = 'Steam 社区市场'; cs2up = 'CS2UP' }

Write-Host "=== 录入 $($labels[$Site]) Cookie ===" -ForegroundColor Cyan

if ($FromFile) {
  $nodeArgs = @((Join-Path $root 'scripts\set-cookies.mjs'), '--site', $Site, '--file', $FromFile)
}
elseif ($String) {
  $nodeArgs = @((Join-Path $root 'scripts\set-cookies.mjs'), '--site', $Site, '--string', $String)
}
else {
  Write-Host ''
  Write-Host '请先在 Chrome 里复制 Cookie：' -ForegroundColor Yellow
  Write-Host '  1) F12 打开开发者工具 → Network（网络）' -ForegroundColor Gray
  Write-Host '  2) 刷新页面，点任意一个请求' -ForegroundColor Gray
  Write-Host '  3) Request Headers（请求标头）里找到 Cookie，复制它整行的值' -ForegroundColor Gray
  Write-Host ''
  $clip = Get-Clipboard -Raw
  if (-not $clip -or -not $clip.Trim()) {
    Write-Host '[x] 剪贴板是空的，请先复制 Cookie 再运行。' -ForegroundColor Red
    exit 1
  }
  $preview = $clip.Trim()
  if ($preview.Length -gt 120) { $preview = $preview.Substring(0, 120) + ' ...' }
  Write-Host "剪贴板内容预览：$preview" -ForegroundColor DarkGray
  $ans = Read-Host '确认使用剪贴板里的这段内容吗？(Y/n)'
  if ($ans -match '^(n|no|否)$') { Write-Host '已取消。' -ForegroundColor Yellow; exit 1 }
  $nodeArgs = @((Join-Path $root 'scripts\set-cookies.mjs'), '--site', $Site, '--string', $clip)
}

& node @nodeArgs
exit $LASTEXITCODE
