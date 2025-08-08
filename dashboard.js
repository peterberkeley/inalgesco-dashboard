let _maintenanceLogged = false;

// ========== Configuration ==========
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";
const REFRESH_INTERVAL = 60000;
// was const HIST = 50; -> now dynamic:
let HIST_POINTS = 50; // default, can be changed by range buttons
const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

let SENSORS = [];
let variableCache = {};
let sensorMapConfig = {};
let pollTimer = null; // interval for live info polling

// expose for range buttons in HTML
window.__setHistoryPoints = function(n){
  if (!Number.isFinite(n) || n < 10) return;
  HIST_POINTS = n;
  updateAll(); // redraw with new history depth
};

// ========== Utility: onReady ==========
function onReady(fn) {
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(fn, 1);
  } else {
    document.addEventListener("DOMContentLoaded", fn);
  }
}

// ========== Sensor Mapping from Admin ==========
async function fetchSensorMapMapping() {
  try {
    const res = await fetch(
      "https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?page_size=1",
      { headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN } }
    );
    const js = await res.json();
    sensorMapConfig = (js.results?.[0]?.context) || {};
  } catch (e) {
    console.error("Failed to fetch sensor_map:", e);
    sensorMapConfig = {};
  }
}

// ========== Fetch devices from Ubidots API v2 ==========
async function fetchSensorMapConfig() {
  try {
    const res = await fetch(`${UBIDOTS_BASE}/devices/`, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!res.ok) throw new Error("Failed to fetch devices");
    const js = await res.json();
    const context = {};
    js.results
      .filter(dev => dev.name && dev.name.startsWith("skycafe-"))
      .forEach(dev => {
        const name = dev.name;
        const label = dev.label || name.replace("skycafe-", "SkyCafé ");
        const lastSeen = dev.lastActivity ? new Date(dev.lastActivity).getTime() : 0;
        const id = dev.id || dev._id || dev["$id"];
        context[name] = { label, last_seen: Math.floor(lastSeen/1000), id };
      });
    return context;
  } catch (err) {
    console.error("Failed to fetch device list:", err);
    return {};
  }
}

function buildDeviceDropdownFromConfig(sensorMap) {
  const deviceSelect = document.getElementById("deviceSelect");
  const now = Math.floor(Date.now() / 1000);
  deviceSelect.innerHTML = "";
  Object.entries(sensorMap)
    .sort(([a],[b]) => parseInt(a.replace("skycafe-",""),10) - parseInt(b.replace("skycafe-",""),10))
    .forEach(([dev, obj]) => {
      const isOnline = (now - (obj.last_seen||0) < 60);
      const dot = isOnline ? "🟢" : "⚪️";
      const opt = document.createElement("option");
      opt.value = dev;
      opt.text = `${dot} ${obj.label} (${isOnline?"Online":"Offline"})`;
      deviceSelect.appendChild(opt);
    });
  for (let i=0;i<deviceSelect.options.length;i++){
    if (deviceSelect.options[i].text.includes("Online")) { deviceSelect.selectedIndex=i; break; }
  }
}

// helpers
const fmt = (v,p=1)=>(v==null||isNaN(v))?"–":(+v).toFixed(p);
const ago = (t)=> {
  if(!t) return "—";
  const d = Math.max(0, (Date.now()-t)/1000|0);
  if (d<60) return `${d}s ago`;
  if (d<3600) return `${(d/60|0)}m ago`;
  return `${(d/3600|0)}h ago`;
};

// signal bars mapping (supports dBm, %, 0–31, 0–5)
function signalToBars(val){
  if (val == null || isNaN(val)) return 0;
  let v = Number(val);
  // if already bars 0–5
  if (v >= 0 && v <= 5 && Number.isInteger(v)) return v;
  // 0–31 (CSQ style)
  if (v >= 0 && v <= 31) return Math.round((v/31)*5);
  // percent 0–100
  if (v >= 0 && v <= 100) return Math.round((v/20));
  // dBm (negative)
  if (v <= -30 && v >= -120) {
    if (v >= -65) return 5;
    if (v >= -75) return 4;
    if (v >= -85) return 3;
    if (v >= -95) return 2;
    if (v >= -110) return 1;
    return 0;
  }
  // fallback: clamp 0–5
  return Math.max(0, Math.min(5, Math.round(v)));
}

function setSigBars(el, bars){
  const kids = el.querySelectorAll('i');
  kids.forEach((k,i)=> k.classList.toggle('on', i < bars));
}

// ========== Ubidots helpers ==========
async function fetchDallasAddresses(deviceID) {
  try {
    const res = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!res.ok) return [];
    const js = await res.json();
    const now = Date.now();
    return js.results
      .filter(v=>/^[0-9a-fA-F]{16}$/.test(v.label))
      .filter(v=>((v.lastValue?.timestamp)||0) > now - 3*60*1000)
      .map(v=>v.label)
      .sort();
  } catch { return []; }
}

function buildSensorSlots(deviceLabel, DALLAS_LIST, SENSOR_MAP) {
  const mapped = SENSOR_MAP[deviceLabel]||{};
  const adminMap = sensorMapConfig[deviceLabel]||{};
  const all = [...DALLAS_LIST.slice(0,5)];
  while(all.length<5) all.push(null);
  return all.map((addr,idx)=>{
    if(!addr) return { id:`empty${idx}`, label:"", col:SENSOR_COLORS[idx], chart:null, address:null, mapped:null, calibration:0 };
    const label = adminMap[addr]?.label?.trim() || mapped[addr]?.label?.trim() || addr;
    const calib = typeof adminMap[addr]?.offset==="number" ? adminMap[addr].offset
                : typeof mapped[addr]?.offset==="number" ? mapped[addr].offset : 0;
    return { id:addr, label, col:SENSOR_COLORS[idx], chart:null, address:addr, mapped:mapped[addr], calibration:calib };
  });
}

async function fetchUbidotsVar(deviceID, variable, limit=1) {
  try {
    if (!variableCache[deviceID]) {
      const rs = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, { headers:{ "X-Auth-Token":UBIDOTS_ACCOUNT_TOKEN } });
      if(!rs.ok) return [];
      const jl = await rs.json();
      variableCache[deviceID] = Object.fromEntries(jl.results.map(v=>[v.label,v.id]));
    }
    const varId = variableCache[deviceID][variable];
    if (!varId) return [];
    const vs = await fetch(`https://industrial.api.ubidots.com/api/v1.6/variables/${varId}/values/?page_size=${limit}`, {
      headers:{ "X-Auth-Token":UBIDOTS_ACCOUNT_TOKEN }
    });
    if(!vs.ok) return [];
    return (await vs.json()).results||[];
  } catch { return []; }
}

// ========== Charts ==========
function initCharts(SENSORS) {
  const ctr = document.getElementById("charts"); ctr.innerHTML="";
  SENSORS.forEach(s=>{
    const card = document.createElement("div");
    card.className="chart-box";
    card.innerHTML=`<h2>${s.label||""}</h2><canvas></canvas>`;
    ctr.appendChild(card);
    const ctx = card.querySelector("canvas").getContext("2d");
    s.chart = new Chart(ctx,{
      type:"line",
      data:{ labels:[], datasets:[{ data:[], borderColor:s.col, borderWidth:2, tension:0.25, pointRadius:0 }]},
      options:{
        responsive:true, maintainAspectRatio:false,
        scales:{ x:{ ticks:{ maxRotation:0 }}, y:{ beginAtZero:false }},
        plugins:{ legend:{ display:false }, decimation:{ enabled:true, algorithm:'lttb' } }
      }
    });
  });
}

async function updateCharts(deviceID, SENSORS) {
  await Promise.all(SENSORS.map(async s=>{
    if(!s.address) return;
    const rows = await fetchUbidotsVar(deviceID,s.address,HIST_POINTS);
    if(!rows.length) return;
    // ensure OLDEST -> NEWEST left->right
    const ordered = rows.slice().reverse();
    s.chart.data.labels = ordered.map(r=>new Date(r.timestamp).toLocaleTimeString([], { hour:"numeric", minute:"2-digit", hour12:true }));
    s.chart.data.datasets[0].data = ordered.map(r=>{
      let v=parseFloat(r.value);
      if(typeof s.calibration==="number") v+=s.calibration;
      return isNaN(v)?null:v;
    });
    s.chart.update();
  }));
}

// ========== Info panel + Map ==========
function drawLive(data,SENSORS){
  let {ts,iccid,lat,lon,speed,signal,volt,readings} = data;
  ts=ts||Date.now();

  // KPI updates
  const devSel = document.getElementById('deviceSelect');
  const deviceLabel = devSel ? devSel.value : "—";
  document.getElementById('kpiTruck').textContent = deviceLabel || "—";
  document.getElementById('kpiSeen').textContent  = `updated ${ago(ts)}`;
  document.getElementById('kpiSpeed').textContent = fmt(speed,1);
  document.getElementById('kpiAvg').textContent   = (function(){
    const vals = SENSORS.filter(s=>s.address && readings[s.address]!=null)
                        .map(s=> Number(readings[s.address]) + (s.calibration||0));
    if(!vals.length) return "—";
    const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
    return fmt(avg,1) + "°";
  })();
  const sigBars = signalToBars(signal);
  const sigWrap = document.getElementById('kpiSigBars'); if (sigWrap) setSigBars(sigWrap, sigBars);
  const sigText = document.getElementById('kpiSigText'); if (sigText) sigText.textContent = (signal!=null?String(signal):"—");

  // Table rows
  const sensorRows = SENSORS.map(s=>[
    s.label,
    s.address && readings[s.address]!=null ? fmt(readings[s.address]+(s.calibration||0),1) : ""
  ]);
  const rows = [
    ["Local Time", new Date(ts).toLocaleString()],
    ["ICCID", iccid||"–"],
    ["Lat", fmt(lat,6)],
    ["Lon", fmt(lon,6)],
    ["Speed (km/h)", fmt(speed,1)],
    ["Signal", (signal!=null?String(signal):"—") + ` <span class="sig"><i class="l1 ${sigBars>0?'on':''}"></i><i class="l2 ${sigBars>1?'on':''}"></i><i class="l3 ${sigBars>2?'on':''}"></i><i class="l4 ${sigBars>3?'on':''}"></i><i class="l5 ${sigBars>4?'on':''}"></i></span>`],
    ["Volt (mV)", fmt(volt,2)]
  ].concat(sensorRows);

  document.getElementById("latest").innerHTML =
    rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("");

  // Map move (ignore >30 min old)
  if(lat!=null&&lon!=null&&isFinite(lat)&&isFinite(lon)){
    if (Date.now() - (ts || Date.now()) < 30*60*1000) {
      marker.setLatLng([lat,lon]);
      trail.push([lat,lon]); if(trail.length>50) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat,lon], Math.max(map.getZoom(),13));
    }
  }
}

async function poll(deviceID,SENSORS){
  const [gpsArr, iccArr, sigArr, voltArr] = await Promise.all([
    fetchUbidotsVar(deviceID,"gps"),
    fetchUbidotsVar(deviceID,"iccid"),
    fetchUbidotsVar(deviceID,"signal",1),
    fetchUbidotsVar(deviceID,"volt",1)
  ]);

  let lat = gpsArr[0]?.context?.lat ?? null;
  let lon = gpsArr[0]?.context?.lng ?? null;
  let speedVal = gpsArr[0]?.context?.speed ?? null;

  if (lat==null || lon==null) {
    const [latArr, lngArr] = await Promise.all([
      fetchUbidotsVar(deviceID,"lat",1),
      fetchUbidotsVar(deviceID,"lng",1)
    ]);
    if (latArr[0]?.value!=null && lngArr[0]?.value!=null) {
      lat = parseFloat(latArr[0].value); lon = parseFloat(lngArr[0].value);
    }
  }

  const candidates = [
    gpsArr[0]?.timestamp, iccArr[0]?.timestamp, sigArr?.[0]?.timestamp, voltArr?.[0]?.timestamp
  ].filter(Boolean);
  const ts = candidates.length ? Math.max(...candidates) : Date.now();
  const iccidVal = iccArr[0]?.value ?? null;

  const readings = {};
  await Promise.all(SENSORS.filter(s=>s.address).map(async s=>{
    const v=await fetchUbidotsVar(deviceID,s.address,1);
    if(v.length&&v[0].value!=null) readings[s.address]=parseFloat(v[0].value);
  }));

  drawLive({
    ts,
    iccid: iccidVal,
    lat, lon,
    speed: speedVal,
    signal: sigArr?.[0]?.value ?? null,
    volt:   voltArr?.[0]?.value ?? null,
    readings
  }, SENSORS);
}

// ========== Map init ==========
let map, marker, polyline, trail=[];
function initMap(){
  map = L.map("map").setView([0,0],2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
  marker = L.marker([0,0]).addTo(map);
  polyline = L.polyline([],{ weight:3, color:"#2563eb" }).addTo(map);
}

// ========== Maintenance ==========
const MAINTENANCE_DEFAULTS = { filterDays:60, serviceDays:365, lastDecrementDate:null };

function showPromptModal(message, callback) {
  const old = document.getElementById("promptModal"); if (old) old.remove();
  const modal = document.createElement("div");
  modal.id = "promptModal";
  modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center;";
  modal.innerHTML = `
    <div style="background:#fff;border-radius:1rem;box-shadow:0 6px 24px rgba(0,0,0,.12);padding:2rem;display:flex;flex-direction:column;gap:1rem;min-width:280px;">
      <div style="font-size:1.05rem;font-weight:600;">${message}</div>
      <input id="modalCodeInput" type="password" style="font-size:1rem;padding:.4rem;border-radius:.5rem;border:1px solid #ccc;width:12rem;" autocomplete="off" autofocus>
      <div id="modalCodeError" style="color:#c00;font-weight:600;display:none;"></div>
      <div style="display:flex;gap:1rem;justify-content:flex-end;">
        <button id="modalCancelBtn" class="btn" style="padding:.4rem .8rem;background:#bbb;color:#fff;border-radius:.5rem;">Cancel</button>
        <button id="modalOkBtn" class="btn" style="padding:.4rem .8rem;background:#2563eb;color:#fff;border-radius:.5rem;">OK</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById("modalCodeInput").focus(), 50);
  function close(){ modal.remove(); }
  document.getElementById("modalCancelBtn").onclick = close;
  document.getElementById("modalOkBtn").onclick = () => {
    const val = document.getElementById("modalCodeInput").value;
    callback(val, close, msg => {
      const err = document.getElementById("modalCodeError");
      err.textContent = msg; err.style.display = "block";
    });
  };
  document.getElementById("modalCodeInput").onkeydown = e => { if (e.key === "Enter") document.getElementById("modalOkBtn").click(); };
}

function getMaintState(truckLabel) {
  const map = sensorMapConfig[truckLabel] || {};
  return {
    filterDays:  typeof map.filterDays  === "number" ? map.filterDays  : MAINTENANCE_DEFAULTS.filterDays,
    serviceDays: typeof map.serviceDays === "number" ? map.serviceDays : MAINTENANCE_DEFAULTS.serviceDays,
    lastDecrementDate: map.lastDecrementDate || null,
  };
}

async function saveMaintState(truckLabel, maintObj) {
  sensorMapConfig[truckLabel] = sensorMapConfig[truckLabel] || {};
  Object.assign(sensorMapConfig[truckLabel], maintObj);
  await fetch(
    "https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?token="+UBIDOTS_ACCOUNT_TOKEN,
    { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({value:0,context:sensorMapConfig}) }
  );
}

async function checkAndUpdateMaintCounters(truckLabel, deviceID) {
  const state = getMaintState(truckLabel);
  const today = (new Date()).toISOString().slice(0,10);
  if (state.lastDecrementDate === today) return state;

  let hasActivity = false;
  for (const s of SENSORS) {
    if (!s.address) continue;
    const vals = await fetchUbidotsVar(deviceID, s.address, 1);
    if (vals[0]?.timestamp) {
      if (new Date(vals[0].timestamp).toISOString().slice(0,10) === today) { hasActivity = true; break; }
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

async function renderMaintenanceBox(truckLabel, deviceID) {
  const box = document.getElementById("maintenanceBox");
  if (!box) { onReady(()=>renderMaintenanceBox(truckLabel, deviceID)); return; }
  const state = await checkAndUpdateMaintCounters(truckLabel, deviceID);

  // nicer: progress bars
  const prog = (days,max)=> {
    const pct = Math.max(0, Math.min(100, Math.round(100*(max-days)/max)));
    return `
      <div class="text-sm text-gray-700">${days} day${days===1?"":"s"} to go</div>
      <div class="w-full h-2 bg-gray-200 rounded mt-1">
        <div class="h-2 bg-blue-500 rounded" style="width:${pct}%"></div>
      </div>`;
  };

  box.innerHTML = `
    <h2 class="text-lg font-semibold mb-2">Maintenance Status</h2>
    <div class="space-y-4">
      <div class="flex items-center justify-between gap-4">
        <div class="flex-1">
          <div class="font-medium">Filter Replacement</div>
          ${prog(state.filterDays,60)}
        </div>
        <button id="resetFilterBtn" class="px-3 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white">Reset</button>
      </div>
      <div class="flex items-center justify-between gap-4">
        <div class="flex-1">
          <div class="font-medium">Annual Service</div>
          ${prog(state.serviceDays,365)}
        </div>
        <button id="resetServiceBtn" class="px-3 py-1 rounded bg-blue-500 hover:bg-blue-600 text-white">Reset</button>
      </div>
    </div>
  `;

  document.getElementById("resetFilterBtn").onclick = () =>
    showPromptModal("Enter code to reset filter (60 days):", async (val, close, showError) => {
      if (val === "0000") { await saveMaintState(truckLabel, { filterDays: 60 }); close(); renderMaintenanceBox(truckLabel, deviceID); }
      else showError("Invalid code");
    });

  document.getElementById("resetServiceBtn").onclick = () =>
    showPromptModal("Enter code to reset annual service (365 days):", async (val, close, showError) => {
      if (val === "8971") { await saveMaintState(truckLabel, { serviceDays: 365 }); close(); renderMaintenanceBox(truckLabel, deviceID); }
      else showError("Invalid code");
    });
}

// ========== CSV ==========
async function fetchCsvRows(deviceID, varLabel, start, end) {
  try {
    if (!variableCache[deviceID]) {
      const vr = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, {
        headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
      });
      const vl = await vr.json();
      variableCache[deviceID] = Object.fromEntries(vl.results.map(v=>[v.label,v.id]));
    }
    const id = variableCache[deviceID][varLabel];
    if (!id) return [];
    let url = `https://industrial.api.ubidots.com/api/v1.6/variables/${id}/values/?page_size=1000`;
    if (start) url += `&start=${start}`;
    if (end)   url += `&end=${end}`;
    const res = await fetch(url, { headers:{ "X-Auth-Token":UBIDOTS_ACCOUNT_TOKEN } });
    if (!res.ok) return [];
    return (await res.json()).results||[];
  } catch { return []; }
}

document.getElementById("dlBtn").onclick = async function(){
  const expStatus = document.getElementById("expStatus");
  expStatus.textContent = "Downloading...";
  try {
    const deviceLabel = document.getElementById("deviceSelect").value;
    const startDate = document.getElementById("start").value;
    const endDate   = document.getElementById("end").value;
    const sensorMap = await fetchSensorMapConfig();
    const deviceID  = sensorMap[deviceLabel]?.id;

    if (!SENSORS.length) { expStatus.textContent = "No sensors available for this truck."; return; }
    const addresses = SENSORS.map(s=>s.address).filter(a=>a);
    if (!addresses.length) { expStatus.textContent = "No valid sensor addresses."; return; }

    const startMs = startDate?new Date(startDate).getTime():null;
    const endMs   = endDate? (new Date(endDate).getTime()+24*3600*1000):null;

    const dataByTime = {};
    for (const addr of addresses) {
      const vals = await fetchCsvRows(deviceID, addr, startMs, endMs);
      for (const v of vals) {
        dataByTime[v.timestamp] = dataByTime[v.timestamp]||{};
        dataByTime[v.timestamp][addr] = v.value;
      }
    }

    const times = Object.keys(dataByTime).map(Number).sort((a,b)=>b-a);
    if (!times.length) { expStatus.textContent="No data found for the selected range."; return; }

    const header = ["Timestamp", ...addresses];
    const rows = [header];
    times.forEach(t=>{
      const row = [new Date(+t).toISOString()];
      addresses.forEach(a=> row.push(dataByTime[t][a]!==undefined?dataByTime[t][a]:""));
      rows.push(row);
    });

    const csv = rows.map(r=>r.join(",")).join("\r\n");
    const blob = new Blob([csv],{type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href    = url;
    a.download= `truck_${deviceLabel}_${startDate||"all"}_${endDate||"all"}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 500);
    expStatus.textContent="Download complete!";
  } catch {
    expStatus.textContent="Download failed.";
  }
};

// ========== Main ==========
onReady(() => {
  updateAll();
  setInterval(updateAll, REFRESH_INTERVAL);
  document.getElementById("deviceSelect").addEventListener("change", updateAll);
});

async function updateAll() {
  await fetchSensorMapMapping();
  const sensorMap = await fetchSensorMapConfig();

  buildDeviceDropdownFromConfig(sensorMap);
  const deviceLabel = document.getElementById("deviceSelect").value;
  const deviceID = sensorMap[deviceLabel]?.id;

  // header pill
  try {
    const now = Math.floor(Date.now()/1000);
    const isOnline = sensorMap[deviceLabel] && (now - (sensorMap[deviceLabel].last_seen||0) < 60);
    if (window.__setDeviceStatus) window.__setDeviceStatus(isOnline);
  } catch {}

  if (deviceID) {
    variableCache = {};
    const DALLAS_LIST = await fetchDallasAddresses(deviceID);
    SENSORS = buildSensorSlots(deviceLabel, DALLAS_LIST, sensorMap);
    initCharts(SENSORS);
    await updateCharts(deviceID, SENSORS);
    if (!map) initMap();

    if (pollTimer) clearInterval(pollTimer);
    await poll(deviceID, SENSORS); // immediately
    pollTimer = setInterval(() => { poll(deviceID, SENSORS); }, 15000);
  }

  await renderMaintenanceBox(deviceLabel, deviceID);
}
