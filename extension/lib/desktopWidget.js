// Base class for a widget that lives on the desktop: it sits in the shell's
// background group (above the wallpaper, below every window), draws a
// LiquidGlass backdrop, can be dragged with the left button and has a
// right-click menu. Subclasses add their content to `this.body` and
// override the hooks at the bottom.
//
// Settings: shared style keys (style-mode, appearance, glass sliders) plus
// `<prefix>-x`, `<prefix>-y` and the widget's size keys (`<prefix>-size` by
// default; see sizeKeys() and readSize()).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LiquidGlass} from './glass.js';
import {macColors} from './colors.js';

const STYLE_KEYS = [
    'style-mode', 'appearance', 'corner-radius', 'roundness-x10',
    'refract-thickness', 'refract-ior-x100', 'refract-scale', 'tint-alpha-pct',
    'chroma-strength-pct', 'spec-strength-pct', 'blur-radius-px',
];

const EDGE_MARGIN = 48;
const HOVER_FADE_MS = 180;

export const DesktopWidget = GObject.registerClass(
class DesktopWidget extends St.Widget {
    _init(extension, settings, prefix) {
        super._init({reactive: true, track_hover: true});

        this._extension = extension;
        this._settings = settings;
        this._prefix = prefix;
        this._grab = null;
        this._dragOffset = [0, 0];
        this._hoverFade = 0;
        this._pointer = [-1, -1];

        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this.glass = new LiquidGlass();
        this.add_child(this.glass);

        this.body = new St.Widget();
        this.add_child(this.body);

        this._fadeTimeline = new Clutter.Timeline({actor: this, duration: HOVER_FADE_MS});
        this._fadeTimeline.connect('new-frame', () => {
            const t = this._fadeTimeline.get_progress();
            this._hoverFade = this._fadeFrom + (this._fadeTo - this._fadeFrom) * t;
            this._syncPointer();
        });
        this.connect('notify::hover', () => this._animateHover(this.hover ? 1 : 0));

        this._buildMenu();

        Main.layoutManager._backgroundGroup.add_child(this);

        const geometryKeys = ['x', 'y', ...this.sizeKeys()].map(k => `changed::${prefix}-${k}`);
        for (const signal of geometryKeys)
            this._settings.connectObject(signal, () => this._loadGeometry(), this);
        for (const key of STYLE_KEYS)
            this._settings.connectObject(`changed::${key}`, () => this._loadStyle(), this);
        this._interfaceSettings.connectObject('changed::color-scheme',
            () => this._loadStyle(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._loadGeometry(), this);

        this.connect('destroy', () => this._onDestroy());
    }

    // Subclasses call this once their content exists.
    start() {
        this._loadStyle();
        this._loadGeometry();
    }

    get colors() {
        return this._colors;
    }

    _loadStyle() {
        const s = this._settings;
        const systemIsDark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        this._colors = macColors(s.get_int('style-mode'), s.get_int('appearance'), systemIsDark);

        this.glass.setParams({
            radius: s.get_int('corner-radius'),
            roundness: s.get_int('roundness-x10') / 10,
            refractThickness: s.get_int('refract-thickness'),
            refractIOR: s.get_int('refract-ior-x100') / 100,
            refractScale: s.get_int('refract-scale'),
            chromaStrength: s.get_int('chroma-strength-pct') / 100,
            tint: this._colors.glassTint,
            tintAlpha: s.get_int('tint-alpha-pct') / 100,
            specStrength: s.get_int('spec-strength-pct') / 100,
            blurRadius: s.get_int('blur-radius-px'),
            ...this.solidBackground(this._colors),
        });

        this.styleChanged(this._colors);
    }

    _loadGeometry() {
        if (this._grab || this._savingPosition)
            return;

        const [width, height] = this.readSize().map(v => Math.max(80, Math.round(v)));
        let x = this._settings.get_int(`${this._prefix}-x`);
        let y = this._settings.get_int(`${this._prefix}-y`);

        if (x < 0 || y < 0) {
            const area = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            [x, y] = this.defaultPosition(area, width, height, EDGE_MARGIN);
        }

        this._width = width;
        this._height = height;
        this.set_size(width, height);
        this.body.set_size(width, height);
        this._moveTo(x, y);
        this.layoutContent(width, height);
    }

    _moveTo(x, y) {
        // Keep the widget fully on screen.
        x = Math.round(Math.min(Math.max(x, 0), global.stage.width - this._width));
        y = Math.round(Math.min(Math.max(y, 0), global.stage.height - this._height));
        this.set_position(x, y);
        this.glass.setGeometry(x, y, this._width, this._height);
    }

    // --- Pointer: drag, menu, specular hover ---

    vfunc_button_press_event(event) {
        const button = event.get_button();

        if (button === Clutter.BUTTON_SECONDARY) {
            this._openMenu();
            return Clutter.EVENT_STOP;
        }

        if (button !== Clutter.BUTTON_PRIMARY || this._settings.get_boolean('lock-position'))
            return Clutter.EVENT_PROPAGATE;

        const [sx, sy] = event.get_coords();
        this._dragOffset = [sx - this.x, sy - this.y];
        this._grab = global.stage.grab(this);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        const [sx, sy] = event.get_coords();

        if (this._grab) {
            this._moveTo(sx - this._dragOffset[0], sy - this._dragOffset[1]);
            return Clutter.EVENT_STOP;
        }

        const [ok, lx, ly] = this.transform_stage_point(sx, sy);
        this._pointer = ok ? [lx / this._width, ly / this._height] : [-1, -1];
        this._syncPointer();
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        this._endDrag();

        // Each set_int() fires a change that reloads the geometry; reloading
        // between the two would see a stale (or unset, -1) y and jump.
        const {x, y} = this;
        this._savingPosition = true;
        this._settings.set_int(`${this._prefix}-x`, x);
        this._settings.set_int(`${this._prefix}-y`, y);
        this._savingPosition = false;
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
    }

    _animateHover(target) {
        this._fadeTimeline.stop();
        this._fadeFrom = this._hoverFade;
        this._fadeTo = target;
        this._fadeTimeline.rewind();
        this._fadeTimeline.start();
    }

    _syncPointer() {
        const [u, v] = this._hoverFade > 0 ? this._pointer : [-1, -1];
        this.glass.setPointer(u, v, this._hoverFade);
    }

    // --- Context menu (port of WidgetActions.qml + per-widget actions) ---

    _buildMenu() {
        this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menuManager.addMenu(this._menu);
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();

        this.addMenuItems(this._menu);
        if (!this._menu.isEmpty())
            this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._glassItem = new PopupMenu.PopupSwitchMenuItem(_('Glass Style'), true);
        this._glassItem.connect('toggled', (_item, on) =>
            this._settings.set_int('style-mode', on ? 0 : 1));
        this._menu.addMenuItem(this._glassItem);

        this._lockItem = new PopupMenu.PopupSwitchMenuItem(_('Lock Position'), false);
        this._lockItem.connect('toggled', (_item, on) =>
            this._settings.set_boolean('lock-position', on));
        this._menu.addMenuItem(this._lockItem);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addAction(_('Widget Settings…'), () => this._extension.openPreferences());
    }

    _openMenu() {
        this._glassItem.setToggleState(this._settings.get_int('style-mode') === 0);
        this._lockItem.setToggleState(this._settings.get_boolean('lock-position'));
        this._menu.toggle();
    }

    _onDestroy() {
        this._endDrag();
        this._fadeTimeline.stop();
        this._settings.disconnectObject(this);
        this._interfaceSettings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._menu.destroy();
    }

    // --- Hooks for subclasses ---

    // Size settings, as suffixes after `<prefix>-`; a change re-runs readSize().
    sizeKeys() {
        return ['size'];
    }

    // [width, height] in stage pixels.
    readSize() {
        const size = this._settings.get_int(`${this._prefix}-size`);
        return [size, size];
    }

    // [x, y] when the widget has no saved position: top-right corner of the
    // primary monitor's work area.
    defaultPosition(area, width, _height, margin) {
        return [area.x + area.width - width - margin, area.y + margin];
    }

    // {solid, solidColor, solidColorBottom?} for the glass backdrop.
    solidBackground(colors) {
        return {solid: colors.isSolid, solidColor: colors.solidBackground};
    }

    styleChanged(_colors) {}

    layoutContent(_width, _height) {}

    addMenuItems(_menu) {}
});
