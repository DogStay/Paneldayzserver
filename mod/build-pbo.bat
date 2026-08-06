@echo off
rem ==========================================================
rem  Rebuild @DayZPanelBridge from sources.
rem  Text is ASCII on purpose: cmd.exe shows it correctly in
rem  any code page, unlike Cyrillic without chcp juggling.
rem ==========================================================
title DayZPanelBridge - build
cd /d "%~dp0"

echo ==========================================================
echo  DayZPanelBridge - building addon
echo ==========================================================
echo.

if not exist "DayZPanelBridge\config.cpp" (
    echo [ERROR] DayZPanelBridge\config.cpp not found.
    echo Run this file from the "mod" folder of the panel.
    echo.
    pause
    exit /b 1
)

rem --- Way 1: DayZ Tools AddonBuilder (official, binarizes config) ----------
set "AB="
if exist "%ProgramFiles(x86)%\Steam\steamapps\common\DayZ Tools\Bin\AddonBuilder\AddonBuilder.exe" set "AB=%ProgramFiles(x86)%\Steam\steamapps\common\DayZ Tools\Bin\AddonBuilder\AddonBuilder.exe"
if exist "C:\Program Files (x86)\Steam\steamapps\common\DayZ Tools\Bin\AddonBuilder\AddonBuilder.exe" set "AB=C:\Program Files (x86)\Steam\steamapps\common\DayZ Tools\Bin\AddonBuilder\AddonBuilder.exe"

if not "%AB%"=="" (
    echo Found DayZ Tools AddonBuilder:
    echo   %AB%
    echo.
    if not exist "@DayZPanelBridge\addons" mkdir "@DayZPanelBridge\addons"
    "%AB%" "%CD%\DayZPanelBridge" "%CD%\@DayZPanelBridge\addons" -clear -packonly -prefix=DayZPanelBridge
    if errorlevel 1 (
        echo.
        echo [WARN] AddonBuilder failed, falling back to the built-in packer.
    ) else (
        echo.
        echo Done: @DayZPanelBridge\addons\DayZPanelBridge.pbo
        echo.
        pause
        exit /b 0
    )
)

rem --- Way 2: packer shipped with the panel (no DayZ Tools needed) ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Neither DayZ Tools nor Node.js found.
    echo Install Node.js LTS from https://nodejs.org and run this file again.
    echo.
    pause
    exit /b 1
)

echo DayZ Tools not found - packing with the panel's own packer.
echo.
node "..\tools\pack-pbo.js" "DayZPanelBridge" "@DayZPanelBridge\addons\dayzpanelbridge.pbo" DayZPanelBridge
if errorlevel 1 (
    echo.
    echo [ERROR] Packing failed.
    echo.
    pause
    exit /b 1
)

echo.
echo Done: @DayZPanelBridge\addons\dayzpanelbridge.pbo
echo Copy the @DayZPanelBridge folder next to DayZServer_x64.exe
echo and add -serverMod=@DayZPanelBridge to the server start line.
echo.
pause
