// Countdown state for the timer widget. It belongs to the extension, not to
// the widget, so a running timer survives the widget being hidden on the
// lock screen or switched off, and still rings on time. State is saved in
// GSettings, so it also survives a log out (a timer that ran out meanwhile
// comes back as finished, without ringing).

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export const TimerState = {
    IDLE: 0,
    RUNNING: 1,
    PAUSED: 2,
    FINISHED: 3,
};

// Emits 'changed' whenever the state changes.
export class TimerModel extends Signals.EventEmitter {
    constructor(settings) {
        super();

        this._settings = settings;
        this._alarmId = 0;

        this._state = settings.get_int('timer-state');
        this._endTime = Number(settings.get_int64('timer-end-time'));
        this._pausedRemaining = Number(settings.get_int64('timer-remaining'));

        if (this._state === TimerState.RUNNING) {
            if (this._endTime <= Date.now())
                this._state = TimerState.FINISHED;
            else
                this._scheduleAlarm();
        }
        if (!Object.values(TimerState).includes(this._state))
            this._state = TimerState.IDLE;
    }

    get state() {
        return this._state;
    }

    // Milliseconds left: counts down while running, frozen while paused.
    get remaining() {
        switch (this._state) {
        case TimerState.RUNNING: return Math.max(0, this._endTime - Date.now());
        case TimerState.PAUSED: return this._pausedRemaining;
        default: return 0;
        }
    }

    start(ms) {
        if (ms <= 0)
            return;
        this._endTime = Date.now() + ms;
        this._scheduleAlarm();
        this._set(TimerState.RUNNING);
    }

    pause() {
        if (this._state !== TimerState.RUNNING)
            return;
        this._pausedRemaining = this.remaining;
        this._clearAlarm();
        this._set(TimerState.PAUSED);
    }

    resume() {
        if (this._state !== TimerState.PAUSED)
            return;
        this._endTime = Date.now() + this._pausedRemaining;
        this._scheduleAlarm();
        this._set(TimerState.RUNNING);
    }

    cancel() {
        this._clearAlarm();
        this._set(TimerState.IDLE);
    }

    destroy() {
        this._clearAlarm();
        this.disconnectAll();
    }

    _set(state) {
        this._state = state;
        this._settings.set_int64('timer-end-time', this._endTime);
        this._settings.set_int64('timer-remaining', this._pausedRemaining);
        this._settings.set_int('timer-state', state);
        this.emit('changed');
    }

    // GLib timeouts run on the monotonic clock, which stops during suspend,
    // so the alarm re-checks the wall clock and waits again if it fired early.
    _scheduleAlarm() {
        this._clearAlarm();
        const delay = Math.max(0, this._endTime - Date.now());
        this._alarmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.min(delay, 60000), () => {
            this._alarmId = 0;
            if (Date.now() < this._endTime)
                this._scheduleAlarm();
            else
                this._finish();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearAlarm() {
        if (this._alarmId)
            GLib.source_remove(this._alarmId);
        this._alarmId = 0;
    }

    _finish() {
        this._set(TimerState.FINISHED);

        const source = new MessageTray.Source({
            title: _('Timer'),
            iconName: 'alarm-symbolic',
        });
        Main.messageTray.add(source);
        source.addNotification(new MessageTray.Notification({
            source,
            title: _('Timer'),
            body: _('Time’s up!'),
            urgency: MessageTray.Urgency.HIGH,
            sound: new MessageTray.Sound(null, 'alarm-clock-elapsed'),
        }));
    }
}
