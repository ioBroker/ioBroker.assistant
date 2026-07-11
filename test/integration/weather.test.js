'use strict';
// Integration test: weather adapter normalization (open-meteo-weather / weatherunderground / openweathermap).
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWeatherReport, trimReport, wmoText, WEATHER_ADAPTERS } = require('../../build/lib/weather.js');

test('wmoText maps codes, empty for unknown', () => {
    assert.equal(wmoText(0), 'clear sky');
    assert.equal(wmoText(61), 'slight rain');
    assert.equal(wmoText(95), 'thunderstorm');
    assert.equal(wmoText(1234), '');
    assert.equal(wmoText('3'), 'overcast');
});

test('open-meteo mapper: current + forecast, derives text from code', () => {
    const root = 'open-meteo-weather.0.Berlin';
    const s = {
        [`${root}.weather.current.temperature_2m`]: 12.4,
        [`${root}.weather.current.apparent_temperature`]: 10,
        [`${root}.weather.current.relative_humidity_2m`]: 80,
        [`${root}.weather.current.weather_code`]: 3, // no weather_text → derived "overcast"
        [`${root}.weather.current.wind_speed_10m`]: 15,
        [`${root}.weather.current.wind_direction_text`]: 'NW',
        [`${root}.weather.current.pressure_msl`]: 1012,
        [`${root}.weather.current.precipitation`]: 0,
        [`${root}.weather.forecast.day0.temperature_2m_max`]: 14,
        [`${root}.weather.forecast.day0.temperature_2m_min`]: 6,
        [`${root}.weather.forecast.day0.weather_text`]: 'Rain',
        [`${root}.weather.forecast.day0.precipitation_probability_max`]: 60,
        [`${root}.weather.forecast.day1.temperature_2m_max`]: 16,
        [`${root}.weather.forecast.day1.temperature_2m_min`]: 7,
        [`${root}.weather.forecast.day1.weather_code`]: 0,
    };
    const r = buildWeatherReport('open-meteo-weather', root, s);
    assert.equal(r.source, 'open-meteo-weather');
    assert.equal(r.location, 'Berlin');
    assert.equal(r.current.temperature, 12.4);
    assert.equal(r.current.condition, 'overcast');
    assert.equal(r.current.windDir, 'NW');
    assert.equal(r.forecast.length, 2);
    assert.equal(r.forecast[0].tempMax, 14);
    assert.equal(r.forecast[0].condition, 'Rain');
    assert.equal(r.forecast[0].precipProbability, 60);
    assert.equal(r.forecast[1].condition, 'clear sky'); // from code 0
});

test('weatherunderground mapper', () => {
    const root = 'weatherunderground.0';
    const s = {
        [`${root}.forecast.current.temp`]: 9,
        [`${root}.forecast.current.weather`]: 'Cloudy',
        [`${root}.forecast.current.relativeHumidity`]: 72,
        [`${root}.forecast.current.wind`]: 11,
        [`${root}.forecast.current.windDirection`]: 'SW',
        [`${root}.forecast.0d.tempMax`]: 12,
        [`${root}.forecast.0d.tempMin`]: 4,
        [`${root}.forecast.0d.state`]: 'Rain',
        [`${root}.forecast.0d.precipitationChance`]: 80,
    };
    const r = buildWeatherReport('weatherunderground', root, s);
    assert.equal(r.source, 'weatherunderground');
    assert.equal(r.current.temperature, 9);
    assert.equal(r.current.condition, 'Cloudy');
    assert.equal(r.forecast.length, 1);
    assert.equal(r.forecast[0].tempMax, 12);
    assert.equal(r.forecast[0].precipProbability, 80);
});

test('openweathermap mapper (wind in m/s)', () => {
    const root = 'openweathermap.0';
    const s = {
        [`${root}.forecast.current.temperature`]: 8,
        [`${root}.forecast.current.state`]: 'Clear',
        [`${root}.forecast.current.windSpeed`]: 3,
        [`${root}.forecast.day0.temperatureMax`]: 11,
        [`${root}.forecast.day0.temperatureMin`]: 2,
        [`${root}.forecast.day0.state`]: 'Sunny',
    };
    const r = buildWeatherReport('openweathermap', root, s);
    assert.equal(r.units.wind, 'm/s');
    assert.equal(r.current.temperature, 8);
    assert.equal(r.forecast[0].condition, 'Sunny');
});

test('brightsky mapper (numeric daily, windowed current, conditionUI)', () => {
    const root = 'brightsky.0';
    const s = {
        [`${root}.weather.current.temperature`]: 7,
        [`${root}.weather.current.conditionUI`]: 'Regen',
        [`${root}.weather.current.relative_humidity`]: 88,
        [`${root}.weather.current.wind_speed_60`]: 18,
        [`${root}.weather.current.pressure_msl`]: 1005,
        [`${root}.weather.current.precipitation_60`]: 1.2,
        [`${root}.weather.daily.0.temperature_max`]: 9,
        [`${root}.weather.daily.0.temperature_min`]: 3,
        [`${root}.weather.daily.0.condition`]: 'rain',
        [`${root}.weather.daily.0.precipitation_probability_median`]: 70,
        [`${root}.weather.daily.1.temperature_max`]: 11,
    };
    const r = buildWeatherReport('brightsky', root, s);
    assert.equal(r.current.temperature, 7);
    assert.equal(r.current.condition, 'Regen');
    assert.equal(r.current.windSpeed, 18);
    assert.equal(r.forecast.length, 2);
    assert.equal(r.forecast[0].precipProbability, 70);
});

test('pirate-weather mapper (m/s, temperatureHigh/Low)', () => {
    const root = 'pirate-weather.0';
    const s = {
        [`${root}.weather.currently.temperature`]: 14,
        [`${root}.weather.currently.summary`]: 'Cloudy',
        [`${root}.weather.currently.windSpeed`]: 4,
        [`${root}.weather.daily.0.temperatureHigh`]: 17,
        [`${root}.weather.daily.0.temperatureLow`]: 9,
        [`${root}.weather.daily.0.summary`]: 'Rain',
        [`${root}.weather.daily.0.precipProbability`]: 55,
    };
    const r = buildWeatherReport('pirate-weather', root, s);
    assert.equal(r.units.wind, 'm/s');
    assert.equal(r.current.temperature, 14);
    assert.equal(r.forecast[0].tempMax, 17);
    assert.equal(r.forecast[0].tempMin, 9);
});

test('accuweather mapper (Day1.. folders, nested Temperature.Min/Max)', () => {
    const root = 'accuweather.0';
    const s = {
        [`${root}.Current.Temperature`]: 6,
        [`${root}.Current.WeatherText`]: 'Cloudy',
        [`${root}.Current.WindSpeed`]: 10,
        [`${root}.Daily.Day1.Temperature.Maximum`]: 8,
        [`${root}.Daily.Day1.Temperature.Minimum`]: 1,
        [`${root}.Daily.Day1.Day.IconPhrase`]: 'Showers',
        [`${root}.Daily.Day1.Day.PrecipitationProbability`]: 65,
        [`${root}.Daily.Day2.Temperature.Maximum`]: 10,
        [`${root}.Daily.Day2.Temperature.Minimum`]: 2,
    };
    const r = buildWeatherReport('accuweather', root, s);
    assert.equal(r.current.temperature, 6);
    assert.equal(r.forecast.length, 2);
    assert.equal(r.forecast[0].tempMax, 8);
    assert.equal(r.forecast[0].tempMin, 1);
    assert.equal(r.forecast[0].condition, 'Showers');
    assert.equal(r.forecast[0].precipProbability, 65);
});

test('daswetter mapper (per-location root, Day_1.. folders)', () => {
    const root = 'daswetter.0.location_1';
    const s = {
        [`${root}.ForecastHourly.Current.temperature`]: 5,
        [`${root}.ForecastHourly.Current.symbol_description`]: 'Bewölkt',
        [`${root}.ForecastDaily.Day_1.Temperature_Max`]: 7,
        [`${root}.ForecastDaily.Day_1.Temperature_Min`]: 0,
        [`${root}.ForecastDaily.Day_1.symbol_description`]: 'Regen',
        [`${root}.ForecastDaily.Day_1.Rain_Probability`]: 75,
        [`${root}.ForecastDaily.Day_2.Temperature_Max`]: 9,
    };
    const r = buildWeatherReport('daswetter', root, s);
    assert.equal(r.current.temperature, 5);
    assert.equal(r.current.condition, 'Bewölkt');
    assert.equal(r.forecast.length, 2);
    assert.equal(r.forecast[0].tempMax, 7);
    assert.equal(r.forecast[0].precipProbability, 75);
});

test('yr mapper (hourly-only: current from 0h, no daily)', () => {
    const root = 'yr.0';
    const s = {
        [`${root}.forecastHourly.0h.air_temperature`]: 3,
        [`${root}.forecastHourly.0h.relative_humidity`]: 90,
        [`${root}.forecastHourly.0h.wind_speed`]: 5,
        [`${root}.forecastHourly.0h.1h_summary_text`]: 'lightrain',
        [`${root}.forecastHourly.0h.air_pressure_at_sea_level`]: 1008,
    };
    const r = buildWeatherReport('yr', root, s);
    assert.equal(r.units.wind, 'm/s');
    assert.equal(r.current.temperature, 3);
    assert.equal(r.current.condition, 'lightrain');
    assert.equal(r.forecast.length, 0); // yr adapter has no daily branch
});

test('unknown adapter → null (caller does the raw dump)', () => {
    assert.equal(buildWeatherReport('dwd', 'dwd.0', { 'dwd.0.x': 1 }), null);
});

test('known adapter but no data → null', () => {
    assert.equal(buildWeatherReport('open-meteo-weather', 'open-meteo-weather.0.Berlin', {}), null);
});

test('trimReport selects the right days', () => {
    const report = {
        source: 'x',
        units: { temp: '°C', wind: 'km/h', precip: 'mm' },
        current: { temperature: 10 },
        forecast: [{ day: 0 }, { day: 1 }, { day: 2 }],
    };
    assert.equal(trimReport(report, 'today').forecast.length, 1);
    assert.equal(trimReport(report, 'tomorrow').forecast[0].day, 1);
    assert.equal(trimReport(report, 'week').forecast.length, 3);
    assert.equal(trimReport(report, undefined).forecast.length, 3);
});

test('registry: understood adapters have a kind, per-location ones a probe', () => {
    assert.equal(WEATHER_ADAPTERS['open-meteo-weather'].kind, 'openmeteo');
    assert.equal(WEATHER_ADAPTERS['weatherunderground'].kind, 'wunderground');
    assert.equal(WEATHER_ADAPTERS['brightsky'].kind, 'brightsky');
    assert.equal(WEATHER_ADAPTERS['pirate-weather'].kind, 'pirate');
    assert.equal(WEATHER_ADAPTERS['accuweather'].kind, 'accuweather');
    assert.equal(WEATHER_ADAPTERS['daswetter'].kind, 'daswetter');
    assert.equal(WEATHER_ADAPTERS['yr'].kind, 'yr');
    assert.ok(WEATHER_ADAPTERS['open-meteo-weather'].perLocationProbe);
    assert.ok(WEATHER_ADAPTERS['daswetter'].perLocationProbe);
    assert.equal(WEATHER_ADAPTERS['dwd'].kind, undefined); // warnings only, no mapper
});
