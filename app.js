import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

// ---------- settings ----------
const POLL_MS = 10000;          // how often the group map refreshes
const SEND_EVERY_MS = 15000;    // send position at least this often while moving
const HEARTBEAT_MS = 60000;     // resend even when still, so "last seen" stays fresh
const MOVE_METRES = 25;         // or sooner if moved this far
const STALE_MS = 3 * 60000;     // on a trip but no update for this long = warning
const STORE_KEY = 'gsp-creds-v1';

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const show = (el, on = true) => el.classList.toggle('hidden', !on);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; show(t, true);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => show(t, false), 4000);
}
function store(v) { try { v ? localStorage.setItem(STORE_KEY, JSON.stringify(v)) : localStorage.removeItem(STORE_KEY); } catch (e) { /* storage unavailable */ } }
function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } }
const hhmm = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60); return h + ' h ' + (m % 60) + ' min ago';
}
function mins(ms) { return Math.max(1, Math.round(Math.abs(ms) / 60000)); }
function metres(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const ERRORS = {
  group_not_found: 'No group with that code. Check it and try again.',
  group_full: 'That group is full (20 people).',
  invalid_name: 'Please enter your first name (up to 30 characters).',
  invalid_group_name: 'Please enter a group name (up to 40 characters).',
  invalid_eta: 'Pick an arrival time within the next 24 hours.',
  invalid_destination: 'Keep the destination under 60 characters.',
  not_member: "You're no longer in this group. It may have expired after 24 hours without use.",
};
function friendly(err) {
  const msg = err?.message || String(err);
  const key = Object.keys(ERRORS).find((k) => msg.includes(k));
  return key ? ERRORS[key] : 'Something went wrong: ' + msg;
}

// ---------- state ----------
const configured = SUPABASE_URL.startsWith('https://') && !SUPABASE_PUBLISHABLE_KEY.startsWith('PASTE');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
let creds = load();             // { code, group_name, member_id, secret, name }
let data = null;                // latest get_group result
let clockOffset = 0;            // server time minus device time
let mode = 'join';
let watchId = null, wakeLock = null, battery = null;
let lastFix = null, lastSent = null;
let map = null, markers = new Map(), fitted = false;
let pollTimer = null, heartbeatTimer = null, findTimer = null;
let shareState = 'off', resumeChecked = false;
let alerted = new Set();
const now = () => Date.now() + clockOffset;
const urlCode = (new URLSearchParams(location.search).get('g') || '').toUpperCase().slice(0, 8);

async function rpc(fn, args) {
  const { data: d, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return d;
}

// ---------- welcome ----------
function setMode(m) {
  mode = m;
  $('tabJoin').setAttribute('aria-selected', String(m === 'join'));
  $('tabCreate').setAttribute('aria-selected', String(m === 'create'));
  show($('joinFields'), m === 'join');
  show($('createFields'), m === 'create');
  $('welcomeBtn').textContent = m === 'join' ? 'Join group' : 'Create group';
}
$('tabJoin').onclick = () => setMode('join');
$('tabCreate').onclick = () => setMode('create');

$('welcomeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('displayName').value.trim();
  if (!name) return toast(ERRORS.invalid_name);
  if (!$('consent').checked) return toast('Please tick the box to agree before continuing.');
  const btn = $('welcomeBtn'); btn.disabled = true;
  try {
    let r;
    if (mode === 'join') {
      const code = $('groupCode').value.trim().toUpperCase();
      if (code.length < 8) { btn.disabled = false; return toast('Group codes are 8 characters.'); }
      r = await rpc('join_group', { p_code: code, p_display_name: name });
    } else {
      const gname = $('groupName').value.trim();
      if (!gname) { btn.disabled = false; return toast(ERRORS.invalid_group_name); }
      r = await rpc('create_group', { p_group_name: gname, p_display_name: name });
    }
    creds = { code: r.code, group_name: r.group_name, member_id: r.member_id, secret: r.secret, name };
    store(creds);
    history.replaceState(null, '', location.pathname + '?g=' + r.code);
    enterGroup();
    if (mode === 'create') { openInvite(); toast('Group created. Send the invite link to your group.'); }
  } catch (err) {
    toast(friendly(err));
  } finally {
    btn.disabled = false;
  }
});

// ---------- group view ----------
function enterGroup() {
  show($('welcome'), false);
  show($('groupView'), true);
  $('groupName2').textContent = creds.group_name;
  $('groupCode2').textContent = creds.code;
  $('inviteLink').value = location.origin + location.pathname + '?g=' + creds.code;
  setDefaultEta();
  if (!map) {
    map = L.map('map', { zoomControl: true }).setView([51.5072, -0.1276], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 50);
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

function leaveToWelcome(message) {
  stopSharing(false);
  resumeChecked = false;
  clearInterval(pollTimer);
  creds = null; data = null; store(null);
  markers.forEach((m) => m.remove()); markers.clear(); fitted = false;
  show($('groupView'), false);
  show($('welcome'), true);
  if (message) $('welcomeNote').textContent = message;
}

async function refresh() {
  if (!creds) return;
  try {
    const r = await rpc('get_group', { p_member: creds.member_id, p_secret: creds.secret });
    clockOffset = new Date(r.server_time).getTime() - Date.now();
    data = r;
    render();
  } catch (err) {
    if (String(err?.message || '').includes('not_member')) return leaveToWelcome(ERRORS.not_member);
    $('updatedNote').textContent = 'Could not refresh: check your signal. Retrying every 10 seconds.';
  }
}

function statusOf(m) {
  const t = now();
  const seen = m.last_seen_at ? new Date(m.last_seen_at).getTime() : null;
  if (m.trip_status === 'active') {
    const eta = new Date(m.trip_eta).getTime();
    if (t > eta) return { kind: 'bad', overdueMs: t - eta, seen, eta };
    if (m.sharing && (!seen || t - seen > STALE_MS)) return { kind: 'warn', seen, eta };
    return { kind: 'ok', seen, eta };
  }
  if (m.trip_status === 'home') return { kind: 'home', seen };
  return { kind: 'none', seen };
}

function render() {
  const t = now();
  const me = data.members.find((m) => m.is_me);
  // banners
  const banners = [];
  const overdueNow = new Set();
  data.members.forEach((m) => {
    const s = statusOf(m);
    const who = m.is_me ? 'You are' : esc(m.name) + ' is';
    const where = m.trip_destination ? ' getting to ' + esc(m.trip_destination) : '';
    const lastSeen = s.seen ? ' Last seen ' + ago(t - s.seen) + '.' : ' No location received yet.';
    if (s.kind === 'bad') {
      overdueNow.add(m.id);
      banners.push(`<div class="banner bad">${who} ${mins(s.overdueMs)} min overdue${where}.${lastSeen}${m.is_me ? ' Tap "I\'m home safe" if you\'re OK.' : ' Try calling them.'}</div>`);
    } else if (s.kind === 'warn') {
      banners.push(`<div class="banner warn">No update from ${m.is_me ? 'you' : esc(m.name)} for a while.${lastSeen} Their screen may be locked or their signal lost.</div>`);
    }
  });
  $('banners').innerHTML = banners.join('');
  const fresh = [...overdueNow].filter((id) => !alerted.has(id));
  if (fresh.length) {
    try { navigator.vibrate?.([300, 120, 300]); } catch (e) { /* not supported */ }
  }
  alerted = overdueNow;
  document.title = overdueNow.size ? `(!) Overdue: ${data.members.filter((m) => overdueNow.has(m.id)).map((m) => m.name).join(', ')}` : 'Group Safety (prototype)';

  // members list
  $('members').innerHTML = data.members.map((m) => {
    const s = statusOf(m);
    let line;
    if (s.kind === 'bad') line = `<span class="status-bad">Overdue by ${mins(s.overdueMs)} min</span>${m.trip_destination ? ' · heading to ' + esc(m.trip_destination) : ''} (due ${hhmm(new Date(s.eta))})`;
    else if (s.kind === 'ok' || s.kind === 'warn') line = `${s.kind === 'warn' ? '<span class="status-warn">No recent update</span> · ' : ''}Heading to ${esc(m.trip_destination || 'their destination')} · due ${hhmm(new Date(s.eta))} (in ${mins(s.eta - t)} min)`;
    else if (s.kind === 'home') line = '<span class="status-home">Home safe</span>';
    else line = 'Not on a trip';
    const seen = !m.sharing ? (s.seen ? `Location off · last seen ${ago(t - s.seen)}` : 'Location off')
      : (s.seen ? `Sharing · last seen ${ago(t - s.seen)}` : 'Sharing · waiting for first location');
    const batt = m.battery_pct != null ? ` · battery ${m.battery_pct}%` : '';
    const dot = { ok: 'st-ok', bad: 'st-bad', warn: 'st-warn', home: 'st-home', none: 'st-none' }[s.kind];
    return `<li class="member"><span class="dot ${dot}" aria-hidden="true"></span><div><b>${esc(m.name)}${m.is_me ? ' (you)' : ''}</b><div>${line}</div><div class="muted">${seen}${batt}</div></div></li>`;
  }).join('');
  $('updatedNote').textContent = 'Updated ' + hhmm(new Date()) + '. Refreshes every 10 seconds while this page is open.';

  // map
  const colours = { ok: '#0b5e69', bad: '#b42318', warn: '#d98a00', home: '#1d7a3e', none: '#7d8790' };
  const seenIds = new Set();
  data.members.forEach((m) => {
    if (m.lat == null || m.lng == null) return;
    seenIds.add(m.id);
    const s = statusOf(m);
    const style = { radius: m.is_me ? 10 : 9, color: '#fff', weight: 3, fillColor: colours[s.kind], fillOpacity: 1 };
    let mk = markers.get(m.id);
    if (!mk) {
      mk = L.circleMarker([m.lat, m.lng], style).addTo(map);
      mk.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -10], className: 'name' });
      markers.set(m.id, mk);
    }
    mk.setLatLng([m.lat, m.lng]).setStyle(style);
    mk.setTooltipContent(esc(m.is_me ? 'You' : m.name));
  });
  markers.forEach((mk, id) => { if (!seenIds.has(id)) { mk.remove(); markers.delete(id); } });
  if (!fitted && markers.size) { fitAll(); fitted = true; }

  // my trip card
  const active = me?.trip_status === 'active';
  show($('tripIdle'), !active);
  show($('tripActive'), active);
  if (active) {
    const eta = new Date(me.trip_eta);
    $('tripLine').textContent = `On your way${me.trip_destination ? ' to ' + me.trip_destination : ''} · due ${hhmm(eta)}`;
    const diff = eta.getTime() - t;
    $('tripCountdown').innerHTML = diff >= 0 ? `Arriving in about ${mins(diff)} min.` : `<span class="status-bad">You're ${mins(diff)} min past your arrival time. Your group has been alerted.</span>`;
    $('keepOpenNote').textContent = watchId === null
      ? 'Your location is off, but the overdue alert still works. Turn on "Share my location" so the group can see where you are.'
      : 'Keep this page open with the screen on. On this prototype, sharing pauses if your screen locks or you switch apps.';
  }
  if (!resumeChecked) {
    resumeChecked = true;
    if (me?.sharing && watchId === null) startSharing(); // page was reloaded while sharing
  }
}

function fitAll() {
  const pts = [...markers.values()].map((m) => m.getLatLng());
  if (pts.length === 1) map.setView(pts[0], 15);
  else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25));
}
$('fitBtn').onclick = fitAll;

// ---------- trip ----------
function setDefaultEta() {
  const d = new Date(Date.now() + 30 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  $('tripEta').value = hhmm(d);
}
function etaFromInput() {
  const [h, m] = $('tripEta').value.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d.getTime() < Date.now() - 5 * 60000) d.setDate(d.getDate() + 1); // a time earlier than now means tomorrow
  return d;
}

$('startTripBtn').onclick = async () => {
  const eta = etaFromInput();
  if (!eta) return toast('Pick an expected arrival time.');
  const btn = $('startTripBtn'); btn.disabled = true;
  try {
    await rpc('start_trip', { p_member: creds.member_id, p_secret: creds.secret, p_destination: $('tripDest').value.trim(), p_eta: eta.toISOString() });
    toast('Trip started.');
    startSharing();
    await refresh();
  } catch (err) {
    toast(friendly(err));
  } finally {
    btn.disabled = false;
  }
};

async function extend(minutes) {
  const me = data?.members.find((m) => m.is_me);
  if (!me) return;
  const base = Math.max(new Date(me.trip_eta).getTime(), now());
  try {
    await rpc('start_trip', { p_member: creds.member_id, p_secret: creds.secret, p_destination: me.trip_destination || '', p_eta: new Date(base + minutes * 60000).toISOString() });
    toast(`Arrival time moved ${minutes} minutes later.`);
    await refresh();
  } catch (err) { toast(friendly(err)); }
}
$('plus15').onclick = () => extend(15);
$('plus30').onclick = () => extend(30);

$('homeBtn').onclick = async () => {
  try {
    if (lastFix) await sendPosition(true);
    await rpc('end_trip', { p_member: creds.member_id, p_secret: creds.secret });
    stopSharing(false);
    toast('Marked as home safe. Location sharing stopped.');
    setDefaultEta();
    await refresh();
  } catch (err) { toast(friendly(err)); }
};

// ---------- location sharing ----------
const BLOCKED_HELP = 'Location is blocked for this site. iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using the App. Android: tap the icon left of the web address › Permissions › Location › Allow. Then reload this page. If you opened the link inside WhatsApp or another app, open it in Safari or Chrome instead.';

function setShare(state, detail) {
  shareState = state;
  const chip = $('shareChip'), status = $('shareStatus'), btn = $('shareBtn');
  const text = {
    off: ['Not sharing', 'off', 'Off. Nobody in the group can see where you are.'],
    finding: ['Finding you…', 'wait', 'Finding your location… Allow location if your phone asks.'],
    slow: ['Finding you…', 'wait', 'Still looking for your location. Move near a window or outdoors, and check location is switched on.'],
    on: ['Sharing location', 'on', 'On. The group can see where you are while this page is open.'],
    blocked: ['Location blocked', 'off', BLOCKED_HELP],
    error: ['Not sharing', 'off', detail || 'This browser cannot share location.'],
  }[state];
  chip.textContent = text[0];
  chip.className = 'chip ' + text[1];
  status.textContent = text[2];
  status.classList.toggle('blocked', state === 'blocked');
  const sharing = state === 'finding' || state === 'slow' || state === 'on';
  btn.textContent = sharing ? 'Stop sharing' : 'Share my location';
  btn.classList.toggle('stop', sharing);
  btn.classList.toggle('primary', !sharing);
}

function startSharing() {
  if (watchId !== null) return;
  if (!('geolocation' in navigator)) { setShare('error'); return; }
  setShare('finding');
  try { navigator.getBattery?.().then((b) => { battery = b; }).catch(() => {}); } catch (e) { /* not supported */ }
  watchId = navigator.geolocation.watchPosition((pos) => {
    lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    if (shareState !== 'on') setShare('on');
    sendPosition(false);
  }, (err) => {
    if (err.code === 1) { stopSharing(true); setShare('blocked'); }
    else if (shareState !== 'on') setShare('slow');
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  clearTimeout(findTimer);
  findTimer = setTimeout(() => { if (shareState === 'finding') setShare('slow'); }, 20000);
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => sendPosition(true), HEARTBEAT_MS);
  keepAwake();
}

function stopSharing(tellGroup = true) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  lastFix = null; lastSent = null;
  clearInterval(heartbeatTimer);
  clearTimeout(findTimer);
  try { wakeLock?.release(); } catch (e) { /* already released */ }
  wakeLock = null;
  setShare('off');
  if (tellGroup && creds) rpc('set_sharing', { p_member: creds.member_id, p_secret: creds.secret, p_on: false }).then(refresh).catch(() => {});
}

$('shareBtn').onclick = () => {
  if (watchId !== null) { stopSharing(true); toast('Location sharing stopped.'); }
  else startSharing();
};

async function sendPosition(force) {
  if (!lastFix || !creds) return;
  const t = Date.now();
  const moved = lastSent ? metres(lastSent, lastFix) : Infinity;
  if (!force && lastSent && t - lastSent.t < SEND_EVERY_MS && moved < MOVE_METRES) return;
  lastSent = { ...lastFix, t };
  try {
    await rpc('update_location', {
      p_member: creds.member_id, p_secret: creds.secret,
      p_lat: lastFix.lat, p_lng: lastFix.lng,
      p_accuracy: Math.round(lastFix.acc || 0),
      p_battery: battery ? Math.round(battery.level * 100) : null,
    });
  } catch (err) {
    lastSent = null; // try again on the next fix
  }
}

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      $('keepOpenNote').textContent = 'Your screen will stay on while this page is open. Sharing pauses if you switch apps or lock the phone.';
    }
  } catch (e) { /* wake lock not allowed; the note already asks to keep the screen on */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && creds) {
    if (watchId !== null) { keepAwake(); sendPosition(true); }
    refresh();
  }
});

// ---------- invite and leave ----------
function openInvite() { show($('inviteBox'), true); }
$('inviteBtn').onclick = async () => {
  const link = $('inviteLink').value;
  openInvite();
  if (navigator.share) {
    try { await navigator.share({ title: 'Join my group', text: `Join "${creds.group_name}" on Group Safety (test prototype). Code ${creds.code}`, url: link }); } catch (e) { /* cancelled */ }
  }
};
$('copyBtn').onclick = async () => {
  try { await navigator.clipboard.writeText($('inviteLink').value); toast('Invite link copied.'); }
  catch (e) { $('inviteLink').select(); toast('Select and copy the link.'); }
};
$('leaveBtn').onclick = async () => {
  if (!confirm('Leave this group and delete your location data?')) return;
  try { await rpc('leave_group', { p_member: creds.member_id, p_secret: creds.secret }); } catch (e) { /* already gone */ }
  leaveToWelcome('You left the group and your data was deleted.');
};

// ---------- start ----------
if (!configured) {
  show($('setupNeeded'), true);
} else if (creds && (!urlCode || urlCode === creds.code)) {
  enterGroup();
} else {
  show($('welcome'), true);
  if (urlCode) {
    $('groupCode').value = urlCode;
    if (creds) $('welcomeNote').textContent = `You're already in "${creds.group_name}". Joining this group will replace it on this phone.`;
  }
  setMode(urlCode || !creds ? 'join' : 'create');
}
