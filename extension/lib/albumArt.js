// Album art for the music widget: loads an MPRIS artUrl (file:// or
// http(s)://), scales it to at most ART_SIZE and returns it as a cairo
// surface, plus a palette sampled from it (port of the median-cut sampler
// in the KDE widget's main.qml).
//
// Cairo in GJS can only read PNG from a file, so the scaled image takes a
// short trip through a temporary PNG in the user cache directory.

import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {rgba} from './colors.js';

const ART_SIZE = 512;
const SAMPLE_SIZE = 32;
const MAX_CACHED = 6;

function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h * 6) % 2 - 1));
    const m = l - c / 2;
    const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h * 6) % 6];
    return {r: r + m, g: g + m, b: b + m, a: 1};
}

function rgbToHsl(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r)
            h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g)
            h = ((b - r) / d + 2) / 6;
        else
            h = ((r - g) / d + 4) / 6;
    }
    return {h, s, l};
}

// Splits pixels along their widest channel, `depth` times; each bucket
// becomes its average color and pixel count.
function medianCut(pixels, depth) {
    if (depth === 0 || pixels.length === 0) {
        const n = pixels.length || 1;
        const sum = pixels.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
        return [{r: sum[0] / n / 255, g: sum[1] / n / 255, b: sum[2] / n / 255, count: pixels.length}];
    }
    const range = ch => Math.max(...pixels.map(p => p[ch])) - Math.min(...pixels.map(p => p[ch]));
    const [rR, gR, bR] = [range(0), range(1), range(2)];
    const ch = rR >= gR && rR >= bR ? 0 : (gR >= bR ? 1 : 2);
    pixels.sort((a, b) => a[ch] - b[ch]);
    const mid = Math.floor(pixels.length / 2);
    return medianCut(pixels.slice(0, mid), depth - 1).concat(medianCut(pixels.slice(mid), depth - 1));
}

// {tint, top, bottom, primary}: glass tint, Solid gradient, and an accent
// for the progress bar.
function samplePalette(pixbuf) {
    const small = pixbuf.scale_simple(SAMPLE_SIZE, SAMPLE_SIZE, GdkPixbuf.InterpType.BILINEAR);
    const data = small.get_pixels();
    const stride = small.get_rowstride();
    const channels = small.get_n_channels();
    const alpha = small.get_has_alpha();

    const pixels = [];
    for (let y = 0; y < SAMPLE_SIZE; y++) {
        for (let x = 0; x < SAMPLE_SIZE; x++) {
            const i = y * stride + x * channels;
            if (alpha && data[i + 3] < 128)
                continue;
            pixels.push([data[i], data[i + 1], data[i + 2]]);
        }
    }
    if (pixels.length === 0)
        return null;

    const buckets = medianCut(pixels, 3);
    let accent = buckets[0], best = -1;
    for (const b of buckets) {
        Object.assign(b, rgbToHsl(b.r, b.g, b.b));
        const score = b.s * (0.3 + 0.7 * (1 - Math.abs(2 * b.l - 1)));
        if (score > best) {
            best = score;
            accent = b;
        }
    }
    const byCount = [...buckets].sort((a, b) => b.count - a.count);
    const dominant = byCount[0];
    const secondary = byCount[1] ?? dominant;
    const mono = buckets.reduce((sum, b) => sum + b.s, 0) / buckets.length < 0.12;

    if (mono) {
        return {
            tint: hslToRgb(0, 0, Math.min(dominant.l, 0.30)),
            top: hslToRgb(0, 0, 0.15 + dominant.l * 0.35),
            bottom: hslToRgb(0, 0, 0.06 + dominant.l * 0.20),
            primary: rgba('#ffffff'),
        };
    }
    return {
        tint: hslToRgb(accent.h, Math.min(accent.s, 0.5), Math.min(accent.l, 0.30)),
        top: hslToRgb(dominant.h, Math.max(dominant.s, 0.30), 0.15 + dominant.l * 0.35),
        bottom: hslToRgb(secondary.h, Math.max(secondary.s, 0.25), 0.06 + secondary.l * 0.20),
        primary: hslToRgb(accent.h, Math.max(accent.s, 0.55), Math.max(accent.l, 0.75)),
    };
}

export class AlbumArtLoader {
    constructor() {
        this._session = new Soup.Session({
            user_agent: 'liquidglass-widgets (GNOME Shell extension)',
            timeout: 20,
        });
        this._cache = new Map(); // url -> {surface, palette}
        this._cancellable = null;
        this._tmpDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'liquidglass-widgets']);
    }

    // Resolves to {surface, palette} or null; a newer load() cancels an
    // older one, which then resolves to null.
    async load(url) {
        if (this._cache.has(url))
            return this._cache.get(url);

        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        try {
            const stream = await this._open(url, cancellable);
            const pixbuf = await new Promise((resolve, reject) => {
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, ART_SIZE, ART_SIZE, true,
                    cancellable, (_s, res) => {
                        try {
                            resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
            if (cancellable.is_cancelled())
                return null;

            const art = {surface: this._toSurface(pixbuf), palette: samplePalette(pixbuf)};
            this._cache.set(url, art);
            if (this._cache.size > MAX_CACHED)
                this._cache.delete(this._cache.keys().next().value);
            return art;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`liquidglass-widgets: album art ${url}: ${e.message}`);
            return null;
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
        }
    }

    _open(url, cancellable) {
        if (/^https?:/i.test(url)) {
            const message = Soup.Message.new('GET', url);
            return new Promise((resolve, reject) => {
                this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                    try {
                        const bytes = s.send_and_read_finish(res);
                        if (message.get_status() !== Soup.Status.OK)
                            throw new Error(`HTTP ${message.get_status()}`);
                        resolve(Gio.MemoryInputStream.new_from_bytes(bytes));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        }

        const file = url.includes('://') ? Gio.File.new_for_uri(url) : Gio.File.new_for_path(url);
        return new Promise((resolve, reject) => {
            file.read_async(GLib.PRIORITY_DEFAULT, cancellable, (f, res) => {
                try {
                    resolve(f.read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    _toSurface(pixbuf) {
        GLib.mkdir_with_parents(this._tmpDir, 0o700);
        const path = GLib.build_filenamev([this._tmpDir, `art-${GLib.uuid_string_random()}.png`]);
        try {
            const [, buffer] = pixbuf.save_to_bufferv('png', [], []);
            GLib.file_set_contents(path, buffer);
            return Cairo.ImageSurface.createFromPNG(path);
        } finally {
            GLib.unlink(path);
        }
    }

    destroy() {
        this._cancellable?.cancel();
        this._session.abort();
        this._cache.clear();
    }
}
