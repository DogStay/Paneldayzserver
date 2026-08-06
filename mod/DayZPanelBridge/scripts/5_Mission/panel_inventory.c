/**
 * Инвентарь игрока для панели.
 *
 * Собирается только по команде `inventory`: складывать это в каждый снимок —
 * верный способ загрузить сервер на ровном месте (у одного игрока легко сотня
 * предметов вместе с патронами).
 *
 * Обход идёт по вложениям и по грузовым отсекам: одежда → её карманы →
 * содержимое, оружие → магазин → патроны. Глубина ограничена настройкой
 * maxInventoryDepth, чтобы не уйти в бесконечность на кривом моде.
 */
class PanelInventory
{
    static string Dump(PlayerBase player)
    {
        int maxDepth = 4;
        PanelBridgeConfig config = PanelBridge.Get().GetConfig();
        if (config && config.maxInventoryDepth > 0) maxDepth = config.maxInventoryDepth;

        string json = "{" + PanelJson.KStr("id", player.PanelId());

        EntityAI hands = player.GetItemInHands();
        if (hands) json += "," + PanelJson.KRaw("hands", ItemJson(hands, 0, maxDepth));
        else json += "," + PanelJson.KNull("hands");

        json += "," + PanelJson.KRaw("clothing", PanelJson.Arr(DumpAttachments(player, 0, maxDepth)));
        // Своего грузового отсека у игрока нет: всё лежит в надетых вещах,
        // поэтому cargo здесь всегда пуст — панель это учитывает.
        json += "," + PanelJson.KRaw("cargo", PanelJson.Arr(""));

        return PanelJson.Obj(json);
    }

    /** Один предмет вместе со вложенными. */
    private static string ItemJson(EntityAI entity, int depth, int maxDepth)
    {
        string json = "{" + PanelJson.KStr("class", entity.GetType());
        json += "," + PanelJson.KNum("health", entity.GetHealth("", ""));

        ItemBase item = ItemBase.Cast(entity);
        if (item) json += "," + PanelJson.KNum("quantity", item.GetQuantity());

        string children = "";
        if (depth < maxDepth)
        {
            children = DumpAttachments(entity, depth + 1, maxDepth);

            string cargo = Cargo(entity, depth + 1, maxDepth);
            if (cargo != "")
            {
                if (children != "") children += ",";
                children += cargo;
            }
        }

        json += "," + PanelJson.KRaw("children", PanelJson.Arr(children));
        return PanelJson.Obj(json);
    }

    /** Вложения (надетое, прикрученное к оружию). */
    private static string DumpAttachments(EntityAI entity, int depth, int maxDepth)
    {
        GameInventory inventory = entity.GetInventory();
        if (!inventory) return "";

        string result = "";
        int count = inventory.AttachmentCount();

        for (int i = 0; i < count; i++)
        {
            EntityAI attachment = inventory.GetAttachmentFromIndex(i);
            if (!attachment) continue;

            if (result != "") result += ",";
            result += ItemJson(attachment, depth, maxDepth);
        }

        return result;
    }

    /** Содержимое грузового отсека (карманы, сумка, ящик). */
    private static string Cargo(EntityAI entity, int depth, int maxDepth)
    {
        GameInventory inventory = entity.GetInventory();
        if (!inventory) return "";

        CargoBase cargo = inventory.GetCargo();
        if (!cargo) return "";

        string result = "";
        int count = cargo.GetItemCount();

        for (int i = 0; i < count; i++)
        {
            EntityAI item = cargo.GetItem(i);
            if (!item) continue;

            if (result != "") result += ",";
            result += ItemJson(item, depth, maxDepth);
        }

        return result;
    }
}
