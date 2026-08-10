"""
Админские команды: управление сервером, сообщения в игру, карточка игрока,
журнал действий админов.

Права проверяются дважды и это не перестраховка: Discord проверяет, кому команда
вообще видна, а панель — что API-токену это позволено. Второе главнее: токен с
правами чтения не сможет ничего изменить, даже если в Discord команду вызвал
администратор.
"""

from __future__ import annotations

import discord
from discord import app_commands

from panel import PanelError

# Что показываем в карточке игрока. Порядок — как читает человек.
STATS = [
    ("health", "Здоровье", 100),
    ("blood", "Кровь", 5000),
    ("hunger", "Голод", 0),
    ("thirst", "Жажда", 0),
    ("stamina", "Выносливость", 0),
]


def is_staff(interaction: discord.Interaction, settings: dict) -> bool:
    """Админ Discord или носитель заданной в панели роли админов."""
    if interaction.user.guild_permissions.administrator:
        return True

    role_id = settings.get("adminRoleId")
    if not role_id:
        return False
    return any(str(role.id) == str(role_id) for role in getattr(interaction.user, "roles", []))


def setup(bot) -> None:
    async def deny_if_not_staff(interaction: discord.Interaction) -> bool:
        if is_staff(interaction, bot.settings):
            return False
        await interaction.response.send_message(
            "Команда только для админов. Роль админов задаётся в мастере настройки панели.", ephemeral=True
        )
        return True

    @bot.tree.command(name="say", description="Написать игрокам в игру (для админов)")
    @app_commands.describe(text="Что написать")
    @app_commands.default_permissions(administrator=True)
    async def say(interaction: discord.Interaction, text: str) -> None:
        if await deny_if_not_staff(interaction):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            await bot.panel.post("/ingame/say", {"text": text})
        except PanelError as err:
            await interaction.followup.send(f"Не отправлено: {err}", ephemeral=True)
            return

        await bot.log_to_channel(f"📢 {interaction.user} написал в игру: {text}")
        await interaction.followup.send("Отправлено игрокам в игру.", ephemeral=True)

    @bot.tree.command(name="restart-server", description="Перезапустить сервер (для админов)")
    @app_commands.describe(warn="Предупредить игроков в игре и подождать минуту")
    @app_commands.default_permissions(administrator=True)
    async def restart_server(interaction: discord.Interaction, warn: bool = True) -> None:
        if await deny_if_not_staff(interaction):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)

        if warn:
            # Предупреждение отправляем сами: панель предупреждает только по
            # плановому расписанию, а это перезапуск руками.
            try:
                await bot.panel.post("/ingame/say", {"text": "Перезапуск сервера через минуту. Уберите вещи в безопасное место."})
            except PanelError:
                pass  # канал в игру может быть не настроен — это не повод не перезапускать

        try:
            await bot.panel.post("/server/restart", {})
        except PanelError as err:
            await interaction.followup.send(f"Не получилось: {err}", ephemeral=True)
            return

        await bot.log_to_channel(f"♻️ {interaction.user} перезапустил сервер" + (" (с предупреждением)" if warn else ""))
        await interaction.followup.send("Перезапуск запущен. Ход виден в панели, на вкладке «Обзор».", ephemeral=True)

    @bot.tree.command(name="player", description="Карточка игрока: здоровье, голод, где он (для админов)")
    @app_commands.describe(name="Часть ника игрока")
    @app_commands.default_permissions(administrator=True)
    async def player(interaction: discord.Interaction, name: str) -> None:
        if await deny_if_not_staff(interaction):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            data = await bot.panel.get("/bridge/players")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        needle = name.strip().lower()
        found = [p for p in data.get("players", []) if needle in str(p.get("name", "")).lower()]

        if not found:
            reason = "" if data.get("status", {}).get("online") else " Мод-мост не на связи, поэтому игроков панель не видит."
            await interaction.followup.send(f"Никого похожего на «{name}» онлайн нет.{reason}", ephemeral=True)
            return

        if len(found) > 1:
            names = ", ".join(p.get("name", "") for p in found[:10])
            await interaction.followup.send(f"Подходят несколько: {names}. Уточните ник.", ephemeral=True)
            return

        p = found[0]
        embed = discord.Embed(title=p.get("name", ""), colour=0x3FB950)
        embed.add_field(name="Steam", value=f"`{p.get('steam64') or p.get('id')}`", inline=False)

        for key, title, _scale in STATS:
            value = p.get(key)
            if value is None or value < 0:
                continue
            embed.add_field(name=title, value=str(round(value)), inline=True)

        pos = p.get("pos") or [0, 0, 0]
        embed.add_field(name="Координаты", value=f"{round(pos[0])}, {round(pos[2] if len(pos) > 2 else 0)}", inline=True)

        marks = [word for flag, word in (("bleeding", "кровотечение"), ("unconscious", "без сознания"), ("restrained", "связан")) if p.get(flag)]
        if marks:
            embed.add_field(name="Состояние", value=", ".join(marks), inline=False)
        if p.get("hands"):
            embed.add_field(name="В руках", value=str(p["hands"]), inline=True)

        await interaction.followup.send(embed=embed, ephemeral=True)

    @bot.tree.command(name="kick", description="Выгнать игрока с сервера (для админов)")
    @app_commands.describe(name="Часть ника игрока", reason="Причина, её увидит игрок")
    @app_commands.default_permissions(administrator=True)
    async def kick(interaction: discord.Interaction, name: str, reason: str = "Решение администрации") -> None:
        if await deny_if_not_staff(interaction):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            data = await bot.panel.get("/bridge/players")
            found = [p for p in data.get("players", []) if name.strip().lower() in str(p.get("name", "")).lower()]

            if len(found) != 1:
                await interaction.followup.send(
                    "Нужен ровно один игрок: " + (f"подходят {len(found)}" if found else "никого не нашлось"), ephemeral=True
                )
                return

            await bot.panel.post("/bridge/command", {"action": "kick", "playerId": found[0].get("id"), "reason": reason})
        except PanelError as err:
            await interaction.followup.send(f"Не получилось: {err}", ephemeral=True)
            return

        await bot.log_to_channel(f"👢 {interaction.user} выгнал {found[0].get('name')} — {reason}")
        await interaction.followup.send(f"{found[0].get('name')} выгнан.", ephemeral=True)

    @bot.tree.command(name="adminlog", description="Последние действия админов, включая VPPAdminTools (для админов)")
    @app_commands.default_permissions(administrator=True)
    async def adminlog(interaction: discord.Interaction) -> None:
        if await deny_if_not_staff(interaction):
            return
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            data = await bot.panel.get("/events?types=admin&limit=15")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        events = data.get("events") or []
        if not events:
            await interaction.followup.send("Записей нет. Журнал целиком — в панели, вкладка «Журнал».", ephemeral=True)
            return

        lines = []
        for item in events[:15]:
            info = item.get("data") or {}
            who = (item.get("playerName") or info.get("admin") or "—")
            lines.append(f"<t:{int(item.get('ts', 0) / 1000)}:t> {who}: {info.get('phrase') or info.get('action') or ''}")

        await interaction.followup.send("\n".join(lines)[:1900], ephemeral=True)
