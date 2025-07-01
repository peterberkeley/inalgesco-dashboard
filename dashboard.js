(() => {
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

  const DEVICE_TOKENS = {
    "skycafe-1": "BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8",
    "skycafe-2": "BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P"
  };
  const POLL_MS = 10000;
  const HIST = 50;
  const TRAIL = 50;

  const DEVICES = Array.from({ length: 24 }, (_, i) => `skycafe-${i+1}`);
  let DEVICE = "skycafe-2";

  const SENSORS = [
    { id: 'nr1', label: 'NR1 °F', col: COLORS.primary, chart: null },
    { id: 'nr2', label: 'NR2 °F', col: COLORS.secondary, chart: null },
    { id: 'nr3', label: 'NR3 °F', col: COLORS.accent, chart: null },
    { id: 'signal', label: 'RSSI (dBm)', col: COLORS.text, chart: null },
    { id: 'volt', label: 'Volt (mV)', col: '#FF0000', chart: null },
    { id: 'speed', label: 'Speed (km/h)', col: COLORS.secondary, chart: null }
  ];

  async function fetchUbidotsVar(device, variable, limit = 1, start = null, end = null) {
    let url = `https://industrial.api.ubidots.com/api/v1.6/devices/${device}/${variable}/values?page_size=${limit}`;
    if (start) url += `&start=${encodeURIComponent(start)}`;
    if (end) url += `&end=${encodeURIComponent(end)}`;
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

  const fmt = (v, p = 1) => (v == null || isNaN(v)) ? '–' : (+v).toFixed(p);

  function initCharts() {
    const ctr = document.getElementById('charts'); ctr.innerHTML='';
    SENSORS.forEach(s => {
      s.chart=null;
      const card=document.createElement('div'); card.className='chart-box';
      card.innerHTML=`<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx=card.querySelector('canvas').getContext('2d');
      s.chart=new Chart(ctx,{ type:'line', data:{ labels:[], datasets:[{ data:[], borderColor:s.col, borderWidth:2, tension:0.25 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false }}} });
    });
  }

  let map, marker, polyline, trail=[];
  function initMap() {
    map=L.map('map').setView([0,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png').addTo(map);
    marker=L.marker([0,0]).addTo(map);
    polyline=L.polyline([], { weight:3 }).addTo(map);
  }

  async function updateCharts() {
    await Promise.all(SENSORS.map(async s=>{
      const rows=await fetchUbidotsVar(DEVICE,s.id,HIST);
      if(!rows.length) return;
      s.chart.data.labels=rows.map(r=>new Date(r.created_at).toLocaleTimeString([], { hour:'numeric',minute:'2-digit',hour12:true }));
      s.chart.data.datasets[0].data=rows.map(r=>parseFloat(r.value)||null);
      s.chart.update();
    }));
  }

  function drawLive({ ts, iccid, lat, lon, speed, signal, volt, nr1, nr2, nr3 }) {
    const rows=[
      ['Local Time', ts?new Date(ts).toLocaleString():'–'],
      ['ICCID',iccid||'–'],
      ['Lat',fmt(lat,6)],['Lon',fmt(lon,6)],
      ['Speed (km/h)',fmt(speed,1)],['RSSI (dBm)',fmt(signal,0)],
      ['Volt (mV)',fmt(volt,2)],['NR1 °F',fmt(nr1,1)],['NR2 °F',fmt(nr2,1)],['NR3 °F',fmt(nr3,1)]
    ];
    document.getElementById('latest').innerHTML=rows.map(r=>`<tr><th>${r[0]}</th><td>${r[1]}</td></tr>`).join('');
    if(isFinite(lat)&&isFinite(lon)){
      marker.setLatLng([lat,lon]); trail.push([lat,lon]); if(trail.length>TRAIL) trail.shift();
      polyline.setLatLngs(trail); map.setView([lat,lon],Math.max(map.getZoom(),13));
    }
  }

  async function poll(){
    const[gpsArr,iccArr,...sensorArrs]=await Promise.all([
      fetchUbidotsVar(DEVICE,'gps'), fetchUbidotsVar(DEVICE,'iccid'), ...SENSORS.map(s=>fetchUbidotsVar(DEVICE,s.id))
    ]);
    const ts=gpsArr[0]?.created_at, c=gpsArr[0]?.context||{};
    drawLive({
      ts, iccid:iccArr[0]?.value||null,
      lat:c.lat, lon:c.lng, speed:c.speed,
      signal:sensorArrs[0]?.[0]?.value||null,
      volt:  sensorArrs[1]?.[0]?.value||null,
      nr1:   sensorArrs[2]?.[0]?.value||null,
      nr2:   sensorArrs[3]?.[0]?.value||null,
      nr3:   sensorArrs[4]?.[0]?.value||null
    });
    setTimeout(poll,POLL_MS);
  }

  // CSV Export (ISO)
  document.getElementById('dlBtn').addEventListener('click', async ev=>{
    ev.preventDefault(); const st=document.getElementById('start').value, en=document.getElementById('end').value;
    const status=document.getElementById('expStatus'); status.innerText='';
    if(!st||!en) return status.innerText='Please select both dates.';
    const startISO=new Date(st+'T00:00:00').toISOString(), endISO=new Date(en+'T23:59:59.999').toISOString();
    status.innerText=`Fetching from ${startISO} to ${endISO}…`;
    try{
      const[gpsList,iccList,...lists]=await Promise.all([
        fetchUbidotsVar(DEVICE,'gps',1000,startISO,endISO),
        fetchUbidotsVar(DEVICE,'iccid',1000,startISO,endISO),
        ...SENSORS.map(s=>fetchUbidotsVar(DEVICE,s.id,1000,startISO,endISO))
      ]);
      const total=gpsList.length+iccList.length+lists.reduce((a,b)=>a+b.length,0);
      status.innerText=`Fetched ${total} records.`;
      if(total===0) return status.innerText+=' No data.';
      const mapData={};
      gpsList.forEach(g=>{mapData[g.created_at]={...mapData[g.created_at],Lat:g.context.lat,Lon:g.context.lng,Alt:g.context.alt,Satellites:g.context.sats,Speed:g.context.speed};});
      iccList.forEach(d=>{mapData[d.created_at]={...mapData[d.created_at],ICCID:d.value};});
      SENSORS.forEach((s,i)=>lists[i].forEach(d=>{mapData[d.created_at]={...mapData[d.created_at],[s.id]:d.value};}));
      const rows=[[ 'Date','Time','Lat','Lon','Alt','Satellites','Speed','ICCID',...SENSORS.map(s=>s.id) ]];
      Object.keys(mapData).sort().forEach(ts=>{const dt=new Date(ts);
        rows.push([dt.toLocaleDateString(),dt.toLocaleTimeString(),mapData[ts].Lat||'',mapData[ts].Lon||'',mapData[ts].Alt||'',mapData[ts].Satellites||'',mapData[ts].Speed||'',mapData[ts].ICCID||'',...SENSORS.map(s=>mapData[ts][s.id]||'')]);
      });
      const csv='sep=;
'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(';')).join('
');
      const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`${DEVICE}-${st}-${en}.csv`;
      document.body.appendChild(a);a.click();document.body.removeChild(a);
      status.innerText+=' Download started.';
    }catch(e){console.error(e); status.innerText=`Error: ${e.message}`;}
  });

  document.addEventListener('DOMContentLoaded',()=>{
    const sel=document.getElementById('deviceSelect'); DEVICES.forEach(d=>{const o=document.createElement('option');o.value=o.text=d.replace('skycafe-','SkyCafé ');sel.appendChild(o);});
    sel.value=DEVICE; sel.addEventListener('change',e=>{DEVICE=e.target.value;initCharts();updateCharts().then(()=>{poll();});});
    initCharts();updateCharts().then(()=>{initMap();poll();});
  });
})();
