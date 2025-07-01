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
    return (
      getComputedStyle(document.documentElement)
        .getPropertyValue(varName) || ''
    ).trim() || fallback;
  }

  const spinner = document.getElementById('spinner');
  function showSpinner() { spinner.style.display = 'block'; }
  function hideSpinner() { spinner.style.display = 'none'; }

  // [1] CONFIG
  const DEVICE_TOKENS = {
    "skycafe-1": "BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8",
    "skycafe-2": "BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P"
  };
  const POLL_MS = 10000;
  const HIST    = 50;
  const TRAIL   = 50;

  // [1a] STATIC DEVICE LIST
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = "skycafe-2";

  // [2] SENSORS
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
    const token = DEVICE_TOKENS[device] || '';
    try {
      const res = await fetch(url, { headers: { 'X-Auth-Token': token } });
      if (!res.ok) return [];
      const json = await res.json();
      return json.results || [];
    } catch {
      return [];
    }
  }

  // [6] FORMAT HELPER
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
        data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
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

  // [9] UPDATE CHARTS
  async function updateCharts() {
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchUbidotsVar(DEVICE, s.id, HIST);
      if (!rows.length) return;
      s.chart.data.labels = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }));
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
      ['Lat', fmt(lat, 6)], ['Lon', fmt(lon, 6)],
      ['Speed (km/h)', fmt(speed, 1)], ['RSSI (dBm)', fmt(signal, 0)],
      ['Volt (mV)', fmt(volt, 2)], ['NR1 °F', fmt(nr1, 1)], ['NR2 °F', fmt(nr2, 1)], ['NR3 °F', fmt(nr3, 1)]
    ];
    document.getElementById('latest').innerHTML = rows.map(r => `<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat) && isFinite(lon)) {
      marker.setLatLng([lat, lon]);
      trail.push([lat, lon]); if (trail.length > TRAIL) trail.shift();
      polyline.setLatLngs(trail);
      map.setView([lat, lon], Math.max(map.getZoom(), 13));
    }
  }

  // [11] POLL LOOP
  async function poll() {
    const [gpsArr, iccArr, ...sensorArrs] = await Promise.all([
      fetchUbidotsVar(DEVICE, 'gps'),
      fetchUbidotsVar(DEVICE, 'iccid'),
      ...SENSORS.map(s => fetchUbidotsVar(DEVICE, s.id))
    ]);
    let ts=null, lat=null, lon=null, speed=null;
    if (gpsArr[0]?.context) {
      ts    = gpsArr[0].created_at;
      lat   = gpsArr[0].context.lat;
      lon   = gpsArr[0].context.lng;
      speed = gpsArr[0].context.speed;
    }
    const iccid = iccArr[0]?.value || null;
    const [sigArr, voltArr, , nr1Arr, nr2Arr, nr3Arr] = sensorArrs;
    drawLive({
      ts, iccid, lat, lon, speed,
      signal: sigArr[0]?.value || null,
      volt:   voltArr[0]?.value || null,
      nr1:    nr1Arr[0]?.value || null,
      nr2:    nr2Arr[0]?.value || null,
      nr3:    nr3Arr[0]?.value || null
    });
    setTimeout(poll, POLL_MS);
  }

  // [12] CSV EXPORT
  document.getElementById('dlBtn').addEventListener('click', async ev => {
    ev.preventDefault();
    const statusEl = document.getElementById('expStatus'); statusEl.innerText = '';
    const start = document.getElementById('start').value;
    const end   = document.getElementById('end').value;
    if (!start || !end) return statusEl.innerText = 'Please select both dates.';
    const startISO = new Date(start + 'T00:00:00').toISOString();
    const endISO   = new Date(end   + 'T23:59:59.999').toISOString();
    statusEl.innerText = `Fetching data from ${startISO} to ${endISO}…`;
    try {
      const [gpsList, iccidList, ...lists] = await Promise.all([
        fetchUbidotsVar(DEVICE,'gps',1000,startISO,endISO),
        fetchUbidotsVar(DEVICE,'iccid',1000,startISO,endISO),
        ...SENSORS.map(s=>fetchUbidotsVar(DEVICE,s.id,1000,startISO,endISO))
      ]);
      const counts = [`GPS:${gpsList.length}`,`ICCID:${iccidList.length}`,...lists.map((l,i)=>`${SENSORS[i].id}:${l.length}`)].join(', ');
      statusEl.innerText = `Fetched → ${counts}`;
      if (gpsList.length+iccidList.length+lists.reduce((a,b)=>a+b.length,0)===0)
        return statusEl.innerText += '
No data.';
      const dataMap={} ;
      gpsList.forEach(g=>{const ts=g.created_at,c=g.context||{};dataMap[ts]={...dataMap[ts],Lat:c.lat,Lon:c.lng,Alt:c.alt,Satellites:c.sats,Speed:c.speed};});
      iccidList.forEach(d=>{const ts=d.created_at;dataMap[ts]={...dataMap[ts],ICCID:d.value};});
      SENSORS.forEach((s,i)=>lists[i].forEach(d=>{const ts=d.created_at;dataMap[ts]={...dataMap[ts],[s.id]:d.value};}));
      const rows=[];
      rows.push(['Date','Time','Lat','Lon','Alt','Satellites','Speed','ICCID',...SENSORS.map(s=>s.id)]);
      Object.keys(dataMap).sort().forEach(ts=>{const dt=new Date(ts);rows.push([dt.toLocaleDateString(),dt.toLocaleTimeString(),dataMap[ts].Lat||'',dataMap[ts].Lon||'',dataMap[ts].Alt||'',dataMap[ts].Satellites||'',dataMap[ts].Speed||'',dataMap[ts].ICCID||'',...SENSORS.map(s=>dataMap[ts][s.id]||'')]);});
      const csv = 'sep=;
'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';')).join('
');
      const blob=new Blob([csv],{type:'text/csv'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${DEVICE}-${start}-${end}.csv`;document.body.appendChild(a);a.click();document.body.removeChild(a);
      statusEl.innerText+='
Download started.';
    } catch(e){console.error(e);statusEl.innerText=`Error: ${e.message}`;}
  });

  // [13] BOOTSTRAP, POLL, MAINTENANCE OMITTED FOR BREVITY
})();
