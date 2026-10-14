import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Glass keys restored by "Reset" on the Appearance page.
const GLASS_KEYS = [
    'corner-radius', 'roundness-x10', 'refract-thickness', 'refract-ior-x100',
    'refract-scale', 'tint-alpha-pct', 'chroma-strength-pct', 'spec-strength-pct',
    'blur-radius-px',
];

// Slider + value label in a row; same ranges as the KDE Appearance page.
function sliderRow(settings, key, title, {lower, upper, step = 1, format}) {
    const adjustment = new Gtk.Adjustment({
        lower, upper, step_increment: step, page_increment: step * 5,
    });
    const scale = new Gtk.Scale({
        adjustment,
        draw_value: false,
        hexpand: true,
        valign: Gtk.Align.CENTER,
        width_request: 220,
    });
    const value = new Gtk.Label({width_chars: 7, xalign: 1, css_classes: ['dim-label', 'numeric']});

    const row = new Adw.ActionRow({title});
    row.add_suffix(scale);
    row.add_suffix(value);

    const load = () => {
        adjustment.value = settings.get_int(key);
        value.label = format(settings.get_int(key));
    };
    adjustment.connect('value-changed', () => {
        const v = Math.round(adjustment.value / step) * step;
        value.label = format(v);
        if (settings.get_int(key) !== v)
            settings.set_int(key, v);
    });
    settings.connect(`changed::${key}`, load);
    load();
    return row;
}

function comboRow(settings, key, title, choices) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(choices)});
    row.selected = settings.get_int(key);
    row.connect('notify::selected', () => settings.set_int(key, row.selected));
    settings.connect(`changed::${key}`, () => {
        row.selected = settings.get_int(key);
    });
    return row;
}

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', 0);
    return row;
}

function spinRow(settings, key, title, {lower, upper, step}) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', 0);
    return row;
}

function positionRow(settings, prefix) {
    const row = new Adw.ActionRow({title: _('Position')});
    const reset = new Gtk.Button({label: _('Reset'), valign: Gtk.Align.CENTER});
    reset.connect('clicked', () => {
        settings.set_int(`${prefix}-x`, -1);
        settings.set_int(`${prefix}-y`, -1);
    });
    row.add_suffix(reset);
    return row;
}

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Open-Meteo place search: resolves to [{name, latitude, longitude, region}].
function searchPlaces(session, query) {
    const url = `${GEOCODE_URL}?name=${GLib.Uri.escape_string(query, null, false)}&count=8&format=json`;
    const message = Soup.Message.new('GET', url);
    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_s, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== Soup.Status.OK)
                    throw new Error(`HTTP ${message.get_status()}`);
                const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                resolve((json.results ?? []).map(r => ({
                    name: r.name,
                    latitude: r.latitude,
                    longitude: r.longitude,
                    region: [r.admin1, r.country].filter(Boolean).join(', '),
                })));
            } catch (e) {
                reject(e);
            }
        });
    });
}

const percent = v => _('%s%').replace('%s', v);
const pixels = v => _('%s px').replace('%s', v);

export default class LiquidGlassWidgetsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(640, 720);

        window.add(this._clocksPage(settings));
        window.add(this._widgetsPage(settings));
        window.add(this._appearancePage(settings));
    }

    _widgetsPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Widgets'),
            icon_name: 'preferences-desktop-apps-symbolic',
        });

        const general = new Adw.PreferencesGroup({title: _('All Widgets')});
        general.add(switchRow(settings, 'lock-position', _('Lock position'),
            _('Stop widgets from moving when dragged.')));

        page.add(this._calendarGroup(settings));
        page.add(this._weatherGroup(settings));
        page.add(this._timerGroup(settings));
        page.add(this._musicGroup(settings));
        page.add(general);
        return page;
    }

    _clocksPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Clocks'),
            icon_name: 'preferences-system-time-symbolic',
        });
        page.add(this._clockGroup(settings, 'clock-analog', _('Clock I'), {
            description: _('Numbered dial. Drag a clock with the left mouse button; right-click it for options.'),
            opaque: true,
        }));
        page.add(this._clockGroup(settings, 'clock-analog-2', _('Clock II'), {
            description: _('Dial with hour marks and no numbers.'),
            opaque: true,
        }));
        page.add(this._clockGroup(settings, 'clock-analog-3', _('Clock III'), {
            description: _('Ticks around the edge, with 12, 3, 6 and 9.'),
        }));
        page.add(this._clockGroup(settings, 'clock-digital', _('Digital Clock'), {
            description: _('Hours and minutes inside a ring of ticks that counts the seconds. Uses the 12/24-hour format from GNOME Settings.'),
            secondsTitle: _('Smooth seconds ring'),
            secondsSubtitle: _('Off moves the ring once a second, which uses less power.'),
        }));
        return page;
    }

    _clockGroup(settings, prefix, title, {
        description = '',
        opaque = false,
        secondsTitle = _('Sweeping second hand'),
        secondsSubtitle = _('Off moves the second hand once a second, which uses less power.'),
    } = {}) {
        const group = new Adw.PreferencesGroup({title, description});
        group.add(switchRow(settings, `${prefix}-enabled`, _('Show on desktop')));
        group.add(spinRow(settings, `${prefix}-size`, _('Size'), {lower: 120, upper: 600, step: 10}));
        group.add(switchRow(settings, `${prefix}-smooth-seconds`, secondsTitle, secondsSubtitle));
        if (opaque) {
            group.add(switchRow(settings, `${prefix}-opaque-background`, _('Fully opaque background'),
                _('In Solid style, use a flat dark card instead of the glass material.')));
        }
        group.add(positionRow(settings, prefix));
        return group;
    }

    _calendarGroup(settings) {
        const group = new Adw.PreferencesGroup({title: _('Calendar')});
        group.add(switchRow(settings, 'calendar-enabled', _('Show on desktop')));
        group.add(spinRow(settings, 'calendar-size', _('Size'), {lower: 140, upper: 500, step: 10}));
        group.add(comboRow(settings, 'calendar-first-day', _('First day of the week'),
            [_('Automatic'), _('Sunday'), _('Monday')]));
        group.add(positionRow(settings, 'calendar'));
        return group;
    }

    _timerGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Timer'),
            description: _('Scroll or drag the numbers to set the time. A running timer keeps going while the screen is locked.'),
        });
        group.add(switchRow(settings, 'timer-enabled', _('Show on desktop')));
        group.add(comboRow(settings, 'timer-layout', _('Layout'),
            [_('Small'), _('Wide, with presets')]));
        group.add(spinRow(settings, 'timer-size', _('Size'), {lower: 140, upper: 400, step: 10}));
        group.add(positionRow(settings, 'timer'));
        return group;
    }

    _musicGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Music'),
            description: _('Shows what’s playing in any app that supports media controls (MPRIS). Lyrics come from LRCLIB.net and are only looked up while the lyrics view is open.'),
        });
        group.add(switchRow(settings, 'music-enabled', _('Show on desktop')));
        group.add(comboRow(settings, 'music-layout', _('Layout'),
            [_('Square'), _('Wide'), _('Bar'), _('Tall')]));
        group.add(spinRow(settings, 'music-size', _('Size'), {lower: 120, upper: 400, step: 10}));
        group.add(switchRow(settings, 'music-lyrics-blur', _('Blur upcoming lyrics')));
        group.add(switchRow(settings, 'music-lyrics-title', _('Track title above lyrics')));
        group.add(switchRow(settings, 'music-hide-when-idle', _('Hide when nothing is playing'),
            _('Fades the widget out 30 seconds after playback stops.')));
        group.add(positionRow(settings, 'music'));
        return group;
    }

    _weatherGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: _('Weather'),
            description: _('Forecasts from Open-Meteo.com (CC BY 4.0). No account or API key is needed.'),
        });
        group.add(switchRow(settings, 'weather-enabled', _('Show on desktop')));
        group.add(comboRow(settings, 'weather-layout', _('Layout'),
            [_('Small'), _('Medium'), _('Large')]));
        group.add(spinRow(settings, 'weather-size', _('Size'), {lower: 140, upper: 400, step: 10}));
        group.add(comboRow(settings, 'weather-temperature-unit', _('Temperature unit'),
            [_('Celsius'), _('Fahrenheit')]));
        group.add(positionRow(settings, 'weather'));

        const location = new Adw.ActionRow({title: _('Location')});
        const showLocation = () => {
            location.subtitle = settings.get_string('weather-location');
        };
        settings.connect('changed::weather-location', showLocation);
        showLocation();
        group.add(location);

        // Search results appear as rows under the entry; picking one stores
        // its coordinates, so the widget never has to guess.
        const search = new Adw.EntryRow({title: _('Search for a city'), show_apply_button: true});
        group.add(search);

        const session = new Soup.Session({timeout: 20});
        let resultRows = [];
        const showResults = rows => {
            resultRows.forEach(row => group.remove(row));
            resultRows = rows;
            resultRows.forEach(row => group.add(row));
        };
        const messageRow = text => new Adw.ActionRow({title: text, css_classes: ['dim-label']});

        search.connect('apply', async () => {
            const query = search.text.trim();
            if (!query)
                return;

            showResults([messageRow(_('Searching…'))]);
            let places;
            try {
                places = await searchPlaces(session, query);
            } catch (e) {
                showResults([messageRow(_('Search failed. Check your internet connection.'))]);
                return;
            }
            if (places.length === 0) {
                showResults([messageRow(_('No places found'))]);
                return;
            }

            showResults(places.map(place => {
                const row = new Adw.ActionRow({
                    title: place.name,
                    subtitle: place.region,
                    activatable: true,
                });
                row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
                row.connect('activated', () => {
                    settings.set_double('weather-latitude', place.latitude);
                    settings.set_double('weather-longitude', place.longitude);
                    settings.set_string('weather-location', place.name);
                    search.text = '';
                    showResults([]);
                });
                return row;
            }));
        });

        return group;
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const style = new Adw.PreferencesGroup({title: _('Style')});
        style.add(comboRow(settings, 'style-mode', _('Style'), [_('Glass'), _('Solid')]));
        style.add(comboRow(settings, 'appearance', _('Appearance'),
            [_('Dark'), _('Light'), _('Follow system')]));
        style.add(sliderRow(settings, 'tint-alpha-pct', _('Glass tint'),
            {lower: 0, upper: 100, format: percent}));
        page.add(style);

        const shape = new Adw.PreferencesGroup({title: _('Shape')});
        shape.add(sliderRow(settings, 'corner-radius', _('Corner radius'),
            {lower: 0, upper: 200, format: pixels}));
        shape.add(sliderRow(settings, 'roundness-x10', _('Corner smoothness'),
            {lower: 20, upper: 100, format: v => (v / 10).toFixed(1)}));
        page.add(shape);

        const glass = new Adw.PreferencesGroup({title: _('Glass')});
        const resetGlass = new Gtk.Button({
            label: _('Reset'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetGlass.connect('clicked', () => GLASS_KEYS.forEach(k => settings.reset(k)));
        glass.set_header_suffix(resetGlass);
        glass.add(sliderRow(settings, 'refract-thickness', _('Edge thickness'),
            {lower: 1, upper: 80, format: pixels}));
        glass.add(sliderRow(settings, 'refract-scale', _('Refraction strength'),
            {lower: 0, upper: 300, step: 5, format: percent}));
        glass.add(sliderRow(settings, 'refract-ior-x100', _('Refraction index'),
            {lower: 100, upper: 400, step: 5, format: v => (v / 100).toFixed(2)}));
        glass.add(sliderRow(settings, 'chroma-strength-pct', _('Color fringing'),
            {lower: 0, upper: 100, format: percent}));
        glass.add(sliderRow(settings, 'spec-strength-pct', _('Edge highlight'),
            {lower: 0, upper: 100, step: 5, format: percent}));
        glass.add(sliderRow(settings, 'blur-radius-px', _('Blur radius'),
            {lower: 0, upper: 100, format: v => (v === 0 ? _('Off') : pixels(v))}));
        page.add(glass);

        return page;
    }
}
