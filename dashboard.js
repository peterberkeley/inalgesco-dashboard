(() => {
  // [0] THEME COLORS & SPINNER UTILITIES
  const COLORS = {
    primary: getCSS('--color-primary'),
    secondary: getCSS('--color-secondary'),
    accent: getCSS('--color-accent'),
    text: getCSS('--color-text'),
    card: getCSS('--color-card')
  };

  function getCSS(varName, fallback = '') {
    return (getComputedStyle(document.documentElement).getPropertyValue(varName) || '').trim() || fallback;
  }

  const spinner = document.getElementById('spinner');
  function showSpinner() { spinner.style.display = 'block'; }
  function hideSpinner() { spinner.style.display = 'none'; }

  // [1] CONFIG
  const UBIDOTS_TOKEN = "BBUS-6Lyp5vsdbVgar8xvI2VW13hBE6TqOK";
  const POLL_MS = 10000;
  const HIST    = 50;
  const TRAIL   = 50;

  // [1a] STATIC DEVICE LIST (skycafe-1 … skycafe-24)
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = "skycafe-2"; // Default, but user can select any.

  // [2] SENSORS & ICCID
  const SENSORS = [
    { id: 'nr1',    label: 'NR1 °F',       col: COLORS.primary,   chart: null },
    { id: 'nr2',    label: 'NR2 °F',       col: COLORS.secondary, chart: null },
    { id: 'nr3',    label: 'NR3 °F',       col: COLORS.accent,    chart: null },
    { id: 'signal', label: 'RSSI (dBm)',   col: COLORS.text,      chart: null },
    { id: 'volt',   label: 'Volt (mV)',    col: '#FF0000',        chart: null },
    { id: 'speed',  label: 'Speed (km/h)', col: COLORS.secondary, chart: null }
  ];

  // [5] FETCH UTILITY — Ubidots REST
  async function fetchUbidotsVar(device, variable, limit = 1, start = null, end = null) {
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${device}/${variable}/values?page_size=${limit}`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end)   url += `&end=${encodeURIComponent(end)}`;
    const res = await fetch(url, {
      headers: { "X-Auth-Token": UBIDOTS_TOKEN }
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json.results || [];
  }

  // [6] FORMAT HELPERS
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);

  // [7] INIT CHARTS
  function initCharts() {
    const ctr = document.getElementById('charts');
    ctr.innerHTML = '';
    SENSORS.forEach(s => {
      s.chart = null;
      const card = document.createElement('div');
      card.className = 'chart-box';
      card.innerHTML = `<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx = card.querySelector('canvas').getContext('2d');
      s.chart = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            data: [],
            borderColor: s.col,
            borderWidth: 2,
            tension: 0.25
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } }
        }
      });
    });
  }

  // [8] INIT MAP
  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map('map').setView([0, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
    marker = L.marker([0, 0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  // [9] UPDATE HISTORICAL DATA
  async function updateCharts() {
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchUbidotsVar(DEVICE, s.id, HIST);
      if (!rows.length) return;
      const labels = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }));
      const values = rows.map(r => parseFloat(r.value) || null);
      s.chart.data.labels = labels;
      s.chart.data.datasets[0].data = values;
      s.chart.update();
    }));
  }

  // [10] DRAW LIVE TABLE & MAP
  function drawLive(data) {
    const { ts, iccid, lat, lon, speed, signal, volt, nr1, nr2, nr3 } = data;
    const rows = [
      ['Local Time', ts ? new Date(ts).toLocaleString() : '–'],
      ['ICCID', iccid ?? '–'],
      ['Lat', fmt(lat, 6)], ['Lon', fmt(lon, 6)],
      ['Speed (km/h)', fmt(speed, 1)], ['RSSI (dBm)', fmt(signal, 0)],
      ['Volt (mV)', fmt(volt, 2)], ['NR1 °F', fmt(nr1, 1)],
      ['NR2 °F', fmt(nr2, 1)], ['NR3 °F', fmt(nr3, 1)]
    ];
    document.getElementById('latest').innerHTML =
      rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat) && isFinite(lon)) {
      marker.setLatLng([lat, lon]);
      trail.push([lat, lon]);
      if (trail.length > TRAIL) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat, lon], Math.max(map.getZoom(), 13));
    }
  }

  // [11] POLL LOOP — Fetch live values from Ubidots for all fields
  async function poll() {
    // Fetch latest value for each variable from Ubidots
    const [gpsArr, iccArr, ...sensorArrs] = await Promise.all([
      fetchUbidotsVar(DEVICE, 'gps'),
      fetchUbidotsVar(DEVICE, 'iccid'),
      ...SENSORS.map(s => fetchUbidotsVar(DEVICE, s.id))
    ]);

    // Parse GPS
    let ts = null, lat = null, lon = null, speed = null, alt = null, sats = null;
    if (gpsArr.length && gpsArr[0].context) {
      ts    = gpsArr[0].created_at ?? null;
      lat   = gpsArr[0].context.lat ?? null;
      lon   = gpsArr[0].context.lng ?? null;
      speed = gpsArr[0].context.speed ?? null;
      alt   = gpsArr[0].context.alt ?? null;
      sats  = gpsArr[0].context.sats ?? null;
    }

    // Parse ICCID
    let iccid = (iccArr.length && iccArr[0].value) ? iccArr[0].value : null;

    // Parse Sensors
    const [sigArr, voltArr, spArr, nr1Arr, nr2Arr, nr3Arr] = sensorArrs;
    let signal = (sigArr.length && sigArr[0].value) ? sigArr[0].value : null;
    let volt   = (voltArr.length && voltArr[0].value) ? voltArr[0].value : null;
    let nr1    = (nr1Arr.length && nr1Arr[0].value) ? nr1Arr[0].value : null;
    let nr2    = (nr2Arr.length && nr2Arr[0].value) ? nr2Arr[0].value : null;
    let nr3    = (nr3Arr.length && nr3Arr[0].value) ? nr3Arr[0].value : null;

    // Show in live table/map
    drawLive({ ts, iccid, lat, lon, speed, signal, volt, nr1, nr2, nr3 });

    // Schedule next poll
    setTimeout(poll, POLL_MS);
  }

  // [12] CSV EXPORT — with debug output!
  document.getElementById('dlBtn').addEventListener('click', async ev => {
    ev.preventDefault();

    let startInput = document.getElementById('start').value;
    let endInput   = document.getElementById('end').value;
    if (!startInput || !endInput) {
      return alert('Please set both a start and end date/time.');
    }

    const startISO = new Date(startInput).toISOString();
    const endISO   = new Date(endInput).toISOString();

    const csvFields = [
      "Date", "Time", "Lat", "Lon", "Alt", "Satellites", "Speed", "ICCID",
      ...SENSORS.map(s => s.id)
    ];

    // Fetch all variable histories
    const [gpsList, iccidList, ...sensorLists] = await Promise.all([
      fetchUbidotsVar(DEVICE, 'gps', 1000, startISO, endISO),
      fetchUbidotsVar(DEVICE, 'iccid', 1000, startISO, endISO),
      ...SENSORS.map(s => fetchUbidotsVar(DEVICE, s.id, 1000, startISO, endISO))
    ]);

    // DEBUG OUTPUT: Print what is being fetched!
    console.log('CSV EXPORT DEBUG');
    console.log('DEVICE:', DEVICE);
    console.log('Start:', startISO, 'End:', endISO);
    console.log('gpsList:', gpsList);
    console.log('iccidList:', iccidList);
    sensorLists.forEach((arr, idx) => {
      console.log(`sensor ${SENSORS[idx].id}:`, arr);
    });

    // Build a timestamp-indexed data map
    const dataMap = {};

    // Merge GPS context into map
    gpsList.forEach(g => {
      const ts = g.created_at;
      if (!dataMap[ts]) dataMap[ts] = {};
      dataMap[ts].Lat = g.context?.lat ?? "";
      dataMap[ts].Lon = g.context?.lng ?? "";
      dataMap[ts].Alt = g.context?.alt ?? "";
      dataMap[ts].Satellites = g.context?.sats ?? "";
      dataMap[ts].Speed = g.context?.speed ?? "";
    });

    // Merge ICCID
    iccidList.forEach(d => {
      const ts = d.created_at;
      if (!dataMap[ts]) dataMap[ts] = {};
      dataMap[ts].ICCID = d.value ?? "";
    });

    // Merge sensors
    SENSORS.forEach((s, idx) => {
      sensorLists[idx].forEach(d => {
        const ts = d.created_at;
        if (!dataMap[ts]) dataMap[ts] = {};
        dataMap[ts][s.id] = d.value ?? "";
      });
    });

    // Build rows
    const timestamps = Object.keys(dataMap).sort();
    console.log('All CSV timestamps:', timestamps);

    const rows = [csvFields];
    timestamps.forEach(ts => {
      const dt = new Date(ts);
      const date = dt.toLocaleDateString();
      const time = dt.toLocaleTimeString();
      const row = [
        date,
        time,
        dataMap[ts].Lat ?? "",
        dataMap[ts].Lon ?? "",
        dataMap[ts].Alt ?? "",
        dataMap[ts].Satellites ?? "",
        dataMap[ts].Speed ?? "",
        dataMap[ts].ICCID ?? "",
        ...SENSORS.map(s => dataMap[ts][s.id] ?? "")
      ];
      rows.push(row);
    });

    // CSV encode
    const sepLine = 'sep=;\n';
    const body = rows.map(row =>
      row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(';')
    ).join('\n');
    const csv = sepLine + body;

    // Trigger download
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href     = URL.createObjectURL(blob);
    link.download = `${DEVICE}-${startInput}-${endInput}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });

  // [13] BOOTSTRAP & DEVICE CHANGE
  document.addEventListener('DOMContentLoaded', () => {
    const deviceSelect = document.getElementById('deviceSelect');
    DEVICES.forEach(dev => {
      const opt = document.createElement('option');
      opt.value = dev;
      opt.text  = dev.replace('skycafe-','SkyCafé ');
      deviceSelect.appendChild(opt);
    });
    // Set the correct device if you have only one!
    deviceSelect.value = DEVICE;
    deviceSelect.addEventListener('change', e => {
      DEVICE = e.target.value;
      showSpinner();
      document.getElementById('latest').innerHTML = '';
      trail = [];
      if (polyline) polyline.setLatLngs([]);
      initCharts();
      updateCharts().then(() => { 
        hideSpinner();
        poll(); // Key: always poll live data for new device!
      });
    });
    showSpinner();
    initCharts();
    updateCharts().then(() => {
      initMap(); hideSpinner(); poll();
    });
  });
})();
