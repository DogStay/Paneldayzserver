@echo off
chcp 65001 >nul
title DayZ Panel - установка
cd /d "%~dp0"

echo ==========================================================
echo  Установка зависимостей DayZ Panel
echo ==========================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден.
    echo Скачайте и установите LTS-версию: https://nodejs.org
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node --version') do echo Найден Node.js %%v
echo.

echo Устанавливаю пакеты (требуется интернет)...
call npm install --omit=dev
if errorlevel 1 (
    echo.
    echo [ОШИБКА] Не удалось установить зависимости.
    pause
    exit /b 1
)

if not exist "config\config.json" (
    copy /y "config\config.default.json" "config\config.json" >nul
    echo Создан config\config.json - укажите в нём пути к серверу и SteamCMD.
)

echo.
echo ==========================================================
echo  Готово. Запускайте start-panel.bat
echo  (желательно от имени администратора - для netsh)
echo ==========================================================
pause
