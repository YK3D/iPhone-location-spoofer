@echo off
REM Only needed for iOS 17.0 - 17.3. Must run as administrator. Keep this window open.
cd /d "%~dp0"
net session >nul 2>nul || (echo Right-click this file and choose "Run as administrator". & pause & exit /b 1)
if not exist ".venv\Scripts\python.exe" (echo Run run_windows.bat once first. & pause & exit /b 1)
".venv\Scripts\python.exe" -m pymobiledevice3 remote tunneld
pause
