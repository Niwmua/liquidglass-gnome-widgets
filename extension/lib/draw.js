// Cairo/Pango helpers for widgets that paint their content in one
// St.DrawingArea (the calendar and weather cards). Colors are the
// {r, g, b, a} objects from colors.js.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

export function setSource(cr, c, opacity = 1) {
    cr.setSourceRGBA(c.r, c.g, c.b, c.a * opacity);
}

// Draws single-line text. `font` is {family, size (px), weight}, with
// weight a Pango.Weight (default regular).
export class TextPainter {
    constructor(cr) {
        this._cr = cr;
        this._layout = PangoCairo.create_layout(cr);
    }

    _setup(text, font, {maxWidth = -1, letterSpacing = 0} = {}) {
        const desc = new Pango.FontDescription();
        desc.set_family(font.family);
        desc.set_weight(font.weight ?? Pango.Weight.NORMAL);
        desc.set_absolute_size(Math.max(1, font.size) * Pango.SCALE);

        const layout = this._layout;
        layout.set_font_description(desc);
        layout.set_width(maxWidth > 0 ? Math.round(maxWidth * Pango.SCALE) : -1);
        layout.set_ellipsize(maxWidth > 0 ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE);

        const attrs = new Pango.AttrList();
        if (letterSpacing)
            attrs.insert(Pango.attr_letter_spacing_new(Math.round(letterSpacing * Pango.SCALE)));
        layout.set_attributes(attrs);

        layout.set_text(text, -1);
        return layout;
    }

    // {ink, logical} pixel rectangles, as Pango reports them.
    measure(text, font, options) {
        const [ink, logical] = this._setup(text, font, options).get_pixel_extents();
        return {ink, logical};
    }

    width(text, font, options) {
        return this.measure(text, font, options).logical.width;
    }

    // Draws `text` with its logical box aligned to (x, y):
    //   align:  0 = x is the left edge, 0.5 = centre, 1 = right edge
    //   valign: 0 = y is the top edge,  0.5 = centre, 1 = bottom edge
    // `inkCenter` centres the glyphs' ink vertically instead of the line box,
    // which sits digits optically in the middle of a circle.
    draw(text, x, y, font, {align = 0, valign = 0, inkCenter = false, ...options} = {}) {
        const layout = this._setup(text, font, options);
        const [ink, logical] = layout.get_pixel_extents();
        const left = x - logical.width * align - logical.x;
        const top = inkCenter
            ? y - ink.y - ink.height / 2
            : y - logical.height * valign - logical.y;
        this._cr.moveTo(left, top);
        PangoCairo.show_layout(this._cr, layout);
        return logical;
    }
}

const imageCache = new Map();

function loadPng(path) {
    if (!imageCache.has(path)) {
        let surface = null;
        try {
            surface = Cairo.ImageSurface.createFromPNG(path);
        } catch (e) {
            console.warn(`liquidglass-widgets: cannot load ${path}: ${e.message}`);
        }
        imageCache.set(path, surface);
    }
    return imageCache.get(path);
}

// Drops cached images; called when the extension is disabled.
export function clearImageCache() {
    imageCache.clear();
}

// Paints a PNG scaled to fit a size x size box at (x, y), keeping its
// aspect ratio and centring it in the box. With `tint`, the image is used
// as an alpha mask and filled with that color instead.
export function drawImage(cr, path, x, y, size, {tint = null} = {}) {
    const surface = loadPng(path);
    if (!surface)
        return;

    const w = surface.getWidth();
    const h = surface.getHeight();
    const scale = size / Math.max(w, h);

    cr.save();
    cr.translate(x + (size - w * scale) / 2, y + (size - h * scale) / 2);
    cr.scale(scale, scale);
    if (tint) {
        setSource(cr, tint);
        const mask = new Cairo.SurfacePattern(surface);
        mask.setFilter(Cairo.Filter.GOOD);
        cr.mask(mask);
    } else {
        cr.setSourceSurface(surface, 0, 0);
        cr.getSource().setFilter(Cairo.Filter.GOOD);
        cr.paint();
    }
    cr.restore();
}
