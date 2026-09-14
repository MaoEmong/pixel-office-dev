# Capture ONE top-level window (never the full screen) with PrintWindow and save PNG.
# ASCII only: PowerShell 5.1 reads BOM-less files as ANSI, so non-ASCII text breaks parsing.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File tool\capture-window.ps1 -Out ..\..\docs\worklog\img\shot.png [-ProcessName pixel_office]
param(
  [string]$ProcessName = "pixel_office",
  [string]$Out = "shot.png"
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$proc = Get-Process $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "no window for process: $ProcessName"; exit 1 }
$hwnd = $proc.MainWindowHandle
$r = New-Object W+RECT
[void][W]::GetWindowRect($hwnd, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [W]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc)
$full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Out))
New-Item -ItemType Directory -Force (Split-Path $full) | Out-Null
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "printwindow=$ok size=${w}x${h} saved=$full"
