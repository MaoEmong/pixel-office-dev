# 앱 실행 → 대기 → 화면 캡처 → 종료 (실측 ⑤ 증거용)
param([int]$wait = 45)
$exe = Join-Path $PSScriptRoot "build\windows\x64\runner\Release\flutter_term.exe"
$proc = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds $wait
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$out = Join-Path $PSScriptRoot "shot.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "saved $out ($($b.Width)x$($b.Height))"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-3) } | Stop-Process -Force -ErrorAction SilentlyContinue
