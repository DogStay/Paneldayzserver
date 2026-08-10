"""
Фракции (группы GroupSpawner).

Состав читается прямо из `GroupSpawner.json` сервера через панель: файл и есть
истина. У прежнего бота список хранился отдельно и расходился с файлом — отсюда
были «я во фракции, а на сервере нет».

Вступление идёт той же очередью прописки, что и верификация: заявка ложится на
диск и панель допишет её сама, даже если файл занят сервером.
"""

from __future__ import annotations

import discord
from discord import app_commands

from panel import PanelError


async def groups_of(bot) -> list[dict]:
    """Плоский список фракций со всех файлов формата group-spawner."""
    data = await bot.panel.get("/roster/groups")
    out: list[dict] = []

    for file in data.get("files", []):
        if file.get("error"):
            raise PanelError(f"{file.get('title')}: {file['error']}")
        for group in file.get("groups", []):
            out.append({"file": file.get("title"), "name": group.get("name", ""), "members": group.get("members", [])})

    return out


def setup(bot) -> None:
    @bot.tree.command(name="groups", description="Список фракций и сколько в них людей")
    async def groups(interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            found = await groups_of(bot)
        except PanelError as err:
            await interaction.followup.send(f"Не прочитал фракции: {err}", ephemeral=True)
            return

        if not found:
            await interaction.followup.send(
                "Фракций нет. Они берутся из файла GroupSpawner.json — добавьте его в мастере настройки "
                "панели, раздел «Прописка игроков», формат «GroupSpawner».",
                ephemeral=True,
            )
            return

        lines = [f"• **{g['name']}** — {len(g['members'])} чел." for g in found]
        await interaction.followup.send("\n".join(lines)[:1900], ephemeral=True)

    @bot.tree.command(name="group-members", description="Кто во фракции")
    @app_commands.describe(name="Название фракции")
    async def group_members(interaction: discord.Interaction, name: str) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            found = await groups_of(bot)
        except PanelError as err:
            await interaction.followup.send(f"Не прочитал фракции: {err}", ephemeral=True)
            return

        group = next((g for g in found if g["name"].lower() == name.strip().lower()), None)
        if group is None:
            await interaction.followup.send(f"Фракции «{name}» нет. Список — /groups.", ephemeral=True)
            return

        if not group["members"]:
            await interaction.followup.send(f"Во фракции «{group['name']}» пока никого.", ephemeral=True)
            return

        lines = [f"• {m.get('name') or m.get('steamId')}" for m in group["members"][:60]]
        await interaction.followup.send(f"**{group['name']}** ({len(group['members'])}):\n" + "\n".join(lines), ephemeral=True)

    @bot.tree.command(name="group-add", description="Вписать игрока во фракцию (для админов)")
    @app_commands.describe(member="Кого", name="Название фракции")
    @app_commands.default_permissions(administrator=True)
    async def group_add(interaction: discord.Interaction, member: discord.Member, name: str) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        # Фракция пишется по подтверждённому Steam: иначе в файл уйдёт чужой id.
        try:
            link = await bot.panel.get(f"/verify/status?discordId={member.id}")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        if not link.get("verified"):
            await interaction.followup.send(
                f"{member.mention} ещё не подтвердил Steam — сначала /verify. Без этого во фракцию писать нечего.",
                ephemeral=True,
            )
            return

        try:
            found = await groups_of(bot)
            if not any(g["name"].lower() == name.strip().lower() for g in found):
                await interaction.followup.send(f"Фракции «{name}» нет в GroupSpawner.json. Список — /groups.", ephemeral=True)
                return

            await bot.panel.post(
                "/roster/add",
                {
                    "steamId": link.get("steamId"),
                    "name": link.get("nickname") or member.display_name,
                    "discordId": str(member.id),
                    "group": name.strip(),
                },
            )
        except PanelError as err:
            await interaction.followup.send(f"Не получилось: {err}", ephemeral=True)
            return

        await bot.log_to_channel(f"🛡 {interaction.user} вписал <@{member.id}> во фракцию «{name.strip()}»")
        await interaction.followup.send(
            f"{member.mention} поставлен в очередь на запись во фракцию «{name.strip()}». "
            "Панель допишет его в файл сама — проверить можно командой /group-members.",
            ephemeral=True,
        )
