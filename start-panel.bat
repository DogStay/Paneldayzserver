@echo off
chcp 65001 >nul
title DayZ Panel
cd /d "%~dp0"

echo ==========================================================
echo  DayZ Panel - веб-панель управления сервером DayZ
echo ==========================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден в PATH.
    echo Установите Node.js LTS с https://nodejs.org и запустите файл заново.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\express" (
    echo Первый запуск: устанавливаю зависимости ^(нужен интернет^)...
    call npm install --omit=dev
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] npm install завершился с ошибкой.
        pause
        exit /b 1
    )
    echo.
)

net session >nul 2>&1
if errorlevel 1 (
    echo [ВНИМАНИЕ] Панель запущена БЕЗ прав администратора.
    echo Автоматическое открытие портов через netsh работать не будет.
    echo Закройте окно и запустите этот файл через ПКМ -^> «Запуск от имени администратора».
    echo.
)

for /f "tokens=2 delims=:," %%p in ('findstr /c:"\"port\"" config\config.json 2^>nul') do set PANEL_PORT=%%p
if not defined PANEL_PORT set PANEL_PORT= 8787
set PANEL_PORT=%PANEL_PORT: =%

echo Открываю http://localhost:%PANEL_PORT% ...
start "" "http://localhost:%PANEL_PORT%"
echo.
echo Панель работает. Не закрывайте это окно.
echo Для остановки нажмите Ctrl+C.
echo.

node src\server.js

echo.
echo Панель остановлена.
pause
