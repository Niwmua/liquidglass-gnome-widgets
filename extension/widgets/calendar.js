// Port of packages/calendar (macOS Calendar): month name, weekday initials
// and a 6 x 7 day grid with today in a filled circle. On glass the day
// number is punched out of the circle so the glass shows through it.
//
// The wide layout adds the KDE widget's event list on the left: events
// from the user's calendars (Evolution Data Server, read by
// lib/calendarEvents.js) grouped as today, this week and upcoming.
//
// The whole card is one St.DrawingArea, repainted only when the day, the
// events, the size or the style change. A GnomeDesktop.WallClock drives the
// day rollover, so it stays right across suspend and time-zone changes.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CalendarEvents} from '../lib/calendarEvents.js';
import {rgba} from '../lib/colors.js';
import {DesktopWidget} from '../lib/desktopWidget.js';
import {setSource, TextPainter} from '../lib/draw.js';

const PREFIX = 'calendar';
const FONT_FAMILY = 'SF Pro Display';
const LAYOUT_WIDE = 1;
const WIDE_FACTOR = 2.15;
const LOOKAHEAD_DAYS = [7, 14, 30, 60];
// Pill color for events whose calendar has no color (KDE's "Event" blue).
const DEFAULT_EVENT_COLOR = rgba('#4B9EFF');

// 2024-01-07 was a Sunday; day i of that week has getDay() === i.
function weekdayInitial(dayOfWeek) {
    return new Date(2024, 0, 7 + dayOfWeek).toLocaleDateString(undefined, {weekday: 'narrow'});
}

function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

export const CalendarWidget = GObject.registerClass(
class CalendarWidget extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._today = new Date();
        this._items = [];   // event list rows, see _buildItems()
        this._scroll = 0;

        // Reactive only to scroll the event list; presses still drag.
        this._canvas = new St.DrawingArea({reactive: true});
        this._canvas.connect('repaint', () => {
            const cr = this._canvas.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this._canvas.connect('scroll-event', (_a, event) => this._onScroll(event));
        this.body.add_child(this._canvas);

        this._events = new CalendarEvents(extension, () => this._buildItems());

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connect('notify::clock', () => {
            const now = new Date();
            if (!sameDay(now, this._today)) {
                this._today = now;
                this._events.refresh();
                this._buildItems();
            }
        });

        settings.connectObject(
            `changed::${PREFIX}-first-day`, () => this._buildItems(),
            `changed::${PREFIX}-layout`, () => {
                this._loadGeometry();
                this._syncEvents();
            },
            `changed::${PREFIX}-lookahead`, () => this._syncEvents(true),
            this);
        this._interfaceSettings.connectObject('changed::clock-format', () => this._buildItems(), this);

        this.start();
        this._syncEvents();
    }

    get _wide() {
        return this._settings.get_int(`${PREFIX}-layout`) === LAYOUT_WIDE;
    }

    get _lookahead() {
        return LOOKAHEAD_DAYS[this._settings.get_int(`${PREFIX}-lookahead`)] ?? 30;
    }

    // Events are only read while the list is on screen.
    _syncEvents(force = false) {
        if (!this._wide)
            return;
        if (force || !this._events.loaded)
            this._events.load(this._lookahead);
    }

    // --- Event list (port of _doRebuildEventsModel in main.qml) ---

    _formatTime(date) {
        if (this._interfaceSettings.get_string('clock-format') === '24h')
            return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
        const h = date.getHours() % 12 || 12;
        const suffix = date.getHours() < 12 ? _('AM') : _('PM');
        return `${h}:${String(date.getMinutes()).padStart(2, '0')} ${suffix}`;
    }

    // Groups the events into "today", "this week" and "upcoming" sections.
    // An event that started before today but is still going shows under
    // today, like the KDE widget's per-day lookup.
    _buildItems() {
        const todayStart = startOfDay(this._today);
        const firstDow = this._firstDayOfWeek();
        const daysToWeekEnd = (firstDow - todayStart.getDay() + 7) % 7 || 7;
        const weekEnd = new Date(todayStart.getFullYear(), todayStart.getMonth(),
            todayStart.getDate() + daysToWeekEnd);
        const lookaheadEnd = new Date(todayStart.getFullYear(), todayStart.getMonth(),
            todayStart.getDate() + this._lookahead);

        const sections = {today: [], week: [], upcoming: []};
        for (const ev of this._events.events) {
            const start = new Date(ev.start * 1000);
            const end = new Date(ev.end * 1000);
            // Everything from today on, including today's earlier events,
            // as in the KDE widget. (All-day events end at next midnight.)
            if (start < todayStart && end <= todayStart)
                continue;

            const day = start < todayStart ? todayStart : startOfDay(start);
            if (day >= lookaheadEnd)
                continue;

            const item = {
                title: ev.title || _('Untitled event'),
                color: /^#[0-9a-f]{6}/i.test(ev.color ?? '') ? rgba(ev.color.slice(0, 7)) : DEFAULT_EVENT_COLOR,
            };
            if (day.getTime() === todayStart.getTime()) {
                item.time = ev.allDay || start < todayStart ? _('All day') : this._formatTime(start);
                sections.today.push(item);
            } else if (day < weekEnd) {
                item.time = day.toLocaleDateString(undefined, {weekday: 'short', day: 'numeric'});
                sections.week.push(item);
            } else {
                item.time = day.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
                sections.upcoming.push(item);
            }
        }

        const items = [];
        const add = (title, list) => {
            if (list.length === 0)
                return;
            items.push({header: title, first: items.length === 0});
            items.push(...list);
        };
        add(_('Events today'), sections.today);
        add(_('This week'), sections.week);
        add(_('Upcoming'), sections.upcoming);
        this._items = items;
        this._canvas.queue_repaint();
    }

    _onScroll(event) {
        if (!this._wide || !this._listBox || event.is_pointer_emulated())
            return Clutter.EVENT_PROPAGATE;
        const [ok, x] = this._canvas.transform_stage_point(...event.get_coords());
        if (!ok || x > this._listBox.x + this._listBox.w)
            return Clutter.EVENT_PROPAGATE;

        let delta;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: delta = -1; break;
        case Clutter.ScrollDirection.DOWN: delta = 1; break;
        case Clutter.ScrollDirection.SMOOTH: delta = event.get_scroll_delta()[1]; break;
        default: return Clutter.EVENT_PROPAGATE;
        }
        const max = Math.max(0, (this._listContentHeight ?? 0) - this._listBox.h);
        this._scroll = Math.max(0, Math.min(max, this._scroll + delta * this._listBox.step));
        this._canvas.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    // --- DesktopWidget hooks ---

    sizeKeys() {
        return ['size', 'layout'];
    }

    readSize() {
        const size = this._settings.get_int(`${PREFIX}-size`);
        return this._wide ? [size * WIDE_FACTOR, size] : [size, size];
    }

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
        this._scroll = 0;
        this._canvas.queue_repaint();
    }

    addMenuItems(menu) {
        menu.addAction(_('Open Calendar'), () => {
            Shell.AppSystem.get_default()
                .lookup_app('org.gnome.Calendar.desktop')?.activate();
        });
        menu.addAction(_('Refresh Events'), () => this._events.refresh());
    }

    _onDestroy() {
        this._wallClock.run_dispose();
        this._events.destroy();
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
        // Wide: the grid keeps a square on the right, the list takes the rest.
        const gridW = this._wide ? h : w;
        if (this._wide)
            this._paintEvents(cr, w - gridW - Math.round(h * 0.04), h, colors);
        this._paintGrid(cr, w - gridW, gridW, h, colors);
    }

    _paintGrid(cr, x0, w, h, colors) {
        const label = Math.max(10, Math.round(h * 0.058));
        const margin = Math.round(h * 0.09);
        const top = Math.round(h * 0.14);
        const spacing = Math.round(h * 0.02);
        const headerH = label * 1.4;

        const font = {family: FONT_FAMILY, size: label};
        const text = new TextPainter(cr);

        const left = x0 + margin;
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

    // Port of the left panel in main.qml and EventCard.qml.
    _paintEvents(cr, panelW, h, colors) {
        const margin = Math.round(h * 0.09);
        const labelSize = Math.max(10, Math.round(h * 0.058));
        const cardSize = Math.max(10, Math.round(h * 0.052));
        const cardH = Math.round(cardSize * 2.8);
        const spacing = Math.round(h * 0.025);
        const box = {x: margin, y: margin, w: Math.max(1, panelW - 2 * margin), h: h - 2 * margin, step: cardH + spacing};
        this._listBox = box;
        const text = new TextPainter(cr);
        const fg = colors.foreground;

        if (this._items.length === 0) {
            this._listContentHeight = 0;
            setSource(cr, fg, 0.45);
            const message = this._events.loaded ? _('No upcoming events')
                : this._events.failed ? _('Couldn’t read your calendars') : _('Loading events…');
            text.draw(message,
                panelW / 2, h / 2, {family: FONT_FAMILY, size: labelSize}, {align: 0.5, valign: 0.5, maxWidth: box.w});
            return;
        }

        cr.save();
        cr.rectangle(0, box.y, panelW, box.h);
        cr.clip();

        let y = box.y - this._scroll;
        for (const item of this._items) {
            if (item.header) {
                const pad = item.first ? 0 : spacing;
                const headerH = Math.round(labelSize * 1.4) + pad;
                if (y + headerH > box.y - 1 && y < box.y + box.h) {
                    setSource(cr, fg, 0.55);
                    text.draw(item.header, box.x, y + pad, {family: FONT_FAMILY, size: labelSize},
                        {letterSpacing: 0.5, maxWidth: box.w});
                }
                y += headerH + spacing;
                continue;
            }

            if (y + cardH > box.y - 1 && y < box.y + box.h)
                this._paintCard(cr, text, item, box.x, y, box.w, cardH, cardSize, colors);
            y += cardH + spacing;
        }
        this._listContentHeight = y + this._scroll - spacing - box.y;
        cr.restore();
    }

    _paintCard(cr, text, item, x, y, w, h, fontSize, colors) {
        setSource(cr, colors.cardBackground, colors.cardBackgroundOpacity);
        roundedRect(cr, x, y, w, h, Math.round(h * 0.25));
        cr.fill();

        const pad = Math.round(h * 0.22);
        setSource(cr, item.color);
        roundedRect(cr, x + pad, y + pad, 3, h - 2 * pad, 1.5);
        cr.fill();

        const timeFont = {family: FONT_FAMILY, size: Math.round(fontSize * 0.85)};
        const timeW = text.width(item.time, timeFont);
        setSource(cr, colors.foreground, 0.6);
        text.draw(item.time, x + w - pad, y + h / 2, timeFont, {align: 1, valign: 0.5});

        const titleX = x + pad + 3 + 6;
        setSource(cr, colors.foreground);
        text.draw(item.title, titleX, y + h / 2, {family: FONT_FAMILY, size: fontSize},
            {valign: 0.5, maxWidth: Math.max(10, x + w - pad - timeW - 4 - titleX)});
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
