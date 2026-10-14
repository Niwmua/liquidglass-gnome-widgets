// Port of the KDE analog clocks, one class with a variant per package:
//   clock-analog    macOS Clock I    numbered dial, 60 pill ticks
//   clock-analog-2  macOS Clock II   dial with 12 bold hour bars, no numerals
//   clock-analog-3  macOS Clock III  no dial plate; 60 ticks that follow the
//                                    glass edge, numerals at 12/3/6/9
// All share the hands: hour/minute pills and an orange second hand.
//
// The dial is painted once per size or style change. Each hand is its own
// St.DrawingArea drawn pointing at 12 and turned with rotation_angle_z, so a
// clock tick only changes a transform and never re-runs cairo. Every layer
// covers the whole widget; `r` is the face radius (84% of the half side,
// i.e. the KDE widgets' 8% inset).

import Cairo from 'cairo';
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
import {perimeterTicks} from '../lib/squircle.js';

const SECOND_HAND = rgba('#F6A029');
const FONT_FAMILY = 'SF Pro Rounded';

// Per-variant differences from Clock I.
export const ANALOG_VARIANTS = {
    'clock-analog': {
        dial: 'minute-ticks',
        numerals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        numeralDist: 0.72,
        numeralSize: 0.17,
        plate: true,
        handScale: 1,
        slot: 0,
    },
    'clock-analog-2': {
        dial: 'hour-bars',
        numerals: [],
        plate: true,
        handScale: 1,
        slot: 2,
    },
    'clock-analog-3': {
        dial: 'edge-ticks',
        numerals: [12, 3, 6, 9],
        numeralDist: 0.64,
        numeralSize: 0.238,
        plate: false,
        // Hands 15% longer; second hand reaches the outer end of the edge
        // ticks (5% inset of the side = 90% of the half side).
        handScale: 1.15,
        secondLength: g => g.R * 0.90,
        hingeRadius: g => g.R * 0.035,
        slot: 3,
    },
};

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

function faceGeometry(area, handScale) {
    const [w, h] = area.get_surface_size();
    const R = Math.min(w, h) / 2;
    const r = R * 0.84;
    const tickW = r * 0.020;
    const outerR = r - tickW * 2;
    const innerR = outerR - r * 0.09;
    const minuteLen = (outerR + innerR) / 2 * handScale;
    return {w, h, cx: w / 2, cy: h / 2, R, r, tickW, outerR, innerR, minuteLen, hourLen: minuteLen * 0.65};
}

export const AnalogClock = GObject.registerClass(
class AnalogClock extends DesktopWidget {
    _init(extension, settings, prefix = 'clock-analog') {
        super._init(extension, settings, prefix);
        this._variant = ANALOG_VARIANTS[prefix];

        this._dial = this._addLayer(this._paintDial);
        this._hourHand = this._addLayer(this._paintHourHand);
        this._minuteHand = this._addLayer(this._paintMinuteHand);
        this._secondHand = this._addLayer(this._paintSecondHand);

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._tickSourceId = 0;

        settings.connectObject(`changed::${prefix}-smooth-seconds`, () => this._startTicking(), this);
        if (this._variant.plate)
            settings.connectObject(`changed::${prefix}-opaque-background`, () => this._loadStyle(), this);

        this.start();
        this._startTicking();
    }

    _addLayer(paint) {
        const area = new St.DrawingArea();
        area.set_pivot_point(0.5, 0.5);
        area.connect('repaint', () => {
            const cr = area.get_context();
            paint.call(this, cr, faceGeometry(area, this._variant.handScale));
            cr.$dispose();
        });
        this.body.add_child(area);
        return area;
    }

    _layers() {
        return [this._dial, this._hourHand, this._minuteHand, this._secondHand];
    }

    // --- DesktopWidget hooks ---

    defaultPosition(area, width, _height, margin) {
        // Top-right; the other clock variants line up to its left.
        const x = area.x + area.width - width - margin - this._variant.slot * (width + margin / 2);
        return [Math.max(area.x + margin, x), area.y + margin];
    }

    solidBackground(colors) {
        // Clocks with a dial plate keep the glass squircle in Solid style
        // unless "opaque background" is on; that card is always the dark
        // fill, even in light mode. Clock III has no plate and uses the
        // regular solid card.
        if (!this._variant.plate)
            return super.solidBackground(colors);
        return {
            solid: colors.isSolid && this._settings.get_boolean(`${this._prefix}-opaque-background`),
            solidColor: rgba('#1A1B1E'),
        };
    }

    styleChanged(colors) {
        this._palette = colors;
        this._dialColor = rgba(colors.isLight ? '#000000' : '#ffffff');
        this._faceColor = colors.isGlass
            ? rgba('#ffffff', 0.20)
            : rgba(colors.isLight ? '#ffffff' : '#343436');
        this._numberColor = withAlpha(colors.foreground, colors.isGlass ? 0.85 : 1.0);
        this._handColor = withAlpha(colors.foreground, colors.isGlass ? 0.92 : 1.0);

        // The edge ticks follow the glass shape, which these settings set.
        this._edgeTicks = null;

        for (const layer of this._layers())
            layer.queue_repaint();
    }

    layoutContent(width, height) {
        this._edgeTicks = null;
        for (const layer of this._layers()) {
            layer.set_position(0, 0);
            layer.set_size(width, height);
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

        this._smooth = this._settings.get_boolean(`${this._prefix}-smooth-seconds`);
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
        if (this._variant.plate) {
            setSource(cr, this._faceColor);
            cr.arc(g.cx, g.cy, g.r, 0, 2 * Math.PI);
            cr.fill();
        }

        switch (this._variant.dial) {
        case 'minute-ticks': this._paintMinuteTicks(cr, g); break;
        case 'hour-bars': this._paintHourBars(cr, g); break;
        case 'edge-ticks': this._paintEdgeTicks(cr, g); break;
        }

        this._paintNumerals(cr, g);
    }

    // Clock I: pill ticks, majors at 75%, minors at 30%.
    _paintMinuteTicks(cr, g) {
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
    }

    // Clock II: 12 pills, a bit thicker than the minute hand and 40% of the
    // hour hand's length, inward from the same outer edge as Clock I's ticks.
    _paintHourBars(cr, g) {
        const width = g.r * 0.0336 * 0.9 * 1.15 * 1.35;
        const length = g.hourLen * 0.40 * 0.90 * 1.10;
        setSource(cr, withAlpha(this._palette.foreground, 0.75));
        cr.save();
        cr.translate(g.cx, g.cy);
        for (let i = 0; i < 12; i++) {
            cr.save();
            cr.rotate(i * 30 * Math.PI / 180);
            capsule(cr, -g.outerR, length, width);
            cr.fill();
            cr.restore();
        }
        cr.restore();
    }

    // Clock III: ticks along the glass edge. Hour ticks are thicker and
    // brighter, and reach inward to a circle (70% of the half side).
    _paintEdgeTicks(cr, g) {
        const s = this._settings;
        this._edgeTicks ??= perimeterTicks(g.w, g.h,
            s.get_int('corner-radius'), s.get_int('roundness-x10') / 10);

        const colors = this._palette;
        const circleR = g.R * 0.699;
        cr.setLineCap(Cairo.LineCap.ROUND);
        this._edgeTicks.forEach((t, i) => {
            const isHour = i % 5 === 0;
            let inner = t.inner;
            if (isHour) {
                // On the circle, pulled 10% back towards the outer end.
                const cx = g.cx + t.dx * circleR;
                const cy = g.cy + t.dy * circleR;
                inner = {x: cx + (t.outer.x - cx) * 0.10, y: cy + (t.outer.y - cy) * 0.10};
            }
            const opacity = isHour
                ? (colors.isGlass ? 0.85 : 1.0)
                : (colors.isGlass ? 0.24 : 0.30);
            setSource(cr, withAlpha(colors.foreground, opacity));
            cr.setLineWidth(isHour ? 2.2 * 1.3225 : 2.2);
            cr.moveTo(inner.x, inner.y);
            cr.lineTo(t.outer.x, t.outer.y);
            cr.stroke();
        });
    }

    _paintNumerals(cr, g) {
        const {numerals, numeralDist, numeralSize} = this._variant;
        if (numerals.length === 0)
            return;

        const layout = PangoCairo.create_layout(cr);
        const font = new Pango.FontDescription();
        font.set_family(FONT_FAMILY);
        font.set_weight(Pango.Weight.MEDIUM);
        font.set_absolute_size(Math.max(8, g.r * numeralSize) * Pango.SCALE);
        layout.set_font_description(font);

        setSource(cr, this._numberColor);
        for (const num of numerals) {
            const angle = num / 12 * 2 * Math.PI;
            const dist = g.r * numeralDist;
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

        const len = this._variant.secondLength?.(g) ?? g.r - g.tickW * 2;
        const counterWeight = g.r * 0.15;
        const hw = g.r * 0.007 * 1.3;
        cr.rectangle(-hw, -len, hw * 2, len + counterWeight);
        cr.fill();

        // Centre hinge dot
        cr.arc(0, 0, this._variant.hingeRadius?.(g) ?? g.r * 0.035, 0, 2 * Math.PI);
        cr.fill();
    }
});
