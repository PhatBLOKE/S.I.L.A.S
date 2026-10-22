# Desktop icons for THIS copy of SILAS (whatever folder this script sits in):
#   "Silas Console"     - normal window (restarts the server first)
#   "SILAS Fullscreen"  - full screen, no taskbar, like a proper program (Alt+F4 to quit)
$Here = $PSScriptRoot
$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [System.Environment]::GetFolderPath('Desktop')

function New-SilasShortcut($Name, $Target, $Description) {
    $Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop "$Name.lnk"))
    $Shortcut.TargetPath = Join-Path $Here $Target
    $Shortcut.WorkingDirectory = $Here
    $Shortcut.IconLocation = (Join-Path $Here "havoc.ico") + ",0"
    $Shortcut.WindowStyle = 7   # start minimised, so the black window stays out of the way
    $Shortcut.Description = $Description
    $Shortcut.Save()
}

New-SilasShortcut "Silas Console" "restart_havoc.bat" "Silas Console // 3D Fleet Command & Personal Assistant"
New-SilasShortcut "SILAS Fullscreen" "silas_fullscreen.bat" "SILAS full screen // Alt+F4 to quit"
Write-Host "Desktop shortcuts now open SILAS from $Here"
