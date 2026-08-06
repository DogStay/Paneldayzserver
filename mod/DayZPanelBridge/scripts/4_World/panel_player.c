/**
 * Игрок: опознание для панели + события урона и смерти.
 *
 * Идентификатор и ник запоминаются при подключении, потому что к моменту
 * отключения или смерти identity может быть уже недоступна, а событие всё равно
 * нужно приписать конкретному человеку.
 */

class PanelRef
{
    /** Участник события в виде JSON: {"id":"765…","name":"Вася"}. */
    static string Of(Man man)
    {
        PlayerBase player = PlayerBase.Cast(man);
        if (!player) return "";

        string id = player.PanelId();
        if (id == "") return "";

        return "{" + PanelJson.KStr("id", id) + "," + PanelJson.KStr("name", player.PanelName()) + "}";
    }

    /** Тот, кому принадлежит предмет/машина, если это игрок. */
    static string OfEntity(EntityAI entity)
    {
        if (!entity) return "";
        return Of(entity.GetHierarchyRootPlayer());
    }

    /** Класс объекта или пустая строка. */
    static string TypeOf(Object object)
    {
        if (!object) return "";
        return object.GetType();
    }
}

modded class PlayerBase
{
    protected string m_PanelId;
    protected string m_PanelName;
    protected int m_PanelConnectedAt;

    /** Прошлое состояние — по нему ловим переходы в снимке (см. 5_Mission). */
    protected bool m_PanelWasBleeding;
    protected bool m_PanelWasUnconscious;
    protected string m_PanelLastVehicle;

    string PanelId()
    {
        if (m_PanelId != "") return m_PanelId;

        PlayerIdentity identity = GetIdentity();
        if (identity)
        {
            m_PanelId = identity.GetPlainId();
            if (m_PanelId == "") m_PanelId = identity.GetId();
        }
        return m_PanelId;
    }

    string PanelName()
    {
        if (m_PanelName != "") return m_PanelName;

        PlayerIdentity identity = GetIdentity();
        if (identity) m_PanelName = identity.GetName();
        return m_PanelName;
    }

    /** Запомнить игрока при подключении. */
    void PanelRemember()
    {
        PlayerIdentity identity = GetIdentity();
        if (identity)
        {
            m_PanelId = identity.GetPlainId();
            if (m_PanelId == "") m_PanelId = identity.GetId();
            m_PanelName = identity.GetName();
        }
        m_PanelConnectedAt = GetGame().GetTime();
    }

    int PanelPlaytimeSec()
    {
        if (m_PanelConnectedAt == 0) return 0;
        return (GetGame().GetTime() - m_PanelConnectedAt) / 1000;
    }

    bool PanelWasBleeding() { return m_PanelWasBleeding; }
    void PanelSetWasBleeding(bool state) { m_PanelWasBleeding = state; }

    bool PanelWasUnconscious() { return m_PanelWasUnconscious; }
    void PanelSetWasUnconscious(bool state) { m_PanelWasUnconscious = state; }

    string PanelLastVehicle() { return m_PanelLastVehicle; }
    void PanelSetLastVehicle(string type) { m_PanelLastVehicle = type; }

    /* ------------------------------------------------------------------ урон */

    override void EEHitBy(TotalDamageResult damageResult, int damageType, EntityAI source,
        int component, string dmgZone, string ammo, vector modelPos, float speedCoef)
    {
        super.EEHitBy(damageResult, damageType, source, component, dmgZone, ammo, modelPos, speedCoef);

        if (!GetGame().IsServer()) return;

        PanelBridge bridge = PanelBridge.Get();
        if (!bridge.EventEnabled("damage")) return;

        float damage = 0;
        if (damageResult) damage = damageResult.GetHighestDamage("Health");

        // Кто ударил: игрок, зомби, животное или мир (падение, машина).
        string attackerJson = "";
        string sourceType = "world";
        float distance = 0;

        if (source)
        {
            PlayerBase attacker = PlayerBase.Cast(source.GetHierarchyRootPlayer());
            if (attacker)
            {
                attackerJson = PanelRef.Of(attacker);
                sourceType = "player";
                distance = vector.Distance(attacker.GetPosition(), GetPosition());
            }
            else if (source.IsInherited(ZombieBase)) sourceType = "infected";
            else if (source.IsInherited(AnimalBase)) sourceType = "animal";
            else sourceType = source.GetType();
        }

        string weapon = "";
        if (source) weapon = source.GetType();

        string data = "{" + PanelJson.KNum("damage", damage);
        data += "," + PanelJson.KStr("zone", dmgZone);
        data += "," + PanelJson.KStr("weapon", weapon);
        data += "," + PanelJson.KStr("ammo", ammo);
        data += "," + PanelJson.KNum("distance", distance);
        data += "," + PanelJson.KStr("sourceType", sourceType) + "}";

        // player — тот, кто нанёс урон (если известен), target — пострадавший.
        bridge.Event("damage", attackerJson, PanelRef.Of(this), GetPosition(), data);
    }

    /* ---------------------------------------------------------------- смерть */

    override void EEKilled(Object killer)
    {
        super.EEKilled(killer);

        if (!GetGame().IsServer()) return;

        PanelBridge bridge = PanelBridge.Get();

        PlayerBase murderer;
        string killerId = "";
        float distance = 0;
        string weapon = "";

        if (killer)
        {
            weapon = killer.GetType();

            EntityAI killerEntity = EntityAI.Cast(killer);
            if (killerEntity)
            {
                murderer = PlayerBase.Cast(killerEntity.GetHierarchyRootPlayer());
                if (murderer)
                {
                    killerId = murderer.PanelId();
                    distance = vector.Distance(murderer.GetPosition(), GetPosition());
                }
            }
        }

        string data = "{" + PanelJson.KStr("reason", weapon);
        data += "," + PanelJson.KStr("killerId", killerId);
        data += "," + PanelJson.KStr("weapon", weapon);
        data += "," + PanelJson.KNum("distance", distance) + "}";

        bridge.Event("death", PanelRef.Of(this), PanelRef.Of(murderer), GetPosition(), data);

        // Убийство игрока игроком — отдельным событием: так его удобно искать.
        if (murderer && murderer != this)
        {
            string killData = "{" + PanelJson.KStr("victimId", PanelId());
            killData += "," + PanelJson.KStr("weapon", weapon);
            killData += "," + PanelJson.KNum("distance", distance);
            killData += "," + PanelJson.KStr("zone", "") + "}";

            bridge.Event("kill", PanelRef.Of(murderer), PanelRef.Of(this), GetPosition(), killData);
        }
    }
}
