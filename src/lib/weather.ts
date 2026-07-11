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
