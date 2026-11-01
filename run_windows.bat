@echo off
REM iPhone Location Spoofer - Windows launcher. Double-click to run.
cd /d "%~dp0"
where py >nul 2>nul || (echo Python launcher "py" not found. Install Python 3.12 from python.org and tick "Add python.exe to PATH". & pause & exit /b 1)
py -3.12 --version >nul 2>nul || (echo Python 3.12 is not installed. Install it from python.org/downloads. & pause & exit /b 1)
if not exist ".venv\Scripts\python.exe" (
  echo First run: creating a private Python environment...
  py -3.12 -m venv .venv || (pause & exit /b 1)
)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt || (echo Installing requirements failed. & pause & exit /b 1)
".venv\Scripts\python.exe" -m spoofer %*
pause
