@echo off
rem Launch Chrome with the bbarit browser bridge extension loaded into a
rem dedicated profile, so the agent can control this window. Re-run any time.
setlocal
set "EXT=%~dp0"
set "EXT=%EXT:~0,-1%"
set "CHROME="
for %%f in (
  "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
  "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do if not defined CHROME if exist %%f set "CHROME=%%~f"
if not defined CHROME (
  echo Could not find chrome.exe. Edit this script with your Chrome path.
  pause
  exit /b 1
)
start "" "%CHROME%" --load-extension="%EXT%" --user-data-dir="%USERPROFILE%\.pi\chrome-bbarit" --no-first-run --new-window "about:blank"
endlocal
