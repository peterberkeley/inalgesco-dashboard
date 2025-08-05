// ========== Configuration ==========
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";
const REFRESH_INTERVAL = 60000;
const HIST = 50;
const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

let SENSORS = [];
let variableCache = {};

// ========== Sensor Mapping from Admin ==========
let sensorMapConfig = {};

async function fetchSensorMapMapping() {
  try {
    const res = await fetch('https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?page_size=1', {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    const js = await res.json();
    if (js.results && js.results[0] && js.results[0].context) {
      sensorMapConfig = js.results[0].context;
    } else {
      sensorMapConfig = {};
    }
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
  const sortedEntries = Object.entries(sensorMap).sort(([a], [b]) => {
    const numA = parseInt(a.replace("skycafe-", ""), 10);
    const numB = parseInt(b.replace("skycafe-", ""), 10);
    return numA - numB;
  });
  sortedEntries.forEach(([dev, obj]) => {
    const label = obj.label || dev.replace("skycafe-", "SkyCafé ");
    const lastSeen = obj.last_seen || 0;
    const isOnline = (now - lastSeen < 60);
    const dot = isOnline ? "🟢" : "⚪️";
    const opt = document.createElement("option");
    opt.value = dev;
    opt.text = `${dot} ${label} (${isOnline ? "Online" : "Offline"})`;
    deviceSelect.appendChild(opt);
  });
  let foundOnline = false;
  for (let i = 0; i < deviceSelect.options.length; i++) {
    if (deviceSelect.options[i].text.includes("Online")) {
      deviceSelect.selectedIndex = i;
      foundOnline = true;
      break;
    }
  }
  if (!foundOnline) deviceSelect.selectedIndex = 0;
}

// ========== Utility and chart functions ==========
const fmt = (v, p = 1) => (v == null || isNaN(v)) ? "–" : (+v).toFixed(p);

async function fetchDallasAddresses(deviceID) {
  const url = `${UBIDOTS_BASE}/variables/?device=${deviceID}`;
  try {
    const res = await fetch(url, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!res.ok) {
      console.error("[fetchDallasAddresses]  API error:", res.status, "for deviceID:", deviceID);
      return [];
    }
    const js = await res.json();
    const now = Date.now();
    return js.results
      .filter(v => /^[0-9a-fA-F]{16}$/.test(v.label))
      .filter(v => {
        let t = (v.lastValue && v.lastValue.timestamp) || 0;
        return (now - t) < 3 * 60 * 1000;
      })
      .map(v => v.label)
      .sort();
  } catch (err) {
    console.error("[fetchDallasAddresses]  Exception:", err, "for deviceID:", deviceID);
    return [];
  }
}

function buildSensorSlots(deviceLabel, DALLAS_LIST, SENSOR_MAP) {
  const mapped = SENSOR_MAP[deviceLabel] || {};
  const allAddr = DALLAS_LIST.slice(0, 5);
  while (allAddr.length < 5) allAddr.push(null);
  return allAddr.map((addr, idx) => {
    if (!addr) return {
      id: `empty${idx}`,
      label: "",
      col: SENSOR_COLORS[idx],
      chart: null,
      address: null,
      mapped: null,
      calibration: 0
    };
    // Use admin-mapped label if available, else fallback to address
    let adminMapForDev = sensorMapConfig[deviceLabel] || {};
    let label = adminMapForDev[addr]?.label?.trim() || mapped[addr]?.label?.trim() || addr;
    let offset = typeof adminMapForDev[addr]?.offset === "number"
      ? adminMapForDev[addr].offset
      : (typeof mapped[addr]?.offset === "number" ? mapped[addr].offset : 0);
    return {
      id: addr,
      label,
      col: SENSOR_COLORS[idx],
      chart: null,
      address: addr,
      mapped: mapped[addr],
      calibration: offset
    };
  });
}

async function fetchUbidotsVar(deviceID, variable, limit = 1) {
  try {
    if (!variableCache[deviceID]) {
      // Get all variables for this device (by device ID)
      const varRes = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, {
        headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
      });
      if (!varRes.ok) {
        console.error("[fetchUbidotsVar] Variable fetch failed for deviceID:", deviceID, "status:", varRes.status);
        return [];
      }
      const varList = await varRes.json();
      variableCache[deviceID] = {};
      varList.results.forEach(v => {
        variableCache[deviceID][v.label] = v.id;
      });
    }
    const varId = variableCache[deviceID][variable];
    if (!varId) {
      return [];
    }
    const valRes = await fetch(`https://industrial.api.ubidots.com/api/v1.6/variables/${varId}/values/?page_size=${limit}`, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!valRes.ok) {
      return [];
    }
    const js = await valRes.json();
    return js.results || [];
  } catch (err) {
    return [];
  }
}

function initCharts(SENSORS) {
  const ctr = document.getElementById("charts");
  ctr.innerHTML = "";
  SENSORS.forEach(s => {
    s.chart = null;
    const card = document.createElement("div");
    card.className = "chart-box";
    card.innerHTML = `<h2>${s.label || ""}</h2><canvas></canvas>`;
    ctr.appendChild(card);
    const ctx = card.querySelector("canvas").getContext("2d");
    s.chart = new Chart(ctx, {
      type: "line",
      data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  });
}

async function updateCharts(deviceID, SENSORS) {
  await Promise.all(SENSORS.map(async (s, idx) => {
    if (!s.address) return;
    const rows = await fetchUbidotsVar(deviceID, s.address, HIST);
    if (!rows.length) return;
    s.chart.data.labels = rows.map(r => new Date(r.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }));
    s.chart.data.datasets[0].data = rows.map(r => {
      let val = parseFloat(r.value);
      if (typeof s.calibration === "number") val += s.calibration;
      return isNaN(val) ? null : val;
    });
    s.chart.update();
  }));
}

function drawLive(data, SENSORS) {
  let { ts, iccid, lat, lon, speed, signal, volt, addresses, readings } = data;
  if (!ts) ts = Date.now();
  const sensorRows = SENSORS.map((s, idx) =>
    [s.label, s.address && readings[s.address] != null ? fmt(readings[s.address] + (s.calibration || 0), 1) : ""]
  );
  const rows = [
    ["Local Time", ts ? new Date(ts).toLocaleString() : "–"],
    ["ICCID", iccid || "–"],
    ["Lat", fmt(lat, 6)], ["Lon", fmt(lon, 6)],
    ["Speed (km/h)", fmt(speed, 1)], ["RSSI (dBm)", fmt(signal, 0)],
    ["Volt (mV)", fmt(volt, 2)]
  ].concat(sensorRows);
  document.getElementById("latest").innerHTML = rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("");
  if (lat != null && lon != null && isFinite(lat) && isFinite(lon)) {
    marker.setLatLng([lat, lon]);
    trail.push([lat, lon]); if (trail.length > 50) trail.shift();
    polyline.setLatLngs(trail);
    map.setView([lat, lon], Math.max(map.getZoom(), 13));
  }
}

async function poll(deviceID, SENSORS) {
  const [gpsArr, iccArr] = await Promise.all([
    fetchUbidotsVar(deviceID, "gps"),
    fetchUbidotsVar(deviceID, "iccid")
  ]);
  let ts = null, lat = null, lon = null, speed = null;
  if (gpsArr[0]?.timestamp) ts = gpsArr[0].timestamp;
  if (gpsArr[0]?.context) {
    lat = gpsArr[0].context.lat;
    lon = gpsArr[0].context.lng;
    speed = gpsArr[0].context.speed;
  }
  if (!ts) ts = iccArr[0]?.timestamp || Date.now();
  const iccidVal = iccArr[0]?.value || null;
  let readings = {};
  await Promise.all(SENSORS.filter(s => s.address).map(async s => {
    const vals = await fetchUbidotsVar(deviceID, s.address, 1);
    if (vals.length && vals[0].value != null) readings[s.address] = parseFloat(vals[0].value);
  }));
  let [signalArr, voltArr, speedArr] = await Promise.all([
    fetchUbidotsVar(deviceID, "signal", 1),
    fetchUbidotsVar(deviceID, "volt", 1),
    fetchUbidotsVar(deviceID, "speed", 1)
  ]);
  let signalVal = signalArr[0]?.value || null;
  let voltVal = voltArr[0]?.value || null;
  let speedVal = speedArr[0]?.value || null;
  drawLive(
    {
      ts, iccid: iccidVal, lat, lon, speed: speedVal,
      signal: signalVal, volt: voltVal, addresses: SENSORS.map(s => s.address), readings
    },
    SENSORS
  );
}

// ========== Map init ==========
let map, marker, polyline, trail = [];
function initMap() {
  map = L.map("map").setView([0, 0], 2);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
  marker = L.marker([0, 0]).addTo(map);
  polyline = L.polyline([], { weight: 3 }).addTo(map);
}

// ========== Main ==========
async function updateAll() {
  await fetchSensorMapMapping(); // << fetch mapping from admin
  const sensorMap = await fetchSensorMapConfig();
  buildDeviceDropdownFromConfig(sensorMap);
  const deviceSelect = document.getElementById("deviceSelect");
  const deviceLabel = deviceSelect.value;
  const deviceID = sensorMap[deviceLabel]?.id;
  if (!deviceID) {
    console.error("Device ID not found for label:", deviceLabel, sensorMap);
    return;
  }
  variableCache = {};
  const DALLAS_LIST = await fetchDallasAddresses(deviceID);
  SENSORS = buildSensorSlots(deviceLabel, DALLAS_LIST, sensorMap);
  initCharts(SENSORS);
  await updateCharts(deviceID, SENSORS);
  if (!map) initMap();
  poll(deviceID, SENSORS);
  await renderMaintenanceBox(deviceLabel, deviceID); // <- pass deviceID too!
}

document.addEventListener("DOMContentLoaded", () => {
  updateAll();
  setInterval(updateAll, REFRESH_INTERVAL);
  document.getElementById("deviceSelect").addEventListener("change", async function() {
    await updateAll();
  });
});

// ========== MAINTENANCE UI & RESET LOGIC ==========

// Single definition!
const MAINTENANCE_DEFAULTS = { filterDays: 60, serviceDays: 365, lastDecrementDate: null };

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
    <div style="background:#fff; border-radius:1rem; box-shadow:0 6px 24px rgba(0,0,0,0.12); padding:2rem 2.5rem; display:flex; flex-direction:column; align-items:center; gap:1rem; min-width:280px;">
      <div style="font-size:1.15rem; font-weight:600; margin-bottom:0.5rem;">${message}</div>
      <input type="password" id="modalCodeInput" style="font-size:1.1rem; padding:0.4rem 0.7rem; border-radius:0.5rem; border:1px solid #ccc; width:10rem;" autocomplete="off" autofocus>
      <div style="color:#c00; font-weight:600; display:none" id="modalCodeError"></div>
      <div style="display:flex; gap:1rem;">
        <button id="modalOkBtn" class="btn" style="min-width:70px;">OK</button>
        <button id="modalCancelBtn" class="btn" style="background:#bbb; color:#fff;">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  setTimeout(() => document.getElementById("modalCodeInput").focus(), 50);

  function close() { modal.remove(); }
  document.getElementById("modalCancelBtn").onclick = close;
  document.getElementById("modalOkBtn").onclick = () => {
    const val = document.getElementById("modalCodeInput").value;
    callback(val, close, function showError(msg) {
      const err = document.getElementById("modalCodeError");
      err.textContent = msg;
      err.style.display = "block";
    });
  };
  document.getElementById("modalCodeInput").onkeydown = function(e) {
    if (e.key === "Enter") document.getElementById("modalOkBtn").click();
  };
}

function getMaintState(truckLabel) {
  const map = sensorMapConfig[truckLabel] || {};
  return {
    filterDays: typeof map.filterDays === "number" ? map.filterDays : MAINTENANCE_DEFAULTS.filterDays,
    serviceDays: typeof map.serviceDays === "number" ? map.serviceDays : MAINTENANCE_DEFAULTS.serviceDays,
    lastDecrementDate: map.lastDecrementDate || null,
  };
}

async function saveMaintState(truckLabel, maintObj) {
  if (!sensorMapConfig[truckLabel]) sensorMapConfig[truckLabel] = {};
  Object.assign(sensorMapConfig[truckLabel], maintObj);
  await fetch('https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?token=' + UBIDOTS_ACCOUNT_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: 0, context: sensorMapConfig })
  });
}

async function checkAndUpdateMaintCounters(truckLabel, deviceID) {
  let state = getMaintState(truckLabel);
  let today = (new Date()).toISOString().slice(0,10);
  if (state.lastDecrementDate === today) return state;
  let hasActivityToday = false;
  for (let s of SENSORS) {
    if (!s.address) continue;
    let vals = await fetchUbidotsVar(deviceID, s.address, 1);
    if (vals && vals.length && vals[0].timestamp) {
      let dt = new Date(vals[0].timestamp);
      let valDay = dt.toISOString().slice(0,10);
      if (valDay === today) {
        hasActivityToday = true;
        break;
      }
    }
  }
  if (hasActivityToday) {
    if (state.filterDays > 0) state.filterDays--;
    if (state.serviceDays > 0) state.serviceDays--;
    state.lastDecrementDate = today;
    await saveMaintState(truckLabel, state);
  }
  return state;
}

async function renderMaintenanceBox(truckLabel, deviceID) {
  const box = document.getElementById("maintenanceBox");
  console.log("Rendering maintenance box for", truckLabel, deviceID, box);
  if (!box) {
    console.error("No #maintenanceBox found in DOM");
    return;
  }
  let state = await checkAndUpdateMaintCounters(truckLabel, deviceID);
  console.log("Maintenance state is", state);
  function color(days) { return days <= 0 ? "red" : "#1f2937"; }
  box.innerHTML = `
    <div style="margin-bottom:0.8em;">
      <span style="font-weight:600;">Filter Replacement:</span>
      <span style="color:${color(state.filterDays)}; font-weight:600; margin-left:0.5em;">
        ${state.filterDays} day${state.filterDays === 1 ? "" : "s"} to go
      </span>
      <button id="resetFilterBtn" class="btn" style="margin-left:1.2em; font-size:0.95em; padding:0.2em 1em;">Reset</button>
    </div>
    <div>
      <span style="font-weight:600;">Annual Service:</span>
      <span style="color:${color(state.serviceDays)}; font-weight:600; margin-left:0.5em;">
        ${state.serviceDays} day${state.serviceDays === 1 ? "" : "s"} to go
      </span>
      <button id="resetServiceBtn" class="btn" style="margin-left:1.2em; font-size:0.95em; padding:0.2em 1em;">Reset</button>
    </div>
  `;
  document.getElementById("resetFilterBtn").onclick = () => {
    showPromptModal("Enter code to reset filter (60 days):", async (val, close, showError) => {
      if (val === "0000") {
        await saveMaintState(truckLabel, { filterDays: 60 });
        close();
        renderMaintenanceBox(truckLabel, deviceID);
      } else {
        showError("Invalid code");
      }
    });
  };
  document.getElementById("resetServiceBtn").onclick = () => {
    showPromptModal("Enter code to reset annual service (365 days):", async (val, close, showError) => {
      if (val === "8971") {
        await saveMaintState(truckLabel, { serviceDays: 365 });
        close();
        renderMaintenanceBox(truckLabel, deviceID);
      } else {
        showError("Invalid code");
      }
    });
  };
}


// ========== CSV Download (robust version) ==========

async function fetchCsvRows(deviceID, varLabel, start, end) {
  try {
    if (!variableCache[deviceID]) {
      const varRes = await fetch(`${UBIDOTS_BASE}/variables/?device=${deviceID}`, {
        headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
      });
      const varList = await varRes.json();
      variableCache[deviceID] = {};
      varList.results.forEach(v => variableCache[deviceID][v.label] = v.id);
    }
    const varId = variableCache[deviceID][varLabel];
    if (!varId) {
      console.warn("[CSV] Variable not found for address:", varLabel);
      return [];
    }
    let url = `https://industrial.api.ubidots.com/api/v1.6/variables/${varId}/values/?page_size=1000`;
    if (start) url += `&start=${start}`;
    if (end) url += `&end=${end}`;
    const res = await fetch(url, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!res.ok) {
      return [];
    }
    const js = await res.json();
    return js.results || [];
  } catch (err) {
    return [];
  }
}

document.getElementById("dlBtn").onclick = async function() {
  const expStatus = document.getElementById("expStatus");
  expStatus.textContent = "Downloading...";
  try {
    const deviceSelect = document.getElementById("deviceSelect");
    const deviceLabel = deviceSelect.value;
    const startDate = document.getElementById("start").value;
    const endDate = document.getElementById("end").value;
    const sensorMap = await fetchSensorMapConfig();
    const deviceID = sensorMap[deviceLabel]?.id;

    const slots = SENSORS;
    if (!slots || !slots.length) {
      expStatus.textContent = "No sensors available for this truck.";
      return;
    }
    let adminMapForDev = sensorMapConfig[deviceLabel] || {};
    const addresses = slots.map(s => s.address).filter(addr => !!addr);
    if (!addresses.length) {
      expStatus.textContent = "No valid sensor addresses.";
      return;
    }

    let startMs = startDate ? new Date(startDate).getTime() : null;
    let endMs = endDate ? (new Date(endDate).getTime() + 24 * 3600 * 1000) : null;

    let csvRows = [];
    let header = ["Timestamp", ...addresses.map(addr => (adminMapForDev[addr]?.label || addr))];
    csvRows.push(header);

    let dataByTime = {};
    for (let addr of addresses) {
      let vals = await fetchCsvRows(deviceID, addr, startMs, endMs);
      for (let v of vals) {
        let t = v.timestamp;
        if (!dataByTime[t]) dataByTime[t] = {};
        dataByTime[t][addr] = v.value;
      }
    }

    let times = Object.keys(dataByTime).map(Number).sort((a, b) => b - a);
    if (!times.length) {
      expStatus.textContent = "No data found for the selected range.";
      return;
    }
    for (let t of times) {
      let row = [new Date(t).toISOString()];
      for (let addr of addresses) {
        row.push(dataByTime[t][addr] !== undefined ? dataByTime[t][addr] : "");
      }
      csvRows.push(row);
    }

    let csv = csvRows.map(r => r.join(",")).join("\r\n");
    let blob = new Blob([csv], {type: "text/csv"});
    let url = URL.createObjectURL(blob);
    let a = document.createElement("a");
    a.href = url;
    a.download = `truck_${deviceLabel}_${startDate || "all"}_${endDate || "all"}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
    expStatus.textContent = "Download complete!";
  } catch (err) {
    expStatus.textContent = "Download failed.";
  }
};
