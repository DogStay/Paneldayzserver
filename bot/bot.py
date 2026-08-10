"""
Discord-бот панели: верификация и автоматическая прописка на сервер.

Главное отличие от «обычного» бота верификации: бот **ничего не решает сам** и
ничего не хранит. Единственная истина — панель:

  * настройки (токен бота, ID сервера Discord, роль, канал журнала) бот берёт у
    панели по API (`GET /api/bot/config`). Локально нужны только адрес панели и
    API-токен, поэтому настройки не расходятся между ботом и панелью;
  * связку Discord ↔ Steam доказывает Steam (OpenID) на стороне панели, а не
    поле ввода в Discord;
  * прописку в файлы сервера делает панель через очередь на диске с повторами.
    Поэтому «человек пришёл, а его не прописало» невозможно даже если бот в этот
    момент лежал: заявка уже в очереди, панель допишет её сама.

Бот только выдаёт роль и пишет в журнал. Если он падал — при запуске он
спрашивает панель `GET /api/verify/pending` и догоняет пропущенных.

Запуск:
    pip install -r requirements.txt
    python bot.py

Настройка (файл .env рядом с ботом или переменные окружения):
    PANEL_URL=http://127.0.0.1:8787
    PANEL_TOKEN=dzp_...        # токен с правами admin из «Настройки → API-токены»
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import aiohttp
import discord
from discord import app_commands

LOG = logging.getLogger("panelbot")

# Как часто догонять пропущенных. Обычно роль выдаётся сразу по событию из
# панели, этот цикл — страховка на случай, если бот был offline.
CATCHUP_SECONDS = 30


def load_env() -> None:
    """Простой .env без зависимостей: строки ключ=значение."""
    env_file = Path(__file__).with_name(".env")
    if not env_file.exists():
        return

    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


class Panel:
    """Тонкий клиент панели. Все ошибки — с человеческим текстом."""

    def __init__(self, base_url: str, token: str):
        self.base = base_url.rstrip("/")
        self.token = token
        self.session: aiohttp.ClientSession | None = None

    async def open(self) -> None:
        self.session = aiohttp.ClientSession(headers={"Authorization": f"Bearer {self.token}"})

    async def close(self) -> None:
        if self.session:
            await self.session.close()

    async def call(self, method: str, path: str, payload: dict | None = None) -> dict:
        assert self.session, "клиент панели не открыт"
        url = f"{self.base}/api{path}"

        try:
            async with self.session.request(method, url, json=payload) as res:
                text = await res.text()
                try:
                    data = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    raise RuntimeError(f"панель ответила не JSON ({res.status})")

                if res.status >= 400:
                    raise RuntimeError(data.get("error") or f"панель ответила {res.status}")
                return data
        except aiohttp.ClientConnectorError:
            raise RuntimeError(f"панель недоступна по адресу {self.base} — запущена ли она?")


class PanelBot(discord.Client):
    def __init__(self, panel: Panel, settings: dict):
        super().__init__(intents=self._intents())
        self.panel = panel
        self.settings = settings
        self.tree = app_commands.CommandTree(self)
        self._catchup_task: asyncio.Task | None = None

    @staticmethod
    def _intents() -> discord.Intents:
        # Нужны участники: без этого нельзя выдать роль по id.
        intents = discord.Intents.default()
        intents.members = True
        return intents

    async def setup_hook(self) -> None:
        guild_id = self.settings.get("guildId")
        if guild_id:
            # Команды на одном сервере появляются сразу, глобальные — до часа.
            guild = discord.Object(id=int(guild_id))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

        self._catchup_task = self.loop.create_task(self.catchup_loop())

    async def on_ready(self) -> None:
        LOG.info("Бот вошёл как %s. Сервер панели: %s", self.user, self.settings.get("serverName") or "?")

    # ------------------------------------------------------------- выдача роли

    async def grant(self, discord_id: str, steam_id: str, nickname: str) -> str:
        """Выдать роль и написать в журнал. Возвращает, что получилось."""
        guild_id = self.settings.get("guildId")
        role_id = self.settings.get("verifiedRoleId")
        if not guild_id:
            return "не задан ID сервера Discord в настройках панели"

        guild = self.get_guild(int(guild_id))
        if guild is None:
            return f"бот не состоит на сервере {guild_id}"

        try:
            member = guild.get_member(int(discord_id)) or await guild.fetch_member(int(discord_id))
        except discord.NotFound:
            return f"участник {discord_id} не найден на сервере"

        done = []
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
                    # Классическая причина: роль бота ниже выдаваемой.
                    done.append("нет прав выдать роль — поднимите роль бота выше выдаваемой")

        if nickname:
            try:
                await member.edit(nick=nickname[:32], reason="Ник из Steam")
                done.append("ник из Steam")
            except discord.Forbidden:
                done.append("ник не сменён (нет прав)")

        await self.log_to_channel(f"✅ <@{discord_id}> подтвердил Steam `{steam_id}`" + (f" ({nickname})" if nickname else "")
                                  + f" — {', '.join(done) if done else 'без изменений'}")

        # Панель может забыть эту верификацию: роль выдана.
        try:
            await self.panel.call("POST", "/verify/ack", {"discordId": discord_id})
        except RuntimeError as err:
            LOG.warning("Не удалось отметить выдачу роли в панели: %s", err)

        return ", ".join(done) if done else "изменений не потребовалось"

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

    # --------------------------------------------------------------- догонялка

    async def catchup_loop(self) -> None:
        """Кому панель уже подтвердила Steam, а роли ещё нет."""
        await self.wait_until_ready()

        while not self.is_closed():
            try:
                data = await self.panel.call("GET", "/verify/pending")
                for item in data.get("pending", []):
                    LOG.info("Догоняю верификацию %s", item.get("discordId"))
                    await self.grant(item.get("discordId", ""), item.get("steamId", ""), item.get("nickname", ""))
            except RuntimeError as err:
                LOG.warning("Панель не ответила: %s", err)

            await asyncio.sleep(CATCHUP_SECONDS)


def build(panel: Panel, settings: dict) -> PanelBot:
    bot = PanelBot(panel, settings)

    @bot.tree.command(name="verify", description="Подтвердить Steam и прописаться на сервере")
    async def verify(interaction: discord.Interaction) -> None:
        # Ответ только этому человеку: ссылка личная, по ней привязывается Steam
        # именно к его Discord.
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            existing = await panel.call("GET", f"/verify/status?discordId={interaction.user.id}")
        except RuntimeError as err:
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
            link = await panel.call(
                "POST",
                "/verify/start",
                {"discordId": str(interaction.user.id), "discordTag": str(interaction.user), "guildId": str(interaction.guild_id or "")},
            )
        except RuntimeError as err:
            await interaction.followup.send(f"Не удалось начать проверку: {err}", ephemeral=True)
            return

        minutes = max(1, int(link.get("ttlSeconds", 900)) // 60)
        await interaction.followup.send(
            f"Откройте ссылку и войдите через Steam — пароль вводится на сайте Steam, "
            f"ни бот, ни панель его не видят:\n{link['url']}\n"
            f"Ссылка личная и действует {minutes} мин. После входа вас прописывает панель, роль выдам я.",
            ephemeral=True,
        )

    @bot.tree.command(name="status", description="Проверить, прописан ли игрок")
    @app_commands.describe(member="Кого проверить (по умолчанию — себя)")
    async def status(interaction: discord.Interaction, member: discord.Member | None = None) -> None:
        who = member or interaction.user
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            data = await panel.call("GET", f"/verify/status?discordId={who.id}")
        except RuntimeError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        if not data.get("verified"):
            await interaction.followup.send(f"{who.mention}: верификации нет. Команда /verify.", ephemeral=True)
            return

        targets = data.get("roster") or []
        lines = [f"Steam: `{data.get('steamId')}`", f"Ник: {data.get('nickname') or '—'}"]
        lines += [f"{'✅' if t.get('present') else '⏳'} {t.get('title')}" for t in targets]
        await interaction.followup.send("\n".join(lines), ephemeral=True)

    @bot.tree.command(name="whitelist", description="Прописать игрока вручную (для админов)")
    @app_commands.describe(member="Кому", steam_id="steamId64 из 17 цифр")
    @app_commands.default_permissions(administrator=True)
    async def whitelist(interaction: discord.Interaction, member: discord.Member, steam_id: str) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            await panel.call(
                "POST",
                "/verify/link",
                {"discordId": str(member.id), "steamId": steam_id.strip(), "nickname": member.display_name},
            )
        except RuntimeError as err:
            await interaction.followup.send(f"Не получилось: {err}", ephemeral=True)
            return

        result = await bot.grant(str(member.id), steam_id.strip(), member.display_name)
        await interaction.followup.send(f"{member.mention} прописан вручную. {result}", ephemeral=True)

    return bot


async def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    load_env()

    panel_url = os.environ.get("PANEL_URL", "http://127.0.0.1:8787")
    panel_token = os.environ.get("PANEL_TOKEN", "")
    if not panel_token:
        print("Не задан PANEL_TOKEN. Возьмите API-токен с правами admin в панели:\n"
              "  Настройки → Аккаунты и права → API-токены\n"
              "и положите его в файл bot/.env строкой PANEL_TOKEN=dzp_…")
        return 2

    panel = Panel(panel_url, panel_token)
    await panel.open()

    try:
        settings = await panel.call("GET", "/bot/config")
    except RuntimeError as err:
        print(f"Не удалось получить настройки из панели: {err}")
        await panel.close()
        return 2

    token = settings.get("botToken") or os.environ.get("DISCORD_TOKEN", "")
    if not token:
        print("В панели не задан токен бота. Откройте на машине с панелью\n"
              f"  {panel_url}/setup.html  →  раздел «Discord»  →  «Токен бота»")
        await panel.close()
        return 2

    bot = build(panel, settings)
    try:
        await bot.start(token)
    except discord.LoginFailure:
        print("Discord не принял токен бота. Проверьте его в мастере настройки панели "
              "(Discord → Bot → Reset Token).")
        return 2
    finally:
        await panel.close()

    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
