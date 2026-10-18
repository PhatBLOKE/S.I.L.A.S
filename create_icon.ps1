Add-Type -AssemblyName System.Drawing

$size = 64
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# Dark obsidian background
$bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(9, 11, 16))
$g.FillRectangle($bgBrush, 0, 0, $size, $size)

# Cyan border
$borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(0, 242, 254), 3)
$g.DrawRectangle($borderPen, 3, 3, $size - 6, $size - 6)

# Glowing inner border
$innerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(2, 132, 199), 1)
$g.DrawRectangle($innerPen, 6, 6, $size - 12, $size - 12)

# Letter 'H' in cyan
$font = New-Object System.Drawing.Font("Impact", 28, [System.Drawing.FontStyle]::Bold)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0, 242, 254))
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
$g.DrawString("H", $font, $textBrush, $rect, $sf)

# Save as ICO
$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = New-Object System.IO.FileStream("havoc.ico", [System.IO.FileMode]::Create)
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()
$g.Dispose()

Write-Host "havoc.ico created successfully!"
