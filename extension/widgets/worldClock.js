// Ports of the KDE world clocks (packages/city-*):
//   city-1        macOS City I        up to 4 cities on numbered dials
//   city-2        macOS City II       up to 4 cities on dials with hour bars
//   city-3        macOS City III      one city on Clock III's edge-tick face
//   city-digital  macOS City Digital  one city on the digital clock
//
// City I/II show a single big dial for one city; for 2-4 cities, a 2x2
// grid or a row (with name, day and hour difference under each dial). In
// the grid and row each dial is light in that city's daytime and dark at
// night. City III/Digital reuse AnalogClock/DigitalClock and only add the
// city's time and labels.
//
// Cities are stored as "Zone/Id" or "Zone/Id|Label" strings in
// `<prefix>-cities`. Every clock refreshes its offsets once a minute
// (GnomeDesktop.WallClock), so DST changes and midnight are picked up.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {rgba, withAlpha} from '../lib/colors.js';
import {DesktopWidget} from '../lib/desktopWidget.js';
import {setSource, TextPainter} from '../lib/draw.js';
import {offsetLabel, parseClocks, zoneNow} from '../lib/worldTime.js';
import {AnalogClock} from './clockAnalog.js';
import {DigitalClock} from './clockDigital.js';

const ROUNDED = 'SF Pro Rounded';
const SECOND_HAND = rgba('#F6A029');
const LAYOUT_ROW = 1;
const MAX_CITIES = 4;

function dayWord(dayDiff) {
    if (dayDiff < 0)
        return _('Yesterday');
    if (dayDiff > 0)
        return _('Tomorrow');
    return _('Today');
}

// One city's clock: `now()` gives a Date whose local getters read that
// city's wall time; refresh() (once a minute) updates the offset and labels.
class CityTime {
    constructor(city) {
        Object.assign(this, city);
        this.refresh();
    }

    refresh() {
        const n = zoneNow(this.tz);
        this.relHours = n.relHours;
        this.dayDiff = n.dayDiff;
        this.isDay = n.isDay;
        this._shiftMs = n.relHours * 3600000;
    }

    now() {
        return new Date(Date.now() + this._shiftMs);
    }
}

function firstCity(settings, prefix) {
    const [city] = parseClocks(settings.get_strv(`${prefix}-cities`));
    return city ? new CityTime(city) : null;
}

function drawAnnotation(cr, str, x, y, size, color, opacity, align = 0.5, valign = 0.5) {
    setSource(cr, color, opacity);
    new TextPainter(cr).draw(str, x, y, {family: ROUNDED, size, weight: Pango.Weight.MEDIUM}, {align, valign});
}

// --- City III / City Digital ---

export const CityAnalogClock = GObject.registerClass(
class CityAnalogClock extends AnalogClock {
    _init(extension, settings) {
        super._init(extension, settings, 'city-3');
        this._city = firstCity(settings, 'city-3');

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connect('notify::clock', () => this._refreshCity());
        settings.connectObject('changed::city-3-cities', () => {
            this._city = firstCity(settings, 'city-3');
            this._refreshCity();
        }, this);
        this._refreshCity();
    }

    _refreshCity() {
        this._city?.refresh();
        this._dial.queue_repaint();
        this._tick();
    }

    now() {
        return this._city?.now() ?? new Date();
    }

    // City code above the centre, hour difference below (main.qml).
    paintAnnotations(cr, g) {
        if (!this._city)
            return;
        const size = Math.max(7, g.r * 0.165);
        const opacity = (this._palette.isGlass ? 0.55 : 1.0) * 0.55;
        const fg = this._palette.foreground;
        drawAnnotation(cr, this._city.code, g.cx, g.cy - g.r * 0.40, size, fg, opacity);
        drawAnnotation(cr, offsetLabel(this._city.relHours), g.cx, g.cy + g.r * 0.40, size, fg, opacity);
    }

    _onDestroy() {
        this._wallClock.run_dispose();
        super._onDestroy();
    }
});

export const CityDigitalClock = GObject.registerClass(
class CityDigitalClock extends DigitalClock {
    _init(extension, settings) {
        super._init(extension, settings, 'city-digital', {slot: 3, row: 1});
        this._city = firstCity(settings, 'city-digital');
        settings.connectObject('changed::city-digital-cities', () => {
            this._city = firstCity(settings, 'city-digital');
            this._time.queue_repaint();
        }, this);
        // The parent repaints the time every minute; refresh the city first.
        this._wallClock.connect('notify::clock', () => this._city?.refresh());
    }

    now() {
        return this._city?.now() ?? new Date();
    }

    // City code near the top, hour difference near the bottom.
    paintAnnotations(cr, w, h) {
        if (!this._city)
            return;
        const minSide = Math.min(w, h);
        const size = Math.max(8, minSide * 0.085);
        const margin = minSide * 0.13;
        const opacity = (this._palette.isGlass ? 0.55 : 1.0) * 0.55;
        const fg = this._palette.foreground;
        drawAnnotation(cr, this._city.code, w / 2, margin, size, fg, opacity, 0.5, 0);
        drawAnnotation(cr, offsetLabel(this._city.relHours), w / 2, h - margin, size, fg, opacity, 0.5, 1);
    }
});

// --- City I / City II ---

// Vertical capsule from y = top to y = top + length, centred on x = 0.
function capsule(cr, top, length, width) {
    const r = width / 2;
    cr.newSubPath();
    cr.arc(0, top + r, r, Math.PI, 2 * Math.PI);
    cr.arc(0, top + length - r, r, 0, Math.PI);
    cr.closePath();
}

function hand(cr, totalLen, stemEnd, stemW, pillW) {
    cr.rectangle(-stemW / 2, -stemEnd, stemW, stemEnd);
    cr.fill();
    capsule(cr, -totalLen, totalLen - stemEnd, pillW);
    cr.fill();
}

// Port of the City widgets' ClockFace.qml: a disc with one of three rings,
//   'perimeter'  60 pill ticks and numerals (City I, one city)
//   'numerals'   numerals near the edge, no ticks (City I, several cities)
//   'bars'       12 bold hour bars (City II)
// and the usual hands. Like AnalogClock, each hand is its own drawing area
// that only rotates as time passes.
const ClockFace = GObject.registerClass(
class ClockFace extends St.Widget {
    _init() {
        super._init();
        this._look = null;
        this._dial = this._addLayer(this._paintDial);
        this._hourHand = this._addLayer(this._paintHourHand);
        this._minuteHand = this._addLayer(this._paintMinuteHand);
        this._secondHand = this._addLayer(this._paintSecondHand);
    }

    _addLayer(paint) {
        const area = new St.DrawingArea();
        area.set_pivot_point(0.5, 0.5);
        area.connect('repaint', () => {
            if (!this._look)
                return;
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const r = Math.min(w, h) / 2;
            const tickW = r * 0.020;
            const outerR = r - tickW * 2;
            const innerR = outerR - r * 0.09;
            const minuteLen = (outerR + innerR) / 2;
            cr.translate(w / 2, h / 2);
            paint.call(this, cr, {r, tickW, outerR, minuteLen, hourLen: minuteLen * 0.65});
            cr.$dispose();
        });
        this.add_child(area);
        return area;
    }

    // look: {ring, disc, mark, numeralOpacity, markOpacity, handOpacity,
    // thickSecond}
    setLook(look) {
        this._look = look;
        this._layers().forEach(l => l.queue_repaint());
    }

    setFaceSize(size) {
        this.set_size(size, size);
        this._layers().forEach(l => {
            l.set_position(0, 0);
            l.set_size(size, size);
        });
    }

    setTime(date, smooth) {
        const sec = date.getSeconds() + (smooth ? date.getMilliseconds() / 1000 : 0);
        const min = date.getMinutes() + sec / 60;
        const hr = (date.getHours() % 12) + min / 60;
        this._secondHand.rotation_angle_z = sec * 6;
        this._minuteHand.rotation_angle_z = min * 6;
        this._hourHand.rotation_angle_z = hr * 30;
    }

    _layers() {
        return [this._dial, this._hourHand, this._minuteHand, this._secondHand];
    }

    _paintDial(cr, g) {
        const look = this._look;
        setSource(cr, look.disc);
        cr.arc(0, 0, g.r, 0, 2 * Math.PI);
        cr.fill();

        if (look.ring === 'bars') {
            const width = g.r * 0.0336 * 0.9 * 1.15 * 1.35;
            const length = g.hourLen * 0.40 * 0.90 * 1.10;
            setSource(cr, withAlpha(look.mark, look.markOpacity));
            for (let i = 0; i < 12; i++) {
                cr.save();
                cr.rotate(i * Math.PI / 6);
                capsule(cr, -g.outerR, length, width);
                cr.fill();
                cr.restore();
            }
            return;
        }

        if (look.ring === 'perimeter') {
            for (let i = 0; i < 60; i++) {
                setSource(cr, withAlpha(look.mark, i % 5 === 0 ? 0.75 : 0.30));
                cr.save();
                cr.rotate(i * Math.PI / 30);
                capsule(cr, -g.outerR, g.r * 0.09, g.tickW);
                cr.fill();
                cr.restore();
            }
        }

        const dist = g.r * (look.ring === 'perimeter' ? 0.72 : 0.80);
        const font = {family: ROUNDED, size: Math.max(8, g.r * 0.17), weight: Pango.Weight.MEDIUM};
        const text = new TextPainter(cr);
        setSource(cr, withAlpha(look.mark, look.numeralOpacity));
        for (let num = 1; num <= 12; num++) {
            const angle = num / 12 * 2 * Math.PI;
            text.draw(String(num), Math.sin(angle) * dist, -Math.cos(angle) * dist, font,
                {align: 0.5, valign: 0.5});
        }
    }

    _paintHourHand(cr, g) {
        setSource(cr, withAlpha(this._look.mark, this._look.handOpacity));
        hand(cr, g.hourLen, g.r * 0.15, g.r * 0.0336, g.r * 0.065);
    }

    _paintMinuteHand(cr, g) {
        setSource(cr, withAlpha(this._look.mark, this._look.handOpacity));
        hand(cr, g.minuteLen, g.r * 0.15, g.r * 0.0336, g.r * 0.065);
        cr.arc(0, 0, g.r * 0.050, 0, 2 * Math.PI);
        cr.fill();
    }

    _paintSecondHand(cr, g) {
        setSource(cr, SECOND_HAND);
        const len = g.r - g.tickW * 2;
        const hw = g.r * 0.007 * (this._look.thickSecond ? 2 : 1);
        cr.rectangle(-hw, -len, hw * 2, len + g.r * 0.15);
        cr.fill();
        cr.arc(0, 0, g.r * 0.035, 0, 2 * Math.PI);
        cr.fill();
    }
});

export const CityMultiClock = GObject.registerClass(
class CityMultiClock extends DesktopWidget {
    // prefix: 'city-1' (numbered dials) or 'city-2' (hour bars).
    _init(extension, settings, prefix) {
        super._init(extension, settings, prefix);
        this._bars = prefix === 'city-2';
        this._cities = [];
        this._faces = [];
        this._tickSourceId = 0;

        this._labels = new St.DrawingArea();
        this._labels.connect('repaint', () => {
            const cr = this._labels.get_context();
            this._paintLabels(cr);
            cr.$dispose();
        });

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connect('notify::clock', () => this._refreshCities());

        settings.connectObject(
            `changed::${prefix}-smooth-seconds`, () => this._startTicking(),
            `changed::${prefix}-opaque-background`, () => this._loadStyle(),
            `changed::${prefix}-cities`, () => this._loadCities(),
            this);

        this._loadCities(false);
        this.start();
        this._startTicking();
    }

    _loadCities(relayout = true) {
        this._cities = parseClocks(this._settings.get_strv(`${this._prefix}-cities`))
            .slice(0, MAX_CITIES).map(c => new CityTime(c));
        if (this._cities.length === 0)
            this._cities = parseClocks([GLib.TimeZone.new_local().get_identifier()]).map(c => new CityTime(c));

        this._faces.forEach(f => f.destroy());
        this._faces = this._cities.map(() => {
            const face = new ClockFace();
            this.body.add_child(face);
            return face;
        });
        // Labels draw over the dials.
        if (this._labels.get_parent())
            this.body.remove_child(this._labels);
        this.body.add_child(this._labels);

        if (relayout) {
            this._loadGeometry();
            this._loadStyle();
            this._tick();
        }
    }

    _refreshCities() {
        const dayNight = this._cities.map(c => c.isDay).join();
        this._cities.forEach(c => c.refresh());
        if (this._cities.map(c => c.isDay).join() !== dayNight)
            this._applyLooks();
        this._labels.queue_repaint();
        this._tick();
    }

    get _single() {
        return this._cities.length <= 1;
    }

    get _row() {
        return !this._single && this._settings.get_int(`${this._prefix}-layout`) === LAYOUT_ROW;
    }

    // --- Time ---

    _startTicking() {
        this._timeline.stop();
        if (this._tickSourceId)
            GLib.source_remove(this._tickSourceId);
        this._tickSourceId = 0;

        this._smooth = this._settings.get_boolean(`${this._prefix}-smooth-seconds`);
        this._tick();
        if (this._smooth)
            this._timeline.start();
        else
            this._scheduleNextSecond();
    }

    _scheduleNextSecond() {
        const delay = 1000 - new Date().getMilliseconds();
        this._tickSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._tickSourceId = 0;
            this._tick();
            this._scheduleNextSecond();
            return GLib.SOURCE_REMOVE;
        });
    }

    _tick() {
        this._faces.forEach((face, i) => face.setTime(this._cities[i].now(), this._smooth));
    }

    // --- DesktopWidget hooks ---

    sizeKeys() {
        return ['size', 'layout', 'cities'];
    }

    readSize() {
        const s = this._settings.get_int(`${this._prefix}-size`);
        const count = Math.min(MAX_CITIES, parseClocks(this._settings.get_strv(`${this._prefix}-cities`)).length);
        const row = count > 1 && this._settings.get_int(`${this._prefix}-layout`) === LAYOUT_ROW;
        return row ? [s * Math.max(2, count * 0.6), s] : [s, s];
    }

    defaultPosition(area, width, height, margin) {
        // Second row of the clock grid at the top right.
        const slot = this._bars ? 1 : 0;
        const size = this._settings.get_int(`${this._prefix}-size`);
        const x = area.x + area.width - width - margin - slot * (size + margin / 2);
        return [Math.max(area.x + margin, x), area.y + margin + height + margin / 2];
    }

    solidBackground(colors) {
        // As in Clock I/II: a flat dark card only with "opaque background".
        return {
            solid: colors.isSolid && this._settings.get_boolean(`${this._prefix}-opaque-background`),
            solidColor: rgba('#1A1B1E'),
        };
    }

    styleChanged(colors) {
        this._palette = colors;
        this._applyLooks();
        this._labels?.queue_repaint();
    }

    _applyLooks() {
        const colors = this._palette;
        if (!colors)
            return;
        if (this._single) {
            // One city: themed by the widget style, like Clock I/II.
            this._faces[0]?.setLook({
                ring: this._bars ? 'bars' : 'perimeter',
                disc: colors.isGlass ? rgba('#ffffff', 0.20) : rgba(colors.isLight ? '#ffffff' : '#343436'),
                mark: colors.foreground,
                numeralOpacity: colors.isGlass ? 0.85 : 1.0,
                markOpacity: 0.75,
                handOpacity: colors.isGlass ? 0.92 : 1.0,
                thickSecond: false,
            });
            return;
        }
        // Several: each dial is light by day, dark by night, in its city.
        this._faces.forEach((face, i) => {
            const day = this._cities[i].isDay;
            face.setLook({
                ring: this._bars ? 'bars' : 'numerals',
                disc: rgba(day ? '#ffffff' : '#343436'),
                mark: rgba(day ? '#1A1B1E' : '#ffffff'),
                numeralOpacity: 0.85,
                markOpacity: 0.75,
                handOpacity: 0.92,
                thickSecond: true,
            });
        });
    }

    layoutContent(width, height) {
        this._labels.set_position(0, 0);
        this._labels.set_size(width, height);
        this._cells = [];

        if (this._single) {
            const margin = Math.min(width, height) * 0.08;
            const size = Math.round(Math.min(width, height) - 2 * margin);
            const x = Math.round((width - size) / 2);
            const y = Math.round((height - size) / 2);
            this._faces[0]?.set_position(x, y);
            this._faces[0]?.setFaceSize(size);
            this._cells.push({faceX: x, faceY: y, faceSize: size});
        } else {
            // Port of the GridLayout in main.qml.
            const count = this._cities.length;
            const margin = Math.round(Math.min(width, height) * 0.06);
            const spacing = Math.round(margin * 0.4);
            const cols = this._row ? count : 2;
            const rows = Math.ceil(count / cols);
            const cellW = (width - 2 * margin - (cols - 1) * spacing) / cols;
            const cellH = (height - 2 * margin - (rows - 1) * spacing) / rows;
            const infoH = this._row ? Math.round(cellH * 0.34) : 0;
            const inset = this._row ? Math.round(cellW * 0.08) : 10;
            const faceSize = Math.max(1, Math.floor(Math.min(cellW - inset, cellH - infoH)));
            const labelSize = Math.max(8, faceSize * 0.13);
            const infoBlock = this._row ? Math.round(faceSize * 0.04) + this._infoHeight(labelSize) : 0;

            this._cities.forEach((_c, i) => {
                const col = i % cols;
                const rowIndex = Math.floor(i / cols);
                const cellX = margin + col * (cellW + spacing);
                const cellY = margin + rowIndex * (cellH + spacing);
                const x = Math.round(cellX + (cellW - faceSize) / 2);
                const y = Math.round(cellY + (cellH - faceSize - infoBlock) / 2);
                this._faces[i].set_position(x, y);
                this._faces[i].setFaceSize(faceSize);
                this._cells.push({faceX: x, faceY: y, faceSize, cellX, cellW, labelSize});
            });
        }
        this._applyLooks();
        this._labels.queue_repaint();
    }

    // Name + day word + difference, as in CityLabel.qml's "full" mode.
    _infoHeight(size) {
        const lines = [size, Math.round(size * 0.85), Math.round(size * 0.85)];
        return lines.reduce((sum, s) => sum + Math.ceil(s * 1.25), 0) + 2 * Math.round(size * 0.15);
    }

    addMenuItems(menu) {
        menu.addAction(_('Adjust Date and Time…'), () => {
            Shell.AppSystem.get_default()
                .lookup_app('gnome-datetime-panel.desktop')?.activate();
        });
    }

    _onDestroy() {
        this._timeline.stop();
        if (this._tickSourceId)
            GLib.source_remove(this._tickSourceId);
        this._tickSourceId = 0;
        this._wallClock.run_dispose();
        super._onDestroy();
    }

    // --- Painting ---

    _paintLabels(cr) {
        const colors = this._palette;
        if (!colors || !this._cells)
            return;
        const annotationOpacity = (colors.isGlass ? 0.55 : 1.0) * 0.55;

        if (this._single) {
            const city = this._cities[0];
            const cell = this._cells[0];
            if (!city || !cell)
                return;
            const r = cell.faceSize / 2;
            const cx = cell.faceX + r;
            const cy = cell.faceY + r;
            const size = Math.max(8, r * 0.16);
            drawAnnotation(cr, city.code, cx, cy - r * 0.40, size, colors.foreground, annotationOpacity);
            drawAnnotation(cr, offsetLabel(city.relHours, false), cx, cy + r * 0.40, size,
                colors.foreground, annotationOpacity);
            return;
        }

        const text = new TextPainter(cr);
        this._cities.forEach((city, i) => {
            const cell = this._cells[i];
            const cx = cell.faceX + cell.faceSize / 2;
            const mark = rgba(city.isDay ? '#1A1B1E' : '#ffffff');

            // City code inside the dial, above the centre.
            drawAnnotation(cr, city.code, cx, cell.faceY + cell.faceSize * 0.30,
                Math.max(7, cell.faceSize * 0.13), mark, annotationOpacity);

            if (!this._row)
                return;

            // Row: name, day word and hour difference under the dial.
            const size = cell.labelSize;
            const small = Math.round(size * 0.85);
            const gap = Math.round(size * 0.15);
            const secondary = colors.isGlass ? 0.85 : 0.6;
            const maxWidth = cell.cellW;
            let y = cell.faceY + cell.faceSize + Math.round(cell.faceSize * 0.04);
            const font = s => ({family: ROUNDED, size: s, weight: Pango.Weight.MEDIUM});

            setSource(cr, colors.foreground);
            y += text.draw(city.label, cx, y, font(size), {align: 0.5, maxWidth}).height + gap;
            setSource(cr, colors.foreground, secondary);
            y += text.draw(dayWord(city.dayDiff), cx, y, font(small), {align: 0.5, maxWidth}).height + gap;
            text.draw(offsetLabel(city.relHours), cx, y, font(small), {align: 0.5, maxWidth});
        });
    }
});
