/**
 * Выполнение команд панели.
 *
 * Каждая команда — маленькая функция: если движок в новой версии игры что-то
 * переименует, отвалится ровно одна команда, а не весь мост. Ошибки не бросают
 * исключений (в Enforce их и нет) — возвращается false и текст для панели.
 */
class PanelCommands extends PanelCommandHandler
{
    override bool Execute(PanelCommand cmd, out string resultJson, out string error)
    {
        resultJson = "{}";
        error = "";

        PanelCommandArgs args = cmd.args;
        if (!args) args = new PanelCommandArgs();

        switch (cmd.action)
        {
            case "ping": return Ping(resultJson);
            case "message": return Message(args, error);
            case "kick": return Kick(args, error);
            case "teleport": return Teleport(args, error);
            case "teleport_to": return TeleportTo(args, error);
            case "heal": return Heal(args, error);
            case "set_stat": return SetStat(args, false, error);
            case "add_stat": return SetStat(args, true, error);
            case "give_item": return GiveItem(args, resultJson, error);
            case "remove_item": return RemoveItem(args, resultJson, error);
            case "inventory": return ReadInventory(args, resultJson, error);
            case "godmode": return GodMode(args, error);
            case "kill": return Kill(args, error);
            case "spawn_object": return SpawnObject(args, resultJson, error);
            case "set_time": return SetTime(args, error);
            case "set_weather": return SetWeather(args, error);
            case "save_world":
                // Надёжного способа сохранить мир из скрипта нет: у панели для
                // этого есть плановый перезапуск, который сервер сохраняет сам.
                error = "сохранение мира из мода не поддерживается — используйте перезапуск сервера";
                return false;
        }

        error = "неизвестная команда: " + cmd.action;
        return false;
    }

    /* ------------------------------------------------------------ игроки */

    /** Найти игрока по Steam64 (он же id в протоколе). */
    private PlayerBase Find(string id)
    {
        if (id == "") return null;

        ref array<Man> players = new array<Man>;
        GetGame().GetPlayers(players);

        for (int i = 0; i < players.Count(); i++)
        {
            PlayerBase player = PlayerBase.Cast(players.Get(i));
            if (player && player.PanelId() == id) return player;
        }
        return null;
    }

    private bool Ping(out string resultJson)
    {
        ref array<Man> players = new array<Man>;
        GetGame().GetPlayers(players);

        string pong = PanelJson.KBool("pong", true);
        pong += "," + PanelJson.KInt("playersOnline", players.Count());
        resultJson = PanelJson.Obj(pong);
        return true;
    }

    private bool Message(PanelCommandArgs args, out string error)
    {
        if (args.text == "")
        {
            error = "пустой текст сообщения";
            return false;
        }

        if (args.id == "all" || args.id == "")
        {
            ref array<Man> players = new array<Man>;
            GetGame().GetPlayers(players);

            for (int i = 0; i < players.Count(); i++)
            {
                Send(PlayerBase.Cast(players.Get(i)), args.text, args.style);
            }
            return true;
        }

        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        Send(player, args.text, args.style);
        return true;
    }

    /**
     * Показать текст игроку.
     *
     * Movement важен: important — красное сообщение по центру, status —
     * обычное уведомление, остальное — дружелюбная строка.
     */
    private void Send(PlayerBase player, string text, string style)
    {
        if (!player) return;

        if (style == "important") player.MessageImportant(text);
        else if (style == "popup") player.MessageStatus(text);
        else player.MessageFriendly(text);
    }

    private bool Kick(PanelCommandArgs args, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        PlayerIdentity identity = player.GetIdentity();
        if (!identity)
        {
            error = "у игрока нет активного подключения";
            return false;
        }

        if (args.reason != "") player.MessageImportant(args.reason);
        GetGame().DisconnectPlayer(identity);
        return true;
    }

    private bool Teleport(PanelCommandArgs args, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }
        if (!args.pos || args.pos.Count() < 3)
        {
            error = "нужны координаты [x, y, z]";
            return false;
        }

        vector target = Vector(args.pos.Get(0), args.pos.Get(1), args.pos.Get(2));

        // Высоту панель может не знать — ставим на поверхность.
        if (target[1] <= 0) target[1] = GetGame().SurfaceY(target[0], target[2]);

        player.SetPosition(target);
        return true;
    }

    private bool TeleportTo(PanelCommandArgs args, out string error)
    {
        PlayerBase player = Find(args.id);
        PlayerBase target = Find(args.targetId);

        if (!player || !target)
        {
            error = "один из игроков не найден на сервере";
            return false;
        }

        vector pos = target.GetPosition();
        pos[0] = pos[0] + 1.5; // рядом, а не внутрь модели
        player.SetPosition(pos);
        return true;
    }

    private bool Heal(PanelCommandArgs args, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        player.SetHealth("", "Health", player.GetMaxHealth("", "Health"));
        player.SetHealth("", "Blood", player.GetMaxHealth("", "Blood"));
        player.SetHealth("", "Shock", player.GetMaxHealth("", "Shock"));

        BleedingSourcesManagerServer bleeding = player.GetBleedingManagerServer();
        if (bleeding) bleeding.RemoveAllSources();

        if (player.GetStatEnergy()) player.GetStatEnergy().Set(player.GetStatEnergy().GetMax());
        if (player.GetStatWater()) player.GetStatWater().Set(player.GetStatWater().GetMax());

        return true;
    }

    /**
     * Правка показателя. Проценты (0…100) панель присылает для тех показателей,
     * у которых есть максимум; здоровье, кровь и шок — в единицах движка.
     */
    private bool SetStat(PanelCommandArgs args, bool relative, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        float amount = args.value;
        if (relative) amount = args.delta;

        switch (args.stat)
        {
            case "health":
                ApplyHealth(player, "Health", amount, relative);
                return true;
            case "blood":
                ApplyHealth(player, "Blood", amount, relative);
                return true;
            case "shock":
                ApplyHealth(player, "Shock", amount, relative);
                return true;
            case "hunger":
                return ApplyStat(player.GetStatEnergy(), amount, relative, error);
            case "thirst":
                return ApplyStat(player.GetStatWater(), amount, relative, error);
            case "stamina":
                return ApplyStamina(player, amount, relative, error);
            case "temperature":
                return ApplyStat(player.GetStatHeatComfort(), amount, relative, error);
        }

        error = "неизвестный показатель: " + args.stat;
        return false;
    }

    private void ApplyHealth(PlayerBase player, string type, float amount, bool relative)
    {
        float value = amount;
        if (relative) value = player.GetHealth("", type) + amount;

        float max = player.GetMaxHealth("", type);
        if (value < 0) value = 0;
        if (max > 0 && value > max) value = max;

        player.SetHealth("", type, value);
    }

    private bool ApplyStat(PlayerStat<float> stat, float amount, bool relative, out string error)
    {
        if (!stat)
        {
            error = "показатель недоступен у этого игрока";
            return false;
        }

        float max = stat.GetMax();
        float value;

        if (max > 0)
        {
            // Панель считает в процентах — переводим в единицы движка.
            float current = stat.Get() / max * 100;
            float percent = amount;
            if (relative) percent = current + amount;

            if (percent < 0) percent = 0;
            if (percent > 100) percent = 100;
            value = percent / 100 * max;
        }
        else
        {
            value = amount;
            if (relative) value = stat.Get() + amount;
        }

        stat.Set(value);
        return true;
    }

    private bool ApplyStamina(PlayerBase player, float amount, bool relative, out string error)
    {
        StaminaHandler handler = player.GetStaminaHandler();
        if (!handler)
        {
            error = "выносливость недоступна";
            return false;
        }

        // У выносливости нет сеттера, зато есть «дать столько-то»: этого
        // достаточно, чтобы восстановить её игроку.
        float delta = amount;
        if (!relative) delta = amount - handler.GetStamina();

        if (delta > 0) handler.SetStamina(handler.GetStamina() + delta);
        return true;
    }

    /* -------------------------------------------------------------- вещи */

    private bool GiveItem(PanelCommandArgs args, out string resultJson, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }
        if (args.itemClass == "")
        {
            error = "не указан класс предмета (itemClass)";
            return false;
        }

        EntityAI created = player.GetInventory().CreateInInventory(args.itemClass);
        string where = "inventory";

        if (!created)
        {
            created = player.GetHumanInventory().CreateInHands(args.itemClass);
            where = "hands";
        }
        if (!created)
        {
            created = EntityAI.Cast(GetGame().CreateObjectEx(args.itemClass, player.GetPosition(), ECE_PLACE_ON_SURFACE));
            where = "ground";
        }
        if (!created)
        {
            error = "не удалось создать предмет — проверьте класс";
            return false;
        }

        if (args.quantity > 0)
        {
            ItemBase item = ItemBase.Cast(created);
            if (item) item.SetQuantity(args.quantity);
        }

        resultJson = "{" + PanelJson.KStr("class", args.itemClass) + "," + PanelJson.KStr("where", where) + "}";
        return true;
    }

    private bool RemoveItem(PanelCommandArgs args, out string resultJson, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        ref array<EntityAI> items = new array<EntityAI>;
        player.GetInventory().EnumerateInventory(InventoryTraversalType.PREORDER, items);

        int removed = 0;
        for (int i = 0; i < items.Count(); i++)
        {
            EntityAI item = items.Get(i);
            if (!item) continue;
            if (args.itemClass != "all" && item.GetType() != args.itemClass) continue;

            GetGame().ObjectDelete(item);
            removed++;
        }

        resultJson = "{" + PanelJson.KInt("removed", removed) + "}";
        return true;
    }

    private bool ReadInventory(PanelCommandArgs args, out string resultJson, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        resultJson = PanelInventory.Dump(player);
        return true;
    }

    /* ------------------------------------------------------------- прочее */

    private bool GodMode(PanelCommandArgs args, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        player.SetAllowDamage(!args.on);
        return true;
    }

    private bool Kill(PanelCommandArgs args, out string error)
    {
        PlayerBase player = Find(args.id);
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        player.SetHealth("", "Health", 0);
        return true;
    }

    private bool SpawnObject(PanelCommandArgs args, out string resultJson, out string error)
    {
        if (args.itemClass == "")
        {
            error = "не указан класс объекта (itemClass)";
            return false;
        }
        if (!args.pos || args.pos.Count() < 3)
        {
            error = "нужны координаты [x, y, z]";
            return false;
        }

        vector pos = Vector(args.pos.Get(0), args.pos.Get(1), args.pos.Get(2));
        if (pos[1] <= 0) pos[1] = GetGame().SurfaceY(pos[0], pos[2]);

        Object created = GetGame().CreateObjectEx(args.itemClass, pos, ECE_PLACE_ON_SURFACE);
        if (!created)
        {
            error = "не удалось создать объект — проверьте класс";
            return false;
        }

        if (args.quantity > 0)
        {
            ItemBase item = ItemBase.Cast(created);
            if (item) item.SetQuantity(args.quantity);
        }

        string spawned = PanelJson.KStr("class", args.itemClass);
        spawned += "," + PanelJson.KVec("pos", pos);
        resultJson = PanelJson.Obj(spawned);
        return true;
    }

    private bool SetTime(PanelCommandArgs args, out string error)
    {
        if (args.hour < 0 || args.hour > 23)
        {
            error = "час должен быть от 0 до 23";
            return false;
        }

        int year, month, day, hour, minute;
        GetGame().GetWorld().GetDate(year, month, day, hour, minute);
        GetGame().GetWorld().SetDate(year, month, day, args.hour, args.minute);
        return true;
    }

    private bool SetWeather(PanelCommandArgs args, out string error)
    {
        Weather weather = GetGame().GetWeather();
        if (!weather)
        {
            error = "погода недоступна";
            return false;
        }

        // Второй аргумент — за сколько секунд измениться, третий — сколько
        // держать. Мгновенная смена погоды выглядит некрасиво, поэтому минута.
        if (args.overcast >= 0) weather.GetOvercast().Set(Clamp01(args.overcast), 60, 600);
        if (args.rain >= 0) weather.GetRain().Set(Clamp01(args.rain), 60, 600);
        if (args.fog >= 0) weather.GetFog().Set(Clamp01(args.fog), 60, 600);

        return true;
    }

    private float Clamp01(float value)
    {
        if (value < 0) return 0;
        if (value > 1) return 1;
        return value;
    }
}
