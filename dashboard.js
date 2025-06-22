// dashboard.js — Section 1 of 2

// ─── Configuration ────────────────────────────────────────────────
const USER    = 'Inalgescodatalogger';
let DEVICE    = 'skycafe-1';
// Poll every 30 seconds
const POLL_MS = 30_000;
// 60 points = 30 minutes @ 30 s
const HIST    = 60;
// Map trail unchanged
const TRAIL   = 50;

// ─── Chart Colors & Sensors ──────────────────────────────────────
const fallbackCols = ['#44b6f7','#7cd992','#e7c46c'];
const SENSORS = [
  { id:'nr1',    label:'NR1 °F',       col:getCSS('--g1',fallbackCols[0]), chart:null },
  { id:'nr2',    label:'NR2 °F',       col:getCSS('--g2',fallbackCols[1]), chart:null },
  { id:'nr3',    label:'NR3 °F',       col:getCSS('--g3',fallbackCols[2]), chart:null },
  { id:'signal', label:'RSSI (dBm)',   col:getCSS('--g4','#999'),           chart:null },
  { id:'volt',   label:'Volt (mV)',    col:getCSS('--g5','#666'),           chart:null },
  { id:'speed',  label:'Speed (km/h)', col:getCSS('--g6','#333'),           chart:null }
];

// ─── CSS Helper ──────────────────────────────────────────────────
function getCSS(varName, fallback='') {
  return (getComputedStyle(document.documentElement)
    .getPropertyValue(varName)||'').trim()||fallback;
}

// ─── Full Feed Keys ──────────────────────────────────────────────
function getFeeds(device) {
  return {
    gps:    `${device}.gps`,
    signal: `${device}.signal`,
    volt:   `${device}.volt`,
    speed:  `${device}.speed`,
    nr1:    `${device}.nr1`,
    nr2:    `${device}.nr2`,
    nr3:    `${device}.nr3`
  };
}

// ─── Fetch Utility ───────────────────────────────────────────────
async function fetchFeed(feedKey, limit=1, params={}) {
  const url = new URL(
    `https://io.adafruit.com/api/v2/${USER}/feeds/${feedKey}/data`
  );
  url.searchParams.set('limit', limit);
  Object.entries(params).forEach(([k,v])=>v&&url.searchParams.set(k,v));
  console.log(`Fetching ${feedKey}`, url.toString());
  const res = await fetch(url.toString(), {/* headers if needed */});
  if (!res.ok) { console.error(`Fetch failed [${feedKey}]:`,res.status); return []; }
  const p = await res.json();
  return Array.isArray(p)? p : Array.isArray(p.data)? p.data : [];
}

// ─── Formatting Utilities ────────────────────────────────────────
const fmt     = (v,p=1)=>(v==null||isNaN(v))?'–':(+v).toFixed(p);
const isoHHMM = ts=> ts?ts.substring(11,19):'';

// ─── Charts Initialization (time scale) ─────────────────────────
function initCharts(){
  const ctr = document.getElementById('charts');
  ctr.innerHTML = '';
  SENSORS.forEach(s=>{
    const card = document.createElement('div');
    card.className = 'bg-white rounded-2xl shadow p-4 chart-box';
    card.innerHTML = `
      <h2 class="text-sm font-semibold mb-2">${s.label}</h2>
      <canvas></canvas>
    `;
    ctr.appendChild(card);
    const ctx = card.querySelector('canvas').getContext('2d');
    s.chart = new Chart(ctx,{
      type:'line',
      data:{labels:[], datasets:[{data:[], borderColor:s.col, borderWidth:2, tension:0.25}]},
      options:{
        animation:false,
        responsive:true,
        maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{
          x:{
            type:'time',
            time:{
              unit:'minute',
              displayFormats:{minute:'HH:mm'}
            },
            ticks:{autoSkip:true, maxTicksLimit:6}
          },
          y:{grace:'5%'}
        }
      }
    });
  });
}

// ─── Leaflet Map Init ────────────────────────────────────────────
let map,marker,poly,trail=[];
function initMap(){
  map=L.map('map').setView([0,0],2);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    {attribution:'&copy; <a href="https://carto.com/">CARTO</a>'}
  ).addTo(map);
  marker=L.marker([0,0]).addTo(map);
  poly=L.polyline([], {weight:3}).addTo(map);
}
// dashboard.js — Section 2 of 2

// ─── Update Historical Charts ────────────────────────────────────
async function updateCharts(){
  const feeds=getFeeds(DEVICE);
  await Promise.all(SENSORS.map(async s=>{
    const rows=await fetchFeed(feeds[s.id], HIST);
    if(!rows.length) return;
    rows.reverse();
    s.chart.data.labels = rows.map(r=>r.created_at);
    s.chart.data.datasets[0].data = rows.map(r=>{
      const n=parseFloat(r.value);
      return isNaN(n)?null:n;
    });
    s.chart.update();
  }));
}

// ─── Draw Live Table & Map Trail ─────────────────────────────────
function drawLive({ts,fix,lat,lon,alt,sats,signal,volt,speed,nr1,nr2,nr3}){
  document.getElementById('latest').innerHTML=[
    ['Local Time',   new Date(ts).toLocaleString()],
    ['Fix',          fix],
    ['Lat',          fmt(lat,6)],
    ['Lon',          fmt(lon,6)],
    ['Alt (m)',      fmt(alt,1)],
    ['Sats',         fmt(sats,0)],
    ['Speed (km/h)', fmt(speed,1)],
    ['RSSI (dBm)',   fmt(signal,0)],
    ['Volt (mV)',    fmt(volt,2)],
    ['NR1 °F',       fmt(nr1,1)],
    ['NR2 °F',       fmt(nr2,1)],
    ['NR3 °F',       fmt(nr3,1)]
  ].map(([k,v])=>`<tr><th class="pr-2 text-left">${k}</th><td>${v}</td></tr>`).join('');

  const latN=Number(lat), lonN=Number(lon);
  if(isFinite(latN)&&isFinite(lonN)){
    map.invalidateSize();
    marker.setLatLng([latN,lonN]);
    trail.push([latN,lonN]);
    if(trail.length>TRAIL) trail.shift();
    poly.setLatLngs(trail);
    map.setView([latN,lonN],Math.max(map.getZoom(),13));
  }
}

// ─── Poll Loop ────────────────────────────────────────────────────
async function poll(){
  const f=getFeeds(DEVICE);
  const [gpsA,sigA,voltA,spdA,n1A,n2A,n3A]=await Promise.all([
    fetchFeed(f.gps),fetchFeed(f.signal),
    fetchFeed(f.volt),fetchFeed(f.speed),
    fetchFeed(f.nr1),fetchFeed(f.nr2),
    fetchFeed(f.nr3)
  ]);

  let g={fix:false,lat:null,lon:null,alt:null,sats:null};
  try{if(gpsA[0]?.value) g=JSON.parse(gpsA[0].value);}catch{}

  const pick=arr=>{
    const v=arr[0]?.value, n=parseFloat(v);
    return v!=null&&!isNaN(n)?n:null;
  };

  const live={
    ts:     gpsA[0]?.created_at,
    fix:    !!g.fix,
    lat:    g.lat,   lon:g.lon,
    alt:    g.alt,   sats:g.sats,
    signal: pick(sigA),
    volt:   pick(voltA),
    speed:  pick(spdA),
    nr1:    pick(n1A),
    nr2:    pick(n2A),
    nr3:    pick(n3A)
  };

  drawLive(live);

  [['nr1',live.nr1],['nr2',live.nr2],['nr3',live.nr3],
   ['signal',live.signal],['volt',live.volt],['speed',live.speed]
  ].forEach(([id,val])=>{
    if(val==null) return;
    const s=SENSORS.find(x=>x.id===id);
    s.chart.data.labels.push(live.ts);
    s.chart.data.datasets[0].data.push(val);
    if(s.chart.data.labels.length>HIST){
      s.chart.data.labels.shift();
      s.chart.data.datasets[0].data.shift();
    }
    s.chart.update();
  });

  setTimeout(poll,POLL_MS);
}

// ─── CSV Export Handler ─────────────────────────────────────────
document.getElementById('dlBtn').addEventListener('click',async()=>{
  const start=document.getElementById('start').value,
        end=document.getElementById('end').value;
  if(!start||!end){
    return document.getElementById('expStatus').textContent='Please select both start and end dates.';
  }
  document.getElementById('expStatus').textContent='Fetching…';
  const params={start:new Date(start).toISOString(),end:new Date(end).toISOString()};
  const data=await Promise.all(
    Object.entries(getFeeds(DEVICE)).map(async([key,fk])=>{
      const rows=await fetchFeed(fk,1000,params);
      return rows.map(r=>({feed:key,ts:r.created_at,value:r.value}));
    })
  );
  const flat=data.flat().sort((a,b)=>a.ts.localeCompare(b.ts));

  document.getElementById('preview').innerHTML=`
    <tr><th>Feed</th><th>Time</th><th>Value</th></tr>
    ${flat.slice(0,5).map(r=>`
      <tr><td>${r.feed}</td><td>${r.ts}</td><td>${r.value}</td></tr>
    `).join('')}
  `;

  const rows=[['feed','timestamp','value'],...flat.map(r=>[r.feed,r.ts,r.value])];
  const csv=rows.map(r=>r.join(',')).join('\n'),
        blob=new Blob([csv],{type:'text/csv'}),
        url=URL.createObjectURL(blob),
        a=document.createElement('a');
  a.href=url; a.download=`${DEVICE}_${start}_${end}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  document.getElementById('expStatus').textContent='Download ready.';
});

// ─── Bootstrap ───────────────────────────────────────────────────
document.getElementById('deviceSelect').addEventListener('change',e=>{
  DEVICE=e.target.value; initCharts(); updateCharts(); trail=[];
});
document.addEventListener('DOMContentLoaded',()=>{
  initCharts();
  updateCharts();
  initMap();
  poll();
  setInterval(updateCharts,POLL_MS);
});
