"""
Состояние сервера в Discord: команды /server и /online плюс живое сообщение в
канале статуса.

Всё берётся у панели: она уже знает и процесс сервера, и мод-мост, и расписание
перезапусков. Бот ничего не опрашивает сам — иначе появился бы второй источник
правды, который расходится с панелью.
"""

from __future__ import annotations

import asyncio
import logging

import discord

from panel import PanelError

LOG = logging.getLogger("panelbot.server")

# Как часто обновляется сообщение статуса и статус самого бота. Чаще нельзя:
# Discord ограничивает правки сообщений, а данные всё равно меняются медленнее.
REFRESH_SECONDS = 60

STATE_WORDS = {
    "running": "🟢 работает",
    "starting": "🟡 запускается",
    "stopping": "🟡 останавливается",
    "stopped": "🔴 остановлен",
    "crashed": "🔴 упал",
}


def uptime_words(seconds: int) -> str:
    if not seconds:
        return "—"
    hours, rest = divmod(int(seconds), 3600)
    minutes = rest // 60
    if hours:
        return f"{hours} ч {minutes} мин"
    return f"{minutes} мин"


class ServerInfo:
    def __init__(self, bot):
        self.bot = bot
        self._status_message: discord.Message | None = None

    async def snapshot(self) -> dict:
        """Собрать состояние: сервер, мост, игроки, перезапуск."""
        servers = await self.bot.panel.get("/servers")
        active_id = servers.get("activeServerId")
        server = next((s for s in servers.get("servers", []) if s["id"] == active_id), None)
        players = await self.bot.panel.get("/bridge/players")

        return {"server": server or {}, "players": players.get("players", []), "bridge": players.get("status", {})}

    def embed(self, data: dict) -> discord.Embed:
        server = data["server"]
        bridge = data["bridge"]
        players = data["players"]

        state = STATE_WORDS.get(server.get("status"), server.get("status") or "неизвестно")
        embed = discord.Embed(title=server.get("name") or "Сервер DayZ", colour=0x3FB950 if server.get("status") == "running" else 0xE5484D)

        embed.add_field(name="Состояние", value=state, inline=True)
        embed.add_field(name="Игроков", value=f"{len(players)} / {server.get('maxPlayers', '?')}", inline=True)
        embed.add_field(name="Аптайм", value=uptime_words(server.get("uptimeSec") or 0), inline=True)
        embed.add_field(name="Карта", value=bridge.get("world") or server.get("mission") or "—", inline=True)

        # Мост показываем только когда он молчит: когда всё работает, игрокам это
        # знать не нужно, а админ увидит подробности в панели.
        if not bridge.get("online"):
            embed.add_field(name="Мод-мост", value="не на связи", inline=True)

        restart = server.get("restart") or {}
        if restart.get("nextAt"):
            embed.add_field(name="Перезапуск", value=f"<t:{int(restart['nextAt'] / 1000)}:R>", inline=True)

        if server.get("lastError"):
            embed.add_field(name="Последняя ошибка", value=str(server["lastError"])[:200], inline=False)

        embed.set_footer(text="Обновляется автоматически")
        return embed

    # ----------------------------------------------------- живое сообщение

    async def refresh_loop(self) -> None:
        await self.bot.wait_until_ready()

        while not self.bot.is_closed():
            try:
                data = await self.snapshot()
                await self.update_presence(data)
                await self.update_status_message(data)
            except PanelError as err:
                LOG.warning("Статус не обновлён: %s", err)
            except discord.HTTPException as err:
                LOG.warning("Discord не принял правку статуса: %s", err)

            await asyncio.sleep(REFRESH_SECONDS)

    async def update_presence(self, data: dict) -> None:
        server = data["server"]
        if server.get("status") == "running":
            text = f"{len(data['players'])}/{server.get('maxPlayers', '?')} на сервере"
        else:
            text = STATE_WORDS.get(server.get("status"), "сервер недоступен")

        await self.bot.change_presence(activity=discord.Game(name=text))

    async def update_status_message(self, data: dict) -> None:
        channel_id = self.bot.settings.get("statusChannelId")
        if not channel_id:
            return

        channel = self.bot.get_channel(int(channel_id))
        if channel is None:
            return

        embed = self.embed(data)

        # Сообщение ищем среди своих последних: так бот не плодит новые после
        # каждого перезапуска и не требует хранить его id где-то ещё.
        if self._status_message is None:
            async for message in channel.history(limit=20):
                if message.author == self.bot.user and message.embeds:
                    self._status_message = message
                    break

        if self._status_message is None:
            self._status_message = await channel.send(embed=embed)
        else:
            try:
                await self._status_message.edit(embed=embed)
            except discord.NotFound:
                # Сообщение удалили — заведём новое на следующем круге.
                self._status_message = None


def setup(bot) -> ServerInfo:
    module = ServerInfo(bot)
    bot.serverinfo = module

    @bot.tree.command(name="server", description="Состояние сервера: онлайн, карта, перезапуск")
    async def server(interaction: discord.Interaction) -> None:
        await interaction.response.defer(thinking=True)

        try:
            data = await module.snapshot()
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}")
            return

        await interaction.followup.send(embed=module.embed(data))

    @bot.tree.command(name="online", description="Кто сейчас на сервере")
    async def online(interaction: discord.Interaction) -> None:
        await interaction.response.defer(thinking=True)

        try:
            data = await module.snapshot()
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}")
            return

        players = data["players"]
        if not data["bridge"].get("online"):
            await interaction.followup.send(
                "Мод-мост не на связи, поэтому список игроков панель не видит. "
                "Состояние сервера — команда /server."
            )
            return

        if not players:
            await interaction.followup.send("Сейчас на сервере никого.")
            return

        # Координаты не показываем: это подсказка, где кого искать.
        names = "\n".join(f"• {p.get('name')}" for p in players[:60])
        more = f"\n… и ещё {len(players) - 60}" if len(players) > 60 else ""
        await interaction.followup.send(f"На сервере {len(players)}:\n{names}{more}")

    return module
