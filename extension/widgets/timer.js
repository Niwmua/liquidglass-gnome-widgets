// Port of packages/timer (macOS Timer): minute/second drum pickers, a
// rolling-digit countdown, start/pause/cancel buttons and, in the wide
// layout, a list of presets.
//
// The countdown itself lives in TimerModel (owned by the extension), so it
// keeps running and rings while this widget is hidden on the lock screen.
// Interactive parts are reactive St.DrawingAreas that stop the button press,
// so pressing them never starts a widget drag; the empty glass still drags.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DesktopWidget} from '../lib/desktopWidget.js';
import {setSource, TextPainter} from '../lib/draw.js';
import {TimerState} from '../lib/timerModel.js';

const PREFIX = 'timer';
const FONT_FAMILY = 'SF Pro Display';
const PRESET_MINUTES = [1, 2, 3, 5, 10, 15];

const LAYOUT_WIDE = 1;
const WIDE_FACTOR = 2.1;

const FADE_MS = 180;
const SLIDE_MS = 220;
const ROLL_MS = 520;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeOutCubic = t => 1 - (1 - t) ** 3;
const easeOutQuint = t => 1 - (1 - t) ** 5;
const pad2 = n => String(n).padStart(2, '0');

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

// Fades an actor in or out, hiding it (and its input) once faded out.
function fade(actor, show, animate) {
    actor.remove_transition('opacity');
    actor.reactive = show;
    if (show)
        actor.show();
    if (!animate) {
        actor.opacity = show ? 255 : 0;
        actor.visible = show;
        return;
    }
    actor.ease({
        opacity: show ? 255 : 0,
        duration: FADE_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
            if (!show)
                actor.hide();
        },
    });
}

// A drawing area that acts as a button: paint(cr, button) draws it, and
// 'clicked' fires on a primary press and release inside it.
const CanvasButton = GObject.registerClass({
    Signals: {'clicked': {}},
}, class CanvasButton extends St.DrawingArea {
    _init(paint) {
        super._init({reactive: true, track_hover: true});
        this.pressed = false;
        this.connect('repaint', () => {
            const cr = this.get_context();
            paint(cr, this);
            cr.$dispose();
        });
        this.connect('notify::hover', () => this.queue_repaint());
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this.pressed = true;
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !this.pressed)
            return Clutter.EVENT_PROPAGATE;
        this.pressed = false;
        this.queue_repaint();
        this.emit('clicked');
        return Clutter.EVENT_STOP;
    }

    vfunc_leave_event(event) {
        if (this.pressed) {
            this.pressed = false;
            this.queue_repaint();
        }
        return super.vfunc_leave_event(event);
    }
});

// Port of CylinderPicker.qml: a drum of two-digit numbers that turns with
// the mouse wheel or a drag, flicks with momentum and snaps to a value.
// `drum-position` is the drum position in items (0 = first value centred).
// (Not `position`: every Clutter.Actor already has one.) The actor is wider
// than the drum so the unit label fits to its right.
const Picker = GObject.registerClass({
    Properties: {
        'drum-position': GObject.ParamSpec.double('drum-position', null, null,
            GObject.ParamFlags.READWRITE, -1000, 1000, 0),
    },
    Signals: {'value-changed': {}},
}, class Picker extends St.DrawingArea {
    _init(count, label) {
        super._init({reactive: true});
        this._count = count;
        this._label = label;
        this._position = 0;
        this._value = 0;
        this._drumWidth = 1;
        this._fg = null;
        this._dragging = false;
        this._snapSourceId = 0;

        this.connect('repaint', () => {
            const cr = this.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.connect('destroy', () => {
            this._endDrag();
            this._clearSnapTimer();
        });
    }

    get drum_position() {
        return this._position;
    }

    set drum_position(v) {
        if (this._position === v)
            return;
        this._position = v;
        this.notify('drum-position');
        this.queue_repaint();
    }

    get value() {
        return this._value;
    }

    setValue(value) {
        this._stopMotion();
        this._value = clamp(Math.round(value), 0, this._count - 1);
        this.drum_position = this._value;
    }

    setGeometry(drumWidth, fg) {
        this._drumWidth = drumWidth;
        this._fg = fg;
        this.queue_repaint();
    }

    get _itemHeight() {
        return Math.max(1, this.height / 5);
    }

    _clampPosition(p) {
        return clamp(p, 0, this._count - 1);
    }

    _stopMotion() {
        this.remove_transition('drum-position');
        this._clearSnapTimer();
    }

    _clearSnapTimer() {
        if (this._snapSourceId)
            GLib.source_remove(this._snapSourceId);
        this._snapSourceId = 0;
    }

    _snap() {
        const target = this._clampPosition(Math.round(this._position));
        this.ease_property('drum-position', target, {
            duration: 220,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => {
                if (this._value !== target) {
                    this._value = target;
                    this.emit('value-changed');
                }
            },
        });
    }

    vfunc_scroll_event(event) {
        // A wheel notch arrives twice: as a discrete step and as an emulated
        // smooth scroll. Take only the real one.
        if (event.is_pointer_emulated())
            return Clutter.EVENT_PROPAGATE;

        let delta;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: delta = -1; break;
        case Clutter.ScrollDirection.DOWN: delta = 1; break;
        case Clutter.ScrollDirection.SMOOTH: delta = event.get_scroll_delta()[1]; break;
        default: return Clutter.EVENT_PROPAGATE;
        }

        this._stopMotion();
        this.drum_position = this._clampPosition(this._position + delta * 0.8);
        this._snapSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._snapSourceId = 0;
            this._snap();
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        this._stopMotion();
        this._grab = global.stage.grab(this);
        this._dragging = true;
        this._lastY = event.get_coords()[1];
        this._velocity = 0;
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;

        const y = event.get_coords()[1];
        const dy = this._lastY - y;
        this._velocity = dy;
        this._lastY = y;
        this.drum_position = this._clampPosition(this._position + dy / this._itemHeight);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._dragging || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        this._endDrag();

        // Flick: coast on for five frames' worth of the last movement.
        const momentum = this._velocity * 5 / this._itemHeight;
        if (Math.abs(momentum) > 0.3) {
            this.ease_property('drum-position', this._clampPosition(this._position + momentum), {
                duration: 320,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete: () => this._snap(),
            });
        } else {
            this._snap();
        }
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this._dragging = false;
    }

    _paint(cr) {
        if (!this._fg)
            return;

        const [, h] = this.get_surface_size();
        const drumW = this._drumWidth;
        const itemH = h / 5;
        const radius = h / 2;
        const maxAngle = Math.PI / 2.2;
        const text = new TextPainter(cr);
        const font = {family: FONT_FAMILY, size: itemH * 0.82, weight: Pango.Weight.MEDIUM};

        cr.save();
        cr.rectangle(0, 0, drumW, h);
        cr.clip();

        const first = Math.max(0, Math.floor(this._position - 3));
        const last = Math.min(this._count - 1, Math.ceil(this._position + 3));
        for (let i = first; i <= last; i++) {
            const angle = (i - this._position) * itemH / radius * maxAngle;
            if (Math.abs(angle) >= Math.PI / 2)
                continue;

            const cos = Math.cos(angle);
            const scale = cos ** 0.6;
            if (scale < 0.01)
                continue;
            cr.save();
            cr.translate(drumW / 2, h / 2 + Math.sin(angle) * radius);
            cr.scale(scale, scale);
            setSource(cr, this._fg, cos ** 2.5);
            text.draw(pad2(i), 0, 0, font, {align: 0.5, valign: 0.5});
            cr.restore();
        }

        // Selection lines around the centre slot
        setSource(cr, this._fg, 0.20);
        cr.rectangle(drumW * 0.075, Math.round(h / 2 - itemH / 2 - 1), drumW * 0.85, 1);
        cr.rectangle(drumW * 0.075, Math.round(h / 2 + itemH / 2), drumW * 0.85, 1);
        cr.fill();
        cr.restore();

        // Unit label, outside the drum
        setSource(cr, this._fg, 0.45);
        text.draw(this._label, drumW + 6, h / 2,
            {family: FONT_FAMILY, size: itemH * 0.52}, {valign: 0.5});
    }
});

// Port of CountdownDisplay.qml + RollingDigit.qml: MM:SS in thin digits.
// A changing digit rolls: the old one shrinks into its baseline while the
// new one grows from the top, on a damped spring, smeared while it moves.
const Countdown = GObject.registerClass(
class Countdown extends St.DrawingArea {
    _init() {
        super._init();
        this._digits = [0, 1, 2, 3].map(() => ({rest: '0', from: '0', to: '0', start: 0}));
        this._color = null;
        this._flashStart = 0;

        // Runs only while a digit rolls or the display flashes.
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => {
            this.queue_repaint();
            if (!this._animating)
                this._timeline.stop();
        });

        this.connect('repaint', () => {
            const cr = this.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.connect('destroy', () => this._timeline.stop());
    }

    setColor(color) {
        this._color = color;
        this.queue_repaint();
    }

    setTime(minutes, seconds, animate) {
        const values = [
            String(Math.floor(minutes / 10) % 10), String(minutes % 10),
            String(Math.floor(seconds / 10)), String(seconds % 10),
        ];
        const now = GLib.get_monotonic_time() / 1000;

        values.forEach((value, i) => {
            const d = this._digits[i];
            const current = d.start ? d.to : d.rest;
            if (value === current)
                return;
            if (animate) {
                d.from = current;
                d.to = value;
                d.start = now;
            } else {
                d.rest = d.to = value;
                d.start = 0;
            }
        });

        this._syncTimeline();
        this.queue_repaint();
    }

    // Pulses between 30% and full opacity, 500 ms each way, when time is up.
    setFlashing(flashing) {
        if (flashing === Boolean(this._flashStart))
            return;
        this._flashStart = flashing ? GLib.get_monotonic_time() / 1000 : 0;
        this._syncTimeline();
        this.queue_repaint();
    }

    get _animating() {
        return Boolean(this._flashStart) || this._digits.some(d => d.start);
    }

    _syncTimeline() {
        if (this._animating && !this._timeline.is_playing())
            this._timeline.start();
    }

    _flashAlpha(now) {
        if (!this._flashStart)
            return 1;
        const phase = ((now - this._flashStart) % 1000) / 500;  // 0..2
        const t = phase < 1 ? phase : 2 - phase;                // 0..1..0
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        return 1 - 0.7 * eased;
    }

    _paint(cr) {
        if (!this._color)
            return;

        const [w, h] = this.get_surface_size();
        const fs = Math.min(w, h) * 0.48;
        const digitW = fs * 0.72;
        const digitH = fs * 1.7;
        const colonW = fs * 0.28;
        const gap = fs * 0.02;
        const totalW = digitW * 4 + colonW + gap * 4;
        const font = {family: FONT_FAMILY, size: fs, weight: Pango.Weight.ULTRALIGHT};
        const text = new TextPainter(cr);
        const glyphH = text.measure('0', font).logical.height;
        const now = GLib.get_monotonic_time() / 1000;

        let x = (w - totalW) / 2;
        const top = (h - digitH) / 2;
        const cy = h / 2;

        cr.pushGroup();

        this._digits.forEach((d, i) => {
            cr.save();
            cr.rectangle(x, top, digitW, digitH);
            cr.clip();
            this._paintDigit(cr, text, font, d, x + digitW / 2, cy, glyphH, fs, now);
            cr.restore();
            x += digitW + gap;

            if (i === 1) {
                // Colon: two dots
                const dot = fs * 0.08;
                const spacing = dot * 1.6;
                setSource(cr, this._color, 0.8);
                for (const dy of [-spacing / 2 - dot / 2, spacing / 2 + dot / 2]) {
                    cr.arc(x + colonW / 2, cy + dy, dot / 2, 0, 2 * Math.PI);
                    cr.fill();
                }
                x += colonW + gap;
            }
        });

        cr.popGroupToSource();
        cr.paintWithAlpha(this._flashAlpha(now));
    }

    _paintDigit(cr, text, font, d, cx, cy, glyphH, fs, now) {
        if (!d.start) {
            setSource(cr, this._color);
            text.draw(d.rest, cx, cy, font, {align: 0.5, valign: 0.5});
            return;
        }

        const elapsed = now - d.start;
        const t = clamp(elapsed / ROLL_MS, 0, 1);
        const springT = clamp(elapsed / (ROLL_MS * 1.25), 0, 1);
        if (springT >= 1) {
            d.rest = d.to;
            d.start = 0;
            this._paintDigit(cr, text, font, d, cx, cy, glyphH, fs, now);
            return;
        }

        const p = easeOutCubic(t);
        const speed = Math.sin(Math.PI * p);
        const spring = -Math.exp(-5.2 * springT) * Math.cos(7.6 * springT) * glyphH * 0.12;
        const boxTop = cy - glyphH / 2 + spring;

        // Outgoing digit shrinks towards its bottom edge and fades late.
        this._paintGlyph(cr, text, font, d.from, cx, boxTop, boxTop + glyphH,
            1 - easeOutQuint(t),
            1 - clamp((p - 0.55) / 0.40, 0, 1),
            clamp(p ** 0.45 * 0.64 + speed * 0.40, 0, 1) * fs);

        // Incoming digit grows from its top edge and fades in early.
        this._paintGlyph(cr, text, font, d.to, cx, boxTop, boxTop,
            easeOutQuint(t),
            clamp(p / 0.30, 0, 1),
            clamp((1 - p) ** 0.45 * 0.78 + speed * 0.34, 0, 1) * fs);
    }

    // Draws `str` with its line box top at `top`, scaled about (cx, originY).
    // `blur` (px) is approximated by smearing a few copies vertically.
    _paintGlyph(cr, text, font, str, cx, top, originY, scale, opacity, blur) {
        if (scale < 0.01 || opacity <= 0)
            return;

        const spread = blur * 0.06;
        const offsets = spread > 0.5 ? [-1, -0.5, 0, 0.5, 1].map(k => k * spread) : [0];

        cr.save();
        cr.translate(cx, originY);
        cr.scale(scale, scale);
        cr.translate(0, top - originY);
        setSource(cr, this._color, opacity * Math.min(1, 1.6 / offsets.length));
        for (const dy of offsets)
            text.draw(str, 0, dy, font, {align: 0.5});
        cr.restore();
    }
});

export const TimerWidget = GObject.registerClass(
class TimerWidget extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._model = extension.timerModel;
        this._tickSourceId = 0;
        this._presetScroll = 0;

        // Presets (wide layout)
        this._presetPanel = new St.Widget({clip_to_allocation: true, reactive: true});
        this._presetPanel.connect('scroll-event', (_a, event) => this._onPresetScroll(event));
        this._presetTitle = new St.DrawingArea();
        this._presetTitle.connect('repaint', () => {
            const cr = this._presetTitle.get_context();
            this._paintPresetTitle(cr);
            cr.$dispose();
        });
        this._presetPanel.add_child(this._presetTitle);
        this._presetCards = PRESET_MINUTES.map(minutes => {
            const card = new CanvasButton((cr, button) => this._paintPresetCard(cr, button, minutes));
            card.connect('clicked', () => this._startPreset(minutes));
            this._presetPanel.add_child(card);
            return card;
        });
        this.body.add_child(this._presetPanel);

        // Pickers (idle); the seconds drum goes on top so it gets the
        // clicks where the minutes label overhangs it.
        this._minPicker = new Picker(100, _('min'));
        this._secPicker = new Picker(60, _('sec'));
        this._minPicker.setValue(settings.get_int(`${PREFIX}-minutes`));
        this._secPicker.setValue(settings.get_int(`${PREFIX}-seconds`));
        for (const [picker, key] of [[this._minPicker, 'minutes'], [this._secPicker, 'seconds']]) {
            picker.connect('value-changed', () => {
                settings.set_int(`${PREFIX}-${key}`, picker.value);
                this._syncButtons(false);
            });
            this.body.add_child(picker);
        }

        // Countdown (running, paused, finished)
        this._countdown = new Countdown();
        this.body.add_child(this._countdown);

        // Buttons
        this._cancelButton = new CanvasButton((cr, button) => this._paintCancelButton(cr, button));
        this._cancelButton.connect('clicked', () => this._model.cancel());
        this._actionButton = new CanvasButton((cr, button) => this._paintActionButton(cr, button));
        this._actionButton.connect('clicked', () => this._onAction());
        this.body.add_child(this._cancelButton);
        this.body.add_child(this._actionButton);

        this._model.connectObject('changed', () => this._syncState(true), this);
        settings.connectObject(`changed::${PREFIX}-layout`, () => this._loadGeometry(), this);

        this.start();
        this._syncState(false);
    }

    get _idle() {
        return this._model.state === TimerState.IDLE;
    }

    get _selectedMs() {
        return (this._minPicker.value * 60 + this._secPicker.value) * 1000;
    }

    _onAction() {
        switch (this._model.state) {
        case TimerState.IDLE: this._model.start(this._selectedMs); break;
        case TimerState.RUNNING: this._model.pause(); break;
        case TimerState.PAUSED: this._model.resume(); break;
        default: this._model.cancel();
        }
    }

    _startPreset(minutes) {
        if (!this._idle)
            return;
        this._minPicker.setValue(minutes);
        this._secPicker.setValue(0);
        this._settings.set_int(`${PREFIX}-minutes`, minutes);
        this._settings.set_int(`${PREFIX}-seconds`, 0);
        this._model.start(this._selectedMs);
    }

    // --- State ---

    _syncState(animate) {
        const state = this._model.state;
        const idle = state === TimerState.IDLE;

        fade(this._minPicker, idle, animate);
        fade(this._secPicker, idle, animate);
        fade(this._countdown, !idle, animate);
        fade(this._cancelButton, !idle, animate);

        this._countdown.setFlashing(state === TimerState.FINISHED);
        this._updateCountdown(animate);
        this._syncButtons(animate);
        this._presetCards.forEach(card => {
            card.reactive = idle;
            card.queue_repaint();
        });

        this._toggleItem.label.text =
            state === TimerState.RUNNING ? _('Pause')
                : state === TimerState.PAUSED ? _('Resume') : _('Start');
        this._toggleItem.setSensitive(!idle || this._selectedMs > 0);
        this._resetItem.setSensitive(!idle);

        this._scheduleTick();
    }

    _syncButtons(animate) {
        const enabled = !this._idle || this._selectedMs > 0;
        this._actionButton.reactive = enabled;
        this._actionButton.opacity = enabled ? 255 : 89;
        this._actionButton.queue_repaint();
        this._toggleItem?.setSensitive(enabled);
        this._placeActionButton(animate);
    }

    _updateCountdown(animate) {
        const seconds = Math.ceil(this._model.remaining / 1000);
        this._countdown.setTime(Math.floor(seconds / 60), seconds % 60, animate);
    }

    // While running, wake at each whole second of the remaining time.
    _scheduleTick() {
        if (this._tickSourceId)
            GLib.source_remove(this._tickSourceId);
        this._tickSourceId = 0;
        if (this._model.state !== TimerState.RUNNING)
            return;

        const delay = (this._model.remaining % 1000) || 1000;
        this._tickSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay + 5, () => {
            this._tickSourceId = 0;
            this._updateCountdown(true);
            this._scheduleTick();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- DesktopWidget hooks ---

    sizeKeys() {
        return ['size', 'layout'];
    }

    readSize() {
        const size = this._settings.get_int(`${PREFIX}-size`);
        return this._settings.get_int(`${PREFIX}-layout`) === LAYOUT_WIDE
            ? [Math.round(size * WIDE_FACTOR), size]
            : [size, size];
    }

    defaultPosition(area, width, height, margin) {
        // Bottom-right.
        return [area.x + area.width - width - margin, area.y + area.height - height - margin];
    }

    styleChanged(colors) {
        this._palette = colors;
        if (!this._countdown)
            return;
        this._countdown.setColor(colors.countdownText);
        this._minPicker.setGeometry(this._minPicker._drumWidth, colors.foreground);
        this._secPicker.setGeometry(this._secPicker._drumWidth, colors.foreground);
        for (const actor of [this._presetTitle, this._cancelButton, this._actionButton, ...this._presetCards])
            actor.queue_repaint();
    }

    layoutContent(width, height) {
        const wide = this._settings.get_int(`${PREFIX}-layout`) === LAYOUT_WIDE;
        const panelW = wide ? height : width;
        const panelX = width - panelW;
        const minSide = Math.min(panelW, height);

        // Buttons along the bottom; pickers or countdown fill the rest.
        const btn = Math.round(minSide * 0.22);
        const btnY = Math.round(height - minSide * 0.08 - btn);
        const areaH = btnY;

        const pickerH = Math.round(areaH * 0.86);
        const drumW = Math.round(minSide * 0.22);
        const labelW = Math.ceil(pickerH / 5 * 0.52 * 2.2) + 8;
        const spacing = minSide * 0.12;
        const rowX = panelX + (panelW - (2 * drumW + spacing)) / 2;
        const pickerY = Math.round((areaH - pickerH) / 2);
        const fg = this._palette?.foreground ?? null;
        [[this._minPicker, rowX], [this._secPicker, rowX + drumW + spacing]].forEach(([picker, x]) => {
            picker.set_position(Math.round(x), pickerY);
            picker.set_size(drumW + labelW, pickerH);
            picker.setGeometry(drumW, fg);
        });

        const cdW = Math.round(panelW * 0.92);
        const cdH = Math.round(areaH * 0.75);
        this._countdown.set_position(Math.round(panelX + (panelW - cdW) / 2), Math.round((areaH - cdH) / 2));
        this._countdown.set_size(cdW, cdH);

        this._panelX = panelX;
        this._panelW = panelW;
        this._buttonY = btnY;
        this._cancelButton.set_size(btn, btn);
        this._cancelButton.set_position(Math.round(panelX + panelW / 4 - btn / 2), btnY);
        this._actionButton.set_size(btn, btn);
        this._placeActionButton(false);

        this._layoutPresets(wide, width, height, panelX);
    }

    // Centred while idle, in the right quarter while a timer is set.
    _placeActionButton(animate) {
        if (this._panelW === undefined)
            return;
        const btn = this._actionButton.width;
        const x = Math.round(this._idle
            ? this._panelX + (this._panelW - btn) / 2
            : this._panelX + this._panelW * 3 / 4 - btn / 2);

        this._actionButton.remove_transition('x');
        this._actionButton.y = this._buttonY;
        if (animate)
            this._actionButton.ease({x, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        else
            this._actionButton.x = x;
    }

    _layoutPresets(wide, width, height, panelX) {
        this._presetPanel.visible = wide;
        if (!wide)
            return;

        const panelW = panelX - Math.round(height * 0.04);
        this._presetPanel.set_position(0, 0);
        this._presetPanel.set_size(panelW, height);

        const m = Math.round(height * 0.09);
        const titleSize = Math.max(10, Math.round(height * 0.058));
        const cardSize = Math.max(10, Math.round(height * 0.052));
        const cardH = Math.round(cardSize * 2.8);
        const cardSpacing = Math.round(height * 0.025);
        const titleH = Math.round(titleSize * 1.4);

        this._presetMetrics = {m, titleSize, cardSize};
        this._presetTitle.set_position(m, m);
        this._presetTitle.set_size(Math.max(1, panelW - 2 * m), titleH);

        this._listTop = m + titleH + cardSpacing;
        this._listBottom = height - m;
        this._cardStep = cardH + cardSpacing;
        const contentH = PRESET_MINUTES.length * this._cardStep - cardSpacing;
        this._maxPresetScroll = Math.max(0, contentH - (this._listBottom - this._listTop));
        this._presetScroll = clamp(this._presetScroll, 0, this._maxPresetScroll);

        this._presetCards.forEach(card => card.set_size(Math.max(1, panelW - 2 * m), cardH));
        this._positionPresetCards();
    }

    _positionPresetCards() {
        const {m} = this._presetMetrics;
        this._presetCards.forEach((card, i) => {
            const y = this._listTop + i * this._cardStep - this._presetScroll;
            card.set_position(m, Math.round(y));
            // Only cards inside the list area take clicks.
            card.visible = y + card.height > this._listTop - 1 && y < this._listBottom + 1;
            card.queue_repaint();
        });
    }

    _onPresetScroll(event) {
        if (event.is_pointer_emulated())
            return Clutter.EVENT_PROPAGATE;

        let delta;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: delta = -1; break;
        case Clutter.ScrollDirection.DOWN: delta = 1; break;
        case Clutter.ScrollDirection.SMOOTH: delta = event.get_scroll_delta()[1]; break;
        default: return Clutter.EVENT_PROPAGATE;
        }
        this._presetScroll = clamp(this._presetScroll + delta * this._cardStep * 0.8,
            0, this._maxPresetScroll);
        this._positionPresetCards();
        return Clutter.EVENT_STOP;
    }

    addMenuItems(menu) {
        this._toggleItem = menu.addAction(_('Start'), () => this._onAction());
        this._resetItem = menu.addAction(_('Reset'), () => this._model.cancel());
    }

    _onDestroy() {
        if (this._tickSourceId)
            GLib.source_remove(this._tickSourceId);
        this._tickSourceId = 0;
        super._onDestroy();
    }

    // --- Painting ---

    _paintPresetTitle(cr) {
        if (!this._palette || !this._presetMetrics)
            return;
        const [, h] = this._presetTitle.get_surface_size();
        setSource(cr, this._palette.foreground, 0.55);
        new TextPainter(cr).draw(_('Presets'), 0, h / 2,
            {family: FONT_FAMILY, size: this._presetMetrics.titleSize}, {valign: 0.5, letterSpacing: 0.5});
    }

    _paintPresetCard(cr, card, minutes) {
        const colors = this._palette;
        if (!colors || !this._presetMetrics)
            return;

        // Cards fade out while a timer is set; clip to the list area so a
        // scrolled card never draws over the title or into the margin.
        const [w, h] = card.get_surface_size();
        const clipTop = Math.max(0, this._listTop - card.y);
        const clipBottom = Math.min(h, this._listBottom - card.y);
        cr.rectangle(0, clipTop, w, Math.max(0, clipBottom - clipTop));
        cr.clip();
        cr.pushGroup();

        const opacity = card.pressed ? colors.cardPressOpacity
            : card.hover ? colors.cardHoverOpacity : colors.cardBackgroundOpacity;
        setSource(cr, colors.cardBackground, opacity);
        roundedRect(cr, 0, 0, w, h, Math.round(h * 0.25));
        cr.fill();

        const label = ngettext('%d min', '%d min', minutes).replace('%d', minutes);
        setSource(cr, colors.foreground);
        new TextPainter(cr).draw(label, Math.round(h * 0.22) + 9, h / 2,
            {family: FONT_FAMILY, size: this._presetMetrics.cardSize}, {valign: 0.5, maxWidth: w * 0.8});

        cr.popGroupToSource();
        cr.paintWithAlpha(this._idle ? 1 : 0.35);
    }

    _paintCircle(cr, button, color) {
        const [w, h] = button.get_surface_size();
        setSource(cr, color, button.pressed ? 0.5 : 1);
        cr.arc(w / 2, h / 2, Math.min(w, h) / 2, 0, 2 * Math.PI);
        cr.fill();
    }

    // Moves the origin so an icon drawn in a `units`-wide box lands in the
    // middle 42% of the button, as in TimerButton.qml.
    _iconSpace(cr, button, units) {
        const [w, h] = button.get_surface_size();
        const size = Math.min(w, h) * 0.42;
        cr.translate((w - size) / 2, (h - size) / 2);
        cr.scale(size / units, size / units);
    }

    _paintCancelButton(cr, button) {
        const colors = this._palette;
        if (!colors)
            return;
        this._paintCircle(cr, button, colors.cancelButtonBg);

        // cancel.svg: an X in a 24-unit box
        this._iconSpace(cr, button, 24);
        setSource(cr, colors.buttonIcon);
        cr.setLineWidth(2);
        cr.moveTo(5.7, 5.7);
        cr.lineTo(18.3, 18.3);
        cr.moveTo(18.3, 5.7);
        cr.lineTo(5.7, 18.3);
        cr.stroke();
    }

    _paintActionButton(cr, button) {
        const colors = this._palette;
        if (!colors)
            return;

        const state = this._model.state;
        const running = state === TimerState.RUNNING;
        this._paintCircle(cr, button, running ? colors.actionOrangeBg : colors.actionGreenBg);

        const iconColor = colors.isGlass
            ? {r: 1, g: 1, b: 1, a: 1}
            : running ? colors.actionOrange : colors.actionGreen;

        // Icons from play.svg / pause.svg / reload.svg (960-unit box).
        this._iconSpace(cr, button, 960);
        setSource(cr, iconColor);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);

        if (running) {
            roundedRect(cr, 240, 200, 160, 560, 80);
            roundedRect(cr, 560, 200, 160, 560, 80);
            cr.fill();
        } else if (state === TimerState.FINISHED) {
            cr.setLineWidth(80);
            cr.arc(480, 480, 280, 28 * Math.PI / 180, 319 * Math.PI / 180);
            cr.stroke();
            cr.moveTo(760, 240);
            cr.lineTo(760, 400);
            cr.lineTo(600, 400);
            cr.stroke();
        } else {
            cr.setLineWidth(60);
            cr.moveTo(350, 300);
            cr.lineTo(350, 660);
            cr.lineTo(690, 480);
            cr.closePath();
            cr.fillPreserve();
            cr.stroke();
        }
    }
});
