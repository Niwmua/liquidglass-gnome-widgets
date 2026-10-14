// Port of 1-common/components/WeatherData.qml: fetches the forecast from
// Open-Meteo (no account or key) and turns it into what the weather card
// shows.
//
// The raw response is kept and the view model is rebuilt from it on demand
// (view()), so the hourly strip and day/night state move on with the clock
// between fetches. Times are converted with the location's UTC offset, so a
// city in another time zone shows its own local hours.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const REFRESH_SECONDS = 30 * 60;
const RETRY_SECONDS = [5, 10, 20, 40, 80, 160, 300];

export function iconNameForCode(code, night) {
    if (code === 0) return night ? 'clearnight' : 'sunny';
    if (code === 1 || code === 2) return night ? 'partlycloudynight' : 'partlysunny';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code === 51 || code === 53 || code === 55) return night ? 'nightdrizzle' : 'drizzle';
    if (code === 56 || code === 57) return 'sleet';
    if (code === 61 || code === 63) return 'rain';
    if (code === 65) return 'heavyrain';
    if (code === 66 || code === 67) return 'sleet';
    if (code === 71 || code === 73 || code === 75) return 'snow';
    if (code === 77) return 'scatteredsnow';
    if (code === 80 || code === 81) return 'rain';
    if (code === 82) return 'heavyrain';
    if (code === 85 || code === 86) return 'scatteredsnow';
    if (code === 95 || code === 96 || code === 99) return 'thunderbolt';
    return night ? 'clearnight' : 'sunny';
}

function conditionForCode(code) {
    switch (code) {
    case 0: return _('Clear');
    case 1: return _('Mainly Clear');
    case 2: return _('Partly Cloudy');
    case 3: return _('Overcast');
    case 45: return _('Fog');
    case 48: return _('Rime Fog');
    case 51: return _('Light Drizzle');
    case 53: return _('Drizzle');
    case 55: return _('Dense Drizzle');
    case 56: return _('Freezing Drizzle');
    case 57: return _('Heavy Freezing Drizzle');
    case 61: return _('Slight Rain');
    case 63: return _('Rain');
    case 65: return _('Heavy Rain');
    case 66: return _('Freezing Rain');
    case 67: return _('Heavy Freezing Rain');
    case 71: return _('Slight Snow');
    case 73: return _('Snow');
    case 75: return _('Heavy Snow');
    case 77: return _('Snow Grains');
    case 80: return _('Light Showers');
    case 81: return _('Showers');
    case 82: return _('Heavy Showers');
    case 85: return _('Light Snow Showers');
    case 86: return _('Heavy Snow Showers');
    case 95: return _('Thunderstorm');
    case 96: return _('Thunderstorm with Hail');
    case 99: return _('Heavy Thunderstorm');
    default: return _('Unknown');
    }
}

function gradientCategoryForCode(code, night) {
    if (code === 0 || code === 1) return night ? 'nightclear' : 'clear';
    if (code === 2) return night ? 'nightcloudy' : 'clear';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return night ? 'nightclear' : 'clear';
}

function isPrecipCode(code) {
    return (code >= 51 && code <= 67) || (code >= 71 && code <= 77) ||
        (code >= 80 && code <= 86) || (code >= 95 && code <= 99);
}

function compassDirection(degrees) {
    const dirs = [_('N'), _('NE'), _('E'), _('SE'), _('S'), _('SW'), _('W'), _('NW')];
    return dirs[Math.round(degrees / 45) % 8];
}

// Open-Meteo local time ("2026-10-12T14:00" or "2026-10-12") -> epoch ms,
// given the location's offset from UTC.
function parseLocal(str, offsetSeconds) {
    const [date, time = '00:00'] = str.split('T');
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    return Date.UTC(y, mo - 1, d, h, mi) - offsetSeconds * 1000;
}

export class WeatherClient {
    // onChanged() runs after every fetch, successful or not.
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._session = new Soup.Session({
            user_agent: 'liquidglass-widgets (GNOME Shell extension)',
            timeout: 30,
        });
        this._cancellable = null;
        this._retrySourceId = 0;
        this._failCount = 0;

        this._place = null;     // {name, latitude, longitude, unit}
        this._data = null;      // last good forecast response
        this._fetchedAt = 0;    // Date.now() when _data arrived
        this.error = null;      // user-facing message, or null
    }

    get hasData() {
        return this._data !== null;
    }

    get loading() {
        return this._cancellable !== null;
    }

    // name: shown and used for lookup; latitude/longitude: both 0 means
    // "look the name up first". unit: 0 = Celsius, 1 = Fahrenheit.
    setPlace(name, latitude, longitude, unit) {
        const sameSpot = this._place &&
            this._place.latitude === latitude && this._place.longitude === longitude &&
            this._place.name === name && this._place.unit === unit;
        if (sameSpot)
            return;

        this._place = {name, latitude, longitude, unit};
        this._data = null;
        this.error = null;
        this.refresh();
    }

    refresh() {
        this._cancelRequest();
        this._clearRetry();
        this._failCount = 0;
        this._load();
    }

    // Called every minute by the widget: refetches once the data is old.
    // Uses wall-clock age, so a resume from suspend refreshes right away.
    refreshIfStale() {
        // A failed lookup ("Location not found") waits for new settings.
        if (this.loading || this._retrySourceId || (this.error && !this._data))
            return;
        const ageSeconds = (Date.now() - this._fetchedAt) / 1000;
        if (!this._data || ageSeconds >= REFRESH_SECONDS)
            this._load();
    }

    destroy() {
        this._cancelRequest();
        this._clearRetry();
        this._session.abort();
        this._session = null;
    }

    async _load() {
        const place = this._place;
        if (!place)
            return;

        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        try {
            if (place.latitude === 0 && place.longitude === 0) {
                const results = await this._getJson(GEOCODE_URL, {
                    name: place.name, count: '1', format: 'json',
                }, cancellable);
                const hit = results.results?.[0];
                if (!hit) {
                    this._finish(cancellable, _('Location not found'), false);
                    return;
                }
                place.latitude = hit.latitude;
                place.longitude = hit.longitude;
            }

            this._data = await this._getJson(FORECAST_URL, {
                latitude: String(place.latitude),
                longitude: String(place.longitude),
                current: 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m',
                hourly: 'temperature_2m,weather_code',
                daily: 'temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset',
                temperature_unit: place.unit === 1 ? 'fahrenheit' : 'celsius',
                wind_speed_unit: 'kmh',
                timezone: 'auto',
                forecast_days: '7',
            }, cancellable);
            this._fetchedAt = Date.now();
            this._finish(cancellable, null, false);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`liquidglass-widgets: weather: ${e.message}`);
            this._finish(cancellable, _('Weather unavailable'), true);
        }
    }

    _finish(cancellable, error, retry) {
        if (cancellable !== this._cancellable)
            return;
        this._cancellable = null;
        this.error = error;

        if (retry) {
            this._scheduleRetry();
        } else {
            this._failCount = 0;
            this._clearRetry();
        }
        this._onChanged();
    }

    _getJson(url, params, cancellable) {
        const query = Object.entries(params)
            .map(([k, v]) => `${k}=${GLib.Uri.escape_string(v, null, false)}`)
            .join('&');
        const message = Soup.Message.new('GET', `${url}?${query}`);

        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable,
                (session, result) => {
                    try {
                        const bytes = session.send_and_read_finish(result);
                        const status = message.get_status();
                        if (status !== Soup.Status.OK)
                            throw new Error(`HTTP ${status} from ${url}`);
                        resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _scheduleRetry() {
        const delay = RETRY_SECONDS[Math.min(this._failCount, RETRY_SECONDS.length - 1)];
        this._failCount++;
        this._clearRetry();
        this._retrySourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retrySourceId = 0;
            this._load();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearRetry() {
        if (this._retrySourceId)
            GLib.source_remove(this._retrySourceId);
        this._retrySourceId = 0;
    }

    _cancelRequest() {
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    // --- View model ---

    // What the card shows right now, or null before the first forecast.
    // formatHour(hours, minutes) -> label for the hourly strip.
    view(formatHour) {
        const data = this._data;
        if (!data?.current || !data.daily || !data.hourly)
            return null;

        const offset = data.utc_offset_seconds ?? 0;
        const now = Date.now();
        const daily = data.daily;
        const sunrise = parseLocal(daily.sunrise[0], offset);
        const sunset = parseLocal(daily.sunset[0], offset);
        const dayMs = 86400000;
        const localDay = t => Math.floor((t + offset * 1000) / dayMs);
        const isNightAt = t => {
            // Today's sunrise/sunset, moved by whole days onto t's date.
            const shift = (localDay(t) - localDay(sunrise)) * dayMs;
            return t < sunrise + shift || t >= sunset + shift;
        };
        // Location-local wall time for a timestamp.
        const local = t => new Date(t + offset * 1000);
        const label = t => formatHour(local(t).getUTCHours(), local(t).getUTCMinutes());

        const night = isNightAt(now);
        const code = data.current.weather_code ?? 0;
        const round = v => Math.round(v);

        // Next 7 whole hours plus today's sunrise/sunset if they fall
        // inside them; 6 slots in all.
        const hourly = [];
        for (let i = 0; i < data.hourly.time.length && hourly.length < 7; i++) {
            const t = parseLocal(data.hourly.time[i], offset);
            if (t <= now)
                continue;
            hourly.push({
                time: t,
                label: label(t),
                temp: `${round(data.hourly.temperature_2m[i])}°`,
                icon: iconNameForCode(data.hourly.weather_code[i], isNightAt(t)),
                sunEvent: false,
            });
        }
        if (hourly.length > 0) {
            const last = hourly[hourly.length - 1].time;
            for (const [t, icon, text] of [[sunrise, 'sunrise', _('Sunrise')], [sunset, 'sunset', _('Sunset')]]) {
                if (t > now && t < last)
                    hourly.push({time: t, label: label(t), temp: text, icon, sunEvent: true});
            }
        }
        hourly.sort((a, b) => a.time - b.time);

        // Days 1..5; the range bar spans the lowest and highest of them
        // and today.
        const days = [];
        let overallLow = round(daily.temperature_2m_min[0]);
        let overallHigh = round(daily.temperature_2m_max[0]);
        for (let i = 1; i <= 5 && i < daily.time.length; i++) {
            const low = round(daily.temperature_2m_min[i]);
            const high = round(daily.temperature_2m_max[i]);
            overallLow = Math.min(overallLow, low);
            overallHigh = Math.max(overallHigh, high);
            days.push({
                name: new Date(parseLocal(daily.time[i], 0))
                    .toLocaleDateString(undefined, {weekday: 'short', timeZone: 'UTC'}),
                icon: iconNameForCode(daily.weather_code[i], false),
                low,
                high,
            });
        }

        let dryDays = 0;
        while (dryDays < daily.weather_code.length && !isPrecipCode(daily.weather_code[dryDays]))
            dryDays++;
        let precipitation;
        if (dryDays === 0)
            precipitation = _('Precipitation expected today');
        else if (dryDays === 1)
            precipitation = _('Precipitation expected tomorrow');
        else
            precipitation = ngettext('No precipitation for %d day', 'No precipitation for %d days', dryDays)
                .replace('%d', dryDays);

        return {
            city: this._place.name,
            temp: `${round(data.current.temperature_2m)}°`,
            high: `${round(daily.temperature_2m_max[0])}°`,
            low: `${round(daily.temperature_2m_min[0])}°`,
            icon: iconNameForCode(code, night),
            condition: conditionForCode(code),
            category: gradientCategoryForCode(code, night),
            wind: _('%s km/h %s')
                .replace('%s', round(data.current.wind_speed_10m))
                .replace('%s', compassDirection(data.current.wind_direction_10m ?? 0)),
            precipitation,
            hourly: hourly.slice(0, 6),
            days,
            overallLow,
            overallHigh,
        };
    }
}
