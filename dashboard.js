// ========== Configuration ==========
const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const CONFIG_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
const UBIDOTS_BASE = "https://industrial.api.ubidots.com/api/v1.6";
const REFRESH_INTERVAL = 60000;
const HIST = 50;
const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

let SENSORS = [];

// ========== Dropdown population from config ==========
async function fetchSensorMapConfig() {
  const CONFIG_URL = `${UBIDOTS_BASE}/devices/config/sensor_map/values?page_size=1&token=${CONFIG_TOKEN}`;
  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) throw new Error("Config fetch failed");
    const js = await res.json();
    return (js.results && js.results[0] && js.results[0].context) ? js.results[0].context : {};
  } catch (err) {
    console.error("Failed to fetch sensor map config:", err);
    return {};
  }
}

function buildDeviceDropdownFromConfig(sensorMap) {
  const deviceSelect = document.getElementById("deviceSelect");
  const now = Math.floor(Date.now() / 1000);
  deviceSelect.innerHTML = "";
  Object.entries(sensorMap).forEach(([dev, obj]) => {
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
  const url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${UBIDOTS_ACCOUNT_TOKEN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const js = await res.json();
    const now = Date.now();
    return js.results
      .filter(v => /^[0-9a-fA-F]{16}$/.test(v.label))
      .filter(v => {
        let t = (v.last_value && v.last_value.timestamp) || 0;
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

async function fetchUbidotsVar(dev, variable, limit = 1) {
  let url = `${UBIDOTS_BASE}/devices/${dev}/${variable}/values?page_size=${limit}&token=${UBIDOTS_ACCOUNT_TOKEN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const js = await res.json();
    return js.results || [];
  } catch {
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
    s.chart.data.labels = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true }));
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
    ["ICCID]()
