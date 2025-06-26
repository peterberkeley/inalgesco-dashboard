// dashboard.js — Unified with Visual Enhancements
(() => {
  // [0] THEME COLORS & SPINNER UTILS
  const COLORS = {
    primary: getCSS('--color-primary'),
    secondary: getCSS('--color-secondary'),
    accent: getCSS('--color-accent'),
    text: getCSS('--color-text'),
    card: getCSS('--color-card')
  };
  const spinner = document.getElementById('spinner');
  function showSpinner() { spinner.style.display = 'block'; }
  function hideSpinner() { spinner.style.display = 'none'; }

  // [1] CONFIG
  const USER = 'Inalgescodatalogger';
  let DEVICE = 'skycafe-1';
  const POLL_MS = 10000;
  const HIST = 50;
  const TRAIL = 50;
  const lastTs = { nr1: null, nr2: null, nr3: null, signal: null, volt: null, speed: null };

  // [2] SENSORS
  const SENSORS = [
    { id:'nr1', label:'NR1 °F', col: getCSS('--g1', COLORS.primary), chart:null },
    { id:'nr2', label:'NR2 °F', col: getCSS('--g2', COLORS.secondary), chart:null },
    { id:'nr3', label:'NR3 °F', col: getCSS('--g3', COLORS.accent), chart:null },
    { id:'signal', label:'RSSI (dBm)', col: getCSS('--g4', '#999'), chart:null },
    { id:'volt', label:'Volt (mV)', col: getCSS('--g5', '#666'), chart:null },
    { id:'speed', label:'Speed (km/h)', col: getCSS('--g6', '#333'), chart:null }
  ];

  // [3] CSS HELPER
  function getCSS(varName, fallback='') {
    return (getComputedStyle(document.documentElement).getPropertyValue(varName) || '').trim() || fallback;
  }

  // [4] FEEDS
  function getFeeds(device) {
    return {
      gps: `${device}.gps`, signal: `${device}.signal`, volt: `${device}.volt`,
      speed: `${device}.speed`, nr1: `${device}.nr1`, nr2: `${device}.nr2`, nr3: `${device}.nr3`
    };
  }

  // [5] FETCH UTILITY
  async function fetchFeed(feedKey, limit=1, params={}) {
    const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feedKey}/data`);
    url.searchParams.set('limit', limit);
    Object.entries(params).forEach(([k,v])=>v && url.searchParams.set(k,v));
    const res = await fetch(url.toString());
    if(!res.ok){ console.error(`Fetch failed [${feedKey}]:`, res.status); return []; }
    const body = await res.json();
    return Array.isArray(body)? body : Array.isArray(body.data)? body.data : [];
  }

  // [6] FORMATTING
  const fmt = (v,p=1)=>(v==null||isNaN(v))?'–':(+v).toFixed(p);
  const isoHHMM = ts=> ts? ts.substring(11,16): '';

  // [7] INIT CHARTS
  function initCharts() {
    const ctr = document.getElementById('charts'); ctr.innerHTML='';
    SENSORS.forEach(s=>{
      const card=document.createElement('div'); card.className='chart-box';
      card.innerHTML=`<h2>${s.label}</h2><canvas></canvas>`;
      ctr.appendChild(card);
      const ctx=card.querySelector('canvas').getContext('2d');
      s.chart=new Chart(ctx,{
        type:'line', data:{ labels:[], datasets:[{ data:[], borderColor:s.col, borderWidth:2, tension:0.25 }] },
        options:{
          animation:false, responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{ display:false },
            tooltip:{
              backgroundColor:COLORS.card, titleColor:COLORS.text, bodyColor:COLORS.text,
              borderColor:'rgba(0,0,0,0.1)', borderWidth:1
            }
          },
          scales:{
            x:{ grid:{ display:false }, ticks:{ maxRotation:0, color:COLORS.text } },
            y:{ grid:{ color:'rgba(0,0,0,0.05)' }, ticks:{ color:COLORS.text }, grace:'5%' }
          }
        }
      });
    });
  }

  // [8] INIT MAP
  let map, marker, polyline, trail=[];
  function initMap(){
    map=L.map('map').setView([0,0],2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{ attribution:'© CARTO' }).addTo(map);
    marker=L.marker([0,0]).addTo(map);
    polyline=L.polyline([], { weight:3 }).addTo(map);
    L.control.zoom({ position:'topright' }).addTo(map);
    L.control.scale({ metric:true, imperial:false }).addTo(map);
  }

  // [9] UPDATE HISTORICAL
  async function updateCharts(){
    const feeds=getFeeds(DEVICE);
    await Promise.all(SENSORS.map(async s=>{
      const rows=await fetchFeed(feeds[s.id], HIST);
      if(!rows.length) return;
      rows.reverse();
      s.chart.data.labels=rows.map(r=>isoHHMM(r.created_at));
      s.chart.data.datasets[0].data=rows.map(r=>{
        let n=parseFloat(r.value);
        if(s.id==='nr3'&&!isNaN(n)) n=(n*9/5)+32;
        return isNaN(n)?null:+n.toFixed(1);
      });
      s.chart.update();
    }));
  }

  // [10] DRAW LIVE
  function drawLive(data){
    const {ts,fix,lat,lon,alt,sats,signal,volt,speed,nr1,nr2,nr3}=data;
    document.getElementById('latest').innerHTML=
      [['Local Time',new Date(ts).toLocaleString()],['Lat',fmt(lat,6)],['Lon',fmt(lon,6)],['Alt (m)',fmt(alt,1)],['Sats',fmt(sats,0)],
       ['Speed (km/h)',fmt(speed,1)],['RSSI (dBm)',fmt(signal,0)],['Volt (mV)',fmt(volt,2)],
       ['NR1 °F',fmt(nr1,1)],['NR2 °F',fmt(nr2,1)],['NR3 °F',fmt(nr3,1)]
      ].map(([k,v])=>`<tr><th class="pr-2 text-left">${k}</th><td>${v}</td></tr>`).join('');
    const latN=Number(lat), lonN=Number(lon);
    if(isFinite(latN)&&isFinite(lonN)){
      map.invalidateSize(); marker.setLatLng([latN,lonN]); trail.push([latN,lonN]);
      if(trail.length>TRAIL) trail.shift(); polyline.setLatLngs(trail);
      map.setView([latN,lonN],Math.max(map.getZoom(),13));
    }
  }

  // [11] POLL LOOP
  async function poll(){
    const feeds=getFeeds(DEVICE);
    const [gpsA,sA,vA,spA,n1A,n2A,n3A]=await Promise.all([
      fetchFeed(feeds.gps),fetchFeed(feeds.signal),fetchFeed(feeds.volt),fetchFeed(feeds.speed),
      fetchFeed(feeds.nr1),fetchFeed(feeds.nr2),fetchFeed(feeds.nr3)
    ]);
    let g={fix:false,lat:null,lon:null,alt:null,sats:null};
    try{ if(gpsA[0]?.value) g=JSON.parse(gpsA[0].value); }catch{}
    const pick=arr=>{const v=arr[0]?.value,n=parseFloat(v);return(v!=null&&!isNaN(n))?n:null;};
    const live={ ts:gpsA[0]?.created_at, fix:!!g.fix, lat:g.lat, lon:g.lon, alt:g.alt, sats:g.sats,
                 signal:pick(sA), volt:pick(vA), speed:pick(spA), nr1:pick(n1A), nr2:pick(n2A),
                 nr3:(()=>{const c=pick(n3A);return c!=null?+((c*9/5)+32).toFixed(1):null;})() };
    drawLive(live);
    [['nr1',live.nr1],['nr2',live.nr2],['nr3',live.nr3],['signal',live.signal],['volt',live.volt],['speed',live.speed]]
      .forEach(([id,val])=>{
        if(val==null||live.ts===lastTs[id]) return;
        const s=SENSORS.find(x=>x.id===id);
        s.chart.data.labels.push(isoHHMM(live.ts));
        s.chart.data.datasets[0].data.push(val);
        lastTs[id]=live.ts;
        if(s.chart.data.labels.length>HIST){ s.chart.data.labels.shift(); s.chart.data.datasets[0].data.shift(); }
        s.chart.update();
      });
    setTimeout(poll,POLL_MS);
  }

  // [12] CSV EXPORT
  document.getElementById('dlBtn').addEventListener('click',async()=>{
    const start=document.getElementById('start').value, end=document.getElementById('end').value;
    if(!start||!end){ return document.getElementById('expStatus').textContent='Please select both dates.'; }
    document.getElementById('expStatus').textContent='Fetching…';
    const params={ start:new Date(start).toISOString(), end:new Date(end).toISOString() };
    const dataArr=await Promise.all(Object.entries(getFeeds(DEVICE)).map(async([k,feed])=>{
      const rows=await fetchFeed(feed,1000,params);
      return rows.map(r=>({feed:k,ts:r.created_at,value:r.value}));
    }));
    const flat=dataArr.flat().sort((a,b)=>a.ts.localeCompare(b.ts));
    document.getElementById('preview').innerHTML=
      `<tr><th>Feed</th><th>Time</th><th>Value</th></tr>`+
      flat.slice(0,5).map(r=>`<tr><td>${r.feed}</td><td>${r.ts}</td><td>${r.value}</td></tr>`).join('');
    const csv=[['feed','timestamp','value'],...flat.map(r=>[r.feed,r.ts,r.value])]
      .map(r=>r.join(',')).join('\n');
    const blob=new Blob([csv],{type:'text/csv'}), url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download=`${DEVICE}_${start}_${end}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    document.getElementById('expStatus').textContent='Download ready.';
  });

  // [13] DEVICE SELECTOR & BOOTSTRAP
  document.getElementById('deviceSelect').addEventListener('change',e=>{
    DEVICE=e.target.value; initCharts(); updateCharts(); trail=[];
  });
  document.addEventListener('DOMContentLoaded', async()=>{
    showSpinner();
    initCharts();
    await updateCharts();
    initMap();
    hideSpinner();
    poll();
  });
})();
