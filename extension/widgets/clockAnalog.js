// Port of packages/clock-analog (macOS Clock I): numbered dial, pill ticks,
// hour/minute hands and an orange sweeping second hand on liquid glass.
//
// The dial is painted once per size or style change. Each hand is its own
// St.DrawingArea drawn pointing at 12 and turned with rotation_angle_z, so a
// clock tick only changes a transform and never re-runs cairo.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopWidget} from '../lib/desktopWidget.js';
import {rgba, withAlpha} from '../lib/colors.js';

const PREFIX = 'clock-analog';
const SECOND_HAND = rgba('#F6A029');
const FONT_FAMILY = 'SF Pro Rounded';

function setSource(cr, c) {
    cr.setSourceRGBA(c.r, c.g, c.b, c.a);
}

// Vertical capsule from y = top to y = top + length, centred on x = 0.
function capsule(cr, top, length, width) {
    const r = width / 2;
    cr.newSubPath();
    cr.arc(0, top + r, r, Math.PI, 2 * Math.PI);
    cr.arc(0, top + length - r, r, 0, Math.PI);
    cr.closePath();
}

// Thin stem from the pivot, then a wider pill with rounded ends.
function hand(cr, totalLen, stemEnd, stemW, pillW) {
    cr.rectangle(-stemW / 2, -stemEnd, stemW, stemEnd);
    cr.fill();
    capsule(cr, -totalLen, totalLen - stemEnd, pillW);
    cr.fill();
}

function faceGeometry(area) {
    const [w, h] = area.get_surface_size();
    const r = Math.min(w, h) / 2;
    const tickW = r * 0.020;
    const outerR = r - tickW * 2;
    const innerR = outerR - r * 0.09;
    const minuteLen = (outerR + innerR) / 2;
    return {cx: w / 2, cy: h / 2, r, tickW, outerR, minuteLen, hourLen: minuteLen * 0.65};
}

export const AnalogClock = GObject.registerClass(
class AnalogClock extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._dial = this._addLayer(this._paintDial);
        this._hourHand = this._addLayer(this._paintHourHand);
        this._minuteHand = this._addLayer(this._paintMinuteHand);
        this._secondHand = this._addLayer(this._paintSecondHand);

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._tickSourceId = 0;

        settings.connectObject(`changed::${PREFIX}-smooth-seconds`, () => this._startTicking(),
            `changed::${PREFIX}-opaque-background`, () => this._loadStyle(),
            this);

        this.start();
        this._startTicking();
    }

    _addLayer(paint) {
        const area = new St.DrawingArea();
        area.set_pivot_point(0.5, 0.5);
        area.connect('repaint', () => {
            const cr = area.get_context();
            paint.call(this, cr, faceGeometry(area));
            cr.$dispose();
        });
        this.body.add_child(area);
        return area;
    }

    _layers() {
        return [this._dial, this._hourHand, this._minuteHand, this._secondHand];
    }

    // --- DesktopWidget hooks ---

    solidBackground(colors) {
        // Solid style keeps the glass squircle unless "opaque background" is
        // on; the opaque card is always the dark fill, even in light mode.
        return {
            solid: colors.isSolid && this._settings.get_boolean(`${PREFIX}-opaque-background`),
            solidColor: rgba('#1A1B1E'),
        };
    }

    styleChanged(colors) {
        this._dialColor = rgba(colors.isLight ? '#000000' : '#ffffff');
        this._faceColor = colors.isGlass
            ? rgba('#ffffff', 0.20)
            : rgba(colors.isLight ? '#ffffff' : '#343436');
        this._numberColor = withAlpha(colors.foreground, colors.isGlass ? 0.85 : 1.0);
        this._handColor = withAlpha(colors.foreground, colors.isGlass ? 0.92 : 1.0);

        for (const layer of this._layers())
            layer.queue_repaint();
    }

    layoutContent(width, height) {
        // Face inset 8% from the glass edge, as in the KDE widget.
        const margin = Math.min(width, height) * 0.08;
        const faceSize = Math.min(width, height) - 2 * margin;
        for (const layer of this._layers()) {
            layer.set_position((width - faceSize) / 2, (height - faceSize) / 2);
            layer.set_size(faceSize, faceSize);
        }
    }

    addMenuItems(menu) {
        menu.addAction(_('Adjust Date and Time…'), () => {
            Shell.AppSystem.get_default()
                .lookup_app('gnome-datetime-panel.desktop')?.activate();
        });
    }

    // --- Time ---

    _startTicking() {
        this._timeline.stop();
        if (this._tickSourceId) {
            GLib.source_remove(this._tickSourceId);
            this._tickSourceId = 0;
        }

        this._smooth = this._settings.get_boolean(`${PREFIX}-smooth-seconds`);
        this._tick();

        if (this._smooth)
            this._timeline.start();
        else
            this._scheduleNextSecond();
    }

    // One-shot timer at the next second boundary, rescheduled each time, so
    // the hand stays in step with the wall clock without polling.
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
        const d = new Date();
        const sec = d.getSeconds() + (this._smooth ? d.getMilliseconds() / 1000 : 0);
        const min = d.getMinutes() + sec / 60;
        const hr = (d.getHours() % 12) + min / 60;
        this._secondHand.rotation_angle_z = sec * 6;
        this._minuteHand.rotation_angle_z = min * 6;
        this._hourHand.rotation_angle_z = hr * 30;
    }

    _onDestroy() {
        this._timeline.stop();
        if (this._tickSourceId)
            GLib.source_remove(this._tickSourceId);
        this._tickSourceId = 0;
        super._onDestroy();
    }

    // --- Painting ---

    _paintDial(cr, g) {
        // Plate
        setSource(cr, this._faceColor);
        cr.arc(g.cx, g.cy, g.r, 0, 2 * Math.PI);
        cr.fill();

        // Pill ticks: majors at 75%, minors at 30%
        cr.save();
        cr.translate(g.cx, g.cy);
        for (let i = 0; i < 60; i++) {
            setSource(cr, withAlpha(this._dialColor, i % 5 === 0 ? 0.75 : 0.30));
            cr.save();
            cr.rotate(i * 6 * Math.PI / 180);
            capsule(cr, -g.outerR, g.r * 0.09, g.tickW);
            cr.fill();
            cr.restore();
        }
        cr.restore();

        // Hour numbers
        const layout = PangoCairo.create_layout(cr);
        const font = new Pango.FontDescription();
        font.set_family(FONT_FAMILY);
        font.set_weight(Pango.Weight.MEDIUM);
        font.set_absolute_size(Math.max(8, g.r * 0.17) * Pango.SCALE);
        layout.set_font_description(font);

        setSource(cr, this._numberColor);
        for (let num = 1; num <= 12; num++) {
            const angle = num / 12 * 2 * Math.PI;
            const dist = g.r * 0.72;
            layout.set_text(String(num), -1);
            const [, logical] = layout.get_pixel_extents();
            cr.moveTo(
                g.cx + Math.sin(angle) * dist - logical.width / 2 - logical.x,
                g.cy - Math.cos(angle) * dist - logical.height / 2 - logical.y);
            PangoCairo.show_layout(cr, layout);
        }
    }

    _paintHourHand(cr, g) {
        cr.translate(g.cx, g.cy);
        setSource(cr, this._handColor);
        hand(cr, g.hourLen, g.r * 0.15, g.r * 0.0336, g.r * 0.065);
    }

    _paintMinuteHand(cr, g) {
        cr.translate(g.cx, g.cy);
        setSource(cr, this._handColor);
        hand(cr, g.minuteLen, g.r * 0.15, g.r * 0.0336, g.r * 0.065);

        // Pivot covering both stem bases
        cr.arc(0, 0, g.r * 0.050, 0, 2 * Math.PI);
        cr.fill();
    }

    _paintSecondHand(cr, g) {
        cr.translate(g.cx, g.cy);
        setSource(cr, SECOND_HAND);

        const len = g.r - g.tickW * 2;
        const counterWeight = g.r * 0.15;
        const hw = g.r * 0.007 * 1.3;
        cr.rectangle(-hw, -len, hw * 2, len + counterWeight);
        cr.fill();

        // Centre hinge dot
        cr.arc(0, 0, g.r * 0.035, 0, 2 * Math.PI);
        cr.fill();
    }
});
