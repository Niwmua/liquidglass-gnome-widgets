// Liquid glass shaped like text: the glyphs themselves are the glass. Port
// of the KDE repo's TextGlass.qml + shaders/liquidglasstext.frag, for the
// Glass Text clock. Same wallpaper and blur as LiquidGlass (glass.js); the
// silhouette comes from a glyph field (glyphField.js) instead of a squircle.
//
// The shader needs two images, the blurred wallpaper and the glyph field,
// but an offscreen effect hands it only one texture: its own rendering. So
// the actor is twice the widget's width and holds both side by side:
//
//   TextGlass             2W x H, clip_to_allocation, TextGlassEffect
//   ├─ _left              W x H at x = 0, clip_to_allocation
//   │  └─ _blurBox        W + 2*BLUR_PAD wide, Shell.BlurEffect
//   │     └─ _wallpaper   lined up with the monitor's wallpaper
//   └─ _field             W x H at x = W, St.ImageContent with the field
//
// The shader draws the left half and leaves the right half transparent.
// Only its right half is ever read as data, never shown.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BLUR_PAD, BLUR_RADIUS_SCALE, MAX_BLUR_RADIUS, effectFrame, monitorIndexAt} from './glass.js';
import {buildGlyphField, SDF_RANGE} from './glyphField.js';

const UNIFORMS = [
    'size', 'refractThickness', 'refractIOR', 'refractScale', 'chromaStrength',
    'tint', 'specStrength', 'solid', 'frame',
];

// liquidglasstext.frag as a Cogl snippet. Coordinates are actor-relative
// (the effect texture is padded, see effectFrame()): x in [0, 0.5) is the
// wallpaper, [0.5, 1) the glyph field (premultiplied by the compositor, so
// it's un-premultiplied here).
const DECLARATIONS = `
uniform vec2  tg_size;
uniform float tg_refractThickness;
uniform float tg_refractIOR;
uniform float tg_refractScale;
uniform float tg_chromaStrength;
uniform vec4  tg_tint;
uniform float tg_specStrength;
uniform float tg_solid;
uniform vec4  tg_frame;  // the actor's rect in the effect texture (effectFrame)

// Actor-relative position -> effect texture coordinate.
vec4 tg_fetch(sampler2D tex, vec2 actorUV) {
    return texture2D(tex, tg_frame.xy + actorUV * tg_frame.zw);
}

// local: position in the wallpaper half, 0..1 across the widget. Stays
// half a texel inside it, so filtering never reaches the field or padding.
vec3 tg_backdrop(sampler2D tex, vec2 local) {
    vec2 inset = 0.5 / tg_size;
    vec2 uv = clamp(local, inset, vec2(1.0) - inset);
    return tg_fetch(tex, vec2(uv.x * 0.5, uv.y)).rgb;
}

// Thin rim sheen along every contour (edgeSpec in liquidglasstext.frag).
vec3 tg_edgeSpec(vec2 ndir, float depthPx) {
    if (tg_specStrength <= 0.0)
        return vec3(0.0);
    float rim = 1.0 - smoothstep(0.0, 4.0, max(depthPx, 0.0));
    rim = rim * rim;
    float align = dot(ndir, normalize(vec2(-0.55, 0.83)));
    float facing = 0.7 + 0.3 * (align * 0.5 + 0.5);
    return vec3(1.0, 0.985, 0.96) * (rim * facing * tg_specStrength * 0.22);
}

// All texture reads happen before any branch, so neighbouring pixels on
// different paths still get well-defined sampling.
vec4 tg_glass(sampler2D tex, vec2 uv) {
    vec2 local = vec2(clamp(uv.x, 0.0, 0.4999) * 2.0, clamp(uv.y, 0.0, 1.0));

    vec4 f = tg_fetch(tex, vec2(local.x * 0.5 + 0.5, local.y));
    float mask = (uv.x >= 0.0 && uv.x < 0.5 && uv.y >= 0.0 && uv.y <= 1.0) ? f.a : 0.0;
    vec3 field = f.rgb / max(f.a, 1e-3);
    float depthPx = field.b * ${SDF_RANGE.toFixed(1)};
    vec2 n = field.rg * 2.0 - vec2(1.0);
    float l = length(n);
    vec2 ndir = l > 1e-4 ? n / l : vec2(0.0, -1.0);

    // Snell on a dome across the edge band; no displacement outside it.
    float inBand = (tg_refractThickness > 0.0 && depthPx > 0.0 && depthPx < tg_refractThickness) ? 1.0 : 0.0;
    float t = clamp(depthPx / max(tg_refractThickness, 1e-3), 0.0, 1.0);
    float sinThetaI = (1.0 - t) * (1.0 - t);
    float thetaI = asin(clamp(sinThetaI, 0.0, 1.0));
    float thetaT = asin(clamp(sinThetaI / tg_refractIOR, 0.0, 1.0));
    float edgeMag = tan(thetaI - thetaT) * inBand;
    vec2 displaceUV = -ndir * edgeMag * tg_refractScale / tg_size;
    float chromaPx = tg_chromaStrength * tg_refractThickness * 0.35 * (1.0 - t) * inBand;
    vec2 chromaUV = -ndir * chromaPx / tg_size;

    vec3 col;
    col.r = tg_backdrop(tex, local + displaceUV + chromaUV).r;
    col.g = tg_backdrop(tex, local + displaceUV).g;
    col.b = tg_backdrop(tex, local + displaceUV - chromaUV).b;

    if (mask <= 0.001)
        return vec4(0.0);
    if (tg_solid > 0.5)
        return vec4((tg_tint.rgb + tg_edgeSpec(ndir, depthPx)) * mask, mask);

    col = mix(col, tg_tint.rgb, tg_tint.a);
    col += tg_edgeSpec(ndir, depthPx);
    return vec4(col * mask, mask);
}
`;

const CODE = `
cogl_color_out = tg_glass(cogl_sampler0, (cogl_tex_coord_in[0].xy - tg_frame.xy) / tg_frame.zw) *
    cogl_color_in.a;
`;

const TextGlassEffect = GObject.registerClass(
class TextGlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this._locations = {};
        for (const name of UNIFORMS)
            this._locations[name] = this.get_uniform_location(`tg_${name}`);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, true);
    }

    setUniform(name, values) {
        this.set_uniform_float(this._locations[name], values.length, values);
    }
});

export const TextGlass = GObject.registerClass(
class TextGlass extends Clutter.Actor {
    _init() {
        super._init({clip_to_allocation: true});

        this._effect = new TextGlassEffect();
        this.add_effect(this._effect);

        this._left = new Clutter.Actor({clip_to_allocation: true});
        this.add_child(this._left);

        this._blurEffect = new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            brightness: 1.0,
            radius: 6 * BLUR_RADIUS_SCALE,
        });
        this._blurBox = new Clutter.Actor();
        this._blurBox.add_effect(this._blurEffect);
        this._left.add_child(this._blurBox);

        this._wallpaper = new Clutter.Actor();
        this._blurBox.add_child(this._wallpaper);

        this._field = new Clutter.Actor();
        this.add_child(this._field);

        this._bgManager = null;
        this._monitorIndex = -1;
        this._screenX = 0;
        this._screenY = 0;
        this._width = 1;
        this._height = 1;
        this._thickness = 35;
        this._paintGlyphs = null;
        this._tmpDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'liquidglass-widgets']);

        Main.layoutManager.connectObject('monitors-changed', () => {
            this._monitorIndex = -1;
            this._syncWallpaper();
        }, this);

        this.connect('destroy', () => {
            this._bgManager?.destroy();
            this._bgManager = null;
        });
    }

    // Screen position and size of the widget, in stage (logical) pixels.
    setGeometry(x, y, width, height) {
        const resized = Math.round(width) !== this._width || Math.round(height) !== this._height;
        this._screenX = x;
        this._screenY = y;
        this._width = Math.max(1, Math.round(width));
        this._height = Math.max(1, Math.round(height));

        this.set_size(2 * this._width, this._height);
        this._left.set_size(this._width, this._height);
        this._blurBox.set_position(-BLUR_PAD, -BLUR_PAD);
        this._blurBox.set_size(this._width + 2 * BLUR_PAD, this._height + 2 * BLUR_PAD);
        this._field.set_position(this._width, 0);
        this._field.set_size(this._width, this._height);
        this._syncWallpaper();

        this._effect.setUniform('size', [this._width, this._height]);
        this._effect.setUniform('frame', effectFrame(x, y, 2 * this._width, this._height));
        if (resized)
            this._rebuildField();
        this._effect.queue_repaint();
    }

    // Same parameters as LiquidGlass.setParams(); radius and roundness don't
    // apply, the glyphs are the shape. Solid style fills the glyphs flat.
    setParams(p) {
        const e = this._effect;
        e.setUniform('refractIOR', [p.refractIOR]);
        e.setUniform('specStrength', [p.specStrength]);
        e.setUniform('refractThickness', [p.solid ? 0 : p.refractThickness]);
        e.setUniform('refractScale', [p.solid ? 0 : p.refractScale]);
        e.setUniform('chromaStrength', [p.solid ? 0 : p.chromaStrength]);
        e.setUniform('solid', [p.solid ? 1 : 0]);
        e.setUniform('tint', p.solid
            ? [p.solidColor.r, p.solidColor.g, p.solidColor.b, 1]
            : [p.tint.r, p.tint.g, p.tint.b, p.tintAlpha]);

        this._blurBox.visible = !p.solid;
        this._blurEffect.enabled = p.blurRadius > 0;
        this._blurEffect.radius =
            Math.min(MAX_BLUR_RADIUS, Math.round(p.blurRadius * BLUR_RADIUS_SCALE));

        // The field's depth ramp scales with the refraction band.
        if (p.refractThickness !== this._thickness) {
            this._thickness = p.refractThickness;
            this._rebuildField();
        }
        e.queue_repaint();
    }

    setPointer() {
        // No corner highlight on glyphs (it's dropped in the KDE shader too).
    }

    // paint(cr, width, height) draws the glyphs in opaque white, in logical
    // pixels. Call refresh() whenever what it draws changes.
    setGlyphs(paint) {
        this._paintGlyphs = paint;
        this._rebuildField();
    }

    refresh() {
        this._rebuildField();
    }

    _rebuildField() {
        if (!this._paintGlyphs)
            return;

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const w = this._width * scale;
        const h = this._height * scale;

        // Rasterise the glyphs; GJS's cairo can't hand out pixels, so read
        // them back through a PNG.
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
        const cr = new Cairo.Context(surface);
        cr.scale(scale, scale);
        this._paintGlyphs(cr, this._width, this._height);
        cr.$dispose();

        GLib.mkdir_with_parents(this._tmpDir, 0o700);
        const path = GLib.build_filenamev([this._tmpDir, `glyphs-${GLib.uuid_string_random()}.png`]);
        let pixbuf;
        try {
            surface.writeToPNG(path);
            pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        } catch (e) {
            console.warn(`liquidglass-widgets: glyph mask: ${e.message}`);
            return;
        } finally {
            GLib.unlink(path);
        }

        const pixels = pixbuf.get_pixels();
        const stride = pixbuf.get_rowstride();
        const channels = pixbuf.get_n_channels();
        const coverage = new Uint8Array(w * h);
        if (pixbuf.get_has_alpha()) {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++)
                    coverage[y * w + x] = pixels[y * stride + x * channels + 3];
            }
        }

        const field = buildGlyphField(coverage, w, h, {scale, thickness: this._thickness});
        const content = St.ImageContent.new_with_preferred_size(this._width, this._height);
        content.set_bytes(global.stage.context.get_backend().get_cogl_context(),
            new GLib.Bytes(field), Cogl.PixelFormat.RGBA_8888, w, h, w * 4);
        this._field.set_content(content);
        this._effect.queue_repaint();
    }

    _syncWallpaper() {
        const index = monitorIndexAt(
            this._screenX + this._width / 2, this._screenY + this._height / 2);
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return;

        if (index !== this._monitorIndex) {
            this._bgManager?.destroy();
            this._bgManager = new Background.BackgroundManager({
                container: this._wallpaper,
                monitorIndex: index,
                controlPosition: false,
                vignette: false,
            });
            this._monitorIndex = index;
        }

        this._wallpaper.set_position(
            monitor.x - this._screenX + BLUR_PAD,
            monitor.y - this._screenY + BLUR_PAD);
    }
});
