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

// holds the most recent devices context so the CSV click handler can resolve deviceID
let __deviceMap = {};

/* =================== Helpers =================== */
function onReady(fn){
  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(fn,1);
  else document.addEventListener("DOMContentLoaded", fn);
}
const fmt = (v,p=1)=>(v==null||isNaN(v))?"–":(+v).toFixed(p);

// Get the *displayed* name seen on the dashboard for a given device label
function getDisplayName(deviceLabel){
  return (aliasMap && aliasMap[deviceLabel])
      || (sensorMapConfig[deviceLabel] && sensorMapConfig[deviceLabel].label)
      || deviceLabel;
}

/* =================== Admin mapping (context) =================== */
async function fetchSensorMapMapping(){
  try{
    const res = await fetch('https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?page_size=1',
      { headers:{ "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }});
    const js = await res.json();
    sensorMapConfig = (js.results?.[0]?.context) || {};
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
    const displayLabel = getDisplayName(dev);
    opt.text  = `${dot} ${displayLabel} (${isOnline?"Online":"Offline"})`;
    sel.appendChild(opt);
  });
  let foundPrev=false;
  for(let i=0; i<sel.options.length; i++){
    if (sel.options[i].value === prev){
      sel.selectedIndex = i;
      foundPrev=true;
      break;
    }
  }
  if(!foundPrev){
    for(let i=0; i<sel.options.length; i++){
      if (sel.options[i].text.includes("Online")){
        sel.selectedIndex = i;
        foundPrev=true;
        break;
      }
    }
  }
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
  await Promise.all(SENSORS.map(async s=>{
    if(!s.address || !s.chart) return;
    const rows = await fetchUbidotsVar(deviceID, s.address, HIST_POINTS);
    if(!rows.length) return;
    const ordered = rows.slice().reverse();
    s.chart.data.labels = ordered.map(r=>
      new Date(r.timestamp).toLocaleTimeString('en-GB', {
        hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Europe/London'
      })
    );
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
      const pad  = Math.max(0.5, (vmax - vmin) * 0.10); // 10% or ≥0.5°
      s.chart.options.scales.y.min = vmin - pad;
      s.chart.options.scales.y.max = vmax + pad;
    } else {
      delete s.chart.options.scales.y.min;
      delete s.chart.options.scales.y.max;
    }

    s.chart.update();
  }));
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
    const fmtD = d=>d.toLocaleDateString('en-GB', { year:'numeric', month:'short', day:'numeric', timeZone:'Europe/London' });
    const fmtT = d=>d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Europe/London' });
    rng.textContent = same ? `${fmtD(a)} · ${fmtT(a)}–${fmtT(b)}` : `${fmtD(a)} ${fmtT(a)} → ${fmtD(b)} ${fmtT(b)}`;
  }
}

/* =================== Live panel + map =================== */
let map, marker;
function initMap(){
  map = L.map("map").setView([0,0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
  marker = L.marker([0,0]).addTo(map);
}

function signalBarsFrom(value){
  if (value==null || isNaN(value)) return 0;
  return Math.max(0, Math.min(5, Math.round((value/31)*5)));
}

function drawLive(data, SENSORS){
  let {ts,iccid,lat,lon,speed,signal,volt,readings} = data;
  ts = ts || Date.now();
  const temps = SENSORS
    .map(s => (s.address && readings[s.address]!=null) ? (readings[s.address] + (s.calibration||0)) : null)
    .filter(v=>v!=null && isFinite(v));
  const avg = temps.length ? (temps.reduce((a,b)=>a+b,0)/temps.length) : null;
  document.getElementById("kpiAvg").textContent = avg!=null ? fmt(avg,1) + "°" : "—";

  const devSel = document.getElementById("deviceSelect");
  const deviceKey = devSel.value;
  const displayName = getDisplayName(deviceKey);

  document.getElementById("kpiTruck").textContent = displayName;

  // London time zone for last-updated label
  const updateTime = new Date(ts).toLocaleTimeString('en-GB', {
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false, timeZone:'Europe/London'
  });
  document.getElementById("kpiSeen").textContent  = `last updated ${updateTime}`;

  const sigBars = signalBarsFrom(signal);
  const sensorRows = SENSORS.map(s=>[
    s.label,
    s.address && readings[s.address]!=null ? fmt(readings[s.address] + (s.calibration||0),1) : ""
  ]);
  const rows = [
    ["Local Time", new Date(ts).toLocaleString('en-GB', { timeZone:'Europe/London' })],
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
    marker.setLatLng([lat,lon]);
    if (map) {
      map.setView([lat,lon], Math.max(map.getZoom(), 13));
    }
  }
}

async function poll(deviceID, SENSORS){
  const [gpsArr, iccArr] = await Promise.all([
    fetchUbidotsVar(deviceID, "gps"),
    fetchUbidotsVar(deviceID, "iccid")
  ]);
  let tsGps   = gpsArr[0]?.timestamp || null;
  let tsIccid = iccArr[0]?.timestamp || null;
  let readings = {};
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
  let ts = Date.now();
  const candidates = [tsGps, tsIccid, tsSensorMax, tsSignal, tsVolt].filter(x => x != null);
  if (candidates.length > 0) ts = Math.max(...candidates);
  const lat = gpsArr[0]?.context?.lat;
  const lon = gpsArr[0]?.context?.lng;
  const speedVal = gpsArr[0]?.context?.speed;
  const iccidVal = iccArr[0]?.value || null;
  drawLive({
    ts,
    iccid: iccidVal,
    lat,
    lon,
    speed: speedVal,
    signal: signalArr[0]?.value || null,
    volt: voltArr[0]?.value || null,
    readings
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
    const [gpsRows, signalRows, voltRows] = await Promise.all([
      fetchCsvRows(deviceID, "gps",    startMs, endMs),
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

/* =================== Breadcrumb route drawing =================== */
async function updateBreadcrumbs(deviceID, rangeMinutes){
  try{
    if(!map) initMap();
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
    const gpsRows = await fetchCsvRows(deviceID, 'gps', startTime, nowMs);
    const gpsPoints = gpsRows
      .filter(r => r.context && r.context.lat != null && r.context.lng != null)
      .sort((a,b) => a.timestamp - b.timestamp);
    if(!gpsPoints.length) return;
    const tempData = {};
    const tempAvg  = {};
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
      buttons.forEach(b=>{
        b.style.backgroundColor = '';
        b.style.color = '';
      });
      this.style.backgroundColor = '#10b981';
      this.style.color = '#ffffff';
      const modeAttr = this.getAttribute('data-mode') || 'range';
      const valAttr = parseInt(this.getAttribute('data-range'), 10);
      selectedRangeMinutes = isFinite(valAttr) ? valAttr : 60;
      selectedRangeMode = modeAttr;
      HIST_POINTS = selectedRangeMinutes;
      await updateAll();
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
  }
}

/* =================== Main update loop =================== */
onReady(()=>{
  wireRangeButtons();
  wireDateInputsCommit();   // commit date instantly


  updateAll();
  setInterval(updateAll, REFRESH_INTERVAL);
  document.getElementById("deviceSelect").addEventListener("change", updateAll);
});

async function updateAll(){
  await fetchSensorMapMapping();
  const sensorMap = await fetchSensorMapConfig();
  __deviceMap = sensorMap; // expose to CSV click handler
  buildDeviceDropdownFromConfig(sensorMap);
  const deviceLabel = document.getElementById("deviceSelect").value;
  const deviceID    = sensorMap[deviceLabel]?.id;
  const isOnline    = (Math.floor(Date.now()/1000) - (sensorMap[deviceLabel]?.last_seen||0)) < 60;
  if (window.__setDeviceStatus) window.__setDeviceStatus(isOnline);
  const pill = document.getElementById('deviceStatusPill');
  if (pill) {
    const seen = sensorMap[deviceLabel]?.last_seen ? new Date(sensorMap[deviceLabel].last_seen*1000) : null;
    pill.title = seen ? `Last activity: ${seen.toLocaleString('en-GB', { timeZone:'Europe/London' })}` : '';
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
    await updateBreadcrumbs(deviceID, selectedRangeMinutes);
  }else{
    console.error("Device ID not found for", deviceLabel);
  }
  wireRangeButtons();
}
