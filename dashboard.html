// ========== Configuration ==========
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v2.0";
const REFRESH_INTERVAL = 60000;
const HIST = 50;
const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

let SENSORS = [];

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
        context[name] = {
          label,
          last_seen: Math.floor(lastSeen / 1000)
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

async function fetchDallasAddresses(dev) {
  const url = `${UBIDOTS_BASE}/variables/?device=${dev}`;
  try {
    const res = await fetch(url, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!res.ok) return [];
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
  } catch {
    return [];
  }
}

function buildSensorSlots(DEVICE, DALLAS_LIST, SENSOR_MAP) {
  const mapped = SENSOR_MAP[DEVICE] || {};
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
    let label = mapped[addr]?.label?.trim() || addr;
    let offset = typeof mapped[addr]?.offset === "number" ? mapped[addr].offset : 0;
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

const variableCache = {};

async function fetchUbidotsVar(dev, variable, limit = 1) {
  try {
    if (!variableCache[dev]) {
      const varRes = await fetch(`${UBIDOTS_BASE}/devices/${dev}/variables/`, {
        headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
      });
      if (!varRes.ok) {
        console.error("[ERROR] Variable fetch failed for device:", dev);
        return [];
      }
      const varList = await varRes.json();
      variableCache[dev] = {};
      console.log("[DEBUG] Variables for", dev, varList.results.map(v => v.label));
      varList.results.forEach(v => {
        variableCache[dev][v.label] = v.id;
      });
    }
    const varId = variableCache[dev][variable];
    if (!varId) {
      console.warn(`[WARN] No variable ID found for '${variable}' on device '${dev}'`);
      return [];
    }
    const valRes = await fetch(`${UBIDOTS_BASE}/variables/${varId}/values/?page_size=${limit}`, {
      headers: { "X-Auth-Token": UBIDOTS_ACCOUNT_TOKEN }
    });
    if (!valRes.ok) {
      console.error(`[ERROR] Value fetch failed for variable '${variable}' (id=${varId}) on device '${dev}'`);
      return [];
    }
    const js = await valRes.json();
    return js.results || [];
  } catch (err) {
    console.error("[EXCEPTION] fetchUbidotsVar error:", err);
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

async function updateCharts(DEVICE, SENSORS) {
  await Promise.all(SENSORS.map(async (s, idx) => {
    if (!s.address) return;
    const rows = await fetchUbidotsVar(DEVICE, s.address, HIST);
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

async function poll(DEVICE, SENSORS) {
  const [gpsArr, iccArr] = await Promise.all([
    fetchUbidotsVar(DEVICE, "gps"),
    fetchUbidotsVar(DEVICE, "iccid")
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
    const vals = await fetchUbidotsVar(DEVICE, s.address, 1);
    if (vals.length && vals[0].value != null) readings[s.address] = parseFloat(vals[0].value);
  }));
  let [signalArr, voltArr, speedArr] = await Promise.all([
    fetchUbidotsVar(DEVICE, "signal", 1),
    fetchUbidotsVar(DEVICE, "volt", 1),
    fetchUbidotsVar(DEVICE, "speed", 1)
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
  const sensorMap = await fetchSensorMapConfig();
  buildDeviceDropdownFromConfig(sensorMap);
  const deviceSelect = document.getElementById("deviceSelect");
  const DEVICE = deviceSelect.value;
  const DALLAS_LIST = await fetchDallasAddresses(DEVICE);
  SENSORS = buildSensorSlots(DEVICE, DALLAS_LIST, sensorMap);
  initCharts(SENSORS);
  await updateCharts(DEVICE, SENSORS);
  if (!map) initMap();
  poll(DEVICE, SENSORS);
}

document.addEventListener("DOMContentLoaded", () => {
  updateAll();
  setInterval(updateAll, REFRESH_INTERVAL);
  document.getElementById("deviceSelect").addEventListener("change", async function() {
    await updateAll();
  });
});
