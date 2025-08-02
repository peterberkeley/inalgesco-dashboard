// How often (ms) to refresh the config and update the dropdown
const REFRESH_INTERVAL = 60000; // 60 seconds

// Fetch config's sensor_map and build the dropdown
async function updateDropdownFromConfig() {
  // EDIT THIS: Use your real Ubidots account token for the config device!
  const CONFIG_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
  const CONFIG_URL = `https://industrial.api.ubidots.com/api/v1.6/devices/config/sensor_map/values?page_size=1&token=${CONFIG_TOKEN}`;

  try {
    const res = await fetch(CONFIG_URL);
    if (!res.ok) throw new Error("Config fetch failed");
    const js = await res.json();
    const sensorMap = (js.results && js.results[0] && js.results[0].context) ? js.results[0].context : {};

    buildDeviceDropdownFromConfig(sensorMap);

  } catch (err) {
    console.error("Failed to fetch sensor map config:", err);
    // Optionally show a warning in the UI
  }
}

// Build dropdown, showing online/offline using last_seen
function buildDeviceDropdownFromConfig(sensorMap) {
  const deviceSelect = document.getElementById("deviceSelect");
  deviceSelect.innerHTML = "";
  const now = Math.floor(Date.now() / 1000);

  Object.entries(sensorMap).forEach(([dev, obj]) => {
    const label = obj.label || dev.replace("skycafe-", "SkyCafé ");
    const lastSeen = obj.last_seen || 0;
    const isOnline = (now - lastSeen < 60); // 60 seconds for online

    const opt = document.createElement("option");
    opt.value = dev;

    // Add a colored "dot" to status
    const dot = isOnline
      ? "🟢"
      : "⚪️"; // Green for online, white for offline

    opt.text = `${dot} ${label} (${isOnline ? "Online" : "Offline"})`;

    // Optional: Disable offline devices so they can't be selected:
    // if (!isOnline) opt.disabled = true;

    deviceSelect.appendChild(opt);
  });

  // Optionally trigger an initial change event or select the first online
  if (deviceSelect.options.length > 0) {
    // Select first online device, else first in list
    let foundOnline = false;
    for (let i = 0; i < deviceSelect.options.length; i++) {
      if (deviceSelect.options[i].text.includes("Online")) {
        deviceSelect.selectedIndex = i;
        foundOnline = true;
        break;
      }
    }
    if (!foundOnline) deviceSelect.selectedIndex = 0;
    // Optionally trigger your data load logic here
    // onDeviceChange();
  }
}

// On page load, build the dropdown and start interval
document.addEventListener("DOMContentLoaded", () => {
  updateDropdownFromConfig();
  setInterval(updateDropdownFromConfig, REFRESH_INTERVAL);

  // Hook up your deviceSelect change event here
  document.getElementById("deviceSelect").addEventListener("change", function() {
    const selectedDev = this.value;
    // Load and display data for selectedDev as usual
    // onDeviceChange(selectedDev);
    // (You'd want to re-use your usual per-device chart/map/etc logic)
    console.log("Device selected:", selectedDev);
  });
});

// NOTE: The rest of your dashboard.js (charts, map, etc) should still work.
// Just be sure that after the user selects a device, you use `deviceSelect.value`
// for fetching/displaying device data as needed.
(() => {
  // --- Per-device tokens (for MQTT publishing, not needed for read-only REST GETs) ---
  const TOKENS = {
    "skycafe-1":  "BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8",
    "skycafe-2":  "BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P",
    // ... Add up to skycafe-24 here ...
    "skycafe-24": "BBUS-REPLACE_ME_FOR_24"
  };

  // --- Account-level REST API token for listing devices & basic read-only access ---
  const UBIDOTS_ACCOUNT_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
  const CONFIG_TOKEN = "BBUS-aHFXFTCqEcKLRdCzp3zq3U2xirToQB";

  // Use CORS proxy for browser fetches
 const UBIDOTS_BASE = "https://api.allorigins.win/raw?url=https://industrial.api.ubidots.com/api/v1.6";
  const POLL_MS = 10000, HIST = 50, TRAIL = 50;
  const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? "–" : (+v).toFixed(p);

  // --- 1. Fetch ALL device labels ever seen in your Ubidots account ---
  async function fetchDeviceList() {
    const url = `${UBIDOTS_BASE}/devices/?token=${UBIDOTS_ACCOUNT_TOKEN}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log("Failed to fetch devices", res.status);
        return [];
      }
      const js = await res.json();
      // Only include those that start with 'skycafe-' (optional: remove if you want ALL devices)
      return (js.results || []).map(d => d.label).filter(label => label.startsWith("skycafe-"));
    } catch (err) {
      console.log("Device fetch error:", err);
      return [];
    }
  }

  // --- 2. Check if a device is "live" (seen within 60s) ---
  async function checkLiveness(dev, token) {
    const url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const js = await res.json();
      const now = Date.now();
      for (const v of js.results || []) {
        if (
          ["signal", "gps", "iccid"].includes(v.label) &&
          v.last_value && v.last_value.timestamp &&
          (now - v.last_value.timestamp) < 60000
        ) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async function fetchSensorMapConfig() {
    const CONFIG_URL = `${UBIDOTS_BASE}/devices/config/sensor_map/values?page_size=1&token=${CONFIG_TOKEN}`;
    try {
      const res = await fetch(CONFIG_URL);
      if (!res.ok) throw new Error("Failed to fetch sensor map config");
      const js = await res.json();
      return (js.results && js.results[0] && js.results[0].context) ? js.results[0].context : {};
    } catch {
      return {};
    }
  }

  async function fetchDallasAddresses(dev, token) {
    try {
      const url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${token}`;
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

  async function fetchUbidotsVar(dev, variable, token, limit = 1) {
    let url = `${UBIDOTS_BASE}/devices/${dev}/${variable}/values?page_size=${limit}`;
    try {
      const res = await fetch(url, { headers: { "X-Auth-Token": token } });
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

  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map("map").setView([0, 0], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
    marker = L.marker([0, 0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  async function updateCharts(DEVICE, SENSORS, token) {
    await Promise.all(SENSORS.map(async (s, idx) => {
      if (!s.address) return;
      const rows = await fetchUbidotsVar(DEVICE, s.address, token, HIST);
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
      ["ICCID", iccid || "–"],
      ["Lat", fmt(lat, 6)], ["Lon", fmt(lon, 6)],
      ["Speed (km/h)", fmt(speed, 1)], ["RSSI (dBm)", fmt(signal, 0)],
      ["Volt (mV)", fmt(volt, 2)]
    ].concat(sensorRows);
    document.getElementById("latest").innerHTML = rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join("");
    if (isFinite(lat) && isFinite(lon)) {
      marker.setLatLng([lat, lon]);
      trail.push([lat, lon]); if (trail.length > TRAIL) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat, lon], Math.max(map.getZoom(), 13));
    }
  }

  async function poll(DEVICE, SENSORS, token) {
    const [gpsArr, iccArr] = await Promise.all([
      fetchUbidotsVar(DEVICE, "gps", token),
      fetchUbidotsVar(DEVICE, "iccid", token)
    ]);
    let ts = null, lat = null, lon = null, speed = null;
    if (gpsArr[0]?.created_at) ts = gpsArr[0].created_at;
    if (gpsArr[0]?.context) {
      lat = gpsArr[0].context.lat;
      lon = gpsArr[0].context.lng;
      speed = gpsArr[0].context.speed;
    }
    if (!ts) ts = iccArr[0]?.created_at || Date.now();
    const iccidVal = iccArr[0]?.value || null;

    let readings = {};
    await Promise.all(SENSORS.filter(s => s.address).map(async s => {
      const vals = await fetchUbidotsVar(DEVICE, s.address, token, 1);
      if (vals.length && vals[0].value != null) readings[s.address] = parseFloat(vals[0].value);
    }));

    let [signalArr, voltArr, speedArr] = await Promise.all([
      fetchUbidotsVar(DEVICE, "signal", token, 1),
      fetchUbidotsVar(DEVICE, "volt", token, 1),
      fetchUbidotsVar(DEVICE, "speed", token, 1)
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
    setTimeout(() => poll(DEVICE, SENSORS, token), POLL_MS);
  }

  // --- POPULATE DROPDOWN AND START DASHBOARD ---
  document.addEventListener("DOMContentLoaded", async () => {
    const deviceSelect = document.getElementById("deviceSelect");
    deviceSelect.innerHTML = "";

    // 1. Fetch all trucks/devices from Ubidots (with 'skycafe-' prefix)
    let allDevices = await fetchDeviceList();

    // 2. Fetch all mapped trucks from config
    let SENSOR_MAP = await fetchSensorMapConfig();
    let mappedDevices = Object.keys(SENSOR_MAP).filter(label => label.startsWith("skycafe-"));

    // 3. Merge & deduplicate: all in Ubidots devices OR in mapping config
    let mergedDevices = Array.from(new Set([...allDevices, ...mappedDevices]));

    // 4. Figure out which are live/offline
    let deviceStatus = {};
    for (const dev of mergedDevices) {
      const token = TOKENS[dev] || UBIDOTS_ACCOUNT_TOKEN;
      deviceStatus[dev] = await checkLiveness(dev, token) ? "online" : "offline";
    }

    // 5. Build dropdown — offline trucks are selectable and marked "(Offline)"
    mergedDevices.forEach(dev => {
      const opt = document.createElement("option");
      opt.value = dev;
      opt.text = dev.replace("skycafe-", "SkyCafé ");
      if (deviceStatus[dev] === "offline") {
        opt.text += " (Offline)";
      }
      deviceSelect.appendChild(opt);
    });

    // 6. Select first online device (or first if none online)
    let DEVICE = mergedDevices.find(d => deviceStatus[d] === "online") || mergedDevices[0];
    deviceSelect.value = DEVICE;

    // 7. Get token for this device
    let thisToken = TOKENS[DEVICE] || UBIDOTS_ACCOUNT_TOKEN;

    // 8. Setup dashboard
    let DALLAS_LIST = await fetchDallasAddresses(DEVICE, thisToken);
    let SENSORS = buildSensorSlots(DEVICE, DALLAS_LIST, SENSOR_MAP);
    initCharts(SENSORS);
    updateCharts(DEVICE, SENSORS, thisToken).then(() => { initMap(); poll(DEVICE, SENSORS, thisToken); });

    deviceSelect.addEventListener("change", async e => {
      DEVICE = e.target.value;
      thisToken = TOKENS[DEVICE] || UBIDOTS_ACCOUNT_TOKEN;
      document.getElementById("latest").innerHTML = "";
      trail = [];
      if (polyline) polyline.setLatLngs([]);
      DALLAS_LIST = await fetchDallasAddresses(DEVICE, thisToken);
      SENSORS = buildSensorSlots(DEVICE, DALLAS_LIST, SENSOR_MAP);
      initCharts(SENSORS);
      updateCharts(DEVICE, SENSORS, thisToken).then(() => { initMap(); poll(DEVICE, SENSORS, thisToken); });
    });
  });
})();
