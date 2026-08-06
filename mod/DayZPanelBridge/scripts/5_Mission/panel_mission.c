/**
 * Точка входа мода: запуск моста, таймеры, подключения и чат.
 *
 * Все периодические дела собраны в одном OnUpdate: запись накопленных событий,
 * снимок состояния, чтение команд панели и уборка. Отдельных таймеров нет
 * специально — так проще следить за нагрузкой.
 */
modded class MissionServer
{
    private ref PanelCommands m_PanelHandler;

    private float m_PanelFlushTimer;
    private float m_PanelSnapshotTimer;
    private float m_PanelCommandTimer;
    private float m_PanelCleanupTimer;

    override void OnInit()
    {
        super.OnInit();

        PanelBridge bridge = PanelBridge.Get();

        m_PanelHandler = new PanelCommands();
        bridge.SetHandler(m_PanelHandler);

        string world = GetGame().GetWorldName();
        world.ToLower();

        bridge.Init(world, PanelWorldSize(world), "", GetGame().ServerConfigGetInt("maxPlayers"));
    }

    /**
     * Размер карты в метрах.
     *
     * Спрашиваем у движка — тогда любая модовая карта (Raman, DeerIsle, свои
     * терраины) отдаёт точное значение, и метки на карте панели не разъезжаются.
     * Табличка ниже осталась подстраховкой, если движок ответит нулём.
     */
    private int PanelWorldSize(string world)
    {
        int size = GetGame().GetWorld().GetWorldSize();
        if (size > 0) return size;

        switch (world)
        {
            case "chernarusplus": return 15360;
            case "chernarus": return 15360;
            case "enoch": return 12800;
            case "sakhal": return 8192;
            case "namalsk": return 12800;
            case "deerisle": return 16384;
            case "banov": return 12800;
        }
        return 15360;
    }

    override void OnUpdate(float timeslice)
    {
        super.OnUpdate(timeslice);

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.IsReady()) return;

        PanelBridgeConfig config = bridge.GetConfig();

        m_PanelFlushTimer += timeslice;
        m_PanelSnapshotTimer += timeslice;
        m_PanelCommandTimer += timeslice;
        m_PanelCleanupTimer += timeslice;

        // Буфер пишем по таймеру или когда он набрался: во время боя события
        // идут лавиной, и ждать секунду незачем.
        if (m_PanelFlushTimer >= config.flushSeconds || bridge.ShouldFlush())
        {
            m_PanelFlushTimer = 0;
            bridge.Flush();
        }

        if (m_PanelSnapshotTimer >= config.snapshotSeconds)
        {
            m_PanelSnapshotTimer = 0;
            PanelSnapshot.Write();
        }

        if (m_PanelCommandTimer >= config.commandPollSeconds)
        {
            m_PanelCommandTimer = 0;
            bridge.PollCommands();
        }

        // Раз в пять минут проверяем, не копятся ли файлы: значит панель не
        // запущена и события никто не забирает.
        if (m_PanelCleanupTimer >= 300)
        {
            m_PanelCleanupTimer = 0;
            bridge.CleanupOut();
        }
    }

    /* ------------------------------------------------------ подключения */

    override void InvokeOnConnect(PlayerBase player, PlayerIdentity identity)
    {
        super.InvokeOnConnect(player, identity);

        if (!player) return;
        player.PanelRemember();

        PanelBridge bridge = PanelBridge.Get();
        string playerJson = PanelRef.Of(player);
        if (playerJson == "") return;

        // Сам IP не пишем: панели он не нужен, а хранить его — лишняя
        // ответственность. Короткий хэш позволяет заметить «тот же адрес».
        string ipHash = "";
        if (identity) ipHash = PanelHashIp(identity.GetPlainId());

        string data = "{" + PanelJson.KStr("ipHash", ipHash);
        data += "," + PanelJson.KStr("steam64", player.PanelId()) + "}";
        bridge.Event("connect", playerJson, "", player.GetPosition(), data);

        bridge.Event("spawn", playerJson, "", player.GetPosition(),
            "{" + PanelJson.KBool("fresh", false) + "}");
    }

    override void InvokeOnDisconnect(PlayerBase player)
    {
        if (player)
        {
            PanelBridge bridge = PanelBridge.Get();
            string playerJson = PanelRef.Of(player);

            if (playerJson != "")
            {
                string data = "{" + PanelJson.KInt("playtimeSec", player.PanelPlaytimeSec()) + "}";
                bridge.Event("disconnect", playerJson, "", player.GetPosition(), data);
                // Событие должно уйти до того, как объект игрока исчезнет.
                bridge.Flush();
            }
        }

        super.InvokeOnDisconnect(player);
    }

    /** Короткий необратимый отпечаток — не адрес, а лишь «тот же или другой». */
    private string PanelHashIp(string value)
    {
        int hash = 7;
        for (int i = 0; i < value.Length(); i++)
        {
            hash = (hash * 31 + value.Substring(i, 1).ToInt()) % 99991;
        }
        return hash.ToString();
    }

    /* ------------------------------------------------------------- чат */

    override void OnEvent(EventType eventTypeId, Param params)
    {
        super.OnEvent(eventTypeId, params);

        if (eventTypeId != ChatMessageEventTypeID) return;

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("chat")) return;

        ChatMessageEventParams chatParams;
        if (!Class.CastTo(chatParams, params)) return;

        string from = chatParams.param2;
        string text = chatParams.param3;
        if (text == "") return;

        // В параметрах чата приходит ник, а не идентификатор — ищем игрока по нему.
        string playerJson = "";
        ref array<Man> players = new array<Man>;
        GetGame().GetPlayers(players);

        for (int i = 0; i < players.Count(); i++)
        {
            PlayerBase player = PlayerBase.Cast(players.Get(i));
            if (player && player.PanelName() == from)
            {
                playerJson = PanelRef.Of(player);
                break;
            }
        }

        if (playerJson == "")
        {
            playerJson = "{" + PanelJson.KStr("id", "") + "," + PanelJson.KStr("name", from) + "}";
        }

        string data = "{" + PanelJson.KInt("channel", chatParams.param1);
        data += "," + PanelJson.KStr("text", text) + "}";

        bridge.Event("chat", playerJson, "", vector.Zero, data);
    }
}
