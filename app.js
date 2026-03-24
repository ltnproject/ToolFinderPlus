/* ══════════════════════════════════════════════════════════════
   TOOL FINDER — app.js
   Camera → OCR (Tesseract.js, 13 languages) → Match → Display
   + Google Search fallback
   No backend. No API. Local only.
   ══════════════════════════════════════════════════════════════ */

'use strict';

// ─── SUPPORTED LANGUAGES ────────────────────────────────────────
const LANGUAGES = [
  { code: 'eng',     label: '🇬🇧 English'             },
  { code: 'tha',     label: '🇹🇭 Thai'                 },
  { code: 'chi_sim', label: '🇨🇳 Chinese (Simplified)' },
  { code: 'chi_tra', label: '🇹🇼 Chinese (Traditional)'},
  { code: 'jpn',     label: '🇯🇵 Japanese'             },
  { code: 'kor',     label: '🇰🇷 Korean'               },
  { code: 'ara',     label: '🇸🇦 Arabic'               },
  { code: 'hin',     label: '🇮🇳 Hindi'                },
  { code: 'fra',     label: '🇫🇷 French'               },
  { code: 'spa',     label: '🇪🇸 Spanish'              },
  { code: 'por',     label: '🇧🇷 Portuguese'           },
  { code: 'rus',     label: '🇷🇺 Russian'              },
  { code: 'deu',     label: '🇩🇪 German'               },
];

// ─── STATE ─────────────────────────────────────────────────────
const state = {
  tools: [],
  stream: null,
  isScanning: false,
  ocrReady: false,
  worker: null,
  activeCategory: 'All',
  activeLang: 'eng',
  lastText: '',
  lastResults: [],
};

// ─── DOM REFS ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const DOM = {
  video:       () => $('video'),
  canvas:      () => $('canvas'),
  scanBtn:     () => $('scanBtn'),
  startBtn:    () => $('startBtn'),
  resetBtn:    () => $('resetBtn'),
  ocrText:     () => $('ocrText'),
  results:     () => $('results'),
  manualInput: () => $('manualInput'),
  manualBtn:   () => $('manualBtn'),
  log:         () => $('logWrap'),
  statusDot:   () => $('statusDot'),
  statusMsg:   () => $('statusMsg'),
  filterRow:   () => $('filterRow'),
  cameraWrap:  () => $('cameraWrap'),
  placeholder: () => $('cameraPlaceholder'),
  ocrStatus:   () => $('ocrStatus'),
  langSelect:  () => $('langSelect'),
  googleBtn:   () => $('googleBtn'),
};

// ─── LOGGING ────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const wrap = DOM.log();
  if (!wrap) return;
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `[${ts}] ${msg}`;
  wrap.prepend(line);
  while (wrap.children.length > 12) wrap.removeChild(wrap.lastChild);
}

// ─── STATUS ─────────────────────────────────────────────────────
function setStatus(msg, dotClass = '') {
  const dot = DOM.statusDot();
  const txt = DOM.statusMsg();
  if (txt) txt.textContent = msg;
  if (dot) {
    dot.className = 'status-dot';
    if (dotClass) dot.classList.add(dotClass);
  }
}

// ─── INIT ───────────────────────────────────────────────────────
async function init() {
  log('TOOL FINDER v1.1 — initializing...', 'info');
  setStatus('LOADING...', 'offline');
  buildLangSelector();
  await loadTools();
  buildFilters();
  await initOCR(state.activeLang);
  bindEvents();
  log('system ready', 'ok');
  setStatus('READY');
}

// ─── BUILD LANGUAGE SELECTOR ─────────────────────────────────────
function buildLangSelector() {
  const sel = DOM.langSelect();
  if (!sel) return;
  sel.innerHTML = '';
  LANGUAGES.forEach(lang => {
    const opt = document.createElement('option');
    opt.value = lang.code;
    opt.textContent = lang.label;
    if (lang.code === state.activeLang) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ─── LOAD TOOLS ─────────────────────────────────────────────────
async function loadTools() {
  try {
    const res = await fetch('./tools.json');
    state.tools = await res.json();
    log(`loaded ${state.tools.length} tools`, 'ok');
  } catch (e) {
    log('tools.json load failed — using fallback', 'warn');
    state.tools = [
      { name: 'CapCut',  tags: ['video','edit','clip'], category: 'Video',  link: 'https://capcut.com' },
      { name: 'Figma',   tags: ['design','ui','ux'],    category: 'Design', link: 'https://figma.com' },
      { name: 'ChatGPT', tags: ['ai','chat','write'],   category: 'AI',     link: 'https://chat.openai.com' },
    ];
  }
}

// ─── BUILD CATEGORY FILTERS ──────────────────────────────────────
function buildFilters() {
  const categories = ['All', ...new Set(state.tools.map(t => t.category))];
  const row = DOM.filterRow();
  if (!row) return;
  row.innerHTML = '';
  categories.forEach(cat => {
    const chip = document.createElement('button');
    chip.className = `filter-chip${cat === 'All' ? ' active' : ''}`;
    chip.textContent = cat;
    chip.dataset.cat = cat;
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.activeCategory = cat;
      if (state.lastResults.length) renderResults(state.lastResults);
    });
    row.appendChild(chip);
  });
}

// ─── OCR INIT ───────────────────────────────────────────────────
async function initOCR(langCode) {
  const status = DOM.ocrStatus();
  const scanBtn = DOM.scanBtn();

  if (state.worker) {
    try { await state.worker.terminate(); } catch(_) {}
    state.worker = null;
    state.ocrReady = false;
    if (scanBtn) scanBtn.disabled = true;
  }

  const langLabel = LANGUAGES.find(l => l.code === langCode)?.label || langCode;
  if (status) status.innerHTML = '<span class="spinner"></span>LOADING OCR...';
  log(`loading OCR engine: ${langLabel}`, 'info');
  setStatus('LOADING OCR...', 'offline');

  try {
    state.worker = await Tesseract.createWorker(langCode, 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          if (status) status.textContent = `RECOGNIZING... ${pct}%`;
        }
        if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
          if (status) status.innerHTML = `<span class="spinner"></span>${m.status.toUpperCase()}`;
        }
      }
    });
    state.ocrReady = true;
    if (status) status.textContent = `OCR READY`;
    if (state.stream && scanBtn) scanBtn.disabled = false;
    log(`OCR ready: ${langLabel}`, 'ok');
    setStatus(`READY · ${langLabel}`);
  } catch (e) {
    log(`OCR init failed: ${e.message}`, 'error');
    if (status) status.textContent = 'OCR FAILED';
    setStatus('OCR FAILED', 'offline');
  }
}

// ─── CAMERA ─────────────────────────────────────────────────────
async function startCamera() {
  log('requesting camera access...', 'info');
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    const video = DOM.video();
    video.srcObject = state.stream;
    await video.play();

    DOM.placeholder().style.display = 'none';
    DOM.startBtn().textContent = 'STOP CAM';
    DOM.startBtn().dataset.mode = 'stop';
    if (state.ocrReady) DOM.scanBtn().disabled = false;

    log('camera active', 'ok');
    setStatus('CAMERA LIVE');
  } catch (e) {
    log(`camera error: ${e.message}`, 'error');
    setStatus('CAM DENIED', 'offline');
    DOM.placeholder().innerHTML = `
      <div class="big-icon">🚫</div>
      <div>CAMERA ACCESS DENIED</div>
      <div class="camera-error">Allow camera in browser settings</div>
    `;
  }
}

function stopCamera() {
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  const video = DOM.video();
  video.srcObject = null;
  DOM.placeholder().style.display = '';
  DOM.placeholder().innerHTML = `<div class="big-icon">📷</div><div>CAMERA OFF</div>`;
  DOM.startBtn().textContent = 'START CAM';
  DOM.startBtn().dataset.mode = 'start';
  DOM.scanBtn().disabled = true;
  DOM.cameraWrap().classList.remove('scanning');
  log('camera stopped', 'info');
  setStatus('CAMERA OFF');
}

// ─── CAPTURE FRAME ───────────────────────────────────────────────
function captureFrame() {
  const video = DOM.video();
  const canvas = DOM.canvas();
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ─── SCAN ───────────────────────────────────────────────────────
async function runScan() {
  if (!state.ocrReady || state.isScanning || !state.stream) {
    if (!state.stream) log('no camera feed', 'warn');
    return;
  }

  state.isScanning = true;
  const btn = DOM.scanBtn();
  btn.classList.add('scanning');
  btn.textContent = 'SCANNING...';
  btn.disabled = true;
  DOM.cameraWrap().classList.add('scanning');
  setStatus('SCANNING...');
  log('capturing frame...', 'info');

  try {
    const canvas = captureFrame();
    log('running OCR...', 'info');

    const { data: { text } } = await state.worker.recognize(canvas);
    const cleaned = text.trim().replace(/\n+/g, ' ').replace(/\s+/g, ' ');

    log(`OCR: "${cleaned.slice(0, 60)}${cleaned.length > 60 ? '...' : ''}"`, cleaned ? 'ok' : 'warn');

    const status = DOM.ocrStatus();
    if (status) status.textContent = 'OCR READY';

    if (!cleaned) {
      showOCRResult('', 'No text detected. Try better lighting or hold steady.');
      showNoResults('No text detected in frame.');
      updateGoogleBtn('');
    } else {
      showOCRResult(cleaned);
      state.lastText = cleaned;
      updateGoogleBtn(cleaned);
      const results = matchTools(cleaned);
      state.lastResults = results;
      renderResults(results);
    }
  } catch (e) {
    log(`scan error: ${e.message}`, 'error');
    setStatus('SCAN ERROR', 'offline');
  } finally {
    state.isScanning = false;
    btn.classList.remove('scanning');
    btn.textContent = 'SCAN';
    btn.disabled = false;
    DOM.cameraWrap().classList.remove('scanning');
    setStatus(state.stream ? 'CAMERA LIVE' : 'READY');
  }
}

// ─── GOOGLE SEARCH BUTTON (in OCR panel) ────────────────────────
function updateGoogleBtn(text) {
  const btn = DOM.googleBtn();
  if (!btn) return;
  btn.style.display = text ? '' : 'none';
  btn.onclick = () => openGoogleSearch(text);
}

function openGoogleSearch(text) {
  if (!text) return;
  const q = encodeURIComponent(text.slice(0, 200));
  window.open(`https://www.google.com/search?q=${q}`, '_blank', 'noopener');
  log(`google search: "${text.slice(0, 50)}"`, 'info');
}

// Exposed globally for inline onclick in rendered results
window.googleSearchText = openGoogleSearch;

// ─── SHOW OCR TEXT ───────────────────────────────────────────────
function showOCRResult(text, hint = '') {
  const el = DOM.ocrText();
  if (!el) return;
  if (!text && hint) {
    el.className = 'ocr-output';
    el.innerHTML = `<div class="ocr-label">detected text</div><div class="ocr-placeholder">${hint}</div>`;
  } else {
    el.className = 'ocr-output has-text';
    el.innerHTML = `<div class="ocr-label">detected text</div>${escapeHtml(text)}`;
  }
}

// ─── MATCH TOOLS ────────────────────────────────────────────────
function matchTools(text) {
  const words = text.toLowerCase().match(/\b[a-z]{2,}\b/g) || [];
  return state.tools
    .map(tool => {
      let score = 0;
      const tags = tool.tags.map(t => t.toLowerCase());
      words.forEach(word => {
        tags.forEach(tag => {
          if (tag === word) score += 3;
          else if (tag.includes(word) || word.includes(tag)) score += 1;
        });
      });
      return { ...tool, score };
    })
    .filter(t => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

// ─── RENDER RESULTS ─────────────────────────────────────────────
function renderResults(results) {
  const el = DOM.results();
  if (!el) return;

  const filtered = state.activeCategory === 'All'
    ? results
    : results.filter(t => t.category === state.activeCategory);

  if (filtered.length === 0) {
    showNoResults(
      results.length > 0
        ? `No ${state.activeCategory} tools matched. Try "All".`
        : 'No matching tools found.'
    );
    return;
  }

  const maxScore = filtered[0].score || 1;
  const safeText = JSON.stringify(state.lastText.slice(0, 200));

  el.innerHTML = `
    <div class="results-count">
      MATCHED <span>${filtered.length}</span> TOOL${filtered.length !== 1 ? 'S' : ''}
    </div>
    <div class="tool-cards">
      ${filtered.map((tool, i) => `
        <a class="tool-card" href="${tool.link}" target="_blank" rel="noopener">
          <span class="tool-rank">${i === 0 ? '★' : `0${i + 1}`}</span>
          <div class="tool-info">
            <div class="tool-name">${escapeHtml(tool.name)}</div>
            <div class="tool-category">${escapeHtml(tool.category)}</div>
          </div>
          <div class="tool-score">
            <div class="score-bar">
              <div class="score-fill" style="width:${Math.round((tool.score / maxScore) * 100)}%"></div>
            </div>
            <div class="score-num">+${tool.score}</div>
          </div>
          <span class="tool-arrow">→</span>
        </a>
      `).join('')}
    </div>
    <div class="google-search-row">
      <button class="btn btn-google" onclick="googleSearchText(${safeText})">
        <span>🔍</span> SEARCH ON GOOGLE
      </button>
    </div>
  `;
  log(`matched ${filtered.length} tools`, 'ok');
}

function showNoResults(msg = 'No tools matched.') {
  const el = DOM.results();
  if (!el) return;
  const safeText = state.lastText ? JSON.stringify(state.lastText.slice(0, 200)) : null;
  el.innerHTML = `
    <div class="no-results">
      <div class="no-results-icon">🔍</div>
      <div class="no-results-text">${escapeHtml(msg)}</div>
      <div class="no-results-hint">TRY: VIDEO / DESIGN / CODE / GAME / AI</div>
    </div>
    ${safeText ? `
    <div class="google-search-row">
      <button class="btn btn-google" onclick="googleSearchText(${safeText})">
        <span>🔍</span> SEARCH ON GOOGLE
      </button>
    </div>` : ''}
  `;
}

// ─── MANUAL SEARCH ───────────────────────────────────────────────
function runManualSearch() {
  const input = DOM.manualInput();
  const text = input?.value?.trim();
  if (!text) return;

  showOCRResult(text);
  state.lastText = text;
  updateGoogleBtn(text);
  const results = matchTools(text);
  state.lastResults = results;
  renderResults(results);
  log(`manual search: "${text}"`, 'info');
}

// ─── RESET ───────────────────────────────────────────────────────
function reset() {
  showOCRResult('', 'Waiting for scan...');
  const el = DOM.results();
  if (el) el.innerHTML = `<div class="results-empty">AWAITING SCAN</div>`;
  if (DOM.manualInput()) DOM.manualInput().value = '';
  updateGoogleBtn('');
  state.lastText = '';
  state.lastResults = [];
  log('reset', 'info');
}

// ─── EVENTS ─────────────────────────────────────────────────────
function bindEvents() {
  DOM.startBtn()?.addEventListener('click', () => {
    if (DOM.startBtn().dataset.mode === 'stop') stopCamera();
    else startCamera();
  });

  DOM.scanBtn()?.addEventListener('click', runScan);
  DOM.resetBtn()?.addEventListener('click', reset);
  DOM.manualBtn()?.addEventListener('click', runManualSearch);

  DOM.manualInput()?.addEventListener('keydown', e => {
    if (e.key === 'Enter') runManualSearch();
  });

  // Language switcher — reinit OCR worker
  DOM.langSelect()?.addEventListener('change', async e => {
    const newLang = e.target.value;
    if (newLang === state.activeLang) return;
    state.activeLang = newLang;
    const label = LANGUAGES.find(l => l.code === newLang)?.label || newLang;
    log(`switching to ${label}...`, 'warn');
    setStatus('SWITCHING LANG...', 'offline');
    if (state.stream && DOM.scanBtn()) DOM.scanBtn().disabled = true;
    await initOCR(newLang);
  });

  // Space = scan
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && !e.target.matches('input, select')) {
      e.preventDefault();
      runScan();
    }
  });
}

// ─── UTILS ───────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── GO ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
