# Points the desktop "Silas Console" icon at THIS copy of SILAS (whatever folder this script sits in).
$Here = $PSScriptRoot
$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [System.Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $Desktop "Silas Console.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = Join-Path $Here "restart_havoc.bat"
$Shortcut.WorkingDirectory = $Here
$Shortcut.IconLocation = (Join-Path $Here "havoc.ico") + ",0"
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Silas Console // 3D Fleet Command & Personal Assistant"
$Shortcut.Save()
Write-Host "Desktop shortcut now opens SILAS from $Here"
