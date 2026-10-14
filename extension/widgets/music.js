// Port of packages/music (macOS Music): now-playing card for whatever MPRIS
// player is active, in four layouts picked in the settings:
//   0 Square  album art fills the card, title and controls over it
//   1 Wide    art on the left, title, controls and a seek bar
//   2 Bar     a thin strip: art, title, a progress line and controls
//   3 Tall    big art on top, details, seek bar and controls below
// Wide and Tall can switch to synced lyrics (LRCLIB). The glass picks up
// the album's color: a tint in Glass style, a gradient in Solid style.
//
// Most of the card is one St.DrawingArea; the controls, seek bar, lyrics
// button and lyrics view are their own reactive actors, so pressing them
// never starts a widget drag.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlbumArtLoader} from '../lib/albumArt.js';
import {CanvasButton} from '../lib/canvasButton.js';
import {rgba, withAlpha} from '../lib/colors.js';
import {DesktopWidget} from '../lib/desktopWidget.js';
import {drawImage, setSource, TextPainter} from '../lib/draw.js';
import {LyricsClient, LyricsState} from '../lib/lyrics.js';
import {MprisWatcher} from '../lib/mpris.js';

const PREFIX = 'music';
const FONT_FAMILY = 'SF Pro Display';

const LAYOUT_WIDE = 1;
const LAYOUT_BAR = 2;
const LAYOUT_TALL = 3;

const WHITE = rgba('#ffffff');
const FLIP_MS = 400;
const FADE_MS = 280;
const IDLE_HIDE_SECONDS = 30;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const easeInOutQuad = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function formatTime(us) {
    const total = Math.floor(Math.max(0, us) / 1e6);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
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

// Squircle outline matching the glass shader (SquareLayout.qml's mask).
function squirclePath(cr, w, h, radius, roundness) {
    const r = Math.min(radius, w / 2, h / 2);
    const n = Math.max(roundness, 2);
    const steps = 32;
    const cx = t => r * Math.abs(Math.cos(t)) ** (2 / n);
    const cy = t => r * Math.abs(Math.sin(t)) ** (2 / n);
    cr.moveTo(r, 0);
    cr.lineTo(w - r, 0);
    for (let i = 1; i <= steps; i++) {
        const t = (1 - i / steps) * Math.PI / 2;
        cr.lineTo(w - r + cx(t), r - cy(t));
    }
    cr.lineTo(w, h - r);
    for (let i = 1; i <= steps; i++) {
        const t = (1 - i / steps) * Math.PI / 2;
        cr.lineTo(w - r + cy(t), h - r + cx(t));
    }
    cr.lineTo(r, h);
    for (let i = 1; i <= steps; i++) {
        const t = (1 - i / steps) * Math.PI / 2;
        cr.lineTo(r - cx(t), h - r + cy(t));
    }
    cr.lineTo(0, r);
    for (let i = 1; i <= steps; i++) {
        const t = (1 - i / steps) * Math.PI / 2;
        cr.lineTo(r - cy(t), r - cx(t));
    }
    cr.closePath();
}

// Paints `surface` to cover the box (cropping, like PreserveAspectCrop).
function paintCover(cr, surface, x, y, w, h) {
    const sw = surface.getWidth();
    const sh = surface.getHeight();
    const scale = Math.max(w / sw, h / sh);
    cr.save();
    cr.rectangle(x, y, w, h);
    cr.clip();
    cr.translate(x + (w - sw * scale) / 2, y + (h - sh * scale) / 2);
    cr.scale(scale, scale);
    cr.setSourceSurface(surface, 0, 0);
    cr.getSource().setFilter(Cairo.Filter.GOOD);
    cr.paint();
    cr.restore();
}

// Port of MarqueeText.qml's timing: a title too long for its box waits 5 s,
// scrolls to its end at 45 ms/px, waits 3 s, scrolls back, waits 3 s, and
// does that twice. offset() answers for a given overflow; `scrolling` and
// `nextChange` tell the caller whether frames are needed and when the next
// pause ends.
class Marquee {
    constructor() {
        this.restart();
    }

    restart() {
        this._start = GLib.get_monotonic_time() / 1000;
        this.scrolling = false;
        this.nextChange = Infinity;
    }

    beginFrame() {
        this.scrolling = false;
        this.nextChange = Infinity;
    }

    offset(overflow) {
        const scrollMs = overflow * 45;
        const phases = [[5000, 0, 0], [scrollMs, 0, 1], [3000, 1, 1], [scrollMs, 1, 0], [3000, 0, 0]];
        const cycle = phases.reduce((sum, [d]) => sum + d, 0);
        const t = GLib.get_monotonic_time() / 1000 - this._start;
        if (t >= cycle * 2)
            return 0;

        let tc = t % cycle;
        for (const [duration, from, to] of phases) {
            if (tc < duration) {
                if (from !== to)
                    this.scrolling = true;
                else
                    this.nextChange = Math.min(this.nextChange, duration - tc);
                return overflow * (from + (to - from) * (tc / duration));
            }
            tc -= duration;
        }
        return 0;
    }
}

// Port of MusicSlider.qml: a thin track that thickens on hover, with
// elapsed and total time under it. Click or drag to seek.
const SeekBar = GObject.registerClass({
    Properties: {
        'thickness': GObject.ParamSpec.double('thickness', null, null,
            GObject.ParamFlags.READWRITE, 0, 100, 3),
    },
}, class SeekBar extends St.DrawingArea {
    _init(widget) {
        super._init({reactive: true, track_hover: true});
        this._widget = widget;
        this._thickness = 3;
        this._dragging = false;
        this._dragPos = 0;
        this.fontSize = 10;
        this.connect('repaint', () => {
            const cr = this.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.connect('notify::hover', () => this._syncThickness());
        this.connect('destroy', () => this._endDrag());
    }

    get thickness() {
        return this._thickness;
    }

    set thickness(v) {
        this._thickness = v;
        this.notify('thickness');
        this.queue_repaint();
    }

    get preferredHeight() {
        return 14 + 2 + Math.ceil(this.fontSize * 1.25);
    }

    _syncThickness() {
        this.ease_property('thickness', this.hover || this._dragging ? 8 : 3, {
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _ratioAt(event) {
        const [ok, x] = this.transform_stage_point(...event.get_coords());
        return ok ? clamp(x / Math.max(1, this.width), 0, 1) : 0;
    }

    vfunc_button_press_event(event) {
        const player = this._widget.player;
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !player?.canSeek || !(player.metadata.length > 0))
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this);
        this._dragging = true;
        this._dragPos = this._ratioAt(event) * player.metadata.length;
        this._syncThickness();
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        this._dragPos = this._ratioAt(event) * (this._widget.player?.metadata.length ?? 0);
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._dragging || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag();
        this._widget.player?.seekTo(this._dragPos);
        this._syncThickness();
        this._widget.onPositionJump();
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this._dragging = false;
    }

    _paint(cr) {
        const style = this._widget.paintStyle;
        if (!style)
            return;
        const [w] = this.get_surface_size();
        const player = this._widget.player;
        const length = player?.metadata.length ?? 0;
        const position = this._dragging ? this._dragPos : (player?.position ?? 0);
        const t = this._thickness;
        const barY = 7 - t / 2;

        setSource(cr, style.fg, 0.20);
        roundedRect(cr, 0, barY, w, t, t / 2);
        cr.fill();
        if (length > 0) {
            setSource(cr, style.accent);
            roundedRect(cr, 0, barY, Math.max(t, w * clamp(position / length, 0, 1)), t, t / 2);
            cr.fill();
        }

        const text = new TextPainter(cr);
        const font = {family: FONT_FAMILY, size: this.fontSize};
        setSource(cr, style.fg, 0.50);
        text.draw(formatTime(position), 0, 16, font);
        text.draw(formatTime(length), w, 16, font, {align: 1});
    }
});

// Port of SyncedLyricsView.qml: the current line sits at the top, slightly
// larger; lines after it fade (and blur) with distance, lines before it are
// dim. Scrolling moves through the song, and the view snaps back to the
// current line 2 s later. Clicking a line seeks to it.
const LyricsView = GObject.registerClass({
    Properties: {
        'scroll': GObject.ParamSpec.double('scroll', null, null,
            GObject.ParamFlags.READWRITE, -1e6, 1e6, 0),
    },
}, class LyricsView extends St.DrawingArea {
    _init(widget) {
        super._init({reactive: true, track_hover: true});
        this._widget = widget;
        this._scroll = 0;
        this._index = -1;
        this._hovered = -1;
        this._userScrolling = false;
        this._snapId = 0;
        this._metrics = null;
        this.title = '';
        this.fontSize = 20;
        this.titleSize = 14;
        this.blur = true;

        this.connect('repaint', () => {
            const cr = this.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.connect('notify::hover', () => {
            if (!this.hover)
                this._setHovered(-1);
        });
        this.connect('notify::size', () => this.invalidate());
        this.connect('destroy', () => this._clearSnap());
    }

    get scroll() {
        return this._scroll;
    }

    set scroll(v) {
        this._scroll = v;
        this.notify('scroll');
        this.queue_repaint();
    }

    // Lyrics, size or fonts changed: re-measure on the next paint.
    invalidate() {
        this._metrics = null;
        this._index = -1;
        this.queue_repaint();
    }

    get _lyrics() {
        return this._widget.lyrics;
    }

    get _titleHeight() {
        return this.title ? Math.round(this.titleSize * 1.3) + Math.round(this.fontSize * 0.4) : 0;
    }

    // Line boxes for the current lyrics at the current width.
    _measure() {
        if (this._metrics)
            return this._metrics;

        const base = this.fontSize;
        const hPad = Math.round(base * 0.6);
        const vPad = Math.round(base * 0.45);
        const spacing = Math.round(base * 0.15);
        const top = Math.round(base * 0.3);
        const width = Math.max(10, this.width - 2 * hPad);
        const layout = Pango.Layout.new(this.get_pango_context());
        layout.set_font_description(this._font(base, true));
        layout.set_width(width * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);

        const lines = this._lyrics.synced.map(line => {
            layout.set_text(line.text || '♪  ♪  ♪', -1);
            const [, logical] = layout.get_pixel_extents();
            return {text: line.text, time: line.time, height: logical.height + 2 * vPad};
        });
        let y = top;
        for (const line of lines) {
            line.y = y;
            y += line.height + spacing;
        }
        this._metrics = {lines, hPad, vPad, width, contentHeight: y};
        return this._metrics;
    }

    _font(size, bold = false, italic = false) {
        const font = new Pango.FontDescription();
        font.set_family(FONT_FAMILY);
        font.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.MEDIUM);
        font.set_style(italic ? Pango.Style.ITALIC : Pango.Style.NORMAL);
        font.set_absolute_size(size * Pango.SCALE);
        return font;
    }

    // Called ~10 times a second while visible: follows the song.
    setPosition(ms) {
        const synced = this._lyrics.synced;
        let index = -1;
        for (let i = 0; i < synced.length && synced[i].time <= ms + 200; i++)
            index = i;
        if (index === this._index)
            return;

        const first = this._index === -1;
        this._index = index;
        if (!this._userScrolling)
            this._scrollToCurrent(!first);
        this.queue_repaint();
    }

    _scrollToCurrent(animate) {
        const m = this._measure();
        const target = this._index >= 0 ? m.lines[this._index].y - Math.round(this.fontSize * 0.3) : 0;
        this.remove_transition('scroll');
        if (animate) {
            this.ease_property('scroll', target, {
                duration: 600,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            this.scroll = target;
        }
    }

    _clearSnap() {
        if (this._snapId)
            GLib.source_remove(this._snapId);
        this._snapId = 0;
    }

    vfunc_scroll_event(event) {
        if (event.is_pointer_emulated())
            return Clutter.EVENT_PROPAGATE;
        let delta;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP: delta = -1; break;
        case Clutter.ScrollDirection.DOWN: delta = 1; break;
        case Clutter.ScrollDirection.SMOOTH: delta = event.get_scroll_delta()[1]; break;
        default: return Clutter.EVENT_PROPAGATE;
        }

        const plain = this._showsPlain;
        const contentHeight = plain ? this._plainHeight ?? 0 : this._measure().contentHeight;
        const max = Math.max(0, contentHeight - (plain ? this.height - this._titleHeight : 0));
        this.remove_transition('scroll');
        this.scroll = clamp(this._scroll + delta * this.fontSize * 2.5, 0, max);

        if (!plain) {
            this._userScrolling = true;
            this._clearSnap();
            this._snapId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                this._snapId = 0;
                this._userScrolling = false;
                this._scrollToCurrent(true);
                return GLib.SOURCE_REMOVE;
            });
        }
        return Clutter.EVENT_STOP;
    }

    _lineAt(event) {
        if (this._showsPlain || this._lyrics.state !== LyricsState.LOADED)
            return -1;
        const [ok, , y] = this.transform_stage_point(...event.get_coords());
        if (!ok)
            return -1;
        const contentY = y - this._titleHeight + this._scroll;
        return this._measure().lines.findIndex(l => contentY >= l.y && contentY < l.y + l.height);
    }

    _setHovered(index) {
        if (index !== this._hovered) {
            this._hovered = index;
            this.queue_repaint();
        }
    }

    vfunc_motion_event(event) {
        this._setHovered(this._lineAt(event));
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (this._lyrics.state === LyricsState.ERROR) {
            this._widget.lyricsClient.retry();
            return Clutter.EVENT_STOP;
        }
        const index = this._lineAt(event);
        if (index < 0)
            return Clutter.EVENT_PROPAGATE;
        this._widget.player?.seekTo(this._lyrics.synced[index].time * 1000);
        this._widget.onPositionJump();
        return Clutter.EVENT_STOP;
    }

    get _showsPlain() {
        const l = this._lyrics;
        return l.state === LyricsState.LOADED && l.synced.length === 0 && l.plain !== '';
    }

    _paint(cr) {
        const style = this._widget.paintStyle;
        if (!style)
            return;
        const [w, h] = this.get_surface_size();
        const text = new TextPainter(cr);
        const fg = style.lyricsFg;

        // Title
        if (this.title) {
            setSource(cr, fg);
            text.draw(this.title, w / 2, 0, {family: FONT_FAMILY, size: this.titleSize, weight: Pango.Weight.SEMIBOLD},
                {align: 0.5, maxWidth: w});
        }
        const top = this._titleHeight;
        cr.rectangle(0, top, w, h - top);
        cr.clip();

        const l = this._lyrics;
        const message = {
            [LyricsState.IDLE]: _('Loading lyrics…'),
            [LyricsState.LOADING]: _('Loading lyrics…'),
            [LyricsState.ERROR]: _('Couldn’t load lyrics. Click to retry.'),
            [LyricsState.NOT_FOUND]: _('No lyrics available'),
        }[l.state] ?? (l.synced.length === 0 && !l.plain ? _('No lyrics available') : null);
        if (message) {
            setSource(cr, fg, 0.45);
            text.draw(message, w / 2, top + (h - top) / 2, {family: FONT_FAMILY, size: Math.max(12, this.fontSize * 0.8)},
                {align: 0.5, valign: 0.5, maxWidth: w});
            return;
        }

        if (this._showsPlain) {
            this._paintPlain(cr, fg, w, top);
            return;
        }

        const m = this._measure();
        const visibleCount = Math.max(3, Math.floor(h / (this.fontSize * 2.5)));
        const layout = PangoCairo.create_layout(cr);
        layout.set_width(m.width * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);

        m.lines.forEach((line, i) => {
            const y = top + line.y - this._scroll;
            if (y + line.height < top || y > h)
                return;

            const dist = i - this._index;
            const active = dist === 0;
            let opacity;
            if (this._userScrolling)
                opacity = active ? 1 : 0.40 * 0.6;
            else if (active)
                opacity = 1;
            else if (dist < 0)
                opacity = 0.40 * 0.25;
            else
                opacity = 0.40 * (1 - Math.min(1, dist / visibleCount) * 0.85);

            if (i === this._hovered) {
                setSource(cr, WHITE, 0.10);
                roundedRect(cr, 0, y, w, line.height, Math.round(line.height * 0.22));
                cr.fill();
            }

            layout.set_font_description(this._font(this.fontSize, true, !line.text));
            layout.set_text(line.text || '♪  ♪  ♪', -1);

            const blurFrac = this.blur && dist >= 2 && !this._userScrolling
                ? Math.min(1, (dist - 1) / (visibleCount + 2)) : 0;
            const spread = blurFrac * this.fontSize * 0.18;
            const offsets = spread > 0.4
                ? [[0, 0], [-spread, 0], [spread, 0], [0, -spread], [0, spread]]
                : [[0, 0]];

            // Stacked copies add up, so give each the alpha whose n-fold
            // overlap matches the line's opacity.
            const copyOpacity = 1 - (1 - opacity) ** (1 / offsets.length);

            cr.save();
            cr.translate(m.hPad, y + m.vPad);
            if (active)
                cr.scale(1.05, 1.05);
            setSource(cr, fg, copyOpacity);
            for (const [dx, dy] of offsets) {
                cr.moveTo(dx, dy);
                PangoCairo.show_layout(cr, layout);
            }
            cr.restore();
        });
    }

    _paintPlain(cr, fg, w, top) {
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(this._font(Math.round(this.fontSize * 0.75)));
        layout.set_width((w - 32) * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        layout.set_spacing(Math.round(this.fontSize * 0.75 * 0.6) * Pango.SCALE);
        layout.set_text(this._lyrics.plain, -1);
        this._plainHeight = layout.get_pixel_extents()[1].height + 32;
        setSource(cr, fg, 0.85);
        cr.moveTo(16, top + 16 - this._scroll);
        PangoCairo.show_layout(cr, layout);
    }
});

export const MusicWidget = GObject.registerClass(
class MusicWidget extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._iconDir = `${extension.dir.get_path()}/icons/music`;
        this._art = null;           // {surface, palette} shown now
        this._flipFrom = null;      // art being flipped away
        this._flipStart = 0;
        this._artUrl = null;
        this._trackKey = null;
        this._lyricsActive = false;
        this._idleHideId = 0;
        this._positionId = 0;
        this._lyricsTickId = 0;
        this._marquee = new Marquee();
        this._marqueeWakeId = 0;
        this.paintStyle = null; // colors for painting (not `style`: St.Widget owns that)

        this._artLoader = new AlbumArtLoader();

        this._canvas = new St.DrawingArea();
        this._canvas.connect('repaint', () => {
            const cr = this._canvas.get_context();
            this._paint(cr);
            cr.$dispose();
        });
        this.body.add_child(this._canvas);

        this._seekBar = new SeekBar(this);
        this.body.add_child(this._seekBar);

        this._lyricsView = new LyricsView(this);
        this._lyricsView.opacity = 0;
        this._lyricsView.hide();
        this.body.add_child(this._lyricsView);

        this._buttons = ['previous', 'playpause', 'next'].map(name => {
            const button = new CanvasButton((cr, b) => this._paintControl(cr, b, name), {bounce: true});
            button.connect('clicked', () => this._onControl(name));
            this.body.add_child(button);
            return button;
        });
        this._lyricsButton = new CanvasButton((cr, b) => this._paintLyricsButton(cr, b));
        this._lyricsButton.connect('clicked', () => this._setLyricsActive(!this._lyricsActive));
        this.body.add_child(this._lyricsButton);

        // Frames only while art flips or a title scrolls.
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._canvas.queue_repaint());

        this.lyricsClient = new LyricsClient(() => {
            this._lyricsView.invalidate();
            this._lyricsView.setPosition((this.player?.position ?? 0) / 1000);
            this._lyricsButton.queue_repaint();
        });

        this._mpris = new MprisWatcher();
        this._mpris.connectObject(
            'changed', () => this._sync(),
            'seeked', () => this.onPositionJump(),
            this);

        settings.connectObject(
            `changed::${PREFIX}-layout`, () => this._loadGeometry(),
            `changed::${PREFIX}-lyrics-blur`, () => this._applyLyricsSettings(),
            `changed::${PREFIX}-lyrics-title`, () => this._applyLyricsSettings(),
            `changed::${PREFIX}-hide-when-idle`, () => this._syncIdleHide(),
            this);

        this.start();
        this._sync();
    }

    get player() {
        return this._mpris.player;
    }

    get lyrics() {
        return this.lyricsClient;
    }

    get _layout() {
        return this._settings.get_int(`${PREFIX}-layout`);
    }

    get _hasLyrics() {
        return this._layout === LAYOUT_WIDE || this._layout === LAYOUT_TALL;
    }

    // --- Player state ---

    _sync() {
        const player = this.player;
        const meta = player?.metadata;
        const key = meta ? `${player.busName}|${meta.trackId}|${meta.title}|${meta.artist}` : null;

        if (key !== this._trackKey) {
            this._trackKey = key;
            this._marquee.restart();
            this.lyricsClient.setTrack(meta ? {...meta} : null);
            if (this._lyricsActive)
                this.lyricsClient.fetch();
            this._applyLyricsSettings();
        }
        this._loadArt(meta?.artUrl ?? '');

        // Like the KDE widget, unavailable controls are dimmed but clickable.
        const playing = player?.playing ?? false;
        this._buttons.forEach(b => b.queue_repaint());

        this._playPauseItem.label.text = playing ? _('Pause') : _('Play');
        this._playPauseItem.setSensitive(Boolean(player?.canPlayPause));
        this._nextItem.setSensitive(Boolean(player?.canGoNext));
        this._previousItem.setSensitive(Boolean(player?.canGoPrevious));

        this._syncPositionTimers();
        this._syncIdleHide();
        this._canvas.queue_repaint();
        this._seekBar.queue_repaint();
    }

    // The player jumped (seek, track change): redraw progress now.
    onPositionJump() {
        this._seekBar.queue_repaint();
        if (this._layout === LAYOUT_BAR)
            this._canvas.queue_repaint();
        if (this._lyricsActive)
            this._lyricsView.setPosition((this.player?.position ?? 0) / 1000);
    }

    _syncPositionTimers() {
        const playing = this.player?.playing ?? false;

        if (playing && !this._positionId) {
            this._positionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                this.onPositionJump();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!playing && this._positionId) {
            GLib.source_remove(this._positionId);
            this._positionId = 0;
        }

        const lyricsTick = playing && this._lyricsActive;
        if (lyricsTick && !this._lyricsTickId) {
            this._lyricsTickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._lyricsView.setPosition((this.player?.position ?? 0) / 1000);
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!lyricsTick && this._lyricsTickId) {
            GLib.source_remove(this._lyricsTickId);
            this._lyricsTickId = 0;
        }
    }

    // "Hide when nothing is playing": fade out 30 s after playback stops.
    _syncIdleHide() {
        if (this._idleHideId)
            GLib.source_remove(this._idleHideId);
        this._idleHideId = 0;

        const enabled = this._settings.get_boolean(`${PREFIX}-hide-when-idle`);
        if (!enabled || this.player?.playing) {
            if (!this.visible || this.opacity < 255) {
                this.show();
                this.ease({opacity: 255, duration: 200});
            }
            return;
        }
        this._idleHideId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, IDLE_HIDE_SECONDS, () => {
            this._idleHideId = 0;
            this.ease({opacity: 0, duration: 400, onComplete: () => this.hide()});
            return GLib.SOURCE_REMOVE;
        });
    }

    _onControl(name) {
        const player = this.player;
        if (!player)
            return;
        if (name === 'previous')
            player.previous();
        else if (name === 'next')
            player.next();
        else
            player.playPause();
    }

    // --- Album art ---

    async _loadArt(url) {
        if (url === this._artUrl)
            return;
        this._artUrl = url;

        const art = url ? await this._artLoader.load(url) : null;
        if (url !== this._artUrl)
            return; // a newer track won

        if (this._art && art && art !== this._art) {
            this._flipFrom = this._art;
            this._flipStart = GLib.get_monotonic_time() / 1000;
            this._timeline.start();
        }
        this._art = art;
        this._loadStyle(); // tint/gradient follow the album
    }

    _noAlbumArt() {
        // The placeholder goes through drawImage's cache; keep its path.
        return `${this._iconDir}/no_album.png`;
    }

    // --- Lyrics ---

    _setLyricsActive(active) {
        if (!this._hasLyrics)
            active = false;
        if (active === this._lyricsActive)
            return;
        this._lyricsActive = active;

        if (active) {
            this.lyricsClient.fetch();
            this._lyricsView.setPosition((this.player?.position ?? 0) / 1000);
        }
        this._applyLyricsSettings();
        this._syncLyricsVisibility(true);
        this._syncPositionTimers();
        this._lyricsButton.queue_repaint();
        if (this._layout === LAYOUT_TALL)
            this._loadStyle(); // the glass darkens behind tall lyrics
    }

    _applyLyricsSettings() {
        this._lyricsView.blur = this._settings.get_boolean(`${PREFIX}-lyrics-blur`);
        this._lyricsView.title = this._settings.get_boolean(`${PREFIX}-lyrics-title`)
            ? (this.player?.metadata.title ?? '') : '';
        this._lyricsView.invalidate();
    }

    _fadeActor(actor, show, animate) {
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
            mode: Clutter.AnimationMode.EASE_OUT_QUART,
            onComplete: () => {
                if (!show)
                    actor.hide();
            },
        });
    }

    // Wide: the whole card swaps for the lyrics. Tall: art and details swap
    // for the lyrics, the controls and button slide down and stay.
    _syncLyricsVisibility(animate) {
        const lyrics = this._lyricsActive;
        const layout = this._layout;
        this._fadeActor(this._lyricsView, lyrics, animate);
        this._fadeActor(this._canvas, !lyrics, animate);
        this._fadeActor(this._seekBar, !lyrics && (layout === LAYOUT_WIDE || layout === LAYOUT_TALL), animate);
        this._buttons.forEach(b => this._fadeActor(b, !(lyrics && layout === LAYOUT_WIDE), animate));
        if (this._geometry)
            this._placeMovingParts(animate);
    }

    // --- DesktopWidget hooks ---

    sizeKeys() {
        return ['size', 'layout'];
    }

    readSize() {
        const s = this._settings.get_int(`${PREFIX}-size`);
        switch (this._settings.get_int(`${PREFIX}-layout`)) {
        case LAYOUT_WIDE: return [s * 2.15, s];
        case LAYOUT_BAR: return [s * 2.15, s * 0.4];
        case LAYOUT_TALL: return [s * 1.4, s * 1.4 * 1.72];
        default: return [s, s];
        }
    }

    defaultPosition(area, width, _height, margin) {
        // Top centre.
        return [Math.round(area.x + (area.width - width) / 2), area.y + margin];
    }

    glassTint(colors, tintAlpha) {
        const palette = this._art?.palette;
        if (this._lyricsActive && this._layout === LAYOUT_TALL)
            return {tint: palette?.bottom ?? rgba('#000000'), tintAlpha: Math.max(tintAlpha, 0.55)};
        if (palette)
            return {tint: palette.tint, tintAlpha: Math.max(tintAlpha, 0.15)};
        return super.glassTint(colors, tintAlpha);
    }

    solidBackground(colors) {
        const palette = this._art?.palette;
        if (!palette)
            return super.solidBackground(colors);
        let {top, bottom} = palette;
        if (this._lyricsActive && this._layout === LAYOUT_TALL) {
            const darken = c => ({r: c.r * 0.45 + bottom.r * 0.55, g: c.g * 0.45 + bottom.g * 0.55, b: c.b * 0.45 + bottom.b * 0.55, a: 1});
            top = darken(top);
            bottom = darken(bottom);
        }
        return {solid: colors.isSolid, solidColor: top, solidColorBottom: bottom};
    }

    styleChanged(colors) {
        const palette = this._art?.palette;
        // On the album gradient (Solid) text is always white.
        const fg = colors.isSolid && palette ? WHITE : colors.foreground;
        this.paintStyle = {
            colors,
            fg,
            accent: palette ? palette.primary : fg,
            lyricsAccent: palette ? palette.tint : withAlpha(WHITE, 0.35),
            lyricsFg: fg,
        };
        if (!this._canvas)
            return;
        for (const actor of [this._canvas, this._seekBar, this._lyricsView, this._lyricsButton, ...this._buttons])
            actor.queue_repaint();
    }

    layoutContent(width, height) {
        const g = this._computeGeometry(width, height);
        this._geometry = g;

        this._canvas.set_position(0, 0);
        this._canvas.set_size(width, height);

        const showSeek = g.seek !== null;
        if (showSeek) {
            this._seekBar.fontSize = g.seek.fontSize;
            this._seekBar.set_position(Math.round(g.seek.x), Math.round(g.seek.y));
            this._seekBar.set_size(Math.round(g.seek.w), this._seekBar.preferredHeight);
        }

        this._buttons.forEach(b => b.set_size(Math.round(g.controls.button), Math.round(g.controls.button)));
        this._lyricsButton.visible = g.lyricsButton !== null;
        if (g.lyricsButton)
            this._lyricsButton.set_size(Math.round(g.lyricsButton.w), Math.round(g.lyricsButton.h));

        if (g.lyrics) {
            this._lyricsView.set_position(Math.round(g.lyrics.x), Math.round(g.lyrics.y));
            this._lyricsView.set_size(Math.round(g.lyrics.w), Math.max(1, Math.round(g.lyrics.h)));
            this._lyricsView.fontSize = g.lyrics.fontSize;
            this._lyricsView.titleSize = g.lyrics.titleSize;
        }

        if (!this._hasLyrics)
            this._lyricsActive = false;
        this._applyLyricsSettings();
        this._syncLyricsVisibility(false);
        this._loadStyle();
    }

    // Controls and the lyrics button move in Tall when lyrics toggle.
    _placeMovingParts(animate) {
        const g = this._geometry;
        const lyrics = this._lyricsActive;
        const c = g.controls;
        const y = Math.round(lyrics && c.lyricsY !== undefined ? c.lyricsY : c.y);
        const move = (actor, x, ty) => {
            actor.remove_transition('x');
            actor.remove_transition('y');
            if (animate && actor.visible) {
                actor.ease({x, y: ty, duration: 180, mode: Clutter.AnimationMode.EASE_IN_OUT_QUART});
            } else {
                actor.set_position(x, ty);
            }
        };
        this._buttons.forEach((b, i) => move(b, Math.round(c.x + i * (c.button + c.spacing)), y));
        if (g.lyricsButton) {
            const lb = g.lyricsButton;
            move(this._lyricsButton, Math.round(lb.x), Math.round(lyrics && lb.lyricsY !== undefined ? lb.lyricsY : lb.y));
        }
    }

    // Geometry for each layout, straight from the KDE layout QML files.
    _computeGeometry(w, h) {
        const textBox = (x, y, bw, bh, size, weight, opts = {}) => ({x, y, w: bw, h: bh, size, weight, ...opts});
        const controlsRow = (icon, spacing, centerX, y) => {
            const button = icon * 1.6;
            const rowW = 3 * button + 2 * spacing;
            return {icon, button, spacing, x: centerX - rowW / 2, y, rowW};
        };
        const lyricsButtonBox = (s, height, iconFrac, spacingFrac, fontSize, right, y) => {
            const icon = Math.round(s * iconFrac);
            const gap = Math.round(s * spacingFrac);
            const measure = this._measureText(_('Lyrics'), fontSize, Pango.Weight.MEDIUM);
            const bw = icon + gap + measure + Math.round(s * 0.08);
            return {x: right - bw, y, w: bw, h: height, icon, gap, fontSize};
        };

        switch (this._layout) {
        case LAYOUT_WIDE: {
            const m = Math.round(h * 0.08);
            const seekFont = Math.max(9, Math.round(h * 0.046));
            const seekH = 14 + 2 + Math.ceil(seekFont * 1.25);
            const contentW = w - 2 * m;
            const topH = h - 2 * m - seekH - Math.round(h * 0.03);
            const art = {x: m, y: m, w: topH, h: topH, r: Math.round(topH * 0.08)};

            const rightX = m + topH + m;
            const rightW = w - m - rightX;
            const titleH = Math.round(h * 0.09) + 4;
            const artistH = Math.max(11, Math.round(h * 0.059)) + 4;
            const icon = Math.max(20, Math.round(h * 0.136));
            const groupH = titleH + 2 + artistH + Math.round(h * 0.03) + icon * 1.6;
            const groupY = m + (topH - groupH) / 2;

            const btnH = Math.round(h * 0.09);
            const lyricsButton = lyricsButtonBox(h, btnH, 0.0726, 0.025, Math.max(8, Math.round(h * 0.05)), w - m, m);
            const titleSize = Math.max(12, Math.round(h * 0.06));
            const lyricsTop = btnH + m;
            return {
                art,
                title: textBox(rightX, groupY, rightW, titleH, Math.max(11, Math.round(h * 0.081)), Pango.Weight.SEMIBOLD, {align: 0.5}),
                artist: textBox(rightX, groupY + titleH + 2, rightW, artistH, Math.max(9, Math.round(h * 0.059)), Pango.Weight.MEDIUM, {align: 0.5}),
                controls: controlsRow(icon, Math.round(h * 0.06), rightX + rightW / 2, groupY + titleH + 2 + artistH + Math.round(h * 0.03)),
                seek: {x: m, y: h - m - seekH, w: contentW, fontSize: seekFont},
                lyricsButton,
                lyrics: {x: m, y: lyricsTop, w: contentW, h: h - lyricsTop - m, fontSize: Math.max(12, Math.round(h * 0.077)), titleSize},
            };
        }
        case LAYOUT_BAR: {
            const pad = Math.round(h * 0.12);
            const artSize = h - 2 * pad;
            const icon = Math.max(14, Math.round(h * 0.28));
            const controls = controlsRow(icon, Math.round(h * 0.08), 0, h / 2 - icon * 0.8);
            controls.x = w - pad - controls.rowW;
            const infoX = pad + artSize + pad;
            const infoW = controls.x - Math.round(pad * 0.5) - infoX;
            const titleH = Math.round(h * 0.26) + 2;
            return {
                art: {x: pad, y: pad, w: artSize, h: artSize, r: Math.round(artSize * 0.12)},
                title: textBox(infoX, pad, infoW, titleH, Math.max(8, Math.round(h * 0.19)), Pango.Weight.SEMIBOLD, {scroll: false}),
                artist: textBox(infoX, pad + titleH + 1, infoW, Math.max(8, Math.round(h * 0.15)) + 2, Math.max(6, Math.round(h * 0.14)), Pango.Weight.MEDIUM, {scroll: false}),
                progress: {x: infoX, y: h - pad - 3, w: infoW},
                controls,
                seek: null,
                lyricsButton: null,
                lyrics: null,
            };
        }
        case LAYOUT_TALL: {
            const s = w;
            const m = Math.round(s * 0.08);
            const contentW = w - 2 * m;
            const art = {x: m, y: m, w: contentW, h: contentW, r: Math.round(contentW * 0.08)};
            const infoY = m + contentW + Math.round(s * 0.03);
            const titleH = Math.round(s * 0.08) + 4;
            const artistH = Math.max(10, Math.round(s * 0.055)) + 4;
            const seekFont = Math.max(8, Math.round(s * 0.038));
            const seekH = 14 + 2 + Math.ceil(seekFont * 1.25);
            const icon = Math.max(15, Math.round(s * 0.102));
            const rowH = icon * 1.6;
            const controls = controlsRow(icon, Math.round(s * 0.08), w / 2, h - m - seekH - Math.round(s * 0.03) - rowH);
            controls.lyricsY = h - m - rowH;

            const btnH = Math.round(s * 0.075);
            const lyricsButton = lyricsButtonBox(s, btnH, 0.0528, 0.02, Math.max(7, Math.round(s * 0.038)), w - m,
                infoY + titleH + 2 + artistH + 2 + 4);
            lyricsButton.lyricsY = controls.lyricsY - Math.round(s * 0.04) - btnH;
            const lyricsTop = 2 * m;
            return {
                art,
                title: textBox(m, infoY, contentW, titleH, Math.max(11, Math.round(s * 0.065)), Pango.Weight.SEMIBOLD),
                artist: textBox(m, infoY + titleH + 2, contentW, artistH, Math.max(9, Math.round(s * 0.05)), Pango.Weight.MEDIUM),
                controls,
                seek: {x: m, y: h - m - seekH, w: contentW, fontSize: seekFont},
                lyricsButton,
                lyrics: {
                    x: m,
                    y: lyricsTop,
                    w: contentW,
                    h: lyricsButton.lyricsY - Math.round(s * 0.04) - lyricsTop,
                    fontSize: Math.max(10, Math.round(s * 0.055)),
                    titleSize: Math.max(12, Math.round(s * 0.055)),
                },
            };
        }
        default: { // square
            const s = Math.min(w, h);
            const m = Math.round(s * 0.08);
            const icon = Math.max(20, Math.round(s * 0.11));
            const rowH = icon * 1.6;
            const controls = controlsRow(icon, Math.round(s * 0.08), w / 2, h - m - rowH);
            const artistH = Math.max(13, Math.round(s * 0.0504)) + 4;
            const titleH = Math.round(s * 0.0735) + 4;
            const artistY = controls.y - Math.round(s * 0.04) - artistH;
            return {
                background: true,
                title: textBox(m, artistY - 2 - titleH, w - 2 * m, titleH, Math.max(13, Math.round(s * 0.0683)), Pango.Weight.SEMIBOLD, {align: 0.5}),
                artist: textBox(m, artistY, w - 2 * m, artistH, Math.max(9, Math.round(s * 0.0494)), Pango.Weight.MEDIUM, {align: 0.5}),
                controls,
                seek: null,
                lyricsButton: null,
                lyrics: null,
            };
        }
        }
    }

    _measureText(str, size, weight) {
        const layout = Pango.Layout.new(this.get_pango_context());
        const font = new Pango.FontDescription();
        font.set_family(FONT_FAMILY);
        font.set_weight(weight);
        font.set_absolute_size(size * Pango.SCALE);
        layout.set_font_description(font);
        layout.set_text(str, -1);
        return layout.get_pixel_extents()[1].width;
    }

    addMenuItems(menu) {
        this._playPauseItem = menu.addAction(_('Play'), () => this.player?.playPause());
        this._nextItem = menu.addAction(_('Next Track'), () => this.player?.next());
        this._previousItem = menu.addAction(_('Previous Track'), () => this.player?.previous());
    }

    _onDestroy() {
        for (const id of [this._idleHideId, this._positionId, this._lyricsTickId, this._marqueeWakeId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._timeline.stop();
        this._mpris.destroy();
        this._artLoader.destroy();
        this.lyricsClient.destroy();
        super._onDestroy();
    }

    // --- Painting ---

    _paint(cr) {
        const style = this.paintStyle;
        const g = this._geometry;
        if (!style || !g)
            return;
        const [w, h] = this._canvas.get_surface_size();
        const text = new TextPainter(cr);
        const meta = this.player?.metadata;
        const now = GLib.get_monotonic_time() / 1000;
        let fg = style.fg;

        this._marquee.beginFrame();

        if (g.background) {
            // Square: the art fills the squircle under a dark gradient.
            cr.save();
            squirclePath(cr, w, h, this._settings.get_int('corner-radius'),
                this._settings.get_int('roundness-x10') / 10);
            cr.clip();
            if (this._art)
                paintCover(cr, this._art.surface, 0, 0, w, h);
            else
                drawImage(cr, this._noAlbumArt(), (w - h) / 2, 0, h);
            const shade = new Cairo.LinearGradient(0, 0, 0, h);
            shade.addColorStopRGBA(0, 0, 0, 0, 0.35);
            shade.addColorStopRGBA(0.35, 0, 0, 0, 0.45);
            shade.addColorStopRGBA(0.85, 0, 0, 0, 0.90);
            shade.addColorStopRGBA(1, 0, 0, 0, 0.97);
            cr.setSource(shade);
            cr.paint();
            cr.restore();
            fg = WHITE;
        } else if (g.art) {
            this._paintArt(cr, g.art, now);
        }

        this._paintText(cr, text, meta?.title || _('Not Playing'), g.title, fg, 1);
        this._paintText(cr, text, meta?.artist || '—', g.artist, fg, 0.55);

        if (g.progress) {
            const length = meta?.length ?? 0;
            const p = g.progress;
            setSource(cr, fg, 0.15);
            roundedRect(cr, p.x, p.y, p.w, 3, 1.5);
            cr.fill();
            if (length > 0) {
                setSource(cr, style.accent, 0.8);
                roundedRect(cr, p.x, p.y, p.w * clamp(this.player.position / length, 0, 1), 3, 1.5);
                cr.fill();
            }
        }

        this._scheduleFrames();
    }

    // Album art in a rounded box; a new cover flips in around the vertical
    // axis (FlipAlbumArt.qml), drawn as a horizontal squeeze.
    _paintArt(cr, box, now) {
        let surface = this._art?.surface ?? null;
        let squeeze = 1;
        if (this._flipFrom) {
            const t = clamp((now - this._flipStart) / FLIP_MS, 0, 1);
            const angle = easeInOutQuad(t) * Math.PI;
            squeeze = Math.abs(Math.cos(angle));
            if (angle < Math.PI / 2)
                surface = this._flipFrom.surface;
            if (t >= 1)
                this._flipFrom = null;
        }

        cr.save();
        cr.translate(box.x + box.w / 2, box.y);
        cr.scale(Math.max(0.001, squeeze), 1);
        cr.translate(-box.w / 2, 0);
        roundedRect(cr, 0, 0, box.w, box.h, box.r);
        cr.clip();
        if (surface)
            paintCover(cr, surface, 0, 0, box.w, box.h);
        else
            drawImage(cr, this._noAlbumArt(), 0, 0, box.w);
        if (squeeze < 1) {
            // Darken the far side of the turn a little for depth.
            cr.setSourceRGBA(0, 0, 0, (1 - squeeze) * 0.35);
            cr.paint();
        }
        cr.restore();
    }

    _paintText(cr, text, str, box, color, opacity) {
        const font = {family: FONT_FAMILY, size: box.size, weight: box.weight};
        const width = text.width(str, font);
        const align = box.align ?? 0;
        const cy = box.y + box.h / 2;

        cr.save();
        cr.rectangle(box.x, box.y, box.w, box.h);
        cr.clip();
        setSource(cr, color, opacity);
        if (width <= box.w || box.scroll === false) {
            text.draw(str, box.x + box.w * align, cy, font, {align, valign: 0.5, maxWidth: box.w});
        } else {
            const offset = this._marquee.offset(width - box.w);
            text.draw(str, box.x - offset, cy, font, {valign: 0.5});
        }
        cr.restore();
    }

    // Keep repainting while art flips or a title scrolls; between scrolls,
    // sleep until the next one starts.
    _scheduleFrames() {
        if (this._marqueeWakeId) {
            GLib.source_remove(this._marqueeWakeId);
            this._marqueeWakeId = 0;
        }
        const animating = this._flipFrom !== null || this._marquee.scrolling;
        if (animating) {
            if (!this._timeline.is_playing())
                this._timeline.start();
            return;
        }
        this._timeline.stop();
        if (this._marquee.nextChange < Infinity) {
            this._marqueeWakeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Math.ceil(this._marquee.nextChange) + 10, () => {
                    this._marqueeWakeId = 0;
                    this._canvas.queue_repaint();
                    return GLib.SOURCE_REMOVE;
                });
        }
    }

    _paintControl(cr, button, name) {
        const style = this.paintStyle;
        const g = this._geometry;
        if (!style || !g)
            return;
        const player = this.player;
        const enabled = name === 'previous' ? player?.canGoPrevious
            : name === 'next' ? player?.canGoNext : player?.canPlayPause;
        const icon = name === 'playpause' ? (player?.playing ? 'pause' : 'play') : name;
        const [w, h] = button.get_surface_size();
        const size = g.controls.icon;
        const color = g.background ? WHITE : style.fg;
        drawImage(cr, `${this._iconDir}/${icon}.png`, (w - size) / 2, (h - size) / 2, size,
            {tint: withAlpha(color, enabled ? 1 : 0.3)});
    }

    _paintLyricsButton(cr, button) {
        const style = this.paintStyle;
        const lb = this._geometry?.lyricsButton;
        if (!style || !lb)
            return;
        const [w, h] = button.get_surface_size();
        setSource(cr, this._lyricsActive ? style.lyricsAccent : withAlpha(WHITE, 0.30));
        roundedRect(cr, 0, 0, w, h, h / 2);
        cr.fill();

        const content = lb.icon + lb.gap + this._measureText(_('Lyrics'), lb.fontSize, Pango.Weight.MEDIUM);
        const x = (w - content) / 2;
        drawImage(cr, `${this._iconDir}/lyrics.png`, x, (h - lb.icon) / 2, lb.icon, {tint: WHITE});
        setSource(cr, WHITE);
        new TextPainter(cr).draw(_('Lyrics'), x + lb.icon + lb.gap, h / 2,
            {family: FONT_FAMILY, size: lb.fontSize, weight: Pango.Weight.MEDIUM}, {valign: 0.5});
    }
});
