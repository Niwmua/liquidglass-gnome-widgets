// Media players over MPRIS (org.mpris.MediaPlayer2.* on the session bus),
// standing in for the Plasma Mpris2Model the KDE music widget uses.
//
// MprisWatcher follows players as they appear and vanish and picks the one
// to show: a playing player first, otherwise the one that played most
// recently, and only players that report a title or artist. Position isn't
// sent in PropertiesChanged, so it's read on demand and extrapolated from
// the wall clock while playing; Seeked corrects it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

const BUS_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';

const PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek"><arg type="x" direction="in"/></method>
    <method name="SetPosition"><arg type="o" direction="in"/><arg type="x" direction="in"/></method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <signal name="Seeked"><arg type="x"/></signal>
  </interface>
</node>`;

const ROOT_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
    <property name="CanRaise" type="b" access="read"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_IFACE);
const RootProxy = Gio.DBusProxy.makeProxyWrapper(ROOT_IFACE);

function unpackMetadata(metadata) {
    const get = key => metadata?.[key]?.deepUnpack?.();
    const artist = get('xesam:artist');
    return {
        trackId: get('mpris:trackid') ?? '',
        title: get('xesam:title') ?? '',
        artist: Array.isArray(artist) ? artist.join(', ') : (artist ?? ''),
        album: get('xesam:album') ?? '',
        artUrl: get('mpris:artUrl') ?? '',
        // Microseconds; some players send it as a double or uint64.
        length: Number(get('mpris:length') ?? 0),
    };
}

// One player. Emits 'changed' on any property change and 'seeked'.
class MprisPlayer extends Signals.EventEmitter {
    constructor(busName, onReady) {
        super();
        this.busName = busName;
        this.identity = busName.slice(BUS_PREFIX.length);
        this.lastActive = 0;
        this._ready = false;
        this._position = 0;
        this._positionAt = 0;
        this._cancellable = new Gio.Cancellable();

        this._root = new RootProxy(Gio.DBus.session, busName, OBJECT_PATH, (proxy, error) => {
            if (!error && proxy.Identity)
                this.identity = proxy.Identity;
        }, this._cancellable);

        this._proxy = new PlayerProxy(Gio.DBus.session, busName, OBJECT_PATH, (proxy, error) => {
            if (error) {
                if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`liquidglass-widgets: ${busName}: ${error.message}`);
                return;
            }
            this._ready = true;
            this._metadata = unpackMetadata(proxy.Metadata);
            if (this.playing)
                this.lastActive = Date.now();
            this.refreshPosition();
            onReady(this);
        }, this._cancellable);

        this._propsId = this._proxy.connect('g-properties-changed', (_p, changed) => {
            const props = changed.deepUnpack();
            if ('Metadata' in props) {
                const before = this._metadata;
                this._metadata = unpackMetadata(this._proxy.Metadata);
                if (before?.trackId !== this._metadata.trackId || before?.title !== this._metadata.title)
                    this._setPosition(0);
            }
            if ('PlaybackStatus' in props || 'Metadata' in props)
                this.refreshPosition();
            if (this.playing)
                this.lastActive = Date.now();
            this.emit('changed');
        });
        this._seekedId = this._proxy.connectSignal('Seeked', (_p, _sender, [position]) => {
            this._setPosition(Number(position));
            this.emit('seeked');
        });
    }

    get ready() {
        return this._ready;
    }

    get metadata() {
        return this._metadata ?? unpackMetadata(null);
    }

    get hasTrack() {
        const m = this.metadata;
        return Boolean(m.title || m.artist);
    }

    get status() {
        return this._proxy.PlaybackStatus ?? 'Stopped';
    }

    get playing() {
        return this.status === 'Playing';
    }

    get canGoNext() {
        return Boolean(this._proxy.CanGoNext);
    }

    get canGoPrevious() {
        return Boolean(this._proxy.CanGoPrevious);
    }

    get canPlayPause() {
        return Boolean(this._proxy.CanPlay || this._proxy.CanPause);
    }

    get canSeek() {
        return Boolean(this._proxy.CanSeek);
    }

    // Current position in microseconds, extrapolated while playing.
    get position() {
        let pos = this._position;
        if (this.playing && this._positionAt)
            pos += (Date.now() - this._positionAt) * 1000;
        const length = this.metadata.length;
        return length > 0 ? Math.min(pos, length) : pos;
    }

    _setPosition(us) {
        this._position = us;
        this._positionAt = Date.now();
    }

    // Asks the player for its position; Position is never pushed to us.
    refreshPosition() {
        Gio.DBus.session.call(this.busName, OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (conn, result) => {
                try {
                    const [value] = conn.call_finish(result).deepUnpack();
                    this._setPosition(Number(value.deepUnpack()));
                    this.emit('seeked');
                } catch (e) {
                    // Not every player implements Position.
                }
            });
    }

    playPause() {
        this._proxy.PlayPauseAsync().catch(logError);
    }

    play() {
        this._proxy.PlayAsync().catch(logError);
    }

    pause() {
        this._proxy.PauseAsync().catch(logError);
    }

    next() {
        this._proxy.NextAsync().catch(logError);
    }

    previous() {
        this._proxy.PreviousAsync().catch(logError);
    }

    // Seeks to an absolute position (microseconds).
    seekTo(us) {
        const trackId = this.metadata.trackId;
        if (trackId && trackId.startsWith('/')) {
            this._proxy.SetPositionAsync(trackId, Math.round(us)).catch(logError);
        } else {
            this._proxy.SeekAsync(Math.round(us - this.position)).catch(logError);
        }
        this._setPosition(us);
    }

    raise() {
        this._root.RaiseAsync?.().catch(() => {});
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy.disconnect(this._propsId);
        this._proxy.disconnectSignal(this._seekedId);
        this.disconnectAll();
    }
}

// All players on the bus. Emits 'changed' when the active player or any of
// its state changes, and 'seeked' when only its position jumped.
export class MprisWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._active = null;

        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(BUS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, null, (conn, result) => {
                try {
                    const [names] = conn.call_finish(result).deepUnpack();
                    names.filter(n => n.startsWith(BUS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {
                    logError(e, 'liquidglass-widgets: listing MPRIS players');
                }
            });
    }

    // The player to show, or null.
    get player() {
        return this._active;
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        const player = new MprisPlayer(name, () => this._choose());
        player.connect('changed', () => this._choose(player));
        player.connect('seeked', () => {
            if (player === this._active)
                this.emit('seeked');
        });
        this._players.set(name, player);
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        player.destroy();
        this._choose();
    }

    _choose(changedPlayer = null) {
        const candidates = [...this._players.values()].filter(p => p.ready && p.hasTrack);
        const playing = candidates.filter(p => p.playing);
        const pool = playing.length > 0 ? playing : candidates;
        // Stick with the current player while it's still a fair choice.
        let next = pool.includes(this._active) ? this._active : null;
        next ??= pool.sort((a, b) => b.lastActive - a.lastActive)[0] ?? null;

        if (next !== this._active || changedPlayer === next || changedPlayer === null) {
            this._active = next;
            this.emit('changed');
        }
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._nameOwnerId);
        for (const player of this._players.values())
            player.destroy();
        this._players.clear();
        this._active = null;
        this.disconnectAll();
    }
}
