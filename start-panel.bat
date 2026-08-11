@echo off
rem ==========================================================
rem  Файл в кодировке CP866 (родная для консоли Windows).
rem  НЕ добавляйте сюда "chcp 65001": смена кодовой страницы
rem  посреди .bat сбивает разбор файла, и скрипт молча обрывается.
rem ==========================================================
title DayZ Panel
cd /d "%~dp0"

echo ==========================================================
echo  DayZ Panel - веб-панель управления сервером DayZ
echo ==========================================================
echo.

if not exist "package.json" (
    echo [ОШИБКА] В этой папке нет package.json.
    echo Запускайте start-panel.bat из папки, куда распакована панель.
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден в PATH.
    echo Установите Node.js LTS с https://nodejs.org и запустите файл заново.
    echo.
    pause
    exit /b 1
)

rem Проверяем каждую зависимость, а не только express: mysql2 добавился позже,
rem и у тех, кто обновился через git pull без npm install, панель падала на
rem старте из-за отсутствующего модуля.
set "NEED_INSTALL="
if not exist "node_modules\express" set "NEED_INSTALL=1"
if not exist "node_modules\mysql2" set "NEED_INSTALL=1"

if defined NEED_INSTALL (
    echo Устанавливаю зависимости панели, нужен интернет...
    echo.
    call npm install --omit=dev
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] npm install завершился с ошибкой. Запустите install.bat.
        echo.
        pause
        exit /b 1
    )
    echo.
)

net session >nul 2>&1
if errorlevel 1 (
    echo [ВНИМАНИЕ] Панель запущена БЕЗ прав администратора.
    echo Автоматическое открытие портов через netsh работать не будет.
    echo Закройте окно и запустите файл через правую кнопку мыши -
    echo "Запуск от имени администратора".
    echo.
)

set "PANEL_PORT=8787"
if exist "config\config.json" (
    for /f "tokens=2 delims=:," %%p in ('findstr /c:"\"port\"" config\config.json') do (
        set "PANEL_PORT=%%p"
        goto :port_done
    )
)
:port_done
set "PANEL_PORT=%PANEL_PORT: =%"

echo Открываю http://localhost:%PANEL_PORT%
start "" "http://localhost:%PANEL_PORT%"
echo.
echo Панель работает. Не закрывайте это окно.
echo Для остановки нажмите Ctrl+C.
echo.

node src\server.js

echo.
echo Панель остановлена.
pause
