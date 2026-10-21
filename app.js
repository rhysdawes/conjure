import * as db from './db.js';
import {
  AudioServices, Bridge, DEFAULT_MODEL, hasClaude, parseServerLink, DEFAULT_TTS_MODEL,
  makeClient, baseRequest, textOf, downscaleImage, readAsDataUrl,
} from './host.js';
import { buildSystemPrompt, buildCreateMessage, buildChangeMessage } from './prompts.js';
import { injectRuntime } from './runtime.js';

const VERSION = '0.3.2';
const MAX_VERSIONS = 10;
const MAX_ERRORS = 20;
const EXAMPLES = [
  'Run lines with me for an audition, from photos of the script',
  'Read a recipe photo aloud step by step while I cook',
  'Log my gym sets and tell me when to go heavier',
  'A packing list that remembers what I always forget',
];

const $ = (id) => document.getElementById(id);

let settings = {
  serverLink: '',
  anthropicKey: '',
  openaiKey: '',
  about: '',
  model: DEFAULT_MODEL,
  ttsModel: DEFAULT_TTS_MODEL,
  defaultVoice: 'coral',
};
let apps = [];
let current = null;
let build = null;
const appErrors = new Map();
const audio = new AudioServices(() => settings);

// ---------- helpers ----------

function show(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function describeError(err) {
  const status = err && err.status;
  const viaServer = Boolean(parseServerLink(settings.serverLink));
  if (status === 401) return viaServer ? 'Your Claude Code server refused the link. Paste the link into settings again.' : 'Your Anthropic API key was rejected. Check it in settings.';
  if (viaServer && err && /connection|fetch|network/i.test(err.message || '')) return `Couldn’t reach your Claude Code server. Is your Mac on, awake and online?\n(${err.message})`;
  if (status === 403) return 'This API key isn’t allowed to use that model. Check your Anthropic console.';
  if (status === 429) return 'Anthropic is rate-limiting this key (or it’s out of credit). Wait a minute, or check billing at console.anthropic.com.';
  if (status === 529 || status === 503) return 'Claude is overloaded right now. Try again in a minute.';
  if (err && /connection|fetch|network/i.test(err.message || '')) return `Couldn’t reach Anthropic. Check your connection.\n(${err.message})`;
  return (err && err.message) || String(err);
}

function firstGrapheme(text, fallback) {
  const seg = [...new Intl.Segmenter().segment(text || '')][0];
  return seg ? seg.segment : fallback;
}

function extractHtml(text) {
  const start = text.search(/<!DOCTYPE html|<html[\s>]/i);
  const end = text.toLowerCase().lastIndexOf('</html>');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Claude’s reply didn’t contain a complete app. Try again.');
  }
  return text.slice(start, end + '</html>'.length);
}

function readMeta(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('title');
  const icon = doc.querySelector('meta[name="conjure-icon"]');
  const description = doc.querySelector('meta[name="description"]');
  return {
    name: ((title && title.textContent) || 'My app').trim().slice(0, 40) || 'My app',
    icon: firstGrapheme(icon && icon.content.trim(), '✨'),
    description: (description && description.content.trim()) || '',
  };
}

async function saveIndex() {
  await db.set('apps', apps);
}

// ---------- home ----------

function tile({ icon, name, className, onClick }) {
  const b = document.createElement('button');
  b.className = `tile ${className || ''}`;
  const i = document.createElement('span');
  i.className = 'tile-icon';
  i.textContent = icon;
  const n = document.createElement('span');
  n.className = 'tile-name';
  n.textContent = name;
  b.append(i, n);
  b.addEventListener('click', onClick);
  return b;
}

function renderHome() {
  const grid = $('app-grid');
  grid.replaceChildren(tile({ icon: '+', name: 'New app', className: 'tile-new', onClick: openCompose }));
  const sorted = [...apps].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  for (const a of sorted) grid.append(tile({ icon: a.icon, name: a.name, onClick: () => openApp(a.id) }));
  $('empty-state').hidden = apps.length > 0;
  $('key-hint').hidden = hasClaude(settings);
  $('install-hint').hidden = isStandalone() || !isIOS();
}

function goHome() {
  closeApp();
  renderHome();
  show('home');
}

// ---------- compose & build ----------

function openCompose() {
  $('brief').value = '';
  $('build-btn').disabled = true;
  show('compose');
  $('brief').focus();
}

function paintProgress(text, thoughts, mode) {
  if (!text) {
    $('build-stage').textContent = 'Thinking about what you need';
    const tail = thoughts.slice(-320);
    const cut = tail.length < thoughts.length ? tail.slice(tail.search(/[.!?]\s/) + 2) : tail;
    $('build-thoughts').textContent = cut.trim();
  } else {
    $('build-title').textContent = mode === 'create' ? 'Building your app…' : 'Making the change…';
    $('build-stage').textContent = `Writing it · ${(text.length / 1000).toFixed(1)}k characters`;
  }
}

async function startBuild(job) {
  if (!hasClaude(settings)) {
    openSettings();
    toast('Add your Claude Code link first');
    return;
  }
  const run = { ...job, aborted: false, stream: null };
  build = run;
  $('building').querySelector('.building-body').classList.remove('failed');
  $('build-title').textContent = job.mode === 'create' ? 'Designing your app…' : 'Planning the change…';
  $('build-stage').textContent = 'Thinking about what you need';
  $('build-thoughts').textContent = '';
  $('build-error').hidden = true;
  $('build-retry').hidden = true;
  $('build-cancel').textContent = 'Cancel';
  show('building');
  audio.keepAwake(true).catch((err) => console.warn('Wake lock unavailable:', err));

  let text = '';
  let thoughts = '';
  try {
    const record = job.appId ? await db.get(`app:${job.appId}`) : null;
    const userMessage = job.mode === 'create'
      ? buildCreateMessage(job.brief)
      : buildChangeMessage({ html: record.html, request: job.request, errors: appErrors.get(job.appId) || [] });
    const client = makeClient(settings);
    const stream = client.beta.messages.stream({
      ...baseRequest(settings),
      max_tokens: 64000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      system: buildSystemPrompt(settings.about),
      messages: [{ role: 'user', content: userMessage }],
    });
    run.stream = stream;
    let lastPaint = 0;
    for await (const ev of stream) {
      if (ev.type !== 'content_block_delta') continue;
      if (ev.delta.type === 'thinking_delta') thoughts += ev.delta.thinking;
      else if (ev.delta.type === 'text_delta') text += ev.delta.text;
      const now = performance.now();
      if (now - lastPaint > 150) {
        lastPaint = now;
        paintProgress(text, thoughts, job.mode);
      }
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new Error('Claude declined to build this. Try rewording the request.');
    if (message.stop_reason === 'max_tokens') throw new Error('The app came out too long and was cut off. Try asking for something a little smaller.');
    const html = extractHtml(textOf(message));
    const id = await saveBuild(job, html);
    if (!run.aborted) await openApp(id);
  } catch (err) {
    if (run.aborted) return;
    console.error('Build failed:', err);
    $('building').querySelector('.building-body').classList.add('failed');
    $('build-title').textContent = 'That didn’t work';
    $('build-stage').textContent = '';
    $('build-thoughts').textContent = '';
    $('build-error').textContent = describeError(err);
    $('build-error').hidden = false;
    $('build-retry').hidden = false;
    $('build-cancel').textContent = 'Back';
  } finally {
    audio.keepAwake(false).catch((err) => console.warn('Wake lock release failed:', err));
  }
}

async function saveBuild(job, html) {
  const meta = readMeta(html);
  const now = Date.now();
  if (job.mode === 'create') {
    const id = crypto.randomUUID();
    await db.set(`app:${id}`, { id, html, brief: job.brief, versions: [], changes: [] });
    apps.push({ id, ...meta, createdAt: now, updatedAt: now, openedAt: now });
    await saveIndex();
    return id;
  }
  const record = await db.get(`app:${job.appId}`);
  record.versions = [...record.versions, { html: record.html, at: now }].slice(-MAX_VERSIONS);
  record.changes.push({ request: job.request, at: now });
  record.html = html;
  await db.set(`app:${job.appId}`, record);
  const entry = apps.find((a) => a.id === job.appId);
  Object.assign(entry, meta, { updatedAt: now });
  await saveIndex();
  appErrors.set(job.appId, []);
  return job.appId;
}

function cancelBuild() {
  const job = build;
  if (job) {
    job.aborted = true;
    if (job.stream) job.stream.abort();
  }
  build = null;
  if (job && job.mode === 'change' && apps.some((a) => a.id === job.appId)) openApp(job.appId);
  else goHome();
}

// ---------- runner ----------

function closeApp() {
  if (!current) return;
  current.bridge.dispose();
  current.iframe.remove();
  current = null;
}

async function openApp(id) {
  closeApp();
  const meta = apps.find((a) => a.id === id);
  const record = await db.get(`app:${id}`);
  if (!meta || !record) {
    toast('That app is missing');
    goHome();
    return;
  }
  meta.openedAt = Date.now();
  saveIndex().catch((err) => console.error('Saving app list failed:', err));

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
  iframe.title = meta.name;
  const bridge = new Bridge({
    iframe,
    app: { id, name: meta.name },
    audio,
    getSettings: () => settings,
    pickFiles,
    onReport: (message) => addAppError(id, message),
  });
  iframe.srcdoc = injectRuntime(record.html, { id, name: meta.name });
  $('frame-wrap').replaceChildren(iframe);
  $('runner-title').textContent = `${meta.icon} ${meta.name}`;
  current = { id, meta, bridge, iframe };
  updateErrorDot();
  show('runner');
}

function addAppError(id, message) {
  const list = appErrors.get(id) || [];
  list.push(message);
  appErrors.set(id, list.slice(-MAX_ERRORS));
  console.warn(`[app ${id}]`, message);
  updateErrorDot();
}

function updateErrorDot() {
  $('error-dot').hidden = !current || !(appErrors.get(current.id) || []).length;
}

// ---------- change sheet ----------

async function openChangeSheet() {
  if (!current) return;
  const record = await db.get(`app:${current.id}`);
  const errs = appErrors.get(current.id) || [];
  $('change-text').value = '';
  $('delete-confirm').hidden = true;
  $('change-undo').disabled = !record.versions.length;
  const chips = $('change-chips');
  chips.replaceChildren();
  if (errs.length) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.textContent = `Fix the ${errs.length === 1 ? 'error' : `${errs.length} errors`} it hit`;
    c.addEventListener('click', () => { $('change-text').value = 'Fix the errors it reported.'; });
    chips.append(c);
  }
  $('change-sheet').hidden = false;
}

function closeChangeSheet() {
  $('change-sheet').hidden = true;
}

function applyChange() {
  const request = $('change-text').value.trim() || ((appErrors.get(current.id) || []).length ? 'Fix the errors it reported.' : '');
  if (!request) {
    $('change-text').focus();
    return;
  }
  const appId = current.id;
  closeChangeSheet();
  closeApp();
  startBuild({ mode: 'change', appId, request });
}

async function undoChange() {
  const id = current.id;
  const record = await db.get(`app:${id}`);
  const previous = record.versions.pop();
  if (!previous) return;
  record.html = previous.html;
  record.changes.push({ request: '(undo)', at: Date.now() });
  await db.set(`app:${id}`, record);
  Object.assign(apps.find((a) => a.id === id), readMeta(previous.html), { updatedAt: Date.now() });
  await saveIndex();
  appErrors.set(id, []);
  closeChangeSheet();
  await openApp(id);
  toast('Undone');
}

async function deleteApp() {
  const id = current.id;
  closeChangeSheet();
  closeApp();
  for (const key of await db.keysWithPrefix(`data:${id}:`)) await db.del(key);
  await db.del(`app:${id}`);
  apps = apps.filter((a) => a.id !== id);
  await saveIndex();
  appErrors.delete(id);
  goHome();
  toast('App deleted');
}

// ---------- file picker (host.pickFiles) ----------

function pickFiles(opts) {
  return new Promise((resolve) => {
    const accept = opts.accept || 'image/*,application/pdf';
    const multiple = opts.multiple !== false;
    const picked = [];
    const cameraInput = $('files-camera-input');
    const chooseInput = $('files-choose-input');
    chooseInput.accept = accept;
    chooseInput.multiple = multiple;
    $('files-camera').hidden = !/image/.test(accept);
    $('files-title').textContent = multiple ? 'Add pages' : 'Add a file';
    $('files-error').hidden = true;

    const render = () => {
      const thumbs = $('files-thumbs');
      thumbs.replaceChildren(...picked.map((f, idx) => {
        const wrap = document.createElement('div');
        wrap.className = 'thumb';
        let preview;
        if (f.type.startsWith('image/')) {
          preview = document.createElement('img');
          preview.src = f.dataUrl;
          preview.alt = f.name;
        } else {
          preview = document.createElement('div');
          preview.className = 'pdf';
          preview.textContent = 'PDF';
        }
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${f.name}`);
        remove.addEventListener('click', () => { picked.splice(idx, 1); render(); });
        wrap.append(preview, remove);
        return wrap;
      }));
      $('files-done').disabled = !picked.length;
      $('files-done').textContent = picked.length ? `Use ${picked.length} ${picked.length === 1 ? 'file' : 'files'}` : 'Use files';
      $('files-camera').textContent = picked.length && multiple ? 'Take another' : 'Take photo';
    };

    const addFiles = async (input) => {
      const files = [...input.files];
      input.value = '';
      $('files-error').hidden = true;
      for (const file of files) {
        try {
          if (file.type.startsWith('image/')) picked.push(await downscaleImage(file));
          else if (file.type === 'application/pdf' && file.size <= 25 * 1024 * 1024) picked.push(await readAsDataUrl(file));
          else throw new Error(file.type === 'application/pdf' ? `${file.name} is over 25 MB` : `${file.name} isn’t an image or PDF`);
        } catch (err) {
          console.error('Adding file failed:', err);
          $('files-error').textContent = `Couldn’t add ${file.name}: ${err.message}`;
          $('files-error').hidden = false;
        }
      }
      if (!multiple) picked.splice(0, Math.max(picked.length - 1, 0));
      render();
    };

    const close = (result) => {
      $('files-sheet').hidden = true;
      resolve(result);
    };

    cameraInput.onchange = () => addFiles(cameraInput);
    chooseInput.onchange = () => addFiles(chooseInput);
    $('files-camera').onclick = () => cameraInput.click();
    $('files-choose').onclick = () => chooseInput.click();
    $('files-done').onclick = () => close(picked);
    $('files-cancel').onclick = () => close([]);
    render();
    $('files-sheet').hidden = false;
  });
}

// ---------- settings ----------

function openSettings() {
  $('s-server').value = settings.serverLink;
  $('s-anthropic').value = settings.anthropicKey;
  $('s-openai').value = settings.openaiKey;
  $('s-about').value = settings.about;
  $('s-model').value = settings.model;
  $('s-tts-model').value = settings.ttsModel;
  fillVoicePicker().catch((err) => console.warn('Voice list failed:', err));
  $('s-check-result').textContent = '';
  show('settings');
}

async function fillVoicePicker() {
  const { expressiveInfo } = await audio.voices();
  const select = $('s-voice');
  if (!expressiveInfo.length) {
    select.replaceChildren(new Option('iPhone built-in (add a Claude Code link for natural voices)', ''));
    return;
  }
  const current = expressiveInfo.some((v) => v.name === settings.defaultVoice) ? settings.defaultVoice : expressiveInfo[0].name;
  select.replaceChildren(...expressiveInfo.map((v) => {
    const label = `${v.name[0].toUpperCase()}${v.name.slice(1)} · ${v.accent || ''} ${v.gender || ''}`.trim();
    return new Option(label, v.name, false, v.name === current);
  }));
}

function bindSetting(inputId, key, transform = (v) => v.trim()) {
  $(inputId).addEventListener('input', (e) => {
    settings[key] = transform(e.target.value);
    db.set('settings', settings).catch((err) => console.error('Saving settings failed:', err));
  });
}

async function checkKey() {
  const out = $('s-check-result');
  if (settings.serverLink && !parseServerLink(settings.serverLink)) {
    out.textContent = '✗ That link doesn’t look right: it should start with https:// and end with #code';
    return;
  }
  if (!hasClaude(settings)) {
    out.textContent = 'Paste your Claude Code link or a key first';
    return;
  }
  out.textContent = 'Checking…';
  try {
    const model = await makeClient(settings).models.retrieve(settings.model || DEFAULT_MODEL);
    out.textContent = `✓ Works (${model.display_name || model.id})`;
  } catch (err) {
    console.error('Key check failed:', err);
    out.textContent = `✗ ${describeError(err)}`;
  }
}

async function testAudio() {
  const btn = $('s-test-audio');
  const log = $('s-test-log');
  const lines = [];
  const write = (line) => { lines.push(line); log.textContent = lines.join('\n'); };
  log.hidden = false;
  btn.disabled = true;
  try {
    const voices = await audio.voices();
    const natural = Boolean(settings.serverLink && voices.expressive.length);
    write(`Voices: ${natural ? `natural, from your server (${voices.expressive.length})` : voices.expressive.length ? 'OpenAI expressive' : 'iPhone built-in only'}`);
    write('Speaking…');
    await audio.speak({ text: 'Hello! After this, say a short sentence, then stop talking.' });
    write('Listening… say something.');
    const r = await audio.listen({ silenceMs: 1200, maxMs: 15000 }, (event, data) => {
      if (event === 'level') {
        const bars = Math.round(data.level * 12);
        log.textContent = [...lines, `  Mic ${'▮'.repeat(bars)}${'▯'.repeat(12 - bars)}`].join('\n');
      }
      if (event === 'transcript') log.textContent = [...lines, `  “${data.text}”`].join('\n');
    });
    write(`Heard you: ${r.heard ? 'yes' : 'no'} (${r.reason}${r.error ? `: ${r.error}` : ''})`);
    if (r.micState) write(`Mic: ${r.micState}, loudest ${r.micPeak}, background ${r.micFloor}`);
    write(`Transcript: ${r.transcript || (r.transcriptError ? `(failed: ${r.transcriptError})` : '(none)')}`);
    await audio.speak({
      text: r.transcript ? `You said: ${r.transcript}` : r.heard ? 'I heard you, but couldn’t make out the words.' : 'I didn’t hear anything.',
    });
    write('Done. If all of that worked, apps can talk and listen.');
  } catch (err) {
    console.error('Audio test failed:', err);
    write(`✗ ${err.message || err}`);
  } finally {
    btn.disabled = false;
  }
}

async function exportBackup() {
  const records = {};
  const data = {};
  for (const a of apps) {
    records[a.id] = await db.get(`app:${a.id}`);
    for (const key of await db.keysWithPrefix(`data:${a.id}:`)) data[key] = await db.get(key);
  }
  const { serverLink, anthropicKey, openaiKey, ...safeSettings } = settings;
  const payload = { conjure: 1, version: VERSION, exportedAt: new Date().toISOString(), settings: safeSettings, apps, records, data };
  const name = `conjure-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(payload)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: 'Conjure backup' });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importBackup(file) {
  const payload = JSON.parse(await file.text());
  if (!payload || payload.conjure !== 1 || !Array.isArray(payload.apps)) throw new Error('That isn’t a Conjure backup file');
  for (const [id, record] of Object.entries(payload.records || {})) await db.set(`app:${id}`, record);
  for (const [key, value] of Object.entries(payload.data || {})) await db.set(key, value);
  const byId = new Map(apps.map((a) => [a.id, a]));
  for (const a of payload.apps) byId.set(a.id, a);
  apps = [...byId.values()];
  await saveIndex();
  toast(`Restored ${payload.apps.length} ${payload.apps.length === 1 ? 'app' : 'apps'}`);
}

// ---------- wiring ----------

function wire() {
  // iOS only allows audio after a tap; unlock on the first one anywhere.
  const unlock = () => audio.unlock();
  document.addEventListener('touchend', unlock, { capture: true });
  document.addEventListener('click', unlock, { capture: true });

  for (const b of document.querySelectorAll('[data-back]')) b.addEventListener('click', goHome);
  $('open-settings').addEventListener('click', openSettings);
  $('key-hint-btn').addEventListener('click', openSettings);

  const chips = $('examples');
  for (const ex of EXAMPLES) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.textContent = ex;
    c.addEventListener('click', () => {
      $('brief').value = ex;
      $('build-btn').disabled = false;
    });
    chips.append(c);
  }
  $('brief').addEventListener('input', () => { $('build-btn').disabled = !$('brief').value.trim(); });
  $('build-btn').addEventListener('click', () => startBuild({ mode: 'create', brief: $('brief').value }));
  $('build-cancel').addEventListener('click', cancelBuild);
  $('build-retry').addEventListener('click', () => {
    const { aborted, stream, ...job } = build;
    startBuild(job);
  });

  $('runner-back').addEventListener('click', goHome);
  $('runner-change').addEventListener('click', openChangeSheet);
  $('change-close').addEventListener('click', closeChangeSheet);
  $('change-sheet').addEventListener('click', (e) => { if (e.target === $('change-sheet')) closeChangeSheet(); });
  $('change-apply').addEventListener('click', applyChange);
  $('change-undo').addEventListener('click', () => undoChange().catch((err) => { console.error('Undo failed:', err); toast(`Undo failed: ${err.message}`); }));
  $('change-reload').addEventListener('click', () => { closeChangeSheet(); openApp(current.id); });
  $('change-delete').addEventListener('click', () => { $('delete-confirm').hidden = false; });
  $('delete-no').addEventListener('click', () => { $('delete-confirm').hidden = true; });
  $('delete-yes').addEventListener('click', () => deleteApp().catch((err) => { console.error('Delete failed:', err); toast(`Delete failed: ${err.message}`); }));

  bindSetting('s-server', 'serverLink');
  bindSetting('s-anthropic', 'anthropicKey');
  bindSetting('s-openai', 'openaiKey');
  bindSetting('s-about', 'about', (v) => v);
  bindSetting('s-model', 'model', (v) => v.trim() || DEFAULT_MODEL);
  bindSetting('s-tts-model', 'ttsModel', (v) => v.trim() || DEFAULT_TTS_MODEL);
  $('s-voice').addEventListener('change', (e) => {
    settings.defaultVoice = e.target.value;
    db.set('settings', settings).catch((err) => console.error('Saving settings failed:', err));
  });
  $('s-check').addEventListener('click', checkKey);
  $('s-test-audio').addEventListener('click', testAudio);
  $('s-export').addEventListener('click', () => exportBackup().catch((err) => {
    if (err.name === 'AbortError') return;
    console.error('Export failed:', err);
    toast(`Export failed: ${err.message}`);
  }));
  $('s-import').addEventListener('click', () => $('s-import-file').click());
  $('s-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await importBackup(file);
    } catch (err) {
      console.error('Import failed:', err);
      toast(`Import failed: ${err.message}`);
    }
  });
  $('version').textContent = `Conjure ${VERSION}`;
}

async function init() {
  wire();
  const saved = await db.get('settings');
  if (saved) settings = { ...settings, ...saved };
  apps = (await db.get('apps')) || [];
  renderHome();
  show('home');
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch((err) => console.warn('Persistent storage request failed:', err));
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker registration failed:', err));
  }
}

init().catch((err) => {
  console.error('Conjure failed to start:', err);
  document.body.textContent = `Conjure failed to start: ${err.message}`;
});
