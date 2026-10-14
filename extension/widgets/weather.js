// Port of packages/weather (macOS Weather): current conditions, an hourly
// strip and a five-day forecast, in three layouts chosen in the settings:
//   0 Small   square tile: temperature, high/low, precipitation and wind
//   1 Medium  wide tile: temperature, condition and the hourly strip
//   2 Large   big square: all of the above plus the daily forecast
//
// The card is one St.DrawingArea, painted from WeatherClient.view(). In
// Solid style the backdrop is a gradient that follows the weather.

import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopWidget} from '../lib/desktopWidget.js';
import {drawImage, setSource, TextPainter} from '../lib/draw.js';
import {weatherGradient} from '../lib/colors.js';
import {WeatherClient} from '../lib/weatherData.js';

const PREFIX = 'weather';
const FONT_FAMILY = 'SF Pro Display';

const LAYOUT_SMALL = 0;
const LAYOUT_MEDIUM = 1;
const LAYOUT_LARGE = 2;

// Wide and large tiles are this many small tiles across, as on macOS.
const WIDE_FACTOR = 2.1;

const PLACE_KEYS = ['location', 'latitude', 'longitude', 'temperature-unit'];

export const WeatherWidget = GObject.registerClass(
class WeatherWidget extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._iconDir = extension.dir.get_child('icons').get_path();
        this._view = null;
        this._category = null;
        this._placeSourceId = 0;

        this._canvas = new St.DrawingArea();
        this._canvas.connect('repaint', () => {
            const cr = this._canvas.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.body.add_child(this._canvas);

        this._client = new WeatherClient(() => this._update());

        // Once a minute: move the hourly strip on and refetch stale data.
        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connect('notify::clock', () => {
            this._client.refreshIfStale();
            this._update();
        });

        for (const key of PLACE_KEYS)
            settings.connectObject(`changed::${PREFIX}-${key}`, () => this._queueLoadPlace(), this);
        settings.connectObject(`changed::${PREFIX}-layout`, () => this._loadGeometry(), this);
        this._interfaceSettings.connectObject('changed::clock-format', () => this._update(), this);

        this.start();
        this._loadPlace();
    }

    // Picking a city in the settings writes several keys in a row; fetch
    // once for all of them.
    _queueLoadPlace() {
        if (this._placeSourceId)
            return;
        this._placeSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._placeSourceId = 0;
            this._loadPlace();
            return GLib.SOURCE_REMOVE;
        });
    }

    _loadPlace() {
        const s = this._settings;
        this._client.setPlace(
            s.get_string(`${PREFIX}-location`),
            s.get_double(`${PREFIX}-latitude`),
            s.get_double(`${PREFIX}-longitude`),
            s.get_int(`${PREFIX}-temperature-unit`));
        this._update();
    }

    _formatHour(hours, minutes) {
        if (this._interfaceSettings.get_string('clock-format') === '24h')
            return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

        const h = hours % 12 || 12;
        const suffix = hours < 12 ? _('AM') : _('PM');
        return minutes > 0
            ? `${h}:${String(minutes).padStart(2, '0')} ${suffix}`
            : `${h} ${suffix}`;
    }

    _update() {
        this._view = this._client.view((h, m) => this._formatHour(h, m));

        // The Solid gradient depends on the weather; restyle when it changes.
        const category = this._view?.category ?? 'clear';
        if (category !== this._category) {
            this._category = category;
            this._loadStyle();
        }
        this._canvas.queue_repaint();
    }

    // --- DesktopWidget hooks ---

    sizeKeys() {
        return ['size', 'layout'];
    }

    readSize() {
        const size = this._settings.get_int(`${PREFIX}-size`);
        const wide = Math.round(size * WIDE_FACTOR);
        switch (this._settings.get_int(`${PREFIX}-layout`)) {
        case LAYOUT_MEDIUM: return [wide, size];
        case LAYOUT_LARGE: return [wide, wide];
        default: return [size, size];
        }
    }

    defaultPosition(area, _width, height, margin) {
        // Bottom-left, below the calendar.
        return [area.x + margin, area.y + area.height - height - margin];
    }

    solidBackground(colors) {
        const [top, bottom] = weatherGradient(this._category ?? 'clear');
        return {solid: colors.isSolid, solidColor: top, solidColorBottom: bottom};
    }

    styleChanged(colors) {
        this._palette = colors;
        this._canvas?.queue_repaint();
    }

    layoutContent(width, height) {
        this._canvas.set_size(width, height);
        this._canvas.queue_repaint();
    }

    addMenuItems(menu) {
        menu.addAction(_('Refresh'), () => this._client.refresh());
    }

    _onDestroy() {
        if (this._placeSourceId)
            GLib.source_remove(this._placeSourceId);
        this._placeSourceId = 0;
        this._wallClock.run_dispose();
        this._client.destroy();
        super._onDestroy();
    }

    // --- Painting (geometry from the KDE widget's main.qml) ---

    _paint(cr) {
        const colors = this._palette;
        if (!colors)
            return;

        const [w, h] = this._canvas.get_surface_size();
        const ctx = {
            cr,
            text: new TextPainter(cr),
            fg: colors.weatherForeground,
            colors,
            w,
            h,
        };

        if (!this._view) {
            this._paintPlaceholder(ctx);
            return;
        }

        switch (this._settings.get_int(`${PREFIX}-layout`)) {
        case LAYOUT_MEDIUM: this._paintMedium(ctx); break;
        case LAYOUT_LARGE: this._paintLarge(ctx); break;
        default: this._paintSmall(ctx);
        }
    }

    _icon(name) {
        return `${this._iconDir}/weather/${this._palette.weatherIconSet}/${name}.png`;
    }

    _font(size, weight = Pango.Weight.NORMAL) {
        return {family: FONT_FAMILY, size, weight};
    }

    _paintPlaceholder({cr, text, fg, w, h}) {
        const label = Math.max(10, Math.round(Math.min(h, 350) * 0.065));
        const message = this._client.error ?? _('Loading…');
        setSource(cr, fg, 0.7);
        text.draw(message, w / 2, h / 2, this._font(label), {
            align: 0.5, valign: 0.5, maxWidth: w * 0.8,
        });
    }

    _paintSmall({cr, text, fg, w, h}) {
        const v = this._view;
        const L = Math.max(10, Math.round(Math.min(h, 350) * 0.065));
        const m = Math.round(h * 0.09);
        const iconSize = L * 3;

        // City + location arrow, top-left (leaving room for the icon).
        const cityFont = this._font(Math.round(L * 1.1), Pango.Weight.MEDIUM);
        const arrowSize = Math.round(L * 0.85);
        const cityMax = w - 2 * m - iconSize - arrowSize - L * 0.5;
        setSource(cr, fg);
        const city = text.draw(v.city, m, m, cityFont, {maxWidth: cityMax});
        drawImage(cr, `${this._iconDir}/location.png`,
            m + city.width + Math.round(L * 0.25), m + (city.height - arrowSize) / 2,
            arrowSize, {tint: fg});

        // Temperature
        setSource(cr, fg);
        text.draw(v.temp, m, m + city.height, this._font(L * 4, Pango.Weight.LIGHT));

        // Icon, top-right, with high/low under it.
        drawImage(cr, this._icon(v.icon), w - m - iconSize, m, iconSize);

        const font = this._font(L);
        const gap = Math.round(L * 0.15);
        const rows = [['↑', v.high, 1.0], ['↓', v.low, 0.7]];
        const rowW = ([arrow, value]) => text.width(arrow, font) + gap + text.width(value, font);
        const colX = w - m - Math.max(...rows.map(rowW));
        let y = m + iconSize + Math.round(L * 0.3);
        for (const [arrow, value, opacity] of rows) {
            setSource(cr, fg, opacity);
            const a = text.draw(arrow, colX, y, font);
            const b = text.draw(value, colX + a.width + gap, y, font);
            y += Math.max(a.height, b.height) + gap;
        }

        // Precipitation and wind, bottom-left.
        const info = Math.round(L * 0.88);
        const lines = [
            [_('Precipitation'), Pango.Weight.MEDIUM, 1.0],
            [v.precipitation, Pango.Weight.NORMAL, 0.55],
            null, // spacer
            [_('Wind'), Pango.Weight.MEDIUM, 1.0],
            [v.wind, Pango.Weight.NORMAL, 0.55],
        ];
        const lineH = text.measure('Ag', this._font(info)).logical.height;
        const spacer = Math.round(L * 0.35);
        y = h - m - (lines.length - 1) * lineH - spacer;
        for (const line of lines) {
            if (!line) {
                y += spacer;
                continue;
            }
            const [str, weight, opacity] = line;
            setSource(cr, fg, opacity);
            text.draw(str, m, y, this._font(info, weight), {maxWidth: w - 2 * m});
            y += lineH;
        }
    }

    // City and temperature on the left; icon, condition and H/L on the
    // right. Shared by the medium and large layouts.
    _paintHeader({cr, text, fg}, x, y, width, L) {
        const v = this._view;
        const iconSize = L * 3;
        const spacing = Math.round(L * 0.3);
        const right = x + width;

        // Right column first, so the city can be elided against it.
        drawImage(cr, this._icon(v.icon), right - iconSize, y, iconSize);
        const font = this._font(L, Pango.Weight.MEDIUM);
        setSource(cr, fg);
        const cond = text.draw(v.condition, right, y + iconSize + spacing, font, {align: 1});
        setSource(cr, fg, 0.7);
        const hl = _('H:%s  L:%s').replace('%s', v.high).replace('%s', v.low);
        text.draw(hl, right, y + iconSize + spacing + cond.height + spacing, font, {align: 1});

        setSource(cr, fg);
        const city = text.draw(v.city, x, y, this._font(Math.round(L * 1.15), Pango.Weight.MEDIUM),
            {maxWidth: width - iconSize - L});
        text.draw(v.temp, x, y + city.height, this._font(Math.round(L * 3.5), Pango.Weight.LIGHT));
    }

    _paintMedium(ctx) {
        const {h, w} = ctx;
        const L = Math.max(10, Math.round(Math.min(h, 350) * 0.065));
        const m = Math.round(h * 0.09);
        const innerH = h - 2 * m;
        const topH = innerH * 0.5;

        this._paintHeader(ctx, m, m, w - 2 * m, L);
        this._paintHourly(ctx, m, m + topH, w - 2 * m, innerH - topH, L);
    }

    _paintLarge(ctx) {
        const {cr, colors, w, h} = ctx;
        const L = Math.max(10, Math.round(Math.min(h, w / 2, 350) * 0.065));
        const m = Math.round(h * 0.06);
        const innerW = w - 2 * m;
        const innerH = h - 2 * m;
        const topH = innerH * 0.30;
        const hourlyH = innerH * 0.22;
        const sep = Math.round(innerH * 0.02);

        const separator = y => {
            setSource(cr, colors.weatherSeparator);
            cr.rectangle(m, Math.round(y), innerW, 1);
            cr.fill();
        };

        this._paintHeader(ctx, m, m, innerW, L);

        let y = m + topH + sep;
        separator(y);
        y += 1 + sep;
        this._paintHourly(ctx, m, y, innerW, hourlyH, L);
        y += hourlyH + sep;
        separator(y);
        y += 1 + sep;
        this._paintDaily(ctx, m, y, innerW, h - m - y, L);
    }

    // Port of HourlyForecast.qml: time, icon and temperature per column.
    _paintHourly({cr, text, fg}, x, y, width, height, L) {
        const slots = this._view.hourly;
        if (slots.length === 0)
            return;

        const font = this._font(L * 0.85);
        const lineH = text.measure('Ag', font).logical.height;
        const iconSize = Math.round(height * 0.36);
        const spacing = Math.round(height * 0.04);
        const top = y + (height - (2 * lineH + iconSize + 2 * spacing)) / 2;
        const slotW = width / slots.length;

        slots.forEach((slot, i) => {
            const cx = x + slotW * (i + 0.5);
            setSource(cr, fg, 0.7);
            text.draw(slot.label, cx, top, font, {align: 0.5});
            drawImage(cr, this._icon(slot.icon), cx - iconSize / 2, top + lineH + spacing, iconSize);
            setSource(cr, fg, slot.sunEvent ? 0.7 : 1.0);
            text.draw(slot.temp, cx, top + lineH + spacing + iconSize + spacing, font, {align: 0.5});
        });
    }

    // Port of DailyForecast.qml: day, icon, low, range bar, high per row.
    _paintDaily({cr, text, fg, colors}, x, y, width, height, L) {
        const v = this._view;
        const days = v.days;
        if (days.length === 0)
            return;

        const rowSpacing = Math.round(height * 0.02);
        const rowH = (height - (days.length - 1) * rowSpacing) / days.length;
        const range = v.overallHigh - v.overallLow;
        const font = this._font(L);
        const iconSize = Math.min(rowH * 0.75, L * 1.8);
        const barH = Math.max(4, Math.round(L * 0.35));

        days.forEach((day, i) => {
            const cy = y + i * (rowH + rowSpacing) + rowH / 2;

            setSource(cr, fg);
            text.draw(day.name, x, cy, this._font(L, Pango.Weight.MEDIUM),
                {valign: 0.5, maxWidth: width * 0.13});

            const iconX = x + width * 0.15;
            drawImage(cr, this._icon(day.icon), iconX, cy - iconSize / 2, iconSize);

            const lowRight = iconX + iconSize + width * 0.11;
            setSource(cr, fg, 0.7);
            text.draw(`${day.low}°`, lowRight, cy, font, {align: 1, valign: 0.5});

            const highLeft = x + width * 0.92;
            setSource(cr, fg);
            text.draw(`${day.high}°`, highLeft, cy, font, {valign: 0.5});

            // Range bar: track, then this day's low..high span.
            const barX = lowRight + width * 0.03;
            const barW = highLeft - width * 0.03 - barX;
            const barY = cy - barH / 2;
            setSource(cr, colors.weatherRangeBarBg);
            pill(cr, barX, barY, barW, barH);
            const fillX = range > 0 ? (day.low - v.overallLow) / range * barW : 0;
            const fillW = range > 0 ? Math.max(barH, (day.high - day.low) / range * barW) : barW;
            setSource(cr, colors.weatherRangeBarFill);
            pill(cr, barX + fillX, barY, fillW, barH);
        });
    }
});

function pill(cr, x, y, width, height) {
    const r = height / 2;
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    cr.arc(x + r, y + r, r, Math.PI / 2, 3 * Math.PI / 2);
    cr.closePath();
    cr.fill();
}
