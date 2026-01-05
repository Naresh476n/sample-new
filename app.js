// ==================================================================
//  CONFIG
// ==================================================================
const ESP32_HOST = "http://esp32.local"; // or "http://192.168.1.123"

// Use Vercel env vars in production
const SUPABASE_URL =
  typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_URL
    ? process.env.NEXT_PUBLIC_SUPABASE_URL
    : "https://fpyjhxsmleuztoxxnxec.supabase.co";

const SUPABASE_ANON_KEY =
  typeof process !== "undefined" && process.env?.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZweWpoeHNtbGV1enRveHhueGVjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc2MTc4NjksImV4cCI6MjA4MzE5Mzg2OX0.8TwwLVl50OObXNgbpf5BPCU8LNFNU8VhS3DK3t180mI";

// Relay pin mapping (id → GPIO pin)
const relayPins = { 1: 16, 2: 17, 3: 18, 4: 19 };

// Supabase client (vanilla fetch-based for reliability)
async function supabaseUpsertRelay(id, state) {
  // Table: relays(id int, pin int, state bool, updated_at timestamptz)
  const body = [{ id, pin: relayPins[id], state, updated_at: new Date().toISOString() }];
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/relays`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Supabase upsert failed: ${resp.status} ${t}`);
  }
}
async function supabaseFetchRelays() {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/relays?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
  });
  if (!resp.ok) throw new Error(`Supabase fetch failed: ${resp.status}`);
  return resp.json();
}

// ==================================================================
//  DATE & TIME
// ==================================================================
function updateDateTime() {
  const el = document.getElementById("dateTime");
  if (el) el.textContent = new Date().toLocaleString();
}
setInterval(updateDateTime, 1000);
updateDateTime();

// ==================================================================
//  GLOBAL VARIABLES
// ==================================================================
const relayStates = { 1: false, 2: false, 3: false, 4: false };
const usageTimers = { 1: 0, 2: 0, 3: 0, 4: 0 };
const usageLimits = { 1: 12, 2: 12, 3: 12, 4: 12 };
const autoOffTimers = {};

async function sendToESP32(id, state) {
  // GET /relay?id=1&state=on|off for reliability in simple firmware
  const url = `${ESP32_HOST}/relay?id=${id}&state=${state ? "on" : "off"}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2000);
  try {
    const r = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
    clearTimeout(t);
    if (!r.ok) throw new Error(`ESP32 HTTP ${r.status}`);
    return true;
  } catch (err) {
    clearTimeout(t);
    addNotification(`ESP32 not reachable for Load ${id}. Will retry in background.`);
    console.warn(err);
    return false;
  }
}

// ==================================================================
//  RELAY / TIMERS / LIMITS
// ==================================================================
for (let i = 1; i <= 4; i++) {
  const el = document.getElementById(`relay${i}`);
  if (el) el.addEventListener("change", (e) => toggleRelay(i, e.target.checked));
}

async function toggleRelay(id, state) {
  // Update UI immediately
  relayStates[id] = state;
  const statusEl = document.getElementById(`s${id}`);
  if (statusEl) statusEl.textContent = state ? "ON" : "OFF";
  const chk = document.getElementById(`relay${id}`);
  if (chk && chk.checked !== state) chk.checked = state;
  addNotification(`Load ${id} turned ${state ? "ON" : "OFF"}`);

  // Fire-and-forget to ESP32 for instant hardware action
  sendToESP32(id, state);

  // Persist to Supabase (await for integrity)
  try {
    await supabaseUpsertRelay(id, state);
  } catch (err) {
    addNotification(`Supabase persist failed for Load ${id}. Will retry on next change.`);
    console.error(err);
  }
}

document.querySelectorAll(".preset").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById("customMin");
    if (input) input.value = btn.dataset.min;
  });
});

const applyTimerBtn2 = document.getElementById("applyTimer");
if (applyTimerBtn2) {
  applyTimerBtn2.addEventListener("click", () => {
    const load = document.getElementById("loadSelect").value;
    const mins = parseInt(document.getElementById("customMin").value, 10);
    if (!mins || mins <= 0) return alert("Enter valid minutes");
    if (autoOffTimers[load]) clearTimeout(autoOffTimers[load]);
    autoOffTimers[load] = setTimeout(() => {
      const chk = document.getElementById(`relay${load}`);
      if (chk) chk.checked = false;
      toggleRelay(Number(load), false);
      addNotification(`Auto-OFF: Load ${load} OFF after ${mins} min`);
    }, mins * 60 * 1000);
    addNotification(`Timer set for Load ${load}: ${mins} min`);
  });
}

const saveLimitsBtn = document.getElementById("saveLimits");
if (saveLimitsBtn) {
  saveLimitsBtn.addEventListener("click", () => {
    for (let i = 1; i <= 4; i++) {
      const el = document.getElementById(`limit${i}`);
      if (!el) continue;
      const v = parseFloat(el.value);
      if (!isNaN(v) && v > 0) usageLimits[i] = v;
    }
    addNotification("Usage limits updated.");
  });
}

setInterval(() => {
  for (let i = 1; i <= 4; i++) {
    if (relayStates[i]) {
      usageTimers[i] += 2;
      const hoursUsed = usageTimers[i] / 3600;
      if (hoursUsed >= usageLimits[i]) {
        const chk = document.getElementById(`relay${i}`);
        if (chk) chk.checked = false;
        toggleRelay(i, false);
        addNotification(`Limit reached: Load ${i} OFF after ${usageLimits[i]} hrs`);
      }
    }
  }
}, 2000);

// ==================================================================
//  BOOTSTRAP FROM SUPABASE (optional sync on page load)
// ==================================================================
(async function bootstrapFromSupabase() {
  try {
    const rows = await supabaseFetchRelays();
    rows.forEach((r) => {
      const id = Number(r.id);
      const st = !!r.state;
      relayStates[id] = st;
      const chk = document.getElementById(`relay${id}`);
      const sEl = document.getElementById(`s${id}`);
      if (chk) chk.checked = st;
      if (sEl) sEl.textContent = st ? "ON" : "OFF";
    });
    addNotification("Bootstrapped relay states from Supabase.");
  } catch (err) {
    console.warn("Bootstrap from Supabase failed:", err);
  }
})();
// ==================================================================
//  LOCAL DATASET (REPLACEMENT FOR SUPABASE)
//  Use the provided readings here. Dates are YYYY-MM-DD.
// ==================================================================
const LOCAL_DATA = [
  { date: "2025-09-15", load1_wh: 1.5, load2_wh: 1.5, load3_wh: 1.4, load4_wh: 1.6, total_wh: 6 },
  { date: "2025-09-16", load1_wh: 6, load2_wh: 6, load3_wh: 5.6, load4_wh: 8, total_wh: 25.6 },
  { date: "2025-09-17", load1_wh: 7.5, load2_wh: 6, load3_wh: 5.6, load4_wh: 8, total_wh: 27.1 },
  { date: "2025-09-18", load1_wh: 4.5, load2_wh: 3, load3_wh: 1.4, load4_wh: 1.6, total_wh: 10.5 },
  { date: "2025-09-19", load1_wh: 1.5, load2_wh: 1.5, load3_wh: 4.2, load4_wh: 4.8, total_wh: 12 },
  { date: "2025-09-20", load1_wh: 3, load2_wh: 3, load3_wh: 2.8, load4_wh: 3.2, total_wh: 12 },
  { date: "2025-09-21", load1_wh: 1.5, load2_wh: 1.5, load3_wh: 1.4, load4_wh: 1.6, total_wh: 6 },
  { date: "2025-09-22", load1_wh: 4.5, load2_wh: 3, load3_wh: 2.8, load4_wh: 3.2, total_wh: 13.5 },
  { date: "2025-09-23", load1_wh: 6, load2_wh: 6, load3_wh: 4.2, load4_wh: 4.8, total_wh: 21 },
  { date: "2025-09-24", load1_wh: 1.5, load2_wh: 3, load3_wh: 4.2, load4_wh: 4.8, total_wh: 13.5 },
  { date: "2025-09-25", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 7, load4_wh: 8, total_wh: 30 },
  { date: "2025-09-26", load1_wh: 6, load2_wh: 6, load3_wh: 5.6, load4_wh: 6.4, total_wh: 24 },
  { date: "2025-09-27", load1_wh: 3, load2_wh: 1.5, load3_wh: 1.4, load4_wh: 1.6, total_wh: 7.5 },
  { date: "2025-09-28", load1_wh: 3, load2_wh: 1.5, load3_wh: 2.8, load4_wh: 1.6, total_wh: 8.9 },
  { date: "2025-09-29", load1_wh: 3, load2_wh: 3, load3_wh: 2.8, load4_wh: 1.6, total_wh: 10.4 },
  { date: "2025-09-30", load1_wh: 4.5, load2_wh: 3, load3_wh: 2.8, load4_wh: 3.2, total_wh: 13.5 },
  { date: "2025-10-01", load1_wh: 6, load2_wh: 6, load3_wh: 4.2, load4_wh: 4.8, total_wh: 21 },
  { date: "2025-10-02", load1_wh: 4.5, load2_wh: 3, load3_wh: 4.2, load4_wh: 4.8, total_wh: 16.5 },
  { date: "2025-10-03", load1_wh: 1.5, load2_wh: 6, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2025-10-04", load1_wh: 1.5, load2_wh: 1.5, load3_wh: 1.4, load4_wh: 1.6, total_wh: 6 },
  { date: "2025-10-05", load1_wh: 3, load2_wh: 3, load3_wh: 2.8, load4_wh: 3.2, total_wh: 12 },
  { date: "2025-10-06", load1_wh: 6, load2_wh: 6, load3_wh: 5.6, load4_wh: 8, total_wh: 25.6 },
  { date: "2025-10-07", load1_wh: 3, load2_wh: 1.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 11.9 },
  { date: "2025-10-08", load1_wh: 1.5, load2_wh: 3, load3_wh: 1.4, load4_wh: 3.2, total_wh: 9.1 },
  { date: "2025-10-09", load1_wh: 4.5, load2_wh: 3, load3_wh: 4.2, load4_wh: 3.2, total_wh: 14.9 },
  { date: "2025-10-10", load1_wh: 3, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2025-10-11", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 7, load4_wh: 3.2, total_wh: 25.2 },
  { date: "2025-10-12", load1_wh: 3, load2_wh: 3, load3_wh: 2.8, load4_wh: 3.2, total_wh: 12 },
  { date: "2025-10-13", load1_wh: 4.5, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 3.2, total_wh: 15 },
  { date: "2025-10-14", load1_wh: 4.5, load2_wh: 3, load3_wh: 2.8, load4_wh: 3.2, total_wh: 13.5 },
  { date: "2025-10-15", load1_wh: 1.5, load2_wh: 3, load3_wh: 4.2, load4_wh: 3.2, total_wh: 11.9 },
  { date: "2025-10-16", load1_wh: 4.5, load2_wh: 3, load3_wh: 7, load4_wh: 1.6, total_wh: 16.1 },
  { date: "2025-10-17", load1_wh: 3, load2_wh: 7.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 18.1 },
  { date: "2025-10-18", load1_wh: 1.5, load2_wh: 3, load3_wh: 5.6, load4_wh: 6.4, total_wh: 16.5 },
  { date: "2025-10-19", load1_wh: 6, load2_wh: 1.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 14.9 },
  { date: "2025-10-20", load1_wh: 7.5, load2_wh: 6, load3_wh: 1.4, load4_wh: 8, total_wh: 22.9 },
  { date: "2025-10-21", load1_wh: 3, load2_wh: 3, load3_wh: 7, load4_wh: 6.4, total_wh: 19.4 },
  { date: "2025-10-22", load1_wh: 6, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 18.1 },
  { date: "2025-10-23", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 5.6, load4_wh: 1.6, total_wh: 19.2 },
  { date: "2025-10-24", load1_wh: 1.5, load2_wh: 1.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 10.4 },
  { date: "2025-10-25", load1_wh: 7.5, load2_wh: 6, load3_wh: 1.4, load4_wh: 8, total_wh: 22.9 },
  { date: "2025-10-26", load1_wh: 3, load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2025-10-27", load1_wh: 6, load2_wh: 3, load3_wh: 2.8, load4_wh: 1.6, total_wh: 13.4 },
  { date: "2025-10-28", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 7, load4_wh: 4.8, total_wh: 23.8 },
  { date: "2025-10-29", load1_wh: 1.5, load2_wh: 3, load3_wh: 4.2, load4_wh: 8, total_wh: 16.7 },
  { date: "2025-10-30", load1_wh: 7.5, load2_wh: 6, load3_wh: 1.4, load4_wh: 6.4, total_wh: 21.3 },
  { date: "2025-10-31", load1_wh: 3, load2_wh: 1.5, load3_wh: 5.6, load4_wh: 3.2, total_wh: 13.3 },
  { date: "2025-11-01", load1_wh: 6, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 8, total_wh: 21.3 },
  { date: "2025-11-02", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 7, load4_wh: 1.6, total_wh: 20.6 },
  { date: "2025-11-03", load1_wh: 1.5, load2_wh: 3, load3_wh: 4.2, load4_wh: 4.8, total_wh: 13.5 },
  { date: "2025-11-04", load1_wh: 7.5, load2_wh: 6, load3_wh: 5.6, load4_wh: 6.4, total_wh: 25.5 },
  { date: "2025-11-05", load1_wh: 3, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 3.2, total_wh: 13.5 },
  { date: "2025-11-06", load1_wh: 6, load2_wh: 7.5, load3_wh: 7, load4_wh: 8, total_wh: 28.5 },
  { date: "2025-11-07", load1_wh: 4.5, load2_wh: 1.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 16.6 },
  { date: "2025-11-08", load1_wh: 1.5, load2_wh: 3, load3_wh: 1.4, load4_wh: 4.8, total_wh: 10.7 },
  { date: "2025-11-09", load1_wh: 7.5, load2_wh: 6, load3_wh: 5.6, load4_wh: 3.2, total_wh: 22.3 },
  { date: "2025-11-10", load1_wh: 3, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2025-11-11", load1_wh: 6, load2_wh: 3, load3_wh: 7, load4_wh: 8, total_wh: 24 },
  { date: "2025-11-12", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 4.8, total_wh: 21 },
  { date: "2025-11-13", load1_wh: 1.5, load2_wh: 1.5, load3_wh: 1.4, load4_wh: 3.2, total_wh: 7.6 },
  { date: "2025-11-14", load1_wh: 7.5, load2_wh: 6, load3_wh: 5.6, load4_wh: 8, total_wh: 27.1 },
  { date: "2025-11-15", load1_wh: 3, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2025-11-16", load1_wh: 6, load2_wh: 7.5, load3_wh: 7, load4_wh: 3.2, total_wh: 23.7 },
  { date: "2025-11-17", load1_wh: 4.5, load2_wh: 3, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2025-11-18", load1_wh: 1.5, load2_wh: 6, load3_wh: 5.6, load4_wh: 1.6, total_wh: 14.7 },
  { date: "2025-11-19", load1_wh: 7.5, load2_wh: 4.5, load3_wh: 1.4, load4_wh: 8, total_wh: 21.4 },
  { date: "2025-11-20", load1_wh: 3, load2_wh: 3, load3_wh: 4.2, load4_wh: 6.4, total_wh: 16.6 },
  { date: "2025-11-21", load1_wh: 6, load2_wh: 1.5, load3_wh: 7, load4_wh: 4.8, total_wh: 19.3 },
  { date: "2025-11-22", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 2.8, load4_wh: 3.2, total_wh: 18 },
  { date: "2025-11-23", load1_wh: 1.5, load2_wh: 4.5, load3_wh: 7, load4_wh: 6.4, total_wh: 19.4 },
  { date: "2025-11-24", load1_wh: 7.5, load2_wh: 6, load3_wh: 1.4, load4_wh: 4.8, total_wh: 19.7 },
  { date: "2025-11-25", load1_wh: 3, load2_wh: 3, load3_wh: 5.6, load4_wh: 8, total_wh: 19.6 },
  { date: "2025-11-26", load1_wh: 6, load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2025-11-27", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 19.4 },
  { date: "2025-11-28", load1_wh: 1.5, load2_wh: 3, load3_wh: 7, load4_wh: 4.8, total_wh: 16.3 },
  { date: "2025-11-29", load1_wh: 7.5, load2_wh: 4.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 19.8 },
  { date: "2025-11-30", load1_wh: 3, load2_wh: 6, load3_wh: 5.6, load4_wh: 8, total_wh: 22.6 },
  { date: "2025-12-01", load1_wh: 6, load2_wh: 4.5, load3_wh: 7, load4_wh: 6.4, total_wh: 23.9 },
  { date: "2025-12-02", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 2.8, load4_wh: 3.2, total_wh: 18 },
  { date: "2025-12-03", load1_wh: 1.5, load2_wh: 6, load3_wh: 4.2, load4_wh: 4.8, total_wh: 16.5 },
  { date: "2025-12-04", load1_wh: 7.5, load2_wh: 3, load3_wh: 1.4, load4_wh: 8, total_wh: 19.9 },
  { date: "2025-12-05", load1_wh: 3, load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2025-12-06", load1_wh: 6, load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2025-12-07", load1_wh: 4.5, load2_wh: 6, load3_wh: 7, load4_wh: 3.2, total_wh: 20.7 },
  { date: "2025-12-08", load1_wh: 1.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 8, total_wh: 21.2 },
  { date: "2025-12-09", load1_wh: 7.5, load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 24 },
  { date: "2025-12-10", load1_wh: 3, load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 12.1 },
  { date: "2025-12-11", load1_wh: 6, load2_wh: 3, load3_wh: 7, load4_wh: 3.2, total_wh: 19.2 },
  { date: "2025-12-12", load1_wh: 4.5, load2_wh: 6, load3_wh: 4.2, load4_wh: 8, total_wh: 22.7 },
  { date: "2025-12-13", load1_wh: 1.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 16.8 },
  { date: "2025-12-14", load1_wh: 7.5, load2_wh: 3, load3_wh: 5.6, load4_wh: 4.8, total_wh: 20.9 },
  { date: "2025-12-15", load1_wh: 3, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2025-12-16", load1_wh: 6, load2_wh: 1.5, load3_wh: 7, load4_wh: 3.2, total_wh: 17.7 },
  { date: "2025-12-17", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 8, total_wh: 24.2 },
  { date: "2025-12-18", load1_wh: 1.5, load2_wh: 6, load3_wh: 1.4, load4_wh: 4.8, total_wh: 13.7 },
  { date: "2025-12-19", load1_wh: 7.5, load2_wh: 3, load3_wh: 5.6, load4_wh: 6.4, total_wh: 22.5 },
  { date: "2025-12-20", load1_wh: 3, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 8, total_wh: 18.3 },
  { date: "2025-12-21", load1_wh: 6, load2_wh: 1.5, load3_wh: 7, load4_wh: 4.8, total_wh: 19.3 },
  { date: "2025-12-22", load1_wh: 4.5, load2_wh: 6, load3_wh: 4.2, load4_wh: 6.4, total_wh: 21.1 },
  { date: "2025-12-23", load1_wh: 1.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 3.2, total_wh: 13.6 },
  { date: "2025-12-24", load1_wh: 7.5, load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8, total_wh: 25.6 },
  { date: "2025-12-25", load1_wh: 3,   load2_wh: 3,   load3_wh: 2.8, load4_wh: 4.8, total_wh: 13.6 },
  { date: "2025-12-26", load1_wh: 6,   load2_wh: 1.5, load3_wh: 7,   load4_wh: 6.4, total_wh: 20.9 },
  { date: "2025-12-27", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 19.4 },
  { date: "2025-12-28", load1_wh: 1.5, load2_wh: 3,   load3_wh: 5.6, load4_wh: 8,   total_wh: 18.1 },
  { date: "2025-12-29", load1_wh: 7.5, load2_wh: 4.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 21.2 },
  { date: "2025-12-30", load1_wh: 3,   load2_wh: 6,   load3_wh: 4.2, load4_wh: 4.8, total_wh: 18.0 },
  { date: "2025-12-31", load1_wh: 6,   load2_wh: 7.5, load3_wh: 1.4, load4_wh: 3.2, total_wh: 18.1 },
  { date: "2026-01-01", load1_wh: 4.5, load2_wh: 6,   load3_wh: 2.8, load4_wh: 8,   total_wh: 21.3 },
  { date: "2026-01-02", load1_wh: 1.5, load2_wh: 3,   load3_wh: 5.6, load4_wh: 4.8, total_wh: 15.0 },
  { date: "2026-01-03", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 7,   load4_wh: 3.2, total_wh: 25.2 },
  { date: "2026-01-04", load1_wh: 3,   load2_wh: 4.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 15.3 },
  { date: "2026-01-05", load1_wh: 6,   load2_wh: 1.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 18.1 },
  { date: "2026-01-06", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-01-07", load1_wh: 1.5, load2_wh: 3,   load3_wh: 2.8, load4_wh: 8,   total_wh: 15.3 },
  { date: "2026-01-08", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 5.6, load4_wh: 3.2, total_wh: 23.8 },
  { date: "2026-01-09", load1_wh: 3,   load2_wh: 4.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 15.3 },
  { date: "2026-01-10", load1_wh: 6,   load2_wh: 1.5, load3_wh: 7,   load4_wh: 4.8, total_wh: 19.3 },
  { date: "2026-01-11", load1_wh: 4.5, load2_wh: 6,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 21.1 },
  { date: "2026-01-12", load1_wh: 1.5, load2_wh: 7.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 19.8 },
  { date: "2026-01-13", load1_wh: 7.5, load2_wh: 3,   load3_wh: 5.6, load4_wh: 4.8, total_wh: 20.9 },
  { date: "2026-01-14", load1_wh: 3,   load2_wh: 4.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 15.3 },
  { date: "2026-01-15", load1_wh: 6,   load2_wh: 1.5, load3_wh: 7,   load4_wh: 3.2, total_wh: 17.7 },
  { date: "2026-01-16", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 22.8 },
  { date: "2026-01-17", load1_wh: 1.5, load2_wh: 6,   load3_wh: 4.2, load4_wh: 4.8, total_wh: 16.5 },
  { date: "2026-01-18", load1_wh: 7.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 6.4, total_wh: 18.3 },
  { date: "2026-01-19", load1_wh: 3,   load2_wh: 1.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 18.1 },
  { date: "2026-01-20", load1_wh: 6,   load2_wh: 4.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 19.7 },
  { date: "2026-01-21", load1_wh: 4.5, load2_wh: 7.5, load3_wh: 7,   load4_wh: 4.8, total_wh: 23.8 },
  { date: "2026-01-22", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 15.1 },
  { date: "2026-01-23", load1_wh: 7.5, load2_wh: 6,   load3_wh: 1.4, load4_wh: 3.2, total_wh: 18.1 },
  { date: "2026-01-24", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-01-25", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-01-26", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-01-27", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 8,   total_wh: 16.7 },
  { date: "2026-01-28", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 22.8 },
  { date: "2026-01-29", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 4.8, total_wh: 17.9 },
  { date: "2026-01-30", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-01-31", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 3.2, total_wh: 20.7 },
  { date: "2026-02-01", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-02-02", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-02-03", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-02-04", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-02-05", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 22.4 },
  { date: "2026-02-06", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2026-02-07", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-02-08", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 8,   total_wh: 25.5 },
  { date: "2026-02-09", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 6.4, total_wh: 12.3 },
  { date: "2026-02-10", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 22.4 },
  { date: "2026-02-11", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 4.8, total_wh: 17.9 },
  { date: "2026-02-12", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-02-13", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 8,   total_wh: 25.5 },
  { date: "2026-02-14", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 4.8, total_wh: 10.7 },
  { date: "2026-02-15", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 25.6 },
  { date: "2026-02-16", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 3.2, total_wh: 16.3 },
  { date: "2026-02-17", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 18.3 },
  { date: "2026-02-18", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 6.4, total_wh: 23.9 },
  { date: "2026-02-19", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 4.8, total_wh: 10.7 },
  { date: "2026-02-20", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 25.6 },
  { date: "2026-02-21", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 3.2, total_wh: 16.3 },
  { date: "2026-02-22", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-02-23", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 8,   total_wh: 25.5 },
  { date: "2026-02-24", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 6.4, total_wh: 12.3 },
  { date: "2026-02-25", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 22.4 },
  { date: "2026-02-26", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-02-27", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-02-28", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 6.4, total_wh: 23.9 },
  { date: "2026-03-01", load1_wh: 6,   load2_wh: 1.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 18.1 },
  { date: "2026-03-02", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-03-03", load1_wh: 1.5, load2_wh: 3,   load3_wh: 2.8, load4_wh: 8,   total_wh: 15.3 },
  { date: "2026-03-04", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 5.6, load4_wh: 3.2, total_wh: 23.8 },
  { date: "2026-03-05", load1_wh: 3,   load2_wh: 4.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 15.3 },
  { date: "2026-03-06", load1_wh: 6,   load2_wh: 1.5, load3_wh: 7,   load4_wh: 4.8, total_wh: 19.3 },
  { date: "2026-03-07", load1_wh: 4.5, load2_wh: 6,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 21.1 },
  { date: "2026-03-08", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 3.2, total_wh: 9.1 },
  { date: "2026-03-09", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 25.8 },
  { date: "2026-03-10", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 4.8, total_wh: 17.9 },
  { date: "2026-03-11", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-03-12", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-03-13", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 15.1 },
  { date: "2026-03-14", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 3.2, total_wh: 19.6 },
  { date: "2026-03-15", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-03-16", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-03-17", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 6.4, total_wh: 23.9 },
  { date: "2026-03-18", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-03-19", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 22.4 },
  { date: "2026-03-20", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2026-03-21", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 18.3 },
  { date: "2026-03-22", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-03-23", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 15.1 },
  { date: "2026-03-24", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 8,   total_wh: 24.4 },
  { date: "2026-03-25", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 4.8, total_wh: 17.9 },
  { date: "2026-03-26", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-03-27", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 3.2, total_wh: 20.7 },
  { date: "2026-03-28", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-03-29", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 25.6 },
  { date: "2026-03-30", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-03-31", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-04-01", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-04-02", load1_wh: 1.5, load2_wh: 3,   load3_wh: 2.8, load4_wh: 6.4, total_wh: 13.7 },
  { date: "2026-04-03", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 28.6 },
  { date: "2026-04-04", load1_wh: 3,   load2_wh: 4.5, load3_wh: 1.4, load4_wh: 4.8, total_wh: 13.7 },
  { date: "2026-04-05", load1_wh: 6,   load2_wh: 1.5, load3_wh: 7,   load4_wh: 6.4, total_wh: 20.9 },
  { date: "2026-04-06", load1_wh: 4.5, load2_wh: 6,   load3_wh: 2.8, load4_wh: 8,   total_wh: 21.3 },
  { date: "2026-04-07", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 4.8, total_wh: 13.5 },
  { date: "2026-04-08", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 6.4, total_wh: 22.8 },
  { date: "2026-04-09", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-04-10", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-04-11", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 3.2, total_wh: 20.7 },
  { date: "2026-04-12", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-04-13", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 4.8, total_wh: 24.0 },
  { date: "2026-04-14", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2026-04-15", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 18.3 },
  { date: "2026-04-16", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-04-17", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 15.1 },
  { date: "2026-04-18", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 8,   total_wh: 24.4 },
  { date: "2026-04-19", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 4.8, total_wh: 17.9 },
  { date: "2026-04-20", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-04-21", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 8,   total_wh: 25.5 },
  { date: "2026-04-22", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 6.4, total_wh: 12.3 },
  { date: "2026-04-23", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 22.4 },
  { date: "2026-04-24", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-04-25", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-04-26", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 6.4, total_wh: 23.9 },
  { date: "2026-04-27", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-04-28", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 22.4 },
  { date: "2026-04-29", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2026-04-30", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 18.3 },
  { date: "2026-05-01", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-05-02", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 15.1 },
  { date: "2026-05-03", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 8,   total_wh: 24.4 },
  { date: "2026-05-04", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 4.8, total_wh: 17.9 },
  { date: "2026-05-05", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-05-06", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 3.2, total_wh: 20.7 },
  { date: "2026-05-07", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-05-08", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 25.6 },
  { date: "2026-05-09", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-05-10", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-05-11", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 6.4, total_wh: 23.9 },
  { date: "2026-05-12", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-05-13", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 3.2, total_wh: 22.4 },
  { date: "2026-05-14", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 6.4, total_wh: 19.5 },
  { date: "2026-05-15", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 8,   total_wh: 18.3 },
  { date: "2026-05-16", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 4.8, total_wh: 22.3 },
  { date: "2026-05-17", load1_wh: 1.5, load2_wh: 3,   load3_wh: 4.2, load4_wh: 6.4, total_wh: 15.1 },
  { date: "2026-05-18", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 1.4, load4_wh: 8,   total_wh: 24.4 },
  { date: "2026-05-19", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 4.8, total_wh: 17.9 },
  { date: "2026-05-20", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 6.4, total_wh: 16.7 },
  { date: "2026-05-21", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 3.2, total_wh: 20.7 },
  { date: "2026-05-22", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 },
  { date: "2026-05-23", load1_wh: 7.5, load2_wh: 7.5, load3_wh: 4.2, load4_wh: 6.4, total_wh: 25.6 },
  { date: "2026-05-24", load1_wh: 3,   load2_wh: 4.5, load3_wh: 5.6, load4_wh: 8,   total_wh: 21.1 },
  { date: "2026-05-25", load1_wh: 6,   load2_wh: 1.5, load3_wh: 2.8, load4_wh: 4.8, total_wh: 15.1 },
  { date: "2026-05-26", load1_wh: 4.5, load2_wh: 6,   load3_wh: 7,   load4_wh: 6.4, total_wh: 23.9 },
  { date: "2026-05-27", load1_wh: 1.5, load2_wh: 3,   load3_wh: 1.4, load4_wh: 8,   total_wh: 13.9 }
];


// Build a quick lookup map by date for fast access
const LOCAL_MAP = LOCAL_DATA.reduce((m, r) => {
  m[r.date] = {
    load1: Number(r.load1_wh || 0),
    load2: Number(r.load2_wh || 0),
    load3: Number(r.load3_wh || 0),
    load4: Number(r.load4_wh || 0),
    total: Number(r.total_wh || (Number(r.load1_wh || 0) + Number(r.load2_wh || 0) + Number(r.load3_wh || 0) + Number(r.load4_wh || 0)))
  };
  return m;
}, {});

// ==================================================================
//  LIVE MONITORING (unchanged demo)
// ==================================================================
function updateLiveDemo() {
  let totalCurrent = 0, totalPower = 0;
  let v1, c1, v2, c2, v3, c3, v4, c4;
  if (relayStates[1]) { v1 = (12 + Math.random() * 0.3).toFixed(1); c1 = (0.12 + Math.random() * 0.02).toFixed(2); } else { v1 = "0.0"; c1 = "0.00"; }
  if (relayStates[2]) { v2 = (12 + Math.random() * 0.2).toFixed(1); c2 = (0.12 + Math.random() * 0.01).toFixed(2); } else { v2 = "0.0"; c2 = "0.00"; }
  if (relayStates[3]) { v3 = (12).toFixed(1); c3 = (0.12).toFixed(2); } else { v3 = "0.0"; c3 = "0.00"; }
  if (relayStates[4]) { v4 = (12 + Math.random() * 0.5).toFixed(1); c4 = (0.11 + Math.random() * 0.05).toFixed(2); } else { v4 = "0.0"; c4 = "0.00"; }

  const voltages = [v1, v2, v3, v4];
  const currents = [c1, c2, c3, c4];

  for (let i = 1; i <= 4; i++) {
    const voltage = parseFloat(voltages[i - 1]);
    const current = parseFloat(currents[i - 1]);
    const power = (voltage * current).toFixed(1);
    const vEl = document.getElementById(`v${i}`);
    const cEl = document.getElementById(`c${i}`);
    const pEl = document.getElementById(`p${i}`);
    const sEl = document.getElementById(`s${i}`);
    if (vEl) vEl.textContent = voltages[i - 1] + "V";
    if (cEl) cEl.textContent = currents[i - 1] + "A";
    if (pEl) pEl.textContent = power + "W";
    if (sEl) sEl.textContent = relayStates[i] ? "ON" : "OFF";
    totalCurrent += isNaN(current) ? 0 : current;
    totalPower += isNaN(parseFloat(power)) ? 0 : parseFloat(power);
  }

  const validVoltages = voltages.filter((v) => parseFloat(v) > 0);
  const avgVoltage = validVoltages.length > 0 ? (validVoltages.reduce((a, b) => a + parseFloat(b), 0) / validVoltages.length).toFixed(1) : "0.0";
  const tv = document.getElementById("tv"), tc = document.getElementById("tc"), tp = document.getElementById("tp");
  if (tv) tv.textContent = avgVoltage + "V";
  if (tc) tc.textContent = totalCurrent.toFixed(2) + "A";
  if (tp) tp.textContent = totalPower.toFixed(1) + "W";
}
setInterval(updateLiveDemo, 2000);

// ==================================================================
//  CHARTS (IN Wh) - USING LOCAL_DATA
// ==================================================================
const filterSelect = document.getElementById("filterSelect");
const filterInputs = {
  day: document.getElementById("singleDay"),
  month: document.getElementById("singleMonth"),
  dayRange: document.getElementById("dayRangeInputs"),
  monthRange: document.getElementById("monthRangeInputs"),
};
if (filterSelect) {
  filterSelect.addEventListener("change", () => {
    Object.values(filterInputs).forEach((el) => {
      if (el && el.classList) el.classList.add("hidden");
    });
    const selected = filterSelect.value;
    if (filterInputs[selected] && filterInputs[selected].classList) filterInputs[selected].classList.remove("hidden");
  });
}

let chart = null;

function calculateCost(totalWh) {
  if (totalWh <= 50) return totalWh * 0.5;
  else if (totalWh <= 100) return totalWh * 0.5;
  else return totalWh * 0.5;
}

// Helper: format Date to YYYY-MM-DD
function toISODateStr(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Helper: get month key YYYY-MM
function toYearMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Aggregate LOCAL_DATA by month (precompute)
const MONTH_AGG = LOCAL_DATA.reduce((m, r) => {
  const ym = r.date.slice(0, 7); // YYYY-MM
  if (!m[ym]) m[ym] = { load1: 0, load2: 0, load3: 0, load4: 0, total: 0, days: 0 };
  m[ym].load1 += Number(r.load1_wh || 0);
  m[ym].load2 += Number(r.load2_wh || 0);
  m[ym].load3 += Number(r.load3_wh || 0);
  m[ym].load4 += Number(r.load4_wh || 0);
  m[ym].total += Number(r.total_wh || (Number(r.load1_wh||0)+Number(r.load2_wh||0)+Number(r.load3_wh||0)+Number(r.load4_wh||0)));
  m[ym].days += 1;
  return m;
}, {});

// Chart load handler (uses LOCAL_MAP / LOCAL_DATA)
const loadChartsBtn = document.getElementById("loadCharts");
if (loadChartsBtn) {
  loadChartsBtn.addEventListener("click", () => {
    const canvas = document.getElementById("chart");
    if (!canvas) {
      alert("Chart canvas not found.");
      return;
    }
    const ctx = canvas.getContext("2d");
    if (chart) chart.destroy();

    const selected = filterSelect ? filterSelect.value : "day";
    const deviceLabels = ["Light 1", "Light 2", "Light 3", "Fan"];
    const colors = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444"];
    let chartLabels = [];
    let dailyData = [];

    try {
      if (selected === "day") {
        const dayInput = document.getElementById("singleDay");
        const day = (dayInput && dayInput.value) ? dayInput.value : toISODateStr(new Date());
        if (dayInput && !dayInput.value) dayInput.value = day;
        chartLabels.push(day);

        const loads = LOCAL_MAP[day] || { load1: 0, load2: 0, load3: 0, load4: 0 };
        dailyData.push({ load1: loads.load1, load2: loads.load2, load3: loads.load3, load4: loads.load4 });

      } else if (selected === "dayRange") {
        const fromVal = document.getElementById("fromDay").value;
        const toVal = document.getElementById("toDay").value;
        if (!fromVal || !toVal) {
          alert("Please select both From and To dates.");
          return;
        }
        const from = new Date(fromVal);
        const to = new Date(toVal);
        if (isNaN(from.getTime()) || isNaN(to.getTime())) {
          alert("Invalid dates selected.");
          return;
        }
        if (from > to) {
          alert("From date must be earlier than or equal to To date.");
          return;
        }

        for (let d = new Date(from.getTime()); d.getTime() <= to.getTime(); d.setDate(d.getDate() + 1)) {
          const ds = toISODateStr(d);
          chartLabels.push(ds);
          const loads = LOCAL_MAP[ds] || { load1: 0, load2: 0, load3: 0, load4: 0 };
          dailyData.push({ load1: loads.load1, load2: loads.load2, load3: loads.load3, load4: loads.load4 });
        }

      } else if (selected === "month") {
        const val = document.getElementById("singleMonth").value || new Date().toISOString().slice(0, 7);
        chartLabels.push(val);
        const agg = MONTH_AGG[val];
        if (agg) {
          dailyData.push({ load1: agg.load1, load2: agg.load2, load3: agg.load3, load4: agg.load4 });
        } else {
          dailyData.push({ load1: 0, load2: 0, load3: 0, load4: 0 });
        }

      } else if (selected === "monthRange") {
        const fromVal = document.getElementById("fromMonth").value;
        const toVal = document.getElementById("toMonth").value;
        if (!fromVal || !toVal) {
          alert("Please select both From and To months.");
          return;
        }
        const from = new Date(fromVal + "-01");
        const to = new Date(toVal + "-01");
        if (isNaN(from.getTime()) || isNaN(to.getTime())) {
          alert("Invalid months selected.");
          return;
        }
        if (from > to) {
          alert("From month must be earlier than or equal to To month.");
          return;
        }
        for (let d = new Date(from.getTime()); d.getTime() <= to.getTime(); d.setMonth(d.getMonth() + 1)) {
          const ym = toYearMonth(d);
          chartLabels.push(ym);
          const agg = MONTH_AGG[ym];
          if (agg) dailyData.push({ load1: agg.load1, load2: agg.load2, load3: agg.load3, load4: agg.load4 });
          else dailyData.push({ load1: 0, load2: 0, load3: 0, load4: 0 });
        }
      }

      // Prepare dataset for Chart.js (ensure numeric values)
      const datasets = deviceLabels.map((load, i) => {
        const key = `load${i + 1}`;
        return {
          label: load,
          backgroundColor: colors[i],
          borderColor: colors[i],
          data: dailyData.map((day) => Number(day[key] || 0)),
          fill: false
        };
      });

      chart = new Chart(ctx, {
        type: document.getElementById("chartType").value || "bar",
        data: { labels: chartLabels, datasets },
        options: {
          responsive: true,
          plugins: {
            title: { display: true, text: "Power Consumption (Wh)", color: "#e2e8f0" },
            legend: { labels: { color: "#e2e8f0" } }
          },
          scales: {
            x: { ticks: { color: "#e2e8f0" } },
            y: { ticks: { color: "#e2e8f0" }, beginAtZero: true }
          }
        }
      });

      // Show Wh & Cost below chart
      const resultDiv = document.getElementById("chartResults");
      if (resultDiv) {
        resultDiv.innerHTML = "";
        chartLabels.forEach((label, idx) => {
          const l = dailyData[idx] || { load1: 0, load2: 0, load3: 0, load4: 0 };
          const totalWh = Number(l.load1 || 0) + Number(l.load2 || 0) + Number(l.load3 || 0) + Number(l.load4 || 0);
          const cost = calculateCost(totalWh).toFixed(2);
          resultDiv.innerHTML += `
            <div style="
              margin-top:8px; background:#1e293b; padding:10px; border-radius:10px;
              text-align:center; width:60%; margin-left:auto; margin-right:auto;
              color:#e2e8f0; box-shadow:0 0 8px #0ea5e9;">
              <strong>${label}</strong><br>
              Load1: ${Number(l.load1 || 0).toFixed(2)} Wh<br>
              Load2: ${Number(l.load2 || 0).toFixed(2)} Wh<br>
              Load3: ${Number(l.load3 || 0).toFixed(2)} Wh<br>
              Fan:   ${Number(l.load4 || 0).toFixed(2)} Wh<br><br>
              <b>Total = ${totalWh.toFixed(2)} Wh</b> | Cost = ₹${cost}
            </div>`;
        });
      }

      addNotification(`Charts loaded for "${selected}" using local dataset.`);
    } catch (err) {
      console.error("loadCharts error:", err);
      alert("Failed to load chart. See console for details.");
      addNotification("Error loading charts. See console.");
    }
  });
}

// ==================================================================
//  PDF REPORT (IN Wh) - updated to match month/monthRange graph
// ==================================================================
const downloadPdfBtn = document.getElementById("downloadPdf");
if (downloadPdfBtn) {
  downloadPdfBtn.addEventListener("click", () => {
    const selected = filterSelect ? filterSelect.value : "month";
    if (selected !== "month" && selected !== "monthRange") {
      alert("PDF report available only for monthly or month-range data.");
      return;
    }
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF();

    // Helper: get human-readable month label
    function monthLabel(ym) {
      const [y, m] = ym.split("-");
      const name = new Date(Number(y), Number(m) - 1).toLocaleString("default", { month: "long" });
      return `${name} ${y}`;
    }

    // Render a single month's report block using MONTH_AGG
    function renderMonthBlock(ym, addPage) {
      const agg = MONTH_AGG[ym];
      if (!agg) return;

      if (addPage) pdf.addPage();

      pdf.setFontSize(14);
      pdf.text(`Power Consumption Report - ${monthLabel(ym)}`, 14, 20);
      pdf.setFontSize(10);
      pdf.text("------------------------------------------", 14, 26);

      let y = 34;
      pdf.text("Load Name        | Power Used (Wh)", 14, y);
      y += 6;
      pdf.text(`Light 1          | ${agg.load1.toFixed(1)} Wh`, 14, y); y += 6;
      pdf.text(`Light 2          | ${agg.load2.toFixed(1)} Wh`, 14, y); y += 6;
      pdf.text(`Light 3          | ${agg.load3.toFixed(1)} Wh`, 14, y); y += 6;
      pdf.text(`Fan              | ${agg.load4.toFixed(1)} Wh`, 14, y); y += 10;

      pdf.text("------------------------------------------", 14, y);
      y += 8;
      pdf.text(`Total Power: ${agg.total.toFixed(1)} Wh`, 14, y);
      y += 6;
      const cost = calculateCost(agg.total).toFixed(2);
      pdf.text(`Cost:${cost}Rupees`, 14, y);

      // Embed current chart image if available
      const chartCanvas = document.getElementById("chart");
      if (chartCanvas && chart) {
        const imgData = chart.toBase64Image();
        // Place image below summary; size adjusted to fit A4 width
        pdf.addImage(imgData, "PNG", 15, y + 10, 180, 80);
      }
    }

    if (selected === "month") {
      const ym = document.getElementById("singleMonth").value || new Date().toISOString().slice(0, 7);
      if (!MONTH_AGG[ym]) {
        alert("No data available for selected month.");
        return;
      }
      renderMonthBlock(ym, false);
    } else {
      const fromVal = document.getElementById("fromMonth").value;
      const toVal = document.getElementById("toMonth").value;
      if (!fromVal || !toVal) {
        alert("Please select both From and To months.");
        return;
      }
      const from = new Date(fromVal + "-01");
      const to = new Date(toVal + "-01");
      if (isNaN(from.getTime()) || isNaN(to.getTime())) {
        alert("Invalid months selected.");
        return;
      }
      if (from > to) {
        alert("From month must be earlier than or equal to To month.");
        return;
      }

      let first = true;
      for (let d = new Date(from.getTime()); d.getTime() <= to.getTime(); d.setMonth(d.getMonth() + 1)) {
        const ym = toYearMonth(d);
        if (!MONTH_AGG[ym]) continue;
        renderMonthBlock(ym, !first);
        first = false;
      }
    }

    pdf.save("Monthly_Report_Wh.pdf");
  });
}

// ==================================================================
//  NOTIFICATIONS + LOGOUT
// ==================================================================
function addNotification(msg) {
  const list = document.getElementById("notifs");
  if (!list) return;
  if (list.children.length === 0 || list.children[0].textContent === "No notifications yet.") list.innerHTML = "";
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} - ${msg}`;
  list.prepend(li);
}

const refreshNotifs = document.getElementById("refreshNotifs");
if (refreshNotifs) refreshNotifs.addEventListener("click", () => addNotification("New data updated."));
const clearNotifs = document.getElementById("clearNotifs");
if (clearNotifs) clearNotifs.addEventListener("click", () => {
  const notifs = document.getElementById("notifs");
  if (notifs) notifs.innerHTML = "<li>No notifications yet.</li>";
});
function logout() {
  window.location.href = "index.html";
}
