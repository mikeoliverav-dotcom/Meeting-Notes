'use strict';
/* Meeting Notes — record a call, capture screenshots and notes, transcribe in the browser with Whisper,
   then hand everything to Claude and turn the reply into a finished document. Everything is stored on this computer. */

const APP_VERSION = '1.6.0';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const hm = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = ms => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const dur = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
function toast(msg, ms = 2800) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); }
function twoTap(btn, confirmLabel, action) {
  const label = btn.innerHTML;
  btn.onclick = async e => {
    e.stopPropagation();
    if (!btn.classList.contains('confirm')) { btn.classList.add('confirm'); btn.textContent = confirmLabel; clearTimeout(btn._t); btn._t = setTimeout(() => { btn.classList.remove('confirm'); btn.innerHTML = label; }, 4000); return; }
    clearTimeout(btn._t); btn.classList.remove('confirm'); btn.innerHTML = label; await action();
  };
}
async function copyText(t, okMsg) {
  try { await navigator.clipboard.writeText(t); }
  catch (_) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast(okMsg);
}
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000); }
const safeName = s => (s || 'meeting').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'meeting';

/* ---------------- storage (IndexedDB, on this computer) ---------------- */
let dbp;
function openDB() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('meeting-notes', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('meetings', { keyPath: 'id' }); d.createObjectStore('blobs', { keyPath: 'id' }).createIndex('meetingId', 'meetingId'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
}
const done = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name, mode = 'readonly') { const d = await openDB(); const t = d.transaction(name, mode); const s = t.objectStore(name); s._done = new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Save interrupted')); }); return s; }
const idb = {
  async get(s, k) { return done((await store(s)).get(k)); },
  async all(s) { return done((await store(s)).getAll()); },
  async put(s, v) { const st = await store(s, 'readwrite'); st.put(v); await st._done; },
  async del(s, k) { const st = await store(s, 'readwrite'); st.delete(k); await st._done; },
  async byMeeting(id) { return done((await store('blobs')).index('meetingId').getAll(id)); },
  async keysByMeeting(id) { return done((await store('blobs')).index('meetingId').getAllKeys(id)); }
};
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

/* ---------------- state ---------------- */
let M = null;               // current meeting
const snipCache = new Map();
let saveT;
function saveSoon() { clearTimeout(saveT); saveT = setTimeout(saveNow, 400); }
async function saveNow() { if (!M) return; clearTimeout(saveT); M.updatedAt = Date.now(); try { await idb.put('meetings', JSON.parse(JSON.stringify(M))); } catch (e) { toast('Could not save: ' + (e.message || e)); } }
function show(v) { $('vHome').hidden = v !== 'home'; $('vMeet').hidden = v !== 'meet'; $('backBtn').hidden = v !== 'meet'; }

/* ---------------- home ---------------- */
async function renderHome() {
  show('home'); $('hdrTitle').hidden = true; $('recChip').hidden = true; document.title = 'Meeting Notes';
  const list = (await idb.all('meetings')).sort((a, b) => b.createdAt - a.createdAt);
  $('listWrap').hidden = !list.length;
  const status = m => TX.job?.id === m.id ? ['run', `Transcribing ${Math.round(TX.pct)}%`] : m.finalMd ? ['done', 'Done']
    : m.rec?.chunks && !m.tx?.done ? ['todo', m.tx?.userPaused ? 'Transcript paused' : 'Waiting to transcribe']
    : (m.tx?.done || m.notes?.length) ? ['todo', 'To write up'] : ['', 'Empty'];
  const todo = list.filter(m => /todo|run/.test(status(m)[0])).length;
  $('todoCount').textContent = todo ? `${todo} to finish` : '';
  $('mlist').innerHTML = list.map(m => { const [c, l] = status(m); return `<div class="mitem"><a href="?m=${m.id}" data-id="${m.id}">${esc(m.title)}</a>
      <span>${esc(day(m.createdAt))} · ${esc(hm(m.rec?.start || m.createdAt))}${m.rec?.duration ? ' · ' + dur(m.rec.duration) : ''}</span><b class="pill ${c}" data-id="${m.id}">${l}</b></div>`; }).join('');
  $('ver').textContent = 'v' + APP_VERSION;
  try { const e = await navigator.storage.estimate(); $('usage').textContent = `${Math.round((e.usage || 0) / 1048576)} MB used`; } catch (_) {}
}
$('newForm').addEventListener('submit', async e => {
  e.preventDefault();
  M = { id: uid(), title: $('newTitle').value.trim() || 'Meeting', createdAt: Date.now(), notes: [], rec: null, tx: null, finalMd: '' };
  $('newTitle').value = '';
  await saveNow(); history.pushState(null, '', '?m=' + M.id); openMeeting(M.id);
});
$('helpLink').onclick = e => { e.preventDefault(); $('help').hidden = !$('help').hidden; };

/* ---------------- meeting view ---------------- */
async function openMeeting(id) {
  M = TX.job && TX.job.id === id ? TX.job.mt : await idb.get('meetings', id);
  if (!M) { history.replaceState(null, '', './'); return renderHome(); }
  show('meet');
  const t = $('hdrTitle'); t.hidden = false; t.value = M.title; document.title = M.title + ' — Meeting Notes';
  $('finalIn').value = M.finalMd || '';
  setTab(M.finalMd ? 'final' : 'tl');
  renderRecPanel(); renderTxPanel(); renderTimeline(); renderFinal(); renderSteps();
}
$('hdrTitle').addEventListener('input', () => { if (!M) return; M.title = $('hdrTitle').value.trim() || 'Meeting'; document.title = M.title + ' — Meeting Notes'; saveSoon(); });
function setTab(w) { $('tabTl').classList.toggle('on', w === 'tl'); $('tabFinal').classList.toggle('on', w === 'final'); $('paneTl').hidden = w !== 'tl'; $('paneFinal').hidden = w !== 'final'; $('filters').hidden = w !== 'tl'; }
$('tabTl').onclick = () => setTab('tl');
$('tabFinal').onclick = () => setTab('final');
$('fTx').onchange = $('fNotes').onchange = () => renderTimeline();
function renderSteps() {
  $('st1').classList.toggle('done', !!M.rec?.ended);
  $('st2').classList.toggle('done', !!M.tx?.done);
  $('st4').classList.toggle('done', !!M.finalMd); $('st5').classList.toggle('done', !!M.finalMd);
  $('dlPdf').disabled = $('dlWord').disabled = !M.finalMd;
  $('dlTx').disabled = !(M.tx?.segments?.length);
  $('dlAudio').disabled = !(M.rec?.chunks);
  $('txBtn').disabled = !M.rec?.ended || REC.active || TX.running;
}

/* time base: maps a moment in the recording (seconds of audio) to the wall clock, allowing for pauses */
function audioToClock(sec, base) {
  const segs = base?.segs?.length ? base.segs : [{ clock: base?.start || M.createdAt, audioAt: 0 }];
  let s = segs[0]; for (const x of segs) if (x.audioAt <= sec) s = x;
  return s.clock + (sec - s.audioAt) * 1000;
}

/* ---------------- timeline ---------------- */
const snipTag = n => 'IMG-' + n.id.replace(/-/g, '').slice(0, 4).toUpperCase();
function txBlocks() {
  const segs = M.tx?.segments || []; const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    // join short pieces into readable paragraphs of up to ~40 seconds
    const join = last && s.start - last.end < 2.5 && s.end - last.start < 40 && (!/[.?!]["”]?$/.test(last.text) || last.end - last.start < 12);
    if (join) { last.text += ' ' + s.text; last.end = s.end; }
    else out.push({ start: s.start, end: s.end, text: s.text });
  }
  const base = M.tx?.base || M.rec;
  return out.map(b => ({ kind: 'tx', at: audioToClock(b.start, base), text: b.text, sec: b.start }));
}
function timelineItems(opts = { tx: true, notes: true }) {
  const items = [];
  if (opts.notes) for (const n of M.notes) items.push({ ...n, kind: n.kind });
  if (opts.tx) items.push(...txBlocks());
  return items.sort((a, b) => a.at - b.at || (a.kind === 'tx' ? 1 : -1));
}
function renderTimeline() {
  const L = $('tl');
  const items = timelineItems({ tx: $('fTx').checked, notes: $('fNotes').checked });
  if (!items.length) { L.innerHTML = '<div class="empty">Your notes, screenshots and (after you transcribe) the transcript appear here in time order. Start recording on the right, then type notes below.</div>'; return; }
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  L.innerHTML = items.map(it => {
    if (it.kind === 'tx') return `<div class="item tx"><span class="t">${esc(clock(it.at))}</span><div class="b">${esc(it.text)}</div><span></span></div>`;
    const acts = `<span class="acts"><button class="icon${it.important ? ' on' : ''}" data-star="${it.id}" title="Important">★</button><button class="icon" data-del="${it.id}" title="Delete">✕</button></span>`;
    if (it.kind === 'snip') return `<div class="item snip${it.important ? ' imp' : ''}"><span class="t">${esc(clock(it.at))}</span><div style="min-width:0"><div class="kind">Screenshot <span class="tag">${snipTag(it)}</span></div><img class="snipimg" data-id="${it.id}" alt="Screenshot"><input class="cap" data-id="${it.id}" value="${esc(it.body)}" placeholder="Caption (optional), e.g. Option B slide" maxlength="200"></div>${acts}</div>`;
    return `<div class="item note${it.important ? ' imp' : ''}"><span class="t">${esc(clock(it.at))}</span><div style="min-width:0"><div class="kind">${it.important ? '★ ' : ''}Your note</div><div class="b" data-id="${it.id}" title="Click to edit">${esc(it.body)}</div></div>${acts}</div>`;
  }).join('');
  L.querySelectorAll('img.snipimg').forEach(img => snipSrc(img.dataset.id).then(s => { if (s) img.src = s; }));
  L.querySelectorAll('.b[data-id]').forEach(b => b.onclick = () => editNote(b));
  L.querySelectorAll('.cap').forEach(c => {
    c.oninput = () => { const n = M.notes.find(x => x.id === c.dataset.id); if (n) { n.body = c.value; saveSoon(); } };
    c.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('noteIn').focus(); } };
  });
  L.querySelectorAll('[data-star]').forEach(b => b.onclick = () => { const n = M.notes.find(x => x.id === b.dataset.star); n.important = !n.important; saveSoon(); renderTimeline(); });
  L.querySelectorAll('[data-del]').forEach(b => twoTap(b, '✕?', async () => {
    const n = M.notes.find(x => x.id === b.dataset.del); M.notes = M.notes.filter(x => x !== n);
    if (n.kind === 'snip') { try { await idb.del('blobs', 'snip:' + n.id); } catch (_) {} snipCache.delete(n.id); }
    saveSoon(); renderTimeline();
  }));
  if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
}
function editNote(el) {
  if (el.isContentEditable) return;
  const n = M.notes.find(x => x.id === el.dataset.id); if (!n) return;
  el.contentEditable = 'true'; el.focus();
  const sel = getSelection(); sel.selectAllChildren(el); sel.collapseToEnd();
  const fin = save => { el.contentEditable = 'false'; const v = el.innerText.replace(/\n+$/, ''); if (save && v.trim() && v !== n.body) { n.body = v; saveSoon(); } else el.textContent = n.body; };
  el.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); } if (e.key === 'Escape') { el.onblur = null; fin(false); } };
  el.onblur = () => fin(true);
}

/* notes */
let important = false;
function addNote(kind, body, at) {
  const n = { id: uid(), kind, body: body || '', important, at: at || Date.now() };
  M.notes.push(n);
  if (important) { important = false; $('impBtn').classList.remove('on'); }
  saveSoon(); renderTimeline(); window.scrollTo(0, document.body.scrollHeight);
  return n;
}
function submitNote() { const v = $('noteIn').value.trim(); if (!v || !M) return; addNote('note', v); $('noteIn').value = ''; grow(); }
const grow = () => { const t = $('noteIn'); t.style.height = 'auto'; t.style.height = Math.min(220, t.scrollHeight) + 'px'; };
$('noteIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitNote(); } });
$('noteIn').addEventListener('input', grow);
$('addBtn').onclick = () => { submitNote(); $('noteIn').focus(); };
$('impBtn').onclick = () => { important = !important; $('impBtn').classList.toggle('on', important); $('noteIn').focus(); };

/* screenshots */
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That image could not be read')); i.src = src; }); }
function canvasToJpeg(drawable, w, h) {
  const s = Math.min(1, 1920 / Math.max(w, h)); const c = document.createElement('canvas');
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(drawable, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}
async function addSnipData(data, at) {
  const n = addNote('snip', '', at);
  await idb.put('blobs', { id: 'snip:' + n.id, meetingId: M.id, kind: 'snip', data });
  snipCache.set(n.id, data); renderTimeline();
  setTimeout(() => { const c = document.querySelector(`.cap[data-id="${n.id}"]`); if (c) c.focus(); }, 60);
  toast('Screenshot added. Type a caption, or keep going.');
}
async function addSnipBlob(blob) { const u = URL.createObjectURL(blob); try { const im = await loadImg(u); await addSnipData(canvasToJpeg(im, im.naturalWidth, im.naturalHeight)); } catch (e) { toast(e.message); } finally { URL.revokeObjectURL(u); } }
async function snipSrc(id) {
  if (snipCache.has(id)) return snipCache.get(id);
  const r = await idb.get('blobs', 'snip:' + id); if (r) snipCache.set(id, r.data); return r?.data || null;
}
/* Screenshot of the shared screen: freeze the frame, then let you drag a box around the part you want */
$('shotBtn').onclick = async () => {
  const v = $('shareVid');
  if (!REC.active || !REC.video || !v.videoWidth) return toast('Screenshots from the shared screen work while recording. You can also paste one with Ctrl+V.', 4000);
  const at = Date.now();
  const frame = document.createElement('canvas'); frame.width = v.videoWidth; frame.height = v.videoHeight;
  frame.getContext('2d').drawImage(v, 0, 0);
  const r = await pickArea(frame);
  if (!r) return;
  const out = document.createElement('canvas'); out.width = r.w; out.height = r.h;
  out.getContext('2d').drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  await addSnipData(canvasToJpeg(out, r.w, r.h), at);
};
const AREA_KEY = 'mn.lastArea';
function pickArea(frame) {
  return new Promise(resolve => {
    const ov = $('cropOv'), cv = $('cropCv'), box = $('cropBox');
    const W = frame.width, H = frame.height;
    const maxW = window.innerWidth - 40, maxH = window.innerHeight - 130;
    const k = Math.min(maxW / W, maxH / H, 1);
    cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    cv.getContext('2d').drawImage(frame, 0, 0, cv.width, cv.height);
    let sel = null;
    try { const a = JSON.parse(localStorage.getItem(AREA_KEY) || 'null'); if (a && a.w > 0.02 && a.h > 0.02) sel = a; } catch (_) {}
    const draw = () => {
      box.hidden = !sel;
      $('cropUse').disabled = !sel; $('cropUse').textContent = 'Use last area';
      if (sel) Object.assign(box.style, { left: sel.x * cv.width + 'px', top: sel.y * cv.height + 'px', width: sel.w * cv.width + 'px', height: sel.h * cv.height + 'px' });
      $('cropHint').textContent = sel ? 'Drag a box around what you want — or press Enter to reuse the last area.' : 'Drag a box around what you want to capture.';
    };
    let start = null;
    const pt = e => { const b = cv.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)), y: Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)) }; };
    const down = e => { if (e.button !== 0) return; e.preventDefault(); start = pt(e); sel = { x: start.x, y: start.y, w: 0, h: 0 }; draw(); };
    const move = e => { if (!start) return; const p = pt(e); sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) }; draw(); };
    const up = () => { if (!start) return; start = null; if (sel && (sel.w < 0.01 || sel.h < 0.01)) { sel = null; draw(); return; } useSel(); };  // releasing the drag takes the screenshot
    const finish = res => {
      ov.hidden = true; cv.onpointerdown = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.removeEventListener('keydown', key, true);
      resolve(res);
    };
    const useSel = () => {
      if (!sel) return;
      try { localStorage.setItem(AREA_KEY, JSON.stringify(sel)); } catch (_) {}
      const x = Math.round(sel.x * W), y = Math.round(sel.y * H);
      finish({ x, y, w: Math.max(1, Math.min(W - x, Math.round(sel.w * W))), h: Math.max(1, Math.min(H - y, Math.round(sel.h * H))) });
    };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); finish(null); } else if (e.key === 'Enter') { e.preventDefault(); useSel(); } };
    cv.onpointerdown = down; box.onpointerdown = down;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    document.addEventListener('keydown', key, true);
    $('cropUse').onclick = useSel;
    $('cropAll').onclick = () => finish({ x: 0, y: 0, w: W, h: H });
    $('cropCancel').onclick = () => finish(null);
    box.ondblclick = useSel;
    ov.hidden = false; draw();
  });
}
$('imgBtn').onclick = () => $('imgFile').click();
$('imgFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) addSnipBlob(f); };
document.addEventListener('paste', e => {
  if (!M || $('vMeet').hidden || e.target === $('finalIn')) return;
  const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (it) { e.preventDefault(); addSnipBlob(it.getAsFile()); }
});

/* ---------------- recording ---------------- */
const REC = { active: false, paused: false, recorder: null, display: null, mic: null, ctx: null, video: null, seq: 0, activeMs: 0, lastResume: 0, timer: null, meters: null };
function renderRecPanel() {
  const live = REC.active;
  $('recIdle').hidden = live; $('recLive').hidden = !live;
  $('recBtn').textContent = M?.rec?.ended ? '● Record more' : '● Start recording';
  $('pauseBtn').textContent = REC.paused ? 'Resume' : 'Pause';
  $('recChip').hidden = !live; $('recDot').className = 'recdot ' + (REC.paused ? 'paused' : live ? 'on' : '');
  $('recInfo').textContent = !live && M?.rec?.duration ? `Recorded ${dur(M.rec.duration)}.` : '';
  if (!live) $('noCallAudio').hidden = true;
  renderSteps();
}
function recSeconds() { return (REC.activeMs + (REC.active && !REC.paused ? Date.now() - REC.lastResume : 0)) / 1000; }
async function startRecording() {
  if (!navigator.mediaDevices?.getDisplayMedia) return toast('This browser can\'t record calls. Use Chrome or Edge on a computer.', 5000);
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' });
  } catch (e) { return toast('Recording didn\'t start: nothing was shared.'); }
  if (TX.running) { await txStop(false); toast('Background transcription paused while you record. It picks up again when you stop.', 4000); }
  let mic = null;
  if ($('useMic').checked) { try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (_) { toast('Microphone not available. Recording call audio only.', 4000); } }
  const callTracks = display.getAudioTracks();
  if (!callTracks.length && !mic) { display.getTracks().forEach(t => t.stop()); return toast('No audio to record. Share a tab with “Share tab audio”, or the entire screen with “Share system audio”.', 6000); }
  const ctx = new AudioContext(); const dest = ctx.createMediaStreamDestination();
  const meters = {};
  const hook = (stream, key) => { const src = ctx.createMediaStreamSource(stream); src.connect(dest); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an); meters[key] = an; };
  if (callTracks.length) hook(new MediaStream(callTracks), 'call');
  if (mic) hook(mic, 'mic');
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(dest.stream, { mimeType: mime || undefined, audioBitsPerSecond: 32000 });
  // continuing an earlier recording keeps its audio and adds to it
  const prev = M.rec?.ended ? M.rec : null;
  const audioAt = prev ? prev.duration : 0;
  M.rec = prev ? { ...prev, ended: false, segs: [...prev.segs, { clock: Date.now(), audioAt }] }
               : { start: Date.now(), segs: [{ clock: Date.now(), audioAt: 0 }], duration: 0, mime: recorder.mimeType || mime, chunks: 0, ended: false };
  if (prev && M.tx) M.tx.stale = true;
  Object.assign(REC, { active: true, paused: false, recorder, display, mic, ctx, meters, seq: M.rec.chunks || 0, activeMs: audioAt * 1000, lastResume: Date.now() });
  recorder.ondataavailable = async e => {
    if (!e.data || !e.data.size) return;
    const seq = REC.seq++;
    try { await idb.put('blobs', { id: `chunk:${M.id}:${String(seq).padStart(6, '0')}`, meetingId: M.id, kind: 'chunk', seq, blob: e.data }); M.rec.chunks = REC.seq; M.rec.duration = recSeconds(); saveSoon(); }
    catch (err) { toast('Could not save audio: ' + (err.message || err), 5000); }
  };
  recorder.onstop = () => finishRecording();
  recorder.start(5000);
  const vt = display.getVideoTracks()[0];
  if (vt) { const v = $('shareVid'); v.srcObject = new MediaStream([vt]); v.play().catch(() => {}); REC.video = vt; vt.onended = () => { if (REC.active) stopRecording(); }; }
  callTracks.forEach(t => t.onended = () => { if (REC.active && !display.getVideoTracks().some(v => v.readyState === 'live')) stopRecording(); });
  $('noCallAudio').hidden = !!callTracks.length;
  REC.timer = setInterval(tickRec, 200);
  saveSoon(); renderRecPanel();
  toast(callTracks.length ? 'Recording. Call audio and your mic are being captured.' : 'Recording your mic only — no call audio.', 4000);
}
function tickRec() {
  $('recTime').textContent = dur(recSeconds());
  const level = an => { if (!an) return 0; const a = new Uint8Array(an.fftSize); an.getByteTimeDomainData(a); let m = 0; for (const x of a) m = Math.max(m, Math.abs(x - 128)); return Math.min(100, m / 1.28 * 1.6); };
  $('mCall').style.width = level(REC.meters?.call) + '%'; $('mMic').style.width = level(REC.meters?.mic) + '%';
}
function stopRecording() {
  if (!REC.active) return;
  if (!REC.paused) REC.activeMs += Date.now() - REC.lastResume;
  REC.paused = false; REC.active = false;
  REC.stopped = new Promise(r => { REC._stopRes = r; setTimeout(r, 8000); });
  try { REC.recorder.state !== 'inactive' && REC.recorder.stop(); } catch (_) { finishRecording(); }
}
async function finishRecording() {
  clearInterval(REC.timer);
  [REC.display, REC.mic].forEach(s => s && s.getTracks().forEach(t => t.stop()));
  try { await REC.ctx?.close(); } catch (_) {}
  $('shareVid').srcObject = null; REC.video = null;
  if (M?.rec) { M.rec.duration = REC.activeMs / 1000; M.rec.ended = true; M.rec.chunks = REC.seq; }
  await saveNow(); renderRecPanel(); REC._stopRes?.();
  toast('Recording saved. Transcribing it in the background.', 3500);
  setTimeout(txQueue, 300);
}
$('recBtn').onclick = startRecording;
$('stopBtn').onclick = stopRecording;
$('pauseBtn').onclick = () => {
  if (!REC.active) return;
  if (REC.paused) { REC.recorder.resume(); REC.paused = false; REC.lastResume = Date.now(); M.rec.segs.push({ clock: Date.now(), audioAt: REC.activeMs / 1000 }); saveSoon(); }
  else { REC.recorder.pause(); REC.paused = true; REC.activeMs += Date.now() - REC.lastResume; }
  renderRecPanel();
};
window.addEventListener('beforeunload', e => { if (REC.active || TX.running) { e.preventDefault(); e.returnValue = ''; } });

async function recordingBlob(mt = M) {
  const chunks = (await idb.byMeeting(mt.id)).filter(b => b.kind === 'chunk').sort((a, b) => a.seq - b.seq);
  if (!chunks.length) return null;
  return new Blob(chunks.map(c => c.blob), { type: (mt.rec?.mime || 'audio/webm').split(';')[0] });
}

/* ---------------- transcription ----------------
   Runs on its own: when a recording stops, and when the app opens, any meeting with an
   untranscribed recording is transcribed in the background (oldest first). It waits while
   you're recording, so it never competes with a live call. */
const TX = { running: false, worker: null, job: null, msg: '', pct: 0, failed: new Set() };
const txModel = () => { try { return localStorage.getItem('mn.model') || $('model').value; } catch (_) { return $('model').value; } };
$('model').onchange = () => { try { localStorage.setItem('mn.model', $('model').value); } catch (_) {} };
function renderTxPanel() {
  const t = M?.tx, mine = TX.job && M && TX.job.id === M.id;
  $('model').value = t?.model || txModel();
  $('txBtn').textContent = t?.done ? 'Transcribe again' : t?.segments?.length ? 'Continue transcribing' : 'Transcribe recording';
  let info = '';
  if (t?.done) info = `Transcript: ${t.segments.length} lines${t.source === 'file' ? ` from ${t.fileName}` : ''}${t.device ? ` · ${t.device === 'webgpu' ? 'graphics card' : 'processor'}` : ''}.`;
  if (t?.stale) info += ' The recording has new audio since this transcript.';
  if (!M?.rec?.ended && !t) info = 'Starts on its own when you stop recording. You can also transcribe an audio file, such as a Teams or Zoom recording.';
  if (TX.running && !mine) info = `Transcribing “${TX.job.mt.title}” in the background.${M?.rec?.ended && !t?.done ? ' This meeting is up next.' : ''}`;
  if (t?.userPaused && !t.done && !mine) info = 'Transcription paused. Click Continue transcribing to pick it up.';
  $('txInfo').textContent = info;
  $('txProg').hidden = !mine; if (mine) { $('txBar').style.width = TX.pct + '%'; $('txMsg').textContent = TX.msg; }
  renderSteps();
}
function txStatus(msg, pct) {
  TX.msg = msg; if (pct != null) TX.pct = pct;
  if (TX.job && M && M.id === TX.job.id) { $('txMsg').textContent = msg; $('txBar').style.width = TX.pct + '%'; }
  const pill = document.querySelector(`.pill[data-id="${TX.job?.id}"]`); if (pill) pill.textContent = `Transcribing ${Math.round(TX.pct)}%`;
}
async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await ctx.decodeAudioData(buf); } finally { ctx.close().catch(() => {}); }
  const len = Math.ceil(decoded.duration * 16000);
  const off = new OfflineAudioContext(1, len, 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}
function makeWorker() {
  if (window.MN_FAKE_ASR) return window.MN_FAKE_ASR();   // used by automated tests only
  return new Worker('whisper-worker.js', { type: 'module' });
}
async function transcribe(source = {}, id = M?.id) {
  if (TX.running || !id) return;
  const mt = M && M.id === id ? M : await idb.get('meetings', id); if (!mt) return;
  const here = () => M && M.id === id;
  const save = async () => { if (here()) return saveNow(); mt.updatedAt = Date.now(); try { await idb.put('meetings', JSON.parse(JSON.stringify(mt))); } catch (_) {} };
  TX.running = true; TX.job = { id, mt }; TX.pct = 0; TX.msg = 'Reading the audio…';
  let txFin; TX.finished = new Promise(r => { txFin = r; });
  if (here()) renderTxPanel();
  try {
    let blob = source.blob;
    if (!blob) { blob = await recordingBlob(mt); if (!blob) throw new Error('There is no recording yet.'); }
    const audio = await decodeTo16k(blob);
    const model = source.file ? $('model').value : (mt.tx?.model && !mt.tx.done ? mt.tx.model : (here() ? $('model').value : txModel()));
    const resume = !source.file && mt.tx && !mt.tx.done && mt.tx.model === model && mt.tx.source === 'recording' && mt.tx.upTo > 0 && !mt.tx.stale;
    if (!resume) mt.tx = { model, segments: [], upTo: 0, done: false, source: source.file ? 'file' : 'recording', fileName: source.file || '', base: source.file ? { start: mt.rec?.start || mt.createdAt, segs: [{ clock: mt.rec?.start || mt.createdAt, audioAt: 0 }] } : null };
    else mt.tx.segments = mt.tx.segments.filter(s => s.start < mt.tx.upTo);
    delete mt.tx.userPaused;
    await save();
    const totalSec = audio.length / 16000, started = Date.now(), startAt = resume ? mt.tx.upTo : 0;
    txStatus('Loading the speech model… (the first time, this downloads it)', 0);
    const w = TX.worker = makeWorker();
    await new Promise((resolve, reject) => {
      const files = {};
      w.onmessage = ev => {
        const m = ev.data;
        if (m.type === 'download') {
          files[m.file] = [m.loaded, m.total]; const l = Object.values(files).reduce((a, x) => a + (x[0] || 0), 0), tt = Object.values(files).reduce((a, x) => a + (x[1] || 0), 0);
          txStatus(`Downloading the speech model (one time): ${Math.round(l / 1048576)} of ${Math.round(tt / 1048576) || '…'} MB`, tt ? Math.round(l / tt * 100) : 0);
        } else if (m.type === 'note') toast(m.message, 4000);
        else if (m.type === 'ready') { mt.tx.device = m.device; txStatus(`Transcribing ${dur(totalSec)} of audio…`, startAt / totalSec * 100); }
        else if (m.type === 'progress') {
          mt.tx.segments.push(...m.segments); mt.tx.upTo = m.upTo; save(); if (here()) renderTimeline();
          const el = (Date.now() - started) / 1000, worked = m.upTo - startAt;
          const left = worked > 0 ? el / worked * (totalSec - m.upTo) : 0;
          txStatus(`Transcribed ${dur(m.upTo)} of ${dur(totalSec)}${left > 5 ? ` · about ${dur(left)} left` : ''}`, m.upTo / totalSec * 100);
        } else if (m.type === 'done') resolve();
        else if (m.type === 'error') reject(new Error(m.message));
      };
      w.onerror = e => reject(new Error(e.message || 'The speech model could not start. Check your internet connection and try again.'));
      TX.reject = reject;
      const pcm = new Float32Array(audio);   // own copy so it can be handed to the worker
      w.postMessage({ type: 'transcribe', model, audio: pcm, startAt, windowSec: 120, preferGpu: true }, [pcm.buffer]);
    });
    mt.tx.done = true; mt.tx.stale = false; await save();
    toast(`Transcript ready for “${mt.title}”: ${mt.tx.segments.length} lines.`, 4000);
  } catch (e) {
    if (e.message === 'cancelled') { if (TX.userCancel && mt.tx) mt.tx.userPaused = true; }
    else { TX.failed.add(id); toast(`Transcription of “${mt.title}” stopped: ${e.message}`, 6000); }
    await save();
  } finally {
    try { TX.worker?.terminate(); } catch (_) {}
    TX.worker = null; TX.running = false; TX.job = null; TX.reject = null; TX.userCancel = false;
    if (here()) { renderTxPanel(); renderTimeline(); }
    if (!$('vHome').hidden) renderHome();
    txFin();
  }
}
function txStop(byUser) { if (TX.reject) { TX.userCancel = !!byUser; TX.reject(new Error('cancelled')); } return TX.finished || Promise.resolve(); }
// Picks the next meeting that needs a transcript and starts it
async function txQueue() {
  if (TX.running || REC.active) return;
  const all = await idb.all('meetings');
  const next = all.filter(m => m.rec?.ended && m.rec.chunks && !TX.failed.has(m.id) && !m.tx?.userPaused &&
      (!m.tx || m.tx.stale || (!m.tx.done && m.tx.source !== 'file'))).sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return;
  await transcribe({}, next.id);
  setTimeout(txQueue, 300);
}
$('txBtn').onclick = () => { if (M?.tx) delete M.tx.userPaused; TX.failed.delete(M.id); transcribe({}); };
$('txFileBtn').onclick = () => $('txFile').click();
$('txFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) transcribe({ blob: f, file: f.name }); };
$('txCancel').onclick = () => { txStop(true); toast('Transcription paused. Click Continue transcribing to pick up where it left off.', 4000); };

/* ---------------- Claude handoff ---------------- */
function claudeText() {
  const items = timelineItems({ tx: true, notes: true });
  const hasTx = items.some(i => i.kind === 'tx');
  const lines = items.map(it => {
    const t = `[${clock(it.at)}]`;
    if (it.kind === 'tx') return `${t} TRANSCRIPT: ${it.text}`;
    if (it.kind === 'snip') return `${t} SCREENSHOT [${snipTag(it)}]${it.body ? ` — "${it.body}"` : ''}${it.important ? ' ★' : ''}`;
    return `${t} MY NOTE: ${it.important ? '★ ' : ''}${it.body.replace(/\n/g, ' / ')}`;
  });
  const start = M.rec?.start || M.createdAt, end = M.rec?.start ? audioToClock(M.rec.duration || 0, M.rec) : Date.now();
  return `Please turn this meeting record into clean, well-organized meeting notes.

Meeting: ${M.title}
Date: ${day(start)}, ${hm(start)}–${hm(end)}

What's below, in time order:
- TRANSCRIPT lines: ${hasTx ? 'an automatic speech-to-text transcript of the call. It has no speaker names and may contain recognition errors.' : '(no transcript was made)'}
- MY NOTE lines: notes I typed during the meeting. ★ marks things I flagged as important.
- SCREENSHOT lines: screenshots I took, each with a tag like [IMG-4F2A] and sometimes a caption.

Write the notes in Markdown with these sections:${M.notes.some(n => n.important) ? `
## Flagged as important (one bullet for each ★ item, in my words, with any helpful context from the transcript)` : ''}
## Summary (3–5 sentences)
## Decisions
## Action items (Owner — task — due date, when stated)
## Open questions
## Timeline (the meeting split into segments by topic, in time order. Start each segment with a heading like "### 10:02 AM – 10:09 AM · Budget review", using clock times from the record, followed by concise bullet points of what was discussed)

Rules:
- Use only what's in the record. Don't invent details. Fix obvious speech-recognition mistakes only when the meaning is clear; otherwise keep the wording and mark it with (?).
- Name speakers only when the transcript or my notes make it clear who said something.
- Every ★ item must appear in the "Flagged as important" section, and its point should also be reflected in the relevant section below.
- Don't copy MY NOTE lines into the Timeline; the app adds them there word for word. Use them to inform the other sections.
- Put each screenshot tag on its own line right after the point it relates to, use every tag exactly once, and copy the tags exactly.
- Reply with the Markdown notes only, no introduction.

--- MEETING RECORD ---
${lines.join('\n')}
`;
}
$('copyClaude').onclick = async () => {
  if (!M.notes.length && !M.tx?.segments?.length) return toast('Nothing to copy yet. Record and transcribe, or add some notes.');
  if (!M.tx?.segments?.length) toast('No transcript yet — copying your notes and screenshots only.', 3500);
  await copyText(claudeText(), 'Copied. Paste it into Claude, then paste Claude\'s reply in step 4.');
  $('st3').classList.add('done');
};

/* ---------------- final notes ---------------- */
$('saveFinal').onclick = async () => {
  const md = $('finalIn').value.trim(); if (!md) return toast('Paste Claude\'s reply first.');
  M.finalMd = md; M.finalAt = Date.now(); await saveNow(); renderFinal(); renderSteps(); setTab('final'); toast('Final notes saved.');
};
// Selecting Claude's reply and pressing Ctrl+C copies formatted HTML; turn it back into markdown
function htmlToMd(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,button,svg').forEach(e => e.remove());
  const inl = n => {
    if (n.nodeType === 3) return n.nodeValue.replace(/\s+/g, ' ');
    if (n.nodeType !== 1) return '';
    const tg = n.tagName, c = [...n.childNodes].map(inl).join('');
    if (tg === 'BR') return '\n';
    if (!c.trim()) return c;
    const pad = s => (/^\s/.test(c) ? ' ' : '') + s + (/\s$/.test(c) ? ' ' : '');
    if (tg === 'STRONG' || tg === 'B') return pad(`**${c.trim()}**`);
    if (tg === 'EM' || tg === 'I') return pad(`*${c.trim()}*`);
    if (tg === 'CODE') return '`' + c + '`';
    return c;
  };
  const out = [];
  const list = (el, depth) => {
    let i = 1;
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const own = [...li.childNodes].filter(x => !(x.nodeType === 1 && /^(UL|OL)$/.test(x.tagName)));
      const txt = own.map(x => x.nodeType === 1 && x.tagName === 'P' ? inl(x) + ' ' : inl(x)).join('').replace(/\s+/g, ' ').trim();
      out.push('  '.repeat(depth) + (el.tagName === 'OL' ? `${i++}. ` : '- ') + txt);
      li.querySelectorAll(':scope > ul, :scope > ol').forEach(s => list(s, depth + 1));
    }
  };
  const block = el => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { if (n.nodeValue.trim()) out.push(n.nodeValue.trim(), ''); continue; }
      if (n.nodeType !== 1) continue;
      const tg = n.tagName;
      if (/^H[1-6]$/.test(tg)) out.push('', '#'.repeat(Math.min(3, +tg[1])) + ' ' + inl(n).trim(), '');
      else if (tg === 'UL' || tg === 'OL') { list(n, 0); out.push(''); }
      else if (tg === 'TABLE') {
        const rows = [...n.querySelectorAll('tr')].map(r => [...r.children].map(c => inl(c).trim().replace(/\|/g, '/')));
        rows.forEach((r, k) => { out.push('| ' + r.join(' | ') + ' |'); if (k === 0) out.push('|' + r.map(() => '---').join('|') + '|'); });
        out.push('');
      } else if (tg === 'HR') out.push('', '---', '');
      else if (tg === 'P' || tg === 'BLOCKQUOTE' || tg === 'PRE') out.push(...inl(n).trim().split('\n').map(s => s.trim()), '');
      else if (n.querySelector('p,h1,h2,h3,h4,ul,ol,table,div')) block(n);
      else { const t = inl(n).trim(); if (t) out.push(t, ''); }
    }
  };
  block(doc.body);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
$('finalIn').addEventListener('paste', e => {
  const html = e.clipboardData?.getData('text/html');
  if (!html || !/<(h[1-6]|li|p|table|strong|b)\b/i.test(html)) return;   // plain text or markdown: paste as-is
  const md = htmlToMd(html); if (!md) return;
  e.preventDefault();
  const ta = e.target, a = ta.selectionStart, b = ta.selectionEnd;
  ta.value = ta.value.slice(0, a) + md + ta.value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + md.length;
});
const snipByTag = tag => M.notes.find(n => n.kind === 'snip' && snipTag(n) === tag);
const TAG_RE = /\[(IMG-[0-9A-F]{4})\]/g;
const MINE_RE = /\s*[\[(](?:MY )?NOTE[\])]/gi;
function parseInline(s) {
  s = s.replace(MINE_RE, '');
  const runs = []; const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`)/g; let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith('**') || t.startsWith('__')) runs.push({ text: t.slice(2, -2), bold: true });
    else if (t.startsWith('`')) runs.push({ text: t.slice(1, -1), code: true });
    else runs.push({ text: t.slice(1, -1), italic: true });
    last = m.index + t.length;
  }
  if (last < s.length) runs.push({ text: s.slice(last) });
  return runs;
}
function parseMd(md) {
  const out = []; let list = null, para = null, table = null;
  const flush = () => { if (para) { out.push({ t: 'p', runs: parseInline(para.join(' ')) }); para = null; } if (list) { out.push(list); list = null; } if (table) { out.push(table); table = null; } };
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const tags = [...raw.matchAll(TAG_RE)].map(m => m[1]);
    const line = raw.replace(TAG_RE, '').replace(/\s+$/, ''); const tr = line.trim();
    if (/^\|.*\|$/.test(tr)) {
      if (para || list) { const t = table; table = null; flush(); table = t; }
      const cells = tr.slice(1, -1).split('|').map(c => c.trim());
      if (!cells.every(c => /^:?-{2,}:?$/.test(c))) { table = table || { t: 'table', rows: [] }; table.rows.push(cells.map(parseInline)); }
    } else if (!tr) flush();
    else if (/^#{1,6}\s/.test(tr)) { flush(); out.push({ t: 'h', level: Math.min(3, tr.match(/^#+/)[0].length), runs: parseInline(tr.replace(/^#+\s*/, '')) }); }
    else if (/^(-{3,}|\*{3,}|_{3,})$/.test(tr)) { flush(); out.push({ t: 'hr' }); }
    else if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      if (para || table) { const l = list; list = null; flush(); list = l; }
      list = list || { t: 'list', ordered: /^\s*\d+[.)]/.test(line), items: [] };
      list.items.push({ level: Math.min(2, Math.floor(line.match(/^\s*/)[0].length / 2)), runs: parseInline(line.replace(/^\s*([-*+]|\d+[.)])\s+/, '')) });
    } else { flush(); para = [tr]; }   // each line is its own paragraph, so plain-text pastes keep their shape
    if (tags.length) { flush(); tags.forEach(tag => out.push({ t: 'img', tag })); }
  }
  flush(); return out;
}
const FLAG_HEAD = 'Flagged as important';
// Reads a clock time like "10:02 AM" from a heading and returns it as a time on the meeting's day
function headTime(text) {
  const m = text.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?\.?/); if (!m) return null;
  const base = M.rec?.start || M.createdAt, d = new Date(base); let h = +m[1];
  if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  d.setHours(h, +m[2], 0, 0); let t = d.getTime();
  if (!m[3] && t < base - 6 * 3600e3) t += 12 * 3600e3;   // "2:15" in an afternoon meeting
  return t;
}
// Puts each typed note, word for word, at the end of the timeline segment it was taken in
function placeMyNotes(blocks) {
  const mine = M.notes.filter(n => n.kind !== 'snip' && n.body?.trim()).sort((a, b) => a.at - b.at);
  if (!mine.length) return;
  const segs = [];
  blocks.forEach((b, i) => { if (b.t === 'h' && b.level >= 3) { const t = headTime(b.runs.map(r => r.text).join('')); if (t != null) segs.push({ i, t, level: b.level }); } });
  const mk = n => ({ t: 'mynote', at: n.at, text: n.body, important: !!n.important });
  if (!segs.length) {   // reply has no timeline: list the notes as typed at the end
    blocks.push({ t: 'h', level: 2, runs: [{ text: 'My notes (as typed)' }] }, ...mine.map(mk)); return;
  }
  const groups = segs.map(() => []);
  for (const n of mine) {
    const minute = Math.floor(n.at / 60000) * 60000;
    let k = 0; segs.forEach((sg, j) => { if (sg.t <= minute) k = j; });
    groups[k].push(mk(n));
  }
  for (let j = segs.length - 1; j >= 0; j--) {
    if (!groups[j].length) continue;
    let end = segs[j].i + 1;
    while (end < blocks.length && !(blocks[end].t === 'h' && blocks[end].level <= segs[j].level)) end++;
    blocks.splice(end, 0, ...groups[j]);
  }
}
function finalBlocks() {
  const blocks = parseMd(M.finalMd || '');
  // Starred notes always appear in the final notes, even if Claude's reply left them out
  const flagged = M.notes.filter(n => n.important).sort((a, b) => a.at - b.at);
  const hasFlagSection = blocks.some(b => b.t === 'h' && /flag|important|★/i.test(b.runs.map(r => r.text).join('')));
  blocks.forEach((b, i) => { if (b.t === 'h' && /flag/i.test(b.runs.map(r => r.text).join('')) && blocks[i + 1]?.t === 'list') blocks[i + 1].flagged = true; });
  if (flagged.length && !hasFlagSection) {
    blocks.unshift({ t: 'h', level: 2, runs: [{ text: FLAG_HEAD }] }, { t: 'list', ordered: false, flagged: true,
      items: flagged.map(n => ({ level: 0, runs: [{ text: n.kind === 'snip' ? `Screenshot${n.body ? ': ' + n.body : ''}` : n.body.replace(/\n+/g, ' ') }, { text: `  (${hm(n.at)})`, italic: true }] })) });
  }
  placeMyNotes(blocks);
  const used = new Set(blocks.filter(b => b.t === 'img').map(b => b.tag));
  const extra = M.notes.filter(n => n.kind === 'snip' && !used.has(snipTag(n))).sort((a, b) => a.at - b.at);
  if (extra.length) { blocks.push({ t: 'h', level: 2, runs: [{ text: 'Other screenshots' }] }); extra.forEach(n => blocks.push({ t: 'img', tag: snipTag(n) })); }
  return blocks;
}
const runsHtml = runs => runs.map(r => { let h = esc(r.text); if (r.code) h = `<code>${h}</code>`; if (r.bold) h = `<strong>${h}</strong>`; if (r.italic) h = `<em>${h}</em>`; return h; }).join('');
function metaLine() { const s = M.rec?.start || M.createdAt, e = M.rec?.start ? audioToClock(M.rec.duration || 0, M.rec) : s; return `${day(s)} · ${hm(s)}–${hm(e)}${M.rec?.duration ? ` · ${dur(M.rec.duration)} recorded` : ''}`; }
function renderFinal() {
  const md = M.finalMd || '';
  $('finalEmpty').hidden = !!md; $('finalDoc').hidden = !md;
  if (!md) return;
  const fb = finalBlocks();
  $('finalDoc').innerHTML = `<h1>${esc(M.title)}</h1><div class="dmeta">${esc(metaLine())}</div>` + fb.map(b => {
    if (b.t === 'mynote') return `<div class="mynote"><span class="mnl">${b.important ? '★ ' : ''}My note · ${esc(hm(b.at))}</span>${esc(b.text).replace(/\n/g, '<br>')}</div>`;
    if (b.t === 'h') { const h = b.level <= 2 ? 2 : 3; return `<h${h}>${runsHtml(b.runs)}</h${h}>`; }
    if (b.t === 'p') return `<p>${runsHtml(b.runs)}</p>`;
    if (b.t === 'hr') return '<hr>';
    if (b.t === 'list') { const tg = b.ordered ? 'ol' : 'ul'; return `<${tg}${b.flagged ? ' class="flagged"' : ''}>` + b.items.map(i => `<li style="margin-left:${i.level * 18}px">${runsHtml(i.runs)}</li>`).join('') + `</${tg}>`; }
    if (b.t === 'table') return `<div class="tablewrap"><table>${b.rows.map((r, i) => `<tr>${r.map(c => i ? `<td>${runsHtml(c)}</td>` : `<th>${runsHtml(c)}</th>`).join('')}</tr>`).join('')}</table></div>`;
    if (b.t === 'img') { const n = snipByTag(b.tag); return n ? `<span class="fig"><img data-id="${n.id}" alt="${esc(n.body || 'Screenshot')}"><small>${esc(n.body ? n.body + ' · ' : '')}${esc(clock(n.at))}</small></span>` : `<p class="sub">[${esc(b.tag)}: screenshot not found]</p>`; }
    return '';
  }).join('');
  $('finalDoc').querySelectorAll('img[data-id]').forEach(img => snipSrc(img.dataset.id).then(s => { if (s) img.src = s; }));
}

/* ---------------- downloads ---------------- */
/* PDF: print a clean, letter-size copy of the final notes (not the whole app screen) */
async function printHtml() {
  const doc = $('finalDoc').cloneNode(true);
  for (const img of doc.querySelectorAll('img[data-id]')) img.src = (await snipSrc(img.dataset.id)) || '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(M.title)}</title><style>
@page{size:letter;margin:0.7in}
body{margin:0;color:#14181b;font-family:"Segoe UI",Calibri,Arial,sans-serif;font-size:11.5pt;line-height:1.45}
h1{font-size:20pt;margin:0 0 4pt}
.dmeta{color:#5a6064;font-size:10pt;border-bottom:3pt solid #c6f432;padding-bottom:6pt;margin-bottom:12pt}
h2{font-size:14.5pt;margin:16pt 0 6pt;border-bottom:1px solid #d5dad8;padding-bottom:3pt;break-after:avoid}
h3{font-size:12.5pt;margin:12pt 0 4pt;break-after:avoid}
p,li{font-size:11.5pt} ul,ol{padding-left:18pt;margin:4pt 0} li{margin:2pt 0}
table{border-collapse:collapse;width:100%;margin:8pt 0;font-size:10.5pt;break-inside:auto}
th,td{border:1px solid #c9cfcc;padding:4pt 6pt;text-align:left;vertical-align:top}
th{background:#14181b;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
code{font-family:Consolas,monospace;font-size:10pt}
.fig{display:block;margin:8pt 0 12pt;break-inside:avoid}
.fig img{display:block;max-width:100%;max-height:6.2in;border:1px solid #c9cfcc}
.fig small{display:block;color:#5a6064;font-size:9.5pt;margin-top:3pt}
.flagged{border-left:4pt solid #b7791f;background:#fbf5e6;padding:6pt 10pt 6pt 24pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
hr{border:0;border-top:1px solid #d5dad8;margin:12pt 0}
.mynote{border-left:3pt solid #1f5f99;background:#eef4fb;padding:4pt 8pt;margin:4pt 0 8pt 12pt;break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.mnl{display:block;font-size:9pt;font-weight:700;color:#1f5f99}
</style></head><body>${doc.innerHTML}</body></html>`;
}
$('dlPdf').onclick = async () => {
  const html = await printHtml();
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(f);
  f.onload = () => {
    const imgs = [...f.contentDocument.images];
    Promise.all(imgs.map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))).then(() => {
      toast('Choose “Save as PDF” as the printer.', 3500);
      f.contentWindow.focus(); f.contentWindow.print();
      setTimeout(() => f.remove(), 60000);
    });
  };
  f.srcdoc = html;
};
$('dlTx').onclick = () => {
  const lines = txBlocks().map(b => `[${clock(b.at)}] ${b.text}`);
  download(new Blob([`${M.title}\n${metaLine()}\nAutomatic transcript (no speaker names; may contain errors)\n\n${lines.join('\n\n')}\n`], { type: 'text/plain' }), `${safeName(M.title)}-transcript.txt`);
};
$('dlAudio').onclick = async () => { const b = await recordingBlob(); if (!b) return toast('No recording saved.'); download(b, `${safeName(M.title)}.${b.type.includes('ogg') ? 'ogg' : 'webm'}`); };
$('dlWord').onclick = async () => {
  if (!window.docx) return toast('The Word exporter is still loading. Try again in a moment.');
  $('dlWord').disabled = true;
  try { download(await buildDocx(), `${safeName(M.title)}-notes.docx`); }
  catch (e) { toast('Could not build the Word file: ' + (e.message || e)); }
  finally { $('dlWord').disabled = !M.finalMd; }
};
async function buildDocx() {
  const D = window.docx;
  const toRuns = runs => runs.map(r => new D.TextRun({ text: r.text, bold: !!r.bold, italics: !!r.italic, font: r.code ? 'Consolas' : undefined }));
  const H = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2];
  const children = [
    new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun({ text: M.title })] }),
    new D.Paragraph({ children: [new D.TextRun({ text: metaLine(), color: '5A6064', size: 20 })], spacing: { after: 200 } })
  ];
  const fb = finalBlocks();
  for (const b of fb) {
    if (b.t === 'h') children.push(new D.Paragraph({ heading: H[b.level], children: toRuns(b.runs) }));
    else if (b.t === 'mynote') children.push(new D.Paragraph({ shading: { type: D.ShadingType.CLEAR, color: 'auto', fill: 'EEF4FB' }, border: { left: { color: '1F5F99', style: D.BorderStyle.SINGLE, size: 18, space: 8 } }, indent: { left: 240 }, spacing: { before: 60, after: 120 },
      children: [new D.TextRun({ text: `${b.important ? '★ ' : ''}My note · ${hm(b.at)}`, bold: true, color: '1F5F99', size: 18, break: 0 }), ...b.text.split('\n').map((l, k) => new D.TextRun({ text: l, break: 1 }))] }));
    else if (b.t === 'p') children.push(new D.Paragraph({ children: toRuns(b.runs), spacing: { after: 120 } }));
    else if (b.t === 'hr') children.push(new D.Paragraph({ border: { bottom: { color: 'CCCCCC', style: D.BorderStyle.SINGLE, size: 6, space: 1 } }, children: [] }));
    else if (b.t === 'list') b.items.forEach(it => children.push(new D.Paragraph(b.ordered ? { children: toRuns(it.runs), numbering: { reference: 'nums', level: it.level } } : { children: toRuns(it.runs), bullet: { level: it.level } })));
    else if (b.t === 'table') {
      const cols = Math.max(...b.rows.map(r => r.length));
      children.push(new D.Table({ width: { size: 100, type: D.WidthType.PERCENTAGE }, rows: b.rows.map((r, ri) => new D.TableRow({ tableHeader: ri === 0,
        children: Array.from({ length: cols }, (_, ci) => new D.TableCell({ shading: ri === 0 ? { fill: '14181B', type: D.ShadingType.CLEAR, color: 'auto' } : undefined,
          children: [new D.Paragraph({ children: (r[ci] || [{ text: '' }]).map(x => new D.TextRun({ text: x.text, bold: ri === 0 || !!x.bold, italics: !!x.italic, color: ri === 0 ? 'FFFFFF' : undefined })) })] })) })) }));
      children.push(new D.Paragraph({ children: [] }));
    } else if (b.t === 'img') {
      const n = snipByTag(b.tag); if (!n) continue;
      const src = await snipSrc(n.id); if (!src) continue;
      const im = await loadImg(src); const w = Math.min(600, im.naturalWidth), h = Math.round(w * im.naturalHeight / im.naturalWidth);
      children.push(new D.Paragraph({ children: [new D.ImageRun({ data: await (await fetch(src)).arrayBuffer(), transformation: { width: w, height: h } })] }));
      children.push(new D.Paragraph({ children: [new D.TextRun({ text: `${n.body ? n.body + ' · ' : ''}${clock(n.at)}`, color: '5A6064', size: 18, italics: true })], spacing: { after: 200 } }));
    }
  }
  const doc = new D.Document({ creator: 'Meeting Notes', title: M.title,
    numbering: { config: [{ reference: 'nums', levels: [0, 1, 2].map(l => ({ level: l, format: D.LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: D.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } })) }] },
    sections: [{ children }] });
  return D.Packer.toBlob(doc);
}
twoTap($('delMeeting'), 'Tap again to delete for good', async () => {
  if (REC.active) return toast('Stop recording first.');
  if (TX.job?.id === M.id) await txStop(false);
  for (const k of await idb.keysByMeeting(M.id)) await idb.del('blobs', k);
  await idb.del('meetings', M.id); M = null; history.pushState(null, '', './'); renderHome(); toast('Meeting deleted.');
});

/* ---------------- leaving a meeting (back-to-back meetings) ---------------- */
async function goHome() {
  const b = $('backBtn');
  if (REC.active) {
    if (!b.classList.contains('confirm')) {
      b.classList.add('confirm'); b.textContent = 'Stop recording & leave?';
      clearTimeout(b._t); b._t = setTimeout(() => { b.classList.remove('confirm'); b.textContent = '← Meetings'; }, 4000); return;
    }
    clearTimeout(b._t); b.classList.remove('confirm'); b.textContent = '← Meetings';
    stopRecording(); await REC.stopped;
  }
  await saveNow(); M = null; history.pushState(null, '', './'); renderHome(); window.scrollTo(0, 0);
}
$('backBtn').onclick = goHome;
document.querySelector('.brand').addEventListener('click', e => { e.preventDefault(); if (M) goHome(); });
$('mlist').addEventListener('click', e => { const a = e.target.closest('a[data-id]'); if (!a || e.ctrlKey || e.metaKey) return; e.preventDefault(); history.pushState(null, '', '?m=' + a.dataset.id); openMeeting(a.dataset.id); window.scrollTo(0, 0); });

/* ---------------- start ---------------- */
function route() { const id = new URLSearchParams(location.search).get('m'); if (id) openMeeting(id); else renderHome(); }
window.addEventListener('popstate', () => {
  if (M && REC.active) { history.pushState(null, '', '?m=' + M.id); return toast('Still recording. Use ← Meetings to stop and leave.', 4000); }
  route();
});
route();
setTimeout(txQueue, 1500);   // finish any transcripts left over from last time
