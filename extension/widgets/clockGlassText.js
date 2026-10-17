// Port of packages/clock-glass-text (macOS Clock Glass Text): the time's
// digits ARE the liquid glass; the wallpaper refracts through every stroke.
// A small date line ("15  Thursday") sits above the big H:MM.
//
// The glyphs are drawn twice from one paint function, so both line up:
// as the shape of the TextGlass backdrop (white, opaque), and as an
// optional tinted overlay on top of it for legibility (text tint 0% =
// refraction only, 100% = solid text), shown in Glass style only.

import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {rgba} from '../lib/colors.js';
import {DesktopWidget} from '../lib/desktopWidget.js';
import {TextGlass} from '../lib/textGlass.js';

const PREFIX = 'clock-glass-text';
const ASPECT = 300 / 180; // the KDE widget's default size

// Digit fonts, in the order of the settings combo (KDE's glyphFont index).
export const GLYPH_FONTS = [
    {family: 'SF Pro - Soft', weight: Pango.Weight.NORMAL},
    {family: 'SF Pro Rounded', weight: Pango.Weight.SEMIBOLD},
    {family: 'SF Pro - Rails', weight: Pango.Weight.NORMAL},
    {family: 'New York Extra Large', weight: Pango.Weight.ULTRABOLD},
    {family: 'SF Pro - Stencil', weight: Pango.Weight.NORMAL},
];
// The date line always uses the soft font.
const DAY_FONT = GLYPH_FONTS[0];

function makeLayout(cr, text, font, size, letterSpacing) {
    const layout = PangoCairo.create_layout(cr);
    const desc = new Pango.FontDescription();
    desc.set_family(font.family);
    desc.set_weight(font.weight);
    desc.set_absolute_size(Math.max(1, size) * Pango.SCALE);
    layout.set_font_description(desc);
    const attrs = new Pango.AttrList();
    attrs.insert(Pango.attr_letter_spacing_new(Math.round(letterSpacing * Pango.SCALE)));
    layout.set_attributes(attrs);
    layout.set_text(text, -1);
    return layout;
}

export const GlassTextClock = GObject.registerClass(
class GlassTextClock extends DesktopWidget {
    _init(extension, settings) {
        super._init(extension, settings, PREFIX);

        this._overlay = new St.DrawingArea();
        this._overlay.connect('repaint', () => {
            const cr = this._overlay.get_context();
            const [w, h] = this._overlay.get_surface_size();
            const color = rgba(this._settings.get_string(`${PREFIX}-text-color`).slice(0, 7) || '#ffffff');
            cr.setSourceRGBA(color.r, color.g, color.b, this._settings.get_int(`${PREFIX}-text-tint-pct`) / 100);
            this._paintGlyphs(cr, w, h);
            cr.$dispose();
        });
        this.body.add_child(this._overlay);

        this._wallClock = new GnomeDesktop.WallClock();
        this._wallClock.connect('notify::clock', () => this._textChanged());
        this._interfaceSettings.connectObject('changed::clock-format', () => this._textChanged(), this);
        settings.connectObject(
            `changed::${PREFIX}-glyph-font`, () => this._textChanged(),
            `changed::${PREFIX}-text-tint-pct`, () => this._syncOverlay(),
            `changed::${PREFIX}-text-color`, () => this._overlay.queue_repaint(),
            this);

        this.start();
        this.glass.setGlyphs((cr, w, h) => {
            cr.setSourceRGBA(1, 1, 1, 1);
            this._paintGlyphs(cr, w, h);
        });
    }

    _textChanged() {
        this.glass.refresh();
        this._overlay.queue_repaint();
    }

    _syncOverlay() {
        this._overlay.visible = Boolean(this._palette?.isGlass) &&
            this._settings.get_int(`${PREFIX}-text-tint-pct`) > 0;
        this._overlay.queue_repaint();
    }

    // Port of GlassClockText.qml: the date line above H:MM, the whole block
    // centred, the digits shrunk to fit 86% of the width. Draws with the
    // current cairo source.
    _paintGlyphs(cr, w, h) {
        const now = new Date();
        const use24 = this._interfaceSettings.get_string('clock-format') === '24h';
        const hours = use24 ? String(now.getHours()).padStart(2, '0') : String((now.getHours() + 11) % 12 + 1);
        const minutes = String(now.getMinutes()).padStart(2, '0');
        // No comma: the soft font's comma looks like a raised apostrophe.
        const day = `${now.getDate()}  ${now.toLocaleDateString(undefined, {weekday: 'long'})}`;
        const font = GLYPH_FONTS[this._settings.get_int(`${PREFIX}-glyph-font`)] ?? GLYPH_FONTS[0];

        const requested = Math.min(w * 0.42, h * 0.62);
        const available = Math.max(40, w * 0.86);
        const widthAt = size => {
            const spacing = -size * 0.02;
            const hw = makeLayout(cr, hours, font, size, spacing).get_pixel_extents()[1].width;
            const mw = makeLayout(cr, minutes, font, size, spacing).get_pixel_extents()[1].width;
            return hw + mw + Math.max(3, Math.round(size * 0.11)) + 2 * size * 0.10;
        };
        const natural = widthAt(requested);
        const size = natural > available ? requested * available / natural : requested;

        const daySize = size * 0.22;
        const dayLayout = makeLayout(cr, day, DAY_FONT, daySize, -daySize * 0.01);
        const hourLayout = makeLayout(cr, hours, font, size, -size * 0.02);
        const minuteLayout = makeLayout(cr, minutes, font, size, -size * 0.02);
        const [, dayRect] = dayLayout.get_pixel_extents();
        const [, hourRect] = hourLayout.get_pixel_extents();
        const [, minuteRect] = minuteLayout.get_pixel_extents();

        const gap = size * 0.10;
        const dot = Math.max(3, Math.round(size * 0.11));
        const spacing = size * 0.04;
        const timeH = Math.max(hourRect.height, minuteRect.height);
        const top = (h - (dayRect.height + spacing + timeH)) / 2;

        cr.moveTo((w - dayRect.width) / 2 - dayRect.x, top - dayRect.y);
        PangoCairo.show_layout(cr, dayLayout);

        const rowW = hourRect.width + gap + dot + gap + minuteRect.width;
        let x = (w - rowW) / 2;
        const rowTop = top + dayRect.height + spacing;
        cr.moveTo(x - hourRect.x, rowTop - hourRect.y);
        PangoCairo.show_layout(cr, hourLayout);
        x += hourRect.width + gap;

        // Colon: two dots centred on the line height.
        const cy = rowTop + timeH / 2;
        for (const dy of [-(dot * 1.4 + dot) / 2, (dot * 1.4 + dot) / 2]) {
            cr.newSubPath();
            cr.arc(x + dot / 2, cy + dy, dot / 2, 0, 2 * Math.PI);
            cr.fill();
        }
        x += dot + gap;

        cr.moveTo(x - minuteRect.x, rowTop - minuteRect.y);
        PangoCairo.show_layout(cr, minuteLayout);
    }

    // --- DesktopWidget hooks ---

    createGlass() {
        return new TextGlass();
    }

    readSize() {
        const size = this._settings.get_int(`${PREFIX}-size`);
        return [size * ASPECT, size];
    }

    defaultPosition(area, width, height) {
        // Middle of the screen, a little above centre.
        return [Math.round(area.x + (area.width - width) / 2), Math.round(area.y + area.height * 0.38 - height / 2)];
    }

    glassTint(colors) {
        // Pure refraction; legibility comes from the text overlay instead.
        return {tint: colors.glassTint, tintAlpha: 0};
    }

    styleChanged(colors) {
        this._palette = colors;
        if (this._overlay)
            this._syncOverlay();
    }

    layoutContent(width, height) {
        this._overlay.set_position(0, 0);
        this._overlay.set_size(width, height);
        this._overlay.queue_repaint();
    }

    addMenuItems(menu) {
        menu.addAction(_('Adjust Date and Time…'), () => {
            Shell.AppSystem.get_default()
                .lookup_app('gnome-datetime-panel.desktop')?.activate();
        });
    }

    _onDestroy() {
        this._wallClock.run_dispose();
        super._onDestroy();
    }
});
