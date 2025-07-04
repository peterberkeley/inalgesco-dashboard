(() => {
  // [0] THEME COLORS & SPINNER
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

  // [1] CONFIGURATION
  const DEVICE_TOKENS = {
    'skycafe-1': 'BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8',
    'skycafe-2': 'BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P'
  };
  const POLL_MS = 10000, HIST = 50, TRAIL = 50;

  // [1a] DEVICE LIST
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = 'skycafe-2';

  // [2] SENSORS
  const SENSORS = [
    { id: 'nr1', label: 'NR1 °F', col: COLORS.primary, chart: null },
    { id: 'nr2', label: 'NR2 °F', col: COLORS.secondary, chart: null },
    { id: 'nr3', label: 'NR3 °F', col: COLORS.accent, chart: null },
    { id: 'signal', label: 'RSSI (dBm)', col: COLORS.text, chart: null },
    { id: 'volt', label: 'Volt (mV)', col: '#FF0000', chart: null },
    { id: 'speed', label: 'Speed (km/h)', col: COLORS.secondary, chart: null }
  ];

  // [5] FETCH FROM UBIDOTS
  async function fetchUbidotsVar(dev, variable, limit = 1, start = null, end = null) {
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/${variable}/values?page_size=${limit}`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end)   url += `&end=${encodeURIComponent(end)}`;
    const token = DEVICE_TOKENS[dev] || '';
    try {
      const res = await fetch(url, { headers: { 'X-Auth-Token': token } });
      if (!res.ok) return [];
      const js = await res.json();
      return js.results || [];
    } catch {
      return [];
    }
  }

  // [6] FORMAT HELPER
  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);

  // [7] INITIALIZE CHARTS
  function initCharts() {
    const ctr = document.getElementById('charts');
    ctr.innerHTML = '';
    SENSORS.forEach(s => {
      s.chart = null;
      const card = document.createElement('div'); card.className = 'chart-box';
      card.innerHTML = `<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx = card.querySelector('canvas').getContext('2d');
      s.chart = new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
    });
  }

  // [8] INITIALIZE MAP
  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map('map').setView([0,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
    marker = L.marker([0,0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  // [9] UPDATE HISTORICAL CHARTS
  async function updateCharts() {
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchUbidotsVar(DEVICE, s.id, HIST);
      if (!rows.length) return;
      s.chart.data.labels    = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }));
      s.chart.data.datasets[0].data = rows.map(r => parseFloat(r.value) || null);
      s.chart.update();
    }));
  }

  // [10] DRAW LIVE & MAP
  function drawLive(data) {
    const { ts, iccid, lat, lon, speed, signal, volt, nr1, nr2, nr3 } = data;
    const rows = [
      ['Local Time', ts ? new Date(ts).toLocaleString() : '–'],
      ['ICCID', iccid || '–'],
      ['Lat', fmt(lat,6)], ['Lon', fmt(lon,6)],
      ['Speed (km/h)', fmt(speed,1)], ['RSSI (dBm)', fmt(signal,0)],
      ['Volt (mV)', fmt(volt,2)], ['NR1 °F', fmt(nr1,1)], ['NR2 °F', fmt(nr2,1)], ['NR3 °F', fmt(nr3,1)]
    ];
    document.getElementById('latest').innerHTML = rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat) && isFinite(lon)) {
      marker.setLatLng([lat,lon]);
      trail.push([lat,lon]); if (trail.length > TRAIL) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat,lon], Math.max(map.getZoom(),13));
    }
  }

  // [11] POLL LOOP
  async function poll() {
    const [gpsArr, iccArr, ...sensorArrs] = await Promise.all([
      fetchUbidotsVar(DEVICE,'gps'),
      fetchUbidotsVar(DEVICE,'iccid'),
      ...SENSORS.map(s => fetchUbidotsVar(DEVICE,s.id))
    ]);
    let ts=null, lat=null, lon=null, speed=null;
    if (gpsArr[0]?.context) {
      ts    = gpsArr[0].created_at;
      lat   = gpsArr[0].context.lat;
      lon   = gpsArr[0].context.lng;
      speed = gpsArr[0].context.speed;
    }
    const iccidVal = iccArr[0]?.value || null;
    const signalVal = sensorArrs[0][0]?.value || null;
    const voltVal   = sensorArrs[1][0]?.value || null;
    const nr1Val    = sensorArrs[2][0]?.value || null;
    const nr2Val    = sensorArrs[3][0]?.value || null;
    const nr3Val    = sensorArrs[4][0]?.value || null;
    drawLive({ ts, iccid: iccidVal, lat, lon, speed, signal: signalVal, volt: voltVal, nr1: nr1Val, nr2: nr2Val, nr3: nr3Val });
    setTimeout(poll, POLL_MS);
  }

  // [12] BOOTSTRAP & INIT
  document.addEventListener('DOMContentLoaded', () => {
    const deviceSelect = document.getElementById('deviceSelect');
    DEVICES.forEach(dev => {
      const opt = document.createElement('option'); opt.value=dev; opt.text=dev.replace('skycafe-','SkyCafé ');
      deviceSelect.appendChild(opt);
    });
    deviceSelect.value = DEVICE;
    deviceSelect.addEventListener('change', e => {
      DEVICE = e.target.value;
      showSpinner();
      document.getElementById('latest').innerHTML = '';
      trail=[]; polyline.setLatLngs([]);
      initCharts(); updateCharts().then(() => { initMap(); hideSpinner(); poll(); });
    });
    showSpinner(); initCharts(); updateCharts().then(() => { initMap(); hideSpinner(); poll(); });
  });
})();
