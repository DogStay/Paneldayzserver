@echo off
rem Запуск Discord-бота панели. Настройки бот берёт у панели, поэтому панель
rem должна быть запущена.
cd /d "%~dp0bot"

where py >nul 2>nul && set PY=py || set PY=python

%PY% -m pip install -r requirements.txt
%PY% bot.py
pause
