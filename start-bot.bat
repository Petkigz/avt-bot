@echo off
title Aviator Bot - Control Center
cd /d "%~dp0"

rem ---------- checks ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not on your PATH.
    echo         Install the LTS from https://nodejs.org and run this file again.
    pause
    exit /b 1
)

if not exist node_modules (
    echo First run: installing dependencies, please wait...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed. Check your internet connection and retry.
        pause
        exit /b 1
    )
)

if not exist .env (
    copy .env.example .env >nul
    echo Created .env from .env.example
)

:menu
cls
echo ======================================================
echo            AVIATOR BOT  -  LAUNCHER
echo ======================================================
echo.
echo   [1] START THE BOT          (dashboard opens automatically)
echo   [2] Health check           (npm run doctor)
echo   [3] Demo dashboard         (synthetic data, no login)
echo   [4] Update from GitHub     (git pull + npm install)
echo   [5] Exit
echo.
echo   Tip: edit .env with Notepad for extra options.
echo ======================================================
set /p choice=Choose an option (1-5): 

if "%choice%"=="1" goto start
if "%choice%"=="2" goto doctor
if "%choice%"=="3" goto demo
if "%choice%"=="4" goto update
if "%choice%"=="5" goto :eof
goto menu

:start
echo.
echo Starting the bot... the dashboard opens in your browser shortly.
echo Close the other window (or Ctrl+C in it) to stop the bot.
rem The launcher is the dashboard-first experience: wait for LAUNCH in Mission Control.
set "UI_START=true"
start "" /b cmd /v:on /c "timeout /t 6 /nobreak >nul & set DP=4100 & if exist data\dashboard-port set /p DP=<data\dashboard-port & start http://localhost:!DP!"
call npm start
echo.
echo Bot stopped.
pause
goto menu

:doctor
echo.
call npm run doctor
echo.
pause
goto menu

:demo
echo.
echo Demo dashboard (synthetic rounds) - close the other window to stop.
start "" /b cmd /v:on /c "timeout /t 5 /nobreak >nul & set DP=4100 & if exist data\dashboard-port set /p DP=<data\dashboard-port & start http://localhost:!DP!"
call npm run demo
echo.
pause
goto menu

:update
echo.
echo Updating from GitHub (Petkigz/avt-bot, arena branch)...
git pull
if errorlevel 1 (
    echo [WARN] git pull failed - if this folder was cloned manually, run:
    echo        git pull origin arena/01a0c813-avt-bot
)
call npm install
echo.
echo Update finished.
pause
goto menu
