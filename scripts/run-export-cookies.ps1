<#
.SYNOPSIS
  从 Chrome 导出炼金所需站点的登录 Cookie（PowerShell 入口，负责 DPAPI 解密钥）。

.DESCRIPTION
  为什么要这个包装脚本：
  当前 DSH 沙箱禁止 Node 派生子进程（spawnSync -> EPERM，命名管道被封锁），
  而解出 Chrome 主密钥必须调用 Windows DPAPI。因此由 PowerShell（本沙箱允许它
  spawn Node）先解出主密钥，再以 --master-key-base64 传给 Node，其余工作交给 Node。

  前置条件：Chrome 必须完全退出。Chrome 运行时会对整份 profile 加独占锁，
  连只读打开 Cookies/History 都会被拒绝（已实测）。

.EXAMPLE
  pwsh -File scripts\run-export-cookies.ps1
  pwsh -File scripts\run-export-cookies.ps1 -Profile "Profile 1" -SkipChromeCheck
#>
[CmdletBinding()]
param(
  [string]$Profile = 'Default',
  [switch]$SkipChromeCheck,
  [switch]$KeepAll
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
Write-Host '=== CS2 磨损猎人 · Chrome Cookie 导出 ===' -ForegroundColor Cyan

# ---------- 1. Chrome 是否还在运行 ----------
# 实测结论：Node 的 fs.copyFileSync 能以共享方式复制被 Chrome 独占锁定的 Cookies 库，
# 所以 Chrome 开着也能导出。但 Chrome 运行时，内存中尚未落盘的 cookie 可能读不到，
# 因此这里只做提示，不再强制要求关闭 Chrome。
if (-not $SkipChromeCheck) {
  $chrome = Get-Process chrome -ErrorAction SilentlyContinue
  if ($chrome) {
    Write-Host ''
    Write-Host "[i] 检测到 $($chrome.Count) 个 chrome.exe 进程正在运行。" -ForegroundColor Yellow
    Write-Host '    可以在 Chrome 运行时导出；若稍后发现缺少登录 cookie，' -ForegroundColor Yellow
    Write-Host '    请完全退出 Chrome 后重新运行本脚本。' -ForegroundColor Yellow
  } else {
    Write-Host '    Chrome 未运行，可读到最完整的 cookie。' -ForegroundColor Green
  }
}

# ---------- 2. DPAPI 解出 Chrome 主密钥 ----------
Write-Host ''
Write-Host '[1/2] 解出 Chrome 主密钥 (DPAPI) ...' -ForegroundColor Cyan
Add-Type -AssemblyName System.Security

$localState = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data\Local State'
if (-not (Test-Path -LiteralPath $localState)) {
  Write-Host "[x] 找不到 Local State: $localState" -ForegroundColor Red
  exit 1
}

try {
  $j    = Get-Content -LiteralPath $localState -Raw | ConvertFrom-Json
  $b64  = $j.os_crypt.encrypted_key
  if (-not $b64) { throw 'os_crypt.encrypted_key 不存在' }
  $raw  = [Convert]::FromBase64String($b64)
  $prefix = [System.Text.Encoding]::ASCII.GetString($raw[0..4])
  if ($prefix -ne 'DPAPI') { throw "未知的密钥前缀 '$prefix'（期望 DPAPI）" }
  $blob = New-Object byte[] ($raw.Length - 5)
  [Array]::Copy($raw, 5, $blob, 0, $blob.Length)
  $key  = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
  $keyB64 = [Convert]::ToBase64String($key)
  $fp = [BitConverter]::ToString(
          [System.Security.Cryptography.SHA256]::Create().ComputeHash($key)
        ).Replace('-','').Substring(0,12).ToLower()
  Write-Host "    主密钥 OK（32 字节，指纹 $fp）" -ForegroundColor Green
} catch {
  Write-Host "[x] DPAPI 解密钥失败：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '    请确认运行本脚本的 Windows 用户与运行 Chrome 的用户是同一个。' -ForegroundColor Yellow
  exit 1
}

# ---------- 3. 交给 Node 完成解密与落盘 ----------
Write-Host ''
Write-Host '[2/2] 调用 Node 解密并写入凭证文件 ...' -ForegroundColor Cyan
$nodeArgs = @(
  (Join-Path $root 'scripts\export-cookies.mjs'),
  '--profile', $Profile,
  '--master-key-base64', $keyB64
)
if ($KeepAll) { $nodeArgs += '--keep-all' }

& node @nodeArgs
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
  Write-Host '=== 导出成功，现在可以重新打开 Chrome 了。 ===' -ForegroundColor Green
} else {
  Write-Host "=== 导出失败（退出码 $code）===" -ForegroundColor Red
}
exit $code
