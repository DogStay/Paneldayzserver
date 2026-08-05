# DayZ Panel — веб-панель управления сервером DayZ Standalone (Windows)

Локальная панель на Node.js + Express для DayZ Standalone Server под Windows.
Управляет модами, портами, автообновлением и запуском сервера, сама собирает
`.bat`-файл запуска и открывает порты в брандмауэре Windows.

Панель работает офлайн. Интернет нужен только в двух случаях: разовая установка
зависимостей (`npm install`) и обращения к SteamCMD (скачивание/обновление модов).

---

## Возможности

| Что | Как реализовано |
|---|---|
| Список модов с чекбоксами | `src/services/mods.js` — состояние хранится в `config/config.json`, порядок задаётся перетаскиванием и напрямую влияет на порядок в `-mod=` |
| Добавление мода по Workshop ID | SteamCMD `workshop_download_item 221100 <id>`, имя папки `@Mod` берётся из `meta.cpp` |
| Старт / стоп / рестарт сервера | `src/services/serverProcess.js`, запуск `DayZServer_x64.exe`, остановка через `taskkill /PID /T /F` |
| Статус и живой лог | SSE-поток `/api/logs/stream`; лог сервера дочитывается из `*.RPT`, `*.ADM`, `script*.log` в папке профиля |
| Автогенерация `.bat` | `src/services/batgen.js` — `-mod=`, `-serverMod=`, порты, конфиг, профили собираются из настроек панели |
| Автооткрытие портов | `src/services/firewall.js` — `netsh advfirewall`, все порты берутся из конфига |
| Автообновление модов | Перед стартом SteamCMD проверяет моды, изменение версии определяется по `appworkshop_221100.acf`; обновлённые моды заново раскладываются в папку сервера, всё пишется в лог |
| Хранение настроек | Один JSON-файл `config/config.json` |

---

## Требования

* Windows 10/11 или Windows Server 2016+
* [Node.js LTS](https://nodejs.org) (18 или новее) — при установке отметьте «Add to PATH»
* [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) — например в `C:\SteamCMD`
* Установленный сервер DayZ (app `223350`) — например в `C:\DayZServer`
* Аккаунт Steam, **владеющий DayZ** (моды Workshop нельзя качать анонимно)

---

## Установка и первый запуск

### 1. Скачать панель

```bat
git clone https://github.com/DogStay/Paneldayzserver.git C:\DayZPanel
cd C:\DayZPanel
```

Либо распакуйте архив репозитория в `C:\DayZPanel`.

### 2. Установить зависимости

Двойной клик по **`install.bat`** (или `npm install --omit=dev` в консоли).
Это единственный шаг, требующий интернета.

### 3. Разовый вход в Steam (если включён Steam Guard)

```bat
C:\SteamCMD\steamcmd.exe +login ВАШ_ЛОГИН +quit
```

Введите пароль и код Steam Guard. Дальше SteamCMD использует сохранённую
сессию, и пароль в панели можно не указывать.

### 4. Запустить панель

Двойной клик по **`start-panel.bat`** → откроется <http://localhost:8787>.

> **Запускайте `start-panel.bat` от имени администратора** (ПКМ → «Запуск от имени
> администратора»), иначе `netsh` не сможет создавать правила брандмауэра.
> Панель об этом предупредит и всё равно запустится — правила можно применить
> позже кнопкой «Сохранить .bat для админа» на вкладке «Брандмауэр».

### 5. Указать пути

Вкладка **«Настройки»** → раздел «Пути»:

| Поле | Пример |
|---|---|
| Папка сервера | `C:\DayZServer` |
| Имя exe-файла | `DayZServer_x64.exe` |
| Путь к steamcmd.exe | `C:\SteamCMD\steamcmd.exe` |
| Папка workshop-контента | оставьте пустым — рассчитается как `C:\SteamCMD\steamapps\workshop\content\221100` |
| Папка профилей | `profiles` (относительно папки сервера) |
| Файл конфига сервера | `serverDZ.cfg` |
| Имя генерируемого .bat | `start_dayz_server.bat` |

Заполните раздел «Сервер» (название, слоты, порты) и «Steam» (логин), нажмите
**«Сохранить настройки»**. Красная плашка вверху исчезнет, когда все пути будут
корректными.

### 6. Добавить моды и стартовать

Вкладка **«Моды»** → вставьте Workshop ID (число из ссылки
`…/filedetails/?id=**1559212036**`) → «Скачать через SteamCMD».
Затем **«▶ Старт сервера»** в шапке.

---

## Что происходит при нажатии «Старт сервера»

1. **Проверка путей** — если чего-то нет, запуск прерывается с понятной ошибкой.
2. **Брандмауэр** — `netsh advfirewall firewall add rule` для игрового порта,
   Steam query порта и всех дополнительных диапазонов из настроек
   (in + out, имена вида `DayZ Panel - UDP 2302`). Существующие правила не дублируются.
3. **`serverDZ.cfg`** — подставляются `hostname`, `maxPlayers`, `steamQueryPort`
   из панели. Остальное содержимое файла не трогается. Если файла нет — создаётся шаблон.
4. **Моды** — SteamCMD проверяет все включённые моды; изменившиеся копируются
   (или симлинкаются) в папку сервера, `.bikey` раскладываются в `<сервер>\keys`.
   В лог пишется, что именно обновилось.
5. **`.bat`** — генерируется файл запуска со всеми актуальными параметрами.
6. **Запуск** — `DayZServer_x64.exe` стартует с теми же аргументами, что в `.bat`,
   панель запоминает PID и начинает читать логи профиля.

Любой шаг можно отключить на вкладке «Настройки» → «Поведение панели».

---

## Структура проекта

```
Paneldayzserver/
├── config/
│   ├── config.default.json     эталон настроек (в репозитории)
│   └── config.json             рабочий конфиг, создаётся при первом запуске
├── src/
│   ├── server.js               Express: статика + /api, точка входа
│   ├── config.js               загрузка/сохранение/нормализация JSON-конфига
│   ├── logger.js               кольцевой буфер лога + рассылка в SSE + файл
│   ├── util/
│   │   └── vdf.js              парсер Valve KeyValues (.acf)
│   ├── routes/
│   │   └── api.js              HTTP API (только маршрутизация)
│   └── services/
│       ├── steamcmd.js         запуск SteamCMD, скачивание модов, версии из .acf
│       ├── mods.js             список/раскладка модов, keys, сборка -mod=
│       ├── batgen.js           генерация аргументов и .bat-файла
│       ├── firewall.js         правила netsh advfirewall
│       ├── serverCfg.js        точечная правка serverDZ.cfg
│       ├── logTail.js          дочитывание *.RPT / *.ADM / script.log
│       └── serverProcess.js    жизненный цикл процесса сервера
├── public/                     фронтенд без сборки (index.html + app.js + style.css)
├── generated/                  open-firewall.bat (создаётся по кнопке)
├── logs/panel.log              лог самой панели
├── install.bat                 установка зависимостей
└── start-panel.bat             запуск панели
```

Модули не знают друг о друге больше необходимого: `steamcmd.js` ничего не знает
про Express, `firewall.js` — про моды, `batgen.js` — про запуск процессов.
Заменить любой из них можно, не трогая остальные.

---

## Конфигурация (`config/config.json`)

```jsonc
{
  "panel":  { "host": "127.0.0.1", "port": 8787, "logBufferLines": 2000 },
  "paths":  {
    "serverPath": "C:\\DayZServer",
    "serverExe": "DayZServer_x64.exe",
    "steamcmdExe": "C:\\SteamCMD\\steamcmd.exe",
    "workshopContentDir": "",        // пусто = вычислить от steamcmd.exe
    "profilesFolder": "profiles",
    "configFile": "serverDZ.cfg",
    "batFile": "start_dayz_server.bat"
  },
  "steam":  { "username": "", "password": "", "anonymous": false,
              "dayzAppId": "221100", "serverAppId": "223350" },
  "server": {
    "name": "My DayZ Server",
    "maxPlayers": 60,
    "gamePort": 2302,                // -port= и правило UDP в брандмауэре
    "steamQueryPort": 27016,         // steamQueryPort в serverDZ.cfg + правило
    "extraPorts": [                  // всё, что нужно открыть дополнительно
      { "protocol": "UDP", "from": 2303, "to": 2305, "comment": "…" }
    ],
    "cpuCount": 0,                   // 0 = не передавать аргумент
    "limitFPS": 0,
    "extraArgs": ["-dologs", "-adminlog", "-netlog", "-freezecheck"]
  },
  "features": {
    "autoFirewall": true,            // netsh при старте
    "autoUpdateMods": true,          // проверка обновлений перед стартом
    "deployMode": "copy",            // copy | symlink (junction)
    "patchServerCfg": true,
    "regenerateBatOnStart": true,
    "launchMode": "exe"              // exe | bat
  },
  "mods": [
    { "id": "1559212036", "name": "Community Framework",
      "folder": "@Community Framework", "enabled": true, "type": "client" }
  ]
}
```

`type: "client"` попадает в `-mod=`, `type: "server"` — в `-serverMod=`.

Формат строк в поле «Дополнительные порты» в интерфейсе:

```
UDP 2303-2305 голосовой чат
TCP 27016 Steam query
```

---

## Режимы раскладки модов

* **copy** (по умолчанию) — мод физически копируется из
  `steamapps\workshop\content\221100\<id>` в `<сервер>\@Имя`.
  Надёжно, работает всегда, занимает место дважды.
* **symlink** — создаётся junction на папку workshop. Экономит диск и
  обновление применяется мгновенно, но требует, чтобы workshop и сервер были
  на одном томе NTFS, а панель — с правом создавать ссылки (обычно нужны права
  администратора).

В обоих режимах `.bikey` копируются в `<сервер>\keys` физически — иначе сервер
их не подхватит.

---

## Как определяется, что мод обновился

DayZ Workshop не даёт версию без обращения в Steam, поэтому панель делает так:

1. Читает `steamapps\workshop\appworkshop_221100.acf` и запоминает
   `manifest` + `timeupdated` для каждого мода.
2. Запускает `steamcmd +workshop_download_item 221100 <id>` для всех включённых
   модов одним вызовом (SteamCMD сам скачает только изменившееся).
3. Перечитывает `.acf`. Если `manifest`/`timeupdated` изменились — мод считается
   обновлённым: он заново раскладывается в папку сервера, а в лог попадает
   строка `↑ <Имя> (<id>): ОБНОВЛЁН`.

Дополнительно панель показывает бейдж «есть обновление», если в секции
`WorkshopItemDetails` файла `.acf` время публикации новее установленного.

---

## API

Всё под `/api`, ответы — JSON.

| Метод | Путь | Назначение |
|---|---|---|
| `GET` | `/status` | статус сервера, состояние SteamCMD, список проблем конфигурации |
| `GET` `PUT` | `/config` | чтение и частичное обновление настроек |
| `GET` | `/mods` | список модов + скачанные, но не подключённые |
| `POST` | `/mods` | `{id, type}` — скачать и добавить мод |
| `POST` | `/mods/adopt` | подключить уже скачанный мод без обращения к Steam |
| `PATCH` | `/mods/:id` | `{enabled, type, name, folder}` |
| `DELETE` | `/mods/:id?deleteFiles=1` | убрать из списка (и удалить папку) |
| `POST` | `/mods/reorder` | `{ids: [...]}` — порядок в `-mod=` |
| `POST` | `/mods/update` | проверить обновления и разложить изменившиеся |
| `POST` | `/mods/deploy` | разложить включённые моды в папку сервера |
| `GET` `POST` | `/bat` | предпросмотр / запись `.bat` |
| `GET` `POST` `DELETE` | `/firewall`, `/firewall/apply`, `/firewall/bat` | правила брандмауэра |
| `GET` `PUT` `POST` | `/servercfg`, `/servercfg/sync` | работа с `serverDZ.cfg` |
| `POST` | `/server/start` `/server/stop` `/server/restart` | управление сервером |
| `POST` | `/steamcmd/update-server` | `app_update 223350 validate` |
| `GET` | `/logs`, `/logs/stream` | лог и SSE-поток лога/статуса |

---

## Безопасность

Панель **не имеет авторизации** и по умолчанию слушает только `127.0.0.1`,
то есть доступна лишь с самой машины сервера. Если поменять `panel.host` на
`0.0.0.0`, панель станет доступна по локальной сети — делайте это осознанно и
никогда не выставляйте её в интернет напрямую (используйте VPN или
reverse-proxy с паролем).

Пароль Steam, если он указан в настройках, хранится в `config/config.json`
в открытом виде и не отдаётся обратно в браузер. Надёжнее выполнить
`steamcmd +login ЛОГИН +quit` один раз вручную и оставить поле пароля пустым.

---

## Решение проблем

**«Порт 8787 занят»** — измените `panel.port` в `config/config.json`.

**Правила брандмауэра не создаются** — панель запущена без прав администратора.
Либо перезапустите `start-panel.bat` от имени администратора, либо нажмите
«Сохранить .bat для админа» и выполните `generated\open-firewall.bat` с правами
администратора.

**SteamCMD: `Login Failure` / `Rate Limit Exceeded`** — выполните вход вручную
(`steamcmd +login ЛОГИН +quit`), подтвердите Steam Guard и повторите.

**SteamCMD: `No subscription`** — аккаунт не владеет DayZ; моды Workshop
анонимно скачать нельзя.

**Сервер стартует и сразу падает** — смотрите лог: чаще всего это
`verifySignatures = 2` без нужных `.bikey` в `<сервер>\keys` или мод-зависимость,
стоящий в `-mod=` ниже зависящего от него (поднимите `@CF`/`@Dabs Framework`
перетаскиванием вверх).

**Лог сервера пуст** — сервер запущен без `-dologs -adminlog -netlog` либо
указана не та папка профиля. Проверьте `paths.profilesFolder`.

**Мод не появился в игре** — убедитесь, что он «разложен» (бейдж «готов»),
включён чекбоксом и попал в предпросмотр `.bat` на вкладке «.bat запуска».

---

## Разработка

```bash
npm install
npm start           # http://localhost:8787
npm run check       # быстрая проверка синтаксиса
```

Единственная внешняя зависимость — Express. Фронтенд — обычные HTML/CSS/JS
без сборки, правки видны после перезагрузки страницы.

Панель запускается и на Linux/macOS (удобно для доработки интерфейса): в этом
случае `netsh` и запуск `DayZServer_x64.exe` не работают, о чём панель
предупреждает в логе, остальные функции доступны.
