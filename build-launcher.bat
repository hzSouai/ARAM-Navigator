@echo off
setlocal
set "ROOT=%~dp0"
set "CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"

"%CSC%" /nologo /target:winexe /codepage:65001 /r:System.Windows.Forms.dll ^
  /win32icon:"%ROOT%web\favicon.ico" ^
  /win32manifest:"%ROOT%src\launcher\app.manifest" ^
  /out:"%ROOT%ARAM-Navigator.exe" ^
  "%ROOT%src\launcher\Launcher.cs"

if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)

echo Built: %ROOT%ARAM-Navigator.exe
