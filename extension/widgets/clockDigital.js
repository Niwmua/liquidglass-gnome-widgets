// Port of packages/clock-digital (macOS Clock Digital): hours and minutes in
// Barlow Condensed inside a ring of 60 ticks that follows the glass edge.
// The ticks double as a seconds hand: the current second lights up and a
// trail fades out behind it over 270 degrees, like a comet.
//
// Two St.DrawingAreas: the time, repainted once a minute (GnomeDesktop
// WallClock), and the tick ring, repainted every second, or every frame
// with smooth seconds on. 12/24-hour follows the GNOME clock setting.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopWidget} from '../lib/desktopWidget.js';
import {setSource, TextPainter} from '../lib/draw.js';
import {perimeterTicks} from '../lib/squircle.js';

const PREFIX = 'clock-digital';
const FONT_FAMILY = 'Barlow Condensed';
const TRAIL_DEGREES = 270;
const SLOT = 1; // position in the row of clocks along the top-right

export const DigitalClock = GObject.registerClass(
class DigitalClock extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._ring = new St.DrawingArea();
        this._ring.connect('repaint', () => {
            const cr = this._ring.get_context();
            this._paintRing(cr);
            cr.$dispose();
        });
        this._time = new St.DrawingArea();
        this._time.connect('repaint', () => {
            const cr = this._time.get_context();
            this._paintTime(cr);
            cr.$dispose();
        });
        this.body.add_child(this._ring);
        this.body.add_child(this._time);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connect('notify::clock', () => this._time.queue_repaint());
        this._interfaceSettings.connectObject('changed::clock-format',
            () => this._time.queue_repaint(), this);

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._ring.queue_repaint());
        this._tickSourceId = 0;
        settings.connectObject(`changed::${PREFIX}-smooth-seconds`, () => this._startTicking(), this);

        this.start();
        this._startTicking();
    }

    // --- DesktopWidget hooks ---

    defaultPosition(area, width, _height, margin) {
        const x = area.x + area.width - width - margin - SLOT * (width + margin / 2);
        return [Math.max(area.x + margin, x), area.y + margin];
    }

    styleChanged(colors) {
        this._palette = colors;
        this._ticks = null; // the ring follows the glass shape
        this._ring?.queue_repaint();
        this._time?.queue_repaint();
    }

    layoutContent(width, height) {
        this._ticks = null;
        for (const area of [this._ring, this._time]) {
            area.set_position(0, 0);
            area.set_size(width, height);
        }
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

    // --- Seconds ---

    _startTicking() {
        this._timeline.stop();
        if (this._tickSourceId)
            GLib.source_remove(this._tickSourceId);
        this._tickSourceId = 0;

        this._smooth = this._settings.get_boolean(`${PREFIX}-smooth-seconds`);
        this._ring.queue_repaint();
        if (this._smooth)
            this._timeline.start();
        else
            this._scheduleNextSecond();
    }

    _scheduleNextSecond() {
        const delay = 1000 - new Date().getMilliseconds();
        this._tickSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._tickSourceId = 0;
            this._ring.queue_repaint();
            this._scheduleNextSecond();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Painting ---

    // Port of TickRing.qml. The newest tick fades in over its second (with
    // smooth seconds; stepped, it lights at the next tick), and the trail
    // hangs off the previous tick so it never outshines that fade.
    _paintRing(cr) {
        const colors = this._palette;
        if (!colors)
            return;

        const [w, h] = this._ring.get_surface_size();
        const s = this._settings;
        this._ticks ??= perimeterTicks(w, h,
            s.get_int('corner-radius'), s.get_int('roundness-x10') / 10);

        const ms = Date.now() % 60000;
        const pos = this._smooth ? ms / 1000 : Math.floor(ms / 1000);
        const current = Math.floor(pos) % 60;
        const previous = (current + 59) % 60;
        const t = pos - Math.floor(pos);
        const headFade = t * t * (3 - 2 * t);
        const base = colors.isGlass ? 0.18 : 0.30;

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(2.2);
        this._ticks.forEach((tick, i) => {
            let lit = 0;
            if (i === current) {
                lit = headFade;
            } else {
                const behind = ((previous - i) * 6 + 360) % 360;
                if (behind <= TRAIL_DEGREES)
                    lit = (1 - behind / TRAIL_DEGREES) ** 0.6;
            }
            setSource(cr, colors.foreground, base + (1 - base) * lit);
            cr.moveTo(tick.inner.x, tick.inner.y);
            cr.lineTo(tick.outer.x, tick.outer.y);
            cr.stroke();
        });
    }

    // Port of DigitalTime.qml: HH:MM with a two-dot colon, shrunk to fit
    // inside the ring if needed.
    _paintTime(cr) {
        const colors = this._palette;
        if (!colors)
            return;

        const [w, h] = this._time.get_surface_size();
        const minSide = Math.min(w, h);
        const now = new Date();
        const use24 = this._interfaceSettings.get_string('clock-format') === '24h';
        const hours = use24 ? String(now.getHours()).padStart(2, '0') : String((now.getHours() + 11) % 12 + 1);
        const minutes = String(now.getMinutes()).padStart(2, '0');

        const text = new TextPainter(cr);
        const fontFor = size => ({family: FONT_FAMILY, size, weight: Pango.Weight.MEDIUM});
        const spacingFor = size => -size * 0.03;
        const dotFor = size => Math.max(3, Math.round(size * 0.10));

        // Natural width at the target size, then scale down to the space
        // the ring leaves (15% of the short side on each side).
        let size = minSide * 0.60;
        const natural = text.width(hours, fontFor(size), {letterSpacing: spacingFor(size)}) +
            text.width(minutes, fontFor(size), {letterSpacing: spacingFor(size)}) +
            dotFor(size) + 2 * size * 0.10;
        const available = Math.max(40, w - 2 * minSide * 0.15);
        if (natural > available)
            size *= available / natural;

        const font = fontFor(size);
        const opts = {letterSpacing: spacingFor(size)};
        const gap = size * 0.10;
        const dot = dotFor(size);
        const hoursW = text.width(hours, font, opts);
        const minutesW = text.width(minutes, font, opts);
        let x = (w - (hoursW + gap + dot + gap + minutesW)) / 2;
        const cy = h / 2;

        setSource(cr, colors.foreground, colors.isGlass ? 0.55 : 1.0);
        text.draw(hours, x, cy, font, {...opts, valign: 0.5});
        x += hoursW + gap;

        const spacing = dot * 1.4;
        for (const dy of [-(spacing + dot) / 2, (spacing + dot) / 2]) {
            cr.arc(x + dot / 2, cy + dy, dot / 2, 0, 2 * Math.PI);
            cr.fill();
        }
        x += dot + gap;
        text.draw(minutes, x, cy, font, {...opts, valign: 0.5});
    }
});
