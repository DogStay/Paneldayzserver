/**
 * Сборка JSON руками.
 *
 * Готового сериализатора произвольных структур в Enforce нет, а ник игрока или
 * текст чата вполне может содержать кавычки, обратные слэши и переводы строк —
 * без экранирования такой JSON панель не разберёт. Поэтому все строки идут
 * только через PanelJson.Str().
 */
class PanelJson
{
    /** Строка в кавычках с экранированием. */
    static string Str(string value)
    {
        return "\"" + Escape(value) + "\"";
    }

    static string Escape(string value)
    {
        string out = "";
        int length = value.Length();

        for (int i = 0; i < length; i++)
        {
            string ch = value.Substring(i, 1);

            if (ch == "\"") out += "\\\"";
            else if (ch == "\\") out += "\\\\";
            else if (ch == "\n") out += "\\n";
            else if (ch == "\r") out += "\\r";
            else if (ch == "\t") out += "\\t";
            else out += ch;
        }

        return out;
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
        return "[" + Num(pos[0]) + "," + Num(pos[1]) + "," + Num(pos[2]) + "]";
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
