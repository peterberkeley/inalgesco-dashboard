//Part 1
let _maintenanceLogged = false;

/* =================== Config =================== */
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";   // devices via v2.0
const UBIDOTS_V1   = "https://industrial.api.ubidots.com/api/v1.6";   // variables via v1.6 (CORS-safe)
/** Static base for non-GPS trucks (2250 E Riverview Dr, Unit 100, Phoenix AZ). */
const STATIC_BASE = { lat: 33.4377, lon: -112.0276 };

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
let __breadcrumbsFixed = false;  // prevents auto-refresh when true

// Unified selection epoch — increment on any user selection that should cancel in-flight work
let __selEpoch = 0;
function bumpSelEpoch(){
  // increment based on the public mirror to avoid any drift
  const cur = Number(window.__selEpoch);
  __selEpoch = Number.isFinite(cur) ? (cur + 1) : (__selEpoch + 1);
  window.__selEpoch = __selEpoch;
}
// Expose for console/tests (bind directly; no wrapper)
window.__selEpoch = 0;
window.bumpSelEpoch = bumpSelEpoch;


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
// --- Admin helpers: ICCID and identity-fencing ---
function getAdminIccid(deviceLabel){
  // Pull an ICCID string from the Admin map if present (used to fence wrong publishers)
  const m = getAdminMapFor(deviceLabel);
  const v = m && typeof m.iccid === 'string' ? m.iccid.trim() : null;
  return v && v.length ? v : null;
}
// Return latest ICCID for a device (prefer v2 bulk; fallback to v1.6)
async function fetchDeviceIccid(deviceID){
  // v2 bulk: fastest
  try {
    const bulk = await fetchDeviceLastValuesV2(deviceID);
    if (bulk && bulk.iccid && bulk.iccid.value != null) {
      return String(bulk.iccid.value).trim();
    }
  } catch (_) {}

  // v1.6 fallback
  try {
    await ensureVarCache(deviceID);
    const id = getVarIdCI(deviceID, 'iccid') || await resolveVarIdStrict(deviceID, 'iccid');
    if (!id) return null;

    const r = await fetch(
      `${UBIDOTS_V1}/variables/${encodeURIComponent(id)}/values/?page_size=1&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`
    );
    if (!r.ok) return null;

    const j = await r.json();
    const v = j?.results?.[0]?.value;
    return (v != null) ? String(v).trim() : null;
  } catch (_) {
    return null;
  }
}

// Compare Admin ICCID (if present) vs latest ICCID; return true/false or null if unknown
async function iccidMatchesAdmin(deviceLabel, deviceID){
  const want = getAdminIccid(deviceLabel);
  if (!want) return null; // no Admin ICCID configured
  const got = await fetchDeviceIccid(deviceID);
  if (!got)  return null; // device hasn't published ICCID (yet)
  return String(want).trim() === String(got).trim();
}

/* === Device binding by ICCID (for LAST-mode/offline trucks) === */
async function findDeviceByIccid(targetIccid, sensorMap){
  const want = String(targetIccid || '').trim();
  if (!want) return null;
  const entries = Object.entries(sensorMap || window.__deviceMap || {});
  for (const [label, info] of entries){
    const id = info && info.id;
    if (!id) continue;
    try{
      const icc = await fetchDeviceIccid(id); // v2-bulk first, v1.6 fallback inside
      if (icc && String(icc).trim() === want) {
        return { deviceLabel: label, deviceID: id };
      }
    }catch(_){}
  }
  return null;
}
window.findDeviceByIccid = findDeviceByIccid;




/** Decide whether to suppress auto-discovered Dallas addresses to avoid
 *  showing another truck's live data.
 *  Rule:
 *   - If the device has NO admin-mapped sensors AND appears Offline (v2 Devices)
 *     AND we have no heartbeat variables (signal/volt/gps) to corroborate activity,
 *     and the current view is 'now' → suppress discovery (show nothing).
 */
async function shouldSuppressAutoDallas(deviceLabel, deviceID, isOnline){
  // If Admin mapping exists, allow (we know which addresses belong to this truck)
  if (getAdminAddresses(deviceLabel).length > 0) return false;

  // Only gate the NOW view; for LAST we load strictly by device's own variables anyway
  if (selectedRangeMode !== 'now') return false;

  // If Admin ICCID is configured, require a match (regardless of Online)
  const adminICC = getAdminIccid(deviceLabel);
  if (adminICC) {
    const match = await iccidMatchesAdmin(deviceLabel, deviceID);
    // Unknown ICCID or mismatch? Be conservative: suppress to avoid cross-truck illusion
    return (match !== true);
  }

  // No Admin ICCID configured:
  // - Allow auto discovery only if the device is Online (recent activity).
  // - If Offline, suppress discovery (we can't prove identity).
  if (!isOnline) return true;

  return false;
}
/** While Offline, treat admin-mapped sensors as trusted only if we can prove identity via ICCID.
 * Online -> always allow. Offline -> require admin ICCID present AND matching the device ICCID.
 * Fail-closed otherwise (prevents ghost charts).
 */
async function shouldUseAdminDallas(deviceLabel, deviceID, isOnline){
  if (isOnline) return true;
  const adminICC = getAdminIccid(deviceLabel);
  if (!adminICC) return false;                // no identity configured → don't trust
  const match = await iccidMatchesAdmin(deviceLabel, deviceID);
  return match === true;                      // only if we can *prove* identity
}
window.shouldUseAdminDallas = shouldUseAdminDallas;

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
    window.sensorMapConfig = sensorMapConfig;  // ensure global reference restored
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
  // Only early-return if we actually have entries for this device
  if (variableCache[deviceID] && Object.keys(variableCache[deviceID]).length > 0) return;

  const url = `${UBIDOTS_V1}/variables/?device=${encodeURIComponent(deviceID)}&page_size=1000&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
  try{
    const rs = await fetch(url);
    if(!rs.ok){ variableCache[deviceID] = {}; return; }
    const jl = await rs.json();

    const map = {};
    (jl.results || []).forEach(v => {
      const lab = String(v.label || "");
      if (!map[lab]) map[lab] = String(v.id); // first-seen id per label
    });

    variableCache[deviceID] = map;
  }catch(e){
    console.error("ensureVarCache", e);
    // allow a retry next time instead of “empty forever”
    delete variableCache[deviceID];
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
// ---------------------------------------------------------------------
// Strict per-device resolver (does NOT rely on the global cache)
// Confirms the variable's owning device matches `deviceID`.
// ---------------------------------------------------------------------
async function resolveVarIdStrict(deviceID, varLabel){
  const want = String(varLabel).toLowerCase();
  const url  = `${UBIDOTS_V1}/variables/?device=${encodeURIComponent(deviceID)}&page_size=1000&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();

    const match = (j.results || []).find(v => {
      const lbl = String(v.label || '').toLowerCase();
      if (lbl !== want) return false;

      // v.device is typically like "/api/v1.6/devices/<id>/" – prefer to double-check
      const devUrl = v && typeof v.device === 'string' ? v.device : null;
      if (!devUrl) return true; // accept if API didn’t include device link (already filtered by ?device=)
      const m = devUrl.match(/\/devices\/([^/]+)\//);
      const ownerId = m ? m[1] : null;
      return ownerId === String(deviceID);
    });

    return match ? String(match.id) : null;
  } catch (e) {
    console.warn('resolveVarIdStrict: device-filtered lookup failed', e);
    return null;
  }
}

// ---------------------------------------------------------------------
// Fetch the newest timestamp (ms) for a variable ID (v1.6 endpoint)
// ---------------------------------------------------------------------
async function fetchLastTsV1(varId){
  const r = await fetch(`${UBIDOTS_V1}/variables/${encodeURIComponent(varId)}/values/?page_size=1&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`);
  if (!r.ok) return null;
  const j = await r.json();
  return (j?.results && j.results[0]?.timestamp) || null;
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
// Unified LAST anchor computation used by both poll() and updateCharts().
// Strategy: v2 bulk first (single request), then parallel v1.6 fallback.
async function computeLastAnchorMs(deviceID, SENSORS){
  let tLast = -Infinity;

  // 1) Try v2 bulk once
  try {
    const bulk = await fetchDeviceLastValuesV2(deviceID);
    if (bulk && typeof bulk === 'object') {
      for (const s of SENSORS) {
        if (!s.address) continue;
        const o = bulk[s.address];
        const ts = o && o.timestamp;
        if (Number.isFinite(ts) && ts > tLast) tLast = ts;
      }
    }
  } catch (_) { /* ignore */ }

  // 2) Parallel v1.6 fallback
  if (!Number.isFinite(tLast) || tLast === -Infinity) {
    await ensureVarCache(deviceID);
    const addrs = SENSORS.filter(s => s.address).map(s => s.address);
    const ids   = await Promise.all(addrs.map(a => resolveVarIdStrict(deviceID, a)));
    const tsArr = await Promise.all(ids.map(id => id ? fetchLastTsV1(id) : null));
    for (const ts of tsArr) {
      if (Number.isFinite(ts) && ts > tLast) tLast = ts;
    }
  }

  return Number.isFinite(tLast) ? tLast : null;
}
// Expose for console/tests and to ensure global visibility in Safari
window.computeLastAnchorMs = computeLastAnchorMs;

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
// Unified LAST anchor computation used by both poll() and updateCharts().
// Strategy: v2 bulk first (single request), then parallel v1.6 fallback.
async function computeLastAnchorMs(deviceID, SENSORS){
  let tLast = -Infinity;

  // 1) Try v2 bulk once
  try {
    const bulk = await fetchDeviceLastValuesV2(deviceID);
    if (bulk && typeof bulk === 'object') {
      for (const s of SENSORS) {
        if (!s.address) continue;
        const o = bulk[s.address];
        const ts = o && o.timestamp;
        if (Number.isFinite(ts) && ts > tLast) tLast = ts;
      }
    }
  } catch (_) { /* ignore */ }

  // 2) Parallel v1.6 fallback
  if (!Number.isFinite(tLast) || tLast === -Infinity) {
    await ensureVarCache(deviceID);
    const addrs = SENSORS.filter(s => s.address).map(s => s.address);
    const ids   = await Promise.all(addrs.map(a => resolveVarIdStrict(deviceID, a)));
    const tsArr = await Promise.all(ids.map(id => id ? fetchLastTsV1(id) : null));
    for (const ts of tsArr) {
      if (Number.isFinite(ts) && ts > tLast) tLast = ts;
    }
  }

  return Number.isFinite(tLast) ? tLast : null;
}
// Expose for console/tests and to ensure global visibility in Safari
window.computeLastAnchorMs = computeLastAnchorMs;



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
  { // stale-call guard: if user changed dropdown mid-fetch, abort this run
    const selNow = document.getElementById('deviceSelect')?.value || null;
    const idNow  = window.__deviceMap?.[selNow]?.id || null;
    if (idNow && deviceID && idNow !== deviceID) return;

  }

     // ── LOCK ONLY: prevent overlapping repaints; no pre-wipe ──
    if (__chartsInFlight) { __chartsQueued = true; return; }
  __chartsInFlight = true;
  const __chartsT0 = performance.now();
  const __epochAtStart = Number(window.__selEpoch) || 0;

  try{

    // --- 0) Guard: nothing to draw if no sensor addresses ---
        // --- 0) Guard: nothing to draw if no sensor addresses ---
    const addrs = SENSORS.filter(s => s.address).map(s => s.address);
    if (!addrs.length) {
      // Do NOT clear charts here; keep last visible data.
      const rng0 = document.getElementById('chartRange');
      if (rng0) rng0.textContent = '';
      return;
    }


      // --- 1) Compute window (absolute ms) ---
    let wndStart, wndEnd;
    if (selectedRangeMode === 'now') {
      wndEnd   = Date.now();
      wndStart = wndEnd - (selectedRangeMinutes * 60 * 1000);
              } else {
      // --- 'last' mode: anchor strictly to the selected device's freshest timestamp ---
      let tLast = -Infinity;

           // A) Prefer v2 bulk last-values (single request) to determine tLast
      try {
        const bulk = await fetchDeviceLastValuesV2(deviceID);
        if (bulk && typeof bulk === 'object') {
          for (const s of SENSORS) {
            if (!s.address) continue;
            const o = bulk[s.address];
            const ts = o && o.timestamp;
            if (Number.isFinite(ts) && ts > tLast) tLast = ts;
          }
        }
      } catch (_) {
        // ignore; fall through to v1.6 parallel fallback
      }

      // B) If still unknown, resolve in PARALLEL via v1.6 (ids + newest row)
      if (!Number.isFinite(tLast) || tLast === -Infinity) {
        await ensureVarCache(deviceID);
        // Resolve IDs in parallel
        const ids = await Promise.all(
          addrs.map(a => resolveVarIdStrict(deviceID, a))
        );
        // Fetch newest timestamps in parallel
        const tsList = await Promise.all(
          ids.map(id => id ? fetchLastTsV1(id) : null)
        );
        for (const ts of tsList) {
          if (Number.isFinite(ts) && ts > tLast) tLast = ts;
        }
      }

                   // 3) No anchor → clear charts and exit (prevents painting another device's data)
            // 3) No anchor → keep previous draw and exit
      if (!Number.isFinite(tLast) || tLast === -Infinity) {
        const rng0 = document.getElementById('chartRange');
        if (rng0) rng0.textContent = '';
        // Do NOT clear charts; leave last datasets visible.
        return;
      }


      // 3b) Sanity guard (RELAXED for LAST mode):
      // We never blank in LAST mode. LAST uses strict per-device var IDs and a fixed tLast window,
      // so stale v2 last_seen is not a reason to suppress charts here.
      try {
        if (selectedRangeMode !== 'last') {
          const nowSec = Math.floor(Date.now() / 1000);
          // Use last_seen for the actual deviceID we are rendering
          let lastSeenSecV2 = 0;
          try {
            const entries = Object.entries(window.__deviceMap || {});
            const hit = entries.find(([,info]) => info && info.id === deviceID);
            lastSeenSecV2 = hit ? (hit[1].last_seen || 0) : 0;
          } catch (_){}
          const tLastAgeSec = Math.floor((Date.now() - tLast) / 1000);

          const STALE_V2_SEC = 48 * 3600;
          const FRESH_ANCHOR = 6  * 3600;

          const v2Stale   = lastSeenSecV2 && ((nowSec - lastSeenSecV2) > STALE_V2_SEC);
          const anchorNew = (tLastAgeSec >= 0) && (tLastAgeSec < FRESH_ANCHOR);

          if (v2Stale && anchorNew) {
            console.warn('[sanity] NOW: v2 last_seen stale + fresh anchor — blanking to avoid cross-truck illusion.');
            const rng0 = document.getElementById('chartRange');
            if (rng0) rng0.textContent = '';
            SENSORS.forEach(s => {
              if (!s?.chart) return;
              s.chart.data.labels = [];
              s.chart.data.datasets[0].data = [];
              delete s.chart.options.scales.y.min;
              delete s.chart.options.scales.y.max;
              s.chart.update('none');
            });
            return;
          }
        }
      } catch (_) {}



           // 4) Fixed 60-min window ending at tLast
      wndEnd   = tLast;
      wndStart = tLast - (60 * 60 * 1000);
    } // ← CLOSE the `else { ... }` block for selectedRangeMode !== 'now'

       // --- 2) Fetch series: window for NOW, last-N for LAST ---

    // STRICT per-device lookup with case-insensitive label resolution
    async function fetchVarWindow(deviceID, varLabel, startMs, endMs, hardCap = 5000){
      await ensureVarCache(deviceID);
      let id = getVarIdCI(deviceID, varLabel);
      if (!id) id = await resolveVarIdStrict(deviceID, varLabel);
      if (!id) return [];

      let url = `${UBIDOTS_V1}/variables/${encodeURIComponent(id)}/values/?page_size=1000&start=${startMs}&end=${endMs}&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
      const out = [];
      while (url) {
        const r = await fetch(url);
        if (!r.ok) break;
        const j = await r.json();
        const rows = j?.results || [];
        out.push(...rows);
        if (out.length >= hardCap) break;
        url = (j.next && typeof j.next === 'string') ? `${j.next}&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}` : null;
      }
      return out;
    }

    // NEW: fetch newest N values with no time window (for LAST view)
    async function fetchVarLastN(deviceID, varLabel, hardCap = 2000){
      await ensureVarCache(deviceID);
      let id = getVarIdCI(deviceID, varLabel);
      if (!id) id = await resolveVarIdStrict(deviceID, varLabel);
      if (!id) return [];

      let url = `${UBIDOTS_V1}/variables/${encodeURIComponent(id)}/values/?page_size=1000&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
      const out = [];
      while (url) {
        const r = await fetch(url);
        if (!r.ok) break;
        const j = await r.json();
        const rows = j?.results || [];
        out.push(...rows);
        if (out.length >= hardCap) break;
        url = (j.next && typeof j.next === 'string') ? `${j.next}&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}` : null;
      }
      return out;
    }

             // Fetch series: window for NOW, fixed 60-min for LAST
    const seriesByAddr = new Map();

    if (selectedRangeMode === 'last') {
      // LAST = strictly the anchored 60-min window [wndStart, wndEnd]
      await Promise.all(SENSORS.map(async s => {
        if (!s.address || !s.chart) return;

        // Request only the window → faster + correct
        const rows = await fetchVarWindow(
          deviceID, s.address, wndStart, wndEnd, /*hardCap*/ 4000
        );

        const ordered = rows
          .map(r => {
            const ts  = +r.timestamp;
            const val = (r.value != null) ? +r.value : null;
            return { ...r, timestamp: ts, value: val };
          })
          .filter(r => Number.isFinite(r.timestamp) &&
                       r.timestamp >= wndStart && r.timestamp <= wndEnd)
          .sort((a,b) => a.timestamp - b.timestamp);

        seriesByAddr.set(s.address, ordered);
      }));
    } else {
  // NOW = explicit time window [wndStart, wndEnd]
  await Promise.all(SENSORS.map(async s => {
    if (!s.address || !s.chart) return;

    // PATCH: fetch newest N values then filter locally into the window.
    // This avoids v1.6 ?start/&end returning empty sets on your account.
    const rows = await fetchVarLastN(
      deviceID,
      s.address,
      /*hardCap*/ 4000
    );

    const ordered = rows
      .map(r => {
        const ts  = +r.timestamp;
        const val = (r.value != null) ? +r.value : null;
        return { ...r, timestamp: ts, value: val };
      })
      .filter(r =>
        Number.isFinite(r.timestamp) &&
        r.timestamp >= wndStart && r.timestamp <= wndEnd
      )
      .sort((a,b) => a.timestamp - b.timestamp);

    seriesByAddr.set(s.address, ordered);
  }));
}

  
    // --- 3) Render each sensor in-window (explicit window already enforced) ---
    // Abort if selection changed while fetching series
    if ((Number(window.__selEpoch) || 0) !== __epochAtStart) return;

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
    { // stale-call guard: if user changed dropdown mid-fetch, abort this run
    const selNow = document.getElementById('deviceSelect')?.value || null;
    const idNow  = window.__deviceMap?.[selNow]?.id || null;
    if (idNow && deviceID && idNow !== deviceID) return;
  }
  const __epochAtStart = Number(window.__selEpoch) || 0;
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
    // 'last' mode: use unified anchor (v2 bulk first, then v1.6 parallel)
    const tLast = await computeLastAnchorMs(deviceID, SENSORS);
    endTimeMs   = tLast ?? Date.now();
    startTimeMs = endTimeMs - (60 * 60 * 1000);
    }
// ---- LAST-mode sanity gate (RELAXED): never blank in LAST.
// We already anchor to a fixed [tLast-60m, tLast] and use strict per-device var IDs.
if (selectedRangeMode === 'last') {
  // No-op: do not suppress draw in LAST mode.
} else {
  // Keep the protection for NOW mode only.
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    // Use last_seen for the actual deviceID we are rendering (not the dropdown label)
    let lastSeenSecV2 = 0;
    try {
      const entries = Object.entries(window.__deviceMap || {});
      const hit = entries.find(([,info]) => info && info.id === deviceID);
      lastSeenSecV2 = hit ? (hit[1].last_seen || 0) : 0;
    } catch (_) {}
    const tLastAgeSec = Math.floor((Date.now() - endTimeMs) / 1000);

    const v2Stale     = lastSeenSecV2 && ((nowSec - lastSeenSecV2) > (48 * 3600));
    const anchorFresh = (tLastAgeSec >= 0) && (tLastAgeSec < (6 * 3600));

    if (v2Stale && anchorFresh) {
      console.warn('[sanity] NOW: v2 last_seen stale + fresh anchor — suppressing draw.');
      const rng0 = document.getElementById('chartRange'); if (rng0) rng0.textContent = '';
      SENSORS.forEach(s => {
        if (!s.chart) return;
        s.chart.data.labels = [];
        s.chart.data.datasets[0].data = [];
        delete s.chart.options.scales.y.min;
        delete s.chart.options.scales.y.max;
        s.chart.update('none');
      });
      return;
    }
  } catch (_) {}
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

    // Read ICCID (ignore timestamp for identity check)
const iccidNow = (bulk.iccid && bulk.iccid.value != null) ? String(bulk.iccid.value).trim() : null;

// --- Identity fence for NOW view: use Admin ICCID if available
try {
  const selectedLabel = document.getElementById("deviceSelect")?.value || null;
  const adminIcc = getAdminIccid(selectedLabel);
  if (adminIcc && selectedRangeMode === 'now') {
    const want = String(adminIcc).trim();
    let got = iccidNow;
    if (!got) got = await fetchDeviceIccid(deviceID); // fallback if bulk didn't carry it
    if (got && want !== String(got).trim()) {
      console.warn('[identity] ICCID mismatch for', selectedLabel, 'admin=', want, 'now=', got, '— suppressing draw.');
      const rng0 = document.getElementById('chartRange'); 
      if (rng0) rng0.textContent = 'ICCID mismatch — data hidden';

      // Clear charts immediately
      SENSORS.forEach(s => {
        if (!s.chart) return;
        s.chart.data.labels = [];
        s.chart.data.datasets[0].data = [];
        delete s.chart.options.scales.y.min;
        delete s.chart.options.scales.y.max;
        s.chart.update('none');
      });
      return; // stop fast path
    }
  }
} catch (_) {}


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
// Keep last-known GPS age for fallback; drawLive shows "(last known)"
if (tsGps) lastGpsAgeMin = Math.round((Date.now() - tsGps) / 60000);


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
    // Abort if selection changed while we were fetching
    if ((Number(window.__selEpoch) || 0) !== __epochAtStart) return;


    drawLive({
  ts: tsPanel,
  iccid: iccidNow,
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
         // 'last' mode: use unified anchor
      const tLast = await computeLastAnchorMs(deviceID, SENSORS);
      endTimeMs   = tLast ?? Date.now();
      startTimeMs = endTimeMs - (60 * 60 * 1000);
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
  // Latest ICCID value (ignore timestamp for identity check)
const iccidVal = (iccArr[0] && iccArr[0].value != null) ? String(iccArr[0].value).trim() : null;

// Identity fence (fallback path, NOW view)
try {
  const selectedLabel = document.getElementById("deviceSelect")?.value || null;
  const adminIcc = getAdminIccid(selectedLabel);
  if (adminIcc && selectedRangeMode === 'now') {
    const want = String(adminIcc).trim();
    const got  = iccidVal || (await fetchDeviceIccid(deviceID));
    if (got && want !== String(got).trim()) {
      console.warn('[identity] ICCID mismatch for', selectedLabel, 'admin=', want, 'now=', got, '— suppressing draw.');
      const rng0 = document.getElementById('chartRange'); 
      if (rng0) rng0.textContent = 'ICCID mismatch — data hidden';
      SENSORS.forEach(s => {
        if (!s.chart) return;
        s.chart.data.labels = [];
        s.chart.data.datasets[0].data = [];
        delete s.chart.options.scales.y.min;
        delete s.chart.options.scales.y.max;
        s.chart.update('none');
      });
      return;
    }
  }
} catch (_) {}


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

// Keep last-known GPS age for label (used by drawLive to show “(last known)”)
// Do NOT null-out lastLat/lastLon here; they may hold the previous valid GPS.
if (tsGps) lastGpsAgeMin = Math.round((Date.now() - tsGps) / 60000);


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
  // Abort if selection changed while we were fetching
  if ((Number(window.__selEpoch) || 0) !== __epochAtStart) return;

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
// Lightweight KPIs/map draw for LAST mode (no poll): v2 bulk + unified tLast anchor
async function drawKpiLast(deviceID, SENSORS){
  try{
    // 1) Compute unified anchor and window
    const tLast = await computeLastAnchorMs(deviceID, SENSORS);
    const endTimeMs   = tLast ?? Date.now();
    const startTimeMs = endTimeMs - (60 * 60 * 1000);

    // 2) Try one v2 bulk fetch for KPIs/map
    const bulk = await fetchDeviceLastValuesV2(deviceID);
    if (!bulk) return; // no-op; charts already rendered

    const inWnd = ts => (isFinite(ts) && ts >= startTimeMs && ts <= endTimeMs);

    // Temps by address in window
    const readingsInWindow = {};
    for (const s of SENSORS){
      if (!s.address) continue;
      const o = bulk[s.address];
      if (o && inWnd(o.timestamp) && o.value != null && isFinite(o.value)){
        readingsInWindow[s.address] = Number(o.value);
      }
    }

    // Signal/Volt in window
    const pick = k => {
      const o = bulk[k];
      return (o && inWnd(o.timestamp) && o.value != null && isFinite(o.value)) ? Number(o.value) : null;
    };
    const signalInWnd = pick('signal') ?? pick('rssi') ?? pick('csq');
    const voltInWnd   = pick('volt')   ?? pick('vbatt') ?? pick('battery') ?? pick('batt');

    // GPS in window
    const gpsObj = bulk.gps || bulk.position || bulk.location || null;
    let latInWnd=null, lonInWnd=null, speedInWnd=null;
    if (gpsObj && inWnd(gpsObj.timestamp)) {
      const c = gpsObj.context || {};
      if (typeof c.lat === 'number' && (typeof c.lng === 'number' || typeof c.lon === 'number')){
        latInWnd = c.lat; lonInWnd = (c.lng != null ? c.lng : c.lon);
      }
      if (typeof c.speed === 'number') speedInWnd = c.speed;
    }

    // Resolve tz from the in-window GPS if present
    const deviceLabel = document.getElementById("deviceSelect")?.value || null;
    const tz = await resolveDeviceTz(deviceLabel, latInWnd, lonInWnd);

    // ICCID (for display)
    const iccidNow = (bulk.iccid && bulk.iccid.value != null) ? String(bulk.iccid.value).trim() : null;

    // 3) Draw KPIs/map once (no Phoenix flash; breadcrumbs will refine map path)
    drawLive({
      ts: endTimeMs,
      iccid: iccidNow,
      lat: latInWnd, lon: lonInWnd,
      lastLat: null, lastLon: null, lastGpsAgeMin: null,
      speed: speedInWnd,
      signal: signalInWnd,
      volt:   voltInWnd,
      tz,
      readings: readingsInWindow
    }, SENSORS);
  }catch(e){
    console.warn('drawKpiLast failed', e);
  }
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
  .filter(s => s.address && s.id !== 'avg' && s.label !== 'Chillrail Avg')
  .filter(s => readings && readings[s.address] != null)        // hide empty rows
  .map(s => [ s.label, fmt(readings[s.address] + (s.calibration || 0), 1) ]);


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

   // --- Place map pin with full fallback logic ---
  try { initMap(); } catch (_) {}
  if (!map || typeof map.addLayer !== 'function' || !marker) return;

  const isValid = (v) => (v != null && isFinite(v) && Math.abs(v) > 0.0001);

  const haveFresh = isValid(lat) && isValid(lon);
  const haveLast  = isValid(lastLat) && isValid(lastLon);

  let target = null;
  let zoom   = 13;
  let tooltipNote = '';

  if (haveFresh) {
    target = [lat, lon];
    zoom   = Math.max(map.getZoom(), 13);
  } else if (haveLast) {
    target = [lastLat, lastLon];
    zoom   = Math.max(map.getZoom(), 12);
    tooltipNote = '(last known)';
  } else {
    // No GPS data ever for this truck → show Phoenix static base
       target = [STATIC_BASE.lat, STATIC_BASE.lon];
    zoom   = Math.max(map.getZoom(), 12);
    tooltipNote = '(SkyCafè PHX)';
    console.info('[map] Using static base location (Phoenix) for non-GPS truck');
  }

  // Ensure marker visible and positioned
  if (target) {
    if (!map.hasLayer(marker)) marker.addTo(map);
    marker.setOpacity(1);
    marker.setLatLng(target);
    marker.bindTooltip(tooltipNote, { direction:'top', offset:[0,-8] }).openTooltip();
    map.setView(target, zoom);
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
async function fetchCsvRows(deviceID, varLabel, start, end, signal) {
  try {
    // Special handling for GPS/position variables - merge from all sources
    if (varLabel === 'position' || varLabel === 'gps' || varLabel === 'location') {
      console.log('[fetchCsvRows] GPS request - merging all position variables');
      
      // Get ALL variables for this device
      const varsUrl = `${UBIDOTS_V1}/variables/?device=${encodeURIComponent(deviceID)}&page_size=1000&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
      const varsResp = await fetch(varsUrl, signal ? { signal } : {});
      
      if (!varsResp.ok) {
        console.error('[fetchCsvRows] Failed to fetch variables list');
        return [];
      }
      
      const varsData = await varsResp.json();
      
      // Find ALL position/gps/location variables
      const gpsVars = (varsData.results || []).filter(v => 
        v.label === 'position' || v.label === 'gps' || v.label === 'location'
      );
      
      console.log(`[fetchCsvRows] Found ${gpsVars.length} GPS variables to check`);
      
      if (gpsVars.length === 0) {
        console.warn('[fetchCsvRows] No GPS variables found for device');
        return [];
      }
      
      // Fetch data from ALL GPS variables
      const allResults = [];
      let varCount = 0;
      
      for (const gpsVar of gpsVars) {
        // Build URL with timestamps
        let varUrl = `${UBIDOTS_V1}/variables/${gpsVar.id}/values/?page_size=1000`;
        
        // Add time parameters if provided
        if (start !== undefined && start !== null) {
          const startMs = Math.floor(Number(start));
          if (isFinite(startMs) && startMs > 0) {
            varUrl += `&start=${startMs}`;
          }
        }
        
        if (end !== undefined && end !== null) {
          const endMs = Math.floor(Number(end));
          if (isFinite(endMs) && endMs > 0) {
            varUrl += `&end=${endMs}`;
          }
        }
        
        varUrl += `&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
        
        try {
          const varResp = await fetch(varUrl, signal ? { signal } : {});
          
          if (varResp.ok) {
            const varData = await varResp.json();
            
            if (varData.results && varData.results.length > 0) {
              console.log(`[fetchCsvRows] Variable ${gpsVar.id.substring(0,8)}... (${gpsVar.label}): ${varData.results.length} points`);
              allResults.push(...varData.results);
              varCount++;
            }
          }
        } catch (e) {
          if (e.name === 'AbortError') {
            console.log('[fetchCsvRows] Request aborted');
            return [];
          }
          console.warn(`[fetchCsvRows] Error fetching ${gpsVar.id}:`, e.message);
        }
      }
      
      console.log(`[fetchCsvRows] Fetched data from ${varCount} variables, total ${allResults.length} points`);
      
      // Sort by timestamp (oldest first)
      allResults.sort((a, b) => a.timestamp - b.timestamp);
      
      // Deduplicate based on timestamp and location
      const uniqueResults = [];
      const seen = new Set();
      
      allResults.forEach(point => {
        const lat = point.context?.lat;
        const lng = point.context?.lng || point.context?.lon;
        
        // Only include points with valid coordinates
        if (lat != null && lng != null) {
          const key = `${point.timestamp}_${lat}_${lng}`;
          
          if (!seen.has(key)) {
            seen.add(key);
            uniqueResults.push(point);
          }
        }
      });
      
      console.log(`[fetchCsvRows] After deduplication: ${uniqueResults.length} unique GPS points`);
      
      // Apply time range filter if needed
      if ((start || end) && uniqueResults.length > 0) {
        const filtered = uniqueResults.filter(r => {
          const ts = r.timestamp;
          if (!ts || !isFinite(ts)) return false;
          if (start && ts < start) return false;
          if (end && ts > end) return false;
          return true;
        });
        
        if (filtered.length !== uniqueResults.length) {
          console.log('[fetchCsvRows] Time filter removed', uniqueResults.length - filtered.length, 'points outside range');
        }
        
        return filtered;
      }
      
      return uniqueResults;
    }
    
    // ========== ORIGINAL LOGIC FOR NON-GPS VARIABLES ==========
    // For temperature sensors and other non-GPS variables
    
    // Ensure variable cache is loaded
    await ensureVarCache(deviceID);
    
    // Get variable ID with case-insensitive lookup
    let id = getVarIdCI(deviceID, varLabel);
    
    // If not found in cache, try strict resolver
    if (!id) {
      console.log('[fetchCsvRows] Variable not in cache, using strict resolver for:', varLabel);
      id = await resolveVarIdStrict(deviceID, varLabel);
    }
    
    // No variable ID found - return empty array
    if (!id) {
      console.warn('[fetchCsvRows] No variable ID found for label:', varLabel);
      return [];
    }

    // Build the URL with proper timestamp parameters
    let url = `${UBIDOTS_V1}/variables/${encodeURIComponent(id)}/values/?page_size=1000`;
    
    // CRITICAL FIX: Ensure timestamps are integers (milliseconds)
    if (start !== undefined && start !== null) {
      // Convert to integer milliseconds
      const startMs = Math.floor(Number(start));
      if (isFinite(startMs) && startMs > 0) {
        url += `&start=${startMs}`;
        console.log('[fetchCsvRows] Start time:', new Date(startMs).toISOString());
      }
    }
    
    if (end !== undefined && end !== null) {
      // Convert to integer milliseconds
      const endMs = Math.floor(Number(end));
      if (isFinite(endMs) && endMs > 0) {
        url += `&end=${endMs}`;
        console.log('[fetchCsvRows] End time:', new Date(endMs).toISOString());
      }
    }
    
    // Add token
    url += `&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`;
    
    console.log('[fetchCsvRows] Fetching:', { 
      deviceID, 
      varLabel, 
      varId: id,
      start: start ? new Date(start).toISOString() : 'none',
      end: end ? new Date(end).toISOString() : 'none'
    });

    // Setup fetch options with abort signal if provided
    const fetchOptions = {};
    if (signal) {
      fetchOptions.signal = signal;
    }

    // Fetch the data
    const res = await fetch(url, fetchOptions);
    
    if (!res.ok) {
      console.error('[fetchCsvRows] HTTP error:', res.status, res.statusText);
      return [];
    }
    
    const json = await res.json();
    const results = json?.results || [];
    
    console.log('[fetchCsvRows] Retrieved', results.length, 'rows for', varLabel);
    
    // Additional validation: ensure timestamps are within requested range
    if ((start || end) && results.length > 0) {
      const filtered = results.filter(r => {
        const ts = r.timestamp;
        if (!ts || !isFinite(ts)) return false;
        if (start && ts < start) return false;
        if (end && ts > end) return false;
        return true;
      });
      
      if (filtered.length !== results.length) {
        console.warn('[fetchCsvRows] Filtered out', results.length - filtered.length, 'out-of-range rows');
      }
      
      return filtered;
    }
    
    return results;
    
  } catch (error) {
    // Handle abort separately (not an error)
    if (error.name === 'AbortError') {
      console.log('[fetchCsvRows] Request aborted for:', varLabel);
      return [];
    }
    
    console.error('[fetchCsvRows] Error fetching data:', error);
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
  const __epochAtStart = Number(window.__selEpoch) || 0;
  
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
      // No GPS variable at all → show static base pin and stop
      try { initMap(); } catch(_) {}
      if (map && marker) {
        marker.setLatLng([STATIC_BASE.lat, STATIC_BASE.lon]);
        marker.bindTooltip('(SkyCafè PHX)', { direction:'top', offset:[0,-8] }).openTooltip();
        map.setView([STATIC_BASE.lat, STATIC_BASE.lon], Math.max(map.getZoom(), 12));
      }
      return;
    }
    
    if (selectedRangeMode === 'now') {
      endTimeMs   = Date.now();
      startTimeMs = endTimeMs - (selectedRangeMinutes * 60 * 1000);
      gpsRows = await fetchCsvRows(deviceID, gpsLabel, startTimeMs, endTimeMs, __crumbSignal);
      
      // === ADAPTIVE GPS LOGIC STARTS HERE (NEW) ===
      if ((!gpsRows || gpsRows.length === 0)) {
        console.log(`[breadcrumbs] No GPS in selected ${rangeMinutes}min, checking for historical data...`);
        
        // Get the variable ID for GPS
        const varId = variableCache[deviceID]?.[gpsLabel];
        if (varId) {
          try {
            // Check for most recent GPS point
            const lastPointUrl = `https://industrial.api.ubidots.com/api/v1.6/variables/${varId}/values/?page_size=1&token=${UBIDOTS_ACCOUNT_TOKEN}`;
            const lastResp = await fetch(lastPointUrl, { signal: __crumbSignal });
            const lastData = await lastResp.json();
            
            if (lastData.results && lastData.results.length > 0) {
              const lastTimestamp = lastData.results[0].timestamp;
              const ageHours = (Date.now() - lastTimestamp) / (1000 * 60 * 60);
              
              // Only use adaptive if data is within 24 hours
              if (ageHours <= 24) {
                console.log(`[breadcrumbs] Found GPS data from ${ageHours.toFixed(1)}h ago, fetching historical window...`);
                
                // Fetch a window around the last known activity
                const historicalEnd = Math.min(lastTimestamp + (30 * 60 * 1000), Date.now());
                const historicalStart = historicalEnd - (selectedRangeMinutes * 60 * 1000);
                
                gpsRows = await fetchCsvRows(deviceID, gpsLabel, historicalStart, historicalEnd, __crumbSignal);
                
                if (gpsRows && gpsRows.length > 0) {
                  console.log(`[breadcrumbs] Adaptive fetch successful: ${gpsRows.length} historical points`);
                  showHistoricalBreadcrumbNotice(ageHours);
                  
                  // Update time window for temperature data to match GPS window
                  startTimeMs = historicalStart;
                  endTimeMs = historicalEnd;
                }
              } else {
                console.log(`[breadcrumbs] Last GPS is ${ageHours.toFixed(1)}h old (>24h), skipping adaptive`);
              }
            }
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.error('[breadcrumbs] Adaptive fetch error:', error);
            }
          }
        }
      }
      // === ADAPTIVE GPS LOGIC ENDS HERE ===
      
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
    
    // Abort if selection changed while fetching breadcrumbs
    if ((Number(window.__selEpoch) || 0) !== __epochAtStart) return;
    
    const gpsPoints = gpsRows
      .filter(r => r.context && r.context.lat != null && r.context.lng != null)
      .sort((a,b) => a.timestamp - b.timestamp);
    
    if(!gpsPoints.length){
      // No points in this window: clear crumbs but DO NOT reposition.
      // drawLive() will keep the last-known GPS point (or nothing).
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
    
    // ... rest of your existing function continues here unchanged ...

// Add this helper function right after updateBreadcrumbs ends:

function showHistoricalBreadcrumbNotice(hoursAgo) {
  // Remove any existing notice
  const existingNotice = document.getElementById('breadcrumb-history-notice');
  if (existingNotice) existingNotice.remove();
  
  const notice = document.createElement('div');
  notice.id = 'breadcrumb-history-notice';
  notice.style.cssText = `
    position: fixed;
    top: 100px;
    right: 20px;
    background: #fef3c7;
    border: 1px solid #f59e0b;
    color: #78350f;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    z-index: 1000;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    display: flex;
    align-items: center;
    gap: 10px;
    animation: slideIn 0.3s ease-out;
  `;
  
  notice.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/>
    </svg>
    <span>Showing GPS from ${Math.floor(hoursAgo)}h ${Math.round((hoursAgo % 1) * 60)}m ago</span>
    <button onclick="this.parentElement.remove()" style="
      margin-left: auto;
      background: none;
      border: none;
      color: #78350f;
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 0 4px;
    ">&times;</button>
  `;
  
  document.body.appendChild(notice);
  
  // Add animation if not already present
  if (!document.getElementById('breadcrumb-animation-style')) {
    const style = document.createElement('style');
    style.id = 'breadcrumb-animation-style';
    style.textContent = `
      @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }
  
  // Auto-remove after 8 seconds
  setTimeout(() => {
    const n = document.getElementById('breadcrumb-history-notice');
    if (n) {
      n.style.transition = 'all 0.3s ease-out';
      n.style.transform = 'translateX(100%)';
      n.style.opacity = '0';
      setTimeout(() => n.remove(), 300);
    }
  }, 8000);
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
       __breadcrumbsFixed = true;  // freeze breadcrumbs after user selection
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
  if (sel) sel.addEventListener("change", () => {
    try { window.bumpSelEpoch(); } catch(_) {}
    __breadcrumbsFixed = false;  // allow new breadcrumbs for new device
    updateAll();
  });
});
// === INSERT ↓ (helpers used by LAST-mode selection) =========================
async function __countRowsFast(deviceID, varLabel, maxPages = 3){
  try{
    await ensureVarCache(deviceID);
    let vid = getVarIdCI(deviceID, varLabel);
    if (!vid) vid = await resolveVarIdStrict(deviceID, varLabel);
    if (!vid) return 0;

    const token = encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN);
    let url = `${UBIDOTS_V1}/variables/${encodeURIComponent(vid)}/values/?page_size=1000&token=${token}`;
    let n = 0, p = 0;
    while (url && p < maxPages) {
      const r = await fetch(url);
      if (!r.ok) break;
      const j = await r.json();
      n += (j?.results?.length || 0);
      url = (j.next && typeof j.next === 'string') ? `${j.next}&token=${token}` : null;
      p++;
    }
    return n;
  }catch{ return 0; }
}

async function __topHexByRows(deviceID, k = 3){
  await ensureVarCache(deviceID);
  const caps = variableCache[deviceID] || {};
  const hexLabs = Object.keys(caps).filter(l => /^[0-9a-fA-F]{16}$/.test(l));
  const rows = [];
  for (const lab of hexLabs){
    rows.push({ lab, n: await __countRowsFast(deviceID, lab, 4) }); // ~4k sample per label
  }
  rows.sort((a,b)=>b.n-a.n);
  return rows.slice(0, Math.max(1,k)).map(x=>x.lab);
}


// === INSERT ↑ ===============================================================
// New: pick top hex labels by newest timestamp (no pagination, 1 row per label)
async function __topHexByNewestTs(deviceID, k = 3){
  await ensureVarCache(deviceID);
  const caps = variableCache[deviceID] || {};
  const hexLabs = Object.keys(caps).filter(l => /^[0-9a-fA-F]{16}$/.test(l));
  if (!hexLabs.length) return [];

  const token = encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN);
  // Resolve varIds once (CI map already built)
  const pairs = await Promise.all(hexLabs.map(async lab => {
    let vid = getVarIdCI(deviceID, lab);
    if (!vid) vid = await resolveVarIdStrict(deviceID, lab);
    return { lab, vid: vid || null };
  }));

  // Fetch newest ts per id in parallel (page_size=1)
  const tsList = await Promise.all(pairs.map(async ({lab, vid}) => {
    if (!vid) return { lab, ts: -Infinity };
    try{
      const r = await fetch(`${UBIDOTS_V1}/variables/${encodeURIComponent(vid)}/values/?page_size=1&token=${token}`);
      if (!r.ok) return { lab, ts: -Infinity };
      const j = await r.json();
      const ts = j?.results?.[0]?.timestamp;
      return { lab, ts: Number.isFinite(ts) ? ts : -Infinity };
    }catch(_){
      return { lab, ts: -Infinity };
    }
  }));

  tsList.sort((a,b) => (b.ts - a.ts));
  return tsList
    .filter(x => Number.isFinite(x.ts) && x.ts > 0)
    .slice(0, Math.max(1, k))
    .map(x => x.lab);
}
// Expose for console/tests
window.__topHexByNewestTs = __topHexByNewestTs;


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
function __resolveSelectedDevice(sensorMap){
  const sel = document.getElementById('deviceSelect');
  let key = (sel && typeof sel.value === 'string') ? sel.value : null;

  // Direct hit by key
  if (key && sensorMap[key]?.id) {
    return { deviceLabel: key, deviceID: sensorMap[key].id };
  }

  // Case-insensitive match
  if (key) {
    const k2 = Object.keys(sensorMap).find(k => String(k).toLowerCase() === String(key).toLowerCase());
    if (k2 && sensorMap[k2]?.id) {
      return { deviceLabel: k2, deviceID: sensorMap[k2].id };
    }
  }

  // NO FALLBACK — prevent binding to “first device”
  return { deviceLabel: key, deviceID: null };
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

      // --- Choose the actual device to fetch data from ---
// default = the selected dropdown device
let dataDeviceID    = deviceID;
let dataDeviceLabel = deviceLabel;

/**
 * LAST-mode robust selector:
 * 1) If Admin ICCID exists AND matches the selected device → keep selected.
 * 2) Else if Admin ICCID exists but mismatch → rebind by ICCID (if found).
 * 3) Else (no Admin ICCID): pick the device that actually holds the most rows
 *    for the first admin-mapped Dallas address (fast heuristic).
 */
try {
  if (selectedRangeMode === 'last') {
    const adminICC = getAdminIccid(deviceLabel);
    if (adminICC) {
      const match = await iccidMatchesAdmin(deviceLabel, deviceID); // true | false | null
      if (match !== true) {
        const rebound = await findDeviceByIccid(adminICC, window.__deviceMap);
        if (rebound && rebound.deviceID) {
          console.warn('[rebind] ICCID-bound device for', deviceLabel, '→', rebound.deviceLabel, rebound.deviceID);
          dataDeviceID    = rebound.deviceID;
          dataDeviceLabel = rebound.deviceLabel;
        }
      }
        } else {
      // PATCH: disable automatic row-count rebinding — keep current device.
      const adminAddrs = getAdminAddresses(deviceLabel) || [];
      const targetAddr = adminAddrs[0] || null;

      if (targetAddr) {
        // Optional: quick diagnostic only (do not change deviceID)
        try {
          const token = encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN);
          await ensureVarCache(dataDeviceID);
          let vid = getVarIdCI(dataDeviceID, targetAddr);
          if (!vid) vid = await resolveVarIdStrict(dataDeviceID, targetAddr);
          if (vid) {
            const r = await fetch(`${UBIDOTS_V1}/variables/${encodeURIComponent(vid)}/values/?page_size=1&token=${token}`);
            const ok = r.ok;
            console.debug('[rebind-check]', deviceLabel, targetAddr, ok ? 'ok' : 'no data');
          }
        } catch (e) {
          console.warn('[rebind-check failed]', e);
        }
      }
      // Always keep current selection (no automatic jump)
      console.warn('[rebind skipped] keeping', deviceLabel, '→', dataDeviceLabel);
    }

  }
} catch (_){}





 // 6) Render everything for the selected device
if (FORCE_VARCACHE_REFRESH) delete variableCache[deviceID]; // optional

if (deviceID) {
  // 6) Discovered addresses for this device — recompute per device
  let discovered = [];
  try {
    const suppress = await shouldSuppressAutoDallas(deviceLabel, dataDeviceID, isOnline);
    if (!suppress) {
      discovered = await fetchDallasAddresses(dataDeviceID);
    } else {
      console.warn('[gating] Suppressing auto-discovered Dallas for', deviceLabel, '(Offline + no admin mapping, NOW view)');
    }
  } catch (e) {
    console.warn('Dallas discovery failed for', deviceLabel, e);
  }

  // Prefer admin-declared; else discovered (rules vary by mode, keep NOW safe)
  const adminAddrs = getAdminAddresses(deviceLabel) || [];
  let liveDallas = [];

  let adminOK = false;
  try {
    adminOK = adminAddrs.length > 0 && await shouldUseAdminDallas(deviceLabel, dataDeviceID, isOnline);
  } catch (_) { adminOK = false; }

    if (selectedRangeMode === 'last') {
    if (adminAddrs.length) {
      // Health check: if Admin labels are effectively empty (~2 rows each), fall back
      const counts = await Promise.all(adminAddrs.map(a => __countRowsFast(dataDeviceID, a, 2)));
           // Health check (no pagination): newest timestamp per admin label
      const token = encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN);
      async function __latestTsForLabel(devId, lab){
        try{
          await ensureVarCache(devId);
          let vid = getVarIdCI(devId, lab);
          if (!vid) vid = await resolveVarIdStrict(devId, lab);
          if (!vid) return -Infinity;
          const r = await fetch(`${UBIDOTS_V1}/variables/${encodeURIComponent(vid)}/values/?page_size=1&token=${token}`);
          if (!r.ok) return -Infinity;
          const j = await r.json();
          const ts = j?.results?.[0]?.timestamp;
          return Number.isFinite(ts) ? ts : -Infinity;
        }catch(_){ return -Infinity; }
      }
      const tsList = await Promise.all(adminAddrs.map(a => __latestTsForLabel(dataDeviceID, a)));
      const FRESH_MS = 48 * 3600 * 1000; // 48h window for admin map freshness
      const nowMs = Date.now();
      const stale = tsList.every(ts => !Number.isFinite(ts) || (nowMs - ts) > FRESH_MS);

      liveDallas = stale
        ? await __topHexByNewestTs(dataDeviceID, adminAddrs.length || 3)
        : adminAddrs;

      console.warn('[LAST select]', { adminAddrs, tsList, stale, liveDallas });

    }
  } else {
    // NOW: keep identity/online safety
    if (adminOK) {
      liveDallas = adminAddrs;
    } else if (isOnline && Array.isArray(discovered) && discovered.length > 0) {
      liveDallas = discovered;
    } else {
      console.warn('[Dallas gating] No trusted sensors for', deviceLabel, '→ skip charts');
      liveDallas = [];
    }
  }


  console.debug('[addresses]', {
    deviceLabel, deviceID: dataDeviceID,
    adminCount: adminAddrs.length,
    discoveredCount: Array.isArray(discovered) ? discovered.length : 0,
    finalCount: liveDallas.length,
    mode: selectedRangeMode,
    liveDallas
  });

    SENSORS = buildSensorSlots(deviceLabel, liveDallas, sensorMapConfig);
  ensureCharts(SENSORS, dataDeviceID);      // key on the actual data device
  initMap();                                // idempotent

  if (selectedRangeMode === 'last') {
    // LAST mode — skip poll(); draw charts first, then KPIs/map via drawKpiLast
    await updateCharts(dataDeviceID, SENSORS);
    await drawKpiLast(dataDeviceID, SENSORS);
  } else {
    // NOW mode — normal fast KPI + charts
    await poll(dataDeviceID, SENSORS);
    await updateCharts(dataDeviceID, SENSORS);
  }

  await renderMaintenanceBox(deviceLabel, dataDeviceID);


  const idle = window.requestIdleCallback || (fn => setTimeout(fn, 50));
  if (!__breadcrumbsFixed) {
    idle(() => { updateBreadcrumbs(dataDeviceID, selectedRangeMinutes); });
  }
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
  ov.style.cssText = [
    'display:none',
    'position:fixed',
    'inset:0',
    'z-index:9999',              // ↑ ensure overlay beats any Leaflet panes
    'background:#fff',
    'box-sizing:border-box'
  ].join(';');

  ov.innerHTML = `
    <button id="mapClose"
            class="bg-gray-700 hover:bg-gray-800 text-white font-semibold py-1 px-3 rounded"
            style="position:absolute;top:12px;right:12px;z-index:10000">
      Close
    </button>
    <div id="mapAll"
         style="position:absolute;left:0;right:0;top:50px;bottom:0;
                width:100%;height:calc(100% - 50px);"></div>
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
  const ov  = document.getElementById('mapAllOverlay');
  const div = document.getElementById('mapAll');
  if (!ov || !div) return;

  // Show overlay
  ov.style.display = 'block';

  // Lock background scroll while overlay is open
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';

  // Lazily create the Leaflet map instance for the overlay
  if (!(mapAll && typeof mapAll.addLayer === 'function')) {
  mapAll = L.map('mapAll').setView([33.4377, -112.0276], 10);  // Center on Phoenix
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(mapAll);
    mapAllLayerGroup = L.layerGroup().addTo(mapAll);
  } else {
    mapAllLayerGroup.clearLayers();
  }
  // Reset legend if it exists
  if (mapAllLegend) { try { mapAll.removeControl(mapAllLegend); } catch(_){} mapAllLegend = null; }

  // *** Force Leaflet to recalc container size after becoming visible ***
  try {
    if (mapAll && typeof mapAll.invalidateSize === 'function') {
      // microtask + macrotask to cover different paint timings
      Promise.resolve().then(() => mapAll.invalidateSize(true));
      setTimeout(() => mapAll.invalidateSize(true), 0);
    }
  } catch(_) {}

  // Fetch devices list (v2) with ids + last_seen
  const sensorMap = await fetchSensorMapConfig();
  const entries   = Object.entries(sensorMap);
  if (!entries.length) return;

  // Activity window and containers
  const nowSec = Math.floor(Date.now()/1000);
  const cutoffMs = Date.now() - (48 * 60 * 60 * 1000); // 48h window
  const boundsLatLngs = [];
  let plotted = 0, skippedNoCoord = 0, skippedOld = 0;

  // For each device, try latest GPS point first, then device.location
  for (const [devLabel, info] of entries) {
    const deviceID = info?.id;
    if (!deviceID) continue;

   // 1) Coordinates: prefer freshest GPS point; else device.location; else v2 bulk gps/position/location
let lat = null, lon = null;

// A) Try the device’s GPS variable (v1.6) – may be stale but still carries coords
try {
  const gpsLab = await resolveGpsLabel(deviceID);
  if (gpsLab) {
    const rows = await fetchUbidotsVar(deviceID, gpsLab, 1);
    const r = rows && rows[0];
    const g = r && r.context;
    if (g && typeof g.lat === 'number' && (typeof g.lng === 'number' || typeof g.lon === 'number')) {
      lat = g.lat;
      lon = (g.lng != null ? g.lng : g.lon);
    }
  }
} catch(_) {}

// B) If still missing, try devices.v2 location
if (lat == null || lon == null) {
  try {
    const loc = await fetchDeviceLocationV2(deviceID);
    if (loc && typeof loc.lat === 'number' && typeof loc.lon === 'number') {
      lat = loc.lat; lon = loc.lon;
    }
  } catch(_) {}
}

// C) If still missing, try v2 bulk last-values for gps/position/location
if (lat == null || lon == null) {
  try {
    const bulk = await fetchDeviceLastValuesV2(deviceID);
    const g = (bulk && (bulk.gps || bulk.position || bulk.location)) || null;
    const c = g && g.context || null;
    if (c && typeof c.lat === 'number' && (typeof c.lng === 'number' || typeof c.lon === 'number')) {
      lat = c.lat;
      lon = (c.lng != null ? c.lng : c.lon);
    }
  } catch(_) {}
}


    // 2) Activity gate: v2 last_seen OR v1.6 heartbeat/GPS fallback (48h window)
let lastSeenSec = info?.last_seen || 0;
let lastSeenMs  = lastSeenSec ? (lastSeenSec * 1000) : 0;

// If v2 is stale, fall back to heartbeat (signal/volt) and GPS timestamps (v1.6)
if (!lastSeenMs || lastSeenMs < cutoffMs) {
  async function __heartbeatFreshMs(devId){
    let best = 0;
    try{
      await ensureVarCache(devId);
      const caps = variableCache[devId] || {};
      const hbLabs = ['signal','rssi','csq','volt','vbatt','battery','batt'];

      // Radio/power heartbeats
      for (const lab of hbLabs){
        const vid = caps[lab];
        if (!vid) continue;
        const r = await fetch(`${UBIDOTS_V1}/variables/${encodeURIComponent(vid)}/values/?page_size=1&token=${encodeURIComponent(UBIDOTS_ACCOUNT_TOKEN)}`);
        if (!r.ok) continue;
        const j  = await r.json();
        const ts = j?.results?.[0]?.timestamp || 0;
        if (Number.isFinite(ts) && ts > best) best = ts;
      }

      // GPS (if present)
      const gpsLab = await resolveGpsLabel(devId);
      if (gpsLab){
        const rows = await fetchUbidotsVar(devId, gpsLab, 1);
        const ts   = rows?.[0]?.timestamp || 0;
        if (Number.isFinite(ts) && ts > best) best = ts;
      }
    }catch(_){}
    return best; // 0 if none found
  }

  const hbMs = await __heartbeatFreshMs(deviceID);
  if (hbMs && hbMs > lastSeenMs) {
    lastSeenMs  = hbMs;
    lastSeenSec = Math.floor(hbMs / 1000);
  }
}

// If we have no coordinates at all, we cannot place a marker
const hasCoord = (typeof lat === 'number' && isFinite(lat) &&
                  typeof lon === 'number' && isFinite(lon));
if (!hasCoord) { skippedNoCoord++; continue; }

// Drop only if unified recency (v2 or fallback) is older than 48 h
// Show ALL trucks regardless of age
// if (!lastSeenMs || lastSeenMs < cutoffMs) { skippedOld++; continue; }


    // Online/offline coloring from last_seen
    const isOnline = (nowSec - lastSeenSec) < ONLINE_WINDOW_SEC;
    const color = isOnline ? '#16a34a' : '#9ca3af';

    const disp = getDisplayName(devLabel);
  const uploadedStr = lastSeenMs 
      ? new Date(lastSeenMs).toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: false })
      : 'No recent data';
    
    // Calculate age for display
    const ageStr = lastSeenMs 
      ? (() => {
          const hours = Math.round((Date.now() - lastSeenMs) / (1000 * 60 * 60));
          if (hours < 24) return `${hours}h ago`;
          const days = Math.round(hours / 24);
          return `${days} day${days === 1 ? '' : 's'} ago`;
        })()
      : 'Unknown';

    const mk = L.circleMarker([lat, lon], {
      radius: 7,
      color,
      fillColor: color,
      weight: 2,
      opacity: 1,
      fillOpacity: 0.9
    })
  .bindTooltip(`<strong>${disp}</strong><br>Last seen: ${ageStr}<br><small>${uploadedStr}</small>`, { direction:'top', offset:[0,-10] })
    .addTo(mapAllLayerGroup);

    mk.on('click', () => {
      const sel = document.getElementById('deviceSelect');
      if (sel) {
        sel.value = devLabel;
        sel.dispatchEvent(new Event('change', { bubbles:true }));
      }
      closeMapAll();
    });

    boundsLatLngs.push([lat, lon]);
    plotted++;
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

  // ──────────────────────────────
  // SAFE ASCII-ONLY DIAGNOSTIC LOG
  // ──────────────────────────────
  try {
    const summary = {
      plotted: plotted,
      skipped_no_coord: skippedNoCoord,
      skipped_old: skippedOld,
      cutoffMs: new Date(cutoffMs).toISOString()
    };
    console.log('[mapAll] ' + JSON.stringify(summary, null, 2));
  } catch (e) {
    console.warn('[mapAll] diagnostic log failed:', e);
  }
}

/** Close overlay */
function closeMapAll(){
  const ov = document.getElementById('mapAllOverlay');
  if (ov) ov.style.display = 'none';

  // Restore background scroll when overlay closes
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
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
/* === HOTFIX: make resolveVarIdStrict device-scoped (CT5999 vs Warehouse2) === */
(function(){
  const V1 = window.UBIDOTS_V1 || 'https://industrial.api.ubidots.com/api/v1.6';
  const getToken = () => window.UBIDOTS_ACCOUNT_TOKEN || window.UBIDOTS_TOKEN || '';
  const withTokenQS = (url) => `${url}${url.includes('?')?'&':'?'}token=${encodeURIComponent(getToken())}`;
  const authHeaders = () => (getToken() ? { 'X-Auth-Token': getToken() } : {});

  // Device -> Map<label -> varId>
  window.__varMapByDevice = window.__varMapByDevice || new Map();

  async function buildVarMapForDevice(devId){
    const cached = window.__varMapByDevice.get(devId);
    if (cached && cached.byLabel && cached.byLabel.size) return cached.byLabel;

    const url = `${V1}/variables/?device=${encodeURIComponent(devId)}&page_size=1000`;
    const res = await fetch(withTokenQS(url), { headers: authHeaders() });
    const j = await res.json();
    const list = (j && j.results) ? j.results : [];

    const byLabel = new Map();
    for (const v of list) byLabel.set(String(v.label || ''), String(v.id));
    window.__varMapByDevice.set(devId, { byLabel, ts: Date.now() });
    return byLabel;
  }

  // Preserve the original for rollback
  const orig = window.resolveVarIdStrict;
  window.__resolveVarIdStrict_orig = orig;

  // New device-scoped resolver
  window.resolveVarIdStrict = async function(devId, label){
    if (!devId || !label) return null;
    try {
      const byLabel = await buildVarMapForDevice(devId);
      const vid = byLabel.get(String(label)) || null;
      if (vid) return vid;

      // fallback to original if not found
      if (typeof orig === 'function') return await orig.call(this, devId, label);
      return null;
    } catch (e) {
      if (typeof orig === 'function') return await orig.call(this, devId, label);
      return null;
    }
  };
  
})();

/* ────────────────────────────────────────────────
   Anti-Phoenix Map Shim
   Suppresses static Phoenix map jump when a non-warehouse
   device (e.g., 5999 / skycafe-1) is in LAST mode, has no
   admin Dallas sensors, and no GPS coordinates in this draw.
   Map still updates normally once GPS data appears.
   ──────────────────────────────────────────────── */

(function installNoMapLastShim() {
  const L = window.L;
  if (!L || !L.Map || !L.Marker) return console.error('[shim] Leaflet not found');
  if (window.drawLive?.__shimmedOnceGPS) return;

  const orig = window.drawLive;
  if (typeof orig !== 'function') return console.error('[shim] drawLive not found');

  function hasAdminDallas() {
    const label = document.getElementById('deviceSelect')?.value || '';
    const a = (window.getAdminAddresses?.(label) || []).filter(h => /^[0-9a-fA-F]{16}$/.test(h));
    return a.length > 0;
  }

  function isWarehouse() {
    const label = (document.getElementById('deviceSelect')?.value || '').toLowerCase();
    return /warehouse/.test(label);
  }

  function hasGPS(d) {
    const lat = d?.lat, lon = d?.lon, lastLat = d?.lastLat, lastLon = d?.lastLon;
    return (typeof lat === 'number' && isFinite(lat) && typeof lon === 'number' && isFinite(lon)) ||
           (typeof lastLat === 'number' && isFinite(lastLat) && typeof lastLon === 'number' && isFinite(lastLon));
  }

  window.drawLive = function drawLive_shim(data, SENSORS) {
    const shouldShim =
      window.selectedRangeMode === 'last' &&
      !isWarehouse() &&
      !hasAdminDallas() &&
      !hasGPS(data);

    if (!shouldShim) return orig.call(this, data, SENSORS);

    const MP = L.Map.prototype, MkP = L.Marker.prototype;
    const sV = MP.setView, pT = MP.panTo, fT = MP.flyTo, fB = MP.fitBounds,
          mV = MP._move, rV = MP._resetView, sLL = MkP.setLatLng;
    const noOp = function(){ return this; };
    MP.setView = MP.panTo = MP.flyTo = MP.fitBounds = noOp;
    if (mV) MP._move = noOp;
    if (rV) MP._resetView = noOp;
    MkP.setLatLng = noOp;

    try {
      return orig.call(this, data, SENSORS);
    } finally {
      MP.setView = sV;
      MP.panTo = pT;
      MP.flyTo = fT;
      MP.fitBounds = fB;
      if (mV) MP._move = mV;
      if (rV) MP._resetView = rV;
      MkP.setLatLng = sLL;
    }
  };

  window.drawLive.__shimmedOnceGPS = true;
  console.info('[shim] Anti-Phoenix map guard active: only suppresses LAST with 0 admin + no GPS.');
})();

// EOF



