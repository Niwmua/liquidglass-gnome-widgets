// Prints the user's calendar events between two times as JSON, for the
// calendar widget's event list:
//
//   gjs -m calendar-events.js <start epoch seconds> <end epoch seconds>
//
// It reads Evolution Data Server (the calendars in GNOME Calendar and
// Online Accounts) read-only, using its synchronous API. That's why it runs
// as a separate process: a slow online calendar can never stall GNOME Shell.
// It doesn't use gnome-shell-calendar-server, whose single shared time range
// belongs to the top-bar calendar.
//
// Output: [{title, start, end, allDay, color, calendar}] with start/end in
// epoch seconds (all-day events: local midnight), sorted by start.

import ECal from 'gi://ECal?version=2.0';
import EDataServer from 'gi://EDataServer?version=1.2';
import GLib from 'gi://GLib';
import ICalGLib from 'gi://ICalGLib?version=3.0';
import System from 'system';

const CONNECT_TIMEOUT_SECONDS = 15;

// ICalGLib.Time -> epoch seconds. Dates (all-day) become local midnight
// and "floating" times (no zone) count as local time, as in GNOME Calendar.
function toEpoch(time, isDate) {
    if (isDate) {
        return GLib.DateTime.new_local(time.get_year(), time.get_month(), time.get_day(), 0, 0, 0)
            .to_unix();
    }
    if (time.is_utc())
        return time.as_timet();
    const zone = time.get_timezone();
    if (zone)
        return time.as_timet_with_zone(zone);
    return GLib.DateTime.new_local(time.get_year(), time.get_month(), time.get_day(),
        time.get_hour(), time.get_minute(), time.get_second()).to_unix();
}

function main([start, end]) {
    start = Number(start);
    end = Number(end);
    if (!(start < end)) {
        printerr('usage: calendar-events.js <start> <end>');
        return 2;
    }

    const registry = EDataServer.SourceRegistry.new_sync(null);
    // Floating times are resolved in the client's default zone, which is
    // UTC unless set; use the local zone, as gnome-shell-calendar-server does.
    const localZone = ICalGLib.Timezone.get_builtin_timezone(GLib.TimeZone.new_local().get_identifier());
    const events = [];
    const seen = new Set();
    const clients = []; // kept alive until exit; see the dispose note below

    for (const source of registry.list_enabled(EDataServer.SOURCE_EXTENSION_CALENDAR)) {
        const extension = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
        // Calendars switched off in GNOME Calendar stay hidden, as in the
        // top-bar calendar.
        if (!extension.get_selected())
            continue;

        let client;
        try {
            client = ECal.Client.connect_sync(source, ECal.ClientSourceType.EVENTS,
                CONNECT_TIMEOUT_SECONDS, null);
            clients.push(client);
            if (localZone)
                client.set_default_timezone(localZone);
        } catch (e) {
            printerr(`${source.get_display_name()}: ${e.message}`);
            continue;
        }

        const color = extension.get_color() || '';
        const calendar = source.get_display_name();
        try {
            client.generate_instances_sync(start, end, null, (comp, instStart, instEnd) => {
                const allDay = instStart.is_date();
                const s = toEpoch(instStart, allDay);
                let e = instEnd ? toEpoch(instEnd, instEnd.is_date()) : s;
                if (e < s)
                    e = s;
                const key = `${comp.get_uid()}|${s}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    events.push({title: comp.get_summary() ?? '', start: s, end: e, allDay, color, calendar});
                }
                return true;
            });
        } catch (e) {
            printerr(`${calendar}: ${e.message}`);
        }
    }

    events.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
    print(JSON.stringify(events));

    // Dispose the registry now: left to the garbage collector at exit, its
    // dispose dispatches a main-context source after GJS has torn down and
    // the process crashes (a core dump on every run).
    registry.run_dispose();
    return 0;
}

System.exit(main(ARGV));
