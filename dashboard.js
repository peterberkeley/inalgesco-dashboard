let _maintenanceLogged = false;

/* =================== Config =================== */
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";

let REFRESH_INTERVAL = 60_000;      // poll live every 60s
let HIST_POINTS      = 60;          // default points on charts (newest on the right, corresponds to 1h)

const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

/* =================== State =================== */
let SENSORS = [];                   // [{address,label,calibration,chart,col},...]
let variableCache = {};             // per-device map: label -> varId
let sensorMapConfig = {};           // admin mapping/config from Ubidots (context)
// aliasMap holds friendly display names per truck label. Populated from
// sensorMapConfig.__aliases and used to override labels in the UI.
let aliasMap = {};

// Breadcrumb route configuration
// Colors used for each segment when drawing breadcrumb routes on the map.  When
// the truck pauses longer than 15 minutes between two GPS points, a new
// segment is started and assigned the next colour in this array (cycling
// through if there are more than seven segments).
const SEGMENT_COLORS = [
  "#dc2626", // red
  "#16a34a", // green
  "#2563eb", // blue
  "#eab308", // yellow
  "#8b5cf6", // purple
  "#f97316", // orange
  "#000000"  // black
];

// Selected time window in minutes for breadcrumbs and chart history. The
// default is 60 (1 hour). When a range button is clicked, this value is
// updated to the minutes specified in the button's data-range attribute.
let selectedRangeMinutes = 60;

// Tracks whether the last-range button (aka “Last seen”) is active. This
// value is updated by the range button click handler. It can be used for
// custom behaviour if needed, but presently both last and range modes
// behave similarly except that the button label differs.
let selectedRangeMode = "range";

// Arrays to keep references to Leaflet polylines and markers representing
// breadcrumb segments. Each time the breadcrumbs are updated these arrays
// are cleared and repopulated so the old markers and lines can be
// removed from the map cleanly.
let segmentPolylines = [];
let segmentMarkers = [];

// Holds the Leaflet control used to display the legend for the
// breadcrumb segments. This reference allows removing the legend when
// updating the route.
let legendControl = null;

/* =================== Helpers =================== */
function onReady(fn){
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(fn,1);
  else document.addEventListener("DOMContentLoaded", fn);
}
const fmt = (v,p=1)=>(v==null||isNaN(v))?"–":(+v).toFixed(p);

/* =================== Admin mapping (context) =================== */
async function fetchSensorMapMapping(){
  try{
    const res = await fetch('https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?page_size=1',
      { headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }});
    const js = await res.json();
    sensorMapConfig = (js.results?.[0]?.context) || {};
    // Populate aliasMap from config. The alias mapping is stored under
    // the special key '__aliases' in the sensor_map context. Reset to
    // empty object if not present to avoid stale values.
    aliasMap = sensorMapConfig.__aliases || {};
  }catch(e){
    console.error("Failed to fetch sensor_map:", e);
    sensorMapConfig = {};
    aliasMap = {};
  }
}

/* =================== Devices (v2) =================== */
async function fetchSensorMapConfig(){
  try{
    const res = await fetch(`${UBIDOTS_BASE}/devices/`, { headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }});
    if(!res.ok) throw new Error("Failed to fetch devices");
    const js = await res.json();
    const context = {};
    js.results
      .filter(dev => dev.name && dev.name.startsWith("skycafe-"))
      .forEach(dev => {
        const name  = dev.name;
        const label = dev.label || name.replace("skycafe-", "SkyCafé ");
        const lastSeen = dev.lastActivity ? new Date(dev.lastActivity).getTime() : 0;
        const id = dev.id || dev._id || dev["$id"];
        context[name] = { label, last_seen: Math.floor(lastSeen/1000), id };
      });
    return context;
  }catch(err){
    console.error("Failed to fetch device list:", err);
    return {};
  }
}

function buildDeviceDropdownFromConfig(sensorMap){
  const sel = document.getElementById("deviceSelect");
  // remember the previously selected device so we can restore it after rebuilding
  const prev = sel.value;
  const now = Math.floor(Date.now()/1000);
  sel.innerHTML = "";
  const entries = Object.entries(sensorMap)
    .sort(([a],[b]) => parseInt(a.replace("skycafe-",""),10)-parseInt(b.replace("skycafe-",""),10));
  entries.forEach(([dev,obj])=>{
    const isOnline = (now - (obj.last_seen||0)) < 60;
    const dot = isOnline ? "🟢" : "⚪️";
    const opt = document.createElement("option");
    opt.value = dev;
    // Use alias if defined, otherwise fall back to the device's label
    const displayLabel = aliasMap && aliasMap[dev] ? aliasMap[dev] : obj.label;
    opt.text  = `${dot} ${displayLabel} (${isOnline?"Online":"Offline"})`;
    sel.appendChild(opt);
  });
  // try to restore the previously selected device if it still exists
  let foundPrev=false;
  for(let i=0; i<sel.options.length; i++){
    if (sel.options[i].value === prev){
      sel.selectedIndex = i;
      foundPrev=true;
      break;
    }
  }
  // if not found, prefer an online truck
  if(!foundPrev){
    for(let i=0; i<sel.options.length; i++){
      if (sel.options[i].text.includes("Online")){
        sel.selectedIndex = i;
        foundPrev=true;
        break;
      }
    }
  }
  // fallback to first option if nothing else
  if(!foundPrev && sel.options.length>0){
    sel.selectedIndex = 0;
  }
}

/* =================== Variables & values =================== */
async function ensureVarCache(deviceID){
  if (variableCache[deviceID]) return;
  const rs = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, { headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }});
  if(!rs.ok){ variableCache[deviceID]={}; return; }
  const jl = await rs.json();
  variableCache[deviceID] = Object.fromEntries(jl.results.map(v=>[v.label, v.id]));
}

async function fetchUbidotsVar(deviceID, varLabel, limit=1){
  try{
    await ensureVarCache(deviceID);
    const varId = variableCache[deviceID][varLabel];
    if(!varId) return [];
    const vs = await fetch(`https://industrial.api.ubidots.com/api/v1.6/variables/${varId}/values/?page_size=${limit}`,
      { headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }});
    if(!vs.ok) return [];
    return (await vs.json()).results || [];
  }catch(e){
    console.error("fetchUbidotsVar", e);
    return [];
  }
}

/* =================== Dallas addresses =================== */
async function fetchDallasAddresses(deviceID){
  try{
    const res = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, { headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }});
    if(!res.ok) return [];
    const js = await res.json();
    // Keep any 16‑character hex sensor label regardless of last reading time
    return js.results
      .filter(v=>/^[0-9a-fA-F]{16}$/.test(v.label))
      .map(v=>v.label)
      .sort();
  }catch(e){ return []; }
}

/* =================== Sensor slots =================== */
function buildSensorSlots(deviceLabel, liveDallas, SENSOR_MAP){
  const mapped   = SENSOR_MAP[deviceLabel]||{};
  const adminMap = sensorMapConfig[deviceLabel]||{};
  const addrs = [...liveDallas.slice(0,5)];
  while(addrs.length<5) addrs.push(null);
  return addrs.map((addr,idx)=>{
    if(!addr) return { id:`empty${idx}`, label:"", col:SENSOR_COLORS[idx], chart:null, address:null, calibration:0 };
    const label = adminMap[addr]?.label?.trim() || mapped[addr]?.label?.trim() || addr;
    const offset = typeof adminMap[addr]?.offset==="number" ? adminMap[addr].offset
                 : typeof mapped[addr]?.offset==="number" ? mapped[addr].offset : 0;
    return { id:addr, label, col:SENSOR_COLORS[idx], chart:null, address:addr, calibration:offset };
  });
}

/* =================== Charts =================== */
function initCharts(SENSORS){
  const ctr = document.getElementById("charts");
  ctr.innerHTML = "";
  SENSORS.forEach(s=>{
    const box = document.createElement("div");
    box.className = "chart-box";
    box.innerHTML = `<h3>${s.label||""}</h3><canvas></canvas>`;
    ctr.appendChild(box);
    const ctx = box.querySelector("canvas").getContext("2d");
    s.chart = new Chart(ctx,{
      type:"line",
      data:{ labels:[], datasets:[{ data:[], borderColor:s.col, borderWidth:2 }]},
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:{ duration:300 },
        interaction:{ intersect:false, mode:'index' },
        scales:{
          x:{ ticks:{ display:false }, grid:{ color:'rgba(17,24,39,.05)' } },
          y:{ beginAtZero:false, ticks:{ callback:v=>Number(v).toFixed(1) }, grid:{ color:'rgba(17,24,39,.06)' } }
        },
        elements:{ line:{ tension:0.22 }, point:{ radius:0 } },
        plugins:{ legend:{ display:false }, decimation:{ enabled:true, algorithm:'lttb' } }
      }
    });
  });
}

async function updateCharts(deviceID, SENSORS){
  // Fill each chart (newest right)
  await Promise.all(SENSORS.map(async s=>{
    if(!s.address || !s.chart) return;
    const rows = await fetchUbidotsVar(deviceID, s.address, HIST_POINTS);
    if(!rows.length) return;
    const ordered = rows.slice().reverse(); // oldest -> newest
    s.chart.data.labels = ordered.map(r=>new Date(r.timestamp).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit", hour12:false }));
    s.chart.data.datasets[0].data = ordered.map(r=>{
      let v = parseFloat(r.value);
      if(typeof s.calibration==="number") v += s.calibration;
      return isNaN(v)?null:v;
    });
    s.chart.update();
  }));

  // Set a single date-range label above the charts
  let minTs = Infinity, maxTs = -Infinity;
  await Promise.all(SENSORS.map(async s=>{
    if(!s.address) return;
    const peek = await fetchUbidotsVar(deviceID, s.address, Math.min(HIST_POINTS, 10));
    if(!peek.length) return;
    const newest = peek[0].timestamp;
    const oldest = peek[peek.length-1].timestamp;
    minTs = Math.min(minTs, oldest, newest);
    maxTs = Math.max(maxTs, oldest, newest);
  }));
  const rng = document.getElementById("chartRange");
  if (rng && isFinite(minTs) && isFinite(maxTs)) {
    const a=new Date(minTs), b=new Date(maxTs);
    const same = a.toDateString()===b.toDateString();
    const fmtD = d=>d.toLocaleDateString([], { year:'numeric', month:'short', day:'numeric' });
    const fmtT = d=>d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:false });
    rng.textContent = same ? `${fmtD(a)} · ${fmtT(a)}–${fmtT(b)}` : `${fmtD(a)} ${fmtT(a)} → ${fmtD(b)} ${fmtT(b)}`;
  }
}

/* =================== Live panel + map =================== */
// Leaflet map and marker instances.  The map is created once and reused.
let map, marker;
function initMap(){
  // Initialise the Leaflet map if it hasn't been created yet.  Use a
  // lightweight base map and add a single marker to represent the
  // truck's current position.  Breadcrumb polylines and markers will
  // be added dynamically elsewhere when range selections are made.
  map = L.map("map").setView([0,0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
  marker = L.marker([0,0]).addTo(map);
}

function signalBarsFrom(value){
  if (value==null || isNaN(value)) return 0;
  // assuming 0..31 typical modem signal metric
  return Math.max(0, Math.min(5, Math.round((value/31)*5)));
}

function drawLive(data, SENSORS){
  let {ts,iccid,lat,lon,speed,signal,volt,readings} = data;
  ts = ts || Date.now();

  // Average temp KPI (from current readings we just fetched)
  const temps = SENSORS
    .map(s => (s.address && readings[s.address]!=null) ? (readings[s.address] + (s.calibration||0)) : null)
    .filter(v=>v!=null && isFinite(v));
  const avg = temps.length ? (temps.reduce((a,b)=>a+b,0)/temps.length) : null;
  document.getElementById("kpiAvg").textContent = avg!=null ? fmt(avg,1) + "°" : "—";

  // Truck + last updated
  const devSel = document.getElementById("deviceSelect");
  const deviceKey = devSel.value;
  // Derive the display name: prefer alias, else sensorMapConfig label, else the key
  let displayName = aliasMap && aliasMap[deviceKey];
  if (!displayName) {
    displayName = (sensorMapConfig[deviceKey] && sensorMapConfig[deviceKey].label) || deviceKey || "—";
  }
  document.getElementById("kpiTruck").textContent = displayName;
  // Show exact last update time in 24h format with seconds
  const updateTime = new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  document.getElementById("kpiSeen").textContent  = `last updated ${updateTime}`;

  // Phone-like signal bars colored
  const sigBars = signalBarsFrom(signal);

  const sensorRows = SENSORS.map(s=>[
    s.label,
    s.address && readings[s.address]!=null ? fmt(readings[s.address] + (s.calibration||0),1) : ""
  ]);

  const rows = [
    ["Local Time", new Date(ts).toLocaleString()],
    ["ICCID", iccid || "—"],
    ["Lat",   fmt(lat,6)],
    ["Lon",   fmt(lon,6)],
    ["Speed (km/h)", fmt(speed,1)],
    ["Signal",
      (signal!=null?String(signal):"—")
      + ` <span class="sig ${sigBars>=4?'high':(sigBars>=2?'med':'low')}">`
      + `<i class="l1 ${sigBars>0?'on':''}"></i><i class="l2 ${sigBars>1?'on':''}"></i><i class="l3 ${sigBars>2?'on':''}"></i><i class="l4 ${sigBars>3?'on':''}"></i><i class="l5 ${sigBars>4?'on':''}"></i></span>`],
    ["Volt (mV)", fmt(volt,2)],
  ].concat(sensorRows);

  document.getElementById("latest").innerHTML =
    rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("");

  if(lat!=null && lon!=null && isFinite(lat) && isFinite(lon)){
    // Update the current position marker on the map and pan
    // smoothly to keep the truck visible.  Breadcrumb routes are
    // handled separately in updateBreadcrumbs().
    marker.setLatLng([lat,lon]);
    if (map) {
      map.setView([lat,lon], Math.max(map.getZoom(), 13));
    }
  }
}

async function poll(deviceID, SENSORS){
  const [gpsArr,iccArr] = await Promise.all([
    fetchUbidotsVar(deviceID,"gps"),
    fetchUbidotsVar(deviceID,"iccid")
  ]);
  const ts  = gpsArr[0]?.timestamp || iccArr[0]?.timestamp || Date.now();
  const lat = gpsArr[0]?.context?.lat;
  const lon = gpsArr[0]?.context?.lng;
  const speedVal = gpsArr[0]?.context?.speed;
  const iccidVal = iccArr[0]?.value || null;

  let readings = {};
  await Promise.all(SENSORS.filter(s=>s.address).map(async s=>{
    const v = await fetchUbidotsVar(deviceID, s.address, 1);
    if(v.length && v[0].value!=null) readings[s.address] = parseFloat(v[0].value);
  }));
  const [signalArr, voltArr] = await Promise.all([
    fetchUbidotsVar(deviceID,"signal",1),
    fetchUbidotsVar(deviceID,"volt",1)
  ]);

  drawLive({
    ts, iccid:iccidVal, lat, lon, speed:speedVal,
    signal:signalArr[0]?.value||null, volt:voltArr[0]?.value||null, readings
  }, SENSORS);
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

  let hasActivity=false;
  for(const s of SENSORS){
    if(!s.address) continue;
    const vals = await fetchUbidotsVar(deviceID, s.address, 1);
    if (vals[0]?.timestamp) {
      if (new Date(vals[0].timestamp).toISOString().slice(0,10) === today) { hasActivity=true; break; }
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
async function fetchCsvRows(deviceID, varLabel, start, end){
  try{
    await ensureVarCache(deviceID);
    const id = variableCache[deviceID][varLabel];
    if(!id) return [];
    let url = `https://industrial.api.ubidots.com/api/v1.6/variables/${id}/values/?page_size=1000`;
    if(start) url += `&start=${start}`;
    if(end)   url += `&end=${end}`;
    const res = await fetch(url, { headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }});
    if(!res.ok) return [];
    return (await res.json()).results||[];
  }catch{ return []; }
}

/* =================== Breadcrumb route drawing =================== */
/**
 * Draw breadcrumb routes on the map for the selected device and time window.
 *
 * This function fetches GPS data (lat/lon/speed) and temperature readings
 * across the specified time window, divides the GPS points into segments
 * whenever there is more than a 15 minute gap between consecutive points,
 * and then draws a polyline for each segment using a distinct colour from
 * SEGMENT_COLORS.  It also places small circular markers at each point
 * along the route and binds a tooltip displaying the timestamp (24‑hour
 * format), vehicle speed and average temperature.  A legend is added to
 * the bottom‑right of the map showing the colour and start/end time for
 * each segment.
 *
 * @param {string} deviceID Unique Ubidots device ID
 * @param {number} rangeMinutes Time window in minutes
 */
async function updateBreadcrumbs(deviceID, rangeMinutes){
  try{
    // Ensure the map is initialised
    if(!map) initMap();
    // Remove any existing breadcrumb lines, markers and legend
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
    // Fetch GPS points within the window
    const gpsRows = await fetchCsvRows(deviceID, 'gps', startTime, nowMs);
    const gpsPoints = gpsRows
      .filter(r => r.context && r.context.lat != null && r.context.lng != null)
      .sort((a,b) => a.timestamp - b.timestamp);
    if(!gpsPoints.length) return;
    // Build temperature averages keyed by timestamp
    const tempData = {};
    const tempAvg  = {};
    // Gather temperature readings for each sensor in SENSORS
    for(const s of SENSORS){
      if(!s.address) continue;
      const rows = await fetchCsvRows(deviceID, s.address, startTime, nowMs);
      for(const r of rows){
        const ts = r.timestamp;
        let v = parseFloat(r.value);
        if(isNaN(v)) continue;
        if(typeof s.calibration === 'number') v += s.calibration;
        if(!tempData[ts]) tempData[ts] = [];
        tempData[ts].push(v);
      }
    }
    // Compute average per timestamp
    Object.keys(tempData).forEach(ts => {
      const vals = tempData[ts];
      if(vals && vals.length){
        const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
        tempAvg[ts] = avg;
      }
    });
    const tempTimestamps = Object.keys(tempAvg).map(t=>+t).sort((a,b)=>a-b);
    // Divide the GPS points into segments based on time gaps > 15 minutes
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
    // Build legend entries and draw segments
    const legendEntries = [];
    segments.forEach((seg, idx) => {
      const color = SEGMENT_COLORS[idx % SEGMENT_COLORS.length];
      const latlngs = seg.map(r => [r.context.lat, r.context.lng]);
      const poly = L.polyline(latlngs, { color, weight:4, opacity:0.9 }).addTo(map);
      segmentPolylines.push(poly);
      // Legend times
      const startDate = new Date(seg[0].timestamp);
      const endDate   = new Date(seg[seg.length-1].timestamp);
      legendEntries.push({ color, start: startDate, end: endDate });
      // Place markers with tooltips
      seg.forEach(pt => {
        const latlng = [pt.context.lat, pt.context.lng];
        // Find nearest average temperature within ±5 minutes
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
        const timeStr = new Date(pt.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
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
    // Fit map bounds to the entire route if there are points
    if(segments.length > 0){
      const allLatLngs = [];
      segments.forEach(seg => {
        seg.forEach(pt => {
          allLatLngs.push([pt.context.lat, pt.context.lng]);
        });
      });
      const bounds = L.latLngBounds(allLatLngs);
      map.fitBounds(bounds, { padding: [20,20] });
    }
    // Add legend control
    if(legendEntries.length > 0){
      legendControl = L.control({ position: 'bottomright' });
      legendControl.onAdd = function(){
        const div = L.DomUtil.create('div', 'breadcrumb-legend');
        // Style inline for clarity; adjust in CSS if needed
        div.style.background = 'rgba(255,255,255,0.85)';
        div.style.padding = '8px 10px';
        div.style.borderRadius = '6px';
        div.style.fontSize = '0.75rem';
        div.style.lineHeight = '1.2';
        div.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        let html = '<strong>Segments</strong><br>';
        legendEntries.forEach(entry => {
          const startT = entry.start.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:false });
          const endT   = entry.end.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', hour12:false });
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
    // Assign a single click handler to each range button.  It updates
    // the selected window and then triggers a refresh of the dashboard.
    btn.onclick = async function(){
      // reset all range buttons to their default appearance
      buttons.forEach(b=>{
        b.style.backgroundColor = '';
        b.style.color = '';
      });
      // highlight the clicked button in green with white text
      this.style.backgroundColor = '#10b981';
      this.style.color = '#ffffff';
      // Determine the range (in minutes) and mode from the button's attributes
      const modeAttr = this.getAttribute('data-mode') || 'range';
      const valAttr = parseInt(this.getAttribute('data-range'), 10);
      selectedRangeMinutes = isFinite(valAttr) ? valAttr : 60;
      selectedRangeMode = modeAttr;
      // Use the selected window for chart history points as well.  For
      // example, a 60‑minute window draws 60 points.  If you prefer a
      // fixed number of points irrespective of minutes, adjust here.
      HIST_POINTS = selectedRangeMinutes;
      await updateAll();
    };
  });
}

/* =================== Main update loop =================== */
onReady(()=>{
  wireRangeButtons();
  updateAll();
  setInterval(updateAll, REFRESH_INTERVAL);
  document.getElementById("deviceSelect").addEventListener("change", updateAll);
});

async function updateAll(){
  await fetchSensorMapMapping();
  const sensorMap = await fetchSensorMapConfig();

  buildDeviceDropdownFromConfig(sensorMap);
  const deviceLabel = document.getElementById("deviceSelect").value;
  const deviceID    = sensorMap[deviceLabel]?.id;
  const isOnline    = (Math.floor(Date.now()/1000) - (sensorMap[deviceLabel]?.last_seen||0)) < 60;

  if (window.__setDeviceStatus) window.__setDeviceStatus(isOnline);
  const pill = document.getElementById('deviceStatusPill');
  if (pill) {
    const seen = sensorMap[deviceLabel]?.last_seen ? new Date(sensorMap[deviceLabel].last_seen*1000) : null;
    pill.title = seen ? `Last activity: ${seen.toLocaleString()}` : '';
  }

  if (deviceID){
    variableCache = {};
    const liveDallas = await fetchDallasAddresses(deviceID);
    SENSORS = buildSensorSlots(deviceLabel, liveDallas, sensorMap);
    initCharts(SENSORS);
    await updateCharts(deviceID, SENSORS);
    if(!map) initMap();
    await poll(deviceID, SENSORS);
    await renderMaintenanceBox(deviceLabel, deviceID);
    // After rendering maintenance, update breadcrumb routes for the selected time window
    await updateBreadcrumbs(deviceID, selectedRangeMinutes);
  }else{
    console.error("Device ID not found for", deviceLabel);
  }
  // reattach range button handlers after DOM updates to ensure they remain functional
  wireRangeButtons();
}
