//Part 1
let _maintenanceLogged = false;

/* =================== Config =================== */
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";   // devices via v2.0
const UBIDOTS_V1   = "https://industrial.api.ubidots.com/api/v1.6";   // variables via v1.6 (CORS-safe)

let REFRESH_INTERVAL = 15_000;      // poll live every 15s
let HIST_POINTS      = 60;          // default points on charts (newest on the right, corresponds to 1h)
const ONLINE_WINDOW_SEC = 300;      // online if seen within last 5 minutes
const USE_V16_HEARTBEAT_FALLBACK = false;  // TEMP: dropdown uses devices v2 only
const USE_V2_BULK = false;                 // browser CORS: disable v2 fetches

const FORCE_VARCACHE_REFRESH = false;      // set true only if debugging var-id mismatches
const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981", "#f97316"];

/* =================== State =================== */
let SENSORS = [];                   // [{address,label,calibration,chart,col},...]
let variableCache = {};             // per-device map: label -> varId (v1.6)
let sensorMapConfig = {};           // admin mapping/config from Ubidots (context)
let aliasMap = {};                  // friendly display names per truck label

// Breadcrumb route configuration
const SEGMENT_COLORS = [
  "#dc2626", "#16a34a", "#2563eb", "#eab308", "#8b5cf6", "#f97316", "#000000"
];

// Selected time window in minutes for breadcrumbs and chart history.
let selectedRangeMinutes = 60;
let selectedRangeMode = "range";

// Arrays for Leaflet polylines and markers
let segmentPolylines = [];
let segmentMarkers = [];
let legendControl = null;
let __crumbToken = 0;   // cancels stale breadcrumb run
let __crumbAbort = null; // AbortController for breadcrumbs

// holds the most recent devices context so the CSV click handler can resolve deviceID
window.__deviceMap = {};
// Prevent overlapping updateCharts() runs
let __chartsInFlight = false;
let __chartsQueued   = false;

// Prevent overlapping updateAll() runs (timer + device change, etc.)
let __updateInFlight = false;
let __updateQueued   = false;



/* =================== Helpers =================== */
function onReady(fn){
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(fn,1);
  else document.addEventListener("DOMContentLoaded", fn);
}
const fmt = (v,p=1)=>(v==null||isNaN(v))?"–":(+v).toFixed(p);
// Fast HH:MM formatter with per-timezone Intl cache
const __dtfCache = {};
const __tzCache = {};  // deviceLabel -> IANA tz
function fmtTimeHHMM(ts, tz='Europe/London'){
  let fmt = __dtfCache[tz];
  if (!fmt){
    fmt = __dtfCache[tz] = new Intl.DateTimeFormat('en-GB', {
      hour:'2-digit', minute:'2-digit', hour12:false, timeZone: tz
    });
  }
  return fmt.format(ts);
}


// Get the *displayed* name seen on the dashboard for a given device label
function getDisplayName(deviceLabel){
  // Always check the __aliases sub-object first (most up-to-date)
  const alias =
    (sensorMapConfig.__aliases && sensorMapConfig.__aliases[deviceLabel]) ||
    (aliasMap && aliasMap[deviceLabel]);
  if (alias && typeof alias === 'string' && alias.trim()) return alias.trim();

  // Fallbacks
  const confLabel = sensorMapConfig[deviceLabel]?.label;
  if (confLabel && typeof confLabel === 'string' && confLabel.trim()) return confLabel.trim();

  return deviceLabel;
}

/* =================== Timezone helpers =================== */
/* Rule:
 * 1) If admin set sensorMapConfig[deviceLabel].tz (IANA), use it.
 * 2) Else auto-lookup with tz-lookup (loaded once from unpkg).
 * 3) Else fallback to 'Europe/London'.
 */
let __tzLoadPromise = null;
function loadTzLookup(){
  if (window.tzlookup) return Promise.resolve(true);
  if (__tzLoadPromise) return __tzLoadPromise;
  __tzLoadPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/tz-lookup@6.1.25/tz.js';
    s.async = true;
    s.onload = () => res(true);
    s.onerror = (e) => { console.warn('tz-lookup load failed', e); res(false); };
    document.head.appendChild(s);
  });
  return __tzLoadPromise;
}
async function resolveDeviceTz(deviceLabel, lat, lon){
  // Fast path: cached tz for this device
  if (__tzCache[deviceLabel]) return __tzCache[deviceLabel];

  // Admin override
  const adminTz = sensorMapConfig?.[deviceLabel]?.tz;
  if (adminTz && typeof adminTz === 'string') {
    __tzCache[deviceLabel] = adminTz;
    return adminTz;
  }

  // Try tz-lookup if we have coords
  if (typeof lat === 'number' && isFinite(lat) && typeof lon === 'number' && isFinite(lon)){
    try{
      if (window.tzlookup || await loadTzLookup()){
        const tz = window.tzlookup(lat, lon); // IANA, DST-aware
        __tzCache[deviceLabel] = tz;          // <-- cache it
        return tz;
      }
    }catch(e){ console.warn('tzlookup failed', e); }
  }

  // Fallback: cache and return default
  return (__tzCache[deviceLabel] = 'Europe/London');
}

/* =================== Admin mapping (context) =================== */
async function fetchSensorMapMapping(){
  try{
    const res = await fetch(`${UBIDOTS_V1}/devices/config/sensor_map/values?page_size=1&_=${Date.now()}&token=${UBIDOTS_ACCOUNT_TOKEN}`);
    const js  = await res.json();
    sensorMapConfig = (js.results?.[0]?.context) || {};
    aliasMap        = sensorMapConfig.__aliases || {};
  }catch(e){
    console.error("Failed to fetch sensor_map:", e);
    sensorMapConfig = {};
    aliasMap = {};
  }
}

/* =================== Devices (v2.0) =================== */
async function fetchSensorMapConfig(){
  try{
    const res = await fetch(`${UBIDOTS_BASE}/devices/?page_size=1000`, {
      headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if(!res.ok) throw new Error(`Failed to fetch devices (${res.status})`);

    const js = await res.json();
    const context = {};

    (js.results || []).forEach(dev => {
      const label = (dev.label || "").trim();
      const name  = (dev.name  || "").trim();
      const key   = label || name;
      if (!key) return;

      const isSkyCafe = (label && label.startsWith("skycafe-")) ||
                        (name  && name.toLowerCase().includes("skycafe"));
      if (!isSkyCafe) return;

      // robust last_seen parser (number or string; seconds or ms)
      let raw = dev.lastActivity ?? dev.last_activity ?? dev.last_seen ?? dev.lastSeen ?? null;
      let lastMs = 0;
      if (typeof raw === "number") {
        lastMs = raw > 1e12 ? raw : raw * 1000;
      } else if (typeof raw === "string" && raw) {
        const n = Number(raw);
        if (!Number.isNaN(n)) lastMs = n > 1e12 ? n : n * 1000;
        else {
          const p = Date.parse(raw);
          if (!Number.isNaN(p)) lastMs = p;
        }
      }

      const id = dev.id || dev._id || dev["$id"];
      const display = name || (label ? label.replace(/^skycafe-/i, "SkyCafé ") : key);

      context[key] = {
        label: display,
        last_seen: Math.floor((lastMs || 0) / 1000),
        id
      };
    });

    return context;
  }catch(err){
    console.error("Failed to fetch device list:", err);
    return {};
  }
}

/* =================== Device dropdown (GLOBAL) =================== */
function buildDeviceDropdownFromConfig(sensorMap){
  const sel = document.getElementById("deviceSelect");
  if (!sel) return;
  const prev = sel.value;
  const now = Math.floor(Date.now()/1000);
  sel.innerHTML = "";

  const entries = Object.entries(sensorMap)
    .sort(([a],[b]) => parseInt(a.replace("skycafe-",""),10)-parseInt(b.replace("skycafe-",""),10));

  entries.forEach(([dev,obj])=>{
    const isOnline = (now - (obj.last_seen||0)) < ONLINE_WINDOW_SEC;
    const dot = isOnline ? "🟢" : "⚪️";
    const opt = document.createElement("option");
    opt.value = dev;
    const displayLabel = getDisplayName(dev);
    opt.text  = `${dot} ${displayLabel} (${isOnline?"Online":"Offline"})`;
    sel.appendChild(opt);
  });

  // restore previous, else first Online, else first
  let foundPrev=false;
  for(let i=0; i<sel.options.length; i++){
    if (sel.options[i].value === prev){ sel.selectedIndex = i; foundPrev=true; break; }
  }
  if(!foundPrev){
    for(let i=0; i<sel.options.length; i++){
      if (sel.options[i].text.includes("Online")){ sel.selectedIndex = i; foundPrev=true; break; }
    }
  }
  if(!foundPrev && sel.options.length>0) sel.selectedIndex = 0;
}
// ensure global visibility in Safari/strict modes
window.buildDeviceDropdownFromConfig = buildDeviceDropdownFromConfig;

/* =================== Variables & values (v1.6) =================== */
// Deduplicate concurrent builds per device
const __varCachePromises = (window.__varCachePromises = window.__varCachePromises || {});

async function ensureVarCache(deviceID){
  if (variableCache[deviceID]) return;

  const url = `${UBIDOTS_V1}/variables/?device=${deviceID}&page_size=1000&token=${UBIDOTS_ACCOUNT_TOKEN}`;
  try{
    const rs = await fetch(url);
    if(!rs.ok){ variableCache[deviceID]={}; return; }
    const jl = await rs.json();

    // Fast map: keep the first id we see per label (no /values probing)
    const map = {};
    (jl.results || []).forEach(v => {
      const lab = v.label;
      if (!map[lab]) map[lab] = v.id; // first-seen id
    });

    variableCache[deviceID] = map;
  }catch(e){
    console.error("ensureVarCache", e);
    variableCache[deviceID] = {};
  }
}



async function fetchUbidotsVar(deviceID, varLabel, limit=1){
  try{
    // Fast path: use current mapping
    await ensureVarCache(deviceID);
    let varId = variableCache[deviceID][varLabel];
    if (varId) {
      const fast = await fetch(`${UBIDOTS_V1}/variables/${varId}/values/?page_size=${limit}&token=${UBIDOTS_ACCOUNT_TOKEN}`);
      if (fast.ok) {
        const data = await fast.json();
        const rows = data.results || [];
        if (rows.length) return rows;
      }
    }

    // Lazy duplicate resolution: scan ids for this label only if needed
    const list = await fetch(`${UBIDOTS_V1}/variables/?device=${deviceID}&page_size=1000&token=${UBIDOTS_ACCOUNT_TOKEN}`);
    if (!list.ok) return [];
    const jl = await list.json();
    const ids = (jl.results || []).filter(v => v.label === varLabel).map(v => v.id);

    for (const id of ids) {
      if (id === varId) continue; // already tried
      const r = await fetch(`${UBIDOTS_V1}/variables/${id}/values/?page_size=${limit}&token=${UBIDOTS_ACCOUNT_TOKEN}`);
      if (!r.ok) continue;
      const j = await r.json();
      const rows = j.results || [];
      if (rows.length) {
        // Update mapping to the working id for future calls
        variableCache[deviceID][varLabel] = id;
        return rows;
      }
    }

    // Nothing found
    return [];
  }catch(e){
    console.error("fetchUbidotsVar", e);
    return [];
  }
}

/* =================== GPS variable auto-detect =================== */
const gpsLabelCache = (window.gpsLabelCache = window.gpsLabelCache || {});

async function resolveGpsLabel(deviceID){
  // Return cached result even if it's null (null = "no GPS label; don't rescan")
  if (Object.prototype.hasOwnProperty.call(gpsLabelCache, deviceID)) {
    return gpsLabelCache[deviceID]; // may be string or null
  }

  await ensureVarCache(deviceID);
  const labels = Object.keys(variableCache[deviceID] || {});

  // Try common names first, then scan everything
  const preferred = ['gps','position','location'];
  const order = preferred.concat(labels.filter(l => !preferred.includes(l)));

  // Choose the freshest label whose latest value includes lat/lng
  let bestLab = null, bestTs = -Infinity;
  for (const lab of order){
    const rows = await fetchUbidotsVar(deviceID, lab, 1);
    const r = rows?.[0];
    const lat = r?.context?.lat, lng = r?.context?.lng;
    const ts  = r?.timestamp || 0;
    if (typeof lat === 'number' && typeof lng === 'number' && ts > bestTs) {
      bestTs = ts; bestLab = lab;
    }
  }

  if (bestLab) {
    gpsLabelCache[deviceID] = bestLab;
    console.log('[gps label]', deviceID, '→', bestLab);
    return bestLab;
  }
  gpsLabelCache[deviceID] = null; // cache miss so we never rescan for this device
  console.warn('[gps label] none found for device', deviceID, labels);
  return null;
}
// --- Ubidots v2 helpers (location + bulk last values) ---
async function fetchDeviceLocationV2(deviceID){
  try{
    const r = await fetch(`${UBIDOTS_BASE}/devices/${deviceID}/?fields=location`, {
      headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if(!r.ok) return null;
    const j = await r.json();
    const lat = j?.location?.lat;
    const lng = j?.location?.lng;
    if (typeof lat === 'number' && typeof lng === 'number') {
      return { lat, lon: lng };
    }
  }catch(e){ /* ignore */ }
  return null;
}

async function fetchDeviceLastValuesV2(deviceID){
    if (!USE_V2_BULK) return null;
  try{
    const r = await fetch(`${UBIDOTS_BASE}/devices/${deviceID}/_/values/last`, {
      headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if(!r.ok) return null;
    const j = await r.json();
    return (j && typeof j === 'object') ? j : null;
  }catch(e){
    console.warn('last-values v2 failed', e);
    return null;
  }
}



/* =================== Dallas addresses (v1.6) =================== */
async function fetchDallasAddresses(deviceID){
  try{
    // 1) If we already have the var map, derive addresses from its labels (no network).
    if (variableCache[deviceID]) {
      const labels = Object.keys(variableCache[deviceID]);
      const seen = new Set();
      const uniq = [];
      for (const l of labels) {
        if (/^[0-9a-fA-F]{16}$/.test(l) && !seen.has(l)) {
          seen.add(l);
          uniq.push(l);
        }
      }
      return uniq;
    }

    // 2) Build the var map once; then derive addresses (still only ONE network call)
    await ensureVarCache(deviceID);
    if (variableCache[deviceID] && Object.keys(variableCache[deviceID]).length) {
      const labels = Object.keys(variableCache[deviceID]);
      const seen = new Set();
      const uniq = [];
      for (const l of labels) {
        if (/^[0-9a-fA-F]{16}$/.test(l) && !seen.has(l)) {
          seen.add(l);
          uniq.push(l);
        }
      }
      return uniq;
    }

    // 3) Fallback (should rarely run): direct variables listing as a last resort
   const res = await fetch(`${UBIDOTS_V1}/variables/?device=${deviceID}&page_size=1000&token=${UBIDOTS_ACCOUNT_TOKEN}`);

    if(!res.ok) return [];
    const js = await res.json();
    const labels = (js.results || []).map(v => v.label).filter(l => /^[0-9a-fA-F]{16}$/.test(l));
    const seen = new Set(); const uniq = [];
    for (const l of labels) { if (!seen.has(l)) { seen.add(l); uniq.push(l); } }
    return uniq;
  }catch(e){
    console.error("fetchDallasAddresses", e);
    return [];
  }
}


/* =================== Heartbeat labels resolver =================== */
function pickHeartbeatLabels(deviceId, deviceLabel){
  const labels = Object.keys(variableCache[deviceId] || {});
  const pickFirst = (...cands) => cands.find(l => labels.includes(l));
  const hb = [];

  const radio = pickFirst("signal","rssi","csq");           if (radio) hb.push(radio);
  const power = pickFirst("volt","vbatt","battery","batt"); if (power) hb.push(power);
  const gps   = pickFirst("gps","position");                if (gps)   hb.push(gps);

  if (!hb.length) {
    const map = sensorMapConfig[deviceLabel] || {};
    hb.push(
      ...Object.keys(map)
        .filter(k => /^[0-9a-fA-F]{16}$/.test(k))
        .slice(0, 2)
    );
  }
  return hb;
}

/* =================== Sensor slots =================== */
function buildSensorSlots(deviceLabel, liveDallas, SENSOR_MAP){
  const mapped   = SENSOR_MAP[deviceLabel]||{};
  const adminMap = sensorMapConfig[deviceLabel]||{};

  // Take the first 5 live DS18B20 addresses from Ubidots
  const addrs = [...liveDallas.slice(0,5)];
  while (addrs.length < 5) addrs.push(null);

  const slots = addrs.map((addr, idx) => {
    if (!addr) {
      return { id:`empty${idx}`, label:"", col:SENSOR_COLORS[idx], chart:null, address:null, calibration:0 };
    }
    const label =
      (adminMap[addr]?.label && String(adminMap[addr].label).trim()) ||
      (mapped[addr]?.label   && String(mapped[addr].label).trim())   ||
      addr;

    const offset =
      (typeof adminMap[addr]?.offset === "number") ? adminMap[addr].offset :
      (typeof mapped[addr]?.offset   === "number") ? mapped[addr].offset   : 0;

    return {
      id: addr,
      label,
      col: SENSOR_COLORS[idx],
      chart: null,
      address: addr,
      calibration: offset
    };
  });

  // Keep synthetic average first
  slots.unshift({ id:"avg", label:"Chillrail Avg", col:SENSOR_COLORS[5], chart:null, address:null, calibration:0 });

  return slots;
}
//Part 2
/* =================== Charts =================== */
function initCharts(SENSORS){
  const ctr = document.getElementById("charts");
  ctr.innerHTML = "";
  SENSORS.forEach(s=>{
    const box = document.createElement("div");
    box.setAttribute('data-addr', (s.address || s.id || ''));
    box.className = "chart-box";
    box.innerHTML = `<h3>${s.label||""}</h3><canvas></canvas>`;
    ctr.appendChild(box);

    const ctx = box.querySelector("canvas").getContext("2d");
    // Keep canvas background white; dataset will not fill
    ctx.canvas.style.backgroundColor = "#ffffff";

    s.chart = new Chart(ctx,{
      type:"line",
      data:{
        labels:[],
        datasets:[{
  data:[],
  borderColor:s.col,
  borderWidth:3,
  fill:false,
  backgroundColor:'transparent',
  // parsing:false,  // ← remove this line
  pointRadius:2,            // TEMP: make dots visible while testing
  pointHoverRadius:4,
  spanGaps:true
}]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:false,
        normalized:true,
        interaction:{ intersect:false, mode:'index' },
        scales:{
          x:{ ticks:{ display:false }, grid:{ color:'rgba(17,24,39,.05)' } },
          y:{ beginAtZero:false, ticks:{ callback:v=>Number(v).toFixed(1) }, grid:{ color:'rgba(17,24,39,.06)' } }
        },
        elements:{ line:{ tension:0.22 }, point:{ radius:0 } },
        plugins:{ legend:{ display:false }, decimation:{ enabled:false } }
      }
    });

    // Keep a direct handle for fast, version-agnostic rebinding
    ctx.canvas.__chart = s.chart;
  });
}

// Only (re)build chart canvases when the chart layout changes.
// Layout key = deviceLabel + ordered addresses (ignores the "avg" slot).
function ensureCharts(SENSORS, deviceLabel){
  const chartsEl = document.getElementById('charts');
  // Order-independent key: same set of addresses → reuse
  const addrsSorted = SENSORS
    .filter(s => s.address)
    .map(s => s.address)
    .sort()
    .join(',');
  const key = `${deviceLabel}|${addrsSorted}`;

  // If layout unchanged and canvases exist, re-bind Chart instances to the new SENSORS
  if (window.__chartsKey === key && chartsEl && chartsEl.children && chartsEl.children.length){
    // Build a map addr/id → existing Chart instance from current DOM
    const boxes = chartsEl.querySelectorAll('.chart-box');
    const instByAddr = new Map();
    boxes.forEach(box => {
      const addr = box.getAttribute('data-addr') || '';
      const canvas = box.querySelector('canvas');
      if (!canvas) return;
      const inst = canvas.__chart || (Chart.getChart ? Chart.getChart(canvas) : null);
      if (inst) instByAddr.set(addr, inst);
    });

    // Re-bind: attach existing instances to the new SENSORS array
    SENSORS.forEach(s => {
      const addr = s.address || s.id || '';
      s.chart = instByAddr.get(addr) || null;
    });

    console.log('[charts] reuse existing canvas (rebound)');
    return; // keep existing canvases & chart instances
  }

  // Layout changed (different addresses set or first load) → rebuild
  window.__chartsKey = key;
  console.log('[charts] rebuild canvas (new layout or device)');
  initCharts(SENSORS);
}


async function updateCharts(deviceID, SENSORS){
  if (__chartsInFlight) {
    __chartsQueued = true;
    console.log('[charts] skipped (already running)');
    return;
  }
  __chartsInFlight = true;
  const __chartsT0 = performance.now();

  try{
    const seriesByAddr = new Map(); // address -> ordered history (oldest..newest)
    const QUICK_POINTS = Math.min(HIST_POINTS, 20);   // fast-first paint
    const FULL_POINTS  = HIST_POINTS;                 // target history length
    const NEEDS_BACKFILL = FULL_POINTS > QUICK_POINTS;
    const expectedKey = window.__chartsKey;           // guard against device/layout changes

    // If there are no sensor addresses, skip chart work (fast no-op)
    if (!SENSORS.some(s => s.address)) {
      const rng0 = document.getElementById('chartRange');
      if (rng0) rng0.textContent = '';
      const avg0 = SENSORS.find(x => x.id === 'avg');
      if (avg0 && avg0.chart) {
        avg0.chart.data.labels = [];
        avg0.chart.data.datasets[0].data = [];
        avg0.chart.update('none');
      }
      return;
    }

    // Per-sensor quick slice
    await Promise.all(SENSORS.map(async s=>{
      if(!s.address || !s.chart) return;
      const rows = await fetchUbidotsVar(deviceID, s.address, QUICK_POINTS);
      if(!rows.length) return;
      const ordered = rows.slice().reverse();
      seriesByAddr.set(s.address, ordered);

      s.chart.data.labels = ordered.map(r => fmtTimeHHMM(r.timestamp, 'Europe/London'));
      s.chart.data.datasets[0].data = ordered.map(r=>{
        let v = parseFloat(r.value);
        if(typeof s.calibration==="number") v += s.calibration;
        return isNaN(v)?null:v;
      });

      // Dynamic y-scale (never clip top/bottom)
      const vals = s.chart.data.datasets[0].data.filter(v => v != null && isFinite(v));
      if (vals.length) {
        const vmin = Math.min(...vals);
        const vmax = Math.max(...vals);
        const pad  = Math.max(0.5, (vmax - vmin) * 0.10);
        s.chart.options.scales.y.min = vmin - pad;
        s.chart.options.scales.y.max = vmax + pad;
      } else {
        delete s.chart.options.scales.y.min;
        delete s.chart.options.scales.y.max;
      }

      s.chart.update('none');
    }));

    // Build & render "Chillrail Avg" using cached series; no extra fetch
    try{
      const series = [];
      for (const s of SENSORS){
        if (!s.address) continue;
        const ordered = seriesByAddr.get(s.address);
        if (!ordered || !ordered.length) continue;

        const items = ordered.map(r=>{
          let v = parseFloat(r.value);
          if (typeof s.calibration === 'number') v += s.calibration;
          return { ts: Math.floor(r.timestamp/60000)*60000, v: isNaN(v) ? null : v };
        }).filter(o => o.v != null);
        if (items.length) series.push(items);
      }

      const bucketSet = new Set();
      series.forEach(arr => arr.forEach(o => bucketSet.add(o.ts)));
      const buckets = Array.from(bucketSet).sort((a,b)=>a-b);

      const maps = series.map(arr=>{
        const m = new Map();
        arr.forEach(o => m.set(o.ts, o.v));
        return m;
      });

      const avgLabels = buckets.map(ts => fmtTimeHHMM(ts, 'Europe/London'));
      const avgData = buckets.map(ts=>{
        const vals = maps.map(m=>m.get(ts)).filter(v=>v!=null && isFinite(v));
        return vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : null;
      });

      const avgSlot = SENSORS.find(x=>x.id==="avg");
      if (avgSlot && avgSlot.chart){
        avgSlot.chart.data.labels = avgLabels;
        avgSlot.chart.data.datasets[0].data = avgData;
        avgSlot.chart.data.datasets[0].fill = false;
        avgSlot.chart.data.datasets[0].backgroundColor = 'transparent';

        const good = avgData.filter(v=>v!=null && isFinite(v));
        if (good.length){
          const vmin = Math.min(...good), vmax = Math.max(...good);
          const pad  = Math.max(0.5,(vmax - vmin) * 0.10);
          avgSlot.chart.options.scales.y.min = vmin - pad;
          avgSlot.chart.options.scales.y.max = vmax + pad;
        } else {
          delete avgSlot.chart.options.scales.y.min;
          delete avgSlot.chart.options.scales.y.max;
        }
        avgSlot.chart.update('none');
      }
    } catch(e){ console.error('avg-build failed:', e); }

    // Range banner from cached series
    let minTs = Infinity, maxTs = -Infinity;
    for (const s of SENSORS){
      if (!s.address) continue;
      const ord = seriesByAddr.get(s.address);
      if (!ord || !ord.length) continue;
      const oldest = ord[0].timestamp;
      const newest = ord[ord.length - 1].timestamp;
      if (isFinite(oldest) && isFinite(newest)) {
        minTs = Math.min(minTs, oldest, newest);
        maxTs = Math.max(maxTs, oldest, newest);
      }
    }
    const rng = document.getElementById("chartRange");
    if (rng && isFinite(minTs) && isFinite(maxTs)) {
      const a=new Date(minTs), b=new Date(maxTs);
      const same = a.toDateString()===b.toDateString();
      const fmtD = d=>d.toLocaleDateString('en-GB', { year:'numeric', month:'short', day:'numeric', timeZone:'Europe/London' });
      const fmtT = d=>d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Europe/London' });
      rng.textContent = same ? `${fmtD(a)} · ${fmtT(a)}–${fmtT(b)}` : `${fmtD(a)} ${fmtT(a)} → ${fmtD(b)} ${fmtT(b)}`;
    }

    // Background backfill to FULL_POINTS
    if (NEEDS_BACKFILL) {
      setTimeout(async () => {
        if (window.__chartsKey !== expectedKey) return;

        try {
          // Full series per sensor
          await Promise.all(SENSORS.map(async s => {
            if (!s.address || !s.chart) return;
            const rowsFull = await fetchUbidotsVar(deviceID, s.address, FULL_POINTS);
            if (!rowsFull || !rowsFull.length) return;
            const orderedFull = rowsFull.slice().reverse();
            seriesByAddr.set(s.address, orderedFull);

            s.chart.data.labels = orderedFull.map(r => fmtTimeHHMM(r.timestamp, 'Europe/London'));
            s.chart.data.datasets[0].data = orderedFull.map(r => {
              let v = parseFloat(r.value);
              if (typeof s.calibration === 'number') v += s.calibration;
              return isNaN(v) ? null : v;
            });

            const vals = s.chart.data.datasets[0].data.filter(v => v != null && isFinite(v));
            if (vals.length) {
              const vmin = Math.min(...vals);
              const vmax = Math.max(...vals);
              const pad  = Math.max(0.5, (vmax - vmin) * 0.10);
              s.chart.options.scales.y.min = vmin - pad;
              s.chart.options.scales.y.max = vmax + pad;
            } else {
              delete s.chart.options.scales.y.min;
              delete s.chart.options.scales.y.max;
            }

            s.chart.update('none');
          }));

          // Rebuild Avg on full data
          try {
            const series = [];
            for (const s of SENSORS){
              if (!s.address) continue;
              const ordered = seriesByAddr.get(s.address);
              if (!ordered || !ordered.length) continue;
              const items = ordered.map(r=>{
                let v = parseFloat(r.value);
                if (typeof s.calibration === 'number') v += s.calibration;
                return { ts: Math.floor(r.timestamp/60000)*60000, v: isNaN(v) ? null : v };
              }).filter(o => o.v != null);
              if (items.length) series.push(items);
            }

            const bucketSet = new Set();
            series.forEach(arr => arr.forEach(o => bucketSet.add(o.ts)));
            const buckets = Array.from(bucketSet).sort((a,b)=>a-b);

            const maps = series.map(arr=>{
              const m = new Map();
              arr.forEach(o => m.set(o.ts, o.v));
              return m;
            });

            const avgLabels = buckets.map(ts => fmtTimeHHMM(ts, 'Europe/London'));
            const avgData = buckets.map(ts=>{
              const vals = maps.map(m=>m.get(ts)).filter(v=>v!=null && isFinite(v));
              return vals.length ? (vals.reduce((a,b)=>a+b,0)/vals.length) : null;
            });

            const avgSlot = SENSORS.find(x=>x.id==="avg");
            if (avgSlot && avgSlot.chart){
              avgSlot.chart.data.labels = avgLabels;
              avgSlot.chart.data.datasets[0].data = avgData;
              const good = avgData.filter(v=>v!=null && isFinite(v));
              if (good.length){
                const vmin = Math.min(...good), vmax = Math.max(...good);
                const pad  = Math.max(0.5,(vmax - vmin) * 0.10);
                avgSlot.chart.options.scales.y.min = vmin - pad;
                avgSlot.chart.options.scales.y.max = vmax + pad;
              } else {
                delete avgSlot.chart.options.scales.y.min;
                delete avgSlot.chart.options.scales.y.max;
              }
              avgSlot.chart.update('none');
            }
          } catch(e) {
            console.error('avg backfill failed:', e);
          }

          // Update range banner on full data
          let minTs2 = Infinity, maxTs2 = -Infinity;
          for (const s of SENSORS){
            if (!s.address) continue;
            const ord = seriesByAddr.get(s.address);
            if (!ord || !ord.length) continue;
            const oldest = ord[0].timestamp;
            const newest = ord[ord.length-1].timestamp;
            if (isFinite(oldest) && isFinite(newest)) {
              minTs2 = Math.min(minTs2, oldest, newest);
              maxTs2 = Math.max(maxTs2, oldest, newest);
            }
          }
          const rng2 = document.getElementById("chartRange");
          if (rng2 && isFinite(minTs2) && isFinite(maxTs2)) {
            const a=new Date(minTs2), b=new Date(maxTs2);
            const same = a.toDateString()===b.toDateString();
            const fmtD = d=>d.toLocaleDateString('en-GB', { year:'numeric', month:'short', day:'numeric', timeZone:'Europe/London' });
            const fmtT = d=>d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Europe/London' });
            rng2.textContent = same ? `${fmtD(a)} · ${fmtT(a)}–${fmtT(b)}` : `${fmtD(a)} ${fmtT(a)} → ${fmtD(b)} ${fmtT(b)}`;
          }

          // free memory after successful backfill
          seriesByAddr.clear();
        } catch(e) {
          console.error('backfill error:', e);
        }
      }, 0);
    }
  } finally {
    __chartsInFlight = false;
    console.log('[charts] done in', Math.round(performance.now()-__chartsT0), 'ms');
    if (__chartsQueued) {
      __chartsQueued = false;
      setTimeout(() => updateCharts(deviceID, SENSORS), 0);
    }
  }
}
// Part 3 — FAST live paint: bulk last values, then fallback
async function poll(deviceID, SENSORS){
  // ---- FAST PATH: one call gets all last values; draw immediately if available ----
  const bulk = await fetchDeviceLastValuesV2(deviceID);
  if (bulk) {
    const readings = {};
    // Dallas temps by address (16-hex labels defined in SENSORS)
    for (const s of SENSORS){
      if (!s.address) continue;
      const obj = bulk[s.address];
      if (obj && obj.value != null) {
        const v = parseFloat(obj.value);
        if (!Number.isNaN(v)) readings[s.address] = v;
      }
    }
    // Common single-value vars
    const pickVal = (...keys) => {
      for (const k of keys) {
        const o = bulk[k];
        if (o && o.value != null && isFinite(o.value)) return Number(o.value);
      }
      return null;
    };
    const iccid  = (bulk.iccid && bulk.iccid.value != null) ? String(bulk.iccid.value) : null;
    const signal = pickVal('signal','rssi','csq');
    const volt   = pickVal('volt','vbatt','battery','batt');

    // GPS from any of these labels
    const gpsObj = bulk.gps || bulk.position || bulk.location || null;
    let lat=null, lon=null, speedVal=null, lastLat=null, lastLon=null, lastGpsAgeMin=null;
    let tsGps = null;
    if (gpsObj) {
      const c = gpsObj.context || {};
      const candLat = c.lat;
      const candLon = (c.lng!=null ? c.lng : c.lon);
      if (typeof candLat === 'number' && typeof candLon === 'number') {
        lat = lastLat = candLat;
        lon = lastLon = candLon;
      }
      if (typeof c.speed === 'number') speedVal = c.speed;
      if (gpsObj.timestamp) tsGps = gpsObj.timestamp;
    }

    // Compose a "best" timestamp from available points
    const tsList = [];
    const pushTs = o => { if (o && o.timestamp && isFinite(o.timestamp)) tsList.push(o.timestamp); };
    ['signal','rssi','csq','volt','vbatt','battery','batt','iccid'].forEach(k => pushTs(bulk[k]));
    if (gpsObj) pushTs(gpsObj);
    for (const s of SENSORS){
      if (!s.address) continue;
      pushTs(bulk[s.address]);
    }
    const nowMs = Date.now();
    const ts = tsList.length ? Math.max(...tsList) : nowMs;
    if (tsGps) lastGpsAgeMin = Math.round((nowMs - tsGps)/60000);

    // Resolve timezone and paint
    const deviceLabel = document.getElementById("deviceSelect")?.value || null;
    const tz = await resolveDeviceTz(deviceLabel, (lat ?? lastLat), (lon ?? lastLon));
    drawLive({
      ts,
      iccid,
      lat, lon,
      lastLat, lastLon, lastGpsAgeMin,
      speed:  speedVal,
      signal, volt,
      tz,
      readings
    }, SENSORS);

    // Done via fast path
    return;
  }
  // ---- END FAST PATH ----

  // Prefer Ubidots device.location (v2) first to avoid GPS label scans
  let lat = null, lon = null, speedVal = null;
  let lastLat = null, lastLon = null, lastGpsAgeMin = null;
  let tsGps = null;
  let gpsArr = [];

  const devLoc = await fetchDeviceLocationV2(deviceID);
  if (devLoc) {
    lastLat = devLoc.lat; lastLon = devLoc.lon;
    lat = devLoc.lat;  lon = devLoc.lon;
  } else {
    // No device.location → fall back to scanning for a GPS variable once
    const gpsLabel = await resolveGpsLabel(deviceID);
    if (gpsLabel) {
      gpsArr = await fetchUbidotsVar(deviceID, gpsLabel, 1);
      tsGps = gpsArr[0]?.timestamp || null;
      if (gpsArr[0]?.context) {
        lastLat = gpsArr[0].context.lat;
        lastLon = gpsArr[0].context.lng;
      }
    }
  }

  // GPS freshness gate (only applies to variable-based GPS)
  const FRESH_GPS_MS = 15 * 60 * 1000;          // 15 minutes
  const gpsIsFresh = tsGps && (Date.now() - tsGps) <= FRESH_GPS_MS;
  if (!lat && gpsIsFresh && lastLat != null && lastLon != null) {
    lat = lastLat; lon = lastLon;
  }
  if (tsGps) lastGpsAgeMin = Math.round((Date.now() - tsGps) / 60000);

  // Latest values for ICCID, sensors, signal, volt
  const iccArr = await fetchUbidotsVar(deviceID, "iccid", 1);
  let tsIccid = iccArr[0]?.timestamp || null;

  const readings = {};
  let tsSensorMax = null;
  await Promise.all(SENSORS.filter(s => s.address).map(async s => {
    const v = await fetchUbidotsVar(deviceID, s.address, 1);
    if (v.length && v[0].value != null) {
      readings[s.address] = parseFloat(v[0].value);
      const tsVal = v[0]?.timestamp;
      if (tsVal != null && (tsSensorMax == null || tsVal > tsSensorMax)) tsSensorMax = tsVal;
    }
  }));
  const [signalArr, voltArr] = await Promise.all([
    fetchUbidotsVar(deviceID, "signal", 1),
    fetchUbidotsVar(deviceID, "volt", 1)
  ]);
  let tsSignal = signalArr[0]?.timestamp || null;
  let tsVolt   = voltArr[0]?.timestamp || null;

  // Compose "best" ts for the live panel
  let ts = Date.now();
  const candidates = [tsGps, tsIccid, tsSensorMax, tsSignal, tsVolt].filter(x => x != null);
  if (candidates.length > 0) ts = Math.max(...candidates);

  // Resolve timezone and paint
  const deviceLabel = document.getElementById("deviceSelect")?.value || null;
  const tz = await resolveDeviceTz(deviceLabel, (lat ?? lastLat), (lon ?? lastLon));
  drawLive({
    ts,
    iccid: iccArr[0]?.value ?? null,
    lat,
    lon,
    lastLat, lastLon, lastGpsAgeMin,
    speed: speedVal,
    signal: signalArr[0]?.value ?? null,
    volt:  voltArr[0]?.value ?? null,
    tz,
    readings
  }, SENSORS);
}

/* =================== Live panel + map =================== */
// Ensure we use a lexical Leaflet map/marker (not window.map DOM element)
let map, marker;

function initMap(){
  // Create the Leaflet map once
  if (!(map && typeof map.addLayer === 'function' && typeof map.setView === 'function')) {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
  }
  // Ensure a marker exists
  if (!(marker && typeof marker.setLatLng === 'function')) {
    marker = L.marker([0, 0]).addTo(map);
  }
}
// Helper: 0..31 CSQ → 0..5 bars
function signalBarsFrom(value){
  if (value == null || isNaN(value)) return 0;
  const v = Number(value);
  return Math.max(0, Math.min(5, Math.round((v / 31) * 5)));
}

function drawLive(data, SENSORS){
  let {ts,iccid,lat,lon,lastLat,lastLon,lastGpsAgeMin,speed,signal,volt,readings} = data;

  ts = ts || Date.now();
  const temps = SENSORS
    .map(s => (s.address && readings[s.address]!=null) ? (readings[s.address] + (s.calibration||0)) : null)
    .filter(v=>v!=null && isFinite(v));
  const avg = temps.length ? (temps.reduce((a,b)=>a+b,0)/temps.length) : null;
  document.getElementById("kpiAvg").textContent = avg!=null ? fmt(avg,1) + "°" : "—";

  const devSel = document.getElementById("deviceSelect");
  const deviceKey = devSel ? devSel.value : '';
  const displayName = getDisplayName(deviceKey);
  document.getElementById("kpiTruck").textContent = displayName;
  // KPI date/time is set in updateAll() from lastSeenSec. Do not write kpiSeen here.

  const sigBars = signalBarsFrom(signal);
  const sigClass = sigBars >= 4 ? 'high' : (sigBars >= 2 ? 'med' : 'low');
  const sigHtml =
    (signal != null ? String(signal) : "—") + " " +
    `<span class="sig ${sigClass}">
       <i class="l1 ${sigBars>0?'on':''}"></i>
       <i class="l2 ${sigBars>1?'on':''}"></i>
       <i class="l3 ${sigBars>2?'on':''}"></i>
       <i class="l4 ${sigBars>3?'on':''}"></i>
       <i class="l5 ${sigBars>4?'on':''}"></i>
     </span>`;

  const sensorRows = SENSORS
    .filter(s => s.address && s.id !== "avg" && s.label !== "Chillrail Avg")
    .map(s => [
      s.label,
      (s.address && readings[s.address] != null)
        ? fmt(readings[s.address] + (s.calibration || 0), 1)
        : ""
    ]);

  // --- Location link: prefer fresh lat/lon, else fall back to last-known ---
  const hasFresh = (lat != null && isFinite(lat) && lon != null && isFinite(lon));
  const useLat = hasFresh ? lat : ((lastLat != null && isFinite(lastLat)) ? lastLat : null);
  const useLon = hasFresh ? lon : ((lastLon != null && isFinite(lastLon)) ? lastLon : null);

  let locationHtml = "—";
  if (useLat != null && useLon != null) {
    const href = `https://maps.google.com/?q=${useLat},${useLon}`;
    const label = `${Number(useLat).toFixed(6)}, ${Number(useLon).toFixed(6)}`;
    const staleNote = hasFresh ? "" :
      (lastGpsAgeMin != null && isFinite(lastGpsAgeMin)
        ? ` <span class="text-gray-500">(stale ${lastGpsAgeMin} min)</span>`
        : ` <span class="text-gray-500">(stale)</span>`);
    locationHtml = `<a href="${href}" target="_blank" rel="noopener">${label}</a>${staleNote}`;
  }

  // Build 2-line Local Time: line 1 = date, line 2 = time
  const t = (window.__lastSeenMs != null && isFinite(window.__lastSeenMs)) ? window.__lastSeenMs : ts;
  const tz = data.tz || 'Europe/London';
  const localDate = new Date(t).toLocaleDateString('en-GB', { timeZone: tz });
  const localTime = new Date(t).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZone: tz });

  const rows = [];
  rows.push(["Local Time", `<div>${localDate}</div><div class="text-gray-500">${localTime}</div>`]);

  if ((lat == null || lon == null) && lastLat != null && lastLon != null) {
    const mins = (lastGpsAgeMin != null && isFinite(lastGpsAgeMin)) ? lastGpsAgeMin : null;
    const staleNote = mins != null ? `Last GPS (${mins} min ago)` : 'Last GPS (stale)';
    rows.push(["Last GPS", `<span class="text-gray-500">${staleNote}</span>`]);
  }

  rows.push(["ICCID", iccid || "—"]);

  const _fresh = (lat != null && isFinite(lat) && lon != null && isFinite(lon));
  const _lat   = _fresh ? Number(lat) : (isFinite(lastLat) ? Number(lastLat) : null);
  const _lon   = _fresh ? Number(lon) : (isFinite(lastLon) ? Number(lastLon) : null);

  let _locationHtml = "—";
  if (_lat != null && _lon != null) {
    const _href  = `https://maps.google.com/?q=${_lat},${_lon}`;
    const _label = `${_lat.toFixed(6)}, ${_lon.toFixed(6)}`;
    const _stale = _fresh
      ? ""
      : (lastGpsAgeMin != null && isFinite(lastGpsAgeMin)
          ? ` <span class="text-gray-500">(stale ${lastGpsAgeMin} min)</span>`
          : ` <span class="text-gray-500">(stale)</span>`);
    _locationHtml = `<a href="${_href}" target="_blank" rel="noopener">${_label}</a>${_stale}`;
  }

  rows.push(["Location", _locationHtml]);
  rows.push(["Speed (km/h)", fmt(speed, 1)]);
  rows.push(["Signal", sigHtml]);
  rows.push(["Volt (V)", (volt != null && isFinite(volt)) ? Number(volt).toFixed(2) : "—"]);
  rows.push(...sensorRows);

  document.getElementById("latest").innerHTML =
    rows.map(([lab,val]) => {
      const wrap = (lab === "Local Time") ? ' style="white-space:normal"' : '';
      return `<tr><th>${lab}</th><td${wrap}>${val}</td></tr>`;
    }).join("");

  // --- Final: map/marker handling (race-proof, no duplication) ---
// Idempotent: ensure map + marker right now (safe every tick)
try { initMap(); } catch (_) {}
if (!map || typeof map.addLayer !== 'function') return;
if (!marker || typeof marker.setLatLng !== 'function') return;

// Place pin: prefer fresh, else last-known
if (lat != null && lon != null && isFinite(lat) && isFinite(lon)) {
  marker.setLatLng([lat, lon]);
  map.setView([lat, lon], Math.max(map.getZoom(), 13));
} else if (lastLat != null && lastLon != null && isFinite(lastLat) && isFinite(lastLon)) {
  marker.setLatLng([lastLat, lastLon]);
  map.setView([lastLat, lastLon], Math.max(map.getZoom(), 12));
}
  }
/* =================== Maintenance =================== */
const MAINTENANCE_DEFAULTS = { filterDays:60, serviceDays:365, lastDecrementDate:null };

function showPromptModal(message, callback){
  const old=document.getElementById("promptModal"); if(old) old.remove();
  const m=document.createElement("div");
  m.id="promptModal"; m.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center;z-index:70";
  m.innerHTML=`<div style="background:#fff;border-radius:1rem;box-shadow:0 6px 24px rgba(0,0,0,.12);padding:1.5rem;min-width:280px;display:flex;gap:.75rem;flex-direction:column;align-items:center">
    <div style="font-weight:600">${message}</div>
    <input id="modalCodeInput" type="password" style="font-size:1rem;padding:.4rem .6rem;border-radius:.5rem;border:1px solid #cbd5e1;width:10rem" />
    <div id="modalCodeError" style="color:#dc2626;font-weight:600;display:none"></div>
    <div style="display:flex;gap:.5rem">
      <button id="modalOkBtn" class="btn" style="padding:.4rem .8rem;background:#2563eb;color:#fff;border-radius:.5rem">OK</button>
      <button id="modalCancelBtn" class="btn" style="padding:.4rem .8rem;background:#9ca3af;color:#fff;border-radius:.5rem">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(m);
  function close(){ m.remove() }
  document.getElementById("modalCancelBtn").onclick=close;
  document.getElementById("modalOkBtn").onclick=()=>{
    const val=document.getElementById("modalCodeInput").value;
    callback(val, close, msg=>{ const e=document.getElementById("modalCodeError"); e.textContent=msg; e.style.display="block"; });
  };
  setTimeout(()=>document.getElementById("modalCodeInput").focus(),50);
}

function getMaintState(truckLabel){
  const map = sensorMapConfig[truckLabel] || {};
  return {
    filterDays:  typeof map.filterDays  === "number" ? map.filterDays  : MAINTENANCE_DEFAULTS.filterDays,
    serviceDays: typeof map.serviceDays === "number" ? map.serviceDays : MAINTENANCE_DEFAULTS.serviceDays,
    lastDecrementDate: map.lastDecrementDate || null,
  };
}

async function saveMaintState(truckLabel, maintObj){
  sensorMapConfig[truckLabel] = sensorMapConfig[truckLabel] || {};
  Object.assign(sensorMapConfig[truckLabel], maintObj);
  await fetch('https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?token='+UBIDOTS_ACCOUNT_TOKEN, {
    method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ value:0, context:sensorMapConfig })
  });
}

async function checkAndUpdateMaintCounters(truckLabel, deviceID){
  const state = getMaintState(truckLabel);
  const today = (new Date()).toISOString().slice(0,10);
  if (state.lastDecrementDate === today) return state;

  let hasActivity = false;

  // FAST PATH: one bulk call for all last values
  try{
    const bulk = await fetchDeviceLastValuesV2(deviceID);
    if (bulk) {
      for (const s of SENSORS) {
        if (!s.address) continue;
        const o = bulk[s.address];
        const ts = o?.timestamp || null;
        if (ts) {
          if (new Date(ts).toISOString().slice(0,10) === today) { hasActivity = true; break; }
        }
      }
    } else {
      // Fallback to per-variable (rare)
      for (const s of SENSORS){
        if(!s.address) continue;
        const vals = await fetchUbidotsVar(deviceID, s.address, 1);
        const ts = vals?.[0]?.timestamp || null;
        if (ts && new Date(ts).toISOString().slice(0,10) === today) { hasActivity = true; break; }
      }
    }
  } catch(e){
    console.warn('maint bulk check failed, falling back:', e);
    // Fallback to per-variable
    for (const s of SENSORS){
      if(!s.address) continue;
      const vals = await fetchUbidotsVar(deviceID, s.address, 1);
      const ts = vals?.[0]?.timestamp || null;
      if (ts && new Date(ts).toISOString().slice(0,10) === today) { hasActivity = true; break; }
    }
  }

  if (hasActivity) {
    if (state.filterDays>0)  state.filterDays--;
    if (state.serviceDays>0) state.serviceDays--;
    state.lastDecrementDate = today;
    await saveMaintState(truckLabel, state);
  }
  return state;
}

async function renderMaintenanceBox(truckLabel, deviceID){
  const box = document.getElementById("maintenanceBox");
  if(!box){ onReady(()=>renderMaintenanceBox(truckLabel,deviceID)); return; }
  const state = await checkAndUpdateMaintCounters(truckLabel, deviceID);
  box.innerHTML = `
    <h2 class="text-lg font-semibold mb-2">Maintenance Status</h2>
    <div class="space-y-4">
      <div class="flex justify-between items-center">
        <span><strong>Filter Replacement:</strong> ${state.filterDays} day${state.filterDays===1?"":"s"} to go</span>
        <button id="resetFilterBtn" class="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-1 px-3 rounded">Reset</button>
      </div>
      <div class="flex justify-between items-center">
        <span><strong>Annual Service:</strong> ${state.serviceDays} day${state.serviceDays===1?"":"s"} to go</span>
        <button id="resetServiceBtn" class="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-1 px-3 rounded">Reset</button>
      </div>
    </div>`;
  document.getElementById("resetFilterBtn").onclick = () =>
    showPromptModal("Enter code to reset filter (60 days):", async (val, close, showError)=>{
      if(val==="0000"){ await saveMaintState(truckLabel,{filterDays:60}); close(); renderMaintenanceBox(truckLabel,deviceID); }
      else showError("Invalid code");
    });
  document.getElementById("resetServiceBtn").onclick = () =>
    showPromptModal("Enter code to reset annual service (365 days):", async (val, close, showError)=>{
      if(val==="8971"){ await saveMaintState(truckLabel,{serviceDays:365}); close(); renderMaintenanceBox(truckLabel,deviceID); }
      else showError("Invalid code");
    });
}

/* =================== CSV download =================== */
async function fetchCsvRows(deviceID, varLabel, start, end, signal){

  try{
    await ensureVarCache(deviceID);
    const id = variableCache[deviceID][varLabel];
    if(!id) return [];
    let url = `https://industrial.api.ubidots.com/api/v1.6/variables/${id}/values/?page_size=1000`;
    if(start) url += `&start=${start}`;
    if(end)   url += `&end=${end}`;
   const init = {};
if (signal) init.signal = signal;
const res = await fetch(url + `&token=${UBIDOTS_ACCOUNT_TOKEN}`, init);


    if(!res.ok) return [];
    return (await res.json()).results||[];
  }catch{ return []; }
}

// Build and download CSV for the selected device/date range
async function downloadCsvForCurrentSelection(){
  try{
    const expStatus = document.getElementById('expStatus');
    const startEl   = document.getElementById('start');
    const endEl     = document.getElementById('end');
    const devSel    = document.getElementById('deviceSelect');

    if(!startEl || !endEl || !devSel){ return; }

    const startStr = startEl.value; // "YYYY-MM-DD"
    const endStr   = endEl.value;
    if(!startStr || !endStr){
      if(expStatus) expStatus.textContent = "Pick a start and end date.";
      return;
    }

    // [start, end] in ms (end inclusive)
    const startMs = new Date(startStr+"T00:00:00").getTime();
    const endMs   = new Date(endStr+"T23:59:59.999").getTime();
    if(isNaN(startMs) || isNaN(endMs) || endMs < startMs){
      if(expStatus) expStatus.textContent = "Invalid date range.";
      return;
    }

    // Resolve current device and its display name
    const deviceLabel = devSel.value;
    const deviceID    = __deviceMap?.[deviceLabel]?.id;
    const displayName = getDisplayName(deviceLabel);
    if(!deviceID){
      if(expStatus) expStatus.textContent = "Device not found.";
      return;
    }

    if(expStatus) expStatus.textContent = "Building CSV…";

    // Columns: timestamp ISO, lat, lng, speed, signal, volt, then each temp sensor (by label)
    const baseCols = ["timestamp", "lat", "lng", "speed", "signal", "volt"];
    const sensorCols = SENSORS.filter(s => s.address).map(s => s.label || s.address);

    // Fetch series
       // Fetch series
    const gpsLabel = await resolveGpsLabel(deviceID);
    const [gpsRows, signalRows, voltRows] = await Promise.all([
      gpsLabel ? fetchCsvRows(deviceID, gpsLabel, startMs, endMs) : Promise.resolve([]),
      fetchCsvRows(deviceID, "signal", startMs, endMs),
      fetchCsvRows(deviceID, "volt",   startMs, endMs)
    ]);


    // Fetch temperature sensors
    const tempSeries = {};
    await Promise.all(SENSORS.filter(s => s.address).map(async s => {
      const rows = await fetchCsvRows(deviceID, s.address, startMs, endMs);
      tempSeries[s.label || s.address] = { rows, calibration: s.calibration||0 };
    }));

    // Merge by exact timestamp (ms)
    const rowMap = new Map(); // ts -> object
    function ensure(ts){ if(!rowMap.has(ts)) rowMap.set(ts, { timestamp: ts }); return rowMap.get(ts); }

    gpsRows.forEach(r=>{
      const o = ensure(r.timestamp);
      o.lat   = r.context?.lat ?? null;
      o.lng   = r.context?.lng ?? null;
      o.speed = (typeof r.context?.speed === 'number') ? r.context.speed : null;
    });
    signalRows.forEach(r=>{ ensure(r.timestamp).signal = (typeof r.value === 'number') ? r.value : null; });
    voltRows.forEach(r=>{ ensure(r.timestamp).volt   = (typeof r.value === 'number') ? r.value : null; });

    Object.entries(tempSeries).forEach(([label, obj])=>{
      obj.rows.forEach(r=>{
        const o = ensure(r.timestamp);
        let v = parseFloat(r.value);
        if(!isNaN(v)) v += obj.calibration || 0;
        o[label] = isNaN(v) ? null : v;
      });
    });

    // Sort timestamps
    const rows = Array.from(rowMap.values()).sort((a,b)=>a.timestamp-b.timestamp);

    // CSV header
    const headers = baseCols.concat(sensorCols);
    const toISO = ts => new Date(ts).toISOString();

    // CSV body
    const csvLines = [];
    csvLines.push(headers.join(','));
    rows.forEach(o=>{
      const line = [
        toISO(o.timestamp),
        o.lat ?? "",
        o.lng ?? "",
        (o.speed != null ? Number(o.speed).toFixed(1) : ""),
        (o.signal!= null ? o.signal : ""),
        (o.volt  != null ? o.volt   : "")
      ];
      sensorCols.forEach(lbl=>{
        line.push(o[lbl] != null ? Number(o[lbl]).toFixed(2) : "");
      });
      csvLines.push(line.join(','));
    });
    const csv = csvLines.join('\n');

    // Download (filename uses the *display* name)
    const safeName = String(displayName).replace(/[^\w\-]+/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,'');
    const fname = `${safeName}_${startStr}_to_${endStr}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    if(expStatus) expStatus.textContent = `Saved ${fname} (${rows.length} rows).`;
  }catch(err){
    console.error("downloadCsvForCurrentSelection error:", err);
    const expStatus = document.getElementById('expStatus');
    if(expStatus) expStatus.textContent = "Failed to build CSV.";
  }
}
// part 4
/* =================== Breadcrumb route drawing =================== */
async function updateBreadcrumbs(deviceID, rangeMinutes){
    const myTok = ++__crumbToken; // stamp this run
// Abort any in-flight breadcrumb work from a previous run
if (__crumbAbort) { try { __crumbAbort.abort(); } catch(_){} }
__crumbAbort = new AbortController();
const __crumbSignal = __crumbAbort.signal;

  try{
  initMap(); // idempotent
    segmentPolylines.forEach(p=>p.remove());
    segmentMarkers.forEach(m=>m.remove());
    segmentPolylines = [];
    segmentMarkers = [];
    if (legendControl){
      map.removeControl(legendControl);
      legendControl = null;
    }
              const nowMs = Date.now();
    const startTime = nowMs - (rangeMinutes * 60 * 1000);

    const gpsLabel = await resolveGpsLabel(deviceID);
    let gpsRows = [];
  if (gpsLabel) gpsRows = await fetchCsvRows(deviceID, gpsLabel, startTime, nowMs, __crumbSignal);



    const gpsPoints = gpsRows
      .filter(r => r.context && r.context.lat != null && r.context.lng != null)
      .sort((a,b) => a.timestamp - b.timestamp);
    if(!gpsPoints.length){
      // No usable points in the selected range
      return;
    }
  // If a newer call started while we were fetching, stop now
  if (myTok !== __crumbToken) return;


    const tempData = {};
    const tempAvg  = {};
    for(const s of SENSORS){
      if(!s.address) continue;
      const rows = await fetchCsvRows(deviceID, s.address, startTime, nowMs, __crumbSignal);
      for(const r of rows){
        const ts = r.timestamp;
        let v = parseFloat(r.value);
        if(isNaN(v)) continue;
        if(typeof s.calibration === 'number') v += s.calibration;
        if(!tempData[ts]) tempData[ts] = [];
        tempData[ts].push(v);
      }
    }
    Object.keys(tempData).forEach(ts => {
      const vals = tempData[ts];
      if(vals && vals.length){
        const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
        tempAvg[ts] = avg;
      }
    });
    const tempTimestamps = Object.keys(tempAvg).map(t=>+t).sort((a,b)=>a-b);
    const segments = [];
    let currentSeg = [];
    for(let i=0;i<gpsPoints.length;i++){
      const pt = gpsPoints[i];
      if(currentSeg.length === 0){
        currentSeg.push(pt);
      } else {
        const prev = gpsPoints[i-1];
        if((pt.timestamp - prev.timestamp) > (15 * 60 * 1000)){
          segments.push(currentSeg);
          currentSeg = [pt];
        } else {
          currentSeg.push(pt);
        }
      }
    }
    if(currentSeg.length) segments.push(currentSeg);
    const legendEntries = [];
    segments.forEach((seg, idx) => {
      const color = SEGMENT_COLORS[idx % SEGMENT_COLORS.length];
      const latlngs = seg.map(r => [r.context.lat, r.context.lng]);
      const poly = L.polyline(latlngs, { color, weight:4, opacity:0.9 }).addTo(map);
      segmentPolylines.push(poly);
      const startDate = new Date(seg[0].timestamp);
      const endDate   = new Date(seg[seg.length-1].timestamp);
      legendEntries.push({ color, start: startDate, end: endDate });
      seg.forEach(pt => {
        const latlng = [pt.context.lat, pt.context.lng];
        let nearestAvg = null;
        let closestDiff = Infinity;
        const ts = pt.timestamp;
        for(const t of tempTimestamps){
          const diff = Math.abs(ts - t);
          if(diff < closestDiff && diff <= 5 * 60 * 1000){
            closestDiff = diff;
            nearestAvg = tempAvg[t];
          }
        }
        const speed = pt.context.speed;
        const timeStr = new Date(pt.timestamp).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZone:'Europe/London' });
        let tooltipHtml = `<div>Time: ${timeStr}</div>`;
        if(speed != null && !isNaN(speed)){
          tooltipHtml += `<div>Speed: ${speed.toFixed(1)} km/h</div>`;
        }
        if(nearestAvg != null && !isNaN(nearestAvg)){
          tooltipHtml += `<div>Avg Temp: ${nearestAvg.toFixed(1)}°</div>`;
        }
        const markerObj = L.circleMarker(latlng, {
          radius: 4,
          fillColor: color,
          color: color,
          weight: 1,
          opacity: 0.9,
          fillOpacity: 0.8
        }).bindTooltip(tooltipHtml, { className: 'tooltip', direction: 'top', offset: [0,-6] });
        markerObj.addTo(map);
        segmentMarkers.push(markerObj);
      });
    });
    if(segments.length > 0){
      const allLatLngs = [];
      segments.forEach(seg => { seg.forEach(pt => { allLatLngs.push([pt.context.lat, pt.context.lng]); }); });
      const bounds = L.latLngBounds(allLatLngs);
      map.fitBounds(bounds, { padding: [20,20] });
    }
    if(legendEntries.length > 0){
      legendControl = L.control({ position: 'bottomright' });
      legendControl.onAdd = function(){
        const div = L.DomUtil.create('div', 'breadcrumb-legend');
        div.style.background = 'rgba(255,255,255,0.85)';
        div.style.padding = '8px 10px';
        div.style.borderRadius = '6px';
        div.style.fontSize = '0.75rem';
        div.style.lineHeight = '1.2';
        div.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        let html = '<strong>Segments</strong><br>';
        legendEntries.forEach(entry => {
          const startT = entry.start.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Europe/London' });
          const endT   = entry.end.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Europe/London' });
          html += `<span style="display:inline-block;width:12px;height:12px;margin-right:4px;background:${entry.color}"></span>${startT}–${endT}<br>`;
        });
        div.innerHTML = html;
        return div;
      };
      legendControl.addTo(map);
    }
  }catch(err){
    console.error('updateBreadcrumbs error', err);
  }
}

/* =================== Range buttons =================== */
function wireRangeButtons(){
  const buttons = document.querySelectorAll(".rangeBtn");
  buttons.forEach(btn=>{
    btn.onclick = async function(){
      // Visual selection
      buttons.forEach(b=>{
        b.style.backgroundColor = '';
        b.style.color = '';
      });
      this.style.backgroundColor = '#10b981';
      this.style.color = '#ffffff';

      // Update selection model
      const modeAttr = this.getAttribute('data-mode') || 'range';
      const valAttr  = parseInt(this.getAttribute('data-range'), 10);

      // No-op if the selection didn't actually change
      const newMinutes = Number.isFinite(valAttr) ? valAttr : 60;
      if (selectedRangeMode === modeAttr && selectedRangeMinutes === newMinutes) {
        return; // nothing to do
      }
      selectedRangeMinutes = newMinutes;
      selectedRangeMode    = modeAttr;
      HIST_POINTS          = selectedRangeMinutes;

      // Fast path: only refresh charts + defer breadcrumbs (no full updateAll)
      const devSel      = document.getElementById('deviceSelect');
      const deviceLabel = devSel?.value || Object.keys(window.__deviceMap || {})[0];
      const deviceID    = window.__deviceMap?.[deviceLabel]?.id;

      if (deviceID) {
        await updateCharts(deviceID, SENSORS); // redraw charts quickly
        const idle = window.requestIdleCallback || ((fn)=>setTimeout(fn,50));
        idle(() => { updateBreadcrumbs(deviceID, selectedRangeMinutes); });
      }
    };
  });
}



/* =================== Date inputs: instant commit =================== */
function wireDateInputsCommit(){
  const startEl = document.getElementById('start');
  const endEl   = document.getElementById('end');
  const btn     = document.getElementById('dlBtn');
  if (!startEl || !endEl) return;

  ['change','input'].forEach(ev => {
    startEl.addEventListener(ev, () => startEl.blur());
    endEl.addEventListener(ev,   () => endEl.blur());
  });

  if (btn) {
    btn.addEventListener('pointerdown', () => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }, { capture:true });
    // Wire the Download button
    btn.onclick = downloadCsvForCurrentSelection;
  }
}

/* =================== Main update loop =================== */
onReady(() => {
  wireRangeButtons();
  wireDateInputsCommit();   // commit date instantly
    installAllTrucksMapUI();
  updateAll();
  setInterval(updateAll, REFRESH_INTERVAL);

  const sel = document.getElementById("deviceSelect");
  if (sel) sel.addEventListener("change", updateAll);
});

async function updateAll(){
    if (__updateInFlight) {
    __updateQueued = true;
    console.log('[updateAll] skipped (already running)');
    return;
  }
  __updateInFlight = true;
  const __t0 = performance.now();

  try{
    // 1) Fetch mapping + devices
  const sensorMap = await fetchSensorMapConfig();
await fetchSensorMapMapping();   // load aliases *after* device list, ensures fresh __aliases
    window.__deviceMap = sensorMap; // expose to CSV click handler

    // 2) Build the device dropdown from Devices v2 last_seen ONLY (no bulk re-check)
    const sel = document.getElementById("deviceSelect");
    if (sel) {
      const prev = sel.value;
      const nowSecForBuild = Math.floor(Date.now()/1000);
      sel.innerHTML = "";

      const entries = Object.entries(sensorMap).sort(([a],[b])=>{
        const na = parseInt(String(a).replace("skycafe-",""), 10);
        const nb = parseInt(String(b).replace("skycafe-",""), 10);
        return (isNaN(na)?9999:na) - (isNaN(nb)?9999:nb);
      });

      for (const [dev, obj] of entries){
        const isOnline = (nowSecForBuild - (obj.last_seen || 0)) < ONLINE_WINDOW_SEC;
        const opt = document.createElement("option");
        opt.value = dev;
        opt.text  = `${isOnline ? "🟢" : "⚪️"} ${getDisplayName(dev)} (${isOnline ? "Online" : "Offline"})`;
        sel.appendChild(opt);
      }

      // restore previous, else first Online, else first
      let foundPrev = false;
      for (let i=0;i<sel.options.length;i++){
        if (sel.options[i].value === prev){ sel.selectedIndex = i; foundPrev = true; break; }
      }
      if (!foundPrev){
        for (let i=0;i<sel.options.length;i++){
          if (sel.options[i].text.includes("Online")){ sel.selectedIndex = i; foundPrev = true; break; }
        }
      }
      if (!foundPrev && sel.options.length>0) sel.selectedIndex = 0;
    }
    // 2b) Re-evaluate stale dropdown items using gps/signal/volt only (narrow heartbeat)
   if (USE_V16_HEARTBEAT_FALLBACK && sel) {
      const nowSec = Math.floor(Date.now() / 1000);

      const updates = Array.from(sel.options).map(async (opt) => {
  const label = opt.value;
  const info  = sensorMap[label];
  const id    = info?.id;
  const last  = info?.last_seen || 0;
  if (!id) return;

  const nowSec = Math.floor(Date.now() / 1000);
  // Only re-check devices that look stale by v2 last_seen
  if ((nowSec - last) <= ONLINE_WINDOW_SEC) return;

  try {
    // Map labels -> varIds (v1.6)
    await ensureVarCache(id);
    const caps = variableCache[id] || {};

    // STRICT heartbeat: radio + power only (never Dallas/temperature addresses)
    const hb = ['signal','rssi','csq','volt','vbatt','battery','batt']
      .filter(l => l in caps);

    // No heartbeat vars -> keep Offline and stop re-check for this device
    if (hb.length === 0) {
      opt.text = `⚪️ ${getDisplayName(label)} (Offline)`;
      return;
    }

    let bestTs = 0;
    for (const lab of hb) {
      const varId = caps[lab];
      if (!varId) continue;
     const r = await fetch(`${UBIDOTS_V1}/variables/${varId}/values/?page_size=1&token=${UBIDOTS_ACCOUNT_TOKEN}`);

      if (!r.ok) continue;
      const j = await r.json();
      const ts = j?.results?.[0]?.timestamp || 0; // ms
      if (ts > bestTs) bestTs = ts;
    }

    const ageOk = bestTs && (Math.floor(Date.now() / 1000) - Math.floor(bestTs / 1000)) < ONLINE_WINDOW_SEC;
    opt.text = `${ageOk ? "🟢" : "⚪️"} ${getDisplayName(label)} (${ageOk ? "Online" : "Offline"})`;
  } catch (e) {
    console.warn("dropdown re-check failed for", label, e);
  }
});


      await Promise.all(updates);
    }

    // 3) If still no devices, stop gracefully
    if (!sensorMap || !Object.keys(sensorMap).length) {
      console.error("No devices available from Ubidots.");
      const charts = document.getElementById("charts");
      if (charts) charts.innerHTML = "<div class='text-sm text-gray-600'>No devices found. Check API token/network.</div>";
      return;
    }

    // 4) Resolve current device
    const deviceLabel = document.getElementById("deviceSelect")?.value || Object.keys(sensorMap)[0];
    const deviceID    = sensorMap[deviceLabel]?.id;

    // 5) Pill Online logic:
    //    Use Devices v2 last_seen; if stale/missing, FALLBACK to gps/signal/volt (v1.6 values) within the same 5-min window.
    const nowSec = Math.floor(Date.now() / 1000);
    let lastSeenSec = sensorMap[deviceLabel]?.last_seen || 0;
    const stale = !lastSeenSec || (nowSec - lastSeenSec) > ONLINE_WINDOW_SEC;

    if (stale && deviceID) {
      try {
        await ensureVarCache(deviceID);  // fills variableCache[deviceID]: label -> varId
      const labelsToCheck = pickHeartbeatLabels(deviceID, deviceLabel);
        let bestTs = 0;
        for (const lab of labelsToCheck) {
          const varId = variableCache[deviceID]?.[lab];
          if (!varId) continue;
         const vs = await fetch(`${UBIDOTS_V1}/variables/${varId}/values/?page_size=1&token=${UBIDOTS_ACCOUNT_TOKEN}`);
          if (!vs.ok) continue;
          const vr = await vs.json();
          const ts = vr?.results?.[0]?.timestamp || 0;   // v1.6 values endpoint
          if (ts > bestTs) bestTs = ts;
        }
        if (bestTs) lastSeenSec = Math.floor(bestTs / 1000);
      } catch (e) {
        console.error("last_seen fallback (gps/signal/volt) failed:", e);
      }
    }
    // DEBUG: final lastSeenSec used for KPI (London)
console.log('[lastSeen]', {
  deviceLabel,
  lastSeenSec,
  london: lastSeenSec
    ? new Date(lastSeenSec * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London' })
    : null,
  nowSec,
  ageSec: lastSeenSec ? (nowSec - lastSeenSec) : null,
  from: stale ? 'fallback(v1.6 values)' : 'devices v2'
});

// DEBUG: final lastSeenSec used for KPI (London time)
console.log('[lastSeen]', {
  deviceLabel,
  lastSeenSec,
  london: lastSeenSec ? new Date(lastSeenSec * 1000)
    .toLocaleString('en-GB', { timeZone: 'Europe/London' }) : null,
  nowSec,
  ageSec: lastSeenSec ? (nowSec - lastSeenSec) : null,
  onlineWindow: ONLINE_WINDOW_SEC
});

    const isOnline = (nowSec - (lastSeenSec || 0)) < ONLINE_WINDOW_SEC;

    // Pill + tooltip
    if (window.__setDeviceStatus) window.__setDeviceStatus(isOnline);
    const pill = document.getElementById("deviceStatusPill");
    if (pill) {
      const seen = lastSeenSec ? new Date(lastSeenSec * 1000) : null;
      pill.title = seen ? `Last activity: ${seen.toLocaleString('en-GB', { timeZone: 'Europe/London' })}` : "";
    }

    // Update the SELECTED dropdown option text to match the pill
    const dd = document.getElementById("deviceSelect");
    if (dd && dd.selectedIndex >= 0) {
      const opt = dd.options[dd.selectedIndex];
      opt.text = `${isOnline ? "🟢" : "⚪️"} ${getDisplayName(deviceLabel)} (${isOnline ? "Online" : "Offline"})`;
    }
    // Update KPI “last updated” using lastSeenSec (v2 Devices or heartbeat fallback)
    {
      const el = document.getElementById("kpiSeen");
      if (el) {
        if (lastSeenSec) {
          const dt = new Date(lastSeenSec * 1000);
          const dStr = dt.toLocaleDateString('en-GB', { timeZone:'Europe/London' });
          const tStr = dt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZone:'Europe/London' });
        el.innerHTML = `<div>${dStr}</div><div class="text-gray-500">${tStr} (London)</div>`;
        } else {
          el.textContent = "—";
        }
      }
    }
window.__lastSeenMs = lastSeenSec ? (lastSeenSec * 1000) : null;

    // 6) Render everything for the selected device
    if (FORCE_VARCACHE_REFRESH) delete variableCache[deviceID];  // optional rebuild; default off
if (deviceID){
  const liveDallas = await fetchDallasAddresses(deviceID);
  SENSORS = buildSensorSlots(deviceLabel, liveDallas, sensorMapConfig);
ensureCharts(SENSORS, deviceLabel);
initMap();                           // idempotent: also recreates marker if missing
await poll(deviceID, SENSORS);       // 1) show current values immediately
await updateCharts(deviceID, SENSORS); // 2) then fetch history for charts
await renderMaintenanceBox(deviceLabel, deviceID);
 // Defer breadcrumbs so they don't block first paint
   const idle = window.requestIdleCallback || ((fn)=>setTimeout(fn,50));
  idle(() => { updateBreadcrumbs(deviceID, selectedRangeMinutes); });
} else {
  console.error("Device ID not found for", deviceLabel);
}


    // 7) Re-wire buttons in case DOM changed
    wireRangeButtons();
   }catch(err){
    console.error("updateAll fatal error (patched):", err);
  } finally {
    __updateInFlight = false;
    console.log('[updateAll] done in', Math.round(performance.now()-__t0), 'ms');
    if (__updateQueued) {
      __updateQueued = false;
      setTimeout(updateAll, 0); // run one more pass to catch the latest state
    }
  }
}
/* =================== "All Trucks" Map UI =================== */
// Reuses your existing helpers: fetchSensorMapConfig, fetchDeviceLocationV2, resolveGpsLabel, fetchUbidotsVar, getDisplayName
let mapAll, mapAllLayerGroup;
let mapAllLegend = null;


function installAllTrucksMapUI(){
  // 1) Find the existing "Admin" button and clone its visual style
  //    We locate by text content "Admin" (case-insensitive). If not found, we fall back to a basic style.
  const adminBtn = Array.from(document.querySelectorAll('button'))
    .find(b => (b.textContent || '').trim().toLowerCase() === 'admin');

  // Create "Map" button
  const mapBtn = document.createElement('button');
  mapBtn.id = 'mapBtn';
  mapBtn.textContent = 'Map';

  if (adminBtn) {
    // Copy class list to match Admin styling exactly
    mapBtn.className = adminBtn.className || '';
    // Insert right after Admin
    adminBtn.insertAdjacentElement('afterend', mapBtn);
  } else {
    // Fallback styling (close to your Admin style if not found)
    mapBtn.className = 'bg-blue-500 hover:bg-blue-600 text-white font-semibold py-1 px-3 rounded';
    // Try to place in a sensible header container; else append to body
    const headerHost = document.querySelector('#header, .header, #topbar, .topbar') || document.body;
    headerHost.appendChild(mapBtn);
    console.warn('[Map] Admin button not found; placed Map button in header/body fallback.');
  }

  // 2) Create the full-screen overlay (once)
  if (!document.getElementById('mapAllOverlay')) {
    const ov = document.createElement('div');
    ov.id = 'mapAllOverlay';
    ov.style.cssText = 'display:none;position:fixed;inset:0;z-index:70;background:#fff;';
    ov.innerHTML = `
      <button id="mapClose"
              class="bg-gray-700 hover:bg-gray-800 text-white font-semibold py-1 px-3 rounded"
              style="position:absolute;top:12px;right:12px;">
        Close
      </button>
      <div id="mapAll" style="position:absolute;inset:0;top:50px;"></div>
    `;
    document.body.appendChild(ov);
  }

  // 3) Wire events
  const ov = document.getElementById('mapAllOverlay');
  const btn = document.getElementById('mapBtn');
  const close = document.getElementById('mapClose');
  if (btn)   btn.addEventListener('click', openMapAll);
  if (close) close.addEventListener('click', closeMapAll);
}

/** Open overlay and render all truck markers */
async function openMapAll(){
  const ov = document.getElementById('mapAllOverlay');
  const div = document.getElementById('mapAll');
  if (!ov || !div) return;

  ov.style.display = 'block';

  // Lazily create the Leaflet map instance for the overlay
  if (!(mapAll && typeof mapAll.addLayer === 'function')) {
    mapAll = L.map('mapAll').setView([20, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(mapAll);
    mapAllLayerGroup = L.layerGroup().addTo(mapAll);
  } else {
    mapAllLayerGroup.clearLayers();
  }
  // Reset legend if it exists
  if (mapAllLegend) { try { mapAll.removeControl(mapAllLegend); } catch(_){} mapAllLegend = null; }

  // Fetch devices list (v2) with ids + last_seen
  const sensorMap = await fetchSensorMapConfig();
  const entries = Object.entries(sensorMap);
  if (!entries.length) return;

  const nowSec = Math.floor(Date.now()/1000);
  const boundsLatLngs = [];
  const cutoffMs = Date.now() - (48 * 60 * 60 * 1000); // 48h window


  // For each device, try v2 location first, then GPS variable fallback
 for (const [devLabel, info] of entries) {
  const deviceID = info?.id;
  if (!deviceID) continue;

  let lat = null, lon = null, tsMs = null;

  // Prefer latest GPS point so timestamp matches the location
  try {
    const gpsLab = await resolveGpsLabel(deviceID);
    if (gpsLab) {
      const rows = await fetchUbidotsVar(deviceID, gpsLab, 1);
      const r = rows && rows[0];
      const g = r && r.context;
      if (g && typeof g.lat === 'number' && (typeof g.lng === 'number' || typeof g.lon === 'number')) {
        lat  = g.lat;
        lon  = (g.lng != null ? g.lng : g.lon);
        tsMs = (typeof r.timestamp === 'number') ? r.timestamp : Date.parse(r.timestamp);
      }
    }
  } catch(_) {}

  // Fallback: device.location (v2) for coords; and last_seen for timestamp
  if (lat == null || lon == null) {
    try {
      const loc = await fetchDeviceLocationV2(deviceID);
      if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
        lat = loc.lat; lon = loc.lon;
      }
    } catch(_) {}
  }
  if (tsMs == null) {
    const lastSeenSec = info?.last_seen || 0;
    tsMs = lastSeenSec ? (lastSeenSec * 1000) : null;
  }

  // Require both coords and a timestamp
  if (!(typeof lat === 'number' && isFinite(lat) && typeof lon === 'number' && isFinite(lon) && tsMs != null && isFinite(tsMs))) {
    continue;
  }

  // Enforce the 48h activity window
  if (tsMs < cutoffMs) continue;

  // Keep current colour logic (online = green, offline = grey)
  const lastSeenSec = info?.last_seen || 0;
  const isOnline = (nowSec - lastSeenSec) < ONLINE_WINDOW_SEC;
  const color = isOnline ? '#16a34a' : '#9ca3af';

  const disp = getDisplayName(devLabel);
  const uploadedStr = new Date(tsMs).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false });

  const mk = L.circleMarker([lat, lon], {
    radius: 7,
    color,
    fillColor: color,
    weight: 2,
    opacity: 1,
    fillOpacity: 0.9
  })
  .bindTooltip(`${disp}<br>Uploaded: ${uploadedStr}`, { direction:'top', offset:[0,-10] })
  .addTo(mapAllLayerGroup);

  // Click-through: focus this truck on the main dashboard
  mk.on('click', () => {
    const sel = document.getElementById('deviceSelect');
    if (sel) {
      sel.value = devLabel;
      sel.dispatchEvent(new Event('change', { bubbles:true }));
    }
    closeMapAll();
  });

  boundsLatLngs.push([lat, lon]);
}

  // Fit bounds if we plotted anything; else show world
  if (boundsLatLngs.length) {
    const b = L.latLngBounds(boundsLatLngs);
    mapAll.fitBounds(b, { padding:[30,30] });
  } else {
    mapAll.setView([20, 0], 2);
  }

  // Legend (Online/Offline)
  mapAllLegend = L.control({ position: 'bottomright' });
  mapAllLegend.onAdd = function(){
    const div = L.DomUtil.create('div');
    div.style.cssText = 'background:rgba(255,255,255,0.9);padding:8px 10px;border-radius:6px;font-size:12px;box-shadow:0 2px 4px rgba(0,0,0,0.1)';
    div.innerHTML = `
      <div style="font-weight:600;margin-bottom:4px;">Status</div>
      <div style="display:flex;gap:10px;align-items:center;">
        <span style="display:inline-block;width:12px;height:12px;background:#16a34a;border-radius:50%;margin-right:6px;"></span>Online
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:4px;">
        <span style="display:inline-block;width:12px;height:12px;background:#9ca3af;border-radius:50%;margin-right:6px;"></span>Offline
      </div>
    `;
    return div;
  };
  mapAllLegend.addTo(mapAll);
}
 /** Close overlay */
function closeMapAll(){
  const ov = document.getElementById('mapAllOverlay');
  if (ov) ov.style.display = 'none';
}

// EOF




