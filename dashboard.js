// dashboard.js

const USER     = 'Inalgescodatalogger';
const AIO_KEY  = 'YOUR_AIO_KEY'; // ← replace with your real key
let DEVICE     = 'skycafe-1';
const POLL_MS  = 10000;
const HIST     = 200;
const TRAIL    = 50;

const getFeeds = d => ({
  gps:   `${d}.gps`,
  signal:`${d}.signal`,
  volt:  `${d}.volt`,
  speed: `${d}.speed`,
  nr1:   `${d}.nr1`,
  nr2:   `${d}.nr2`,
  nr3:   `${d}.nr3`
});

async function fetchFeed(feed, limit=1, params={}) {
  const url = new URL(`https://io.adafruit.com/api/v2/${USER}/feeds/${feed}/data`);
  url.searchParams.set('limit', limit);
  Object.entries(params).forEach(([k,v]) => v && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { 'X-AIO-Key': AIO_KEY } });
  return res.ok ? res.json() : [];
}

// TODO: initialize Chart.js charts and Leaflet map here

(async function poll() {
  const feeds = getFeeds(DEVICE);
  const gpsData = await fetchFeed(feeds.gps);
  console.log('Latest GPS:', gpsData);
  setTimeout(poll, POLL_MS);
})();
