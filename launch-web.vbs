Option Explicit

Dim shell, fso, root, nodeExe, url, args
Set shell = CreateObject("Shell.Application")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
url = "http://127.0.0.1:8765/"

If Not fso.FileExists(nodeExe) Then
  MsgBox "Node.js 20+ not found. Please install Node.js first.", 16, "LOL ARAM Helper"
  WScript.Quit 1
End If

args = """" & root & "\src\index.js"" --web"

' Window style 0 = hidden. The web page is the interface.
shell.ShellExecute nodeExe, args, root, "runas", 0

' Give the local server a moment to bind, then open the dashboard.
WScript.Sleep 1800
CreateObject("WScript.Shell").Run url, 1, False
