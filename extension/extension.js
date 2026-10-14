import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {clearImageCache} from './lib/draw.js';
import {TimerModel} from './lib/timerModel.js';
import {AnalogClock} from './widgets/clockAnalog.js';
import {DigitalClock} from './widgets/clockDigital.js';
import {CalendarWidget} from './widgets/calendar.js';
import {TimerWidget} from './widgets/timer.js';
import {WeatherWidget} from './widgets/weather.js';

// Each entry: settings key that toggles the widget, and its class.
const WIDGETS = [
    {key: 'clock-analog-enabled', create: (ext, settings) => new AnalogClock(ext, settings, 'clock-analog')},
    {key: 'clock-analog-2-enabled', create: (ext, settings) => new AnalogClock(ext, settings, 'clock-analog-2')},
    {key: 'clock-analog-3-enabled', create: (ext, settings) => new AnalogClock(ext, settings, 'clock-analog-3')},
    {key: 'clock-digital-enabled', create: (ext, settings) => new DigitalClock(ext, settings)},
    {key: 'calendar-enabled', create: (ext, settings) => new CalendarWidget(ext, settings)},
    {key: 'weather-enabled', create: (ext, settings) => new WeatherWidget(ext, settings)},
    {key: 'timer-enabled', create: (ext, settings) => new TimerWidget(ext, settings)},
];

// The extension also runs on the lock screen ("session-modes" in
// metadata.json) so a running timer still rings there. The widgets
// themselves are removed while locked; only the timer model keeps going.
export default class LiquidGlassWidgets extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._widgets = new Map();
        this.timerModel = new TimerModel(this._settings);

        for (const {key} of WIDGETS)
            this._settings.connectObject(`changed::${key}`, () => this._sync(), this);
        Main.sessionMode.connectObject('updated', () => this._sync(), this);
        this._sync();
    }

    disable() {
        this._settings.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        for (const widget of this._widgets.values())
            widget.destroy();
        this._widgets = null;
        this.timerModel.destroy();
        this.timerModel = null;
        this._settings = null;
        clearImageCache();
    }

    _sync() {
        const locked = Main.sessionMode.isLocked;

        for (const {key, create} of WIDGETS) {
            const wanted = !locked && this._settings.get_boolean(key);
            const widget = this._widgets.get(key);

            if (wanted && !widget) {
                this._widgets.set(key, create(this, this._settings));
            } else if (!wanted && widget) {
                widget.destroy();
                this._widgets.delete(key);
            }
        }
    }
}
