// .github/scripts/pull_aa_phx_adb.js
// Fetch live American Airlines flights at PHX from AeroDataBox (RapidAPI)
// and write them to: data/aa-phx/latest.json  (+ a dated copy)
// Requires GitHub Actions secret: RAPIDAPI_KEY

const fs = require("node:fs");
const path = require("node:path");

const RAPID_KEY = process.env.RAPIDAPI_KEY;
if (!RAPID_KEY) {
  console.error("Missing RAPIDAPI_KEY environment secret.");
  process.exit(1);
}

const BASE_HOST = "aerodatabox.p.rapidapi.com";
const BASE_URL  = `https://${BASE_HOST}`;
const ICAO      = "KPHX";        // Phoenix
const AIRLINE_IATA = "AA";       // American Airlines
const AIRLINE_ICAO = "AAL";

// ---- helpers ---------------------------------------------------------------

const isoMin = d => d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM (UTC, no seconds)

// Parse ISO or "YYYY-MM-DD HH:mm" safely -> epoch seconds (UTC)
const toSec = s => {
  if (!s) return null;
  let t = Date.parse(s);
  if (!Number.isFinite(t) && typeof s === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) {
    t = Date.parse(s.replace(" ", "T") + ":00Z");
  }
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

const apId = ap => (ap?.iata || ap?.icao || null);

const isAA = f => {
  const opIata = (f?.airline?.iata || f?.operator?.iata || "").toUpperCase();
  const opIcao = (f?.airline?.icao || f?.operator?.icao || "").toUpperCase();
  const num    = (f?.flight?.iata || f?.flight?.icao || f?.number || "").toUpperCase();

  // Codeshares sometimes come as array or nested object
  const codeshares = []
    .concat(Array.isArray(f?.codeshares) ? f.codeshares : [])
    .concat(Array.isArray(f?.codeshared) ? f.codeshared : [])
    .concat(f?.codeshared?.flight?.iata ? [f.codeshared.flight.iata] : [])
    .map(x => String(x).toUpperCase());

  const hasAAshare = codeshares.some(cs => cs.startsWith("AA"));

  return opIata === AIRLINE_IATA || opIcao === AIRLINE_ICAO || num.startsWith("AA") || hasAAshare;
};

function mapRow(f, type) {
  const dep = f.departure || {};
  const arr = f.arrival   || {};
  const ac  = f.aircraft  || {};

  const schedISO = type === "DEP"
    ? (dep.scheduledTimeUtc || dep.scheduledTime || dep.scheduledTimeLocal)
    : (arr.scheduledTimeUtc || arr.scheduledTime || arr.scheduledTimeLocal);
  const estISO = type === "DEP"
    ? (dep.estimatedTimeUtc || dep.estimatedTime || dep.estimatedTimeLocal)
    : (arr.estimatedTimeUtc || arr.estimatedTime || arr.estimatedTimeLocal);
  const actISO = type === "DEP"
    ? (dep.actualTimeUtc || dep.actualTime || dep.actualTimeLocal)
    : (arr.actualTimeUtc || arr.actualTime || arr.actualTimeLocal);

  return {
    type, // "ARR" | "DEP"
    flight: f.flight?.iata || f.flight?.icao || f.number || "",
    reg: ac.registration || ac.reg || null,
    origin: apId(dep.airport),
    destination: apId(arr.airport),
    terminal: (type === "DEP" ? dep.terminal : arr.terminal) ?? null,
    gate:     (type === "DEP" ? dep.gate     : arr.gate)     ?? null,
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
      const text = await res.text(); // read once
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`JSON parse error: ${e.message} :: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      lastErr = e;
      const backoff = 500 * i;
      console.warn(`Attempt ${i} failed: ${e.message} — retrying in ${backoff}ms`);
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// ---- build request window (<= 12h span per API limit) ----------------------

const now = new Date();
const PAST_HOURS   = 2;
const WINDOW_HOURS = 12; // hard limit
const from = new Date(now.getTime() - PAST_HOURS * 3600 * 1000);
const to   = new Date(from.getTime() + WINDOW_HOURS * 3600 * 1000);

const url =
  `${BASE_URL}/flights/airports/icao/${ICAO}/${isoMin(from)}/${isoMin(to)}` +
  `?withLeg=true&direction=Both&withCancelled=true&withCodeshared=true&withCargo=false`;

const headers = {
  "X-RapidAPI-Key": RAPID_KEY,
  "X-RapidAPI-Host": BASE_HOST,
  "Accept": "application/json"
};

// ---- main ------------------------------------------------------------------

(async () => {
  try {
    console.log("Requesting:", url);
    const js = await fetchWithRetry(url, headers);

    const arrivals   = Array.isArray(js.arrivals)   ? js.arrivals   : [];
    const departures = Array.isArray(js.departures) ? js.departures : [];
    console.log(`ADB returned ${arrivals.length} arrivals + ${departures.length} departures`);

    let aaArr = arrivals.filter(isAA);
    let aaDep = departures.filter(isAA);
    console.log(`Filtered AA: ${aaArr.length} arrivals, ${aaDep.length} departures`);

    let flights = [...aaArr.map(f => mapRow(f, "ARR")), ...aaDep.map(f => mapRow(f, "DEP"))]
      .filter(r => r.sched || r.est || r.actual)
      .sort((a, b) => (a.actual || a.est || a.sched || 0) - (b.actual || b.est || b.sched || 0));

    // Optional visibility fallback: if AA filter produced zero rows, write all carriers
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
      airport: "PHX",
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
