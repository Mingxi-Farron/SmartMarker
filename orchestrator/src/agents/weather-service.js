function weatherCodeToText(code) {
  const map = {
    0: '晴',
    1: '大部晴朗',
    2: '局部多云',
    3: '阴',
    45: '雾',
    48: '冻雾',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '强毛毛雨',
    56: '冻毛毛雨',
    57: '强冻毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    66: '冻雨',
    67: '强冻雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    77: '冰粒',
    80: '阵雨',
    81: '较强阵雨',
    82: '暴雨',
    85: '阵雪',
    86: '强阵雪',
    95: '雷阵雨',
    96: '雷暴夹小冰雹',
    99: '雷暴夹大冰雹'
  };
  return map[Number(code)] || '未知天气';
}

function safeNumber(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  const fixed = Number(n.toFixed(Math.max(0, digits)));
  return Number.isFinite(fixed) ? fixed : null;
}

export class WeatherService {
  constructor({ timeoutMs = 12000 } = {}) {
    this.timeoutMs = Math.max(3000, Math.min(30000, Number(timeoutMs) || 12000));
  }

  async fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`天气接口失败 ${res.status}: ${text || 'unknown error'}`);
      }
      return await res.json();
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`天气接口超时（>${this.timeoutMs}ms）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async geocode(cityName) {
    const q = encodeURIComponent(String(cityName || '').trim());
    if (!q) {
      throw new Error('缺少城市名');
    }
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${q}&count=8&language=zh&format=json`;
    const data = await this.fetchJson(geoUrl);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) {
      throw new Error(`未找到城市：${cityName}`);
    }

    const chosen =
      results.find((item) => String(item?.country_code || '').toUpperCase() === 'CN') || results[0];
    return {
      name: chosen.name || cityName,
      admin1: chosen.admin1 || '',
      country: chosen.country || '',
      latitude: Number(chosen.latitude),
      longitude: Number(chosen.longitude),
      timezone: chosen.timezone || 'Asia/Shanghai'
    };
  }

  async get7DayForecast({ cityName }) {
    const location = await this.geocode(cityName);
    const query = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      timezone: location.timezone || 'Asia/Shanghai',
      forecast_days: '7',
      daily: [
        'weathercode',
        'temperature_2m_max',
        'temperature_2m_min',
        'precipitation_probability_max',
        'wind_speed_10m_max'
      ].join(',')
    });
    const forecastUrl = `https://api.open-meteo.com/v1/forecast?${query.toString()}`;
    const data = await this.fetchJson(forecastUrl);

    const daily = data?.daily || {};
    const dates = Array.isArray(daily.time) ? daily.time : [];
    const list = dates.map((date, idx) => ({
      date,
      weather: weatherCodeToText(daily.weathercode?.[idx]),
      maxC: safeNumber(daily.temperature_2m_max?.[idx], 1),
      minC: safeNumber(daily.temperature_2m_min?.[idx], 1),
      precipitationProbMax: safeNumber(daily.precipitation_probability_max?.[idx], 0),
      windMaxKmh: safeNumber(daily.wind_speed_10m_max?.[idx], 1)
    }));

    return {
      city: location.name,
      admin1: location.admin1,
      country: location.country,
      timezone: location.timezone,
      days: list
    };
  }

  formatForecastText(report) {
    const cityText = [report?.city, report?.admin1].filter(Boolean).join(' ');
    const lines = [];
    lines.push(`${cityText || '目标城市'}未来 7 天天气（时区：${report?.timezone || 'Asia/Shanghai'}）`);
    for (const day of report?.days || []) {
      lines.push(
        `${day.date}: ${day.weather}，${day.minC ?? '-'}~${day.maxC ?? '-'}°C，降水概率${day.precipitationProbMax ?? '-'}%，最大风速${day.windMaxKmh ?? '-'}km/h`,
      );
    }
    return lines.join('\n');
  }
}
