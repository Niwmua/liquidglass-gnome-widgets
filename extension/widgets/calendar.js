// Port of packages/calendar (macOS Calendar), month-grid layout: month name,
// weekday initials and a 6 x 7 day grid with today in a filled circle. On
// glass the day number is punched out of the circle so the glass shows
// through it.
//
// The whole card is one St.DrawingArea, repainted only when the day, the
// size or the style changes. A GnomeDesktop.WallClock drives the day
// rollover, so it stays right across suspend and time-zone changes.

import Cairo from 'cairo';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopWidget} from '../lib/desktopWidget.js';
import {setSource, TextPainter} from '../lib/draw.js';

const PREFIX = 'calendar';
const FONT_FAMILY = 'SF Pro Display';

// 2024-01-07 was a Sunday; day i of that week has getDay() === i.
function weekdayInitial(dayOfWeek) {
    return new Date(2024, 0, 7 + dayOfWeek).toLocaleDateString(undefined, {weekday: 'narrow'});
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

export const CalendarWidget = GObject.registerClass(
class CalendarWidget extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._today = new Date();

        this._canvas = new St.DrawingArea();
        this._canvas.connect('repaint', () => {
            const cr = this._canvas.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.body.add_child(this._canvas);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connect('notify::clock', () => {
            const now = new Date();
            if (!sameDay(now, this._today)) {
                this._today = now;
                this._canvas.queue_repaint();
            }
        });

        settings.connectObject(`changed::${PREFIX}-first-day`,
            () => this._canvas.queue_repaint(), this);

        this.start();
    }

    // --- DesktopWidget hooks ---

    defaultPosition(area, _width, _height, margin) {
        // Top-left, out of the way of the clock in the top-right.
        return [area.x + margin, area.y + margin];
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
        menu.addAction(_('Open Calendar'), () => {
            Shell.AppSystem.get_default()
                .lookup_app('org.gnome.Calendar.desktop')?.activate();
        });
    }

    _onDestroy() {
        this._wallClock.run_dispose();
        super._onDestroy();
    }

    // --- Painting (geometry from the KDE widget's full representation) ---

    _firstDayOfWeek() {
        switch (this._settings.get_int(`${PREFIX}-first-day`)) {
        case 1: return 0; // Sunday
        case 2: return 1; // Monday
        default: return Shell.util_get_week_start();
        }
    }

    _paint(cr) {
        const colors = this._palette;
        if (!colors)
            return;

        const [w, h] = this._canvas.get_surface_size();
        const label = Math.max(10, Math.round(h * 0.058));
        const margin = Math.round(h * 0.09);
        const top = Math.round(h * 0.14);
        const spacing = Math.round(h * 0.02);
        const headerH = label * 1.4;

        const font = {family: FONT_FAMILY, size: label};
        const text = new TextPainter(cr);

        const left = margin;
        const width = w - 2 * margin;
        const cellW = width / 7;
        const gridTop = top + 2 * (headerH + spacing);
        const cellH = (h - margin - gridTop) / 6;

        const firstDow = this._firstDayOfWeek();
        const dayOfWeek = col => (firstDow + col) % 7;
        const isWeekend = col => dayOfWeek(col) === 0 || dayOfWeek(col) === 6;
        const fg = colors.foreground;

        // Month name, left-aligned with the first weekday initial.
        const initials = [...Array(7).keys()].map(col => weekdayInitial(dayOfWeek(col)));
        const firstInitialW = text.width(initials[0], font);
        const month = this._today.toLocaleDateString(undefined, {month: 'long'}).toLocaleUpperCase();
        setSource(cr, colors.todayAccent);
        text.draw(month, left + cellW / 2 - firstInitialW / 2, top + headerH / 2, font,
            {valign: 0.5, letterSpacing: 1});

        // Weekday initials
        const weekdayY = top + headerH + spacing + headerH / 2;
        initials.forEach((initial, col) => {
            setSource(cr, fg, isWeekend(col) ? 0.45 : 0.75);
            text.draw(initial, left + cellW * (col + 0.5), weekdayY, font, {align: 0.5, valign: 0.5});
        });

        // Day grid
        const year = this._today.getFullYear();
        const monthIndex = this._today.getMonth();
        const offset = (new Date(year, monthIndex, 1).getDay() - firstDow + 7) % 7;
        const lastDay = new Date(year, monthIndex + 1, 0).getDate();
        const badgeDiameter = Math.min(cellW, cellH) * 1.02;

        for (let day = 1; day <= lastDay; day++) {
            const slot = offset + day - 1;
            const col = slot % 7;
            const cx = left + cellW * (col + 0.5);
            const cy = gridTop + cellH * (Math.floor(slot / 7) + 0.5);

            if (day === this._today.getDate()) {
                this._paintBadge(cr, text, String(day), cx, cy, badgeDiameter, label, colors);
                continue;
            }

            setSource(cr, fg, isWeekend(col) ? 0.45 : 1.0);
            text.draw(String(day), cx, cy, font, {align: 0.5, valign: 0.5});
        }
    }

    // Port of TodayBadge.qml: a filled circle nudged slightly up and right
    // of the cell centre, with the number on top of it.
    _paintBadge(cr, text, number, cx, cy, diameter, label, colors) {
        cr.save();
        cr.pushGroup();

        setSource(cr, colors.todayAccent);
        cr.arc(cx + label * 0.04, cy - label * 0.05, diameter / 2, 0, 2 * Math.PI);
        cr.fill();

        if (colors.punchOutText) {
            // Erase the digits from the circle so the glass shows through.
            cr.setOperator(Cairo.Operator.DEST_OUT);
            cr.setSourceRGBA(0, 0, 0, 1);
        } else {
            cr.setSourceRGBA(1, 1, 1, 1);
        }
        text.draw(number, cx, cy, {family: FONT_FAMILY, size: label, weight: Pango.Weight.NORMAL},
            {align: 0.5, inkCenter: true});

        cr.popGroupToSource();
        cr.paint();
        cr.restore();
    }
});
