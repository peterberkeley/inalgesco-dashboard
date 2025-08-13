// .github/scripts/pull_aa_phx_adb.js
// Pull live AA flights at PHX via AeroDataBox (RapidAPI) and write site JSON.

const fs = require("fs");
const path = require("path");

const RAPID_KEY = process.env.RAPIDAPI_KEY;
if (!RAPID_KEY) { console.error("Missing RAPIDAPI_KEY"); process.exit(1); }

const ICAO = "KPHX";
const AIRLINE_IATA = "AA";   // American
const AIRLINE_ICAO = "AAL";

// Build a UTC time window: last 2h .. next 18h (covers most of the day)
const now = new Date();
const from = new Date(now.getTime() - 2 * 3600 * 1000);
const to   = new Date(now.getTime() + 18 * 3600 * 1000);
const isoMin = d => d.toISOString().slice(0,16);  // YYYY-MM-DDTHH:MM

const url =
  `https://aerodatabox.p.rapidapi.com/flights/airports/icao/${ICAO}/${isoMin(from)}/${isoMin(to)}` +
  `?withLeg=true&direction=Both&withCancelled=true&withCodeshared=true&withCargo=false`;

const headers = {
  "X-RapidAPI-Key": RAPID_KEY,
  "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com"
};

const toSec = iso => {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

const apId = ap => ap?.iata || ap?.icao || null;

const isAA = f => {
  const opIata = f?.airline?.iata || f?.operator?.iata || "";
  const opIcao = f?.airline?.icao || f?.operator?.icao || "";
  const ident  = f?.flight?.iata || f?.flight?.icao || f?.number || "";
  return opIata === AIRLINE_IATA || opIcao === AIRLINE_ICAO || String(ident).startsWith("AA");
};

function mapRow(f, type){
  const dep = f.departure || {};
  const arr = f.arrival   || {};
  const ac  = f.aircraft  || {};

  // prefer *Utc props if present, else local/unsuffixed
  const schedISO = type === "DEP" ? (dep.scheduledTimeUtc || dep.scheduledTime) : (arr.scheduledTimeUtc || arr.scheduledTime);
  const estISO   = type === "DEP" ? (dep.estimatedTimeUtc || dep.estimatedTime) : (arr.estimatedTimeUtc || arr.estimatedTime);
  const actISO   = type === "DEP" ? (dep.actualTimeUtc    || dep.actualTime)    : (arr.actualTimeUtc    || arr.actualTime);

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

(async ()=>{
  try{
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`.slice(0,300));
    const js = await res.json();

    const arrivals   = Array.isArray(js.arrivals)   ? js.arrivals   : [];
    const departures = Array.isArray(js.departures) ? js.departures : [];

    const aaArr = arrivals.filter(isAA).map(f => mapRow(f, "ARR"));
    const aaDep = departures.filter(isAA).map(f => mapRow(f, "DEP"));

    const flights = [...aaArr, ...aaDep]
      .filter(r => r.sched || r.est || r.actual)   // keep rows with some timing
      .sort((a,b) => (a.actual||a.est||a.sched||0) - (b.actual||b.est||b.sched||0));

    const out = {
      date: new Date().toISOString().slice(0,10),
      generated_at: new Date().toISOString(),
      source: "AeroDataBox via RapidAPI",
      flights
    };

    const dir = path.join(process.cwd(), "data", "aa-phx");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(dir, `${out.date}.json`), JSON.stringify(out, null, 2));
    console.log(`Saved ${flights.length} AA flights.`);
  } catch (e) {
    console.error("pull_aa_phx_adb failed:", e.message);
    process.exit(2);
  }
})();
