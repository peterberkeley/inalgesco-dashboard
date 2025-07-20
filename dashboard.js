// --- Per-device tokens
const TOKENS = {
  "skycafe-1":  "BBUS-tSkfHbTV8ZNb25hhASDhaOA84JeHq8",
  "skycafe-2":  "BBUS-PoaNQXG2hMOTfNzAjLEhbQeSW0HE2P",
  "skycafe-3":  "BBUS-iA1d3odtdyBl1Li3aTxeffacaYzbTW",
  "skycafe-4":  "BBUS-02xhIPOIpmMrGv5OwS2XX5La6Nn7ma",
  "skycafe-5":  "BBUS-FV7oZN9Xc45nxYevSaopBl7k5PEulk",
  "skycafe-6":  "BBUS-seXBbsBXsrBMy36xrszv69tOJK9q33",
  "skycafe-7":  "BBUS-7iuQhKnTINTKKJE1mkFryTZmZNYAmU",
  "skycafe-8":  "BBUS-KgQ7uvh3QgFNeRj6EGQTvTKH91Y0hv",
  "skycafe-9":  "BBUS-OCoYOgeBSeIOOlExVxm59W1dqVYB7p",
  "skycafe-10": "BBUS-hUwkXc9JKvaNq5cl8H3sMRPR0AZvj2",
  "skycafe-11": "BBUS-1AFBfwaDmRrpWPUDuKfMWxVjdpeG7O",
  "skycafe-12": "BBUS-4flIrJ1FKcQUHh0c0z7HQrg458lSZ4"
};
const DEVICES = Object.keys(TOKENS);
const UBIDOTS_BASE = "https://corsproxy.io/?https://industrial.api.ubidots.com/api/v1.6";

// --- LIVENESS CHECK: only count "signal", "gps", or "iccid" variables
async function checkLiveness(dev) {
  const token = TOKENS[dev];
  const url = `${UBIDOTS_BASE}/variables/?device=${dev}&token=${token}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const js = await res.json();
    const now = Date.now();
    for (const v of js.results || []) {
      // Only count true device variables; ignore Dallas addresses!
      if (
        ["signal", "gps", "iccid"].includes(v.label) &&
        v.last_value && v.last_value.timestamp &&
        (now - v.last_value.timestamp) < 60000
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// --- POPULATE DROPDOWN
async function fillDropdown() {
  const sel = document.getElementById('deviceSelect');
  sel.innerHTML = '';
  for (const dev of DEVICES) {
    const online = await checkLiveness(dev);
    const opt = document.createElement('option');
    opt.value = dev;
    opt.text = dev.replace('skycafe-', 'SkyCafé ');
    if (!online) {
      opt.disabled = true;
      opt.text += ' (Offline)';
    }
    sel.appendChild(opt);
  }
  // Select the first online truck by default
  for (const opt of sel.options) {
    if (!opt.disabled) {
      sel.value = opt.value;
      break;
    }
  }
}

// --- INIT
document.addEventListener('DOMContentLoaded', fillDropdown);
