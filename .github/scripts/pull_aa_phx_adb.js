// .github/scripts/pull_aa_phx_adb.js
// Fetch live American Airlines flights at PHX from AeroDataBox (RapidAPI)
// Write to data/aa-phx/latest.json (+ dated copy)
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
const HOME_IATA = "PHX";
const AIRLINE_IATA = "AA";
const AIRLINE_ICAO = "AAL";

// helpers
const isoMin = d => d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM (UTC)
const toSec = s => {
  if (!s) return null;
  let t = Date.parse(s);
  if (!Number.isFinite(t) && typeof s === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    t = Date.parse(s.replace(" ", "T") + ":00Z");
  }
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const apId = ap => (ap?.iata || ap?.icao || null);
const normalizeGate = g => {
  if (!g) return null;
  return String(g).toUpperCase().trim().replace(/^GATE\s+/, "");
};

// Tighter AA filter (operator OR flight number OR codeshare containing AA)
const isAA = (f) => {
  const opIata = (f?.airline?.iata || f?.operator?.iata || "").toUpperCase();
  const opIcao = (f?.airline?.icao || f?.operator?.icao || "").toUpperCase();

  const nums = []
    .concat(f?.number || [])
    .concat(f?.callSign || [])
    .concat(f?.flight?.iata || [])
    .concat(f?.flight?.icao || [])
    .map(x => String(x).toUpperCase().replace(/\s+/g, ""));

  // Some responses don’t expose explicit codeshare arrays, so number prefix is the safest
  const aaNumber = nums.some(n => n.startsWith("AA"));

  return opIata === AIRLINE_IATA || opIcao === AIRLINE_ICAO || aaNumber;
};

function mapRow(f, type) {
  const dep = f.departure || {};
  const arr = f.arrival   || {};
  const ac  = f.aircraft  || {};

  // FIDS-style nested times
  const getUtc = (seg, key) => seg?.[key]?.utc || seg?.[key]?.local || null;

  const schedISO = type === "DEP" ? getUtc(dep, "scheduledTime") : getUtc(arr, "scheduledTime");
  const estISO   = type === "DEP" ? (getUtc(dep, "revisedTime")  || getUtc(dep, "estimatedTime"))
                                  : (getUtc(arr, "revisedTime")  || getUtc(arr, "estimatedTime"));
  const actISO   = type === "DEP" ? (getUtc(dep, "runwayTime")   || getUtc(dep, "actualTime"))
                                  : (getUtc(arr, "runwayTime")   || getUtc(arr, "actualTime"));

  // Terminal & gate (prefer the side we’re rendering; fall back to other side)
  let terminal = (type === "DEP" ? dep.terminal : arr.terminal) ?? dep.terminal ?? arr.terminal ?? null;
  let gate     = normalizeGate((type === "DEP" ? dep.gate : arr.gate) || dep.gate || arr.gate);

  // Local PHX rules: AA uses T4 → default to "4" if missing
  if (!terminal && isAA(f)) terminal = "4";

  // Origin/Destination fill to PHX if missing (based on side)
  const origin      = apId(dep.airport) || (type === "DEP" ? HOME_IATA : null);
  const destination = apId(arr.airport) || (type === "ARR" ? HOME_IATA : null);

  // Flight id: prefer published "number" (e.g., "AA 123") squashed to "AA123"
  const flightId = (f.number || f.callSign || f?.flight?.iata || f?.flight?.icao || "")
    .toString().replace(/\s+/g, "");

  return {
    type, // ARR | DEP
    flight: flightId,
    reg: ac.registration || ac.reg || null,
    origin,
    destination,
    terminal,
    gate,
    sched:  toSec(schedISO),
    est:    toSec(estISO),
    actual: toSec(actISO),
    status: f.status || f.statusText || ""
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

// request window (<=12h hard limit)
const now = new Date();
const PAST_HOURS   = 2;
const WINDOW_HOURS = 12;
const from = new Date(now.getTime() - PAST_HOURS * 3600 * 1000);
const to   = new Date(from.getTime() + WINDOW_HOURS * 3600 * 1000);

// IATA endpoint tends to carry better FIDS-like fields
const url =
  `${BASE_URL}/flights/airports/iata/${HOME_IATA}` +
  `?offsetMinutes=-${PAST_HOURS*60}&durationMinutes=${WINDOW_HOURS*60}` +
  `&direction=Both&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=true`;

const headers = {
  "X-RapidAPI-Key": RAPID_KEY,
  "X-RapidAPI-Host": BASE_HOST,
  "Accept": "application/json"
};

(async () => {
  try {
    console.log("Requesting:", url);
    const js = await fetchWithRetry(url, headers);

    // Debug raw (helps when ADB fields change)
    try {
      const dbgDir = path.join(process.cwd(), "data", "aa-phx");
      fs.mkdirSync(dbgDir, { recursive: true });
      fs.writeFileSync(path.join(dbgDir, "_last_raw.json"), JSON.stringify(js, null, 2));
    } catch {}

    const arrivals   = Array.isArray(js.arrivals)   ? js.arrivals   : [];
    const departures = Array.isArray(js.departures) ? js.departures : [];

    let aaArr = arrivals.filter(isAA);
    let aaDep = departures.filter(isAA);

    // Map + sort
    let flights = [
      ...aaArr.map(f => mapRow(f, "ARR")),
      ...aaDep.map(f => mapRow(f, "DEP"))
    ]
      .filter(r => r.sched || r.est || r.actual)
      .sort((a, b) => (a.actual || a.est || a.sched || 0) - (b.actual || b.est || b.sched || 0));

    const out = {
      date: new Date().toISOString().slice(0, 10),
      generated_at: new Date().toISOString(),
      source: "AeroDataBox via RapidAPI",
      airport: HOME_IATA,
      airline_filter: "AA (AAL)",
      window_utc: { from: isoMin(from), to: isoMin(to) },
      flights
    };

    const dir = path.join(process.cwd(), "data", "aa-phx");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(dir, `${out.date}.json`), JSON.stringify(out, null, 2));

    console.log(`Saved ${flights.length} AA rows to data/aa-phx/latest.json`);
  } catch (e) {
    console.error("pull_aa_phx_adb failed:", e.message);
    process.exit(2);
  }
})();
