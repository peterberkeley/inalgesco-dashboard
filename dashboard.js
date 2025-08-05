let _maintenanceLogged = false;
// ========== Configuration ==========
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";
const REFRESH_INTERVAL = 60000;
const HIST = 50;
const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

let SENSORS = [];
let variableCache = {};
let sensorMapConfig = {};

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
      'https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?page_size=1',
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
      .filter(dev => dev.name.startsWith("skycafe-"))
      .forEach(dev => {
        const name = dev.name;
        const label = dev.label || name.replace("skycafe-", "SkyCafé ");
        const lastSeen = dev.lastActivity ? new Date(dev.lastActivity).getTime() : 0;
        const id = dev.id || dev._id || dev["$id"];
        context[name] = {
          label,
          last_seen: Math.floor(lastSeen / 1000),
          id
        };
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
    .sort(([a], [b]) => parseInt(a.replace("skycafe-", ""),10) - parseInt(b.replace("skycafe-", ""),10))
    .forEach(([dev, obj]) => {
      const isOnline = (now - (obj.last_seen||0) < 60);
      const dot = isOnline ? "🟢" : "⚪️";
      const opt = document.createElement("option");
      opt.value = dev;
      opt.text = `${dot} ${obj.label} (${isOnline?"Online":"Offline"})`;
      deviceSelect.appendChild(opt);
    });
  const opts = deviceSelect.options;
  for (let i=0;i<opts.length;i++){
    if (opts[i].text.includes("Online")) { deviceSelect.selectedIndex=i; return; }
  }
}

const fmt = (v,p=1)=>(v==null||isNaN(v))?"–":(+v).toFixed(p);

async function fetchDallasAddresses(deviceID) {
  try {
    const res = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!res.ok) {
      console.error("[fetchDallasAddresses] API error:", res.status);
      return [];
    }
    const js = await res.json();
    const now = Date.now();
    return js.results
      .filter(v=>/^[0-9a-fA-F]{16}$/.test(v.label))
      .filter(v=>((v.lastValue?.timestamp)||0) > now - 3*60*1000)
      .map(v=>v.label)
      .sort();
  } catch(e) {
    console.error("[fetchDallasAddresses] Exception:", e);
    return [];
  }
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
                : typeof mapped[addr]?.offset==="number" ? mapped[addr].offset
                : 0;
    return { id:addr, label, col:SENSOR_COLORS[idx], chart:null, address:addr, mapped:mapped[addr], calibration:calib };
  });
}

// ========== Fetch Ubidots variable values ==========
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
  } catch(e){
    return [];
  }
}

// ========== Chart initialization & updating ==========
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
      data:{ labels:[], datasets:[{ data:[], borderColor:s.col, borderWidth:2, tension:0.25 }]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } } }
    });
  });
}

async function updateCharts(deviceID, SENSORS) {
  await Promise.all(SENSORS.map(async s=>{
    if(!s.address) return;
    const rows = await fetchUbidotsVar(deviceID,s.address,HIST);
    if(!rows.length) return;
    s.chart.data.labels = rows.map(r=>new Date(r.timestamp).toLocaleTimeString([], { hour:"numeric", minute:"2-digit", hour12:true }));
    s.chart.data.datasets[0].data = rows.map(r=>{
      let v=parseFloat(r.value);
      if(typeof s.calibration==="number") v+=s.calibration;
      return isNaN(v)?null:v;
    });
    s.chart.update();
  }));
}

function drawLive(data,SENSORS){
  let {ts,iccid,lat,lon,speed,signal,volt,readings} = data;
  ts=ts||Date.now();
  const sensorRows = SENSORS.map(s=>[s.label, s.address && readings[s.address]!=null?fmt(readings[s.address]+(s.calibration||0),1):""]);
  const rows = [
    ["Local Time", new Date(ts).toLocaleString()],
    ["ICCID", iccid||"–"], ["Lat", fmt(lat,6)], ["Lon", fmt(lon,6)],
    ["Speed (km/h)", fmt(speed,1)], ["RSSI (dBm)", fmt(signal,0)], ["Volt (mV)", fmt(volt,2)]
  ].concat(sensorRows);
  document.getElementById("latest").innerHTML = rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("");
  if(lat!=null&&lon!=null&&isFinite(lat)&&isFinite(lon)){
    marker.setLatLng([lat,lon]);
    trail.push([lat,lon]); if(trail.length>50) trail.shift();
    polyline.setLatLngs(trail);
    map.setView([lat,lon], Math.max(map.getZoom(),13));
  }
}

async function poll(deviceID,SENSORS){
  const [gpsArr,iccArr] = await Promise.all([
    fetchUbidotsVar(deviceID,"gps"),
    fetchUbidotsVar(deviceID,"iccid")
  ]);
  let ts=gpsArr[0]?.timestamp||iccArr[0]?.timestamp||Date.now();
  let lat=gpsArr[0]?.context?.lat, lon=gpsArr[0]?.context?.lng, speedVal=gpsArr[0]?.context?.speed;
  const iccidVal=iccArr[0]?.value||null;
  let readings={};
  await Promise.all(SENSORS.filter(s=>s.address).map(async s=>{
    const v=await fetchUbidotsVar(deviceID,s.address,1);
    if(v.length&&v[0].value!=null) readings[s.address]=parseFloat(v[0].value);
  }));
  const [signalArr,voltArr] = await Promise.all([
    fetchUbidotsVar(deviceID,"signal",1),
    fetchUbidotsVar(deviceID,"volt",1)
  ]);
  drawLive({
    ts, iccid:iccidVal, lat, lon, speed:speedVal,
    signal:signalArr[0]?.value||null, volt:voltArr[0]?.value||null, readings
  },SENSORS);
}

// ========== Map init ==========
let map, marker, polyline, trail=[];
function initMap(){
  map = L.map("map").setView([0,0],2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
  marker = L.marker([0,0]).addTo(map);
  polyline = L.polyline([],{ weight:3 }).addTo(map);
}
// ========== MAINTENANCE UI & RESET LOGIC ==========
const MAINTENANCE_DEFAULTS = { filterDays:60, serviceDays:365, lastDecrementDate:null };

function showPromptModal(message, callback) {
  const old = document.getElementById("promptModal");
  if (old) old.remove();

  const modal = document.createElement("div");
  modal.id = "promptModal";
  modal.style.position = "fixed";
  modal.style.top = "0"; modal.style.left = "0";
  modal.style.width = "100vw"; modal.style.height = "100vh";
  modal.style.background = "rgba(0,0,0,0.15)";
  modal.style.display = "flex"; modal.style.alignItems = "center"; modal.style.justifyContent = "center";
  modal.innerHTML = `
    <div style="background:#fff;border-radius:1rem;box-shadow:0 6px 24px rgba(0,0,0,0.12);padding:2rem;display:flex;flex-direction:column;align-items:center;gap:1rem;min-width:280px;">
      <div style="font-size:1.15rem;font-weight:600;">${message}</div>
      <input id="modalCodeInput" type="password" style="font-size:1.1rem;padding:0.4rem;border-radius:0.5rem;border:1px solid #ccc;width:10rem;" autocomplete="off" autofocus>
      <div id="modalCodeError" style="color:#c00;font-weight:600;display:none;"></div>
      <div style="display:flex;gap:1rem;">
        <button id="modalOkBtn" class="btn" style="min-width:70px;">OK</button>
        <button id="modalCancelBtn" class="btn" style="background:#bbb;color:#fff;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById("modalCodeInput").focus(), 50);

  function close() { modal.remove(); }
  document.getElementById("modalCancelBtn").onclick = close;
  document.getElementById("modalOkBtn").onclick = () => {
    const val = document.getElementById("modalCodeInput").value;
    callback(val, close, msg => {
      const err = document.getElementById("modalCodeError");
      err.textContent = msg;
      err.style.display = "block";
    });
  };
  document.getElementById("modalCodeInput").onkeydown = e => {
    if (e.key === "Enter") document.getElementById("modalOkBtn").click();
  };
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
    'https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?token='+UBIDOTS_ACCOUNT_TOKEN,
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
      if (new Date(vals[0].timestamp).toISOString().slice(0,10) === today) {
        hasActivity = true; break;
      }
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
  console.clear();
  console.log("🔍 maintenanceBox element:", document.getElementById("maintenanceBox"));
  const box = document.getElementById("maintenanceBox");
  if (!box) {
    console.warn("⚠️ maintenanceBox not found, will defer");
    onReady(()=>renderMaintenanceBox(truckLabel, deviceID));
    return;
  }
  console.log("⏯ renderMaintenanceBox called for", truckLabel, deviceID);
  const state = await checkAndUpdateMaintCounters(truckLabel, deviceID);
  console.log("🔍 renderMaintenanceBox got state:", state);

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
    </div>
  `;

  document.getElementById("resetFilterBtn").onclick = () =>
    showPromptModal("Enter code to reset filter (60 days):", async (val, close, showError) => {
      if (val === "0000") {
        await saveMaintState(truckLabel, { filterDays: 60 });
        close(); renderMaintenanceBox(truckLabel, deviceID);
      } else showError("Invalid code");
    });

  document.getElementById("resetServiceBtn").onclick = () =>
    showPromptModal("Enter code to reset annual service (365 days):", async (val, close, showError) => {
      if (val === "8971") {
        await saveMaintState(truckLabel, { serviceDays: 365 });
        close(); renderMaintenanceBox(truckLabel, deviceID);
      } else showError("Invalid code");
    });
}
// ========== CSV Download ==========
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
  } catch {
    return [];
  }
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

    if (!SENSORS.length) {
      expStatus.textContent = "No sensors available for this truck."; return;
    }
    const adminMap = sensorMapConfig[deviceLabel]||{};
    const addresses = SENSORS.map(s=>s.address).filter(a=>a);
    if (!addresses.length) {
      expStatus.textContent = "No valid sensor addresses."; return;
    }

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
    if (!times.length) {
      expStatus.textContent="No data found for the selected range."; return;
    }

    const header = ["Timestamp", ...addresses.map(a=>adminMap[a]?.label||a)];
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
  console.log("⏯ updateAll() entered");
  await fetchSensorMapMapping();
  const sensorMap = await fetchSensorMapConfig();
  console.log("🔍 sensorMap:", sensorMap);

  buildDeviceDropdownFromConfig(sensorMap);
  const deviceLabel = document.getElementById("deviceSelect").value;
  console.log("🔍 selected device label:", deviceLabel);

  const deviceID = sensorMap[deviceLabel]?.id;
  console.log("🔍 resolved deviceID:", deviceID);

  if (deviceID) {
    variableCache = {};
    const DALLAS_LIST = await fetchDallasAddresses(deviceID);
    SENSORS = buildSensorSlots(deviceLabel, DALLAS_LIST, sensorMap);
    initCharts(SENSORS);
    await updateCharts(deviceID, SENSORS);
    if (!map) initMap();
    poll(deviceID, SENSORS);
  } else {
    console.error("Device ID not found for label:", deviceLabel, sensorMap);
  }

  console.log("⏯ about to call renderMaintenanceBox");
  await renderMaintenanceBox(deviceLabel, deviceID);
  console.log("✅ renderMaintenanceBox completed");
}
