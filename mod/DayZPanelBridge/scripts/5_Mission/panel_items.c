/**
 * Работа с конкретными предметами игрока: удалить, переложить, изменить.
 *
 * Панель адресует предметы по сетевому идентификатору: он есть у любого объекта
 * (Object.GetNetworkID) и по нему объект находится обратно
 * (CGame.GetObjectByNetworkId). Имя класса для этого не годится — у игрока может
 * быть пять одинаковых банок, а удалить надо конкретную.
 *
 * Все перемещения выполняются в режиме InventoryMode.SERVER: команда приходит
 * с панели, клиента в этот момент никто не спрашивает.
 */
class PanelItems
{
    /** «low:high» -> объект. Пусто или не найден — null. */
    static EntityAI FindByNet(string net)
    {
        if (net == "") return null;

        int at = net.IndexOf(":");
        if (at < 0) return null;

        string lowPart = net.Substring(0, at);
        string highPart = net.Substring(at + 1, net.Length() - at - 1);

        int low = lowPart.ToInt();
        int high = highPart.ToInt();

        Object found = GetGame().GetObjectByNetworkId(low, high);
        if (!found) return null;

        return EntityAI.Cast(found);
    }

    /** Идентификатор предмета для панели — в том же виде «low:high». */
    static string NetOf(EntityAI entity)
    {
        if (!entity) return "";

        int low, high;
        entity.GetNetworkID(low, high);
        return low.ToString() + ":" + high.ToString();
    }

    /* --------------------------------------------------------------- правки */

    static bool DeleteItem(string net, out string error)
    {
        EntityAI item = FindByNet(net);
        if (!item)
        {
            error = "предмет не найден — обновите инвентарь";
            return false;
        }

        item.Delete();
        return true;
    }

    static bool SetItemQuantity(string net, float value, out string error)
    {
        EntityAI entity = FindByNet(net);
        ItemBase item = ItemBase.Cast(entity);
        if (!item)
        {
            error = "предмет не найден или у него нет количества";
            return false;
        }

        if (value < 0) value = 0;
        item.SetQuantity(value);
        return true;
    }

    static bool SetItemHealth(string net, float value, out string error)
    {
        EntityAI item = FindByNet(net);
        if (!item)
        {
            error = "предмет не найден — обновите инвентарь";
            return false;
        }

        if (value < 0) value = 0;
        if (value > 100) value = 100;

        item.SetHealth("", "", value);
        return true;
    }

    /* ------------------------------------------------------------ переносы */

    /** В руки игроку. Занятые руки сначала освобождаем на землю. */
    static bool MoveToHands(string net, PlayerBase player, out string error)
    {
        EntityAI item = FindByNet(net);
        if (!item)
        {
            error = "предмет не найден — обновите инвентарь";
            return false;
        }
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        EntityAI inHands = player.GetItemInHands();
        if (inHands && inHands != item) player.ServerDropEntity(inHands);

        bool ok = player.GetInventory().TakeEntityToInventory(InventoryMode.SERVER, FindInventoryLocationType.HANDS, item);
        if (!ok) error = "не удалось взять предмет в руки";
        return ok;
    }

    /** На землю рядом с владельцем. */
    static bool MoveToGround(string net, out string error)
    {
        EntityAI item = FindByNet(net);
        if (!item)
        {
            error = "предмет не найден — обновите инвентарь";
            return false;
        }

        EntityAI owner = item.GetHierarchyParent();
        if (owner && owner.ServerDropEntity(item)) return true;

        // Предмет уже лежит сам по себе — просто ставим его на поверхность.
        vector pos = item.GetPosition();
        if (owner) pos = owner.GetPosition();

        item.SetPosition(pos);
        item.PlaceOnSurface();
        return true;
    }

    /** Внутрь другого предмета или игрока (сумка, ящик, карман). */
    static bool MoveInto(string net, string containerNet, out string error)
    {
        EntityAI item = FindByNet(net);
        if (!item)
        {
            error = "предмет не найден — обновите инвентарь";
            return false;
        }

        EntityAI container = FindByNet(containerNet);
        if (!container)
        {
            error = "не найдено, куда положить — обновите инвентарь";
            return false;
        }
        if (container == item)
        {
            error = "предмет нельзя положить внутрь себя";
            return false;
        }

        GameInventory inventory = container.GetInventory();
        if (!inventory)
        {
            error = "у этого предмета нет места внутри";
            return false;
        }

        bool ok = inventory.TakeEntityToInventory(InventoryMode.SERVER, FindInventoryLocationType.ANY, item);
        if (!ok) error = "не поместилось: нет свободного места";
        return ok;
    }

    /** Создать предмет прямо внутри выбранного контейнера. */
    static bool SpawnInto(string containerNet, string itemClass, float quantity, out string resultJson, out string error)
    {
        if (itemClass == "")
        {
            error = "не указан класс предмета (itemClass)";
            return false;
        }

        EntityAI container = FindByNet(containerNet);
        if (!container)
        {
            error = "не найдено, куда положить — обновите инвентарь";
            return false;
        }

        GameInventory inventory = container.GetInventory();
        if (!inventory)
        {
            error = "у этого предмета нет места внутри";
            return false;
        }

        EntityAI created = inventory.CreateInInventory(itemClass);
        if (!created)
        {
            error = "не удалось создать предмет — проверьте класс и свободное место";
            return false;
        }

        if (quantity > 0)
        {
            ItemBase item = ItemBase.Cast(created);
            if (item) item.SetQuantity(quantity);
        }

        string body = PanelJson.KStr("net", NetOf(created));
        body += "," + PanelJson.KStr("class", created.GetType());
        resultJson = PanelJson.Obj(body);
        return true;
    }

    /** Убрать у игрока всё: и надетое, и то, что в руках. */
    static bool StripAll(PlayerBase player, out string resultJson, out string error)
    {
        if (!player)
        {
            error = "игрок не найден на сервере";
            return false;
        }

        int removed = 0;

        EntityAI inHands = player.GetItemInHands();
        if (inHands)
        {
            inHands.Delete();
            removed++;
        }

        GameInventory inventory = player.GetInventory();
        if (inventory)
        {
            ref array<EntityAI> items = new array<EntityAI>;
            inventory.EnumerateInventory(InventoryTraversalType.PREORDER, items);

            for (int i = 0; i < items.Count(); i++)
            {
                EntityAI item = items.Get(i);
                if (!item || item == player) continue;

                item.Delete();
                removed++;
            }
        }

        resultJson = PanelJson.Obj(PanelJson.KInt("removed", removed));
        return true;
    }
}
