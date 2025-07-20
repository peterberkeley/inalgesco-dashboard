(() => {
  // ===[TOKENS PER DEVICE]===
  const TOKENS = {
    "skycafe-1":  "BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8",
    "skycafe-2":  "BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P",
    "skycafe-3":  "BBUS-iA1d3odtdyBl1Li3aTxeffacaYzbTW",
    "skycafe-4":  "BBUS-02xhIPOIpmMrGv5OwS2XX5La6Nn7ma",
    "skycafe-5":  "BBUS-FV7oZN9Xc45nxYevSaopBl7k5PEulk",
    "skycafe-6":  "BBUS-seXBbsBXsrBMy36xrszv69tOJK9q33",
    "skycafe-7":  "BBUS-7iuQhKnTINTKKJE1mkFryTZmZNYAmU",
    "skycafe-8":  "BBUS-KgQ7uvh3QgFNeRj6EGQTvTKH91Y0hv",
    "skycafe-9":  "BBUS-OCoYOgeBSeIOOlExVxm59W1dqVYB7p",
    "skycafe-10": "BBUS-hUwkXc9JKvaNq5cl8H3sMRPR0AZvj2",
    "skycafe-11": "BBUS-1AFBfwaDmRrpWPUDuKfMWxVjdpeG7O",
    "skycafe-12": "BBUS-4flIrJ1FKcQUHh0c0z7HQrg458lSZ4"
  };
  const CONFIG_TOKEN = "BBUS-aHFXFTCqEcKLRdCzp3zq3U2xirToQB";

  // ===[SETTINGS AND CONSTANTS]===
  const DEVICES = Object.keys(TOKENS);
  const UBIDOTS_BASE = "https://corsproxy.io/?https://industrial.api.ubidots.com/api/v1.6";
  const POLL_MS = 10000, HIST = 50, TRAIL = 50;
  const SENSOR_COLORS = ["#2563eb", "#0ea5e9", "#10b981", "#8b5cf6", "#10b981"];

  // ===[UI THEME]===
  function getCSS(varName, fallback = "") {
    return (getComputedStyle(document.documentElement).getPropertyValue(varName) || "").trim() || fallback;
  }

  // ===[FETCH CONFIGURATION MAP (per device)]===
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

  // ===[FETCH ADDRESSES FOR TRUCK]===
  async function fetchDallasAddresses(dev) {
    try {
      const token = TOKENS[dev];
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

  // ===[SENSOR SLOT BUILDER]===
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

  // ===[CHECK IF TRUCK IS LIVE (any var in last 60s)]===
  async function checkLiveness(dev) {
    const token = TOKENS[dev];
    const url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${token}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      const js = await res.json();
      const now = Date.now();
      for (const v of js.results || []) {
        if (v.last_value && v.last_value.timestamp) {
          const diff = now - v.last_value.timestamp;
          if (diff < 60000) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  // ===[FETCH UBIDOTS VARIABLE]===
  async function fetchUbidotsVar(dev, variable, limit = 1) {
    const token = TOKENS[dev];
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

  // ===[FORMAT VALUE]===
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? "–" : (+v).toFixed(p);

  // ===[CHART INITIALIZER]===
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

  // ===[MAP INITIALIZER]===
  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map("map").setView([0, 0], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png").addTo(map);
    marker = L.marker([0, 0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  // ===[CHART UPDATER]===
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

  // ===[DRAW LIVE DATA]===
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

  // ===[PERIODIC POLLING AND UPDATE]===
  async function poll(DEVICE, SENSORS) {
    const [gpsArr, iccArr] = await Promise.all([
      fetchUbidotsVar(DEVICE, "gps"),
      fetchUbidotsVar(DEVICE, "iccid")
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
    setTimeout(() => poll(DEVICE, SENSORS), POLL_MS);
  }

  // ===[POPULATE THE DROPDOWN AND SETUP DASHBOARD]===
  document.addEventListener("DOMContentLoaded", async () => {
    // Basic HTML for dashboard (you can keep your own layout)
    document.body.innerHTML = `
      <div class="container bg-white shadow-lg rounded-2xl p-7 mt-8">
        <div class="flex flex-row justify-between items-center mb-6">
          <span class="header">SkyCafé Sensor Dashboard</span>
          <select id="deviceSelect"></select>
        </div>
        <div class="flex flex-col md:flex-row gap-8">
          <div class="flex-1">
            <table id="latest" class="mb-4 w-full"></table>
            <div id="charts"></div>
          </div>
          <div class="flex-1 md:max-w-sm">
            <div id="map"></div>
          </div>
        </div>
        <div class="mt-4 text-xs text-gray-500">Questions? <a href="mailto:support@sky-cafe.com" class="underline">support@sky-cafe.com</a></div>
      </div>
    `;

    // --- LIVENESS CHECK: Fill dropdown with online/offline
    const deviceSelect = document.getElementById("deviceSelect");
    deviceSelect.innerHTML = "";
    let deviceStatus = {};
    for (const dev of DEVICES) {
      deviceStatus[dev] = await checkLiveness(dev) ? "online" : "offline";
    }
    DEVICES.forEach(dev => {
      const opt = document.createElement("option");
      opt.value = dev;
      opt.text = dev.replace("skycafe-", "SkyCafé ");
      if (deviceStatus[dev] === "offline") {
        opt.disabled = true;
        opt.text += " (Offline)";
      }
      deviceSelect.appendChild(opt);
    });

    // --- Select first online truck by default
    let DEVICE = DEVICES.find(d => deviceStatus[d] === "online") || DEVICES[0];
    deviceSelect.value = DEVICE;

    // --- Setup map and polling
    let SENSOR_MAP = await fetchSensorMapConfig();
    let DALLAS_LIST = await fetchDallasAddresses(DEVICE);
    let SENSORS = buildSensorSlots(DEVICE, DALLAS_LIST, SENSOR_MAP);
    initCharts(SENSORS);
    updateCharts(DEVICE, SENSORS).then(() => { initMap(); poll(DEVICE, SENSORS); });

    deviceSelect.addEventListener("change", async e => {
      DEVICE = e.target.value;
      document.getElementById("latest").innerHTML = "";
      trail = [];
      if (polyline) polyline.setLatLngs([]);
      DALLAS_LIST = await fetchDallasAddresses(DEVICE);
      SENSORS = buildSensorSlots(DEVICE, DALLAS_LIST, SENSOR_MAP);
      initCharts(SENSORS);
      updateCharts(DEVICE, SENSORS).then(() => { initMap(); poll(DEVICE, SENSORS); });
    });
  });
})();
