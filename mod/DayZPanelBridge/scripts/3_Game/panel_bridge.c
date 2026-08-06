/**
 * DayZ Panel Bridge — ядро моста между сервером и веб-панелью.
 *
 * Обмен идёт файлами в папке профиля сервера ($profile:panel). Никаких сетевых
 * обращений: движок их всё равно не даёт, а файлы работают всегда и переживают
 * перезапуск любой из сторон.
 *
 *   panel/config.json    настройки мода (создаётся сам)
 *   panel/hello.json     версия мода, мир, размер карты — пишется при старте
 *   panel/snapshot.json   состояние игроков, перезаписывается раз в N секунд
 *   panel/out/ev_*.json   события: панель читает и удаляет
 *   panel/in/cmd_*.json   команды панели: мод выполняет, отвечает и удаляет
 *
 * Здесь только «транспорт»: буфер событий, запись файлов, разбор команд.
 * Всё, что знает про игроков и мир, живёт в 4_World и 5_Mission.
 *
 * Протокол целиком описан в docs/bridge-mod-prompt.md панели.
 */

class PanelBridgeEvents
{
    bool connect = true;
    bool spawn = true;
    bool disconnect = true;
    bool death = true;
    bool kill = true;
    bool damage = true;
    bool shot = true;
    bool chat = true;
    bool item_take = true;
    bool item_drop = true;
    bool item_move = false;
    bool action = true;
    bool vehicle = true;
    bool build = true;
    bool container_open = true;
    bool placement = true;
    bool unconscious = true;
    bool bleeding = true;
}

class PanelBridgeConfig
{
    int v = 1;
    bool enabled = true;
    float snapshotSeconds = 3.0;
    float flushSeconds = 1.0;
    int flushEvents = 200;
    float commandPollSeconds = 1.0;
    int maxEventsPerSecond = 300;
    int maxOutFiles = 2000;
    int maxInventoryDepth = 4;
    ref PanelBridgeEvents events = new PanelBridgeEvents();
}

/** Аргументы команды панели. Имена полей = имена в JSON. */
class PanelCommandArgs
{
    string id;
    string targetId;
    string text;
    string style;
    string stat;
    string itemClass;
    string reason;
    float value;
    float delta;
    float quantity;
    int hour;
    int minute;
    bool on;
    float overcast;
    float rain;
    float fog;
    float windForce;
    ref array<float> pos;
}

class PanelCommand
{
    int v;
    string id;
    string action;
    ref PanelCommandArgs args;
}

/**
 * Исполнитель команд. Настоящая реализация живёт в 5_Mission (там доступны
 * игроки и мир) и регистрируется в ядре при старте миссии.
 */
class PanelCommandHandler
{
    /**
     * @param cmd команда из файла
     * @param resultJson готовый JSON-объект результата (или "{}")
     * @param error текст ошибки, если не получилось
     * @return true — выполнено
     */
    bool Execute(PanelCommand cmd, out string resultJson, out string error)
    {
        resultJson = "{}";
        error = "обработчик команд не подключён";
        return false;
    }
}

class PanelBridge
{
    static const string DIR = "$profile:panel";
    static const string OUT_DIR = "$profile:panel/out";
    static const string IN_DIR = "$profile:panel/in";
    static const string CONFIG_FILE = "$profile:panel/config.json";
    static const string HELLO_FILE = "$profile:panel/hello.json";
    static const string SNAPSHOT_FILE = "$profile:panel/snapshot.json";

    static const int PROTOCOL = 1;
    static const string MOD_VERSION = "1.0.5";

    private static ref PanelBridge s_Instance;

    ref PanelBridgeConfig m_Config;
    ref PanelCommandHandler m_Handler;

    /** Готовые JSON-объекты событий, ждущие записи на диск. */
    private ref array<string> m_Buffer;

    private int m_Seq;
    private int m_Dropped;

    /** Ограничитель частоты: сколько событий уже записано в текущую секунду. */
    private int m_SecondCount;
    private int m_SecondStartedMs;

    /** База для unix-времени: секунды на момент старта минус игровое время. */
    private int m_BaseUnixSec;
    private int m_BaseGameMs;

    private bool m_Ready;
    private bool m_ErrorLogged;

    static PanelBridge Get()
    {
        if (!s_Instance) s_Instance = new PanelBridge();
        return s_Instance;
    }

    void PanelBridge()
    {
        m_Buffer = new array<string>;
        m_Config = new PanelBridgeConfig();
    }

    bool IsReady()
    {
        return m_Ready && m_Config && m_Config.enabled;
    }

    PanelBridgeConfig GetConfig()
    {
        return m_Config;
    }

    void SetHandler(PanelCommandHandler handler)
    {
        m_Handler = handler;
    }

    /* ------------------------------------------------------------- запуск */

    /**
     * Подготовка: папки, настройки, точка отсчёта времени.
     * @param worldName имя мира
     * @param worldSize размер карты в метрах
     * @param mission имя миссии
     * @param maxPlayers слотов на сервере
     */
    void Init(string worldName, int worldSize, string mission, int maxPlayers)
    {
        m_BaseGameMs = GetGame().GetTime();
        m_BaseUnixSec = PanelTime.UnixSeconds();

        if (!EnsureDirs())
        {
            Log("не удалось создать папку " + DIR + " — мост выключен");
            return;
        }

        LoadConfig();
        m_Ready = true;

        if (!m_Config.enabled)
        {
            Log("мост выключен в config.json (enabled = false)");
            return;
        }

        WriteHello(worldName, worldSize, mission, maxPlayers);
        Log("мост запущен, папка обмена: " + DIR);

        string startBody = PanelJson.KStr("message", "мод-мост запущен");
        startBody += "," + PanelJson.KStr("level", "info");
        string startData = PanelJson.Obj(startBody);
        Event("server", "", "", vector.Zero, startData);
    }

    private bool EnsureDirs()
    {
        if (!FileExist(DIR) && !MakeDirectory(DIR)) return false;
        if (!FileExist(OUT_DIR) && !MakeDirectory(OUT_DIR)) return false;
        if (!FileExist(IN_DIR) && !MakeDirectory(IN_DIR)) return false;
        return true;
    }

    private void LoadConfig()
    {
        if (FileExist(CONFIG_FILE))
        {
            PanelBridgeConfig loaded = new PanelBridgeConfig();
            JsonFileLoader<PanelBridgeConfig>.JsonLoadFile(CONFIG_FILE, loaded);

            // Битый или пустой файл не должен превращать мод в тыкву: если
            // разбор не дал даже флагов событий, остаёмся на значениях по умолчанию.
            if (loaded && loaded.events)
            {
                m_Config = loaded;
                if (m_Config.snapshotSeconds < 1.0) m_Config.snapshotSeconds = 1.0;
                if (m_Config.flushSeconds < 0.2) m_Config.flushSeconds = 0.2;
                if (m_Config.commandPollSeconds < 0.2) m_Config.commandPollSeconds = 0.2;
                if (m_Config.flushEvents < 1) m_Config.flushEvents = 1;
                if (m_Config.maxEventsPerSecond < 10) m_Config.maxEventsPerSecond = 10;
                if (m_Config.maxOutFiles < 50) m_Config.maxOutFiles = 50;
                if (m_Config.maxInventoryDepth < 1) m_Config.maxInventoryDepth = 1;
            }
            else
            {
                Log("config.json не разобран, взяты значения по умолчанию");
            }
        }
        else
        {
            JsonFileLoader<PanelBridgeConfig>.JsonSaveFile(CONFIG_FILE, m_Config);
            Log("создан " + CONFIG_FILE);
        }
    }

    private void WriteHello(string worldName, int worldSize, string mission, int maxPlayers)
    {
        string featureList = PanelJson.Str("events") + "," + PanelJson.Str("snapshot");
        featureList += "," + PanelJson.Str("commands") + "," + PanelJson.Str("inventory");
        string features = PanelJson.Arr(featureList);

        string body = PanelJson.KInt("v", 1);
        body += "," + PanelJson.KInt("protocol", PROTOCOL);
        body += "," + PanelJson.KStr("mod", "DayZPanelBridge");
        body += "," + PanelJson.KStr("modVersion", MOD_VERSION);
        body += "," + PanelJson.KRaw("startedAt", Now());
        body += "," + PanelJson.KStr("world", worldName);
        body += "," + PanelJson.KInt("worldSize", worldSize);
        body += "," + PanelJson.KStr("mission", mission);
        body += "," + PanelJson.KInt("maxPlayers", maxPlayers);
        body += "," + PanelJson.KRaw("features", features);

        WriteAtomic(HELLO_FILE, PanelJson.Obj(body));
    }

    /* --------------------------------------------------------------- время */

    /** Unix-время в миллисекундах строкой: int не вмещает миллисекунды. */
    string Now()
    {
        int elapsed = GetGame().GetTime() - m_BaseGameMs;
        if (elapsed < 0) elapsed = 0;

        int sec = m_BaseUnixSec + (elapsed / 1000);
        int ms = elapsed % 1000;

        string msText = ms.ToString();
        if (ms < 10) msText = "00" + msText;
        else if (ms < 100) msText = "0" + msText;

        return sec.ToString() + msText;
    }

    /* -------------------------------------------------------------- события */

    bool EventEnabled(string type)
    {
        if (!IsReady()) return false;
        PanelBridgeEvents e = m_Config.events;
        if (!e) return true;

        switch (type)
        {
            case "connect": return e.connect;
            case "spawn": return e.spawn;
            case "disconnect": return e.disconnect;
            case "death": return e.death;
            case "kill": return e.kill;
            case "damage": return e.damage;
            case "shot": return e.shot;
            case "chat": return e.chat;
            case "item_take": return e.item_take;
            case "item_drop": return e.item_drop;
            case "item_move": return e.item_move;
            case "action": return e.action;
            case "build": return e.build;
            case "dismantle": return e.build;
            case "container_open": return e.container_open;
            case "placement": return e.placement;
            case "unconscious": return e.unconscious;
            case "bleeding": return e.bleeding;
            case "vehicle_enter": return e.vehicle;
            case "vehicle_exit": return e.vehicle;
            case "vehicle_engine": return e.vehicle;
            case "vehicle_destroy": return e.vehicle;
        }
        return true;
    }

    /**
     * Добавить событие в буфер.
     *
     * @param type тип события из протокола
     * @param playerJson готовый JSON участника («{"id":…}») или пустая строка
     * @param targetJson то же для второго участника
     * @param pos место события (vector.Zero — не указывать)
     * @param dataJson готовый JSON-объект с деталями
     */
    void Event(string type, string playerJson, string targetJson, vector pos, string dataJson)
    {
        if (!IsReady()) return;
        if (!EventEnabled(type)) return;
        if (!Budget()) return;

        string body = PanelJson.KRaw("ts", Now()) + "," + PanelJson.KStr("type", type);
        if (playerJson != "") body += "," + PanelJson.KRaw("player", playerJson);
        if (targetJson != "") body += "," + PanelJson.KRaw("target", targetJson);
        if (pos != vector.Zero) body += "," + PanelJson.KVec("pos", pos);
        if (dataJson != "") body += "," + PanelJson.KRaw("data", dataJson);

        m_Buffer.Insert(PanelJson.Obj(body));
    }

    /**
     * Ограничитель частоты. На людном сервере поток событий может стать
     * лавиной (бой, стройка, зачистка лута), и запись на диск важнее полноты:
     * лишнее считаем в dropped, панель это показывает.
     */
    private bool Budget()
    {
        int now = GetGame().GetTime();
        if (now - m_SecondStartedMs >= 1000)
        {
            m_SecondStartedMs = now;
            m_SecondCount = 0;
        }

        if (m_SecondCount >= m_Config.maxEventsPerSecond)
        {
            m_Dropped++;
            return false;
        }

        m_SecondCount++;
        return true;
    }

    /** Пора ли писать буфер на диск. */
    bool ShouldFlush()
    {
        return IsReady() && m_Buffer.Count() >= m_Config.flushEvents;
    }

    /** Записать накопленные события одним файлом. */
    void Flush()
    {
        if (!IsReady() || m_Buffer.Count() == 0) return;

        string events = "";
        for (int i = 0; i < m_Buffer.Count(); i++)
        {
            if (i > 0) events += ",";
            events += m_Buffer.Get(i);
        }

        string body = PanelJson.KInt("v", 1);
        body += "," + PanelJson.KRaw("ts", Now());
        body += "," + PanelJson.KInt("dropped", m_Dropped);
        body += "," + PanelJson.KRaw("events", PanelJson.Arr(events));

        string json = PanelJson.Obj(body);

        m_Seq++;
        string name = OUT_DIR + "/ev_" + Now() + "_" + m_Seq.ToString() + ".json";

        if (WriteAtomic(name, json))
        {
            m_Buffer.Clear();
            m_Dropped = 0;
        }
        else if (m_Buffer.Count() > m_Config.flushEvents * 10)
        {
            // Панель не читает, диск не пишет — не растём в памяти бесконечно.
            m_Dropped += m_Buffer.Count();
            m_Buffer.Clear();
        }
    }

    /** Снимок состояния игроков: файл перезаписывается целиком. */
    void WriteSnapshot(string json)
    {
        if (!IsReady()) return;
        WriteAtomic(SNAPSHOT_FILE, json);
    }

    /* -------------------------------------------------------------- команды */

    /** Прочитать и выполнить команды панели. */
    void PollCommands()
    {
        if (!IsReady()) return;

        string name;
        FileAttr attr;
        FindFileHandle handle = FindFile(IN_DIR + "/*.json", name, attr, FindFileFlags.DIRECTORIES);
        if (!handle) return;

        ref array<string> files = new array<string>;
        if (name != "") files.Insert(name);
        while (FindNextFile(handle, name, attr))
        {
            if (name != "") files.Insert(name);
        }
        CloseFindFile(handle);

        for (int i = 0; i < files.Count(); i++)
        {
            RunCommandFile(IN_DIR + "/" + files.Get(i));
        }
    }

    private void RunCommandFile(string path)
    {
        PanelCommand cmd = new PanelCommand();
        JsonFileLoader<PanelCommand>.JsonLoadFile(path, cmd);
        DeleteFile(path);

        if (!cmd || cmd.action == "")
        {
            Log("команда не разобрана: " + path);
            return;
        }

        string resultJson = "{}";
        string error = "";
        bool ok = false;

        if (m_Handler) ok = m_Handler.Execute(cmd, resultJson, error);
        else error = "обработчик команд не подключён";

        string body = PanelJson.KStr("id", cmd.id);
        body += "," + PanelJson.KStr("action", cmd.action);
        body += "," + PanelJson.KBool("ok", ok);
        if (!ok) body += "," + PanelJson.KStr("error", error);
        body += "," + PanelJson.KRaw("result", resultJson);

        string answer = PanelJson.KRaw("ts", Now());
        answer += "," + PanelJson.KStr("type", "command_result");
        answer += "," + PanelJson.KRaw("data", PanelJson.Obj(body));

        // Ответ на команду не подчиняется ограничителю частоты: панель его ждёт.
        m_Buffer.Insert(PanelJson.Obj(answer));
        Flush();
    }

    /* ---------------------------------------------------------------- файлы */

    /**
     * Запись «через временный файл»: панель читает каталог параллельно и не
     * должна натыкаться на половину файла.
     */
    private bool WriteAtomic(string path, string text)
    {
        string tmp = path + ".tmp";

        FileHandle file = OpenFile(tmp, FileMode.WRITE);
        if (file == 0)
        {
            LogOnce("не удалось записать " + tmp + " (нет доступа или кончилось место)");
            return false;
        }

        FPrintln(file, text);
        CloseFile(file);

        if (!CopyFile(tmp, path))
        {
            LogOnce("не удалось переименовать " + tmp);
            DeleteFile(tmp);
            return false;
        }

        DeleteFile(tmp);
        m_ErrorLogged = false;
        return true;
    }

    /**
     * Уборка: если панель не запущена, файлы событий копятся. Оставляем
     * последние maxOutFiles, остальное считаем потерянным.
     */
    void CleanupOut()
    {
        if (!IsReady()) return;

        string name;
        FileAttr attr;
        FindFileHandle handle = FindFile(OUT_DIR + "/ev_*.json", name, attr, FindFileFlags.DIRECTORIES);
        if (!handle) return;

        ref array<string> files = new array<string>;
        if (name != "") files.Insert(name);
        while (FindNextFile(handle, name, attr))
        {
            if (name != "") files.Insert(name);
        }
        CloseFindFile(handle);

        if (files.Count() <= m_Config.maxOutFiles) return;

        // Имена начинаются с времени, поэтому лексикографически старые — первые.
        files.Sort();
        int excess = files.Count() - m_Config.maxOutFiles;
        for (int i = 0; i < excess; i++)
        {
            DeleteFile(OUT_DIR + "/" + files.Get(i));
            m_Dropped++;
        }

        Log("панель не читает события: удалено старых файлов " + excess.ToString());
    }

    /* ------------------------------------------------------------------ лог */

    void Log(string message)
    {
        Print("[PanelBridge] " + message);
    }

    /** Одна и та же ошибка записи не должна засорять script.log каждую секунду. */
    private void LogOnce(string message)
    {
        if (m_ErrorLogged) return;
        m_ErrorLogged = true;
        Log(message);
    }
}
