"""
Клиент панели.

Единственное место, где бот знает про HTTP. Все ошибки превращаются в
`PanelError` с человеческим текстом: бот показывает его игроку или админу как
есть, поэтому «Traceback» в Discord не попадает никогда.
"""

from __future__ import annotations

import json

import aiohttp


class PanelError(RuntimeError):
    """Ошибка обращения к панели с текстом, который можно показать человеку."""


class Panel:
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
        if not self.session:
            raise PanelError("клиент панели не открыт")

        url = f"{self.base}/api{path}"
        try:
            async with self.session.request(method, url, json=payload) as res:
                text = await res.text()
                try:
                    data = json.loads(text) if text else {}
                except json.JSONDecodeError:
                    raise PanelError(f"панель ответила не JSON ({res.status})")

                if res.status >= 400:
                    raise PanelError(data.get("error") or f"панель ответила {res.status}")
                return data
        except aiohttp.ClientConnectorError:
            raise PanelError(f"панель недоступна по адресу {self.base} — запущена ли она?")
        except aiohttp.ClientError as err:
            raise PanelError(f"связь с панелью прервалась: {err}")

    # Короткие обёртки: так модули читаются как описание, а не как HTTP-код.

    async def get(self, path: str) -> dict:
        return await self.call("GET", path)

    async def post(self, path: str, payload: dict | None = None) -> dict:
        return await self.call("POST", path, payload)
