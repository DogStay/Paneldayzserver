/**
 * Сборка JSON руками.
 *
 * Главная особенность: в файле нет ни одной escape-последовательности.
 * Парсер Enforce ломается на литерале вида «кавычка внутри кавычек»
 * (CParser: quoted string not closed), поэтому кавычка, обратный слэш и
 * переводы строк собираются из ASCII-кодов через int.AsciiToString() —
 * штатную функцию движка. Заодно это снимает вопрос «а поддерживает ли
 * конкретная версия игры такое экранирование».
 *
 * Весь JSON мода собирается только через эти помощники: ник игрока или текст
 * чата вполне может содержать кавычки и переводы строк, и без экранирования
 * панель такой ответ не разберёт.
 */
class PanelJson
{
    private static string s_Quote;
    private static string s_Slash;
    private static string s_NewLine;
    private static string s_Return;
    private static string s_Tab;

    /** Символы, которые нельзя записать литералом. Считаются один раз. */
    private static void Init()
    {
        if (s_Quote != "") return;

        int quote = 34;
        int slash = 92;
        int newLine = 10;
        int carriage = 13;
        int tab = 9;

        s_Quote = quote.AsciiToString();
        s_Slash = slash.AsciiToString();
        s_NewLine = newLine.AsciiToString();
        s_Return = carriage.AsciiToString();
        s_Tab = tab.AsciiToString();
    }

    /** Строка в кавычках с экранированием. */
    static string Str(string value)
    {
        Init();
        return s_Quote + Escape(value) + s_Quote;
    }

    static string Escape(string value)
    {
        Init();

        string result = "";
        int length = value.Length();

        for (int i = 0; i < length; i++)
        {
            string ch = value.Substring(i, 1);

            if (ch == s_Quote) result += s_Slash + s_Quote;
            else if (ch == s_Slash) result += s_Slash + s_Slash;
            else if (ch == s_NewLine) result += s_Slash + "n";
            else if (ch == s_Return) result += s_Slash + "r";
            else if (ch == s_Tab) result += s_Slash + "t";
            else result += ch;
        }

        return result;
    }

    static string Bool(bool value)
    {
        if (value) return "true";
        return "false";
    }

    /** Число с одним знаком после запятой — координаты и урон читаемее. */
    static string Num(float value)
    {
        int scaled = Math.Round(value * 10);
        int whole = scaled / 10;
        int frac = scaled - whole * 10;
        if (frac < 0) frac = -frac;
        return whole.ToString() + "." + frac.ToString();
    }

    /** Координаты как [x, y, z]. */
    static string Vec(vector pos)
    {
        return Arr(Num(pos[0]) + "," + Num(pos[1]) + "," + Num(pos[2]));
    }

    /* ------------------------------------------------- структуры */

    /** Объект: {…}. Фигурные скобки экранировать не нужно. */
    static string Obj(string body)
    {
        return "{" + body + "}";
    }

    /** Массив: […]. */
    static string Arr(string body)
    {
        return "[" + body + "]";
    }

    /** Пара «ключ: готовый JSON» — для вложенных объектов и массивов. */
    static string KRaw(string key, string rawJson)
    {
        return Str(key) + ":" + rawJson;
    }

    /** Пара «ключ: строка». */
    static string KStr(string key, string value)
    {
        return Str(key) + ":" + Str(value);
    }

    /** Пара «ключ: число». */
    static string KNum(string key, float value)
    {
        return Str(key) + ":" + Num(value);
    }

    /** Пара «ключ: целое». */
    static string KInt(string key, int value)
    {
        return Str(key) + ":" + value.ToString();
    }

    /** Пара «ключ: логическое». */
    static string KBool(string key, bool value)
    {
        return Str(key) + ":" + Bool(value);
    }

    /** Пара «ключ: null». */
    static string KNull(string key)
    {
        return Str(key) + ":null";
    }

    /** Пара «ключ: координаты». */
    static string KVec(string key, vector pos)
    {
        return Str(key) + ":" + Vec(pos);
    }
}

/**
 * Unix-время старта сервера.
 *
 * В Enforce нет функции «дай unix-время», зато есть UTC-дата и время. Считаем
 * число дней от эпохи по алгоритму days_from_civil (григорианский календарь без
 * ветвлений по високосным годам) и переводим в секунды.
 */
class PanelTime
{
    static int UnixSeconds()
    {
        int year, month, day, hour, minute, second;
        GetYearMonthDayUTC(year, month, day);
        GetHourMinuteSecondUTC(hour, minute, second);

        return DaysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
    }

    /** Число дней от 1970-01-01 до указанной даты. */
    static int DaysFromCivil(int y, int m, int d)
    {
        if (m <= 2) y -= 1;

        int era = y / 400;
        if (y < 0) era = (y - 399) / 400;

        int yoe = y - era * 400;

        int mp = m - 3;
        if (m <= 2) mp = m + 9;

        int doy = (153 * mp + 2) / 5 + d - 1;
        int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;

        return era * 146097 + doe - 719468;
    }
}
