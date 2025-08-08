let _maintenanceLogged = false;

/* =================== Config =================== */
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";

let REFRESH_INTERVAL = 60_000;      // poll live every 60s
let HIST_POINTS      = 50;          // default points on charts (newest on the right)

const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

/* =================== State =================== */
let SENSORS = [];                   // [{address,label,calibration,chart,col},...]
let variableCache = {};             // per-device map: label -> varId
let sensorMapConfig = {};           // admin mapping/config from Ubidots (context)
// aliasMap holds friendly display names per truck label. Populated from
// sensorMapConfig.__aliases and used to override labels in the UI.
let aliasMap = {};

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
let map, marker, polyline, trail=[];
function initMap(){
  map = L.map("map").setView([0,0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
  marker = L.marker([0,0]).addTo(map);
  polyline = L.polyline([],{ weight:3 }).addTo(map);
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
    marker.setLatLng([lat,lon]);
    trail.push([lat,lon]); if(trail.length>50) trail.shift();
    polyline.setLatLngs(trail);
    map.setView([lat,lon], Math.max(map.getZoom(), 13));
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

document.getElementById("dlBtn").onclick = async function(){
  const expStatus = document.getElementById("expStatus");
  expStatus.textContent = "Downloading...";
  try{
    const deviceLabel = document.getElementById("deviceSelect").value;
    const startDate = document.getElementById("start").value;
    const endDate   = document.getElementById("end").value;
    const sensorMap = await fetchSensorMapConfig();
    const deviceID  = sensorMap[deviceLabel]?.id;

    if(!SENSORS.length){ expStatus.textContent="No sensors available for this truck."; return; }
    const addresses = SENSORS.map(s=>s.address).filter(Boolean);
    if(!addresses.length){ expStatus.textContent="No valid sensor addresses."; return; }

    const startMs = startDate? new Date(startDate).getTime() : null;
    const endMs   = endDate  ? new Date(endDate).getTime()+24*3600*1000 : null;

    const dataByTime = {};
    for(const addr of addresses){
      const vals = await fetchCsvRows(deviceID, addr, startMs, endMs);
      for(const v of vals){
        dataByTime[v.timestamp] = dataByTime[v.timestamp]||{};
        dataByTime[v.timestamp][addr]=v.value;
      }
    }

    const times = Object.keys(dataByTime).map(Number).sort((a,b)=>b-a);
    if(!times.length){ expStatus.textContent="No data found for the selected range."; return; }

    const adminMap = sensorMapConfig[deviceLabel]||{};
    const header = ["Timestamp", ...addresses.map(a=>adminMap[a]?.label||a)];
    const rows = [header];
    times.forEach(t=>{
      const row=[new Date(+t).toISOString()];
      addresses.forEach(a=> row.push(dataByTime[t][a]!==undefined?dataByTime[t][a]:""));
      rows.push(row);
    });

    const csv = rows.map(r=>r.join(",")).join("\r\n");
    const blob = new Blob([csv], {type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a=document.createElement("a"); a.href=url; a.download=`truck_${deviceLabel}_${startDate||"all"}_${endDate||"all"}.csv`;
    document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 500);
    expStatus.textContent="Download complete!";
  }catch(e){
    console.error(e);
    expStatus.textContent="Download failed.";
  }
};

/* =================== Range buttons =================== */
function wireRangeButtons(){
  const buttons = document.querySelectorAll(".rangeBtn");
  buttons.forEach(btn=>{
    // use the onclick property to ensure only one handler per button
    btn.onclick = async function(){
      // reset all range buttons to default colours
      buttons.forEach(b=>{
        b.style.backgroundColor = '';
        b.style.color = '';
      });
      // highlight clicked button in green with white text
      this.style.backgroundColor = '#10b981';
      this.style.color = '#ffffff';
      const val = parseInt(this.getAttribute('data-range'), 10);
      HIST_POINTS = isFinite(val) ? val : 50;
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
  }else{
    console.error("Device ID not found for", deviceLabel);
  }
  // reattach range button handlers after DOM updates to ensure they remain functional
  wireRangeButtons();
}
