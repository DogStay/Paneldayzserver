class CfgPatches
{
    class DayZPanelBridge
    {
        units[] = {};
        weapons[] = {};
        requiredVersion = 0.1;
        requiredAddons[] = {"DZ_Data"};
    };
};

class CfgMods
{
    class DayZPanelBridge
    {
        dir = "DayZPanelBridge";
        picture = "";
        action = "";
        hideName = 0;
        hidePicture = 1;
        name = "DayZ Panel Bridge";
        credits = "DayZ Panel";
        author = "DayZ Panel";
        authorID = "0";
        version = "1.0.1";
        extra = 0;
        type = "mod";
        dependencies[] = {"Game", "World", "Mission"};

        class defs
        {
            class gameScriptModule
            {
                value = "";
                files[] = {"DayZPanelBridge/scripts/3_Game"};
            };
            class worldScriptModule
            {
                value = "";
                files[] = {"DayZPanelBridge/scripts/4_World"};
            };
            class missionScriptModule
            {
                value = "";
                files[] = {"DayZPanelBridge/scripts/5_Mission"};
            };
        };
    };
};
