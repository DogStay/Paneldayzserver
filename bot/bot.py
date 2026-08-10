"""
Discord-бот панели.

Бот **ничего не хранит и ничего не решает сам** — единственная истина в панели:

  * настройки (токен бота, ID сервера Discord, роли, каналы) он берёт у панели
    (`GET /api/bot/config`), поэтому у владельца одно место настройки и нечему
    расходиться. Локально нужны только адрес панели и API-токен;
  * владение Steam доказывает панель через Steam OpenID, а не поле ввода;
  * прописку в файлы сервера делает панель через очередь на диске с повторами.
    Поэтому «пришёл, а его не прописало» невозможно даже если бот в этот момент
    лежал: заявка уже в очереди, панель допишет её сама.

Модули лежат в `modules/`, каждый добавляет свои команды в `setup(bot)`:

    verification — /verify, /status, /whitelist, /unverify + догонялка ролей
    serverinfo   — /server, /online, живое сообщение статуса, статус бота
    admin        — /say, /restart-server, /player, /kick, /adminlog
    groups       — /groups, /group-members, /group-add
    tickets      — /ticket, /close, /ticket-setup (приватные ветки)

Запуск:
    pip install -r requirements.txt
    python bot.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

import discord
from discord import app_commands

from panel import Panel, PanelError
from modules import admin, groups, serverinfo, tickets, verification

LOG = logging.getLogger("panelbot")

MODULES = (verification, serverinfo, admin, groups, tickets)


def load_env() -> None:
    """Простой .env без зависимостей: строки вида ключ=значение."""
    env_file = Path(__file__).with_name(".env")
    if not env_file.exists():
        return

    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


class PanelBot(discord.Client):
    def __init__(self, panel: Panel, settings: dict):
        intents = discord.Intents.default()
        # Участники нужны, чтобы выдавать роли по id, а не только по событиям.
        intents.members = True
        super().__init__(intents=intents)

        self.panel = panel
        self.settings = settings
        self.tree = app_commands.CommandTree(self)
        self._views: list[discord.ui.View] = []
        self._tasks: list[asyncio.Task] = []

    # ------------------------------------------------------------ настройка

    def add_persistent_view(self, view: discord.ui.View) -> None:
        """Виды с кнопками регистрируются после подключения, а не сразу."""
        self._views.append(view)

    def main_guild(self) -> discord.Guild | None:
        guild_id = self.settings.get("guildId")
        if not guild_id:
            return None
        return self.get_guild(int(guild_id))

    async def setup_hook(self) -> None:
        for module in MODULES:
            module.setup(self)

        guild_id = self.settings.get("guildId")
        if guild_id:
            # На одном сервере команды появляются сразу; глобальные — до часа.
            guild = discord.Object(id=int(guild_id))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            LOG.warning("Не задан ID сервера Discord — команды появятся не сразу (глобальная синхронизация)")
            await self.tree.sync()

        for view in self._views:
            self.add_view(view)

        self._tasks.append(self.loop.create_task(self.verification.catchup_loop()))
        self._tasks.append(self.loop.create_task(self.serverinfo.refresh_loop()))
        self._tasks.append(self.loop.create_task(self.settings_loop()))

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        await super().close()

    # ------------------------------------------------------------- служебное

    async def settings_loop(self) -> None:
        """
        Перечитывать настройки из панели.

        Владелец меняет ID роли или канала в мастере настройки и ждёт, что бот
        это подхватит. Раз в пять минут — достаточно, чтобы не перезапускать бота
        руками, и не нагружает панель.
        """
        await self.wait_until_ready()

        while not self.is_closed():
            await asyncio.sleep(300)
            try:
                fresh = await self.panel.get("/bot/config")
            except PanelError as err:
                LOG.warning("Настройки не обновлены: %s", err)
                continue

            # Токен бота менять на ходу нельзя — для этого нужен перезапуск.
            fresh.pop("botToken", None)
            if {k: v for k, v in self.settings.items() if k != "botToken"} != fresh:
                LOG.info("Настройки в панели изменились — применяю")
                self.settings.update(fresh)

    async def log_to_channel(self, text: str) -> None:
        channel_id = self.settings.get("logChannelId")
        if not channel_id:
            return

        channel = self.get_channel(int(channel_id))
        if channel is None:
            return
        try:
            await channel.send(text)
        except discord.HTTPException as err:
            LOG.warning("Журнал в Discord не записан: %s", err)

    async def on_ready(self) -> None:
        LOG.info(
            "Бот вошёл как %s. Сервер панели: «%s». Команд: %d",
            self.user,
            self.settings.get("serverName") or "?",
            len(self.tree.get_commands()),
        )


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    load_env()

    panel_url = os.environ.get("PANEL_URL", "http://127.0.0.1:8787")
    panel_token = os.environ.get("PANEL_TOKEN", "")

    if not panel_token:
        print(
            "Не задан PANEL_TOKEN. Возьмите API-токен с правами admin в панели:\n"
            "  Настройки → Аккаунты и права → API-токены\n"
            "и положите его в файл bot/.env строкой PANEL_TOKEN=dzp_…"
        )
        return 2

    panel = Panel(panel_url, panel_token)
    await panel.open()

    try:
        settings = await panel.get("/bot/config")
    except PanelError as err:
        print(f"Не удалось получить настройки из панели: {err}")
        await panel.close()
        return 2

    token = settings.get("botToken") or os.environ.get("DISCORD_TOKEN", "")
    if not token:
        print(
            "В панели не задан токен бота. Откройте на машине с панелью\n"
            f"  {panel_url}/setup.html  →  раздел «Discord»  →  «Токен бота»"
        )
        await panel.close()
        return 2

    bot = PanelBot(panel, settings)
    try:
        await bot.start(token)
    except discord.LoginFailure:
        print("Discord не принял токен бота. Проверьте его в мастере настройки панели (Discord → Bot → Reset Token).")
        return 2
    except discord.PrivilegedIntentsRequired:
        print(
            "Включите Server Members Intent: discord.com/developers → ваше приложение → Bot →\n"
            "Privileged Gateway Intents → Server Members Intent. Без него бот не может выдавать роли."
        )
        return 2
    finally:
        await panel.close()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
