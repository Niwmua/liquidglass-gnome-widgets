// Synced lyrics from LRCLIB (https://lrclib.net), as in the KDE music
// widget: one GET per track, matched on artist, title, album and duration.
// Lyrics are only fetched while the lyrics view is open.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const API_URL = 'https://lrclib.net/api/get';
const RETRY_SECONDS = [5, 10, 20, 40, 80, 160, 300];

export const LyricsState = {
    IDLE: 0,
    LOADING: 1,
    LOADED: 2,
    ERROR: 3,
    NOT_FOUND: 4,
};

// "[mm:ss.xx] text" lines -> [{time (ms), text}], sorted. Honors
// "[offset:+/-ms]" tags and the API's own offset (seconds).
export function parseLrc(lrc, apiOffsetSeconds = 0) {
    const lineRe = /\[(\d{2}):(\d{2})[.:](\d{2,3})\](.*)/;
    const offsetRe = /\[offset:([+-]?\d+)\]/i;
    let offset = apiOffsetSeconds * 1000;
    const lines = [];
    for (const raw of lrc.split('\n')) {
        const o = offsetRe.exec(raw);
        if (o) {
            offset += parseInt(o[1]);
            continue;
        }
        const m = lineRe.exec(raw);
        if (!m)
            continue;
        const fraction = m[3].length === 3 ? parseInt(m[3]) : parseInt(m[3]) * 10;
        lines.push({
            time: parseInt(m[1]) * 60000 + parseInt(m[2]) * 1000 + fraction + offset,
            text: m[4].trim(),
        });
    }
    return lines.sort((a, b) => a.time - b.time);
}

// Holds the lyrics for one track at a time; onChanged() runs whenever
// state, synced or plain change.
export class LyricsClient {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._session = new Soup.Session({
            user_agent: 'liquidglass-widgets (https://github.com/Niwmua/liquidglass-gnome-widgets)',
            timeout: 20,
        });
        this._track = null;
        this._key = '';
        this._cancellable = null;
        this._retryId = 0;
        this._failCount = 0;
        this._reset();
    }

    _reset() {
        this.state = LyricsState.IDLE;
        this.synced = [];
        this.plain = '';
    }

    // track: {title, artist, album, length (us)}. Forgets the old lyrics
    // when the track changes; nothing is fetched until fetch().
    setTrack(track) {
        const key = track ? `${track.artist}|${track.title}` : '';
        if (key === this._key)
            return;
        this._cancel();
        this._key = key;
        this._track = track;
        this._failCount = 0;
        this._reset();
        this._onChanged();
    }

    // Fetches the current track's lyrics unless they're loaded or loading.
    fetch() {
        const t = this._track;
        if (!t || !t.title || !t.artist)
            return;
        if (this.state === LyricsState.LOADING || this.state === LyricsState.LOADED ||
            this.state === LyricsState.NOT_FOUND)
            return;
        this._request();
    }

    // After an error, try again now.
    retry() {
        if (this.state === LyricsState.ERROR) {
            this._clearRetry();
            this._request();
        }
    }

    _request() {
        const t = this._track;
        const params = {artist_name: t.artist, track_name: t.title};
        if (t.album)
            params.album_name = t.album;
        if (t.length > 0)
            params.duration = String(Math.round(t.length / 1e6));
        const query = Object.entries(params)
            .map(([k, v]) => `${k}=${GLib.Uri.escape_string(v, null, false)}`).join('&');
        const message = Soup.Message.new('GET', `${API_URL}?${query}`);
        const key = this._key;

        this._cancel();
        this._cancellable = new Gio.Cancellable();
        this.state = LyricsState.LOADING;
        this._onChanged();

        this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
            let bytes;
            try {
                bytes = s.send_and_read_finish(res);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                this._fail(key);
                return;
            }
            if (key !== this._key)
                return;
            this._cancellable = null;

            const status = message.get_status();
            if (status === Soup.Status.NOT_FOUND) {
                this.state = LyricsState.NOT_FOUND;
                this._onChanged();
                return;
            }
            try {
                if (status !== Soup.Status.OK)
                    throw new Error(`HTTP ${status}`);
                const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                this.plain = json.plainLyrics ?? '';
                this.synced = json.syncedLyrics ? parseLrc(json.syncedLyrics, json.offset ?? 0) : [];
                this.state = LyricsState.LOADED;
                this._failCount = 0;
                this._onChanged();
            } catch (e) {
                console.warn(`liquidglass-widgets: lyrics: ${e.message}`);
                this._fail(key);
            }
        });
    }

    _fail(key) {
        if (key !== this._key)
            return;
        this._cancellable = null;
        this.state = LyricsState.ERROR;
        this._onChanged();

        const delay = RETRY_SECONDS[Math.min(this._failCount, RETRY_SECONDS.length - 1)];
        this._failCount++;
        this._clearRetry();
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryId = 0;
            this.retry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancel() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._clearRetry();
    }

    _clearRetry() {
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = 0;
    }

    destroy() {
        this._cancel();
        this._session.abort();
    }
}
