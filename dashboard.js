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
  const DEVICE_TOKENS = {
    "skycafe-1": "BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8",
    "skycafe-2": "BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P"
  };
  const POLL_MS = 10000;
  const HIST    = 50;
  const TRAIL   = 50;

  // [1a] STATIC DEVICE LIST (skycafe-1 … skycafe-24)
  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = "skycafe-2";

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
    const token = DEVICE_TOKENS[device] || '';
    try {
      const res = await fetch(url, { headers: { "X-Auth-Token": token } });
      if (!res.ok) return [];
      const json = await res.json();
      return json.results || [];
    } catch {
      return [];
    }
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
        type: 'line', data: { labels: [], datasets: [{ data: [], borderColor: s.col, borderWidth: 2, tension: 0.25 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
      });
    });
  }

  // [8] INIT MAP
  let map, marker, polyline, trail = [];
  function initMap() {
    map = L.map('map').setView([0,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
    marker = L.marker([0,0]).addTo(map);
    polyline = L.polyline([], { weight: 3 }).addTo(map);
  }

  // [9] UPDATE HISTORICAL DATA
  async function updateCharts() {
    await Promise.all(SENSORS.map(async s => {
      const rows = await fetchUbidotsVar(DEVICE, s.id, HIST);
      if (!rows.length) return;
      const labels = rows.map(r => new Date(r.created_at).toLocaleTimeString([], { hour:'numeric',minute:'2-digit',hour12:true }));
      const vals   = rows.map(r => parseFloat(r.value)||null);
      s.chart.data.labels = labels;
      s.chart.data.datasets[0].data = vals;
      s.chart.update();
    }));
  }

  // [10] DRAW LIVE & MAP
  function drawLive(data) {
    const { ts, iccid, lat, lon, speed, signal, volt, nr1, nr2, nr3 } = data;
    const rows = [
      ['Local Time', ts ? new Date(ts).toLocaleString() : '–'],['ICCID',iccid||'–'],
      ['Lat',fmt(lat,6)],['Lon',fmt(lon,6)],
      ['Speed (km/h)',fmt(speed,1)],['RSSI (dBm)',fmt(signal,0)],
      ['Volt (mV)',fmt(volt,2)],['NR1 °F',fmt(nr1,1)],['NR2 °F',fmt(nr2,1)],['NR3 °F',fmt(nr3,1)]
    ];
    document.getElementById('latest').innerHTML = rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if (isFinite(lat)&&isFinite(lon)){
      marker.setLatLng([lat,lon]); trail.push([lat,lon]); if(trail.length>TRAIL) trail.shift(); polyline.setLatLngs(trail);
      map.setView([lat,lon],Math.max(map.getZoom(),13));
    }
  }

  // [11] POLL LOOP
  async function poll(){
    const [gpsArr, iccArr, ...sensorArrs] = await Promise.all([
      fetchUbidotsVar(DEVICE,'gps'),fetchUbidotsVar(DEVICE,'iccid'),...SENSORS.map(s=>fetchUbidotsVar(DEVICE,s.id))
    ]);
    let ts=null,lat=null,lon=null,speed=null,alt=null,sats=null;
    if(gpsArr.length&&gpsArr[0].context){ const c=gpsArr[0].context; ts=gpsArr[0].created_at;lat=c.lat;lon=c.lng;speed=c.speed;alt=c.alt;sats=c.sats; }
    const iccid = (iccArr.length&&iccArr[0].value)?iccArr[0].value:null;
    const [sigArr,voltArr,spArr,nr1Arr,nr2Arr,nr3Arr] = sensorArrs;
    const signal = sigArr[0]?.value||null; const voltVal = voltArr[0]?.value||null;
    const n1 = nr1Arr[0]?.value||null, n2 = nr2Arr[0]?.value||null, n3 = nr3Arr[0]?.value||null;
    drawLive({ts,iccid,lat,lon,speed,signal,volt:voltVal,nr1:n1,nr2:n2,nr3:n3});
    setTimeout(poll,POLL_MS);
  }

  // [12] CSV EXPORT + Maintenance Logic
  document.getElementById('dlBtn').addEventListener('click', async ev => {
    ev.preventDefault();
    const statusEl = document.getElementById('expStatus'); statusEl.innerText='';
    const startIn = document.getElementById('start').value; const endIn = document.getElementById('end').value;
    if(!startIn||!endIn) return statusEl.innerText='Select start and end dates.';
    const startMs=new Date(startIn+'T00:00:00').getTime(), endMs=new Date(endIn+'T23:59:59.999').getTime();
    statusEl.innerText=`Fetching ${DEVICE} from ${startMs} to ${endMs}…`;
    try{
      const [gpsList,iccList,...senLists]=await Promise.all([
        fetchUbidotsVar(DEVICE,'gps',1000,startMs,endMs),
        fetchUbidotsVar(DEVICE,'iccid',1000,startMs,endMs),
        ...SENSORS.map(s=>fetchUbidotsVar(DEVICE,s.id,1000,startMs,endMs))
      ]);
      const counts=[`GPS:${gpsList.length}`,`ICCID:${iccList.length}`,...senLists.map((l,i)=>`${SENSORS[i].id}:${l.length}`)].join(',');
      statusEl.innerText=`Fetched → ${counts}`;
      if(gpsList.length===0&&iccList.length===0&&senLists.every(l=>l.length===0)) return statusEl.innerText+='\nNo data.';
      const dataMap={};
      gpsList.forEach(g=>{const ts=g.created_at,c=g.context||{};dataMap[ts]=Object.assign(dataMap[ts]||{},{Lat:c.lat||'',Lon:c.lng||'',Alt:c.alt||'',Satellites:c.sats||'',Speed:c.speed||''});});
      iccList.forEach(d=>{const ts=d.created_at;dataMap[ts]=dataMap[ts]||{};dataMap[ts].ICCID=d.value||'';});
      SENSORS.forEach((s,idx)=>senLists[idx].forEach(d=>{const ts=d.created_at;dataMap[ts]=dataMap[ts]||{};dataMap[ts][s.id]=d.value||'';}));
      const fields=['Date','Time','Lat','Lon','Alt','Satellites','Speed','ICCID',...SENSORS.map(s=>s.id)];
      const rows=[fields];Object.keys(dataMap).sort().forEach(ts=>{const dt=new Date(+ts);rows.push([dt.toLocaleDateString(),dt.toLocaleTimeString(),dataMap[ts].Lat||'',dataMap[ts].Lon||'',dataMap[ts].Alt||'',dataMap[ts].Satellites||'',dataMap[ts].Speed||'',dataMap[ts].ICCID||'',...SENSORS.map(s=>dataMap[ts][s.id]||'')]);});
      const sep='sep=;\n'; const body=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';')).join('\n');
      const blob=new Blob([sep+body],{type:'text/csv;charset=utf-8;'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${DEVICE}-${startIn}-${endIn}.csv`;document.body.appendChild(a);a.click();document.body.removeChild(a);
      statusEl.innerText+='\nDownload started.';
    }catch(e){console.error(e);statusEl.innerText=`Error: ${e.message}`;}    

    // Maintenance logic
    const FILTER=182, SERVICE=384, CODE='8971';
    if(!localStorage.getItem('filterDate')) localStorage.setItem('filterDate',new Date().toISOString());
    if(!localStorage.getItem('serviceDate')) localStorage.setItem('serviceDate',new Date().toISOString());
    function daysSince(i){return Math.floor((Date.now()-new Date(i))/(1000*60*60*24));}
    function render(){
      const fDate=localStorage.getItem('filterDate'), sDate=localStorage.getItem('serviceDate');
      const fd=daysSince(fDate), sd=daysSince(sDate);
      const fEl=document.getElementById('filterStatus'), sEl=document.getElementById('serviceStatus');
      if(fd<FILTER){const d=new Date(fDate);d.setDate(d.getDate()+FILTER);fEl.textContent=`Filter OK until ${d.toISOString().slice(0,10)}`;} else fEl.textContent='Filter needs changing';
      if(sd<SERVICE) sEl.textContent=''; else sEl.textContent='Service due';
    }
    document.getElementById('resetFilterBtn').addEventListener('click',()=>{localStorage.setItem('filterDate',new Date().toISOString());render();});
    document.getElementById('resetServiceBtn').addEventListener('click',()=>{ const e=prompt('Enter code:'); if(e===CODE){localStorage.setItem('serviceDate',new Date().toISOString());render();}else alert('Incorrect code.'); });
    render();
  });
})();
