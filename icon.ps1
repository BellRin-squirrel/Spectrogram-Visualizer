# 1. icon.ico から 256x256 のPNGを確実に抽出して保存
Add-Type -AssemblyName System.Drawing
$icoPath = (Resolve-Path "src-tauri\icons\icon.ico").Path
$icon = New-Object System.Drawing.Icon($icoPath, 256, 256)
$bmp = $icon.ToBitmap()
$bmp.Save("$PWD\temp_icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()
$bmp.Dispose()

# 2. npx.cmd を使ってTauri全OS用アイコン一式を生成 (PowerShell制限を回避)
npx.cmd @tauri-apps/cli icon temp_icon.png

# 3. 作業用PNGを削除
Remove-Item temp_icon.png