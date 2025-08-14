// Fetch live American Airlines flights at PHX from AeroDataBox (RapidAPI)
// Write to: data/aa-phx/latest.json and data/aa-phx/YYYY-MM-DD.json
// Requires: repo Secret RAPIDAPI_KEY

const fs = require("node:fs");
const path = require("node:path");

const RAPID_KEY = process.env.RAPIDAPI_KEY;
if (!RAPID_KEY) {
  console.error("Missing RAPIDAPI_KEY secret");
  process.exit(1);
}

const ICAO = "KPHX";
const IATA = "PHX";
const BASE_HOST = "aerodatabox.p.rapidapi.com";
const BASE = `https://${BASE_HOST}`;

const H = {
  "X-RapidAPI-Key": RAPID_KEY,
  "X-RapidAPI-Host": BASE_HOST,
  "Accept": "application/json"
};

// ---------- small utils ----------
const isoMin = d => d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
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
  const num    = (f?.flight?.iata || f?.flight?.icao || f?.number || f?.callSign || "").toUpperCase();
  const shares = []
    .concat(Array.isArray(f?.codeshares) ? f.codeshares : [])
    .concat(Array.isArray(f?.codeshared) ? f.codeshared : [])
    .concat(f?.codeshared?.flight?.iata ? [f.codeshared.flight.iata] : [])
    .map(x => String(x).toUpperCase());
  const hasAAshare = shares.some(cs => cs.startsWith("AA"));
  return opIata === "AA" || opIcao === "AAL" || num.startsWith("AA") || hasAAshare;
};

function mapRow(f, type) {
  const dep = f.departure || {};
  const arr = f.arrival   || {};
  const ac  = f.aircraft  || {};

  const getUtc = (seg, key) => seg?.[key]?.utc || seg?.[key]?.local || null;

  const schedISO = type === "DEP" ? getUtc(dep, "scheduledTime") : getUtc(arr, "scheduledTime");
  const estISO   = type === "DEP"
    ? (getUtc(dep, "revisedTime") || getUtc(dep, "estimatedTime"))
    : (getUtc(arr, "revisedTime") || getUtc(arr, "estimatedTime"));
  const actISO   = type === "DEP"
    ? (getUtc(dep, "runwayTime")  || getUtc(dep, "actualTime"))
    : (getUtc(arr, "runwayTime")  || getUtc(arr, "actualTime"));

  const terminal = (type === "DEP" ? dep.terminal : arr.terminal) ?? dep.terminal ?? arr.terminal ?? null;
  const gate     = (type === "DEP" ? dep.gate     : arr.gate)     ?? dep.gate     ?? arr.gate     ?? null;

  const flightId = (f.number || f.flight?.iata || f.flight?.icao || f.callSign || "").toString().replace(/\s+/g, "");

  return {
    type,
    flight: flightId,
    reg: ac.registration || ac.reg || null,
    origin: apId(dep.airport),
    destination: apId(arr.airport),
    terminal,
    gate,
    sched:  toSec(schedISO),
    est:    toSec(estISO),
    actual: toSec(actISO),
    status: f.status || f.statusText || ""
  };
}

async function getJson(url) {
  const res = await fetch(url, { headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`JSON parse error: ${e.message} :: ${text.slice(0, 200)}`);
  }
}

// Prefer the record that has more detail (gate/reg/times)
function better(a, b, type) {
  if (!a) return b;
  if (!b) return a;
  const score = r =>
    (r?.departure?.gate || r?.arrival?.gate ? 4 : 0) +
    (r?.aircraft?.reg || r?.aircraft?.registration ? 3 : 0) +
    (r?.status ? 1 : 0) +
    (type === "DEP"
      ? (r?.departure?.runwayTime?.utc || r?.departure?.estimatedTime?.utc || r?.departure?.revisedTime?.utc ? 1 : 0)
      : (r?.arrival?.runwayTime?.utc   || r?.arrival?.estimatedTime?.utc   || r?.arrival?.revisedTime?.utc   ? 1 : 0)
    );
  return score(a) >= score(b) ? a : b;
}

// ---------- main ----------
(async () => {
  try {
    const now = new Date();
    const PAST_HOURS   = 2;   // look 2h back
    const WINDOW_HOURS = 12;  // 12h span (API hard limit)
    const from = new Date(now.getTime() - PAST_HOURS * 3600 * 1000);
    const to   = new Date(from.getTime() + WINDOW_HOURS * 3600 * 1000);

    // Query BOTH feeds, then merge:
    const urlIata =
      `${BASE}/flights/airports/iata/${IATA}`
      + `?offsetMinutes=-${PAST_HOURS*60}&durationMinutes=${WINDOW_HOURS*60}`
      + `&direction=Both&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=true`;

    const urlIcao =
      `${BASE}/flights/airports/icao/${ICAO}`
      + `?offsetMinutes=-${PAST_HOURS*60}&durationMinutes=${WINDOW_HOURS*60}`
      + `&direction=Both&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=true&withLocation=true`;

    console.log("Requesting:", urlIata);
    const jsIata = await getJson(urlIata);
    console.log("Requesting:", urlIcao);
    const jsIcao = await getJson(urlIcao);

    // Build a keyed map and keep the richer record per flight/time
    const byKey = (arr, type) => {
      const map = new Map();
      for (const f of arr || []) {
        // key by type + squashed flight number + scheduled time (UTC) to reduce collisions
        const num = (f.number || f.flight?.iata || f.callSign || "").toString().replace(/\s+/g, "");
        const sched = type === "DEP"
          ? (f?.departure?.scheduledTime?.utc || f?.departure?.scheduledTime || "")
          : (f?.arrival?.scheduledTime?.utc   || f?.arrival?.scheduledTime   || "");
        const k = `${type}|${num}|${sched}`;
        const current = map.get(k);
        map.set(k, better(current, f, type));
      }
      return map;
    };

    const depMap = byKey([...(jsIata.departures||[]), ...(jsIcao.departures||[])], "DEP");
    const arrMap = byKey([...(jsIata.arrivals||[]),   ...(jsIcao.arrivals||[])],   "ARR");

    // Flatten back out and AA-filter
    let deps = Array.from(depMap.values()).filter(isAA);
    let arrs = Array.from(arrMap.values()).filter(isAA);

    console.log(`Merged AA rows → ARR ${arrs.length} + DEP ${deps.length}`);

    // Map to compact rows
    let flights = [
      ...arrs.map(f => mapRow(f, "ARR")),
      ...deps.map(f => mapRow(f, "DEP")),
    ]
    .filter(r => r.sched || r.est || r.actual)  // need some time
    .sort((a, b) => (a.actual || a.est || a.sched || 0) - (b.actual || b.est || b.sched || 0));

    // If still zero, dump all carriers for inspection (shouldn’t happen often)
    if (flights.length === 0) {
      const all = [
        ...Array.from(arrMap.values()).map(f => mapRow(f, "ARR")),
        ...Array.from(depMap.values()).map(f => mapRow(f, "DEP")),
      ].filter(r => r.sched || r.est || r.actual);
      console.log(`AA-filter empty; writing ALL carriers (${all.length}) for debugging`);
      flights = all.sort((a,b)=>(a.actual||a.est||a.sched||0)-(b.actual||b.est||b.sched||0));
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

    // Keep the raw of the second source for debugging (optional)
    try {
      fs.writeFileSync(path.join(dir, "_last_raw_iata.json"), JSON.stringify(jsIata, null, 2));
      fs.writeFileSync(path.join(dir, "_last_raw_icao.json"), JSON.stringify(jsIcao, null, 2));
    } catch {}

    console.log(`Saved ${flights.length} rows to data/aa-phx/latest.json`);
  } catch (e) {
    console.error("pull_aa_phx_adb failed:", e.message);
    process.exit(2);
  }
})();
