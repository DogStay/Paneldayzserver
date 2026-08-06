/**
 * Снимок состояния игроков — то, из чего панель рисует карту и карточки.
 *
 * Файл перезаписывается целиком раз в несколько секунд: это «сейчас», а не
 * история. Позиции специально не идут отдельными событиями — иначе журнал
 * превратился бы в поток координат.
 *
 * Заодно здесь ловятся переходы состояний (сел в машину, началось
 * кровотечение, потерял сознание). Хуков на это в движке нет, а сравнить с
 * прошлым снимком — надёжно и ничего не стоит.
 */
class PanelSnapshot
{
    /** Собрать и записать снимок. */
    static void Write()
    {
        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.IsReady()) return;

        ref array<Man> players = new array<Man>;
        GetGame().GetPlayers(players);

        string list = "";
        int counted = 0;

        for (int i = 0; i < players.Count(); i++)
        {
            PlayerBase player = PlayerBase.Cast(players.Get(i));
            if (!player || !player.IsAlive()) continue;
            if (player.PanelId() == "") continue;

            if (counted > 0) list += ",";
            list += PlayerJson(player, bridge);
            counted++;
        }

        string body = PanelJson.KInt("v", 1);
        body += "," + PanelJson.KRaw("ts", bridge.Now());
        body += "," + PanelJson.KInt("uptimeSec", GetGame().GetTime() / 1000);
        body += "," + PanelJson.KStr("gameTime", GameTime());
        body += "," + PanelJson.KInt("playersOnline", counted);
        body += "," + PanelJson.KInt("dropped", 0);
        body += "," + PanelJson.KRaw("players", PanelJson.Arr(list));

        string json = PanelJson.Obj(body);

        bridge.WriteSnapshot(json);
    }

    /** Игровое время сервера как «14:32». */
    private static string GameTime()
    {
        int year, month, day, hour, minute;
        GetGame().GetWorld().GetDate(year, month, day, hour, minute);

        string h = hour.ToString();
        string m = minute.ToString();
        if (hour < 10) h = "0" + h;
        if (minute < 10) m = "0" + m;
        return h + ":" + m;
    }

    private static string PlayerJson(PlayerBase player, PanelBridge bridge)
    {
        vector pos = player.GetPosition();
        vector orientation = player.GetOrientation();

        float health = player.GetHealth("", "Health");
        float blood = player.GetHealth("", "Blood");
        float shock = player.GetHealth("", "Shock");

        float energy = -1;
        float water = -1;
        float hunger = -1;
        float thirst = -1;

        if (player.GetStatEnergy())
        {
            energy = player.GetStatEnergy().Get();
            float energyMax = player.GetStatEnergy().GetMax();
            if (energyMax > 0) hunger = energy / energyMax * 100;
        }
        if (player.GetStatWater())
        {
            water = player.GetStatWater().Get();
            float waterMax = player.GetStatWater().GetMax();
            if (waterMax > 0) thirst = water / waterMax * 100;
        }

        float wet = 0;
        if (player.GetStatWet()) wet = player.GetStatWet().Get();

        // Комфорт по теплу (-1 замерзает … +1 перегрев): в движке это ближе к
        // самочувствию игрока, чем «температура тела».
        float heatComfort = 0;
        if (player.GetStatHeatComfort()) heatComfort = player.GetStatHeatComfort().Get();

        float stamina = -1;
        StaminaHandler staminaHandler = player.GetStaminaHandler();
        if (staminaHandler) stamina = staminaHandler.GetStamina();

        bool bleeding = false;
        BleedingSourcesManagerServer bleedingManager = player.GetBleedingManagerServer();
        if (bleedingManager) bleeding = bleedingManager.GetBleedingSourcesCount() > 0;

        bool unconscious = player.IsUnconscious();

        string hands = "";
        EntityAI inHands = player.GetItemInHands();
        if (inHands) hands = inHands.GetType();

        string vehicle = "";
        HumanCommandVehicle command = player.GetCommand_Vehicle();
        if (command)
        {
            Transport transport = command.GetTransport();
            if (transport) vehicle = transport.GetType();
        }

        // Переходы состояний -> отдельные события.
        Transitions(player, bridge, bleeding, unconscious, vehicle, pos);

        string json = "{" + PanelJson.KStr("id", player.PanelId());
        json += "," + PanelJson.KStr("steam64", player.PanelId());
        json += "," + PanelJson.KStr("name", player.PanelName());
        json += "," + PanelJson.KVec("pos", pos);
        json += "," + PanelJson.KNum("dir", orientation[0]);
        json += "," + PanelJson.KNum("health", health);
        json += "," + PanelJson.KNum("blood", blood);
        json += "," + PanelJson.KNum("shock", shock);
        json += "," + PanelJson.KNum("energy", energy);
        json += "," + PanelJson.KNum("water", water);
        json += "," + PanelJson.KNum("hunger", hunger);
        json += "," + PanelJson.KNum("thirst", thirst);
        json += "," + PanelJson.KNum("heatComfort", heatComfort);
        json += "," + PanelJson.KNum("temperature", -1);
        json += "," + PanelJson.KNum("wet", wet);
        json += "," + PanelJson.KNum("stamina", stamina);
        json += "," + PanelJson.KBool("bleeding", bleeding);
        json += "," + PanelJson.KBool("unconscious", unconscious);
        json += "," + PanelJson.KBool("restrained", player.IsRestrained());
        json += "," + PanelJson.KStr("hands", hands);

        if (vehicle != "") json += "," + PanelJson.KStr("vehicle", vehicle);
        else json += "," + PanelJson.KNull("vehicle");

        json += "," + PanelJson.KInt("playtimeSec", player.PanelPlaytimeSec());
        json += "," + PanelJson.KInt("ping", -1);
        json += "}";

        return json;
    }

    /** События, которых нет в виде хуков: посадка в транспорт, кровь, обморок. */
    private static void Transitions(PlayerBase player, PanelBridge bridge,
        bool bleeding, bool unconscious, string vehicle, vector pos)
    {
        string playerJson = PanelRef.Of(player);
        if (playerJson == "") return;

        if (bleeding != player.PanelWasBleeding())
        {
            player.PanelSetWasBleeding(bleeding);
            bridge.Event("bleeding", playerJson, "", pos, "{" + PanelJson.KBool("state", bleeding) + "}");
        }

        if (unconscious != player.PanelWasUnconscious())
        {
            player.PanelSetWasUnconscious(unconscious);
            bridge.Event("unconscious", playerJson, "", pos, "{" + PanelJson.KBool("state", unconscious) + "}");
        }

        string previous = player.PanelLastVehicle();
        if (vehicle != previous)
        {
            player.PanelSetLastVehicle(vehicle);

            if (vehicle != "")
            {
                string enter = "{" + PanelJson.KStr("class", vehicle) + "," + PanelJson.KInt("seat", -1) + "}";
                bridge.Event("vehicle_enter", playerJson, "", pos, enter);
            }
            else if (previous != "")
            {
                bridge.Event("vehicle_exit", playerJson, "", pos, "{" + PanelJson.KStr("class", previous) + "}");
            }
        }
    }
}
