"""
Админка трейдера MAODev Trade System в Discord.

Перенос `trader_manager.py` прежнего бота: та же интерактивная панель с
страницами, те же действия. Отличие одно и оно принципиальное — файлы правит не
бот, а панель (`/api/trader/*`). Причины:

  * файлы торговца лежат рядом с сервером, а бот может стоять на другой машине;
  * панель делает копию перед каждой правкой и проверяет правила (нулевое
    количество, занятый classname, назначенная категория), поэтому одни и те же
    ограничения действуют и из Discord, и из панели, и с сайта;
  * каждая правка попадает в общий журнал событий панели.

Страницы панели: главная -> категории -> товары, отдельно торговцы (назначение
категорий) и проверка файлов.
"""

from __future__ import annotations

import logging

import discord
from discord import app_commands

from panel import PanelError

LOG = logging.getLogger("panelbot.trader")

# Discord показывает в одном выпадающем списке не больше 25 пунктов.
PAGE = 25

STYLES = {
    "primary": discord.ButtonStyle.primary,
    "secondary": discord.ButtonStyle.secondary,
    "success": discord.ButtonStyle.success,
    "danger": discord.ButtonStyle.danger,
}


def can_manage(member: discord.Member, bot) -> bool:
    """Админ Discord, роль админов панели или роль управляющего трейдером."""
    if member.guild_permissions.administrator:
        return True

    allowed = {str(r) for r in (bot.settings.get("traderRoleIds") or [])}
    if bot.settings.get("adminRoleId"):
        allowed.add(str(bot.settings["adminRoleId"]))

    return any(str(role.id) in allowed for role in member.roles)


def page_window(items: list, page: int) -> tuple[list, int, int]:
    """Кусок списка для страницы плюс номер страницы и их общее число."""
    total = max(1, (len(items) + PAGE - 1) // PAGE)
    current = min(max(page, 0), total - 1)
    return items[current * PAGE:(current + 1) * PAGE], current, total


def price(value) -> str:
    """-1 у мода означает «нельзя купить/продать», а не «цена минус один»."""
    number = int(value)
    return "нельзя" if number < 0 else str(number)


def stock(value) -> str:
    number = int(value)
    return "∞" if number < 0 else str(number)


class TraderAdminView(discord.ui.View):
    """Интерактивная админка. Живёт 30 минут, как в прежнем боте."""

    def __init__(self, bot, author_id: int, data: dict):
        super().__init__(timeout=1800)
        self.bot = bot
        self.author_id = author_id
        self.data = data                 # ответ GET /api/trader
        self.kind = "trader"
        self.page_name = "main"
        self.category: str | None = None
        self.products: list[dict] = []
        self.product_index: int | None = None
        self.trader_id: str | None = None
        self.category_page = 0
        self.product_page = 0
        self.message: discord.Message | None = None
        self.rebuild()

    # ---------------------------------------------------------------- доступ

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message("Эта админка открыта другим человеком.", ephemeral=True)
            return False

        if not isinstance(interaction.user, discord.Member) or not can_manage(interaction.user, self.bot):
            await interaction.response.send_message("Доступ к админке трейдера убрали.", ephemeral=True)
            return False

        return True

    async def on_timeout(self) -> None:
        for item in self.children:
            item.disabled = True
        if self.message is not None:
            try:
                await self.message.edit(view=self)
            except discord.HTTPException:
                pass

    # -------------------------------------------------------------- данные

    def categories(self) -> list[dict]:
        return (self.data.get("categories") or {}).get(self.kind) or []

    async def reload(self) -> None:
        self.data = await self.bot.panel.get("/trader")
        if self.category:
            await self.reload_products()

    async def reload_products(self) -> None:
        try:
            answer = await self.bot.panel.get(f"/trader/products?category={self.category}&kind={self.kind}")
            self.products = answer.get("products") or []
        except PanelError as err:
            LOG.warning("Товары не прочитаны: %s", err)
            self.products = []

    async def refresh(self, interaction: discord.Interaction, note: str = "") -> None:
        """Перечитать данные из панели и перерисовать сообщение."""
        try:
            await self.reload()
        except PanelError as err:
            note = f"{note}\nПанель: {err}".strip()

        self.rebuild()
        if interaction.response.is_done():
            await interaction.edit_original_response(embed=self.embed(note), view=self)
        else:
            await interaction.response.edit_message(embed=self.embed(note), view=self)

    # ------------------------------------------------------------- разметка

    def embed(self, note: str = "") -> discord.Embed:
        if not self.data.get("ok"):
            embed = discord.Embed(title="Трейдер недоступен", colour=0xE5484D,
                                  description=self.data.get("reason") or "панель не нашла файлы торговца")
            embed.add_field(name="Что сделать",
                            value="Укажите папку Trade System в настройках сервера панели "
                                  "(«Настройки сервера» или мастер настройки).", inline=False)
            return embed

        embed = discord.Embed(title="Админка трейдера", colour=0x3FB950)
        embed.description = f"Тип категорий: **{'бартер' if self.kind == 'barter' else 'продажа'}**"

        if self.page_name == "main":
            traders = self.data.get("traders") or []
            trader_cats = len((self.data.get("categories") or {}).get("trader") or [])
            barter_cats = len((self.data.get("categories") or {}).get("barter") or [])

            embed.add_field(name="Торговцев", value=str(len(traders)), inline=True)
            embed.add_field(name="Категорий", value=f"продажа {trader_cats}, бартер {barter_cats}", inline=True)
            embed.add_field(name="Валюты",
                            value=", ".join(c["currencyId"] for c in self.data.get("currencies") or []) or "—",
                            inline=True)

            issues = self.data.get("issues") or []
            embed.add_field(
                name="Проверка файлов",
                value="✅ поломок нет" if not issues else "⚠️ " + "\n".join(f"• {i}" for i in issues[:5])[:900],
                inline=False,
            )
            embed.add_field(name="Папка", value=f"`{self.data.get('path')}`", inline=False)

        elif self.page_name == "categories":
            items, current, total = page_window(self.categories(), self.category_page)
            lines = [
                f"**{c['id']}** — {c['name'] or 'без названия'} · товаров {c['products']}"
                + (f" · у NPC: {', '.join(c['traders'])}" if c["traders"] else "")
                + (f" · ⚠️ {c['error']}" if c.get("error") else "")
                for c in items
            ]
            embed.add_field(name=f"Категории ({current + 1}/{total})", value="\n".join(lines) or "категорий нет", inline=False)

        elif self.page_name == "products":
            items, current, total = page_window(self.products, self.product_page)
            if self.kind == "barter":
                lines = [f"`#{p['index'] + 1}` {', '.join(p['received']) or '—'} ← {', '.join(p['required']) or '—'}" for p in items]
            else:
                lines = [
                    f"`#{p['index'] + 1}` **{p['classname']}** · покупка {price(p['buyPrice'])} · продажа {price(p['sellPrice'])}"
                    f" · склад {stock(p['count'])}" + (" · скрыт" if p["hidden"] else "")
                    for p in items
                ]
            embed.add_field(name=f"«{self.category}» ({current + 1}/{total})", value="\n".join(lines)[:1000] or "товаров нет", inline=False)

            if self.product_index is not None:
                chosen = next((p for p in self.products if p["index"] == self.product_index), None)
                if chosen and self.kind == "trader":
                    embed.add_field(
                        name="Выбран",
                        value=f"**{chosen['classname']}**\nпокупка {price(chosen['buyPrice'])}, продажа {price(chosen['sellPrice'])}, "
                              f"quantity_buy {chosen['quantityBuy']}, quantity_sell {chosen['quantitySell']}, "
                              f"склад {stock(chosen['count'])}, {'скрыт' if chosen['hidden'] else 'виден'}",
                        inline=False,
                    )

        elif self.page_name == "traders":
            lines = [
                f"**{t['traderId']}** · режим `{t['mode']}` · валюта `{t['currencyId'] or '—'}`\n"
                f"продажа: {', '.join(t['categoriesTrader']) or '—'}\nбартер: {', '.join(t['categoriesBarter']) or '—'}"
                for t in (self.data.get("traders") or [])
            ]
            embed.add_field(name="Торговцы", value="\n\n".join(lines)[:1000] or "торговцев нет", inline=False)

        if note:
            embed.add_field(name="Последнее действие", value=note[:1000], inline=False)

        embed.set_footer(text="Каждая правка сохраняется в файлы сервера, копия делается автоматически")
        return embed

    def rebuild(self) -> None:
        self.clear_items()

        if not self.data.get("ok"):
            self.add_item(NavButton("Обновить", "secondary", self.go_refresh, row=0))
            return

        if self.page_name == "main":
            self.add_item(KindSelect(self))
            self.add_item(NavButton("Категории", "primary", self.go_categories, row=1))
            self.add_item(NavButton("Торговцы", "primary", self.go_traders, row=1))
            self.add_item(NavButton("Проверить файлы", "secondary", self.go_validate, row=1))
            self.add_item(NavButton("Копия всех файлов", "secondary", self.go_backup, row=2))
            self.add_item(NavButton("Обновить", "secondary", self.go_refresh, row=2))

        elif self.page_name == "categories":
            if self.categories():
                self.add_item(CategorySelect(self))
            self.add_item(NavButton("Новая категория", "success", self.go_create_category, row=1))
            if self.category:
                self.add_item(NavButton("Товары", "primary", self.go_products, row=1))
                self.add_item(NavButton("Удалить категорию", "danger", self.go_delete_category, row=1))
            self.add_page_buttons("category", len(self.categories()), row=2)
            self.add_item(NavButton("Назад", "secondary", self.go_main, row=3))

        elif self.page_name == "products":
            if self.products:
                self.add_item(ProductSelect(self))
            if self.kind == "trader":
                self.add_item(NavButton("Добавить товар", "success", self.go_add_product, row=1))
                if self.product_index is not None:
                    self.add_item(NavButton("Изменить", "primary", self.go_edit_product, row=1))
                    self.add_item(NavButton("Склад", "secondary", self.go_edit_stock, row=1))
                    self.add_item(NavButton("Скрыть/показать", "secondary", self.go_toggle_hidden, row=2))
                    self.add_item(NavButton("Удалить товар", "danger", self.go_delete_product, row=2))
            elif self.product_index is not None:
                self.add_item(NavButton("Удалить рецепт", "danger", self.go_delete_product, row=1))

            self.add_page_buttons("product", len(self.products), row=3)
            self.add_item(NavButton("К категориям", "secondary", self.go_categories, row=4))

        elif self.page_name == "traders":
            if self.data.get("traders"):
                self.add_item(TraderSelect(self))
            if self.trader_id:
                self.add_item(AssignSelect(self))
                self.add_item(UnassignSelect(self))
            self.add_item(NavButton("Назад", "secondary", self.go_main, row=4))

    def add_page_buttons(self, target: str, total: int, row: int) -> None:
        if total <= PAGE:
            return
        self.add_item(PageButton("◀", target, -1, self, row=row))
        self.add_item(PageButton("▶", target, +1, self, row=row))

    # ------------------------------------------------------------ переходы

    async def go_main(self, interaction):
        self.page_name = "main"
        await self.refresh(interaction)

    async def go_refresh(self, interaction):
        await self.refresh(interaction, "данные перечитаны")

    async def go_categories(self, interaction):
        self.page_name = "categories"
        self.product_index = None
        await self.refresh(interaction)

    async def go_products(self, interaction):
        if not self.category:
            await interaction.response.send_message("Сначала выберите категорию.", ephemeral=True)
            return
        self.page_name = "products"
        self.product_index = None
        self.product_page = 0
        await self.reload_products()
        await self.refresh(interaction)

    async def go_traders(self, interaction):
        self.page_name = "traders"
        await self.refresh(interaction)

    async def go_validate(self, interaction):
        try:
            answer = await self.bot.panel.get("/trader/validate")
        except PanelError as err:
            await interaction.response.send_message(f"Не проверилось: {err}", ephemeral=True)
            return

        issues = answer.get("issues") or []
        text = "✅ Поломок не найдено." if not issues else "⚠️ Найдено:\n" + "\n".join(f"• {i}" for i in issues[:25])
        await interaction.response.send_message(text[:1900], ephemeral=True)

    async def go_backup(self, interaction):
        try:
            answer = await self.bot.panel.post("/trader/backup", {})
        except PanelError as err:
            await interaction.response.send_message(f"Копия не сделана: {err}", ephemeral=True)
            return

        await self.bot.log_to_channel(f"🗄 {interaction.user} сделал полную копию файлов трейдера")
        await interaction.response.send_message(f"Копия здесь:\n`{answer.get('path')}`", ephemeral=True)

    # ------------------------------------------------------------ действия

    async def go_create_category(self, interaction):
        await interaction.response.send_modal(CreateCategoryModal(self))

    async def go_delete_category(self, interaction):
        try:
            await self.bot.panel.post("/trader/categories/delete", {"id": self.category, "kind": self.kind})
        except PanelError as err:
            await interaction.response.send_message(f"Не удалено: {err}", ephemeral=True)
            return

        await self.bot.log_to_channel(f"🗑 {interaction.user} удалил категорию `{self.category}` ({self.kind})")
        note = f"категория «{self.category}» удалена"
        self.category = None
        await self.refresh(interaction, note)

    async def go_add_product(self, interaction):
        await interaction.response.send_modal(AddProductModal(self))

    async def go_edit_product(self, interaction):
        chosen = next((p for p in self.products if p["index"] == self.product_index), None)
        if chosen is None:
            await interaction.response.send_message("Товар не выбран.", ephemeral=True)
            return
        await interaction.response.send_modal(EditProductModal(self, chosen))

    async def go_edit_stock(self, interaction):
        chosen = next((p for p in self.products if p["index"] == self.product_index), None)
        if chosen is None:
            await interaction.response.send_message("Товар не выбран.", ephemeral=True)
            return
        await interaction.response.send_modal(StockModal(self, chosen))

    async def go_toggle_hidden(self, interaction):
        chosen = next((p for p in self.products if p["index"] == self.product_index), None)
        if chosen is None:
            await interaction.response.send_message("Товар не выбран.", ephemeral=True)
            return

        try:
            await self.bot.panel.post(
                "/trader/products/update",
                {"category": self.category, "kind": self.kind, "index": chosen["index"], "hidden": 0 if chosen["hidden"] else 1},
            )
        except PanelError as err:
            await interaction.response.send_message(f"Не изменилось: {err}", ephemeral=True)
            return

        await self.reload_products()
        await self.refresh(interaction, f"{chosen['classname']}: {'показан' if chosen['hidden'] else 'скрыт'}")

    async def go_delete_product(self, interaction):
        chosen = next((p for p in self.products if p["index"] == self.product_index), None)
        if chosen is None:
            await interaction.response.send_message("Ничего не выбрано.", ephemeral=True)
            return

        try:
            answer = await self.bot.panel.post(
                "/trader/products/delete",
                {"category": self.category, "kind": self.kind, "index": chosen["index"]},
            )
        except PanelError as err:
            await interaction.response.send_message(f"Не удалено: {err}", ephemeral=True)
            return

        await self.bot.log_to_channel(f"🗑 {interaction.user} удалил `{answer.get('deleted')}` из `{self.category}`")
        self.product_index = None
        await self.reload_products()
        await self.refresh(interaction, f"удалено: {answer.get('deleted')}")


# --------------------------------------------------------------- элементы

class NavButton(discord.ui.Button):
    def __init__(self, label: str, style: str, handler, *, row: int = 0):
        super().__init__(label=label, style=STYLES.get(style, discord.ButtonStyle.secondary), row=row)
        self.handler = handler

    async def callback(self, interaction: discord.Interaction) -> None:
        await self.handler(interaction)


class PageButton(discord.ui.Button):
    def __init__(self, label: str, target: str, delta: int, view: TraderAdminView, *, row: int = 0):
        super().__init__(label=label, style=discord.ButtonStyle.secondary, row=row)
        self.target = target
        self.delta = delta
        self.owner = view

    async def callback(self, interaction: discord.Interaction) -> None:
        attribute = f"{self.target}_page"
        setattr(self.owner, attribute, max(0, getattr(self.owner, attribute) + self.delta))
        await self.owner.refresh(interaction)


class KindSelect(discord.ui.Select):
    def __init__(self, view: TraderAdminView):
        super().__init__(
            placeholder="Тип категорий",
            options=[
                discord.SelectOption(label="Продажа (trader)", value="trader", default=view.kind == "trader"),
                discord.SelectOption(label="Бартер (barter)", value="barter", default=view.kind == "barter"),
            ],
            row=0,
        )
        self.owner = view

    async def callback(self, interaction: discord.Interaction) -> None:
        self.owner.kind = self.values[0]
        self.owner.category = None
        self.owner.product_index = None
        await self.owner.refresh(interaction)


class CategorySelect(discord.ui.Select):
    def __init__(self, view: TraderAdminView):
        items, _, _ = page_window(view.categories(), view.category_page)
        super().__init__(
            placeholder="Категория",
            options=[
                discord.SelectOption(
                    label=item["id"][:100],
                    description=(item["name"] or "без названия")[:100],
                    value=item["id"],
                    default=item["id"] == view.category,
                )
                for item in items
            ] or [discord.SelectOption(label="нет категорий", value="-")],
            row=0,
        )
        self.owner = view

    async def callback(self, interaction: discord.Interaction) -> None:
        if self.values[0] == "-":
            await interaction.response.defer()
            return

        self.owner.category = self.values[0]
        self.owner.product_index = None
        await self.owner.refresh(interaction)


class ProductSelect(discord.ui.Select):
    def __init__(self, view: TraderAdminView):
        items, _, _ = page_window(view.products, view.product_page)

        options = []
        for item in items:
            if view.kind == "barter":
                label = ", ".join(item["received"]) or f"рецепт #{item['index'] + 1}"
                description = "за " + (", ".join(item["required"]) or "—")
            else:
                label = item["classname"] or f"товар #{item['index'] + 1}"
                description = f"покупка {price(item['buyPrice'])}, продажа {price(item['sellPrice'])}"

            options.append(
                discord.SelectOption(
                    label=label[:100],
                    description=description[:100],
                    value=str(item["index"]),
                    default=item["index"] == view.product_index,
                )
            )

        super().__init__(placeholder="Товар", options=options or [discord.SelectOption(label="пусто", value="-")], row=0)
        self.owner = view

    async def callback(self, interaction: discord.Interaction) -> None:
        if self.values[0] == "-":
            await interaction.response.defer()
            return

        self.owner.product_index = int(self.values[0])
        await self.owner.refresh(interaction)


class TraderSelect(discord.ui.Select):
    def __init__(self, view: TraderAdminView):
        traders = view.data.get("traders") or []
        super().__init__(
            placeholder="Торговец",
            options=[
                discord.SelectOption(
                    label=t["traderId"][:100],
                    description=f"режим {t['mode']}, валюта {t['currencyId'] or '—'}"[:100],
                    value=t["traderId"],
                    default=t["traderId"] == view.trader_id,
                )
                for t in traders[:PAGE]
            ] or [discord.SelectOption(label="нет торговцев", value="-")],
            row=0,
        )
        self.owner = view

    async def callback(self, interaction: discord.Interaction) -> None:
        if self.values[0] == "-":
            await interaction.response.defer()
            return

        self.owner.trader_id = self.values[0]
        await self.owner.refresh(interaction)


class AssignSelect(discord.ui.Select):
    """Назначить категорию выбранному торговцу — только те, которых у него нет."""

    def __init__(self, view: TraderAdminView):
        trader = next((t for t in (view.data.get("traders") or []) if t["traderId"] == view.trader_id), {})
        assigned = {c.lower() for c in (trader.get("categoriesBarter") if view.kind == "barter" else trader.get("categoriesTrader")) or []}
        free = [c for c in view.categories() if c["id"].lower() not in assigned]

        super().__init__(
            placeholder=f"Назначить категорию ({'бартер' if view.kind == 'barter' else 'продажа'})",
            options=[discord.SelectOption(label=c["id"][:100], value=c["id"]) for c in free[:PAGE]]
            or [discord.SelectOption(label="нечего назначать", value="-")],
            row=1,
        )
        self.owner = view

    async def callback(self, interaction: discord.Interaction) -> None:
        if self.values[0] == "-":
            await interaction.response.defer()
            return

        try:
            await self.owner.bot.panel.post(
                "/trader/assign",
                {"traderId": self.owner.trader_id, "category": self.values[0], "kind": self.owner.kind},
            )
        except PanelError as err:
            # Сюда попадает и «режим торговца не поддерживает этот тип».
            await interaction.response.send_message(f"Не назначено: {err}", ephemeral=True)
            return

        await self.owner.bot.log_to_channel(
            f"🏷 {interaction.user} назначил `{self.values[0]}` торговцу `{self.owner.trader_id}`"
        )
        await self.owner.refresh(interaction, f"«{self.values[0]}» назначена {self.owner.trader_id}")


class UnassignSelect(discord.ui.Select):
    def __init__(self, view: TraderAdminView):
        trader = next((t for t in (view.data.get("traders") or []) if t["traderId"] == view.trader_id), {})
        assigned = (trader.get("categoriesBarter") if view.kind == "barter" else trader.get("categoriesTrader")) or []

        super().__init__(
            placeholder="Снять категорию",
            options=[discord.SelectOption(label=c[:100], value=c) for c in assigned[:PAGE]]
            or [discord.SelectOption(label="нечего снимать", value="-")],
            row=2,
        )
        self.owner = view

    async def callback(self, interaction: discord.Interaction) -> None:
        if self.values[0] == "-":
            await interaction.response.defer()
            return

        try:
            await self.owner.bot.panel.post(
                "/trader/unassign",
                {"traderId": self.owner.trader_id, "category": self.values[0], "kind": self.owner.kind},
            )
        except PanelError as err:
            await interaction.response.send_message(f"Не снято: {err}", ephemeral=True)
            return

        await self.owner.bot.log_to_channel(
            f"🏷 {interaction.user} снял `{self.values[0]}` с торговца `{self.owner.trader_id}`"
        )
        await self.owner.refresh(interaction, f"«{self.values[0]}» снята с {self.owner.trader_id}")


# ----------------------------------------------------------------- окна

class CreateCategoryModal(discord.ui.Modal, title="Новая категория"):
    category_id = discord.ui.TextInput(label="id (он же имя файла)", max_length=60)
    name = discord.ui.TextInput(label="Название для игрока", max_length=80, required=False)

    def __init__(self, view: TraderAdminView):
        super().__init__()
        self.owner = view

    async def on_submit(self, interaction: discord.Interaction) -> None:
        try:
            await self.owner.bot.panel.post(
                "/trader/categories",
                {"id": self.category_id.value.strip(), "name": self.name.value.strip(), "kind": self.owner.kind},
            )
        except PanelError as err:
            await interaction.response.send_message(f"Не создано: {err}", ephemeral=True)
            return

        self.owner.category = self.category_id.value.strip()
        await self.owner.bot.log_to_channel(f"➕ {interaction.user} создал категорию `{self.owner.category}` ({self.owner.kind})")
        await self.owner.refresh(interaction, f"категория «{self.owner.category}» создана")


class AddProductModal(discord.ui.Modal, title="Добавить товар"):
    classname = discord.ui.TextInput(label="Classname", max_length=120)
    buy_price = discord.ui.TextInput(label="Цена покупки (-1 — нельзя купить)", default="-1", max_length=20)
    sell_price = discord.ui.TextInput(label="Цена продажи (-1 — нельзя продать)", default="-1", max_length=20)
    quantity_buy = discord.ui.TextInput(label="quantity_buy (0 нельзя)", default="-1", max_length=20)
    quantity_sell = discord.ui.TextInput(label="quantity_sell (0 нельзя)", default="-3", max_length=20)

    def __init__(self, view: TraderAdminView):
        super().__init__()
        self.owner = view

    async def on_submit(self, interaction: discord.Interaction) -> None:
        try:
            payload = {
                "category": self.owner.category,
                "kind": self.owner.kind,
                "classname": self.classname.value.strip(),
                "buyPrice": int(self.buy_price.value.strip()),
                "sellPrice": int(self.sell_price.value.strip()),
                "quantityBuy": int(self.quantity_buy.value.strip()),
                "quantitySell": int(self.quantity_sell.value.strip()),
            }
        except ValueError:
            await interaction.response.send_message("Числовые поля заполнены неверно.", ephemeral=True)
            return

        try:
            answer = await self.owner.bot.panel.post("/trader/products", payload)
        except PanelError as err:
            await interaction.response.send_message(f"Не добавлено: {err}", ephemeral=True)
            return

        self.owner.product_index = answer.get("index")
        await self.owner.reload_products()
        await self.owner.bot.log_to_channel(
            f"➕ {interaction.user} добавил `{payload['classname']}` в `{self.owner.category}`"
        )
        await self.owner.refresh(interaction, f"{payload['classname']} добавлен (склад ∞, виден)")


class EditProductModal(discord.ui.Modal, title="Изменить товар"):
    classname = discord.ui.TextInput(label="Classname", max_length=120)
    buy_price = discord.ui.TextInput(label="Цена покупки", max_length=20)
    sell_price = discord.ui.TextInput(label="Цена продажи", max_length=20)
    quantity_buy = discord.ui.TextInput(label="quantity_buy", max_length=20)
    quantity_sell = discord.ui.TextInput(label="quantity_sell", max_length=20)

    def __init__(self, view: TraderAdminView, product: dict):
        super().__init__()
        self.owner = view
        self.product = product

        # Поля заполняются текущими значениями: правка «на месте», как в панели.
        self.classname.default = product["classname"]
        self.buy_price.default = str(product["buyPrice"])
        self.sell_price.default = str(product["sellPrice"])
        self.quantity_buy.default = str(product["quantityBuy"])
        self.quantity_sell.default = str(product["quantitySell"])

    async def on_submit(self, interaction: discord.Interaction) -> None:
        try:
            payload = {
                "category": self.owner.category,
                "kind": self.owner.kind,
                "index": self.product["index"],
                "classname": self.classname.value.strip(),
                "buyPrice": int(self.buy_price.value.strip()),
                "sellPrice": int(self.sell_price.value.strip()),
                "quantityBuy": int(self.quantity_buy.value.strip()),
                "quantitySell": int(self.quantity_sell.value.strip()),
            }
        except ValueError:
            await interaction.response.send_message("Числовые поля заполнены неверно.", ephemeral=True)
            return

        try:
            await self.owner.bot.panel.post("/trader/products/update", payload)
        except PanelError as err:
            await interaction.response.send_message(f"Не изменено: {err}", ephemeral=True)
            return

        await self.owner.reload_products()
        await self.owner.bot.log_to_channel(
            f"✏️ {interaction.user} изменил `{payload['classname']}` в `{self.owner.category}`"
        )
        await self.owner.refresh(interaction, f"{payload['classname']} изменён")


class StockModal(discord.ui.Modal, title="Склад товара"):
    count = discord.ui.TextInput(label="count_product (-1 — бесконечно)", max_length=20)

    def __init__(self, view: TraderAdminView, product: dict):
        super().__init__()
        self.owner = view
        self.product = product
        self.count.default = str(product["count"])

    async def on_submit(self, interaction: discord.Interaction) -> None:
        try:
            value = int(self.count.value.strip())
        except ValueError:
            await interaction.response.send_message("Склад должен быть числом.", ephemeral=True)
            return

        try:
            await self.owner.bot.panel.post(
                "/trader/products/update",
                {"category": self.owner.category, "kind": self.owner.kind, "index": self.product["index"], "count": value},
            )
        except PanelError as err:
            await interaction.response.send_message(f"Не изменено: {err}", ephemeral=True)
            return

        await self.owner.reload_products()
        await self.owner.refresh(interaction, f"склад {self.product['classname']}: {stock(value)}")


# -------------------------------------------------------------- команды

def setup(bot) -> None:
    async def guard(interaction: discord.Interaction) -> bool:
        if isinstance(interaction.user, discord.Member) and can_manage(interaction.user, bot):
            return True

        await interaction.response.send_message(
            "Админка трейдера только для управляющих. Роли задаются в мастере настройки панели "
            "(«ID ролей для админки трейдера»).",
            ephemeral=True,
        )
        return False

    @bot.tree.command(name="trader-admin", description="Админка трейдера: категории, товары, цены, торговцы")
    @app_commands.default_permissions(administrator=True)
    async def trader_admin(interaction: discord.Interaction) -> None:
        if not await guard(interaction):
            return

        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            data = await bot.panel.get("/trader")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        view = TraderAdminView(bot, interaction.user.id, data)
        view.message = await interaction.followup.send(embed=view.embed(), view=view, ephemeral=True)

    @bot.tree.command(name="trader-price", description="Быстро поменять цены товара")
    @app_commands.describe(category="Категория", classname="Classname товара", buy="Цена покупки", sell="Цена продажи")
    @app_commands.default_permissions(administrator=True)
    async def trader_price(
        interaction: discord.Interaction, category: str, classname: str, buy: int | None = None, sell: int | None = None
    ) -> None:
        if not await guard(interaction):
            return

        await interaction.response.defer(ephemeral=True, thinking=True)
        if buy is None and sell is None:
            await interaction.followup.send("Укажите цену покупки, продажи или обе.", ephemeral=True)
            return

        try:
            answer = await bot.panel.get(f"/trader/products?category={category}&kind=trader")
            found = [p for p in answer.get("products") or [] if p["classname"].lower() == classname.strip().lower()]
            if not found:
                await interaction.followup.send(f"В «{category}» нет товара `{classname}`.", ephemeral=True)
                return

            payload = {"category": category, "kind": "trader", "index": found[0]["index"]}
            if buy is not None:
                payload["buyPrice"] = buy
            if sell is not None:
                payload["sellPrice"] = sell

            await bot.panel.post("/trader/products/update", payload)
        except PanelError as err:
            await interaction.followup.send(f"Не изменено: {err}", ephemeral=True)
            return

        await bot.log_to_channel(f"💰 {interaction.user} поменял цены `{classname}` в `{category}`")
        await interaction.followup.send("Цены изменены.", ephemeral=True)

    @bot.tree.command(name="trader-validate", description="Проверить файлы трейдера на поломки")
    @app_commands.default_permissions(administrator=True)
    async def trader_validate(interaction: discord.Interaction) -> None:
        if not await guard(interaction):
            return

        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            answer = await bot.panel.get("/trader/validate")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        issues = answer.get("issues") or []
        text = "✅ Поломок не найдено." if not issues else "⚠️ Найдено:\n" + "\n".join(f"• {i}" for i in issues[:25])
        await interaction.followup.send(text[:1900], ephemeral=True)

    @bot.tree.command(name="trader-list", description="Категории трейдера и сколько в них товаров")
    @app_commands.describe(kind="Тип категорий")
    @app_commands.choices(kind=[
        app_commands.Choice(name="продажа", value="trader"),
        app_commands.Choice(name="бартер", value="barter"),
    ])
    async def trader_list(interaction: discord.Interaction, kind: app_commands.Choice[str] | None = None) -> None:
        await interaction.response.defer(ephemeral=True, thinking=True)

        try:
            data = await bot.panel.get("/trader")
        except PanelError as err:
            await interaction.followup.send(f"Панель не ответила: {err}", ephemeral=True)
            return

        if not data.get("ok"):
            await interaction.followup.send(f"Трейдер недоступен: {data.get('reason')}", ephemeral=True)
            return

        chosen = (kind.value if kind else "trader")
        items = (data.get("categories") or {}).get(chosen) or []
        lines = [
            f"**{c['id']}** — {c['name'] or 'без названия'} · товаров {c['products']}"
            + (f" · у NPC: {', '.join(c['traders'])}" if c["traders"] else "")
            for c in items
        ]
        await interaction.followup.send("\n".join(lines)[:1900] or "категорий нет", ephemeral=True)
