// Turns glyph coverage into the data the text-glass shader needs. CPU port
// of the KDE repo's TextGlass.qml SDF chain in its "fast" mode (blur_h ->
// blur_v -> glyph_sdf.frag with fastSDF = 1):
//
//   1. a small Gaussian blur of the coverage makes a ramp across each edge;
//   2. depth into the glyph = (blurred - 0.5) * rampScale;
//   3. the outward normal is minus the Sobel gradient of the blurred ramp.
//
// The clock only changes once a minute, so doing this on the CPU is cheap
// and keeps the GPU side to a single shader.
//
// Output texel (RGBA, straight alpha): rg = normal * 0.5 + 0.5,
// b = depth / SDF_RANGE (logical px), a = the sharp glyph coverage.

export const SDF_RANGE = 64; // logical px packed into the blue channel

// Separable Gaussian blur of a w x h Float32Array.
function gaussianBlur(src, w, h, sigma) {
    // 3 sigma: the weights past that are below 1%, invisible in 8-bit output.
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const kernel = new Float32Array(2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
        sum += kernel[i + radius];
    }
    for (let i = 0; i < kernel.length; i++)
        kernel[i] /= sum;

    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const xx = Math.min(w - 1, Math.max(0, x + k));
                acc += src[row + xx] * kernel[k + radius];
            }
            tmp[row + x] = acc;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let acc = 0;
            for (let k = -radius; k <= radius; k++) {
                const yy = Math.min(h - 1, Math.max(0, y + k));
                acc += tmp[yy * w + x] * kernel[k + radius];
            }
            out[y * w + x] = acc;
        }
    }
    return out;
}

// coverage: Uint8Array, one byte (0..255) per pixel, w x h device pixels.
// scale: device pixels per logical pixel. thickness: refraction band (px).
// Returns a Uint8Array of w * h RGBA texels.
export function buildGlyphField(coverage, w, h, {scale = 1, thickness = 35} = {}) {
    const out = new Uint8Array(w * h * 4);

    // Same constants as TextGlass.qml / blur_h.frag.
    const sdfBlurPx = Math.max(5, thickness * 0.8);
    const sigma = Math.min(3.1, Math.max(0.001, sdfBlurPx / 3)) * scale;
    const rampScale = sdfBlurPx * 2;
    const step = Math.max(1, Math.round(Math.max(2, sdfBlurPx * 0.5) * scale));

    // Only the glyphs' bounding box (plus the blur and gradient reach)
    // matters; everything else stays transparent.
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (coverage[y * w + x]) {
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
                y0 = Math.min(y0, y);
                y1 = Math.max(y1, y);
            }
        }
    }
    if (x1 < 0)
        return out;
    const pad = Math.ceil(sigma * 3) + step + 1;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad);
    y1 = Math.min(h - 1, y1 + pad);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;

    const cov = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++)
            cov[y * bw + x] = coverage[(y + y0) * w + x + x0] / 255;
    }
    const blurred = gaussianBlur(cov, bw, bh, sigma);
    const at = (x, y) => blurred[Math.min(bh - 1, Math.max(0, y)) * bw + Math.min(bw - 1, Math.max(0, x))];

    for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
            const x = bx, y = by;
            const i = (by + y0) * w + bx + x0;
            const o = i * 4;
            const alpha = coverage[i];
            out[o + 3] = alpha;
            if (alpha === 0)
                continue; // the shader never reads outside the glyph

            const tl = at(x - step, y - step), tc = at(x, y - step), tr = at(x + step, y - step);
            const ml = at(x - step, y), mr = at(x + step, y);
            const bl = at(x - step, y + step), bc = at(x, y + step), br = at(x + step, y + step);
            let nx = -((tr + 2 * mr + br) - (tl + 2 * ml + bl));
            let ny = -((bl + 2 * bc + br) - (tl + 2 * tc + tr));
            const len = Math.hypot(nx, ny);
            if (len > 1e-3) {
                nx /= len;
                ny /= len;
            } else {
                nx = 0;
                ny = -1;
            }

            const depth = Math.min(SDF_RANGE, Math.max(0, (blurred[by * bw + bx] - 0.5) * rampScale));
            out[o] = Math.round((nx * 0.5 + 0.5) * 255);
            out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
            out[o + 2] = Math.round(depth / SDF_RANGE * 255);
        }
    }
    return out;
}
