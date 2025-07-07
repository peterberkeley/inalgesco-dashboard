(() => {
  // [0] THEME COLORS
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

  // [1] CONFIGURATION
  const DEVICE_TOKENS = {
    'skycafe-1': 'BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8',
    'skycafe-2': 'BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P',
    'skycafe-3': '', // Missing
    'skycafe-4': 'BBUS-02xhIPOIpmMrGv5OwS2XX5La6Nn7ma',
    'skycafe-5': '', // Missing
    'skycafe-6': '', // Missing
    'skycafe-7': '', // Missing
  

    'skycafe-9': 'BBUS-hUwkXc9JKvaNq5cl8H3sMRPR0AZvj2',
    // Add more tokens here as you get them...
  };

  const POLL_MS = 10000, HIST = 50, TRAIL = 50;
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = 'skycafe-1';

  const SENSORS = [
    { id: 'nr1', label: 'NR1 °F', col: COLORS.primary, chart: null },
    { id: 'nr2', label: 'NR2 °F', col: COLORS.secondary, chart: null },
    { id: 'nr3', label: 'NR3 °F', col: COLORS.accent, chart: null },
    { id: 'signal', label: 'RSSI (dBm)', col: COLORS.text, chart: null },
    { id: 'volt', label: 'Volt (mV)', col: '#FF0000', chart: null },
    { id: 'speed', label: 'Speed (km/h)', col: COLORS.secondary, chart: null }
  ];

  async function fetchUbidotsVar(dev, variable, limit = 1, start = null, end = null) {
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${dev}/${variable}/values?page_size=${limit}`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end)   url += `&end=${encodeURIComponent(end)}`;
    const token = DEVICE_TOKENS[dev] || '';
    if (!token) return [];
    try {
      const res = await fetch(url, { headers: { 'X-Auth-Token': token } });
      if (!res.ok) return [];
      const js = await res.json();
      return js.results || [];
    } catch {
      return [];
    }
  }

  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);

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

  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map('map').setView([0,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
    marker = L.marker([0,0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  async function updateCharts() {
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchUbidotsVar(DEVICE, s.id, HIST);
      if (!rows.length) return;
      s.chart.data.labels    = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour:'numeric', minute:'2-digit', hour12:true }));
      s.chart.data.datasets[0].data = rows.map(r => parseFloat(r.value) || null);
      s.chart.update();
    }));
  }

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

  async function poll() {
    if (!DEVICE_TOKENS[DEVICE]) {
      document.getElementById('latest').innerHTML = '<tr><td colspan="2" style="color:red;">No token for this device. Data unavailable.</td></tr>';
      setTimeout(poll, POLL_MS);
      return;
    }
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

  // === Maintenance Countdown Logic ===
  function updateMaintenanceStatus() {
    const filterDays = 30;
    const serviceDays = 180;
    const now = new Date();

    const filterKey = `${DEVICE}-filter`;
    const serviceKey = `${DEVICE}-service`;

    let lastFilter = localStorage.getItem(filterKey);
    let lastService = localStorage.getItem(serviceKey);

    lastFilter = lastFilter ? new Date(lastFilter) : new Date(now.getTime() - 365 * 86400000);
    lastService = lastService ? new Date(lastService) : new Date(now.getTime() - 365 * 86400000);

    const filterUsed = Math.floor((now - lastFilter) / 86400000);
    const serviceUsed = Math.floor((now - lastService) / 86400000);
    const filterLeft = filterDays - filterUsed;
    const serviceLeft = serviceDays - serviceUsed;

    const filterStatus = document.getElementById('filterStatus');
    const serviceStatus = document.getElementById('serviceStatus');
    const resetFilterBtn = document.getElementById('resetFilterBtn');
    const resetServiceBtn = document.getElementById('resetServiceBtn');

    if (filterStatus) {
      if (filterLeft < 0) {
        filterStatus.innerHTML = `<span style="color:red;font-weight:bold;">Filter change overdue by ${-filterLeft} day(s)!</span>`;
        resetFilterBtn.style.display = '';
      } else {
        filterStatus.innerHTML = `Filter: <b>${filterLeft} day(s) left</b> until next change.`;
        resetFilterBtn.style.display = filterLeft <= 3 ? '' : 'none';
      }
    }
    if (serviceStatus) {
      if (serviceLeft < 0) {
        serviceStatus.innerHTML = `<span style="color:red;font-weight:bold;">Service overdue by ${-serviceLeft} day(s)!</span>`;
        resetServiceBtn.style.display = '';
      } else {
        serviceStatus.innerHTML = `Service: <b>${serviceLeft} day(s) left</b> until next service.`;
        resetServiceBtn.style.display = serviceLeft <= 7 ? '' : 'none';
      }
    }
  }

  // --- Robust Handlers (always re-attached) ---
  function setupMaintenanceHandlers() {
    const resetFilterBtn = document.getElementById('resetFilterBtn');
    const resetServiceBtn = document.getElementById('resetServiceBtn');

    if (resetFilterBtn) {
      resetFilterBtn.onclick = () => {
        if (confirm("Mark filter change as done today?")) {
          localStorage.setItem(`${DEVICE}-filter`, new Date().toISOString());
          updateMaintenanceStatus();
          setupMaintenanceHandlers();
        }
      };
    }
    if (resetServiceBtn) {
      resetServiceBtn.onclick = () => {
        const code = prompt("Enter service reset code:");
        if (code === null) return;
        if (code.trim() === "8971") {
          localStorage.setItem(`${DEVICE}-service`, new Date().toISOString());
          updateMaintenanceStatus();
          setupMaintenanceHandlers();
          alert("Service reset successful.");
        } else {
          alert("Incorrect code. Service was not reset.");
        }
      };
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Device selector setup
    const deviceSelect = document.getElementById('deviceSelect');
    deviceSelect.innerHTML = '';
    DEVICES.forEach(dev => {
      const opt = document.createElement('option');
      opt.value = dev;
      opt.text = dev.replace('skycafe-','SkyCafé ');
      if (!DEVICE_TOKENS[dev]) {
        opt.disabled = true;
        opt.text += ' (No Token)';
      }
      deviceSelect.appendChild(opt);
    });
    const firstAvailable = DEVICES.find(d => DEVICE_TOKENS[d]);
    DEVICE = firstAvailable || DEVICES[0];
    deviceSelect.value = DEVICE;
    deviceSelect.addEventListener('change', e => {
      DEVICE = e.target.value;
      document.getElementById('latest').innerHTML = '';
      trail=[]; polyline.setLatLngs([]);
      initCharts(); updateCharts().then(() => { initMap(); poll(); });
      updateMaintenanceStatus();
      setupMaintenanceHandlers();
    });
    initCharts(); updateCharts().then(() => { initMap(); poll(); });

    // CSV EXPORT BUTTON handler (robust, safe)
    const dlBtn = document.getElementById('dlBtn');
    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        dlBtn.disabled = true;
        dlBtn.textContent = "Downloading...";

        let startRaw = document.getElementById('start')?.value;
        let endRaw = document.getElementById('end')?.value;
        let start = null, end = null;
        if (startRaw) {
          start = new Date(startRaw + 'T00:00:00Z').getTime();
        }
        if (endRaw) {
          end = new Date(endRaw + 'T23:59:59.999Z').getTime();
        }

        const rowsBySensor = await Promise.all(
          SENSORS.map(s => fetchUbidotsVar(DEVICE, s.id, HIST, start, end))
        );
        const maxLen = Math.max(...rowsBySensor.map(r => r.length));
        if (maxLen === 0) {
          alert("No data available to export for this device.");
          dlBtn.disabled = false;
          dlBtn.textContent = "Download";
          return;
        }
        let header = ['Time'].concat(SENSORS.map(s => s.label));
        let csv = [header.join(',')];

        for (let i = 0; i < maxLen; i++) {
          let t = rowsBySensor[0][i]?.created_at || '';
          let row = [t ? new Date(t).toLocaleString() : ''];
          for (let s = 0; s < SENSORS.length; s++) {
            row.push(rowsBySensor[s][i]?.value ?? '');
          }
          csv.push(row.join(','));
        }

        const blob = new Blob([csv.join('\r\n')], {type: 'text/csv'});
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `${DEVICE}_data_${(new Date).toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        dlBtn.disabled = false;
        dlBtn.textContent = "Download";
      });
    }

    // Maintenance logic setup
    updateMaintenanceStatus();
    setupMaintenanceHandlers();
    setInterval(() => {
      updateMaintenanceStatus();
      setupMaintenanceHandlers();
    }, 60 * 60 * 1000);
  });
})();
