// .github/scripts/pull_aa_phx_adb.js
// Fetch live American Airlines flights at PHX from AeroDataBox (RapidAPI)
// Writes: data/aa-phx/latest.json (+ dated copy)
// Requires repo secret: RAPIDAPI_KEY

const fs = require("node:fs");
const path = require("node:path");

const RAPID_KEY = process.env.RAPIDAPI_KEY;
if (!RAPID_KEY) {
  console.error("Missing RAPIDAPI_KEY environment secret.");
  process.exit(1);
}

const BASE_HOST = "aerodatabox.p.rapidapi.com";
const BASE_URL  = `https://${BASE_HOST}`;
const AIRPORT_IATA = "PHX";      // Phoenix (IATA path works best)
const AIRLINE_IATA = "AA";       // American
const AIRLINE_ICAO = "AAL";

// ----------------- helpers -----------------

const isoMin = d => d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM (UTC)

// Parse strings like:
// "2025-08-13 18:52Z" / "2025-08-13 18:52-07:00" / ISO strings -> epoch seconds
const toSec = s => {
  if (!s) return null;
  if (typeof s === "string") {
    let str = s.trim();
    // Coerce "YYYY-MM-DD HH:mmZ" or "YYYY-MM-DD HH:mm±HH:MM" to ISO
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(str)) {
      str = str.replace(" ", "T");
    }
    const t1 = Date.parse(str);
    return Number.isFinite(t1) ? Math.floor(t1 / 1000) : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

const apId = ap => (ap?.iata || ap?.icao || null);

// Keep only American flights
const isAA = f => {
  // In FIDS, airline is at f.airline; id at f.number / f.callSign
  const opIata = (f?.airline?.iata || "").toUpperCase();
  const opIcao = (f?.airline?.icao || "").toUpperCase();
  const ident  = (f?.number || f?.callSign || "").toUpperCase().replace(/\s+/g, "");
  return opIata === AIRLINE_IATA || opIcao === AIRLINE_ICAO || ident.startsWith("AA");
};

// Map one FIDS record to our simplified row
function mapRow(f, type) {
  const dep = f.departure || {};
  const arr = f.arrival   || {};
  const ac  = f.aircraft  || {};

  // ADB FIDS times are nested: *.scheduledTime.utc, *.revisedTime.utc, *.runwayTime.utc
  const getUtc = (seg, key) => seg?.[key]?.utc || seg?.[key]?.local || null;

  // Priority for each column
  const schedISO = type === "DEP" ? getUtc(dep, "scheduledTime") : getUtc(arr, "scheduledTime");
  const estISO   = type === "DEP"
    ? (getUtc(dep, "revisedTime") || getUtc(dep, "estimatedTime"))
    : (getUtc(arr, "revisedTime") || getUtc(arr, "estimatedTime"));
  const actISO   = type === "DEP"
    ? (getUtc(dep, "runwayTime") || getUtc(dep, "actualTime"))
    : (getUtc(arr, "runwayTime") || getUtc(arr, "actualTime"));

  // Terminal/gate may appear on dep or arr; use whichever exists
  const terminal = (type === "DEP" ? dep.terminal : arr.terminal) ?? dep.terminal ?? arr.terminal ?? null;
  const gate     = (type === "DEP" ? dep.gate     : arr.gate)     ?? dep.gate     ?? arr.gate     ?? null;

  // Flight id: use published "number" (e.g., "AA 123") squashed to "AA123"
  const flightId = (f.number || f.callSign || "").toString().replace(/\s+/g, "");

  return {
    type, // "ARR" | "DEP"
    flight: flightId,
    reg: ac.registration || ac.reg || null,
    origin: apId(dep.airport),
    destination: apId(arr.airport),
    terminal,
    gate,
    sched:  toSec(schedISO),
    est:    toSec(estISO),
    actual: toSec(actISO),
    status: f.status || ""
  };
}

async function fetchWithRetry(url, headers, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
      try { return JSON.parse(text); }
      catch (e) { throw new Error(`JSON parse error: ${e.message} :: ${text.slice(0, 200)}`); }
    } catch (e) {
      lastErr = e;
      const backoff = 500 * i;
      console.warn(`Attempt ${i} failed: ${e.message} — retrying in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// -------------- request window (<=12h per API) --------------

const now = new Date();
const PAST_HOURS   = 2;
const WINDOW_HOURS = 12;
const from = new Date(now.getTime() - PAST_HOURS * 3600 * 1000);
const to   = new Date(from.getTime() + WINDOW_HOURS * 3600 * 1000);

// Use IATA endpoint (PHX) with relative window
const url =
  `${BASE_URL}/flights/airports/iata/${AIRPORT_IATA}` +
  `?offsetMinutes=-120&durationMinutes=600&direction=Both` +
  `&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=true`;

const headers = {
  "X-RapidAPI-Key": RAPID_KEY,
  "X-RapidAPI-Host": BASE_HOST,
  "Accept": "application/json"
};

// ------------------ main ------------------

(async () => {
  try {
    console.log("Requesting:", url);
    const js = await fetchWithRetry(url, headers);

    // DEBUG: write the raw shape so we can inspect fields anytime
    try {
      const dbgDir = path.join(process.cwd(), "data", "aa-phx");
      fs.mkdirSync(dbgDir, { recursive: true });
      fs.writeFileSync(path.join(dbgDir, "_last_raw.json"), JSON.stringify(js, null, 2));
      console.log("Wrote data/aa-phx/_last_raw.json");
    } catch (e) {
      console.warn("debug write failed:", e.message);
    }

    const arrivals   = Array.isArray(js.arrivals)   ? js.arrivals   : [];
    const departures = Array.isArray(js.departures) ? js.departures : [];
    console.log(`ADB returned ${arrivals.length} arrivals + ${departures.length} departures`);

    let aaArr = arrivals.filter(isAA);
    let aaDep = departures.filter(isAA);
    console.log(`Filtered AA: ${aaArr.length} arrivals, ${aaDep.length} departures`);

    let flights = [...aaArr.map(f => mapRow(f, "ARR")), ...aaDep.map(f => mapRow(f, "DEP"))]
      .filter(r => r.sched || r.est || r.actual)
      .sort((a, b) => (a.actual || a.est || a.sched || 0) - (b.actual || b.est || b.sched || 0));

    // Fallback for visibility while tuning
    if (flights.length === 0) {
      console.log("AA filter produced 0 rows — writing ALL carriers for inspection.");
      flights = [...arrivals.map(f => mapRow(f, "ARR")), ...departures.map(f => mapRow(f, "DEP"))]
        .filter(r => r.sched || r.est || r.actual)
        .sort((a, b) => (a.actual || a.est || a.sched || 0) - (b.actual || b.est || b.sched || 0));
    }

    const out = {
      date: new Date().toISOString().slice(0, 10),
      generated_at: new Date().toISOString(),
      source: "AeroDataBox via RapidAPI",
      airport: AIRPORT_IATA,
      airline_filter: "AA (AAL)",
      window_utc: { from: isoMin(from), to: isoMin(to) },
      flights
    };

    const dir = path.join(process.cwd(), "data", "aa-phx");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(dir, `${out.date}.json`), JSON.stringify(out, null, 2));
    console.log(`Saved ${flights.length} rows to data/aa-phx/latest.json`);
  } catch (e) {
    console.error("pull_aa_phx_adb failed:", e.message);
    process.exit(2);
  }
})();
