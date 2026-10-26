/**
 * Weather understanding — reads a user-selected ioBroker weather adapter's states and normalizes their
 * (wildly different) state trees into one compact {@link WeatherReport} the LLM can answer from.
 *
 * Each weather adapter names its states differently, so there is one small mapper per adapter "kind"
 * (verified against the adapters' source):
 *  - `openmeteo`      → `open-meteo-weather` (H5N1v2): `<root>.weather.current.*`, `<root>.weather.forecast.dayN.*`
 *  - `wunderground`   → `weatherunderground`:          `<root>.forecast.current.*`, `<root>.forecast.Nd.*`
 *  - `openweathermap` → `openweathermap`:              `<root>.forecast.current.*`, `<root>.forecast.dayN.*`
 * Adapters without a mapper fall back to a raw state dump (handled by the caller), so the dropdown can still
 * offer them and the LLM can attempt an answer.
 */

/** How to read a given weather adapter's state tree. */
export type WeatherKind =
    'openmeteo' | 'wunderground' | 'openweathermap' | 'brightsky' | 'pirate' | 'accuweather' | 'daswetter' | 'yr';

/**
 * Registry of weather adapters offered in the settings dropdown. `kind` present = fully normalized.
 * `perLocationProbe` (a state path that exists once per location) marks adapters that namespace their data
 * under a per-location device, so the dropdown lists each location separately (its first path segment is
 * used to split the location out of the state id).
 */
export const WEATHER_ADAPTERS: Record<string, { label: string; kind?: WeatherKind; perLocationProbe?: string }> = {
    'open-meteo-weather': {
        label: 'Open-Meteo',
        kind: 'openmeteo',
        perLocationProbe: 'weather.current.temperature_2m',
    },
    weatherunderground: { label: 'Weather Underground', kind: 'wunderground' },
    openweathermap: { label: 'OpenWeatherMap', kind: 'openweathermap' },
    brightsky: { label: 'Bright Sky (DWD, free)', kind: 'brightsky' },
    'pirate-weather': { label: 'Pirate Weather', kind: 'pirate' },
    accuweather: { label: 'AccuWeather', kind: 'accuweather' },
    daswetter: {
        label: 'DasWetter (Meteored)',
        kind: 'daswetter',
        perLocationProbe: 'ForecastDaily.Day_1.Temperature_Max',
    },
    yr: { label: 'Yr / met.no', kind: 'yr' },
    dwd: { label: 'DWD (warnings only)' },
};

/** Current conditions, normalized. All fields optional (an adapter may not provide them). */
export interface WeatherCurrent {
    temperature?: number;
    feelsLike?: number;
    humidity?: number;
    condition?: string;
    windSpeed?: number;
    windDir?: string | number;
    pressure?: number;
    precipitation?: number;
    cloudCover?: number;
    uvIndex?: number;
}

/** One forecast day, normalized. */
export interface WeatherDay {
    day: number;
    date?: string;
    tempMax?: number;
    tempMin?: number;
    condition?: string;
    precipProbability?: number;
    precipitation?: number;
    windSpeed?: number;
    windDir?: string | number;
}

export interface WeatherReport {
    /** Adapter name the data came from. */
    source: string;
    /** Location name, if the root path carries one (Open-Meteo). */
    location?: string;
    /** Unit labels for the numeric values (the weather adapter's default units). */
    units: { temp: string; wind: string; precip: string };
    current?: WeatherCurrent;
    forecast: WeatherDay[];
}

/** A flat map of state id → value (as returned by getForeignStates, `.val` already unwrapped by the caller). */
export type StateValues = Record<string, unknown>;

/** WMO weather-code → short English text, used when an adapter gives only a numeric code. */
const WMO_TEXT: Record<number, string> = {
    0: 'clear sky',
    1: 'mainly clear',
    2: 'partly cloudy',
    3: 'overcast',
    45: 'fog',
    48: 'depositing rime fog',
    51: 'light drizzle',
    53: 'drizzle',
    55: 'dense drizzle',
    56: 'freezing drizzle',
    57: 'dense freezing drizzle',
    61: 'slight rain',
    63: 'rain',
    65: 'heavy rain',
    66: 'freezing rain',
    67: 'heavy freezing rain',
    71: 'slight snow',
    73: 'snow',
    75: 'heavy snow',
    77: 'snow grains',
    80: 'slight rain showers',
    81: 'rain showers',
    82: 'violent rain showers',
    85: 'snow showers',
    86: 'heavy snow showers',
    95: 'thunderstorm',
    96: 'thunderstorm with slight hail',
    99: 'thunderstorm with heavy hail',
};

/** Human text for a WMO code (or '' if unknown). */
export function wmoText(code: unknown): string {
    const n = typeof code === 'number' ? code : parseInt(String(code), 10);
    return Number.isFinite(n) ? WMO_TEXT[n] || '' : '';
}

function num(states: StateValues, id: string): number | undefined {
    const v = states[id];
    if (v === undefined || v === null || v === '') {
        return undefined;
    }
    const n = typeof v === 'number' ? v : parseFloat(v == null ? '0' : (v as string).toString());
    return Number.isFinite(n) ? n : undefined;
}

function str(states: StateValues, id: string): string | undefined {
    const v = states[id];
    if (v == null || v === '') {
        return undefined;
    }
    return (v as string).toString();
}

/** First defined number among several candidate ids (for adapters with windowed/variant fields). */
function firstNum(states: StateValues, ids: string[]): number | undefined {
    for (const id of ids) {
        const n = num(states, id);
        if (n !== undefined) {
            return n;
        }
    }
    return undefined;
}

/** First defined string among several candidate ids. */
function firstStr(states: StateValues, ids: string[]): string | undefined {
    for (const id of ids) {
        const s = str(states, id);
        if (s !== undefined) {
            return s;
        }
    }
    return undefined;
}

/** Number of forecast days present under `dayId(i)` (probe until a day has no max-temp). */
function countDays(states: StateValues, maxId: (i: number) => string, cap = 8): number {
    let n = 0;
    for (let i = 0; i < cap; i++) {
        if (num(states, maxId(i)) === undefined && str(states, maxId(i)) === undefined) {
            break;
        }
        n++;
    }
    return n;
}

function mapOpenMeteo(root: string, states: StateValues): WeatherReport {
    const c = `${root}.weather.current`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.temperature_2m`),
        feelsLike: num(states, `${c}.apparent_temperature`),
        humidity: num(states, `${c}.relative_humidity_2m`),
        condition: str(states, `${c}.weather_text`) || wmoText(states[`${c}.weather_code`]),
        windSpeed: num(states, `${c}.wind_speed_10m`),
        windDir: str(states, `${c}.wind_direction_text`) ?? num(states, `${c}.wind_direction_10m`),
        pressure: num(states, `${c}.pressure_msl`),
        precipitation: num(states, `${c}.precipitation`),
        cloudCover: num(states, `${c}.cloud_cover`),
    };
    const dayBase = (i: number): string => `${root}.weather.forecast.day${i}`;
    const days = countDays(states, i => `${dayBase(i)}.temperature_2m_max`);
    const forecast: WeatherDay[] = [];
    for (let i = 0; i < days; i++) {
        const d = dayBase(i);
        forecast.push({
            day: i,
            date: str(states, `${d}.name_day`) || str(states, `${d}.time`),
            tempMax: num(states, `${d}.temperature_2m_max`),
            tempMin: num(states, `${d}.temperature_2m_min`),
            condition: str(states, `${d}.weather_text`) || wmoText(states[`${d}.weather_code`]),
            precipProbability: num(states, `${d}.precipitation_probability_max`),
            precipitation: num(states, `${d}.precipitation_sum`),
            windSpeed: num(states, `${d}.wind_speed_10m_max`),
            windDir: num(states, `${d}.wind_direction_10m_dominant`),
        });
    }
    // Location = the segment between the instance (adapter.N) and the fixed ".weather" suffix.
    const m = root.match(/^[^.]+\.\d+\.(.+)$/);
    return {
        source: 'open-meteo-weather',
        location: m ? m[1].replace(/_/g, ' ') : undefined,
        units: { temp: '°C', wind: 'km/h', precip: 'mm' },
        current,
        forecast,
    };
}

function mapWunderground(root: string, states: StateValues): WeatherReport {
    const c = `${root}.forecast.current`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.temp`),
        feelsLike: num(states, `${c}.feelsLike`),
        humidity: num(states, `${c}.relativeHumidity`),
        condition: str(states, `${c}.weather`),
        windSpeed: num(states, `${c}.wind`),
        windDir: str(states, `${c}.windDirection`) ?? num(states, `${c}.windDegrees`),
        pressure: num(states, `${c}.pressure`),
        precipitation: num(states, `${c}.precipitationHour`),
    };
    const dayBase = (i: number): string => `${root}.forecast.${i}d`;
    const days = countDays(states, i => `${dayBase(i)}.tempMax`);
    const forecast: WeatherDay[] = [];
    for (let i = 0; i < days; i++) {
        const d = dayBase(i);
        forecast.push({
            day: i,
            date: str(states, `${d}.date`),
            tempMax: num(states, `${d}.tempMax`),
            tempMin: num(states, `${d}.tempMin`),
            condition: str(states, `${d}.state`),
            precipProbability: num(states, `${d}.precipitationChance`),
            precipitation: num(states, `${d}.precipitationAllDay`),
            windSpeed: num(states, `${d}.windSpeed`),
            windDir: str(states, `${d}.windDirection`),
        });
    }
    return { source: 'weatherunderground', units: { temp: '°C', wind: 'km/h', precip: 'mm' }, current, forecast };
}

function mapOpenWeatherMap(root: string, states: StateValues): WeatherReport {
    const c = `${root}.forecast.current`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.temperature`),
        feelsLike: num(states, `${c}.feelsLike`),
        humidity: num(states, `${c}.humidity`),
        condition: str(states, `${c}.state`) || str(states, `${c}.title`),
        windSpeed: num(states, `${c}.windSpeed`),
        windDir: str(states, `${c}.windDirectionText`) ?? num(states, `${c}.windDirection`),
        pressure: num(states, `${c}.pressure`),
        precipitation: num(states, `${c}.precipitationRain`),
    };
    const dayBase = (i: number): string => `${root}.forecast.day${i}`;
    const days = countDays(states, i => `${dayBase(i)}.temperatureMax`);
    const forecast: WeatherDay[] = [];
    for (let i = 0; i < days; i++) {
        const d = dayBase(i);
        forecast.push({
            day: i,
            date: str(states, `${d}.date`),
            tempMax: num(states, `${d}.temperatureMax`),
            tempMin: num(states, `${d}.temperatureMin`),
            condition: str(states, `${d}.state`) || str(states, `${d}.title`),
            precipitation: num(states, `${d}.precipitationRain`),
            windSpeed: num(states, `${d}.windSpeed`),
            windDir: str(states, `${d}.windDirectionText`),
        });
    }
    // OpenWeatherMap reports wind in m/s.
    return { source: 'openweathermap', units: { temp: '°C', wind: 'm/s', precip: 'mm' }, current, forecast };
}

function mapBrightsky(root: string, states: StateValues): WeatherReport {
    const c = `${root}.weather.current`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.temperature`),
        feelsLike: num(states, `${c}.apparent_temperature`),
        humidity: num(states, `${c}.relative_humidity`),
        condition: firstStr(states, [`${c}.conditionUI`, `${c}.condition`]),
        windSpeed: firstNum(states, [`${c}.wind_speed_60`, `${c}.wind_speed_10`, `${c}.wind_speed_30`]),
        windDir:
            firstStr(states, [`${c}.wind_bearing_text`]) ??
            firstNum(states, [`${c}.wind_direction_60`, `${c}.wind_direction_10`]),
        pressure: num(states, `${c}.pressure_msl`),
        precipitation: firstNum(states, [`${c}.precipitation_60`, `${c}.precipitation_10`]),
        cloudCover: num(states, `${c}.cloud_cover`),
    };
    const dayBase = (i: number): string => `${root}.weather.daily.${i}`;
    const days = countDays(states, i => `${dayBase(i)}.temperature_max`);
    const forecast: WeatherDay[] = [];
    for (let i = 0; i < days; i++) {
        const d = dayBase(i);
        forecast.push({
            day: i,
            date: firstStr(states, [`${d}.dayName_long`, `${d}.dayName_short`]),
            tempMax: num(states, `${d}.temperature_max`),
            tempMin: num(states, `${d}.temperature_min`),
            condition: str(states, `${d}.condition`),
            precipProbability: num(states, `${d}.precipitation_probability_median`),
            precipitation: num(states, `${d}.precipitation`),
            windSpeed: firstNum(states, [`${d}.wind_speed_max`, `${d}.wind_speed_median`]),
            windDir: num(states, `${d}.wind_direction_median`),
        });
    }
    return { source: 'brightsky', units: { temp: '°C', wind: 'km/h', precip: 'mm' }, current, forecast };
}

function mapPirate(root: string, states: StateValues): WeatherReport {
    const c = `${root}.weather.currently`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.temperature`),
        feelsLike: num(states, `${c}.apparentTemperature`),
        humidity: num(states, `${c}.humidity`),
        condition: str(states, `${c}.summary`),
        windSpeed: num(states, `${c}.windSpeed`),
        windDir: str(states, `${c}.windBearingText`) ?? num(states, `${c}.windBearing`),
        pressure: num(states, `${c}.pressure`),
        precipitation: num(states, `${c}.precipIntensity`),
        cloudCover: num(states, `${c}.cloudCover`),
    };
    const dayBase = (i: number): string => `${root}.weather.daily.${i}`;
    const days = countDays(states, i => `${dayBase(i)}.temperatureHigh`);
    const forecast: WeatherDay[] = [];
    for (let i = 0; i < days; i++) {
        const d = dayBase(i);
        forecast.push({
            day: i,
            date: str(states, `${d}.time`),
            tempMax: num(states, `${d}.temperatureHigh`),
            tempMin: num(states, `${d}.temperatureLow`),
            condition: str(states, `${d}.summary`),
            precipProbability: num(states, `${d}.precipProbability`),
            precipitation: firstNum(states, [`${d}.precipAccumulation`, `${d}.precipIntensity`]),
            windSpeed: num(states, `${d}.windSpeed`),
            windDir: str(states, `${d}.windBearingText`) ?? num(states, `${d}.windBearing`),
        });
    }
    // Pirate Weather defaults to SI units (wind m/s).
    return { source: 'pirate-weather', units: { temp: '°C', wind: 'm/s', precip: 'mm' }, current, forecast };
}

function mapAccuweather(root: string, states: StateValues): WeatherReport {
    const c = `${root}.Current`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.Temperature`),
        feelsLike: num(states, `${c}.RealFeelTemperature`),
        humidity: num(states, `${c}.RelativeHumidity`),
        condition: str(states, `${c}.WeatherText`),
        windSpeed: num(states, `${c}.WindSpeed`),
        windDir: str(states, `${c}.WindDirectionText`) ?? num(states, `${c}.WindDirection`),
        pressure: num(states, `${c}.Pressure`),
        cloudCover: num(states, `${c}.CloudCover`),
        uvIndex: num(states, `${c}.UVIndex`),
    };
    // AccuWeather days are the fixed folders Day1..Day5 (i logical → Day${i+1}).
    const dayBase = (i: number): string => `${root}.Daily.Day${i + 1}`;
    const days = countDays(states, i => `${dayBase(i)}.Temperature.Maximum`, 6);
    const forecast: WeatherDay[] = [];
    for (let i = 0; i < days; i++) {
        const d = dayBase(i);
        forecast.push({
            day: i,
            date: str(states, `${d}.Date`),
            tempMax: num(states, `${d}.Temperature.Maximum`),
            tempMin: num(states, `${d}.Temperature.Minimum`),
            condition: firstStr(states, [`${d}.Day.IconPhrase`, `${d}.Day.ShortPhrase`]),
            precipProbability: num(states, `${d}.Day.PrecipitationProbability`),
            windSpeed: num(states, `${d}.Day.WindSpeed`),
            windDir: str(states, `${d}.Day.WindDirection`),
        });
    }
    // Metric config is the default (°C, km/h).
    return { source: 'accuweather', units: { temp: '°C', wind: 'km/h', precip: 'mm' }, current, forecast };
}

function mapDasWetter(root: string, states: StateValues): WeatherReport {
    // Current is a copy of an hourly record (only present when CopyCurrentHour is enabled).
    const c = `${root}.ForecastHourly.Current`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.temperature`),
        feelsLike: num(states, `${c}.temperature_feels_like`),
        humidity: num(states, `${c}.humidity`),
        condition: str(states, `${c}.symbol_description`),
        windSpeed: num(states, `${c}.wind_speed`),
        windDir: str(states, `${c}.wind_direction`),
        pressure: num(states, `${c}.pressure`),
        precipitation: num(states, `${c}.rain`),
        cloudCover: num(states, `${c}.clouds`),
    };
    // Daily folders are Day_1..Day_5 (i logical → Day_${i+1}).
    const dayBase = (i: number): string => `${root}.ForecastDaily.Day_${i + 1}`;
    const days = countDays(states, i => `${dayBase(i)}.Temperature_Max`, 6);
    const forecast: WeatherDay[] = [];
    for (let i = 0; i < days; i++) {
        const d = dayBase(i);
        forecast.push({
            day: i,
            date: firstStr(states, [`${d}.NameOfDay`, `${d}.date`]),
            tempMax: num(states, `${d}.Temperature_Max`),
            tempMin: num(states, `${d}.Temperature_Min`),
            condition: str(states, `${d}.symbol_description`),
            precipProbability: num(states, `${d}.Rain_Probability`),
            precipitation: num(states, `${d}.Rain`),
            windSpeed: num(states, `${d}.Wind_Speed`),
            windDir: str(states, `${d}.Wind_Direction`),
        });
    }
    return { source: 'daswetter', units: { temp: '°C', wind: 'km/h', precip: 'mm' }, current, forecast };
}

function mapYr(root: string, states: StateValues): WeatherReport {
    // met.no is hourly-only; the nearest hour (`forecastHourly.0h`) is the closest thing to "current".
    const c = `${root}.forecastHourly.0h`;
    const current: WeatherCurrent = {
        temperature: num(states, `${c}.air_temperature`),
        humidity: num(states, `${c}.relative_humidity`),
        condition: firstStr(states, [`${c}.1h_summary_text`, `${c}.6h_summary_text`]),
        windSpeed: num(states, `${c}.wind_speed`),
        windDir: num(states, `${c}.wind_from_direction`),
        pressure: num(states, `${c}.air_pressure_at_sea_level`),
        precipitation: num(states, `${c}.1h_precipitation_amount`),
        cloudCover: num(states, `${c}.cloud_area_fraction`),
    };
    // No daily/multi-day branch in the yr adapter → forecast stays empty.
    return { source: 'yr', units: { temp: '°C', wind: 'm/s', precip: 'mm' }, current, forecast: [] };
}

/**
 * Build a normalized {@link WeatherReport} from a weather adapter's flat state map. `adapter` is the adapter
 * name (segment 0 of the instance id); `root` is the state prefix the data lives under (for Open-Meteo this
 * includes the location device, e.g. `open-meteo-weather.0.Berlin`). Returns null for adapters without a
 * mapper (the caller then falls back to a raw dump) or when no data is present.
 */
export function buildWeatherReport(adapter: string, root: string, states: StateValues): WeatherReport | null {
    const kind = WEATHER_ADAPTERS[adapter]?.kind;
    if (!kind) {
        return null;
    }
    const mappers: Record<WeatherKind, (root: string, states: StateValues) => WeatherReport> = {
        openmeteo: mapOpenMeteo,
        wunderground: mapWunderground,
        openweathermap: mapOpenWeatherMap,
        brightsky: mapBrightsky,
        pirate: mapPirate,
        accuweather: mapAccuweather,
        daswetter: mapDasWetter,
        yr: mapYr,
    };
    const report = mappers[kind](root, states);
    // Drop empty/undefined fields from `current` so the report is compact (and a data-less selection
    // collapses to no current at all, rather than a stray empty condition string).
    if (report.current) {
        report.current = Object.fromEntries(
            Object.entries(report.current).filter(([, v]) => v !== undefined && v !== ''),
        );
        if (!Object.keys(report.current).length) {
            report.current = undefined;
        }
    }
    if (!report.current && !report.forecast.length) {
        return null; // adapter selected but no data yet
    }
    return report;
}

/** Keep only the forecast days a question needs: 'current'/'today' → day 0, 'tomorrow' → day 1, 'week' → all. */
export function trimReport(report: WeatherReport, when?: string): WeatherReport {
    const w = (when || '').toLowerCase();
    if (w === 'tomorrow') {
        return { ...report, forecast: report.forecast.filter(d => d.day === 1) };
    }
    if (w === 'today' || w === 'current' || w === 'now') {
        return { ...report, forecast: report.forecast.filter(d => d.day === 0) };
    }
    return report; // 'week' / unspecified → everything
}

/** Localized wording for {@link buildWeatherPrompt} (the assistant's voice languages: de/en/ru). */
const PROMPT_LABELS: Record<string, Record<string, string>> = {
    en: {
        header: 'Current weather',
        feels: 'feels like',
        wind: 'wind',
        humidity: 'humidity',
        precip: 'precipitation',
        clouds: 'cloud cover',
        uv: 'UV index',
        pressure: 'pressure',
        today: 'Today',
        tomorrow: 'Tomorrow',
        chance: 'precipitation probability',
        max: 'max',
        min: 'min',
        hint: 'Answer weather questions from this data; call get_weather only for days beyond tomorrow.',
    },
    de: {
        header: 'Aktuelles Wetter',
        feels: 'gefühlt',
        wind: 'Wind',
        humidity: 'Luftfeuchte',
        precip: 'Niederschlag',
        clouds: 'Bewölkung',
        uv: 'UV-Index',
        pressure: 'Luftdruck',
        today: 'Heute',
        tomorrow: 'Morgen',
        chance: 'Niederschlagswahrscheinlichkeit',
        max: 'max.',
        min: 'min.',
        hint: 'Beantworte Wetterfragen aus diesen Daten; rufe get_weather nur für Tage nach morgen auf.',
    },
    ru: {
        header: 'Текущая погода',
        feels: 'ощущается как',
        wind: 'ветер',
        humidity: 'влажность',
        precip: 'осадки',
        clouds: 'облачность',
        uv: 'УФ-индекс',
        pressure: 'давление',
        today: 'Сегодня',
        tomorrow: 'Завтра',
        chance: 'вероятность осадков',
        max: 'макс.',
        min: 'мин.',
        hint: 'Отвечай на вопросы о погоде по этим данным; вызывай get_weather только для дней после завтра.',
    },
};

/** At most one decimal — weather values carry no meaningful precision beyond that. */
function fmtNum(v: number): string {
    return String(Math.round(v * 10) / 10);
}

/**
 * Compact, localized summary of the current conditions plus today/tomorrow, meant to be prepended to the
 * LLM's user turn so it can answer "how's the weather?" straight away — no `get_weather` round-trip, and
 * small/local models (which have no tools at all) can answer instead of inventing a forecast. Days beyond
 * tomorrow stay behind the tool so the injected block stays short. Returns '' if the report carries nothing.
 */
export function buildWeatherPrompt(report: WeatherReport, lang: string): string {
    const t = PROMPT_LABELS[lang] || PROMPT_LABELS.en;
    const u = report.units;
    const lines: string[] = [];
    const where = [WEATHER_ADAPTERS[report.source]?.label || report.source, report.location].filter(Boolean).join(', ');
    const c = report.current;
    if (c) {
        const parts: string[] = [];
        if (c.temperature !== undefined) {
            const feels = c.feelsLike !== undefined ? ` (${t.feels} ${fmtNum(c.feelsLike)} ${u.temp})` : '';
            parts.push(`${fmtNum(c.temperature)} ${u.temp}${feels}`);
        }
        if (c.condition) {
            parts.push(String(c.condition));
        }
        if (c.windSpeed !== undefined) {
            parts.push(`${t.wind} ${fmtNum(c.windSpeed)} ${u.wind}`);
        }
        if (c.humidity !== undefined) {
            parts.push(`${t.humidity} ${fmtNum(c.humidity)} %`);
        }
        if (c.precipitation !== undefined) {
            parts.push(`${t.precip} ${fmtNum(c.precipitation)} ${u.precip}`);
        }
        if (c.cloudCover !== undefined) {
            parts.push(`${t.clouds} ${fmtNum(c.cloudCover)} %`);
        }
        if (c.uvIndex !== undefined) {
            parts.push(`${t.uv} ${fmtNum(c.uvIndex)}`);
        }
        if (c.pressure !== undefined) {
            parts.push(`${t.pressure} ${fmtNum(c.pressure)} hPa`);
        }
        if (parts.length) {
            lines.push(`${t.header} (${where}): ${parts.join(', ')}.`);
        }
    }
    for (const d of report.forecast.filter(f => f.day === 0 || f.day === 1)) {
        const parts: string[] = [];
        if (d.tempMin !== undefined && d.tempMax !== undefined) {
            parts.push(`${fmtNum(d.tempMin)}…${fmtNum(d.tempMax)} ${u.temp}`);
        } else if (d.tempMax !== undefined) {
            parts.push(`${t.max} ${fmtNum(d.tempMax)} ${u.temp}`);
        } else if (d.tempMin !== undefined) {
            parts.push(`${t.min} ${fmtNum(d.tempMin)} ${u.temp}`);
        }
        if (d.condition) {
            parts.push(String(d.condition));
        }
        if (d.precipProbability !== undefined) {
            parts.push(`${t.chance} ${fmtNum(d.precipProbability)} %`);
        }
        if (d.precipitation !== undefined) {
            parts.push(`${t.precip} ${fmtNum(d.precipitation)} ${u.precip}`);
        }
        if (d.windSpeed !== undefined) {
            parts.push(`${t.wind} ${fmtNum(d.windSpeed)} ${u.wind}`);
        }
        if (parts.length) {
            lines.push(`${d.day === 0 ? t.today : t.tomorrow}: ${parts.join(', ')}.`);
        }
    }
    if (!lines.length) {
        return '';
    }
    lines.push(t.hint);
    return lines.join('\n');
}

/** WMO texts in the other voice languages, by the English text {@link wmoText} puts into a report. */
const WMO_LOCAL: Record<string, Record<string, string>> = {
    de: {
        'clear sky': 'klarer Himmel',
        'mainly clear': 'überwiegend klar',
        'partly cloudy': 'teilweise bewölkt',
        overcast: 'bedeckt',
        fog: 'Nebel',
        'depositing rime fog': 'Nebel mit Raureif',
        'light drizzle': 'leichter Nieselregen',
        drizzle: 'Nieselregen',
        'dense drizzle': 'starker Nieselregen',
        'freezing drizzle': 'gefrierender Nieselregen',
        'dense freezing drizzle': 'starker gefrierender Nieselregen',
        'slight rain': 'leichter Regen',
        rain: 'Regen',
        'heavy rain': 'starker Regen',
        'freezing rain': 'gefrierender Regen',
        'heavy freezing rain': 'starker gefrierender Regen',
        'slight snow': 'leichter Schneefall',
        snow: 'Schneefall',
        'heavy snow': 'starker Schneefall',
        'snow grains': 'Schneegriesel',
        'slight rain showers': 'leichte Regenschauer',
        'rain showers': 'Regenschauer',
        'violent rain showers': 'heftige Regenschauer',
        'snow showers': 'Schneeschauer',
        'heavy snow showers': 'starke Schneeschauer',
        thunderstorm: 'Gewitter',
        'thunderstorm with slight hail': 'Gewitter mit leichtem Hagel',
        'thunderstorm with heavy hail': 'Gewitter mit starkem Hagel',
    },
    ru: {
        'clear sky': 'ясно',
        'mainly clear': 'преимущественно ясно',
        'partly cloudy': 'переменная облачность',
        overcast: 'пасмурно',
        fog: 'туман',
        'depositing rime fog': 'туман с изморозью',
        'light drizzle': 'лёгкая морось',
        drizzle: 'морось',
        'dense drizzle': 'сильная морось',
        'freezing drizzle': 'ледяная морось',
        'dense freezing drizzle': 'сильная ледяная морось',
        'slight rain': 'небольшой дождь',
        rain: 'дождь',
        'heavy rain': 'сильный дождь',
        'freezing rain': 'ледяной дождь',
        'heavy freezing rain': 'сильный ледяной дождь',
        'slight snow': 'небольшой снег',
        snow: 'снег',
        'heavy snow': 'сильный снег',
        'snow grains': 'снежная крупа',
        'slight rain showers': 'небольшой ливень',
        'rain showers': 'ливень',
        'violent rain showers': 'сильный ливень',
        'snow showers': 'снегопад',
        'heavy snow showers': 'сильный снегопад',
        thunderstorm: 'гроза',
        'thunderstorm with slight hail': 'гроза с небольшим градом',
        'thunderstorm with heavy hail': 'гроза с сильным градом',
    },
};

/** Russian noun form after a number: 1 градус, 2 градуса, 5 градусов. */
function ruPlural(n: number, one: string, few: string, many: string): string {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) {
        return many;
    }
    return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

/** Wording of {@link buildWeatherAnswer}. */
const ANSWER_TEXT: Record<
    string,
    {
        degrees: (n: number) => string;
        percent: (n: number) => string;
        now: (temp: string) => string;
        feels: (temp: string) => string;
        range: (min: number, max: number) => string;
        chance: (p: string) => string;
        day: Record<'today' | 'tomorrow' | 'dayAfter', string>;
    }
> = {
    en: {
        degrees: n => `${n} ${Math.abs(n) === 1 ? 'degree' : 'degrees'}`,
        percent: n => `${n} percent`,
        now: temp => `It is ${temp} outside`,
        feels: temp => `feels like ${temp}`,
        range: (min, max) => `${min} to ${max} degrees`,
        chance: p => `${p} chance of rain`,
        day: { today: 'Today', tomorrow: 'Tomorrow', dayAfter: 'The day after tomorrow' },
    },
    de: {
        degrees: n => `${n} Grad`,
        percent: n => `${n} Prozent`,
        now: temp => `Draußen sind es ${temp}`,
        feels: temp => `gefühlt ${temp}`,
        range: (min, max) => `${min} bis ${max} Grad`,
        chance: p => `Regenwahrscheinlichkeit ${p}`,
        day: { today: 'Heute', tomorrow: 'Morgen', dayAfter: 'Übermorgen' },
    },
    ru: {
        degrees: n => `${n} ${ruPlural(n, 'градус', 'градуса', 'градусов')}`,
        percent: n => `${n} ${ruPlural(n, 'процент', 'процента', 'процентов')}`,
        now: temp => `Сейчас на улице ${temp}`,
        feels: temp => `ощущается как ${temp}`,
        range: (min, max) => `от ${min} до ${max} ${ruPlural(max, 'градуса', 'градусов', 'градусов')}`,
        chance: p => `вероятность осадков ${p}`,
        day: { today: 'Сегодня', tomorrow: 'Завтра', dayAfter: 'Послезавтра' },
    },
};

/** A condition text in the answer language: WMO texts are translated, adapter texts are kept as they come. */
function localCondition(condition: string, lang: string): string {
    const text = String(condition).trim();
    return WMO_LOCAL[lang]?.[text.toLowerCase()] || text;
}

/**
 * The spoken answer to a weather question, straight from the report — no LLM. `now` gives the current
 * conditions plus today's range; `today`/`tomorrow`/`dayAfter` give that forecast day. Returns '' when the
 * report has nothing for the asked day, so the caller can hand the question on.
 */
export function buildWeatherAnswer(
    report: WeatherReport,
    lang: string,
    when: 'now' | 'today' | 'tomorrow' | 'dayAfter' = 'now',
): string {
    const t = ANSWER_TEXT[lang] || ANSWER_TEXT.en;
    const r = Math.round;
    const sentences: string[] = [];
    const c = report.current;
    if (when === 'now' && c && (c.temperature !== undefined || c.condition)) {
        const parts: string[] = [];
        if (c.temperature !== undefined) {
            parts.push(t.now(t.degrees(r(c.temperature))));
            // Only worth a word when it differs noticeably (wind chill, humid heat).
            if (c.feelsLike !== undefined && Math.abs(c.feelsLike - c.temperature) >= 3) {
                parts.push(t.feels(t.degrees(r(c.feelsLike))));
            }
        }
        if (c.condition) {
            parts.push(localCondition(c.condition, lang));
        }
        sentences.push(`${parts.join(', ')}.`);
    }
    const dayIndex = when === 'tomorrow' ? 1 : when === 'dayAfter' ? 2 : 0;
    const d = report.forecast.find(f => f.day === dayIndex);
    let dayParts = 0;
    if (d) {
        const parts: string[] = [];
        if (d.tempMin !== undefined && d.tempMax !== undefined) {
            parts.push(t.range(r(d.tempMin), r(d.tempMax)));
        } else if (d.tempMax !== undefined) {
            parts.push(t.degrees(r(d.tempMax)));
        }
        if (d.condition) {
            parts.push(localCondition(d.condition, lang));
        }
        if (d.precipProbability !== undefined) {
            parts.push(t.chance(t.percent(r(d.precipProbability))));
        }
        if (parts.length) {
            dayParts = parts.length;
            sentences.push(`${t.day[when === 'now' ? 'today' : when]} ${parts.join(', ')}.`);
        }
    }
    // A forecast day without data cannot be answered from the current conditions.
    if (when !== 'now' && !dayParts) {
        return '';
    }
    return sentences.join(' ');
}
