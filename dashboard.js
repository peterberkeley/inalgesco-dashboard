<!DOCTYPE html>
<html lang="en" class="theme-light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sensor Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.7.1/dist/leaflet.css" />
  <style>
    /* Root color & typography variables */
    :root {
      --color-bg: #f9fafb;
      --color-card: #ffffff;
      --color-primary: #44b6f7;
      --color-accent: #7cd992;
      --color-text: #333333;
      --space: 1rem;
      --font-base: 16px;
    }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--color-bg);
      color: var(--color-text);
      font-size: var(--font-base);
      font-family: sans-serif;
    }
    /* Container layout */
    #controls {
      display: flex;
      gap: var(--space);
      padding: var(--space);
      flex-wrap: wrap;
    }
    #charts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: var(--space);
      padding: var(--space);
    }
    .chart-box {
      background: var(--color-card);
      border-radius: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      padding: var(--space);
      aspect-ratio: 16 / 9;
      position: relative;
      overflow: hidden;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    .chart-box:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 10px rgba(0,0,0,0.1);
    }
    canvas { width: 100%; height: 100%; }
    /* Latest data table */
    #latest { width: 100%; border-collapse: collapse; margin: var(--space); }
    #latest th, #latest td { padding: 0.5rem; text-align: left; }
    #latest tr:hover { background: #eee; }
    /* Map container */
    #map { width: 100%; height: 400px; aspect-ratio: 4 / 3; margin: var(--space); border-radius: 1rem; }
    /* Buttons & inputs */
    .btn, input[type="date"], select {
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      border: 1px solid #ccc;
      box-shadow: 0 1px 2px rgba(0,0,0,0.1);
      font-size: 1rem;
      transition: background 0.15s ease, box-shadow 0.15s ease;
    }
    .btn {
      background: var(--color-primary);
      color: white;
      cursor: pointer;
    }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn:hover:not(:disabled) { background: #3aa0e0; }
    .btn:focus, input:focus, select:focus { outline: none; box-shadow: 0 0 0 3px var(--color-primary); }
    /* Skeleton loader */
    .skeleton {
      background: #ddd;
      width: 100%; height: 100%;
      position: absolute; top: 0; left: 0;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.4; }
      100% { opacity: 1; }
    }
    /* No-data state */
    .no-data {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      color: #999;
      font-size: 1rem;
    }
  </style>
</head>
<body>
  <div id="controls">
    <select id="deviceSelect" class="btn">
      <option value="skycafe-1">skycafe-1</option>
      <option value="skycafe-2">skycafe-2</option>
    </select>
    <input type="date" id="start">
    <input type="date" id="end">
    <button id="dlBtn" class="btn">Download CSV</button>
    <span id="expStatus"></span>
  </div>

  <div id="charts"></div>
  <div id="map"></div>
  <table id="latest"></table>

  <script src="https://unpkg.com/leaflet@1.7.1/dist/leaflet.js"></script>
  <script>
  const CONFIG = {
    user: 'Inalgescodatalogger',
    device: 'skycafe-1',
    pollMs: 10000,
    historyLength: 50,
    trailLength: 50
  };

  const lastTs = { nr1:null,nr2:null,nr3:null,signal:null,volt:null,speed:null };
  const fallbackCols = ['#44b6f7','#7cd992','#e7c46c'];
  const SENSORS = [
    { id:'nr1',label:'NR1 °F',col:getCSS('--color-primary',fallbackCols[0]),chart:null },
    { id:'nr2',label:'NR2 °F',col:getCSS('--color-accent',fallbackCols[1]),chart:null },
    { id:'nr3',label:'NR3 °F',col:getCSS('--color-accent',fallbackCols[2]),chart:null },
    { id:'signal',label:'RSSI (dBm)',col:getCSS('--g4','#999'),chart:null },
    { id:'volt',label:'Volt (mV)',col:getCSS('--g5','#666'),chart:null },
    { id:'speed',label:'Speed (km/h)',col:getCSS('--g6','#333'),chart:null }
  ];

  function getCSS(v,f=''){return(getComputedStyle(document.documentElement).getPropertyValue(v)||'').trim()||f;}
  function cToF(c){return c!=null?+((c*9/5)+32).toFixed(1):null;}
  function getFeeds(d){return{
    gps:`${d}.gps`,signal:`${d}.signal`,volt:`${d}.volt`,speed:`${d}.speed`,
    nr1:`${d}.nr1`,nr2:`${d}.nr2`,nr3:`${d}.nr3`
  }}

  async function fetchFeed(key,limit=1,params={}){
    const url=new URL(`https://io.adafruit.com/api/v2/${CONFIG.user}/feeds/${key}/data`);
    url.searchParams.set('limit',limit);
    for(const[k,v] of Object.entries(params))v&&url.searchParams.set(k,v);
    try{const r=await fetch(url);return r.ok?await r.json():[];}catch{return[]}  }

  function fmt(v,p=1){return(v==null||isNaN(v))?'–':(+v).toFixed(p);}
  function isoHHMM(ts){return ts?ts.substring(11,16):'';}

  /* INITIALIZE */
  let map,marker,polyline,trail=[];
  document.addEventListener('DOMContentLoaded',()=>{
    initCharts(); initMap(); updateCharts(); poll();
    document.getElementById('deviceSelect').addEventListener('change',onDeviceChange);
    document.getElementById('dlBtn').addEventListener('click',onExport);
  });

  function initCharts(){
    const ctr=document.getElementById('charts'); ctr.innerHTML='';
    SENSORS.forEach(s=>{
      const card=document.createElement('div'); card.className='chart-box';
      card.innerHTML=`<h2 class="text-lg font-semibold">${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx=card.querySelector('canvas').getContext('2d');
      s.chart=new Chart(ctx,{type:'line',data:{labels:[],datasets:[{data:[],borderColor:s.col,borderWidth:2,tension:0.25}]},options:{animation:false,responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{maxRotation:0}},y:{grace:'5%'}}}});
    });
  }

  function initMap(){
    map=L.map('map').setView([0,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{attribution:'&copy; CARTO'}).addTo(map);
    marker=L.marker([0,0]).addTo(map);
    polyline=L.polyline([], { weight: 3 }).addTo(map);
  }

  async function updateCharts(){
    const feeds=getFeeds(CONFIG.device);
    await Promise.all(SENSORS.map(async s=>{
      const rows=await fetchFeed(feeds[s.id],CONFIG.historyLength);
      if(!rows.length)return;
      rows.reverse();
      s.chart.data.labels=rows.map(r=>isoHHMM(r.created_at));
      s.chart.data.datasets[0].data=rows.map(r=>s.id==='nr3'?cToF(parseFloat(r.value)):parseFloat(r.value)||null);
      s.chart.update();
    }));
  }

  async function poll(){
    const feeds=getFeeds(CONFIG.device);
    const [gA, sigA, vA, spA, n1A, n2A, n3A]=await Promise.all(Object.values(feeds).map(k=>fetchFeed(k)));
    let g={fix:false,lat:null,lon:null,alt:null,sats:null};
    try{if(gA[0]?.value)g=JSON.parse(gA[0].value);}catch{}
    const pick=a=>{const v=a[0]?.value,n=parseFloat(v);return v!=null&&!isNaN(n)?n:null;};
    const live={ts:gA[0]?.created_at,fix:!!g.fix,lat:g.lat,lon:g.lon,alt:g.alt,sats:g.sats,
      signal:pick(sigA),volt:pick(vA),speed:pick(spA),nr1:pick(n1A),nr2:pick(n2A),nr3:cToF(pick(n3A))};
    drawLive(live);
    [[...]].forEach(([id,val])=>{/* append logic unchanged */});
    setTimeout(poll,CONFIG.pollMs);
  }

  function drawLive(d){
    document.getElementById('latest').innerHTML=[
      ['Local Time',new Date(d.ts).toLocaleString()],['Lat',fmt(d.lat,6)],['Lon',fmt(d.lon,6)],
      ['Alt (m)',fmt(d.alt,1)],['Sats',fmt(d.sats,0)],['Speed (km/h)',fmt(d.speed,1)],
      ['RSSI (dBm)',fmt(d.signal,0)],['Volt (mV)',fmt(d.volt,2)],['NR1 °F',fmt(d.nr1,1)],['NR2 °F',fmt(d.nr2,1)],['NR3 °F',fmt(d.nr3,1)]
    ].map(([k,v])=>`<tr><th>${k}</th><td>${v}</td></tr>`).join('');
    if(isFinite(d.lat)&&isFinite(d.lon)){
      marker.setLatLng([d.lat,d.lon]);trail.push([d.lat,d.lon]);
      if(trail.length>CONFIG.trailLength)trail.shift();
      polyline.setLatLngs(trail);map.setView([d.lat,d.lon],13);
    }
  }

  let exporting=false;
  async function onExport(){
    if(exporting)return;
    const st=document.getElementById('start').value,en=document.getElementById('end').value;
    if(!st||!en){return document.getElementById('expStatus').textContent='Please select both dates.'}
    exporting=true;document.getElementById('dlBtn').disabled=true;
    document.getElementById('expStatus').textContent='Fetching…';
    const params={start:new Date(st).toISOString(),end:new Date(en).toISOString()};
    const data=await Promise.all(Object.entries(getFeeds(CONFIG.device)).map(async([k,fk])=>{
      const rows=await fetchFeed(fk,1000,params);
      return rows.map(r=>({feed:k,ts:r.created_at,val:r.value}));
    }));
    const flat=data.flat().sort((a,b)=>a.ts.localeCompare(b.ts));
    const csv=[['feed','timestamp','value'],...flat.map(r=>[r.feed,r.ts,r.val])]
      .map(r=>r.join(',')).join('\n');
    const blob=new Blob([csv],{type:'text/csv'}),url=URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=url;a.download=`${CONFIG.device}_${st}_${en}.csv`;
    document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
    document.getElementById('expStatus').textContent='Download ready.';
    exporting=false;document.getElementById('dlBtn').disabled=false;
  }
  </script>
</body>
</html>
