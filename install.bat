@echo off
rem ==========================================================
rem  Файл в кодировке CP866 (родная для консоли Windows).
rem  НЕ добавляйте сюда "chcp 65001": смена кодовой страницы
rem  посреди .bat сбивает разбор файла, и скрипт молча обрывается.
rem ==========================================================
title DayZ Panel - установка
cd /d "%~dp0"

echo ==========================================================
echo  DayZ Panel - установка зависимостей
echo ==========================================================
echo.
echo Папка: %CD%
echo.

if not exist "package.json" (
    echo [ОШИБКА] В этой папке нет package.json.
    echo Запускайте install.bat из папки, куда распакована панель.
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден в PATH.
    echo.
    echo Скачайте LTS-версию с https://nodejs.org, установите её
    echo (галочка "Add to PATH" должна быть включена) и запустите файл заново.
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node --version') do echo [OK] Node.js %%v
for /f "delims=" %%v in ('npm --version 2^>nul') do echo [OK] npm %%v
echo.

echo Устанавливаю пакеты. Нужен интернет, это займёт до минуты...
echo.
call npm install --omit=dev
if errorlevel 1 (
    echo.
    echo [ОШИБКА] npm install завершился с ошибкой.
    echo Проверьте интернет и антивирус, затем запустите файл заново.
    echo.
    pause
    exit /b 1
)

echo.
echo ==========================================================
echo  [OK] Готово. Запускайте start-panel.bat
echo       Желательно от имени администратора - тогда панель
echo       сможет открывать порты в брандмауэре.
echo ==========================================================
echo.
pause
