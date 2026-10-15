// World-clock helpers: city names and codes for time zones, and the time,
// day and hour difference in a zone. The city table is the KDE repo's
// 1-common/components/cities.js (IANA zone -> short code and name).

import GLib from 'gi://GLib';

const CITIES = {
    // --- North America ---
    "America/New_York":       { code: "NYC",  name: "New York" },
    "America/Detroit":        { code: "DET",  name: "Detroit" },
    "America/Toronto":        { code: "YYZ",  name: "Toronto" },
    "America/Montreal":       { code: "YUL",  name: "Montreal" },
    "America/Chicago":        { code: "CHI",  name: "Chicago" },
    "America/Winnipeg":       { code: "YWG",  name: "Winnipeg" },
    "America/Mexico_City":    { code: "MEX",  name: "Mexico City" },
    "America/Denver":         { code: "DEN",  name: "Denver" },
    "America/Phoenix":        { code: "PHX",  name: "Phoenix" },
    "America/Edmonton":       { code: "YEG",  name: "Edmonton" },
    "America/Los_Angeles":    { code: "LAX",  name: "Los Angeles" },
    "America/Vancouver":      { code: "YVR",  name: "Vancouver" },
    "America/Tijuana":        { code: "TIJ",  name: "Tijuana" },
    "America/Anchorage":      { code: "ANC",  name: "Anchorage" },
    "America/Halifax":        { code: "YHZ",  name: "Halifax" },
    "America/St_Johns":       { code: "YYT",  name: "St. John's" },
    "America/Havana":         { code: "HAV",  name: "Havana" },
    "Pacific/Honolulu":       { code: "HNL",  name: "Honolulu" },

    // --- Central / South America ---
    "America/Guatemala":      { code: "GUA",  name: "Guatemala City" },
    "America/Panama":         { code: "PTY",  name: "Panama City" },
    "America/Bogota":         { code: "BOG",  name: "Bogotá" },
    "America/Lima":           { code: "LIM",  name: "Lima" },
    "America/Caracas":        { code: "CCS",  name: "Caracas" },
    "America/La_Paz":         { code: "LPB",  name: "La Paz" },
    "America/Santiago":       { code: "SCL",  name: "Santiago" },
    "America/Argentina/Buenos_Aires": { code: "BUE", name: "Buenos Aires" },
    "America/Montevideo":     { code: "MVD",  name: "Montevideo" },
    "America/Sao_Paulo":      { code: "SAO",  name: "São Paulo" },
    "America/Asuncion":       { code: "ASU",  name: "Asunción" },

    // --- Europe ---
    "Atlantic/Reykjavik":     { code: "REK",  name: "Reykjavík" },
    "Europe/Lisbon":          { code: "LIS",  name: "Lisbon" },
    "Europe/Dublin":          { code: "DUB",  name: "Dublin" },
    "Europe/London":          { code: "LON",  name: "London" },
    "Europe/Madrid":          { code: "MAD",  name: "Madrid" },
    "Europe/Paris":           { code: "PAR",  name: "Paris" },
    "Europe/Brussels":        { code: "BRU",  name: "Brussels" },
    "Europe/Amsterdam":       { code: "AMS",  name: "Amsterdam" },
    "Europe/Berlin":          { code: "BER",  name: "Berlin" },
    "Europe/Zurich":          { code: "ZRH",  name: "Zürich" },
    "Europe/Rome":            { code: "ROM",  name: "Rome" },
    "Europe/Vienna":          { code: "VIE",  name: "Vienna" },
    "Europe/Prague":          { code: "PRG",  name: "Prague" },
    "Europe/Copenhagen":      { code: "CPH",  name: "Copenhagen" },
    "Europe/Oslo":            { code: "OSL",  name: "Oslo" },
    "Europe/Stockholm":       { code: "STO",  name: "Stockholm" },
    "Europe/Warsaw":          { code: "WAW",  name: "Warsaw" },
    "Europe/Budapest":        { code: "BUD",  name: "Budapest" },
    "Europe/Belgrade":        { code: "BEG",  name: "Belgrade" },
    "Europe/Athens":          { code: "ATH",  name: "Athens" },
    "Europe/Bucharest":       { code: "OTP",  name: "Bucharest" },
    "Europe/Helsinki":        { code: "HEL",  name: "Helsinki" },
    "Europe/Kyiv":            { code: "KBP",  name: "Kyiv" },
    "Europe/Kiev":            { code: "KBP",  name: "Kyiv" },
    "Europe/Istanbul":        { code: "IST",  name: "Istanbul" },
    "Europe/Moscow":          { code: "MOW",  name: "Moscow" },

    // --- Africa ---
    "Africa/Casablanca":      { code: "CMN",  name: "Casablanca" },
    "Africa/Lagos":           { code: "LOS",  name: "Lagos" },
    "Africa/Accra":           { code: "ACC",  name: "Accra" },
    "Africa/Algiers":         { code: "ALG",  name: "Algiers" },
    "Africa/Tunis":           { code: "TUN",  name: "Tunis" },
    "Africa/Cairo":           { code: "CAI",  name: "Cairo" },
    "Africa/Johannesburg":    { code: "JNB",  name: "Johannesburg" },
    "Africa/Cape_Town":       { code: "CPT",  name: "Cape Town" },
    "Africa/Nairobi":         { code: "NBO",  name: "Nairobi" },
    "Africa/Addis_Ababa":     { code: "ADD",  name: "Addis Ababa" },
    "Africa/Kampala":         { code: "KLA",  name: "Kampala" },
    "Africa/Kinshasa":        { code: "FIH",  name: "Kinshasa" },

    // --- Middle East / West Asia ---
    "Asia/Jerusalem":         { code: "JLM",  name: "Jerusalem" },
    "Asia/Beirut":            { code: "BEY",  name: "Beirut" },
    "Asia/Amman":             { code: "AMM",  name: "Amman" },
    "Asia/Riyadh":            { code: "RUH",  name: "Riyadh" },
    "Asia/Qatar":             { code: "DOH",  name: "Doha" },
    "Asia/Dubai":             { code: "DXB",  name: "Dubai" },
    "Asia/Tehran":            { code: "THR",  name: "Tehran" },
    "Asia/Baghdad":           { code: "BGW",  name: "Baghdad" },
    "Asia/Kuwait":            { code: "KWI",  name: "Kuwait City" },
    "Asia/Baku":              { code: "GYD",  name: "Baku" },
    "Asia/Yerevan":           { code: "EVN",  name: "Yerevan" },
    "Asia/Tbilisi":           { code: "TBS",  name: "Tbilisi" },

    // --- Central / South Asia ---
    "Asia/Karachi":           { code: "KHI",  name: "Karachi" },
    "Asia/Tashkent":          { code: "TAS",  name: "Tashkent" },
    "Asia/Kabul":             { code: "KBL",  name: "Kabul" },
    "Asia/Kolkata":           { code: "DEL",  name: "Mumbai" },
    "Asia/Calcutta":          { code: "DEL",  name: "Mumbai" },
    "Asia/Colombo":           { code: "CMB",  name: "Colombo" },
    "Asia/Kathmandu":         { code: "KTM",  name: "Kathmandu" },
    "Asia/Dhaka":             { code: "DAC",  name: "Dhaka" },
    "Asia/Almaty":            { code: "ALA",  name: "Almaty" },

    // --- East / Southeast Asia ---
    "Asia/Yangon":            { code: "RGN",  name: "Yangon" },
    "Asia/Bangkok":           { code: "BKK",  name: "Bangkok" },
    "Asia/Jakarta":           { code: "JKT",  name: "Jakarta" },
    "Asia/Ho_Chi_Minh":       { code: "SGN",  name: "Ho Chi Minh City" },
    "Asia/Saigon":            { code: "SGN",  name: "Ho Chi Minh City" },
    "Asia/Kuala_Lumpur":      { code: "KUL",  name: "Kuala Lumpur" },
    "Asia/Singapore":         { code: "SIN",  name: "Singapore" },
    "Asia/Manila":            { code: "MNL",  name: "Manila" },
    "Asia/Hong_Kong":         { code: "HKG",  name: "Hong Kong" },
    "Asia/Taipei":            { code: "TPE",  name: "Taipei" },
    "Asia/Shanghai":          { code: "SHA",  name: "Shanghai" },
    "Asia/Chongqing":         { code: "CKG",  name: "Chongqing" },
    "Asia/Urumqi":            { code: "URC",  name: "Ürümqi" },
    "Asia/Seoul":             { code: "SEL",  name: "Seoul" },
    "Asia/Pyongyang":         { code: "FNJ",  name: "Pyongyang" },
    "Asia/Tokyo":             { code: "TYO",  name: "Tokyo" },
    "Asia/Ulaanbaatar":       { code: "ULN",  name: "Ulaanbaatar" },
    "Asia/Vladivostok":       { code: "VVO",  name: "Vladivostok" },
    "Asia/Yekaterinburg":     { code: "SVX",  name: "Yekaterinburg" },
    "Asia/Novosibirsk":       { code: "OVB",  name: "Novosibirsk" },
    "Asia/Krasnoyarsk":       { code: "KJA",  name: "Krasnoyarsk" },

    // --- Oceania ---
    "Australia/Perth":        { code: "PER",  name: "Perth" },
    "Australia/Adelaide":     { code: "ADL",  name: "Adelaide" },
    "Australia/Darwin":       { code: "DRW",  name: "Darwin" },
    "Australia/Brisbane":     { code: "BNE",  name: "Brisbane" },
    "Australia/Sydney":       { code: "SYD",  name: "Sydney" },
    "Australia/Melbourne":    { code: "MEL",  name: "Melbourne" },
    "Australia/Hobart":       { code: "HBA",  name: "Hobart" },
    "Pacific/Auckland":       { code: "AKL",  name: "Auckland" },
    "Pacific/Fiji":           { code: "SUV",  name: "Suva" },
    "Pacific/Port_Moresby":   { code: "POM",  name: "Port Moresby" },
    "Pacific/Guam":           { code: "GUM",  name: "Guam" },
    "Pacific/Tongatapu":      { code: "TBU",  name: "Nukuʻalofa" },
    "Pacific/Pago_Pago":      { code: "PPG",  name: "Pago Pago" }
};

// "Asia/Kuala_Lumpur" -> "Kuala Lumpur"
function nameFromZone(zone) {
    const city = String(zone).split('/').pop().replace(/_/g, ' ');
    return city.replace(/\b\w/g, c => c.toUpperCase());
}

// "New York" -> "NY", "Lima" -> "LIM"
function codeFromName(name) {
    const words = name.split(' ').filter(w => w.length > 0);
    if (words.length >= 2)
        return words.slice(0, 3).map(w => w[0]).join('').toUpperCase();
    return name.slice(0, 3).toUpperCase();
}

// {code, name} for a zone, derived from its id when it isn't in the table.
export function lookupCity(zone) {
    return CITIES[zone] ?? {code: codeFromName(nameFromZone(zone)), name: nameFromZone(zone)};
}

// Every city in the table as {zone, code, name}, for the settings search.
export function knownCities() {
    return Object.entries(CITIES).map(([zone, info]) => ({zone, ...info}));
}

// Settings store each clock as "Zone/Id" or "Zone/Id|Custom label".
// Returns [{zone, label, code, name, tz}] for the entries GLib knows.
export function parseClocks(entries) {
    const clocks = [];
    for (const entry of entries) {
        const bar = entry.indexOf('|');
        const zone = (bar >= 0 ? entry.slice(0, bar) : entry).trim();
        const label = bar >= 0 ? entry.slice(bar + 1).trim() : '';
        const tz = zone ? GLib.TimeZone.new_identifier(zone) : null;
        if (!tz)
            continue;
        const info = lookupCity(zone);
        clocks.push({zone, tz, code: info.code, name: info.name, label: label || info.name});
    }
    return clocks;
}

// "+3.5HRS", "-12.5HRS", "0HRS" (with suffix) or "+3.5", ... (without).
export function offsetLabel(hours, suffix = true) {
    const sign = hours > 0 ? '+' : (hours < 0 ? '-' : '');
    const abs = Math.abs(hours);
    const num = abs % 1 === 0 ? String(abs) : abs.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return `${sign}${num}${suffix ? 'HRS' : ''}`;
}

// The time in `tz` now: hours, minutes, seconds (with fraction), the hour
// difference from local time, and whether that zone is a day ahead or behind.
export function zoneNow(tz) {
    const local = GLib.DateTime.new_now_local();
    const there = local.to_timezone(tz);
    const dayDiff = Math.round(
        (Date.UTC(there.get_year(), there.get_month() - 1, there.get_day_of_month()) -
         Date.UTC(local.get_year(), local.get_month() - 1, local.get_day_of_month())) / 86400000);
    return {
        hours: there.get_hour(),
        minutes: there.get_minute(),
        seconds: there.get_second() + there.get_microsecond() / 1e6,
        relHours: (there.get_utc_offset() - local.get_utc_offset()) / 3600e6,
        dayDiff,
        isDay: there.get_hour() >= 6 && there.get_hour() < 18,
    };
}
