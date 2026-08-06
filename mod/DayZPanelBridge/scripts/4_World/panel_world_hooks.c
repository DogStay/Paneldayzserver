/**
 * Хуки мира: вещи, действия, выстрелы, транспорт, стройка.
 *
 * Главный приём — событие `action`. Вместо десятков частных хуков на «открыл
 * дверь», «поел», «перевязался», «взломал замок» перехватывается завершение
 * ЛЮБОГО действия. Так в лог попадает всё, что игрок делает руками, включая
 * действия из будущих патчей и других модов, — а частные события остаются лишь
 * там, где нужны детали (урон, смерть, стройка, транспорт).
 */

modded class ItemBase
{
    override void OnInventoryEnter(Man player)
    {
        super.OnInventoryEnter(player);

        if (!GetGame().IsServer()) return;

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("item_take")) return;

        string playerJson = PanelRef.Of(player);
        if (playerJson == "") return;

        string data = "{" + PanelJson.KStr("class", GetType());
        data += "," + PanelJson.KNum("quantity", GetQuantity());
        data += "," + PanelJson.KNum("health", GetHealth("", "")) + "}";

        bridge.Event("item_take", playerJson, "", GetPosition(), data);
    }

    override void OnInventoryExit(Man player)
    {
        super.OnInventoryExit(player);

        if (!GetGame().IsServer()) return;

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("item_drop")) return;

        string playerJson = PanelRef.Of(player);
        if (playerJson == "") return;

        string data = "{" + PanelJson.KStr("class", GetType());
        data += "," + PanelJson.KNum("quantity", GetQuantity());
        data += "," + PanelJson.KNum("health", GetHealth("", "")) + "}";

        bridge.Event("item_drop", playerJson, "", GetPosition(), data);
    }
}

modded class ActionBase
{
    override void OnEndServer(ActionData action_data)
    {
        super.OnEndServer(action_data);

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("action")) return;
        if (!action_data || !action_data.m_Player) return;

        string playerJson = PanelRef.Of(action_data.m_Player);
        if (playerJson == "") return;

        // Класс действия — устойчивое имя: ActionOpenDoors, ActionEatSmall,
        // ActionBandageSelf и так далее. По нему панель и фильтрует.
        string actionName = ClassName();

        Object target;
        if (action_data.m_Target) target = action_data.m_Target.GetObject();

        string targetType = PanelRef.TypeOf(target);
        string ownerJson = "";
        EntityAI targetEntity = EntityAI.Cast(target);
        if (targetEntity) ownerJson = PanelRef.OfEntity(targetEntity);

        string data = "{" + PanelJson.KStr("action", actionName);
        data += "," + PanelJson.KStr("target", targetType);
        if (action_data.m_MainItem) data += "," + PanelJson.KStr("item", action_data.m_MainItem.GetType());
        data += "}";

        bridge.Event("action", playerJson, ownerJson, action_data.m_Player.GetPosition(), data);
    }
}

modded class Weapon_Base
{
    override void EEFired(int muzzleType, int mode, string ammoType)
    {
        super.EEFired(muzzleType, mode, ammoType);

        if (!GetGame().IsServer()) return;

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("shot")) return;

        string playerJson = PanelRef.OfEntity(this);
        if (playerJson == "") return;

        string data = "{" + PanelJson.KStr("weapon", GetType());
        data += "," + PanelJson.KStr("ammo", ammoType);
        data += "," + PanelJson.KInt("muzzle", muzzleType) + "}";

        bridge.Event("shot", playerJson, "", GetPosition(), data);
    }
}

modded class CarScript
{
    override void OnEngineStart()
    {
        super.OnEngineStart();
        PanelEngineEvent(true);
    }

    override void OnEngineStop()
    {
        super.OnEngineStop();
        PanelEngineEvent(false);
    }

    /** Двигатель запустил тот, кто сидит за рулём. */
    private void PanelEngineEvent(bool on)
    {
        if (!GetGame().IsServer()) return;

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("vehicle_engine")) return;

        string playerJson = "";
        Human driver = CrewMember(DayZPlayerConstants.VEHICLESEAT_DRIVER);
        if (driver) playerJson = PanelRef.Of(Man.Cast(driver));

        string data = "{" + PanelJson.KStr("class", GetType());
        data += "," + PanelJson.KBool("on", on) + "}";

        bridge.Event("vehicle_engine", playerJson, "", GetPosition(), data);
    }

    override void EEKilled(Object killer)
    {
        super.EEKilled(killer);

        if (!GetGame().IsServer()) return;

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("vehicle_destroy")) return;

        string data = "{" + PanelJson.KStr("class", GetType()) + "}";
        bridge.Event("vehicle_destroy", PanelRef.OfEntity(EntityAI.Cast(killer)), "", GetPosition(), data);
    }
}

modded class BaseBuildingBase
{
    override void OnPartBuiltServer(notnull Man player, string part_name, int action_id)
    {
        super.OnPartBuiltServer(player, part_name, action_id);

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("build")) return;

        string data = "{" + PanelJson.KStr("part", part_name);
        data += "," + PanelJson.KStr("target", GetType()) + "}";

        bridge.Event("build", PanelRef.Of(player), "", GetPosition(), data);
    }

    override void OnPartDismantledServer(notnull Man player, string part_name, int action_id)
    {
        super.OnPartDismantledServer(player, part_name, action_id);

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("dismantle")) return;

        string data = "{" + PanelJson.KStr("part", part_name);
        data += "," + PanelJson.KStr("target", GetType()) + "}";

        bridge.Event("dismantle", PanelRef.Of(player), "", GetPosition(), data);
    }
}
