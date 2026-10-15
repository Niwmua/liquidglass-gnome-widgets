// Upcoming calendar events for the calendar widget, read by running
// helpers/calendar-events.js in its own process (see that file for why).
// Refreshes on load(), every REFRESH_MINUTES, and whenever the widget asks.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const REFRESH_MINUTES = 10;
const HELPER_TIMEOUT_SECONDS = 90;

export class CalendarEvents {
    // onChanged(events) runs after each successful read.
    constructor(extension, onChanged) {
        this._helper = extension.dir.get_child('helpers').get_child('calendar-events.js').get_path();
        this._gjs = GLib.find_program_in_path('gjs');
        this._onChanged = onChanged;
        this._subprocess = null;
        this._timeoutId = 0;
        this._refreshId = 0;
        this._days = 30;
        this.events = [];
        this.loaded = false;
        this.failed = false; // the last read failed
    }

    // Reads `days` days from local midnight today, now and then periodically.
    load(days) {
        this._days = days;
        this.refresh();
        if (!this._refreshId) {
            this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_MINUTES * 60, () => {
                this.refresh();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    refresh() {
        if (this._subprocess || !this._gjs)
            return;

        const today = GLib.DateTime.new_now_local();
        const start = GLib.DateTime.new_local(today.get_year(), today.get_month(), today.get_day_of_month(), 0, 0, 0);
        const end = start.add_days(this._days);

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [this._gjs, '-m', this._helper, String(start.to_unix()), String(end.to_unix())],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            console.warn(`liquidglass-widgets: calendar events: ${e.message}`);
            return;
        }
        this._subprocess = proc;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HELPER_TIMEOUT_SECONDS, () => {
            this._timeoutId = 0;
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, null, (p, result) => {
            if (this._timeoutId)
                GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
            this._subprocess = null;
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(result);
                if (stderr?.trim())
                    console.warn(`liquidglass-widgets: calendar events: ${stderr.trim()}`);
                if (!p.get_successful()) {
                    throw new Error(p.get_if_exited()
                        ? `helper exited with status ${p.get_exit_status()}` : 'helper was stopped');
                }
                this.events = JSON.parse(stdout);
                this.loaded = true;
                this.failed = false;
                this._onChanged(this.events);
            } catch (e) {
                console.warn(`liquidglass-widgets: calendar events: ${e.message}`);
                this.failed = true;
                this._onChanged(this.events);
            }
        });
    }

    destroy() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._refreshId = this._timeoutId = 0;
        this._subprocess?.force_exit();
        this._subprocess = null;
        this._onChanged = () => {};
    }
}
