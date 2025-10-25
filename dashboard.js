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
const USE_V2_BULK = true;                  // enable fast per-device v2 bulk fetch

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
let selectedRangeMode = "now";

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


/// Get the *displayed* name seen on the dashboard for a given device label
function getDisplayName(deviceLabel){
  if (!deviceLabel) return deviceLabel;

  const aliases = (sensorMapConfig && sensorMapConfig.__aliases) || aliasMap || {};
  // 1) Exact match first (fast path)
  if (aliases[deviceLabel]) {
    const v = String(aliases[deviceLabel]).trim();
    if (v) return v;
  }
  // 2) Case-insensitive lookup (fixes "skycafe-warehouse" vs "skycafe-Warehouse")
  const want = String(deviceLabel).toLowerCase();
  for (const k of Object.keys(aliases)){
    if (String(k).toLowerCase() === want){
      const v = String(aliases[k]).trim();
      if (v) return v;
    }
  }

  // 3) Fallbacks (also case-insensitive into sensorMapConfig)
  const cfg = sensorMapConfig || {};
  if (cfg[deviceLabel]?.label && String(cfg[deviceLabel].label).trim()) {
    return String(cfg[deviceLabel].label).trim();
  }
  const k2 = Object.keys(cfg).find(k => String(k).toLowerCase() === want);
  if (k2 && cfg[k2]?.label && String(cfg[k2].label).trim()) {
    return String(cfg[k2].label).trim();
  }

  return deviceLabel;
}

// Return admin-mapped DS18B20 addresses for a truck, preserving admin order
function getAdminAddresses(deviceLabel){
  const cfg = sensorMapConfig || {};
  const key = Object.keys(cfg).find(k => String(k).toLowerCase() === String(deviceLabel).toLowerCase());
  if (!key) return [];
  const devMap = cfg[key] || {};
  return Object.keys(devMap).filter(k => /^[0-9a-fA-F]{16}$/.test(k));
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

// Case-insensitive per-device variable ID resolver for hex labels
function getVarIdCI(deviceID, label){
  const map = variableCache[deviceID] || {};
  if (map[label]) return map[label]; // exact hit

  const want = String(label).toLowerCase();
  for (const [k,v] of Object.entries(map)){
    if (String(k).toLowerCase() === want){
      // Cache under the requested label spelling for faster future hits
      variableCache[deviceID][label] = v;
      return v;
    }
  }
  return null;
}
async function fetchUbidotsVar(deviceID, varLabel, limit = 1) {
  try {
    await ensureVarCache(deviceID);

    // 1) Try case-insensitive mapping first (fast path)
    let varId = getVarIdCI(deviceID, varLabel);
    if (varId) {
      const fast = await fetch(`${UBIDOTS_V1}/variables/${varId}/values/?page_size=${limit}&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`);
      if (fast.ok) {
        const data = await (await fast).json();
        const rows = data?.[ 'results' ] || [];
        if (rows.length) return rows;
      }
    }

    // 2) Fallback: scan THIS device’s variables for a case-insensitive label match
    const list = await fetch(`${UBIDOTS_V1}/variables/?device=${encodeURIComponent(deviceID)}&page_size=1000&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`);
    if (!list.ok) return [];
    const jl   = await list.json();
    const want = String(varLabel).toLowerCase();

    const ids = (jl.results || [])
      .filter(v => String(v.label || '').toLowerCase() === want)
      .map(v => v.id);

    for (const id of ids) {
      if (id === varId) continue; // already tried
      const r = await fetch(`${UBIDOTS_V1}/variables/${id}/values/?page_size=${limit}&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`);
      if (!r.ok) continue;
      const j = await r.json();
      const rows = j?.[ 'result' in j ? 'result' : 'results' ] || [];
      if (rows.length) {
        // Cache the resolved ID under the requested label spelling
        (variableCache[deviceID] ||= {})[varId ? varLabel : (jl.results.find(x => x.id === id)?.label || varLabel)] = id;
        return rows;
      }
    }

    return [];
  } catch (e) {
    console.error('fetchUbidotsVar error:', e);
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

// ------------- FRESH-ONLY DALLAS RESOLVER (≤48 h) -------------
async function fetchDallasAddresses(deviceID){
  try{
    // ---- A) ADMIN MAP (authoritative) ----
    try{
      const entry = Object.entries(window.__deviceMap||{}).find(([,info]) => info && info.id === deviceID);
      const deviceLabel = entry ? entry[0] : null;
      if (deviceLabel && window.sensorMapConfig){
        const keyCI = Object.keys(window.sensorMapConfig).find(k => k.toLowerCase() === String(deviceLabel).toLowerCase());
        if (keyCI){
          const devMap = window.sensorMapConfig[keyCI] || {};
          const adminAddrs = Object.keys(devMap).filter(k => /^[0-9a-fA-F]{16}$/.test(k));
          if (adminAddrs.length) return adminAddrs; // keep admin order
        }
      }
    }catch{}

    // ---- B) NO ADMIN MAP → only fresh addresses ----
    const FRESH_MS = 48 * 60 * 60 * 1000; // 48 h
    const nowMs = Date.now();

    // B1) v2 bulk last-values (fast path)
    if (window.USE_V2_BULK) {
      try{
        const r = await fetch(`${UBIDOTS_BASE}/devices/${deviceID}/_/values/last`,
                              { headers:{ 'X-Auth-Token': UBIDOTS_ACCOUNT_TOKEN } });
        if (r.ok){
          const bulk = await r.json();
          const fresh = Object.entries(bulk)
            .filter(([lab,obj]) => /^[0-9a-fA-F]{16}$/.test(lab) &&
                                   Number.isFinite(obj?.timestamp) &&
                                   (nowMs - obj.timestamp) <= FRESH_MS)
            .map(([lab]) => lab);
          if (fresh.length) return fresh;
        }
      }catch(e){ console.warn('v2 bulk last filter failed', e); }
    }

    // B2) fallback: v1.6 variables list + 48 h freshness check
    const listUrl = `${UBIDOTS_V1}/variables/?device=${encodeURIComponent(deviceID)}&page_size=1000&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
    const listJs  = await fetch(listUrl).then(r=>r.json()).catch(()=>({results:[]}));
    const seen = new Set();
    const hexVars = [];
    for (const v of (listJs.results||[])){
      const lab = String(v.label||'');
      if (!/^[0-9a-fA-F]{16}$/.test(lab)) continue;
      const k = lab.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      hexVars.push({label:lab,id:String(v.id)});
    }
    if (!hexVars.length) return [];

    const keepFresh = [];
    const CHUNK = 6;
    for (let i=0;i<hexVars.length;i+=CHUNK){
      const batch = hexVars.slice(i,i+CHUNK);
      const rs = await Promise.all(batch.map(async hv=>{
        try{
          const j = await fetch(`${UBIDOTS_V1}/variables/${hv.id}/values/?page_size=1&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`).then(r=>r.json());
          const ts = j?.results?.[0]?.timestamp;
          return (Number.isFinite(ts) && (nowMs - ts) <= FRESH_MS) ? hv.label : null;
        }catch{return null;}
      }));
      rs.forEach(l=>{ if(l) keepFresh.push(l); });
    }
    return keepFresh;
  }catch(e){
    console.error('fetchDallasAddresses (fresh-only)', e);
    return [];
  }
}
window.fetchDallasAddresses = fetchDallasAddresses;



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
// --- Helper: resolve correct admin mapping even if device label case differs ---
function getAdminMapFor(deviceLabel){
  const cfg = sensorMapConfig || {};
  if (cfg[deviceLabel]) return cfg[deviceLabel];
  const keyMatch = Object.keys(cfg).find(
    x => String(x).toLowerCase() === String(deviceLabel).toLowerCase()
  );
  return keyMatch ? cfg[keyMatch] : {};
}
// --- Helper: resolve correct admin mapping even if device label case differs ---
function getAdminMapFor(deviceLabel){
  const cfg = sensorMapConfig || {};
  if (cfg[deviceLabel]) return cfg[deviceLabel];
  const keyMatch = Object.keys(cfg).find(
    x => String(x).toLowerCase() === String(deviceLabel).toLowerCase()
  );
  return keyMatch ? cfg[keyMatch] : {};
}
// Expose for console/tests
window.getAdminMapFor = getAdminMapFor;

/* =================== Sensor slots =================== */
function buildSensorSlots(deviceLabel, liveDallas, SENSOR_MAP){
  // --- Case-insensitive device-level mapping (skycafe-warehouse vs skycafe-Warehouse)
  const mapped = SENSOR_MAP[deviceLabel] || {};
  const cfg    = sensorMapConfig || {};
  const devKey = Object.keys(cfg).find(k => String(k).toLowerCase() === String(deviceLabel).toLowerCase()) || deviceLabel;
  const adminMap = (cfg[devKey] && typeof cfg[devKey] === 'object') ? cfg[devKey] : {};

  // --- Case-insensitive per-address maps (handle 28D7... vs 28d7...)
  const adminByAddr = new Map(
    Object.entries(adminMap)
      .filter(([k]) => /^[0-9a-fA-F]{16}$/.test(String(k)))
      .map(([k, v]) => [String(k).toLowerCase(), v])
  );
  const mappedByAddr = new Map(
    Object.entries(mapped)
      .filter(([k]) => /^[0-9a-fA-F]{16}$/.test(String(k)))
      .map(([k, v]) => [String(k).toLowerCase(), v])
  );

  // --- Use ONLY live Dallas addresses to avoid ghost sensors; dedupe & keep order
  const addrs = Array.from(new Set(
    (liveDallas || []).filter(a => /^[0-9a-fA-F]{16}$/.test(String(a)))
  ));

  // --- Build slots from the live addresses
  const slots = addrs.map((addr, idx) => {
    const key = String(addr).toLowerCase();
    const entryA = adminByAddr.get(key) || null;  // from admin mapping (preferred)
    const entryM = mappedByAddr.get(key) || null; // from runtime SENSOR_MAP fallback

    const label =
      (entryA && entryA.label && String(entryA.label).trim()) ||
      (entryM && entryM.label && String(entryM.label).trim()) ||
      addr;

    const offset =
      (entryA && typeof entryA.offset === 'number') ? entryA.offset :
      (entryM && typeof entryM.offset === 'number') ? entryM.offset : 0;

    return {
      id: addr,
      label,
      col: SENSOR_COLORS[idx % SENSOR_COLORS.length],
      chart: null,
      address: addr,
      calibration: offset
    };
  });

  // --- Keep synthetic average first
  slots.unshift({ id: "avg", label: "Chillrail Avg", col: SENSOR_COLORS[5], chart: null, address: null, calibration: 0 });

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
// Rebuild/reuse chart canvases; key by deviceID to avoid cross-truck reuse
// Rebuild/reuse chart canvases; key by deviceID to avoid cross-truck reuse
// Rebuild/reuse chart canvases; key by deviceID to avoid cross-truck reuse
// Rebuild/reuse chart canvases; key by deviceID to avoid cross-truck reuse
function ensureCharts(SENSORS, deviceID){
  const chartsEl = document.getElementById('charts');

  // Unique key per device + set of addresses (ignores the avg slot)
  const addrsSorted = SENSORS
    .filter(s => s && s.address)
    .map(s => String(s.address))
    .sort()
    .join(',');
  const key = `${String(deviceID)}|${addrsSorted}`;

  // ── Reuse existing canvases, but REFRESH labels/colors and DOM order to match SENSORS ──
  if (chartsEl && window.__chartsKey === key && chartsEl.children && chartsEl.children.length){
    const boxes = Array.from(chartsEl.querySelectorAll('.chart-box'));
    const boxByAddr  = new Map();
    const instByAddr = new Map();

    boxes.forEach(box => {
      const addr   = box.getAttribute('data-addr') || '';
      const canvas = box.querySelector('canvas');
      const inst   = canvas && (canvas.__chart || (typeof Chart !== 'undefined' ? Chart.getChart?.(canvas) : null));
      boxByAddr.set(addr, box);
      if (inst) instByAddr.set(addr, inst);
    });

    // Rebind chart handles AND refresh visible titles and colors
    SENSORS.forEach(s => {
      const addr = s.address || s.id || '';
      const box  = boxByAddr.get(addr);
      const inst = instByAddr.get(addr) || null;

      s.chart = inst;

      if (box) {
        box.setAttribute('data-addr', addr);
        const h3 = box.querySelector('h3');
        const want = s.label || '';
        if (h3 && h3.textContent !== want) h3.textContent = want; // alias over hex
      }

      if (inst && inst.data && inst.data.datasets && inst.data.datasets[0]) {
        const ds = inst.data.datasets[0];
        if (ds.borderColor !== s.col) ds.borderColor = s.col; // keep color in sync with slot
        inst.update('none');
      }
    });

    // Reorder boxes to EXACTLY match SENSORS order (admin order; avg first)
    const frag = document.createDocumentFragment();
    SENSORS.forEach(s => {
      const addr = s.address || s.id || '';
      const box  = boxByAddr.get(addr);
      if (box) frag.appendChild(box);
    });
    chartsEl.appendChild(frag);

    console.log('[charts] reuse canvas + refreshed labels/order', { key, count: chartsEl.children.length });
    return;   // ends the reuse branch
  }

  // ── Full rebuild when device/layout changed ──
  if (Array.isArray(window.__currentCharts)) {
    window.__currentCharts.forEach(c => { try { c.destroy(); } catch(_){} });
  }
  window.__currentCharts = [];

  if (chartsEl) chartsEl.innerHTML = '';
  initCharts(SENSORS);

  const canvases = chartsEl ? chartsEl.getElementsByTagName('canvas') : [];
  for (const cv of canvases) {
    if (cv && cv.__chart) window.__currentCharts.push(cv.__chart);
  }

  window.__chartsKey = key;
  console.log('[charts] rebuild canvas (new device/layout)', { key, count: canvases.length });
}


async function updateCharts(deviceID, SENSORS){
  if (__chartsInFlight) { __chartsQueued = true; return; }
      // ---- STALE DEVICE GUARD for "now" ranges ----
  // If the device's last activity is older than the selected window,
  // force-empty all series so offline trucks don't show spurious charts.
  if (selectedRangeMode === 'now') {
    const lastSeenMs = (typeof window.__lastSeenMs === 'number' && isFinite(window.__lastSeenMs)) ? window.__lastSeenMs : null;
    const windowMs   = selectedRangeMinutes * 60 * 1000;
    const isStale    = (lastSeenMs == null) || ((Date.now() - lastSeenMs) > windowMs);

    if (isStale) {
      const rng0 = document.getElementById('chartRange');
      if (rng0) rng0.textContent = '';
      SENSORS.forEach(s => {
        if (!s.chart) return;
        s.chart.data.labels = [];
        s.chart.data.datasets[0].data = [];
        delete s.chart.options.scales.y.min;
        delete s.chart.options.scales.y.max;
        s.chart.update('none');
      });
      return; // ← Nothing to render in this "now" window for a stale device
    }
  }
  
  __chartsInFlight = true;
  const __chartsT0 = performance.now();

  try{
    // --- 0) Guard: nothing to draw if no sensor addresses ---
    const addrs = SENSORS.filter(s => s.address).map(s => s.address);
    if (!addrs.length) {
      const rng0 = document.getElementById('chartRange');
      if (rng0) rng0.textContent = '';
      const avg0 = SENSORS.find(x => x.id === 'avg');
      if (avg0 && avg0.chart) {
        avg0.chart.data.labels = [];
        avg0.chart.data.datasets[0].data = [];
        delete avg0.chart.options.scales.y.min;
        delete avg0.chart.options.scales.y.max;
        avg0.chart.update('none');
      }
      return;
    }

    // --- 1) Compute window (absolute ms) ---
    let wndStart, wndEnd;
    if (selectedRangeMode === 'now') {
      wndEnd   = Date.now();
      wndStart = wndEnd - (selectedRangeMinutes * 60 * 1000);
    } else {
      // 'last' mode → anchor to freshest timestamp we actually have (across sensors)
            let tLast = -Infinity;

      // One quick pass to find newest timestamp across this truck’s selected addresses
      await ensureVarCache(deviceID);
      for (const addr of addrs) {
        const id = getVarIdCI(deviceID, addr);
        if (!id) continue;
        const r  = await fetch(`${UBIDOTS_V1}/variables/${id}/values/?page_size=1&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`);
        if (!r.ok) continue;
        const j  = await r.json();
        const ts = j?.results?.[0]?.timestamp;
        if (Number.isFinite(ts) && ts > tLast) tLast = ts;
      }

                    if (!Number.isFinite(tLast) || tLast === -Infinity) {
        // Fallback once: try v2 bulk last-values to get an anchor timestamp
        try {
          const bulk = await fetchDeviceLastValuesV2(deviceID); // /v2.0/devices/{id}/_/values/last
          if (bulk && typeof bulk === 'object') {
            for (const s of SENSORS) {
              if (!s.address) continue;
              const o = bulk[s.address];
              const ts = o?.timestamp;
              if (Number.isFinite(ts) && ts > tLast) {
                tLast = ts;
              }
            }
          }
        } catch (err) {
          console.warn('v2 bulk fallback failed', err);
        }

        if (!Number.isFinite(tLast) || tLast === -Infinity) {
          // No anchor at all → clear and exit
          SENSORS.forEach(s => {
            if (!s.chart) return;
            s.chart.data.labels = [];
            s.chart.data.datasets[0].data = [];
            delete s.chart.options.scales.y.min;
            delete s.chart.options.scales.y.max;
            s.chart.update('none');
          });
          const rng0 = document.getElementById('chartRange');
          if (rng0) rng0.textContent = '';
          return;
        }

        // We have an anchor from v2 — use a strict 60-minute window ending at tLast
        wndEnd   = tLast;
        wndStart = tLast - (60 * 60 * 1000);
      }


    // --- 2) Time-window fetch per variable (not by point count) ---
// STRICT per-device lookup with case-insensitive label resolution
async function fetchVarWindow(deviceID, varLabel, startMs, endMs, hardCap = 5000){
  await ensureVarCache(deviceID);

  // Case-insensitive map hit for THIS device
  const id = getVarIdCI(deviceID, varLabel);
  if (!id || typeof id !== 'string') return [];

  let url = `${UBIDOTS_V1}/variables/${id}/values/?page_size=1000&start=${startMs}&end=${endMs}&token=${UBIDOTS_ACCOUNT_TOKEN}`;
  const out = [];
  while (url) {
    const r = await fetch(url);
    if (!r.ok) break;
    const j = await r.json();
    const rows = j?.results || [];
    out.push(...rows);
    if (out.length >= hardCap) break;
    url = (j.next && typeof j.next === 'string') ? `${j.next}&token=${UBIDOTS_ACCOUNT_TOKEN}` : null;
  }
  return out;
}



    // Fetch time-windowed series for each sensor in parallel
    const seriesByAddr = new Map();
    await Promise.all(SENSORS.map(async s => {
      if (!s.address || !s.chart) return;
      const rows = await fetchVarWindow(deviceID, s.address, wndStart, wndEnd, /*cap*/ 20000);

// Strict in-window filter (defensive in case API returns out-of-range points),
// then ensure chronological order oldest..newest
const ordered = rows
  .filter(r => Number.isFinite(r?.timestamp) && r.timestamp >= wndStart && r.timestamp <= wndEnd)
  .sort((a,b) => a.timestamp - b.timestamp);

seriesByAddr.set(s.address, ordered);

    }));

    // --- 3) Render each sensor in-window (explicit window already enforced) ---
    SENSORS.forEach(s => {
      if (!s.address || !s.chart) return;
      const ordered = seriesByAddr.get(s.address) || [];
      const labels = ordered.map(r => fmtTimeHHMM(r.timestamp, 'Europe/London'));
      const data   = ordered.map(r => {
        let v = parseFloat(r.value);
        if (typeof s.calibration === 'number') v += s.calibration;
        return Number.isFinite(v) ? v : null;
      });

      s.chart.data.labels = labels;
      s.chart.data.datasets[0].data = data;

      const vals = data.filter(v => v != null && isFinite(v));
      if (vals.length) {
        const vmin = Math.min(...vals), vmax = Math.max(...vals);
        const pad  = Math.max(0.5, (vmax - vmin) * 0.10);
        s.chart.options.scales.y.min = vmin - pad;
        s.chart.options.scales.y.max = vmax + pad;
      } else {
        delete s.chart.options.scales.y.min;
        delete s.chart.options.scales.y.max;
      }
      s.chart.update('none');
    });

    // --- 4) Build & render "Chillrail Avg" over the exact same window ---
    (function(){
      const series = [];
      for (const s of SENSORS){
        if (!s.address) continue;
        const arr = seriesByAddr.get(s.address) || [];
        if (!arr.length) continue;
        const items = arr.map(r=>{
          let v = parseFloat(r.value);
          if (typeof s.calibration === 'number') v += s.calibration;
          return { ts: Math.floor(r.timestamp/60000)*60000, v: Number.isFinite(v) ? v : null };
        }).filter(o => o.v != null);
        if (items.length) series.push(items);
      }
      const bucketSet = new Set();
      series.forEach(arr => arr.forEach(o => bucketSet.add(o.ts)));
      const buckets = Array.from(bucketSet).sort((a,b)=>a-b);
      const maps = series.map(arr => {
        const m = new Map(); arr.forEach(o => m.set(o.ts, o.v)); return m;
      });
      const avgLabels = buckets.map(ts => fmtTimeHHMM(ts, 'Europe/London'));
      const avgData = buckets.map(ts => {
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
    })();

    // --- 5) Range banner: reflect actual min/max drawn in window ---
    let minTs = Infinity, maxTs = -Infinity;
    for (const s of SENSORS){
      if (!s.address) continue;
      const ord = seriesByAddr.get(s.address) || [];
      for (const r of ord){
        const ts = r.timestamp;
        if (!Number.isFinite(ts)) continue;
        if (ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
    }
    const rng = document.getElementById("chartRange");
    if (rng && isFinite(minTs) && isFinite(maxTs) && minTs <= maxTs) {
      const a=new Date(minTs), b=new Date(maxTs);
      const same = a.toDateString()===b.toDateString();
      const fmtD = d=>d.toLocaleDateString('en-GB', { year:'numeric', month:'short', day:'numeric', timeZone:'Europe/London' });
      const fmtT = d=>d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Europe/London' });
      rng.textContent = same ? `${fmtD(a)} · ${fmtT(a)}–${fmtT(b)}` : `${fmtD(a)} ${fmtT(a)} → ${fmtD(b)} ${fmtT(b)}`;
    } else if (rng) {
      rng.textContent = '';
    }
  } catch(e){
    console.error('updateCharts(windowed) error:', e);
  } finally {
    __chartsInFlight = false;
    // console.log('[updateCharts] done in', Math.round(performance.now()-__chartsT0), 'ms');
    if (__chartsQueued) { __chartsQueued = false; setTimeout(() => updateCharts(deviceID, SENSORS), 0); }
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

        // Compose timestamps list across all items we fetched
    const tsList = [];
    const pushTs = o => { if (o && o.timestamp && isFinite(o.timestamp)) tsList.push(o.timestamp); };
    ['signal','rssi','csq','volt','vbatt','battery','batt','iccid'].forEach(k => pushTs(bulk[k]));
    if (gpsObj) pushTs(gpsObj);
    for (const s of SENSORS){
      if (!s.address) continue;
      pushTs(bulk[s.address]);
    }

    // Compute the required time window
    let endTimeMs, startTimeMs;
    if (selectedRangeMode === 'now') {
      endTimeMs   = Date.now();
      startTimeMs = endTimeMs - (selectedRangeMinutes * 60 * 1000);
    } else {
      // 'last' mode: anchor to latest available timestamp across fetched items
      const tLast = tsList.length ? Math.max(...tsList) : Date.now();
      endTimeMs   = tLast;
      startTimeMs = tLast - (60 * 60 * 1000);
    }

    // Filter each value into the window; out-of-window → blank (null/undefined)
    const inWnd = ts => (isFinite(ts) && ts >= startTimeMs && ts <= endTimeMs);

    // Temps by address (keep only values whose timestamp is in window)
    const readingsInWindow = {};
    for (const s of SENSORS) {
      if (!s.address) continue;
      const obj = bulk[s.address];
      if (obj && inWnd(obj.timestamp)) {
        const v = parseFloat(obj.value);
        if (!Number.isNaN(v)) readingsInWindow[s.address] = v;
      }
    }

    // Radio/Power with window filter
    const valInWnd = k => {
      const o = bulk[k];
      return (o && inWnd(o.timestamp) && o.value != null && isFinite(o.value)) ? Number(o.value) : null;
    };
    const signalInWnd = valInWnd('signal') ?? valInWnd('rssi') ?? valInWnd('csq');
    const voltInWnd   = valInWnd('volt')   ?? valInWnd('vbatt') ?? valInWnd('battery') ?? valInWnd('batt');

    // ICCID only if in window
    const iccidInWnd = (bulk.iccid && inWnd(bulk.iccid.timestamp) && bulk.iccid.value != null)
      ? String(bulk.iccid.value) : null;

    // GPS only if its timestamp is in window
    let latInWnd = null, lonInWnd = null, speedInWnd = null;
    if (gpsObj && inWnd(gpsObj.timestamp)) {
      const c = gpsObj.context || {};
      const candLat = c.lat;
      const candLon = (c.lng!=null ? c.lng : c.lon);
      if (typeof candLat === 'number' && typeof candLon === 'number') {
        latInWnd = candLat;
        lonInWnd = candLon;
      }
      if (typeof c.speed === 'number') speedInWnd = c.speed;
    }
    // No stale carry-forward in KPI box:
    lastLat = null; lastLon = null; lastGpsAgeMin = null;

    // Resolve timezone using the (possibly in-window) GPS point
    const deviceLabel = document.getElementById("deviceSelect")?.value || null;
    const tz = await resolveDeviceTz(deviceLabel, latInWnd, lonInWnd);

      // Decide whether there is any in-window data at all
    const hasAny =
      Object.keys(readingsInWindow).length > 0 ||
      signalInWnd != null || voltInWnd != null ||
      (latInWnd != null && lonInWnd != null);

    // Panel timestamp:
    // - 'last' mode: always anchor to the found last-timestamp window (endTimeMs)
    // - 'now' mode: only show a timestamp if we actually have in-window data; else null
    const tsPanel = (selectedRangeMode === 'last') ? endTimeMs : (hasAny ? endTimeMs : null);


    drawLive({
      ts: tsPanel,
      iccid: iccidInWnd,
      lat: latInWnd, lon: lonInWnd,
      lastLat: null, lastLon: null, lastGpsAgeMin: null,
      speed:  speedInWnd,
      signal: signalInWnd,
      volt:   voltInWnd,
      tz,
      readings: readingsInWindow
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

   // Compute the required time window
  let endTimeMs, startTimeMs;
  if (selectedRangeMode === 'now') {
    endTimeMs   = Date.now();
    startTimeMs = endTimeMs - (selectedRangeMinutes * 60 * 1000);
  } else {
    // 'last' mode: anchor to latest timestamp among fetched items
    const candidates = [tsGps, tsIccid, tsSensorMax, tsSignal, tsVolt].filter(x => isFinite(x));
    const tLast = candidates.length ? Math.max(...candidates) : Date.now();
    endTimeMs   = tLast;
    startTimeMs = tLast - (60 * 60 * 1000);
  }
  const inWnd = ts => (isFinite(ts) && ts >= startTimeMs && ts <= endTimeMs);

  // Filter each value into the window; out-of-window → blank
  // Temps:
  const readingsInWindow = {};
  await Promise.all(SENSORS.filter(s => s.address).map(async s => {
    const v = await fetchUbidotsVar(deviceID, s.address, 1);
    if (v.length && v[0].value != null && inWnd(v[0].timestamp)) {
      const num = parseFloat(v[0].value);
      if (!Number.isNaN(num)) readingsInWindow[s.address] = num;
    }
  }));

  // Signal/Volt:
  const signalVal = (signalArr[0] && inWnd(signalArr[0].timestamp) && signalArr[0].value != null && isFinite(signalArr[0].value))
    ? Number(signalArr[0].value) : null;
  const voltVal   = (voltArr[0]   && inWnd(voltArr[0].timestamp)   && voltArr[0].value != null   && isFinite(voltArr[0].value))
    ? Number(voltArr[0].value) : null;

  // ICCID:
  const iccidVal = (iccArr[0] && inWnd(iccArr[0].timestamp) && iccArr[0].value != null)
    ? String(iccArr[0].value) : null;

  // GPS only if its timestamp is in window (no stale carry-forward)
  let latInWnd = null, lonInWnd = null, speedInWnd = null;
  if (gpsArr[0] && inWnd(gpsArr[0].timestamp)) {
    const c = gpsArr[0].context || {};
    if (typeof c.lat === 'number' && (typeof c.lng === 'number' || typeof c.lon === 'number')) {
      latInWnd = c.lat;
      lonInWnd = (c.lng != null ? c.lng : c.lon);
    }
    if (typeof c.speed === 'number') speedInWnd = c.speed;
  }
  lastLat = null; lastLon = null; lastGpsAgeMin = null;

  // Resolve timezone using in-window GPS point (may be null)
  const deviceLabel = document.getElementById("deviceSelect")?.value || null;
  const tz = await resolveDeviceTz(deviceLabel, latInWnd, lonInWnd);

    // Decide whether there is any in-window data at all
  const hasAny =
    Object.keys(readingsInWindow).length > 0 ||
    signalVal != null || voltVal != null ||
    (latInWnd != null && lonInWnd != null);

  // Panel timestamp:
  // - 'last' mode: anchor to the last data window
  // - 'now' mode: only if there is in-window data; else null (prevents “today” on offline)
  const tsPanel = (selectedRangeMode === 'last') ? endTimeMs : (hasAny ? endTimeMs : null);

  drawLive({
    ts: tsPanel,
    iccid: iccidVal,
    lat: latInWnd,
    lon: lonInWnd,
    lastLat: null,
    lastLon: null,
    lastGpsAgeMin: null,
    speed: speedInWnd,
    signal: signalVal,
    volt:  voltVal,
    tz,
    readings: readingsInWindow
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

  const rows = [];

  // Build 2-line Local Time derived **only** from the data window.
  // If no in-window data, show "—" (prevents showing today's date for offline devices).
  const tz = data.tz || 'Europe/London';
  if (ts && isFinite(ts)) {
    const localDate = new Date(ts).toLocaleDateString('en-GB', { timeZone: tz });
    const localTime = new Date(ts).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: tz
    });
    rows.push(["Local Time", `<div>${localDate}</div><div class="text-gray-500">${localTime}</div>`]);
  } else {
    rows.push(["Local Time", "—"]);
  }

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
// Case-insensitive per-device CSV/crumbs fetch by var label (hex)
async function fetchCsvRows(deviceID, varLabel, start, end, signal){
  try {
    await ensureVarCache(deviceID);
    const id = getVarIdCI(deviceID, varLabel);   // ← IMPORTANT: CI lookup
    if (!id) return [];

    let url  = `https://industrial.api.ubidots.com/api/v1.6/variables/${id}/values/?page_size=1000`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end)   url += `&end=${encodeURIComponent(end)}`;

    const init = {};
    if (signal) init.signal = signal;

    const res = await fetch(`${url}&${'token'}=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`, init);
    if (!res.ok) return [];
    const j = await res.json();
    return j?.results || [];
  } catch {
    return [];
  }
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
                 // Compute time window for breadcrumbs:
    // - NOW: [now - selectedRangeMinutes, now]
    // - LAST: [t_last - 60min, t_last], where t_last is the most recent GPS timestamp
    const gpsLabel = await resolveGpsLabel(deviceID);
    let gpsRows = [];
    let startTimeMs = null, endTimeMs = null;

    if (!gpsLabel) {
      // No GPS variable → nothing to draw
      return;
    }

    if (selectedRangeMode === 'now') {
      endTimeMs   = Date.now();
      startTimeMs = endTimeMs - (selectedRangeMinutes * 60 * 1000);
      gpsRows = await fetchCsvRows(deviceID, gpsLabel, startTimeMs, endTimeMs, __crumbSignal);
    } else {
      // 'last' mode: anchor to latest GPS value
      const lastGpsArr = await fetchUbidotsVar(deviceID, gpsLabel, 1);
      const tLast = lastGpsArr?.[0]?.timestamp || null;
      if (!tLast || !isFinite(tLast)) {
        // No GPS data at all → nothing to draw
        return;
      }
      endTimeMs   = tLast;
      startTimeMs = tLast - (60 * 60 * 1000);
      gpsRows = await fetchCsvRows(deviceID, gpsLabel, startTimeMs, endTimeMs, __crumbSignal);
    }




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
      const rows = await fetchCsvRows(deviceID, s.address, startTimeMs, endTimeMs, __crumbSignal);

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

  buttons.forEach(btn => {
    btn.onclick = async function(){
      // Visual selection
      buttons.forEach(b => { b.style.backgroundColor=''; b.style.color=''; });
      this.style.backgroundColor = '#10b981';
      this.style.color = '#ffffff';

      // Mode
      const modeAttr = (this.getAttribute('data-mode') || '').toLowerCase();
      const newMode  = (modeAttr === 'last') ? 'last' : 'now';

      // Range parsing (supports "1/3/12/24" as hours, "60/180" as minutes, "1h/90m")
      let newMinutes;
      if (newMode === 'now') {
        const raw = String(this.getAttribute('data-range') || '').trim();
        newMinutes = parseRangeToMinutes(raw);
      } else {
        newMinutes = 60; // fixed 60-min window for "last"
      }
      if (!Number.isFinite(newMinutes) || newMinutes <= 0) newMinutes = 60;

      // No-op guard
      if (selectedRangeMode === newMode && selectedRangeMinutes === newMinutes) return;

      // Commit selection
      selectedRangeMode    = newMode;
      selectedRangeMinutes = newMinutes;
      HIST_POINTS = selectedRangeMinutes; // harmless cap used elsewhere

      // Resolve device
      const devSel      = document.getElementById('deviceSelect');
      const deviceLabel = devSel?.value || Object.keys(window.__deviceMap || {})[0];
      const deviceID    = window.__deviceMap?.[deviceLabel]?.id;

      // Debug (fixes previous ReferenceError on "hours")
      console.debug('[range select]', {
        mode: selectedRangeMode,
        minutes: selectedRangeMinutes,
        hours: +(selectedRangeMinutes/60).toFixed(2)
      });

      // Refresh UI
      if (deviceID) {
        await poll(deviceID, SENSORS);           // KPI (window-aware)
        await updateCharts(deviceID, SENSORS);   // Charts (window-aware)
        const idle = window.requestIdleCallback || (fn => setTimeout(fn, 50));
        idle(() => updateBreadcrumbs(deviceID, selectedRangeMinutes)); // Map crumbs
      }
    };
  });

  function parseRangeToMinutes(raw){
    if (!raw) return 60;
    const m = raw.match(/^\s*(\d+(?:\.\d+)?)\s*([hm]?)\s*$/i);
    if (m) {
      const val  = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      if (unit === 'h') return Math.round(val * 60);
      if (unit === 'm') return Math.round(val);
      // No unit: treat small numbers (≤48) as hours, larger as minutes
      return (val <= 48) ? Math.round(val * 60) : Math.round(val);
    }
    const n = Number(raw);
    if (Number.isFinite(n)) return (n <= 48) ? Math.round(n * 60) : Math.round(n);
    return 60;
  }
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

   // 4) Resolve current device (robust against case/alias mismatches)
function __resolveSelectedDevice(sensorMap){
  const sel = document.getElementById('deviceSelect');
  let key = (sel && typeof sel.value === 'string') ? sel.value : null;

  // 4a) Direct hit
  if (key && sensorMap[key]?.id) {
    return { deviceLabel: key, deviceID: sensorMap[key].id };
  }

  // 4b) Case-insensitive match
  if (key) {
    const k2 = Object.keys(sensorMap).find(k => String(k).toLowerCase() === String(key).toLowerCase());
    if (k2 && sensorMap[k2]?.id) {
      return { deviceLabel: k2, deviceID: sensorMap[k2].id };
    }
  }

  // 4c) Fallback: first available
  const first = Object.keys(sensorMap)[0] || null;
  return { deviceLabel: first, deviceID: first ? sensorMap[first]?.id : null };
}

const { deviceLabel, deviceID } = __resolveSelectedDevice(sensorMap);

// DEBUG: show binding to ensure we’re fetching from the selected device
console.debug('[device binding]', { selected: document.getElementById('deviceSelect')?.value, deviceLabel, deviceID });


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
if (FORCE_VARCACHE_REFRESH) delete variableCache[deviceID]; // optional

if (deviceID) {
  // Discovered addresses for this device
  const discovered = await fetchDallasAddresses(deviceID);

  // Prefer admin-declared addresses (stable chart count per truck)
  const adminAddrs = getAdminAddresses(deviceLabel);
  const liveDallas = (Array.isArray(adminAddrs) && adminAddrs.length > 0)
    ? adminAddrs
    : (Array.isArray(discovered) ? discovered : []);

  console.debug('[addresses]', {
    deviceLabel, deviceID,
    adminCount: adminAddrs.length,
    finalCount: liveDallas.length,
    liveDallas
  });

  // Build chart slots and render
  SENSORS = buildSensorSlots(deviceLabel, liveDallas, sensorMapConfig);
  ensureCharts(SENSORS, deviceID);   // key on unique deviceID
  initMap();                         // idempotent
  await poll(deviceID, SENSORS);     // KPI / quick last values
  await updateCharts(deviceID, SENSORS);  // windowed history
  await renderMaintenanceBox(deviceLabel, deviceID);

  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 50));
  idle(() => { updateBreadcrumbs(deviceID, selectedRangeMinutes); });
} else {
  console.error('Device ID not found for', deviceLabel);
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
// --- Final override: ensure alias lookup is case-insensitive everywhere ---
(function(){
  function getDisplayNameCI(deviceLabel){
    if (!deviceLabel) return deviceLabel;

    const aliases = (sensorMapConfig && sensorMapConfig.__aliases) || aliasMap || {};
    // 1) Exact match
    if (aliases[deviceLabel]) {
      const v = String(aliases[deviceLabel]).trim();
      if (v) return v;
    }
    // 2) Case-insensitive match (handles "skycafe-warehouse" vs "skycafe-Warehouse")
    const want = String(deviceLabel).toLowerCase();
    for (const k in aliases){
      if (Object.prototype.hasOwnProperty.call(aliases, k) &&
          String(k).toLowerCase() === want){
        const v = String(aliases[k]).trim();
        if (v) return v;
      }
    }

    // 3) Fallbacks into sensorMapConfig
    const cfg = sensorMapConfig || {};
    if (cfg[deviceLabel]?.label && String(cfg[deviceLabel].label).trim()) {
      return String(cfg[deviceLabel].label).trim();
    }
    const k2 = Object.keys(cfg).find(x => String(x).toLowerCase() === want);
    if (k2 && cfg[k2]?.label && String(cfg[k2].label).trim()) {
      return String(cfg[k2].label).trim();
    }

    return deviceLabel;
  }
  // Force the global reference used by all call sites to this CI version.
  window.getDisplayName = getDisplayNameCI;
})();

// EOF




