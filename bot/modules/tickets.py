"""
Обращения (тикеты).

Ничего из того, что видит игрок, здесь не зашито: кнопки, вопросы, тексты и роли
приходят из панели (`GET /api/tickets/config`). Владелец добавляет кнопку в
панели — бот её рисует. Поэтому «добавить ещё одну кнопку» не требует правки бота.

Само обращение — приватная ветка канала. Почему ветка, а не канал на обращение:
каналов у сервера ограниченное число и их приходится убирать руками, а ветка
архивируется сама и остаётся историей. Учёт и переписка при этом хранятся в
панели, поэтому обращение читается и после архивации ветки — например, когда
жалобу разбирают месяцем позже.
"""

from __future__ import annotations

import logging

import discord

from panel import PanelError

LOG = logging.getLogger("panelbot.tickets")

STYLES = {
    "primary": discord.ButtonStyle.primary,
    "secondary": discord.ButtonStyle.secondary,
    "success": discord.ButtonStyle.success,
    "danger": discord.ButtonStyle.danger,
}

# custom_id кнопок. Они постоянные: Discord присылает их после перезапуска бота,
# и по ним восстанавливается, что нажали.
OPEN_PREFIX = "panel-ticket-open:"
CLAIM_PREFIX = "panel-ticket-claim:"
CLOSE_PREFIX = "panel-ticket-close:"


def settings_of(bot) -> dict:
    return (bot.settings.get("tickets") or {}).get("settings") or {}


def forms_of(bot) -> list[dict]:
    return (bot.settings.get("tickets") or {}).get("forms") or []


def form_by_id(bot, form_id: str) -> dict | None:
    return next((f for f in forms_of(bot) if f["id"] == form_id), None)


def is_staff(member: discord.Member, settings: dict, form: dict | None, bot) -> bool:
    """Сотрудник: админ Discord, роль поддержки формы или общая роль поддержки."""
    if member.guild_permissions.administrator:
        return True

    allowed = set(settings.get("staffRoleIds") or [])
    allowed.update((form or {}).get("staffRoleIds") or [])
    if bot.settings.get("adminRoleId"):
        allowed.add(str(bot.settings["adminRoleId"]))
    if bot.settings.get("staffRoleId"):
        allowed.add(str(bot.settings["staffRoleId"]))

    return any(str(role.id) in allowed for role in member.roles)


class TicketModal(discord.ui.Modal):
    """Окно с вопросами формы. Вопросы приходят из панели, а не зашиты."""

    def __init__(self, bot, form: dict):
        super().__init__(title=form["title"][:45], timeout=600)
        self.bot = bot
        self.form = form
        self.fields: list[tuple[str, discord.ui.TextInput]] = []

        for question in form.get("questions", [])[:5]:
            item = discord.ui.TextInput(
                label=question["label"][:45],
                placeholder=question.get("placeholder") or None,
                required=question.get("required", True),
                style=discord.TextStyle.paragraph if question.get("long") else discord.TextStyle.short,
                max_length=1024 if question.get("long") else 200,
            )
            self.add_item(item)
            self.fields.append((question["id"], item))

    async def on_submit(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)
        answers = {qid: item.value for qid, item in self.fields}
        await create_ticket(self.bot, interaction, self.form, answers)


class OpenView(discord.ui.View):
    """Кнопки в канале обращений — по одной на форму."""

    def __init__(self, bot):
        super().__init__(timeout=None)

        for form in forms_of(bot):
            self.add_item(
                discord.ui.Button(
                    label=form["buttonLabel"][:40],
                    emoji=form.get("emoji") or None,
                    style=STYLES.get(form.get("buttonStyle"), discord.ButtonStyle.primary),
                    custom_id=f"{OPEN_PREFIX}{form['id']}",
                )
            )


class TicketView(discord.ui.View):
    """Кнопки внутри обращения: «взять» и «закрыть»."""

    def __init__(self, bot, ticket_id: str):
        super().__init__(timeout=None)
        s = settings_of(bot)

        self.add_item(
            discord.ui.Button(
                label=(s.get("claimLabel") or "Взять тикет")[:40],
                style=discord.ButtonStyle.success,
                custom_id=f"{CLAIM_PREFIX}{ticket_id}",
            )
        )
        self.add_item(
            discord.ui.Button(
                label=(s.get("closeLabel") or "Закрыть")[:40],
                style=discord.ButtonStyle.danger,
                custom_id=f"{CLOSE_PREFIX}{ticket_id}",
            )
        )


async def create_ticket(bot, interaction: discord.Interaction, form: dict, answers: dict) -> None:
    """Записать обращение в панель и открыть ветку."""
    channel = interaction.channel
    if isinstance(channel, discord.Thread):
        channel = channel.parent
    if not isinstance(channel, discord.TextChannel):
        await interaction.followup.send("Обращения создаются в текстовом канале.", ephemeral=True)
        return

    # Сначала запись в панели: если ветка не создастся, обращение всё равно видно
    # администрации и не потеряется.
    try:
        created = await bot.panel.post(
            "/tickets",
            {
                "formId": form["id"],
                "discordId": str(interaction.user.id),
                "discordTag": str(interaction.user),
                "guildId": str(interaction.guild_id or ""),
                "channelId": str(channel.id),
                "answers": answers,
            },
        )
    except PanelError as err:
        await interaction.followup.send(str(err), ephemeral=True)
        return

    ticket = created["ticket"]
    settings = created.get("settings") or settings_of(bot)

    try:
        thread = await channel.create_thread(
            name=f"{form.get('emoji') or ''}{ticket['number']}-{interaction.user.display_name}"[:100],
            type=discord.ChannelType.private_thread,
            auto_archive_duration=int(settings.get("autoArchiveMinutes") or 1440),
            reason=f"Обращение №{ticket['number']}",
        )
    except discord.Forbidden:
        await interaction.followup.send(
            "Не хватает прав создать ветку: боту нужны «Создавать приватные ветки» и «Писать в ветках». "
            f"Обращение №{ticket['number']} всё равно записано — администрация его увидит в панели.",
            ephemeral=True,
        )
        return
    except discord.HTTPException as err:
        await interaction.followup.send(
            f"Discord не создал ветку: {err.text or err}. Обращение №{ticket['number']} записано в панели.",
            ephemeral=True,
        )
        return

    try:
        await bot.panel.post(f"/tickets/{ticket['id']}/thread", {"threadId": str(thread.id)})
    except PanelError as err:
        LOG.warning("Ветка не привязана к обращению: %s", err)

    bot.ticket_threads[str(thread.id)] = ticket["id"]
    await thread.add_user(interaction.user)

    # Роли, которые должны видеть обращение: общие плюс роли этой формы.
    mentions: list[str] = []
    for role_id in set((settings.get("staffRoleIds") or []) + (form.get("staffRoleIds") or [])):
        mentions.append(f"<@&{role_id}>")
    for role_id in set((settings.get("viewerRoleIds") or []) + (form.get("viewerRoleIds") or [])):
        mentions.append(f"<@&{role_id}>")

    embed = discord.Embed(title=f"№{ticket['number']} · {form['title']}", colour=0x3FB950)
    for question in form.get("questions", []):
        value = answers.get(question["id"]) or "—"
        embed.add_field(name=question["label"], value=str(value)[:1024], inline=False)
    embed.set_footer(text=f"Автор: {interaction.user} · id {interaction.user.id}")

    await thread.send(
        content=f"{interaction.user.mention} " + " ".join(dict.fromkeys(mentions)),
        embed=embed,
        view=TicketView(bot, ticket["id"]),
    )
    if form["texts"].get("opened"):
        await thread.send(form["texts"]["opened"])

    await bot.log_to_channel(f"✉️ Обращение №{ticket['number']} «{form['title']}» от <@{interaction.user.id}>: {thread.mention}")
    await interaction.followup.send(f"Обращение №{ticket['number']} создано: {thread.mention}", ephemeral=True)


async def claim_ticket(bot, interaction: discord.Interaction, ticket_id: str) -> None:
    await interaction.response.defer(ephemeral=True, thinking=True)

    try:
        data = await bot.panel.get(f"/tickets/{ticket_id}")
    except PanelError as err:
        await interaction.followup.send(str(err), ephemeral=True)
        return

    form = data.get("form") or {}
    if not is_staff(interaction.user, settings_of(bot), form, bot):
        await interaction.followup.send("Брать обращения может только поддержка.", ephemeral=True)
        return

    try:
        await bot.panel.post(
            f"/tickets/{ticket_id}/claim",
            {"staffId": str(interaction.user.id), "staffTag": str(interaction.user)},
        )
    except PanelError as err:
        # Сюда попадает и «уже взял другой» — текст от панели понятный.
        await interaction.followup.send(str(err), ephemeral=True)
        return

    template = (form.get("texts") or {}).get("claimed") or "Обращение взял {staff}."
    await interaction.channel.send(template.replace("{staff}", interaction.user.mention))
    await interaction.followup.send("Обращение за вами.", ephemeral=True)


async def close_ticket(bot, interaction: discord.Interaction, ticket_id: str, reason: str = "") -> None:
    if not interaction.response.is_done():
        await interaction.response.defer(ephemeral=True, thinking=True)

    try:
        data = await bot.panel.get(f"/tickets/{ticket_id}")
    except PanelError as err:
        await interaction.followup.send(str(err), ephemeral=True)
        return

    ticket = data["ticket"]
    form = data.get("form") or {}
    settings = settings_of(bot)

    # Закрыть может автор (вопрос решился) или поддержка (ответила).
    if str(interaction.user.id) != ticket["discordId"] and not is_staff(interaction.user, settings, form, bot):
        await interaction.followup.send("Закрыть обращение может его автор или поддержка.", ephemeral=True)
        return

    try:
        await bot.panel.post(f"/tickets/{ticket_id}/close", {"by": str(interaction.user), "reason": reason})
    except PanelError as err:
        await interaction.followup.send(str(err), ephemeral=True)
        return

    template = (form.get("texts") or {}).get("closed") or "Обращение закрыто."
    await interaction.channel.send(template + (f"\nИтог: {reason}" if reason else ""))
    await bot.log_to_channel(
        f"✅ Обращение №{ticket['number']} закрыто {interaction.user}" + (f": {reason}" if reason else "")
    )
    await interaction.followup.send("Закрыто.", ephemeral=True)

    thread = interaction.channel
    if isinstance(thread, discord.Thread):
        try:
            if settings.get("deleteOnClose"):
                # Переписка уже в панели, поэтому удаление ветки ничего не теряет.
                await thread.delete(reason="Обращение закрыто")
            else:
                await thread.edit(archived=True, locked=True, reason="Обращение закрыто")
        except discord.Forbidden:
            LOG.warning("Нет прав закрыть ветку %s", thread.id)


def setup(bot) -> None:
    # Кнопки должны отвечать и после перезапуска бота: view'ы регистрируются
    # заново при старте, а разбор нажатий идёт по custom_id.
    bot.add_persistent_view(OpenView(bot))

    @bot.event
    async def on_interaction(interaction: discord.Interaction) -> None:
        data = interaction.data or {}
        custom_id = str(data.get("custom_id") or "")

        if custom_id.startswith(OPEN_PREFIX):
            form = form_by_id(bot, custom_id[len(OPEN_PREFIX):])
            if form is None:
                await interaction.response.send_message(
                    "Эта кнопка устарела — форму удалили в панели. Попросите админа обновить панель обращений.",
                    ephemeral=True,
                )
                return

            if form.get("questions"):
                await interaction.response.send_modal(TicketModal(bot, form))
            else:
                # Форма без вопросов: ветку открываем сразу.
                await interaction.response.defer(ephemeral=True, thinking=True)
                await create_ticket(bot, interaction, form, {})
            return

        if custom_id.startswith(CLAIM_PREFIX):
            await claim_ticket(bot, interaction, custom_id[len(CLAIM_PREFIX):])
            return

        if custom_id.startswith(CLOSE_PREFIX):
            await close_ticket(bot, interaction, custom_id[len(CLOSE_PREFIX):])

    @bot.event
    async def on_message(message: discord.Message) -> None:
        """Переписку обращения складываем в панель, чтобы её можно было читать там."""
        if message.author.bot or not isinstance(message.channel, discord.Thread):
            return

        ticket_id = bot.ticket_by_thread(str(message.channel.id))
        if not ticket_id:
            return

        try:
            await bot.panel.post(
                f"/tickets/{ticket_id}/message",
                {"ts": int(message.created_at.timestamp() * 1000), "author": str(message.author),
                 "authorId": str(message.author.id), "text": message.content},
            )
        except PanelError as err:
            LOG.warning("Сообщение обращения не сохранено: %s", err)

    @bot.tree.command(name="tickets-panel", description="Поставить в этом канале кнопки обращений (для админов)")
    @discord.app_commands.default_permissions(administrator=True)
    async def tickets_panel(interaction: discord.Interaction) -> None:
        s = settings_of(bot)
        forms = forms_of(bot)

        if not forms:
            await interaction.response.send_message(
                "В панели нет ни одной формы обращений. Заведите её: вкладка «Обращения» → «Новая форма».",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title=s.get("panelTitle") or "Обращение к администрации",
            description=s.get("panelText") or "",
            colour=0x3FB950,
        )
        for form in forms:
            if form.get("description"):
                embed.add_field(name=f"{form.get('emoji') or ''} {form['title']}", value=form["description"], inline=False)

        await interaction.channel.send(embed=embed, view=OpenView(bot))
        await interaction.response.send_message(
            f"Кнопок поставлено: {len(forms)}. Тексты и кнопки меняются в панели, вкладка «Обращения».",
            ephemeral=True,
        )

    @bot.tree.command(name="close", description="Закрыть обращение (внутри его ветки)")
    @discord.app_commands.describe(reason="Итог, его увидит автор обращения")
    async def close(interaction: discord.Interaction, reason: str = "") -> None:
        ticket_id = bot.ticket_by_thread(str(interaction.channel_id))
        if not ticket_id:
            await interaction.response.send_message("Эту команду нужно вызывать внутри ветки обращения.", ephemeral=True)
            return

        await close_ticket(bot, interaction, ticket_id, reason)

    @bot.tree.command(name="tickets", description="Открытые обращения (для поддержки)")
    @discord.app_commands.default_permissions(administrator=True)
    async def tickets_list(interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            data = await bot.panel.get("/tickets?status=open&limit=25")
            claimed = await bot.panel.get("/tickets?status=claimed&limit=25")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        counts = data.get("counts", {})
        lines = [f"Открытых: {counts.get('open', 0)}, в работе: {counts.get('claimed', 0)}, всего: {counts.get('total', 0)}", ""]

        for item in (data.get("tickets") or []) + (claimed.get("tickets") or []):
            mark = "🆕" if item["status"] == "open" else "🛠"
            who = item.get("claimedByTag") or ""
            link = f"<#{item['threadId']}>" if item.get("threadId") else "(без ветки)"
            lines.append(f"{mark} №{item['number']} {item['formTitle']} — {item['discordTag']} {link}" + (f" · {who}" if who else ""))

        await interaction.followup.send("\n".join(lines)[:1900] or "Обращений нет.", ephemeral=True)
