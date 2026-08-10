"""
Обращения (тикеты) — приватные ветки в канале.

Почему ветки, а не отдельные каналы: канал на каждое обращение быстро упирается
в лимит каналов Discord и требует уборки, а ветка сама архивируется и остаётся
историей. Ничего хранить не нужно: сама ветка и есть тикет, поэтому у бота нет
файла с состоянием, который может разойтись с Discord.

Кнопка «Создать обращение» держится в канале постоянно (persistent view), поэтому
она продолжает работать после перезапуска бота.
"""

from __future__ import annotations

import logging

import discord
from discord import app_commands

LOG = logging.getLogger("panelbot.tickets")

# Ветка закрывается сама, если в ней долго тихо. Сутки — компромисс: обращение не
# висит вечно, но человек успевает ответить после сна.
AUTO_ARCHIVE_MINUTES = 1440

BUTTON_ID = "panel-ticket-open"


class TicketButton(discord.ui.View):
    """Кнопка в канале обращений. timeout=None — иначе перестанет работать."""

    def __init__(self, bot):
        super().__init__(timeout=None)
        self.bot = bot

    @discord.ui.button(label="Создать обращение", style=discord.ButtonStyle.primary, emoji="✉️", custom_id=BUTTON_ID)
    async def open_ticket(self, interaction: discord.Interaction, button: discord.ui.Button) -> None:
        await open_for(self.bot, interaction)


async def open_for(bot, interaction: discord.Interaction) -> None:
    """Создать ветку под обращение этого человека."""
    channel = interaction.channel
    if not isinstance(channel, discord.TextChannel):
        await interaction.response.send_message("Обращения создаются в текстовом канале.", ephemeral=True)
        return

    await interaction.response.defer(ephemeral=True, thinking=True)

    # Уже открытая ветка — вторую не плодим: иначе история разъезжается по двум.
    existing = next(
        (t for t in channel.threads if not t.archived and t.name.endswith(f"-{interaction.user.id}")),
        None,
    )
    if existing is not None:
        await interaction.followup.send(f"У вас уже есть открытое обращение: {existing.mention}", ephemeral=True)
        return

    try:
        thread = await channel.create_thread(
            name=f"обращение-{interaction.user.display_name}-{interaction.user.id}"[:100],
            # Приватная ветка: её видят только приглашённые и модерация.
            type=discord.ChannelType.private_thread,
            auto_archive_duration=AUTO_ARCHIVE_MINUTES,
            reason="Обращение через бота панели",
        )
    except discord.Forbidden:
        await interaction.followup.send(
            "Не хватает прав создать ветку. Боту нужны «Создавать приватные ветки» и «Писать в ветках» в этом канале.",
            ephemeral=True,
        )
        return
    except discord.HTTPException as err:
        # Приватные ветки есть не на всех серверах (нужен уровень бустов).
        await interaction.followup.send(f"Discord не создал ветку: {err.text or err}", ephemeral=True)
        return

    staff_role_id = bot.settings.get("staffRoleId")
    mention = f" <@&{staff_role_id}>" if staff_role_id else ""

    await thread.add_user(interaction.user)
    await thread.send(
        f"{interaction.user.mention}, опишите вопрос одним сообщением: что произошло, когда, ник на сервере.{mention}\n"
        "Закрыть обращение — команда `/close` прямо здесь."
    )

    await bot.log_to_channel(f"✉️ Новое обращение от <@{interaction.user.id}>: {thread.mention}")
    await interaction.followup.send(f"Обращение создано: {thread.mention}", ephemeral=True)


def setup(bot) -> None:
    # Кнопка должна отвечать и после перезапуска бота, поэтому view
    # регистрируется заново при каждом старте.
    bot.add_persistent_view(TicketButton(bot))

    @bot.tree.command(name="ticket", description="Создать обращение к администрации")
    async def ticket(interaction: discord.Interaction) -> None:
        await open_for(bot, interaction)

    @bot.tree.command(name="close", description="Закрыть обращение (внутри ветки обращения)")
    @app_commands.describe(reason="Итог, его увидит автор обращения")
    async def close(interaction: discord.Interaction, reason: str = "") -> None:
        thread = interaction.channel
        if not isinstance(thread, discord.Thread) or not thread.name.startswith("обращение-"):
            await interaction.response.send_message("Эту команду нужно вызывать внутри ветки обращения.", ephemeral=True)
            return

        # Закрыть может автор или сотрудник: автор — потому что вопрос решился
        # сам, сотрудник — потому что ответил.
        author_id = thread.name.rsplit("-", 1)[-1]
        staff_role_id = bot.settings.get("staffRoleId")
        is_staff = interaction.user.guild_permissions.administrator or (
            staff_role_id and any(str(r.id) == str(staff_role_id) for r in interaction.user.roles)
        )

        if str(interaction.user.id) != author_id and not is_staff:
            await interaction.response.send_message("Закрыть обращение может его автор или сотрудник.", ephemeral=True)
            return

        await interaction.response.send_message(
            f"Обращение закрыто {interaction.user.mention}." + (f" Итог: {reason}" if reason else "")
        )
        await bot.log_to_channel(f"✅ Обращение {thread.name} закрыто {interaction.user}" + (f": {reason}" if reason else ""))

        try:
            await thread.edit(archived=True, locked=True, reason="Обращение закрыто")
        except discord.Forbidden:
            LOG.warning("Нет прав закрыть ветку %s", thread.id)

    @bot.tree.command(name="ticket-setup", description="Поставить в этом канале кнопку «Создать обращение» (для админов)")
    @app_commands.default_permissions(administrator=True)
    async def ticket_setup(interaction: discord.Interaction) -> None:
        embed = discord.Embed(
            title="Обращение к администрации",
            description=(
                "Нажмите кнопку — откроется приватная ветка, которую видите только вы и администрация.\n"
                "Опишите вопрос одним сообщением: что произошло, когда, ваш ник на сервере."
            ),
            colour=0x3FB950,
        )

        await interaction.channel.send(embed=embed, view=TicketButton(bot))
        await interaction.response.send_message(
            "Кнопка поставлена. Чтобы бот держал её сам, укажите ID этого канала в мастере настройки панели "
            "(«ID канала тикетов»).",
            ephemeral=True,
        )
