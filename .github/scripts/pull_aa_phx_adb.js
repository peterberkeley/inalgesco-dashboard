// .github/scripts/pull_aa_phx_adb.js
// Fetch live AA at PHX from AeroDataBox (RapidAPI) -> data/aa-phx/latest.json (+ dated)
// Requires RAPIDAPI_KEY (GitHub secret)

const fs = require("node:fs");
const path = require("node:path");

const RAPID_KEY = process.env.RAPIDAPI_KEY;
if (!RAPID_KEY) { console.error("Missing RAPIDAPI_KEY"); process.exit(1); }

const BASE_HOST = "aerodatabox.p.rapidapi.com";
const BASE_URL  = `https://${BASE_HOST}`;
const HOME_IATA = "PHX";
const AIRLINE_IATA = "AA";
const AIRLINE_ICAO = "AAL";

// --- helpers -------------------------------------------------
const isoMin = d => d.toISOString().slice(0,16);
const toSec = s => {
  if (!s) return null;
  let t = Date.parse(s);
  if (!Number.isFinite(t) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(s))) {
    t = Date.parse(String(s).replace(" ", "T") + ":00Z");
  }
  return Number.isFinite(t) ? Math.floor(t/1000) : null;
};
const apId = ap => (ap?.iata || ap?.icao || null);
const normalizeGate = g => g ? String(g).toUpperCase().trim().replace(/^GATE\s+/, "") : null;
const phxDate = (sec) => {
  const d = new Date((sec ?? Date.now()/1000) * 1000);
  const y = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',year:'numeric'}).format(d);
  const m = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',month:'2-digit'}).format(d);
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/Phoenix',day:'2-digit'}).format(d);
  return `${y}-${m}-${day}`;
};

const isAA = f => {
  const opIata = (f?.airline?.iata || f?.operator?.iata || "").toUpperCase();
  const opIcao = (f?.airline?.icao || f?.operator?.icao || "").toUpperCase();
  const nums = []
    .concat(f?.number || [])
    .concat(f?.callSign || [])
    .concat(f?.flight?.iata || [])
    .concat(f?.flight?.icao || [])
    .map(x => String(x).toUpperCase().replace(/\s+/g,""));
  const aaNumber = nums.some(n => n.startsWith("AA"));
  return opIata === AIRLINE_IATA || opIcao === AIRLINE_ICAO || aaNumber;
};

function mapRow(f, type){
  const dep = f.departure || {};
  const arr = f.arrival || {};
  const ac  = f.aircraft || {};
  const getUtc = (seg, key) => seg?.[key]?.utc || seg?.[key]?.local || null;

  const schedISO = type === "DEP" ? getUtc(dep, "scheduledTime") : getUtc(arr, "scheduledTime");
  const estISO   = type === "DEP" ? (getUtc(dep, "revisedTime")  || getUtc(dep, "estimatedTime"))
                                  : (getUtc(arr, "revisedTime")  || getUtc(arr, "estimatedTime"));
  const actISO   = type === "DEP" ? (getUtc(dep, "runwayTime")   || getUtc(dep, "actualTime"))
                                  : (getUtc(arr, "runwayTime")   || getUtc(arr, "actualTime"));

  let terminal = (type === "DEP" ? dep.terminal : arr.terminal) ?? dep.terminal ?? arr.terminal ?? null;
  let gate     = normalizeGate((type === "DEP" ? dep.gate : arr.gate) || dep.gate || arr.gate);

  if (!terminal) terminal = "4"; // PHX local rule for AA

  const origin      = apId(dep.airport) || (type === "DEP" ? HOME_IATA : null);
  const destination = apId(arr.airport) || (type === "ARR" ? HOME_IATA : null);

  const flightId = (f.number || f.callSign || f?.flight?.iata || f?.flight?.icao || "")
    .toString().replace(/\s+/g,"");

  return {
    type,
    flight: flightId,
    reg: ac.registration || ac.reg || null,
    origin, destination,
    terminal, gate,
    sched:  toSec(schedISO),
    est:    toSec(estISO),
    actual: toSec(actISO),
    status: f.status || f.statusText || ""
  };
}

async function fetchJson(url){
  const headers = { "X-RapidAPI-Key": RAPID_KEY, "X-RapidAPI-Host": BASE_HOST, "Accept":"application/json" };
  const res = await fetch(url, { headers });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${txt.slice(0,300)}`);
  try { return JSON.parse(txt); } catch(e) { throw new Error(`JSON parse error: ${e.message}`); }
}

// Backfill reg/gate using "Flight status (specific date)"
async function backfillMissing(rows){
  const need = rows.filter(r => !r.reg || !r.gate);
  if (need.length === 0) return rows;

  // De-dupe by flight code + date; limit calls to respect quota
  const seen = new Set();
  const tasks = [];
  const BACKFILL_LIMIT = 20; // keep this small for free/low plans
  for (const r of need){
    const code = (r.flight || "").toUpperCase();
    if (!/^AA\d+/.test(code)) continue;
    const dateStr = phxDate(r.sched || r.est || r.actual || Math.floor(Date.now()/1000));
    const key = `${code}|${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const url = `${BASE_URL}/flights/number/${encodeURIComponent(code)}/${dateStr}`;
    tasks.push({ key, url });
    if (tasks.length >= BACKFILL_LIMIT) break;
  }
  const details = new Map();
  for (const t of tasks){
    try{
      const js = await fetchJson(t.url); // usually an array
      if (Array.isArray(js) && js.length){
        // prefer record where PHX is either departure or arrival
        const match = js.find(x => x?.departure?.airport?.iata === HOME_IATA || x?.arrival?.airport?.iata === HOME_IATA) || js[0];
        details.set(t.key, match);
      }
      // polite pace to avoid spikes
      await new Promise(r => setTimeout(r, 200));
    }catch(e){
      console.warn("Backfill failed:", t.url, e.message);
    }
  }

  // apply enrichments
  rows.forEach(r=>{
    const code = (r.flight || "").toUpperCase();
    if (!/^AA\d+/.test(code)) return;
    const dateStr = phxDate(r.sched || r.est || r.actual || Math.floor(Date.now()/1000));
    const k = `${code}|${dateStr}`;
    const d = details.get(k);
    if (!d) return;

    const dep = d.departure || {};
    const arr = d.arrival || {};
    if (!r.reg) {
      r.reg = d?.aircraft?.registration || d?.aircraft?.reg || r.reg || null;
    }
    if (!r.gate) {
      const g = r.type === "DEP" ? dep.gate : arr.gate;
      r.gate = normalizeGate(g) || r.gate || null;
    }
  });

  return rows;
}

// --- main ---------------------------------------------------
(async ()=>{
  try{
    const now = new Date();
    const PAST_HOURS = 2, WINDOW_HOURS = 12;
    const from = new Date(now.getTime() - PAST_HOURS*3600*1000);
    const to   = new Date(from.getTime() + WINDOW_HOURS*3600*1000);

    const url =
      `${BASE_URL}/flights/airports/iata/${HOME_IATA}` +
      `?offsetMinutes=-${PAST_HOURS*60}&durationMinutes=${WINDOW_HOURS*60}` +
      `&direction=Both&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=true`;

    const js = await fetchJson(url);

    // debug raw (optional)
    try {
      const dbgDir = path.join(process.cwd(), "data", "aa-phx");
      fs.mkdirSync(dbgDir, { recursive: true });
      fs.writeFileSync(path.join(dbgDir, "_last_raw.json"), JSON.stringify(js, null, 2));
    } catch {}

    const arrivals   = Array.isArray(js.arrivals)   ? js.arrivals   : [];
    const departures = Array.isArray(js.departures) ? js.departures : [];

    let flights = [
      ...arrivals.filter(isAA).map(f => mapRow(f, "ARR")),
      ...departures.filter(isAA).map(f => mapRow(f, "DEP")),
    ].filter(r => r.sched || r.est || r.actual)
     .sort((a,b)=>(a.actual||a.est||a.sched||0)-(b.actual||b.est||b.sched||0));

    // backfill reg/gate where missing (limited)
    flights = await backfillMissing(flights);

    const out = {
      date: new Date().toISOString().slice(0,10),
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
    console.log(`Saved ${flights.length} AA rows`);
  }catch(e){
    console.error("pull_aa_phx_adb failed:", e.message);
    process.exit(2);
  }
})();
