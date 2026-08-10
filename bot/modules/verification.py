"""
Верификация: /verify, /status, ручная прописка, догонялка после падения бота.

Доказательство владения Steam делает панель (Steam OpenID), прописку в файлы
сервера — очередь панели. Здесь только Discord: выдать роль, поставить ник,
написать в журнал.
"""

from __future__ import annotations

import asyncio
import logging

import discord
from discord import app_commands

from panel import PanelError

LOG = logging.getLogger("panelbot.verify")

# Обычно роль выдаётся сразу после команды. Этот цикл — страховка: если бот в
# момент верификации лежал, панель всё равно прописала игрока, и роль нужно
# догнать.
CATCHUP_SECONDS = 30


class Verification:
    def __init__(self, bot):
        self.bot = bot

    # --------------------------------------------------------- выдача роли

    async def grant(self, discord_id: str, steam_id: str, nickname: str) -> str:
        """Выдать роль и ник. Возвращает, что получилось — словами."""
        guild = self.bot.main_guild()
        if guild is None:
            return "не задан ID сервера Discord в настройках панели"

        try:
            member = guild.get_member(int(discord_id)) or await guild.fetch_member(int(discord_id))
        except (discord.NotFound, discord.HTTPException):
            return f"участник {discord_id} не найден на сервере"

        done: list[str] = []
        role_id = self.bot.settings.get("verifiedRoleId")

        if role_id:
            role = guild.get_role(int(role_id))
            if role is None:
                done.append(f"роль {role_id} не найдена")
            elif role in member.roles:
                done.append("роль уже была")
            else:
                try:
                    await member.add_roles(role, reason="Верификация через панель")
                    done.append(f"выдана роль {role.name}")
                except discord.Forbidden:
                    # Самая частая причина: роль бота ниже выдаваемой.
                    done.append("нет прав выдать роль — поднимите роль бота выше выдаваемой")

        if nickname:
            try:
                await member.edit(nick=nickname[:32], reason="Ник из Steam")
                done.append("ник из Steam")
            except discord.Forbidden:
                done.append("ник не сменён (нет прав)")

        await self.bot.log_to_channel(
            f"✅ <@{discord_id}> подтвердил Steam `{steam_id}`"
            + (f" ({nickname})" if nickname else "")
            + f" — {', '.join(done) if done else 'без изменений'}"
        )

        try:
            await self.bot.panel.post("/verify/ack", {"discordId": discord_id})
        except PanelError as err:
            LOG.warning("Не удалось отметить выдачу роли в панели: %s", err)

        return ", ".join(done) if done else "изменений не потребовалось"

    # ----------------------------------------------------------- догонялка

    async def catchup_loop(self) -> None:
        await self.bot.wait_until_ready()

        while not self.bot.is_closed():
            try:
                data = await self.bot.panel.get("/verify/pending")
                for item in data.get("pending", []):
                    LOG.info("Догоняю верификацию %s", item.get("discordId"))
                    await self.grant(item.get("discordId", ""), item.get("steamId", ""), item.get("nickname", ""))
            except PanelError as err:
                LOG.warning("Панель не ответила: %s", err)

            await asyncio.sleep(CATCHUP_SECONDS)


def setup(bot) -> Verification:
    module = Verification(bot)
    bot.verification = module

    @bot.tree.command(name="verify", description="Подтвердить Steam и прописаться на сервере")
    async def verify(interaction: discord.Interaction) -> None:
        # Ответ виден только этому человеку: ссылка личная — по ней Steam
        # привязывается именно к его Discord.
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            existing = await bot.panel.get(f"/verify/status?discordId={interaction.user.id}")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        if existing.get("verified"):
            targets = existing.get("roster") or []
            missing = [t["title"] for t in targets if not t.get("present")]
            note = ("Прописка ещё идёт: " + ", ".join(missing)) if missing else "Вы уже прописаны на сервере."
            await interaction.followup.send(
                f"Ваш Steam уже подтверждён: `{existing.get('steamId')}`. {note}", ephemeral=True
            )
            return

        try:
            link = await bot.panel.post(
                "/verify/start",
                {
                    "discordId": str(interaction.user.id),
                    "discordTag": str(interaction.user),
                    "guildId": str(interaction.guild_id or ""),
                },
            )
        except PanelError as err:
            await interaction.followup.send(f"Не удалось начать проверку: {err}", ephemeral=True)
            return

        minutes = max(1, int(link.get("ttlSeconds", 900)) // 60)
        await interaction.followup.send(
            "Откройте ссылку и войдите через Steam — пароль вводится на сайте Steam, "
            "ни бот, ни панель его не видят:\n"
            f"{link['url']}\n"
            f"Ссылка личная и действует {minutes} мин. После входа вас прописывает панель, роль выдам я.",
            ephemeral=True,
        )

    @bot.tree.command(name="status", description="Проверить, прописан ли игрок")
    @app_commands.describe(member="Кого проверить (по умолчанию — себя)")
    async def status(interaction: discord.Interaction, member: discord.Member | None = None) -> None:
        who = member or interaction.user
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            data = await bot.panel.get(f"/verify/status?discordId={who.id}")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        if not data.get("verified"):
            await interaction.followup.send(f"{who.mention}: верификации нет. Команда /verify.", ephemeral=True)
            return

        lines = [f"Steam: `{data.get('steamId')}`", f"Ник: {data.get('nickname') or '—'}"]
        lines += [f"{'✅' if t.get('present') else '⏳'} {t.get('title')}" for t in (data.get("roster") or [])]
        await interaction.followup.send("\n".join(lines), ephemeral=True)

    @bot.tree.command(name="whitelist", description="Прописать игрока вручную (для админов)")
    @app_commands.describe(member="Кому", steam_id="steamId64 из 17 цифр")
    @app_commands.default_permissions(administrator=True)
    async def whitelist(interaction: discord.Interaction, member: discord.Member, steam_id: str) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            await bot.panel.post(
                "/verify/link",
                {"discordId": str(member.id), "steamId": steam_id.strip(), "nickname": member.display_name},
            )
        except PanelError as err:
            await interaction.followup.send(f"Не получилось: {err}", ephemeral=True)
            return

        result = await module.grant(str(member.id), steam_id.strip(), member.display_name)
        await interaction.followup.send(f"{member.mention} прописан вручную. {result}", ephemeral=True)

    @bot.tree.command(name="unverify", description="Снять связку Discord и Steam (для админов)")
    @app_commands.describe(member="У кого снять")
    @app_commands.default_permissions(administrator=True)
    async def unverify(interaction: discord.Interaction, member: discord.Member) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            await bot.panel.post("/verify/unlink", {"discordId": str(member.id)})
        except PanelError as err:
            await interaction.followup.send(f"Не получилось: {err}", ephemeral=True)
            return

        # Роль снимаем здесь же: иначе связки нет, а доступ остался.
        role_id = bot.settings.get("verifiedRoleId")
        note = ""
        if role_id:
            role = interaction.guild.get_role(int(role_id)) if interaction.guild else None
            if role and role in member.roles:
                try:
                    await member.remove_roles(role, reason="Связка снята")
                    note = f", роль {role.name} снята"
                except discord.Forbidden:
                    note = ", роль снять не удалось (нет прав)"

        await bot.log_to_channel(f"🚫 Связка <@{member.id}> снята администратором {interaction.user}")
        await interaction.followup.send(f"Связка {member.mention} снята{note}.", ephemeral=True)

    return module
