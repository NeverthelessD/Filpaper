// Flipaper — Image ⇄ PDF converter
// made by. Nevertheless_D
import * as pdfjsLib from '/assets/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdfjs/pdf.worker.min.mjs';
const PDF_OPTS = {
  cMapUrl: '/assets/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/assets/pdfjs/standard_fonts/',
  isEvalSupported: false,
};

const T = new URLSearchParams(location.search).get('t') || '';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let uidSeq = 0;
const uid = () => 'k' + (++uidSeq);

// ════════════════════════════════════════════════════════════ server API
async function api(path, body) {
  const isBin = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'x-token': T } };
  if (body !== undefined) {
    init.body = isBin ? body : JSON.stringify(body);
    if (!isBin) init.headers['content-type'] = 'application/json';
  }
  let r;
  try { r = await fetch(path, init); } catch { throw new Error('앱 엔진과 연결이 끊겼어요. Flipaper를 다시 실행해 주세요.'); }
  let j = {};
  try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok || j.ok === false) throw new Error(j.error || `요청에 실패했어요 (${r.status})`);
  return j;
}
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function saveBytes(folder, name, ext, data) {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const j = await api(`/api/save?${qs({ folder, name, ext })}`, blob);
  return j.path;
}

// ════════════════════════════════════════════════════════════ app state
const S = {
  mode: 'img',
  settings: null,
  folder: '',
  img: {
    items: [], sel: new Set(), anchor: null,
    paper: 'a4', customW: 210, customH: 297, orientation: 'portrait', margin: 0, quality: 1, merge: true,
    name: stampName(), est: null, estimating: false, job: null, status: null,
  },
  pdf: { files: [], selKey: null, format: 'jpg', quality: 1, range: 'all', rangeText: '', subfolder: true, status: null, running: false, cancel: false },
  zip: { files: [], selKey: null, method: 'smart', quality: 1, suffix: '_압축', status: null, running: false, cancel: false },
};

function stampName() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `Flipaper_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ════════════════════════════════════════════════════════════ formatting
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}
const fmtMM = (v) => (Math.round(v * 10) / 10).toString();
function shortPath(p) {
  const home = S.settings?.home;
  if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
  return p;
}
const baseName = (n) => n.replace(/\.[^.]+$/, '');
const extOf = (n) => (n.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();

// ════════════════════════════════════════════════════════════ toast, menus, modal
let toastTimer;
function toast(msg, ms = 3800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function showCtx(x, y, items) {
  const m = $('#ctxMenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = () => { hideMenus(); it.onClick(); };
    m.append(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
function hideMenus() { $('#ctxMenu').hidden = true; $('#imgSortMenu').hidden = true; }
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.ctx-menu, .menu, .menu-wrap')) hideMenus();
});

const M = { onClose: null, onPrev: null, onNext: null, open: false };
function openModal({ title, sub = '', pos = null, onPrev, onNext, actions = [], body, small = false, onClose }) {
  M.open = true;
  M.onClose = onClose || null;
  M.onPrev = onPrev || null;
  M.onNext = onNext || null;
  $('#modalBox').classList.toggle('small', small);
  $('#modalTitle').textContent = title;
  $('#modalSub').textContent = sub;
  $('#modalNav').hidden = pos == null;
  if (pos) $('#modalPos').textContent = pos;
  setModalActions(actions);
  const b = $('#modalBody');
  b.innerHTML = '';
  if (body) b.append(body);
  $('#modal').hidden = false;
}
function setModalActions(actions) {
  const a = $('#modalActions');
  a.innerHTML = '';
  for (const act of actions) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (act.primary ? ' primary' : '');
    btn.textContent = act.label;
    btn.disabled = !!act.disabled;
    if (act.id) btn.id = act.id;
    btn.onclick = act.onClick;
    a.append(btn);
  }
}
function closeModal() {
  if (!M.open) return;
  M.open = false;
  $('#modal').hidden = true;
  $('#modalBody').innerHTML = '';
  const cb = M.onClose;
  M.onClose = M.onPrev = M.onNext = null;
  cb && cb();
}
$('#modalClose').onclick = closeModal;
$('#modalPrev').onclick = () => M.onPrev && M.onPrev();
$('#modalNext').onclick = () => M.onNext && M.onNext();
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

// ════════════════════════════════════════════════════════════ illustrations
function photoSVG(id, cls, sky1, sky2, hill) {
  return `
  <g class="${cls}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky1}"/><stop offset="1" stop-color="${sky2}"/></linearGradient>
    <clipPath id="${id}c"><rect x="8" y="8" width="104" height="80" rx="4"/></clipPath></defs>
    <rect width="120" height="96" rx="9" fill="#fff" style="filter:drop-shadow(0 6px 10px rgba(0,0,0,.18))"/>
    <g clip-path="url(#${id}c)">
      <rect x="8" y="8" width="104" height="80" fill="url(#${id})"/>
      <circle cx="90" cy="27" r="9" fill="#ffe073"/>
      <path d="M20 88 L58 44 L80 72 L94 58 L130 88 Z" fill="${hill}" opacity=".55"/>
      <path d="M0 88 L38 46 L62 76 L76 62 L112 88 Z" fill="${hill}"/>
    </g>
  </g>`;
}
function paperSVG(cls, badge = 'PDF', badgeColor = '#ff6b4a', w = 104) {
  const h = Math.round(w * 1.36), f = Math.round(w * 0.24);
  return `
  <g class="${cls}">
    <path d="M0 0 H${w - f} L${w} ${f} V${h} H0 Z" fill="#fff" style="filter:drop-shadow(0 6px 12px rgba(0,0,0,.18))"/>
    <path d="M${w - f} 0 V${f} H${w} Z" fill="#dcdcdc"/>
    <rect x="${w * .13}" y="${h * .2}" width="${w * .62}" height="${w * .42}" rx="3" fill="#bfe3fb"/>
    <path d="M${w * .13} ${h * .2 + w * .42} L${w * .33} ${h * .2 + w * .18} L${w * .5} ${h * .2 + w * .36} L${w * .6} ${h * .2 + w * .26} L${w * .75} ${h * .2 + w * .42} Z" fill="#2e8c78"/>
    <rect x="${w * .13}" y="${h * .62}" width="${w * .7}" height="4" rx="2" fill="#e3e3e6"/>
    <rect x="${w * .13}" y="${h * .7}" width="${w * .52}" height="4" rx="2" fill="#e3e3e6"/>
    <rect x="${w * .13}" y="${h * .78}" width="${w * .6}" height="4" rx="2" fill="#e3e3e6"/>
    <g transform="translate(${-w * .14} ${h * .84})">
      <rect width="${badge.length * 9 + 18}" height="22" rx="11" fill="${badgeColor}" style="filter:drop-shadow(0 3px 5px rgba(0,0,0,.25))"/>
      <text x="${(badge.length * 9 + 18) / 2}" y="15.5" text-anchor="middle" font-family="ui-rounded,-apple-system,sans-serif" font-weight="800" font-size="12" fill="#fff">${badge}</text>
    </g>
  </g>`;
}
const arrowSVG = (x, y) => `
  <g transform="translate(${x} ${y})"><g class="arrow-pulse">
    <defs><linearGradient id="ag${x}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b4a"/><stop offset="1" stop-color="#ffb547"/></linearGradient></defs>
    <circle r="23" fill="url(#ag${x})" style="filter:drop-shadow(0 4px 10px rgba(255,107,74,.45))"/>
    <path d="M-8 0 H8 M2 -7 L9 0 L2 7" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g></g>`;
function illustration(kind) {
  const photos = `
    <g transform="translate(20 52)">${photoSVG('ph1' + kind, 'float-a', '#5cb2f2', '#cdecff', '#2e8c78')}</g>
    <g transform="translate(62 62)">${photoSVG('ph2' + kind, 'float-b', '#ff9e8c', '#ffdc9e', '#6b4d8c')}</g>`;
  if (kind === 'img') {
    return `<svg width="440" height="190" viewBox="0 0 440 190">${photos}${arrowSVG(232, 104)}
      <g transform="translate(300 22)">${paperSVG('float-c')}</g></svg>`;
  }
  if (kind === 'pdf') {
    return `<svg width="440" height="190" viewBox="0 0 440 190"><g transform="translate(30 22)">${paperSVG('float-c')}</g>${arrowSVG(198, 104)}
      <g transform="translate(240 0)">${photos}</g></svg>`;
  }
  return `<svg width="440" height="190" viewBox="0 0 440 190">
    <g transform="translate(36 14)">${paperSVG('float-c', '24 MB', '#8a8f9c', 118)}</g>${arrowSVG(222, 104)}
    <g transform="translate(300 52)">${paperSVG('float-a2', '2.1 MB', '#2fa66a', 80)}</g></svg>`;
}
$$('[data-illus]').forEach((el) => (el.innerHTML = illustration(el.dataset.illus)));

// ════════════════════════════════════════════════════════════ shared widgets
const IMG_Q = [
  { t: '낮음', dpi: 100, j: 55, hint: '메일·메신저 공유용, 가장 가벼워요' },
  { t: '보통', dpi: 150, j: 70, hint: '일반 문서용, 화질과 용량의 균형' },
  { t: '높음', dpi: 220, j: 82, hint: '선명한 화면 보기·일반 인쇄용' },
  { t: '매우 높음', dpi: 300, j: 92, hint: '고품질 인쇄·보관용' },
];
const PDF_Q = [
  { t: '낮음', dpi: 72 }, { t: '보통', dpi: 150 }, { t: '높음', dpi: 220 }, { t: '매우 높음', dpi: 300 },
];
const ZIP_Q = [
  { t: '낮음', dpi: 96, q: 0.5, hint: '가장 작게 — 화면으로 대충 볼 문서' },
  { t: '보통', dpi: 144, q: 0.65, hint: '추천 — 메일 첨부·공유용' },
  { t: '높음', dpi: 200, q: 0.78, hint: '사진이 많은 문서, 선명하게' },
  { t: '매우 높음', dpi: 300, q: 0.88, hint: '인쇄용, 용량은 조금만 줄어요' },
];

function renderQuality(el, levels, current, detail, value, onPick) {
  el.innerHTML = '';
  levels.forEach((lv, i) => {
    const b = document.createElement('button');
    b.className = 'q' + (i === current ? ' on' : '');
    const bars = [0, 1, 2, 3].map((k) => `<i class="${k <= i ? 'f' : ''}" style="height:${5 + k * 3}px"></i>`).join('');
    b.innerHTML = `<div class="qt">${lv.t}<span class="bars">${bars}</span></div>
      <div class="qd">${esc(detail(lv, i))}</div><div class="qv">${value(lv, i)}</div>`;
    b.onclick = () => onPick(i);
    el.append(b);
  });
}

function setSeg(el, value) {
  $$('button', el).forEach((b) => b.classList.toggle('on', b.dataset.v === String(value)));
}
function bindSeg(el, onPick) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) onPick(b.dataset.v);
  });
}

function renderStatus(el, st, onCancel) {
  if (!st) { el.innerHTML = ''; return; }
  if (st.kind === 'run') {
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    el.innerHTML = `<div class="st run"><div class="row"><b>${esc(st.label)}</b><span>${st.done} / ${st.total}</span>
      <button class="mini" data-cancel>취소</button></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
    $('[data-cancel]', el).onclick = onCancel;
  } else if (st.kind === 'ok') {
    el.innerHTML = `<div class="st ok"><span style="font-size:17px">✅</span><div class="grow"><b>${esc(st.title)}</b><div class="sub">${esc(st.sub || '')}</div></div>
      ${st.paths?.length ? '<button class="mini" data-reveal>Finder에서 보기</button>' : ''}<button class="x" data-x>✕</button></div>`;
    const r = $('[data-reveal]', el);
    if (r) r.onclick = () => api('/api/reveal', { paths: st.paths }).catch(() => {});
    $('[data-x]', el).onclick = () => { el.innerHTML = ''; };
  } else {
    el.innerHTML = `<div class="st err"><span>⚠️</span><div class="grow">${esc(st.msg)}</div><button class="x" data-x>✕</button></div>`;
    $('[data-x]', el).onclick = () => { el.innerHTML = ''; };
  }
}

// ---- 저장 폴더 표시
function renderFolders() {
  const def = S.settings.resolvedDefaultFolder;
  const isDef = S.folder === def;
  const name = S.folder.split('/').filter(Boolean).pop() || S.folder;
  $$('[data-folder]').forEach((el) => {
    el.innerHTML = `
      <div class="folder-main"><span class="folder-ico">📁</span>
        <div class="folder-text"><div class="folder-name">${esc(name)}</div><div class="folder-path" title="${esc(S.folder)}">${esc(shortPath(S.folder))}</div></div>
        <button class="btn" data-act="change">변경…</button></div>
      <div class="folder-sub">${isDef ? '<span class="badge-ok">✓ 기본 저장 폴더</span>' : '<button class="link" data-act="default">📌 이 폴더를 기본 폴더로 지정</button>'}
        <button class="link" data-act="open">폴더 열기 ↗</button></div>`;
  });
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-folder] [data-act]');
  if (!b) return;
  const act = b.dataset.act;
  try {
    if (act === 'change') {
      const j = await api('/api/choose-folder', { start: S.folder });
      if (j.path) { S.folder = j.path; renderFolders(); }
    } else if (act === 'default') {
      S.settings = await api('/api/settings', { defaultFolder: S.folder });
      renderFolders();
      toast('📌 기본 저장 폴더로 지정했어요');
    } else if (act === 'open') {
      api('/api/open', { path: S.folder });
    }
  } catch (err) { toast('⚠️ ' + err.message); }
});

// ---- 화면 설정 저장
let uiTimer;
function saveUI() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    const { img, pdf, zip } = S;
    api('/api/settings', {
      ui: {
        mode: S.mode,
        img: { paper: img.paper, customW: img.customW, customH: img.customH, orientation: img.orientation, margin: img.margin, quality: img.quality, merge: img.merge },
        pdf: { format: pdf.format, quality: pdf.quality, subfolder: pdf.subfolder },
        zip: { method: zip.method, quality: zip.quality, suffix: zip.suffix },
      },
    }).catch(() => {});
  }, 500);
}

// ---- 테마
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  $$('#themeToggle button').forEach((b) => b.classList.toggle('on', b.dataset.theme === (mode || 'system')));
}
$('#themeToggle').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  applyTheme(b.dataset.theme);
  S.settings = await api('/api/settings', { appearance: b.dataset.theme }).catch(() => S.settings);
});

// ---- 모드 전환
function setMode(m) {
  S.mode = m;
  $$('.mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  for (const k of ['img', 'pdf', 'zip']) $('#view-' + k).hidden = k !== m;
  movePill();
  saveUI();
}
function movePill() {
  const on = $('.mode.on');
  const pill = $('#modePill');
  if (!on) return;
  pill.style.left = on.offsetLeft + 'px';
  pill.style.width = on.offsetWidth + 'px';
}
$('#modes').addEventListener('click', (e) => {
  const b = e.target.closest('.mode');
  if (b) setMode(b.dataset.mode);
});
addEventListener('resize', movePill);

// ---- 파일 선택 / 끌어다 놓기
let pickTarget = 'img';
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (!b) return;
  pickPick(b.dataset.pick);
});
function pickPick(target) {
  pickTarget = target;
  (target === 'img' ? $('#pickImg') : $('#pickPdf')).click();
}
$('#pickImg').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; routeFiles('img', f); };
$('#pickPdf').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; routeFiles(pickTarget === 'img' ? S.mode : pickTarget, f); };

const IMG_EXT = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'tif', 'tiff', 'bmp', 'gif']);
function routeFiles(target, files, beforeKey) {
  if (!files.length) return;
  if (target === 'img') {
    const ok = files.filter((f) => IMG_EXT.has(extOf(f.name)) || (f.type.startsWith('image/') && f.type !== 'image/svg+xml'));
    const pdfs = files.filter((f) => extOf(f.name) === 'pdf');
    if (pdfs.length && !ok.length) toast('📄 PDF는 위쪽의 ‘PDF → 이미지’ 또는 ‘PDF 용량 줄이기’에서 넣어 주세요');
    else if (ok.length < files.length) toast(`${files.length - ok.length}개는 이미지가 아니라서 제외했어요`);
    addImages(ok, beforeKey);
  } else {
    const ok = files.filter((f) => extOf(f.name) === 'pdf' || f.type === 'application/pdf');
    if (ok.length < files.length) toast(`${files.length - ok.length}개는 PDF가 아니라서 제외했어요`);
    if (target === 'pdf') addPdfs(ok); else addZips(ok);
  }
}

// 폴더까지 펼쳐서 파일 목록 얻기
async function filesFromDrop(dt) {
  const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (!entries.some((en) => en && en.isDirectory)) return [...dt.files];
  const out = [];
  const walk = async (entry, path) => {
    if (!entry) return;
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      if (f && !f.name.startsWith('.')) out.push({ f, p: path + f.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        for (const ch of batch) await walk(ch, path + entry.name + '/');
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en, '');
  out.sort((a, b) => a.p.localeCompare(b.p, 'ko', { numeric: true }));
  return out.map((o) => o.f);
}

function setupDrop(workEl, target, getBefore) {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  workEl.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; workEl.classList.add('drag'); });
  workEl.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; workEl.classList.remove('drag'); } });
  workEl.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  workEl.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    workEl.classList.remove('drag');
    const before = getBefore ? getBefore(e) : undefined;
    routeFiles(target, await filesFromDrop(e.dataTransfer), before);
  });
}
// 창 밖으로 떨어뜨렸을 때 브라우저가 파일을 열어 버리지 않도록
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => e.preventDefault());

// ════════════════════════════════════════════════════════════ 1) 이미지 → PDF
const PAPERS = { a4: [210, 297], a3: [297, 420], a5: [148, 210], b4: [257, 364], b5: [182, 257], letter: [215.9, 279.4], legal: [215.9, 355.6] };
const I = S.img;

function paperMM() {
  if (I.paper !== 'custom') return PAPERS[I.paper] || PAPERS.a4;
  const c = (v) => Math.min(3000, Math.max(10, Number(v) || 0));
  return [c(I.customW), c(I.customH)];
}
// 페이지 안에서 이미지 위치 (비율 유지, 자동 확대/축소, 가운데)
function geom(item) {
  const [a, b] = paperMM();
  const short = Math.min(a, b), long = Math.max(a, b);
  const w = item.width || 3, h = item.height || 4;
  const land = I.orientation === 'landscape' || (I.orientation === 'auto' && w > h);
  const pw = land ? long : short, ph = land ? short : long;
  const m = Math.max(0, Math.min(I.margin, Math.min(pw, ph) / 2 - 0.4));
  const aw = pw - 2 * m, ah = ph - 2 * m;
  const s = Math.min(aw / w, ah / h);
  const dw = w * s, dh = h * s;
  return { pw, ph, x: (m + (aw - dw) / 2) / pw, y: (m + (ah - dh) / 2) / ph, w: dw / pw, h: dh / ph, dwmm: dw, dhmm: dh };
}
function pageOptions() {
  const [w, h] = paperMM();
  return { paperW: w, paperH: h, orientation: I.orientation, margin: Number(I.margin), quality: I.quality };
}
const thumbURL = (id, max) => `/api/thumb?id=${id}&max=${max}&t=${T}`;

function placePaper(card, item) {
  const g = geom(item);
  const box = { w: 150, h: 172 };
  const s = Math.min(box.w / g.pw, box.h / g.ph);
  const paper = $('.paper', card);
  paper.style.width = g.pw * s + 'px';
  paper.style.height = g.ph * s + 'px';
  const img = $('img', paper);
  if (img) Object.assign(img.style, { left: g.x * 100 + '%', top: g.y * 100 + '%', width: g.w * 100 + '%', height: g.h * 100 + '%' });
}

function cardHTML(item, n) {
  const meta = item.id ? `${item.width}×${item.height} · ${fmtBytes(item.size)}` : '불러오는 중…';
  return `<div class="pbox"><div class="paper"><div class="pclip">${item.id ? `<img loading="lazy" decoding="async" src="${thumbURL(item.id, 420)}" draggable="false">` : '<div class="ploading"><span class="spin"></span></div>'}</div>
      <span class="pnum">${n}</span>
      <div class="phover"><button data-a="view" title="크게 보기">👁</button><button data-a="del" title="삭제">✕</button></div></div></div>
    <div class="pname" title="${esc(item.name)}">${esc(item.name)}</div><div class="pmeta">${meta}</div>`;
}

function renderImgGrid() {
  const grid = $('#imgGrid');
  const has = I.items.length > 0;
  $('#imgEmpty').hidden = has;
  $('#imgFilled').hidden = !has;
  $('#imgWork').classList.toggle('has', has);
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  I.items.forEach((it, i) => {
    const c = document.createElement('div');
    c.className = 'pcard' + (I.sel.has(it.key) ? ' sel' : '');
    c.dataset.key = it.key;
    c.draggable = true;
    c.innerHTML = cardHTML(it, i + 1);
    placePaper(c, it);
    frag.append(c);
  });
  grid.append(frag);
  updateImgHeader();
}
function updateImgCard(item) {
  const c = $(`#imgGrid .pcard[data-key="${item.key}"]`);
  if (!c) return;
  c.innerHTML = cardHTML(item, I.items.indexOf(item) + 1);
  placePaper(c, item);
}
function renumber() {
  $$('#imgGrid .pcard').forEach((c, i) => { const n = $('.pnum', c); if (n) n.textContent = i + 1; });
}
function updateSel() {
  $$('#imgGrid .pcard').forEach((c) => c.classList.toggle('sel', I.sel.has(c.dataset.key)));
  updateImgHeader();
}
function updateImgHeader() {
  const n = I.items.length;
  $('#imgCount').innerHTML = `이미지 ${n}장` + (I.items.some((x) => !x.id) ? ' <span class="spin"></span>' : '');
  $('#imgHint').textContent = I.sel.size
    ? `${I.sel.size}장 선택됨 · ⌘클릭 개별 선택 · ⇧클릭 범위 선택 · ⌫ 삭제`
    : '드래그해서 순서를 바꾸고, 더블클릭하면 크게 볼 수 있어요';
  $('#imgDelSel').hidden = I.sel.size === 0;
  const ready = n > 0 && I.items.every((x) => x.id);
  const busy = !!I.job;
  $('#imgConvertBtn').disabled = !ready || busy;
  $('#imgPreviewBtn').disabled = !ready || busy;
}
function relayoutCards() {
  $$('#imgGrid .pcard').forEach((c) => {
    const it = I.items.find((x) => x.key === c.dataset.key);
    if (it) placePaper(c, it);
  });
}

// ---- 업로드
async function addImages(files, beforeKey) {
  if (!files.length) return;
  const fresh = files.map((f) => ({ key: uid(), file: f, name: f.name, size: f.size, id: null }));
  let at = beforeKey ? I.items.findIndex((x) => x.key === beforeKey) : -1;
  if (at < 0) at = I.items.length;
  I.items.splice(at, 0, ...fresh);
  renderImgGrid();
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < fresh.length) {
      const it = fresh[next++];
      try {
        const r = await fetch(`/api/upload?name=${encodeURIComponent(it.name)}`, { method: 'POST', headers: { 'x-token': T }, body: it.file });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
        Object.assign(it, { id: j.image.id, width: j.image.width, height: j.image.height });
        delete it.file;
        updateImgCard(it);
      } catch {
        failed.push(it.name);
        I.items = I.items.filter((x) => x !== it);
        $(`#imgGrid .pcard[data-key="${it.key}"]`)?.remove();
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  renumber();
  updateImgHeader();
  if (failed.length) toast(`⚠️ 읽을 수 없는 파일 ${failed.length}개를 제외했어요: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ' …' : ''}`, 5500);
  if (!I.items.length) renderImgGrid();
  scheduleEstimate();
}

function removeImages(keys) {
  const ids = I.items.filter((x) => keys.has(x.key) && x.id).map((x) => x.id);
  I.items = I.items.filter((x) => !keys.has(x.key));
  keys.forEach((k) => I.sel.delete(k));
  if (ids.length) api('/api/remove', { ids }).catch(() => {});
  renderImgGrid();
  scheduleEstimate();
}

// ---- 선택 · 순서
$('#imgGrid').addEventListener('click', (e) => {
  const card = e.target.closest('.pcard');
  const act = e.target.closest('[data-a]');
  if (!card) { if (e.target.id === 'imgGrid') { I.sel.clear(); updateSel(); } return; }
  const key = card.dataset.key;
  if (act) {
    if (act.dataset.a === 'del') removeImages(new Set([key]));
    else openImagePreview(I.items.findIndex((x) => x.key === key));
    return;
  }
  if (e.shiftKey && I.anchor) {
    const a = I.items.findIndex((x) => x.key === I.anchor), b = I.items.findIndex((x) => x.key === key);
    if (a >= 0 && b >= 0) I.sel = new Set(I.items.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.key));
  } else if (e.metaKey || e.ctrlKey) {
    I.sel.has(key) ? I.sel.delete(key) : I.sel.add(key);
    I.anchor = key;
  } else {
    I.sel = new Set([key]);
    I.anchor = key;
  }
  updateSel();
});
$('#imgScroll').addEventListener('click', (e) => { if (e.target.id === 'imgScroll') { I.sel.clear(); updateSel(); } });
$('#imgGrid').addEventListener('dblclick', (e) => {
  const card = e.target.closest('.pcard');
  if (card && !e.target.closest('[data-a]')) openImagePreview(I.items.findIndex((x) => x.key === card.dataset.key));
});
$('#imgGrid').addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.pcard');
  if (!card) return;
  e.preventDefault();
  const key = card.dataset.key;
  if (!I.sel.has(key)) { I.sel = new Set([key]); I.anchor = key; updateSel(); }
  const keys = new Set(I.sel);
  showCtx(e.clientX, e.clientY, [
    { label: '👁  크게 보기', onClick: () => openImagePreview(I.items.findIndex((x) => x.key === key)) },
    '-',
    { label: '⇤  맨 앞으로', onClick: () => moveSel(keys, 'front') },
    { label: '←  한 칸 앞으로', onClick: () => moveSel(keys, 'fwd') },
    { label: '→  한 칸 뒤로', onClick: () => moveSel(keys, 'back') },
    { label: '⇥  맨 뒤로', onClick: () => moveSel(keys, 'end') },
    '-',
    { label: keys.size > 1 ? `🗑  선택한 ${keys.size}장 삭제` : '🗑  삭제', danger: true, onClick: () => removeImages(keys) },
  ]);
});
function moveSel(keys, how) {
  let list = I.items.slice();
  const inSel = (x) => keys.has(x.key);
  if (how === 'front') list = [...list.filter(inSel), ...list.filter((x) => !inSel(x))];
  else if (how === 'end') list = [...list.filter((x) => !inSel(x)), ...list.filter(inSel)];
  else if (how === 'fwd') { for (let i = 1; i < list.length; i++) if (inSel(list[i]) && !inSel(list[i - 1])) [list[i - 1], list[i]] = [list[i], list[i - 1]]; }
  else { for (let i = list.length - 2; i >= 0; i--) if (inSel(list[i]) && !inSel(list[i + 1])) [list[i + 1], list[i]] = [list[i], list[i + 1]]; }
  I.items = list;
  renderImgGrid();
}
$('#imgDelSel').onclick = () => removeImages(new Set(I.sel));
$('#imgClear').onclick = () => {
  if (!I.items.length) return;
  removeImages(new Set(I.items.map((x) => x.key)));
};
$('#imgSortBtn').onclick = () => { $('#imgSortMenu').hidden = !$('#imgSortMenu').hidden; };
$('#imgSortMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sort]');
  if (!b) return;
  hideMenus();
  const coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
  if (b.dataset.sort === 'asc') I.items.sort((a, c) => coll.compare(a.name, c.name));
  else if (b.dataset.sort === 'desc') I.items.sort((a, c) => coll.compare(c.name, a.name));
  else I.items.reverse();
  renderImgGrid();
});

// ---- 드래그로 순서 바꾸기
let dragKey = null;
const grid = $('#imgGrid');
grid.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.pcard');
  if (!card) return;
  dragKey = card.dataset.key;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/x-flipaper', dragKey);
  requestAnimationFrame(() => card.classList.add('dragging'));
});
grid.addEventListener('dragover', (e) => {
  if (!dragKey) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.target.closest('.pcard');
  const dragged = $(`.pcard[data-key="${dragKey}"]`, grid);
  if (!target || !dragged || target === dragged) return;
  const r = target.getBoundingClientRect();
  const before = e.clientX < r.left + r.width / 2;
  const ref = before ? target : target.nextSibling;
  if (ref !== dragged && dragged.nextSibling !== ref) grid.insertBefore(dragged, ref);
});
grid.addEventListener('drop', (e) => { if (dragKey) e.preventDefault(); });
grid.addEventListener('dragend', () => {
  if (!dragKey) return;
  $(`.pcard[data-key="${dragKey}"]`, grid)?.classList.remove('dragging');
  const order = $$('.pcard', grid).map((c) => c.dataset.key);
  const byKey = new Map(I.items.map((x) => [x.key, x]));
  I.items = order.map((k) => byKey.get(k)).filter(Boolean);
  dragKey = null;
  renumber();
});

setupDrop($('#imgWork'), 'img', (e) => e.target.closest?.('#imgGrid .pcard')?.dataset.key);

// ---- 오른쪽 설정
function renderImgSide() {
  $('#paperSel').value = I.paper;
  $('#customSize').hidden = I.paper !== 'custom';
  $('#customW').value = I.customW;
  $('#customH').value = I.customH;
  setSeg($('#orientSeg'), I.orientation);
  const [a, b] = paperMM();
  const s = fmtMM(Math.min(a, b)), l = fmtMM(Math.max(a, b));
  $('#paperDesc').textContent = I.orientation === 'portrait' ? `${s} × ${l} mm · 세로` : I.orientation === 'landscape' ? `${l} × ${s} mm · 가로` : `${s} × ${l} mm · 이미지 방향에 맞춰 자동으로 회전`;
  $('#marginRange').value = I.margin;
  $('#marginVal').textContent = `${I.margin} mm`;
  renderImgQuality();
  setSeg($('#mergeSeg'), I.merge ? '1' : '0');
  $('#nameRow').hidden = !I.merge;
  $('#sepNote').hidden = I.merge;
  if (document.activeElement !== $('#imgName')) $('#imgName').value = I.name;
}
function renderImgQuality() {
  renderQuality($('#imgQuality'), IMG_Q, I.quality,
    (lv) => `${lv.dpi} DPI · JPEG ${lv.j}%`,
    (lv, i) => (I.est ? `≈ ${fmtBytes(I.est[i])}` : I.estimating ? '<span class="spin"></span>' : '—'),
    (i) => { I.quality = i; renderImgQuality(); saveUI(); });
  $('#imgQualityHint').textContent = '💡 ' + IMG_Q[I.quality].hint;
}
function pageSettingsChanged() {
  renderImgSide();
  relayoutCards();
  scheduleEstimate();
  saveUI();
}
$('#paperSel').onchange = (e) => { I.paper = e.target.value; pageSettingsChanged(); };
$('#customW').oninput = (e) => { I.customW = Number(e.target.value) || 0; if (I.orientation !== 'auto' && I.customW !== I.customH) I.orientation = I.customW > I.customH ? 'landscape' : 'portrait'; relayoutCards(); };
$('#customH').oninput = (e) => { I.customH = Number(e.target.value) || 0; if (I.orientation !== 'auto' && I.customW !== I.customH) I.orientation = I.customW > I.customH ? 'landscape' : 'portrait'; relayoutCards(); };
$('#customW').onchange = $('#customH').onchange = pageSettingsChanged;
bindSeg($('#orientSeg'), (v) => { I.orientation = v; pageSettingsChanged(); });
$('#marginRange').oninput = (e) => { I.margin = Number(e.target.value); $('#marginVal').textContent = `${I.margin} mm`; relayoutCards(); };
$('#marginRange').onchange = pageSettingsChanged;
bindSeg($('#mergeSeg'), (v) => { I.merge = v === '1'; renderImgSide(); saveUI(); });
$('#imgName').oninput = (e) => { I.name = e.target.value; };
$('#imgNameReset').onclick = () => { I.name = stampName(); $('#imgName').value = I.name; };

// ---- 예상 용량
let estTimer, estSeq = 0;
function scheduleEstimate() {
  clearTimeout(estTimer);
  const ready = I.items.filter((x) => x.id);
  if (!ready.length) { I.est = null; I.estimating = false; renderImgQuality(); return; }
  I.estimating = true;
  I.est = null;
  renderImgQuality();
  estTimer = setTimeout(async () => {
    const seq = ++estSeq;
    try {
      const j = await api('/api/estimate', { ids: ready.map((x) => x.id), options: pageOptions() });
      if (seq !== estSeq) return;
      I.est = j.sizes;
    } catch { if (seq === estSeq) I.est = null; }
    if (seq === estSeq) { I.estimating = false; renderImgQuality(); }
  }, 450);
}

// ---- 크게 보기 (배치 미리보기)
function openImagePreview(index) {
  if (index < 0 || !I.items.length) return;
  let i = index;
  const stage = document.createElement('div');
  stage.className = 'pv-stage';
  const side = document.createElement('div');
  side.className = 'pv-side';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex:1;min-width:0';
  wrap.append(stage, side);
  const show = () => {
    const it = I.items[i];
    const g = geom(it);
    $('#modalPos').textContent = `${i + 1} / ${I.items.length}`;
    $('#modalSub').textContent = it.name;
    const sw = stage.clientWidth - 52, sh = stage.clientHeight - 52;
    const s = Math.min(sw / g.pw, sh / g.ph);
    stage.innerHTML = `<div class="paper" style="width:${g.pw * s}px;height:${g.ph * s}px"><div class="pclip">${it.id ? `<img src="${thumbURL(it.id, 1600)}" style="left:${g.x * 100}%;top:${g.y * 100}%;width:${g.w * 100}%;height:${g.h * 100}%">` : ''}</div></div>`;
    const q = IMG_Q[I.quality];
    const nativeDPI = it.width / (g.dwmm / 25.4);
    const eff = Math.round(Math.min(q.dpi, nativeDPI));
    side.innerHTML = `
      <b style="font-size:13px;word-break:break-all">${esc(it.name)}</b>
      <div class="kv"><span>원본 크기</span><b>${it.width} × ${it.height} px</b></div>
      <div class="kv"><span>파일 용량</span><b>${fmtBytes(it.size)}</b></div><hr>
      <div class="kv"><span>용지</span><b>${fmtMM(g.pw)} × ${fmtMM(g.ph)} mm</b></div>
      <div class="kv"><span>배치 크기</span><b>${fmtMM(g.dwmm)} × ${fmtMM(g.dhmm)} mm</b></div>
      <div class="kv"><span>여백</span><b>${I.margin} mm</b></div><hr>
      <div class="kv"><span>품질</span><b>${q.t}</b></div>
      <div class="kv"><span>적용 해상도</span><b>${eff} DPI</b></div>
      ${nativeDPI < q.dpi ? '<div class="note">원본 해상도가 선택한 품질보다 낮아서 원본 그대로 넣어요. 억지로 키우지 않아 용량이 늘지 않아요.</div>' : ''}
      <hr><div class="note">↔︎ 이미지 비율을 유지한 채 용지에 맞춰 자동으로 확대·축소하고 가운데에 놓아요.</div>`;
    $('#modalPrev').disabled = i <= 0;
    $('#modalNext').disabled = i >= I.items.length - 1;
  };
  openModal({
    title: '🔍 페이지 미리보기', sub: '', pos: '',
    onPrev: () => { if (i > 0) { i--; show(); } },
    onNext: () => { if (i < I.items.length - 1) { i++; show(); } },
    body: wrap,
  });
  requestAnimationFrame(show);
}

// ---- 변환 & 실제 PDF 미리보기
async function pollJob(id, onTick) {
  for (;;) {
    const j = await api(`/api/job?id=${id}`);
    onTick(j);
    if (j.state !== 'running') return j;
    await sleep(250);
  }
}
async function convertImages() {
  const ids = I.items.map((x) => x.id);
  if (!ids.length || ids.some((x) => !x)) return;
  try {
    const { job } = await api('/api/build', { ids, options: pageOptions(), merge: I.merge, name: I.name, folder: S.folder });
    I.job = job;
    updateImgHeader();
    const label = I.merge ? 'PDF를 만드는 중…' : '이미지마다 PDF를 만드는 중…';
    I.status = { kind: 'run', label, done: 0, total: ids.length };
    renderImgStatus();
    const fin = await pollJob(job, (j) => { I.status = { kind: 'run', label, done: j.done, total: j.total }; renderImgStatus(); });
    if (fin.state === 'done') {
      I.status = { kind: 'ok', title: '변환 완료!', sub: fin.outputs.length === 1 ? `${fin.outputs[0].split('/').pop()} · ${fmtBytes(fin.size)}` : `${fin.outputs.length}개 파일 · 총 ${fmtBytes(fin.size)}`, paths: fin.outputs };
      toast('🎉 PDF를 저장했어요');
    } else if (fin.state === 'canceled') I.status = null;
    else I.status = { kind: 'err', msg: fin.error || '변환하지 못했어요' };
  } catch (err) {
    I.status = { kind: 'err', msg: err.message };
  }
  I.job = null;
  renderImgStatus();
  updateImgHeader();
}
function renderImgStatus() {
  renderStatus($('#imgStatus'), I.status, () => I.job && api(`/api/job/cancel?id=${I.job}`).catch(() => {}));
}
$('#imgConvertBtn').onclick = convertImages;

async function previewImagesPDF() {
  const ids = I.items.map((x) => x.id);
  if (!ids.length || ids.some((x) => !x)) return;
  let jobId = null, closed = false, viewerCleanup = null;
  const body = document.createElement('div');
  body.className = 'center-msg';
  body.innerHTML = `<div style="font-size:40px">📄</div><b>현재 설정 그대로 실제 PDF를 만들고 있어요…</b><div class="bar"><i></i></div><span class="cnt"></span>`;
  const saveLabel = I.merge ? '💾 이대로 저장' : '💾 이미지마다 PDF로 저장';
  openModal({
    title: '👀 PDF 미리보기', sub: '만드는 중…', body,
    actions: [{ label: saveLabel, primary: true, disabled: true, id: 'pvSave', onClick: async () => {
      if (!I.merge) { closeModal(); convertImages(); return; }
      try {
        const j = await api(`/api/job/save?id=${jobId}`, { folder: S.folder, name: I.name });
        I.status = { kind: 'ok', title: '저장 완료!', sub: j.path.split('/').pop(), paths: [j.path] };
        renderImgStatus();
        toast('🎉 PDF를 저장했어요');
        closeModal();
      } catch (err) { toast('⚠️ ' + err.message); }
    } }],
    onClose: () => { closed = true; viewerCleanup?.(); if (jobId) api(`/api/job/discard?id=${jobId}`).catch(() => {}); },
  });
  try {
    const r = await api('/api/build', { ids, options: pageOptions(), merge: true, name: I.name, preview: true });
    jobId = r.job;
    if (closed) { api(`/api/job/discard?id=${jobId}`).catch(() => {}); return; }
    const fin = await pollJob(jobId, (j) => {
      if (closed) return;
      $('.bar i', body).style.width = (j.done / j.total) * 100 + '%';
      $('.cnt', body).textContent = `${j.done} / ${j.total}장`;
    });
    if (closed) return;
    if (fin.state !== 'done') throw new Error(fin.error || 'PDF를 만들지 못했어요');
    $('#modalSub').textContent = `${ids.length}쪽 · 파일 크기 ${fmtBytes(fin.size)} · 품질 ‘${IMG_Q[I.quality].t}’`;
    const resp = await fetch(`/api/preview.pdf?id=${jobId}&t=${T}`);
    const viewer = await pdfViewer(new Uint8Array(await resp.arrayBuffer()));
    if (closed) { viewer.destroy(); return; }
    viewerCleanup = viewer.destroy;
    $('#modalBody').innerHTML = '';
    $('#modalBody').append(viewer.el);
    viewer.start();
    $('#pvSave').disabled = false;
  } catch (err) {
    if (!closed) body.innerHTML = `<div style="font-size:34px">⚠️</div><b>${esc(err.message)}</b>`;
  }
}
$('#imgPreviewBtn').onclick = previewImagesPDF;

// ════════════════════════════════════════════════════════════ PDF 공통 (pdf.js)
async function openPdf(bytes) {
  return pdfjsLib.getDocument({ ...PDF_OPTS, data: bytes.slice() }).promise;
}
function canvasBlob(canvas, type, q) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('이미지를 만들지 못했어요'))), type, q));
}
async function renderPdfPage(doc, n, dpi, maxArea = 36e6) {
  const page = await doc.getPage(n);
  let scale = dpi / 72;
  let vp = page.getViewport({ scale });
  const area = vp.width * vp.height;
  if (area > maxArea) { scale *= Math.sqrt(maxArea / area); vp = page.getViewport({ scale }); }
  const side = Math.max(vp.width, vp.height);
  if (side > 16000) { scale *= 16000 / side; vp = page.getViewport({ scale }); }
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(vp.width));
  c.height = Math.max(1, Math.round(vp.height));
  const g = c.getContext('2d', { alpha: false });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  page.cleanup();
  return c;
}
function freeCanvas(c) { c.width = c.height = 0; }

// 브라우저 PDF 뷰어 설정과 관계없이 항상 보이도록 pdf.js로 직접 그리는 미리보기
async function pdfViewer(bytes) {
  const doc = await openPdf(bytes);
  const el = document.createElement('div');
  el.className = 'pdfview';
  const bar = document.createElement('div');
  bar.className = 'zoombar';
  bar.innerHTML = '<button class="mini" data-z="-">−</button><span>100%</span><button class="mini" data-z="+">＋</button>';
  const pages = document.createElement('div');
  pages.className = 'pdfpages';
  el.append(pages, bar);
  const sizes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const vp = (await doc.getPage(n)).getViewport({ scale: 1 });
    sizes.push([vp.width, vp.height]);
  }
  const zooms = [0.5, 0.75, 1, 1.5, 2, 3];
  let zi = 2, gen = 0;
  const rendered = new Map();
  const io = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) draw(Number(en.target.dataset.n), en.target);
  }, { root: el, rootMargin: '600px' });
  async function draw(n, host) {
    const my = gen;
    if (rendered.get(n) === my) return;
    rendered.set(n, my);
    const cssW = host.clientWidth;
    const dpi = (cssW / sizes[n - 1][0]) * 72 * Math.min(2, devicePixelRatio || 1);
    try {
      const c = await renderPdfPage(doc, n, dpi, 24e6);
      if (my !== gen) { freeCanvas(c); return; }
      c.style.width = '100%';
      c.style.height = '100%';
      host.innerHTML = '';
      host.append(c);
    } catch { /* ignore */ }
  }
  function layout() {
    gen++;
    rendered.clear();
    io.disconnect();
    const fit = Math.max(200, (el.clientWidth || 800) - 60);
    const maxW = Math.max(...sizes.map((s) => s[0]));
    const base = Math.min(fit / maxW, 1.6);
    $('span', bar).textContent = Math.round(zooms[zi] * 100) + '%';
    pages.innerHTML = '';
    sizes.forEach(([w, h], i) => {
      const pg = document.createElement('div');
      pg.className = 'pdfpage';
      pg.dataset.n = i + 1;
      pg.style.width = w * base * zooms[zi] + 'px';
      pg.style.height = h * base * zooms[zi] + 'px';
      pg.innerHTML = '<span class="spin"></span>';
      pages.append(pg);
      io.observe(pg);
    });
  }
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-z]');
    if (!b) return;
    const nz = Math.min(zooms.length - 1, Math.max(0, zi + (b.dataset.z === '+' ? 1 : -1)));
    if (nz !== zi) { zi = nz; layout(); }
  });
  return { el, start: () => requestAnimationFrame(layout), destroy: () => { io.disconnect(); gen++; doc.destroy(); } };
}

async function loadPdfEntry(file) {
  const e = { key: uid(), file, name: file.name, size: file.size, pages: 0, w: 595, h: 842, locked: false, thumbs: new Map() };
  e.bytes = new Uint8Array(await file.arrayBuffer());
  try {
    e.doc = await openPdf(e.bytes);
    e.pages = e.doc.numPages;
    const p1 = await e.doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    e.w = vp.width; e.h = vp.height;
  } catch (err) {
    if (err?.name === 'PasswordException') e.locked = true;
    else throw err;
  }
  return e;
}

// 썸네일은 한 번에 하나씩, 화면에 보이는 것부터
const thumbQueue = [];
let thumbBusy = false;
function queueThumb(entry, page, cb, skip) {
  thumbQueue.push({ entry, page, cb, skip });
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const job = thumbQueue.shift();
    if (job.skip?.()) continue;
    const { entry, page, cb } = job;
    try {
      let url = entry.thumbs.get(page);
      if (!url && entry.doc) {
        const scale = 300 / Math.max(entry.w, entry.h);
        const c = await renderPdfPage(entry.doc, page, 72 * scale);
        url = URL.createObjectURL(await canvasBlob(c, 'image/jpeg', 0.8));
        freeCanvas(c);
        entry.thumbs.set(page, url);
      }
      cb(url);
    } catch { cb(null); }
  }
  thumbBusy = false;
}
function setThumb(imgHost, entry, page = 1) {
  const url = entry.thumbs.get(page);
  if (url) { imgHost.innerHTML = `<img src="${url}">`; return; }
  if (entry.locked || !entry.doc) { imgHost.innerHTML = '🔒'; return; }
  queueThumb(entry, page, (u) => { if (u && imgHost.isConnected) imgHost.innerHTML = `<img src="${u}">`; }, () => !imgHost.isConnected);
}

// ════════════════════════════════════════════════════════════ 2) PDF → 이미지
const P = S.pdf;
const pdfSel = () => P.files.find((f) => f.key === P.selKey) || P.files[0];

async function addPdfs(files) {
  if (!files.length) return;
  $('#pdfCount').innerHTML = `PDF ${P.files.length}개 <span class="spin"></span>`;
  const bad = [];
  for (const f of files) {
    try {
      const e = await loadPdfEntry(f);
      P.files.push(e);
      if (!P.selKey) P.selKey = e.key;
      if (e.locked) toast(`🔒 ‘${f.name}’은(는) 암호로 보호돼 있어 변환할 수 없어요`, 5000);
    } catch { bad.push(f.name); }
  }
  if (bad.length) toast(`⚠️ 읽을 수 없는 PDF ${bad.length}개를 제외했어요: ${bad.slice(0, 3).join(', ')}`, 5000);
  renderPdfMode();
}
function renderPdfMode() {
  const has = P.files.length > 0;
  $('#pdfEmpty').hidden = has;
  $('#pdfFilled').hidden = !has;
  $('#pdfWork').classList.toggle('has', has);
  $('#pdfCount').textContent = `PDF ${P.files.length}개`;
  const list = $('#pdfList');
  list.innerHTML = '';
  const cur = pdfSel();
  for (const e of P.files) {
    const row = document.createElement('div');
    row.className = 'frow' + (e === cur ? ' on' : '');
    row.innerHTML = `<div class="fthumb"></div><div class="finfo"><div class="fname" title="${esc(e.name)}">${esc(e.name)}</div>
      <div class="fmeta">${e.locked ? '🔒 암호 보호 · ' : ''}${e.pages ? e.pages + '쪽 · ' : ''}${fmtBytes(e.size)}</div></div><button class="fx" title="목록에서 빼기">✕</button>`;
    list.append(row);
    setThumb($('.fthumb', row), e);
    row.onclick = (ev) => {
      if (ev.target.closest('.fx')) { P.files = P.files.filter((x) => x !== e); if (P.selKey === e.key) P.selKey = P.files[0]?.key; renderPdfMode(); return; }
      P.selKey = e.key; renderPdfMode();
    };
  }
  renderPdfPages();
  renderPdfSide();
}

let pageObserver;
function renderPdfPages() {
  const e = pdfSel();
  const g = $('#pdfGrid');
  g.innerHTML = '';
  pageObserver?.disconnect();
  if (!e) return;
  $('#pdfTitle').textContent = e.name;
  const inc = new Set(pagesFor(e) || []);
  $('#pdfHint').textContent = e.locked ? '🔒 암호로 보호된 PDF라 페이지를 열 수 없어요'
    : `전체 ${e.pages}쪽 · 변환 대상 ${inc.size}쪽 · 페이지를 누르면 변환 결과를 미리볼 수 있어요`;
  if (e.locked) return;
  const ar = e.w / e.h;
  pageObserver = new IntersectionObserver((ents) => {
    for (const en of ents) {
      if (!en.isIntersecting) continue;
      pageObserver.unobserve(en.target);
      const n = Number(en.target.dataset.page);
      setThumb($('.paper', en.target), e, n);
    }
  }, { root: g.parentElement, rootMargin: '300px' });
  const frag = document.createDocumentFragment();
  for (let n = 1; n <= e.pages; n++) {
    const c = document.createElement('div');
    c.className = 'pcard pdfpage' + (inc.has(n) ? '' : ' out');
    c.dataset.page = n;
    const bw = 136, bh = 168;
    const pw = ar >= bw / bh ? bw : bh * ar, ph = ar >= bw / bh ? bw / ar : bh;
    c.innerHTML = `<div class="pbox"><div class="paper" style="width:${pw}px;height:${ph}px;display:flex;align-items:center;justify-content:center"><span class="spin"></span></div>
      <div class="peye"><span>👁 미리보기</span></div></div><div class="pname">${n}쪽${inc.has(n) ? '' : ' · 제외'}</div>`;
    c.onclick = () => openPagePreview(e, n);
    frag.append(c);
    pageObserver.observe(c);
  }
  g.append(frag);
}
function updatePageMarks() {
  const e = pdfSel();
  if (!e) return;
  const inc = new Set(pagesFor(e) || []);
  $$('#pdfGrid .pcard').forEach((c) => {
    const n = Number(c.dataset.page);
    c.classList.toggle('out', !inc.has(n));
    $('.pname', c).textContent = `${n}쪽${inc.has(n) ? '' : ' · 제외'}`;
  });
  $('#pdfHint').textContent = `전체 ${e.pages}쪽 · 변환 대상 ${inc.size}쪽 · 페이지를 누르면 변환 결과를 미리볼 수 있어요`;
}

function parseRange(text, count) {
  const parts = text.replace(/\s+/g, '').replace(/~/g, '-').split(/[,;]/).filter(Boolean);
  if (!parts.length || count < 1) return null;
  const set = new Set();
  for (const p of parts) {
    const m = p.match(/^(\d*)-(\d*)$/);
    if (m) {
      const lo = m[1] ? +m[1] : 1, hi = m[2] ? +m[2] : count;
      if (lo > hi) return null;
      for (let i = Math.max(1, lo); i <= Math.min(count, hi); i++) set.add(i);
    } else if (/^\d+$/.test(p)) {
      const n = +p;
      if (n >= 1 && n <= count) set.add(n);
    } else return null;
  }
  return [...set].sort((a, b) => a - b);
}
function pagesFor(e) {
  if (!e.pages) return [];
  if (P.range === 'all') return Array.from({ length: e.pages }, (_, i) => i + 1);
  return parseRange(P.rangeText, e.pages);
}
function rangeError() {
  if (P.range !== 'custom') return null;
  if (!P.rangeText.trim()) return '변환할 페이지를 입력해 주세요.';
  const e = pdfSel();
  if (!e || !e.pages) return null;
  const p = parseRange(P.rangeText, e.pages);
  if (!p) return '형식이 올바르지 않아요. 예: 1-3, 5, 8~10';
  if (!p.length) return `이 PDF(${e.pages}쪽)에 해당하는 페이지가 없어요.`;
  return null;
}
function totalPages() { return P.files.filter((f) => !f.locked).reduce((s, f) => s + (pagesFor(f)?.length || 0), 0); }

const FMT_NOTE = {
  jpg: '용량이 작아 공유하기 좋아요. (JPG와 JPEG는 확장자만 달라요)',
  jpeg: '용량이 작아 공유하기 좋아요. (JPG와 JPEG는 확장자만 달라요)',
  png: '손실 없이 저장해요. 글자·도표가 선명하지만 용량이 커요.',
};
function renderPdfSide() {
  setSeg($('#fmtSeg'), P.format);
  $('#fmtNote').textContent = FMT_NOTE[P.format];
  const e = pdfSel();
  renderQuality($('#pdfQuality'), PDF_Q, P.quality, (lv) => `${lv.dpi} DPI`,
    (lv) => (e && e.pages ? `${Math.round(e.w * lv.dpi / 72)}×${Math.round(e.h * lv.dpi / 72)}` : '—'),
    (i) => { P.quality = i; renderPdfSide(); saveUI(); });
  setSeg($('#rangeSeg'), P.range);
  $('#rangeInput').hidden = P.range !== 'custom';
  const err = rangeError();
  const note = $('#rangeNote');
  note.className = 'note' + (err ? ' warn' : '');
  note.textContent = err || (P.range === 'custom' ? `모든 PDF에 같은 범위가 적용돼요. 총 ${totalPages()}쪽을 변환해요.` : `총 ${totalPages()}쪽을 변환해요.`);
  $('#subfolderChk').checked = P.subfolder;
  const nm = e ? baseName(e.name) : '문서';
  $('#pdfNameNote').textContent = `파일 이름 예: ${nm}_001.${P.format}, ${nm}_002.${P.format} …`;
  const busy = P.running;
  $('#pdfConvertBtn').disabled = busy || !P.files.length || !!err || totalPages() === 0;
  $('#pdfPreviewBtn').disabled = busy || !e || e.locked;
}
bindSeg($('#fmtSeg'), (v) => { P.format = v; renderPdfSide(); saveUI(); });
bindSeg($('#rangeSeg'), (v) => { P.range = v; renderPdfSide(); updatePageMarks(); if (v === 'custom') $('#rangeInput').focus(); });
$('#rangeInput').oninput = (e) => { P.rangeText = e.target.value; renderPdfSide(); updatePageMarks(); };
$('#subfolderChk').onchange = (e) => { P.subfolder = e.target.checked; saveUI(); };
$('#pdfClear').onclick = () => { P.files = []; P.selKey = null; renderPdfMode(); };
setupDrop($('#pdfWork'), 'pdf');

function openPagePreview(entry, page) {
  if (!entry || entry.locked) return;
  let n = page, seq = 0, url = null;
  const stage = document.createElement('div');
  stage.className = 'pv-stage';
  const side = document.createElement('div');
  side.className = 'pv-side';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex:1;min-width:0';
  wrap.append(stage, side);
  const renderSide = (info) => {
    const inc = (pagesFor(entry) || []).includes(n);
    side.innerHTML = `
      <div><div class="lbl">형식</div><div class="seg" id="pvFmt"><button data-v="jpg">JPG</button><button data-v="jpeg">JPEG</button><button data-v="png">PNG</button></div></div>
      <div><div class="lbl">해상도</div><div class="radio-list">${PDF_Q.map((q, i) => `<label><input type="radio" name="pvq" value="${i}" ${i === P.quality ? 'checked' : ''}> ${q.t} <span class="note">(${q.dpi} DPI)</span></label>`).join('')}</div></div>
      <hr>
      <div class="lbl">예상 파일 크기</div><div class="bigsize">${info ? fmtBytes(info.bytes) : '<span class="spin"></span>'}</div>
      <div class="kv"><span>이미지 크기</span><b>${info ? `${info.w} × ${info.h} px` : '—'}</b></div>
      <div class="kv"><span>저장 형식</span><b>.${P.format}</b></div><hr>
      <div class="note" style="color:${inc ? 'var(--ok)' : 'var(--muted)'};font-weight:600">${inc ? '✓ 변환 대상에 포함된 페이지' : '– 페이지 범위 밖이라 변환되지 않아요'}</div>`;
    setSeg($('#pvFmt', side), P.format);
    bindSeg($('#pvFmt', side), (v) => { P.format = v; renderPdfSide(); saveUI(); draw(); });
    $$('input[name=pvq]', side).forEach((r) => (r.onchange = () => { P.quality = Number(r.value); renderPdfSide(); saveUI(); draw(); }));
  };
  const draw = async () => {
    const my = ++seq;
    $('#modalPos').textContent = `${n} / ${entry.pages}`;
    $('#modalPrev').disabled = n <= 1;
    $('#modalNext').disabled = n >= entry.pages;
    renderSide(null);
    stage.style.opacity = '.55';
    try {
      const c = await renderPdfPage(entry.doc, n, PDF_Q[P.quality].dpi);
      const type = P.format === 'png' ? 'image/png' : 'image/jpeg';
      const blob = await canvasBlob(c, type, P.format === 'png' ? undefined : 0.86);
      const info = { bytes: blob.size, w: c.width, h: c.height };
      freeCanvas(c);
      if (my !== seq) return;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(blob);
      stage.innerHTML = `<img src="${url}">`;
      stage.style.opacity = '1';
      renderSide(info);
    } catch (err) {
      if (my === seq) stage.innerHTML = `<div class="center-msg">⚠️ ${esc(err.message || '페이지를 그리지 못했어요')}</div>`;
    }
  };
  openModal({
    title: '👀 변환 미리보기', sub: entry.name, pos: '',
    onPrev: () => { if (n > 1) { n--; draw(); } },
    onNext: () => { if (n < entry.pages) { n++; draw(); } },
    body: wrap,
    onClose: () => { seq++; if (url) URL.revokeObjectURL(url); },
  });
  draw();
}
$('#pdfPreviewBtn').onclick = () => {
  const e = pdfSel();
  if (e) openPagePreview(e, (pagesFor(e) || [])[0] || 1);
};

async function convertPdfs() {
  const jobs = P.files.filter((f) => !f.locked).map((f) => ({ f, pages: pagesFor(f) || [] })).filter((j) => j.pages.length);
  const total = jobs.reduce((s, j) => s + j.pages.length, 0);
  if (!total) return;
  P.running = true;
  P.cancel = false;
  renderPdfSide();
  let done = 0;
  const outputs = [];
  const upd = () => { P.status = { kind: 'run', label: '이미지로 저장하는 중…', done, total }; renderStatus($('#pdfStatus'), P.status, () => (P.cancel = true)); };
  upd();
  const lv = PDF_Q[P.quality];
  const type = P.format === 'png' ? 'image/png' : 'image/jpeg';
  try {
    for (const { f, pages } of jobs) {
      if (P.cancel) break;
      const base = baseName(f.name);
      let dir = S.folder;
      if (P.subfolder && pages.length > 1) dir = (await api('/api/mkdir', { folder: S.folder, name: base })).path;
      const digits = Math.max(3, String(f.pages).length);
      for (const n of pages) {
        if (P.cancel) break;
        const c = await renderPdfPage(f.doc, n, lv.dpi);
        const blob = await canvasBlob(c, type, P.format === 'png' ? undefined : 0.86);
        freeCanvas(c);
        const name = f.pages === 1 ? base : `${base}_${String(n).padStart(digits, '0')}`;
        outputs.push(await saveBytes(dir, name, P.format, blob));
        done++;
        upd();
      }
    }
    if (P.cancel) P.status = outputs.length ? { kind: 'ok', title: '중간에 멈췄어요', sub: `${outputs.length}개 이미지는 저장됐어요`, paths: outputs } : null;
    else {
      P.status = { kind: 'ok', title: '변환 완료!', sub: `${outputs.length}개 이미지를 저장했어요`, paths: outputs };
      toast('🎉 이미지를 저장했어요');
      if (S.settings.revealAfter) api('/api/reveal', { paths: outputs }).catch(() => {});
    }
  } catch (err) {
    P.status = { kind: 'err', msg: err.message };
  }
  P.running = false;
  renderStatus($('#pdfStatus'), P.status);
  renderPdfSide();
}
$('#pdfConvertBtn').onclick = convertPdfs;

// ════════════════════════════════════════════════════════════ 3) PDF 용량 줄이기
const Z = S.zip;
const zipSel = () => Z.files.find((f) => f.key === Z.selKey) || Z.files[0];

async function addZips(files) {
  if (!files.length) return;
  const bad = [];
  for (const f of files) {
    try {
      const e = await loadPdfEntry(f);
      e.state = e.locked ? 'err' : 'idle';
      if (e.locked) e.error = '🔒 암호로 보호된 PDF라 줄일 수 없어요';
      Z.files.push(e);
      if (!Z.selKey) Z.selKey = e.key;
    } catch { bad.push(f.name); }
  }
  if (bad.length) toast(`⚠️ 읽을 수 없는 PDF ${bad.length}개를 제외했어요: ${bad.slice(0, 3).join(', ')}`, 5000);
  renderZipMode();
}
function zipSig() { return `${Z.method}|${Z.quality}`; }
function renderZipMode() {
  const has = Z.files.length > 0;
  $('#zipEmpty').hidden = has;
  $('#zipFilled').hidden = !has;
  $('#zipWork').classList.toggle('has', has);
  $('#zipCount').textContent = `PDF ${Z.files.length}개 · 총 ${fmtBytes(Z.files.reduce((s, f) => s + f.size, 0))}`;
  const list = $('#zipList');
  list.innerHTML = '';
  const cur = zipSel();
  for (const e of Z.files) {
    const row = document.createElement('div');
    row.className = 'zrow' + (e === cur ? ' on' : '');
    row.dataset.key = e.key;
    row.innerHTML = zipRowHTML(e);
    list.append(row);
    setThumb($('.fthumb', row), e);
    row.onclick = (ev) => {
      if (ev.target.closest('.fx')) { if (Z.running) return; Z.files = Z.files.filter((x) => x !== e); if (Z.selKey === e.key) Z.selKey = Z.files[0]?.key; renderZipMode(); return; }
      Z.selKey = e.key; $$('.zrow', list).forEach((r) => r.classList.toggle('on', r.dataset.key === e.key));
    };
  }
  renderZipSide();
}
function zipRowHTML(e) {
  const r = e.result && e.result.sig === zipSig() ? e.result : null;
  let state = '', bar = '', after = '';
  if (e.state === 'run') { state = `<span class="zstate">압축 중 ${Math.round(e.progress * 100)}%</span>`; bar = `<div class="zbar"><i style="width:${e.progress * 100}%"></i></div>`; }
  else if (e.state === 'err') state = `<span class="zstate err">${esc(e.error || '실패')}</span>`;
  else if (r && r.same) state = '<span class="zstate same">이미 최적화돼 있어요</span>';
  if (r && !r.same) {
    const pct = Math.round((1 - r.size / e.size) * 100);
    after = `<span>→</span><span class="after">${fmtBytes(r.size)}</span>`;
    bar = `<div class="zbar"><i class="done" style="width:${Math.max(3, 100 - pct)}%"></i></div>`;
    state = `<span class="saving">−${pct}%</span>`;
    if (e.savedSig === zipSig()) state = `<span class="zstate ok">✓ 저장됨</span>` + state;
  }
  return `<div class="fthumb"></div><div class="zinfo"><div class="zname" title="${esc(e.name)}">${esc(e.name)}</div>
    <div class="zsizes"><b>${fmtBytes(e.size)}</b>${after}<span>·</span><span>${e.pages ? e.pages + '쪽' : ''}</span></div>${bar}</div>${state}<button class="fx" title="목록에서 빼기">✕</button>`;
}
function updateZipRow(e) {
  const row = $(`#zipList .zrow[data-key="${e.key}"]`);
  if (!row) return;
  const thumb = $('.fthumb', row).innerHTML;
  row.innerHTML = zipRowHTML(e);
  $('.fthumb', row).innerHTML = thumb;
}
function renderZipSide() {
  setSeg($('#zipMethod'), Z.method);
  renderQuality($('#zipQuality'), ZIP_Q, Z.quality,
    (lv) => (Z.method === 'smart' ? `사진 최대 ${lv.dpi} DPI` : `페이지 ${lv.dpi} DPI`),
    (lv) => `JPEG ${Math.round(lv.q * 100)}%`,
    (i) => { Z.quality = i; renderZipSide(); refreshZipRows(); saveUI(); });
  $('#zipQualityHint').textContent = '💡 ' + ZIP_Q[Z.quality].hint;
  if (document.activeElement !== $('#zipSuffix')) $('#zipSuffix').value = Z.suffix;
  const ok = Z.files.some((f) => !f.locked);
  $('#zipConvertBtn').disabled = Z.running || !ok;
  $('#zipPreviewBtn').disabled = Z.running || !zipSel() || zipSel().locked;
}
function refreshZipRows() { Z.files.forEach(updateZipRow); }
bindSeg($('#zipMethod'), (v) => { Z.method = v; renderZipSide(); refreshZipRows(); saveUI(); });
$('#zipSuffix').oninput = (e) => { Z.suffix = e.target.value; saveUI(); };
$('#zipClear').onclick = () => { if (!Z.running) { Z.files = []; Z.selKey = null; renderZipMode(); } };
setupDrop($('#zipWork'), 'zip');

// ---- 스마트 압축: 글자·도형은 그대로, 사진만 다시 압축
const { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray, PDFDict, PDFRef, PDFBool } = window.PDFLib;
const NM = (s) => PDFName.of(s);
const num = (x) => (x instanceof PDFNumber ? x.asNumber() : undefined);

function colorComps(ctx, cs) {
  if (cs === NM('DeviceRGB') || cs === NM('CalRGB')) return 3;
  if (cs === NM('DeviceGray') || cs === NM('CalGray')) return 1;
  if (cs instanceof PDFArray && cs.size() >= 1) {
    const fam = ctx.lookup(cs.get(0));
    if (fam === NM('ICCBased')) {
      const s = ctx.lookup(cs.get(1));
      const n = num(s?.dict?.lookup(NM('N')));
      return n === 1 || n === 3 ? n : 0;
    }
    if (fam === NM('CalRGB')) return 3;
    if (fam === NM('CalGray')) return 1;
  }
  return 0;
}
// 삽입된 JPEG의 EXIF 회전 정보 제거 (PDF는 회전 정보를 쓰지 않음)
function stripApp1(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const out = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const m = b[i + 1];
    if (m === 0xda) { out.push(b.subarray(i)); break; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m !== 0xe1) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  const total = out.reduce((s, p) => s + p.length, 0);
  const r = new Uint8Array(total);
  let o = 0;
  for (const p of out) { r.set(p, o); o += p.length; }
  return r;
}
async function inflate(u8) {
  const ds = new DecompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer());
}
function unPNG(data, rowLen, bpp, rows) {
  const out = new Uint8Array(rowLen * rows);
  let p = 0;
  for (let y = 0; y < rows; y++) {
    const ft = data[p++];
    const o = y * rowLen, prev = o - rowLen;
    for (let x = 0; x < rowLen; x++) {
      const raw = data[p++];
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: return null;
      }
      out[o + x] = v & 255;
    }
  }
  return out;
}
function stepDown(src, sw, sh, w, h) {
  // 큰 비율로 줄일 때 화질을 위해 절반씩 단계적으로 줄입니다
  let cur = src, cw = sw, ch = sh;
  while (cw / 2 >= w * 1.05 && ch / 2 >= h * 1.05) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = document.createElement('canvas');
    c.width = nw; c.height = nh;
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nh);
    if (cur instanceof HTMLCanvasElement && cur !== src) freeCanvas(cur);
    cur = c; cw = nw; ch = nh;
  }
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const g = out.getContext('2d', { alpha: false });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, w, h);
  if (cur instanceof HTMLCanvasElement && cur !== src) freeCanvas(cur);
  return out;
}
async function recompressImage(ctx, obj, cap, q) {
  const d = obj.dict;
  if (d.lookup(NM('ImageMask')) === PDFBool.True) return null;
  if (d.has(NM('Decode'))) return null;
  if (d.lookup(NM('Mask')) instanceof PDFArray) return null;
  const W = num(d.lookup(NM('Width'))), H = num(d.lookup(NM('Height')));
  if (!W || !H || W * H < 96 * 96 || W * H > 60e6) return null;
  let filter = d.lookup(NM('Filter'));
  if (filter instanceof PDFArray) { if (filter.size() !== 1) return null; filter = ctx.lookup(filter.get(0)); }
  const comps = colorComps(ctx, d.lookup(NM('ColorSpace')));
  if (comps !== 1 && comps !== 3) return null;
  const bpc = num(d.lookup(NM('BitsPerComponent'))) || 8;
  const raw = obj.contents;
  let src;
  if (filter === NM('DCTDecode')) {
    const bmp = await createImageBitmap(new Blob([stripApp1(raw)], { type: 'image/jpeg' }));
    if (bmp.width !== W || bmp.height !== H) { bmp.close(); return null; }
    src = bmp;
  } else if (filter === NM('FlateDecode')) {
    if (bpc !== 8) return null;
    const parms = d.lookup(NM('DecodeParms'));
    let pred = 1;
    if (parms instanceof PDFDict) {
      pred = num(parms.lookup(NM('Predictor'))) || 1;
      const colors = num(parms.lookup(NM('Colors'))) || 1, cols = num(parms.lookup(NM('Columns'))) || 1;
      if (pred >= 10 && (colors !== comps || cols !== W)) return null;
    }
    if (pred !== 1 && pred < 10) return null;
    const data = await inflate(raw);
    const rowLen = W * comps;
    const pix = pred >= 10 ? (data.length >= (rowLen + 1) * H ? unPNG(data, rowLen, comps, H) : null) : data;
    if (!pix || pix.length < rowLen * H) return null;
    const id = new ImageData(W, H);
    const t = id.data;
    for (let i = 0, j = 0; i < W * H; i++, j += comps) {
      const k = i * 4;
      if (comps === 3) { t[k] = pix[j]; t[k + 1] = pix[j + 1]; t[k + 2] = pix[j + 2]; }
      else { t[k] = t[k + 1] = t[k + 2] = pix[j]; }
      t[k + 3] = 255;
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').putImageData(id, 0, 0);
    src = c;
  } else return null;

  const longest = Math.max(W, H);
  const s = Math.min(1, cap / longest);
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const out = stepDown(src, W, H, w, h);
  if (src.close) src.close(); else freeCanvas(src);
  const blob = await canvasBlob(out, 'image/jpeg', q);
  freeCanvas(out);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length >= raw.length * 0.9) return null;
  const nd = d.clone(ctx);
  nd.set(NM('Filter'), NM('DCTDecode'));
  nd.delete(NM('DecodeParms'));
  nd.set(NM('Width'), PDFNumber.of(w));
  nd.set(NM('Height'), PDFNumber.of(h));
  nd.set(NM('BitsPerComponent'), PDFNumber.of(8));
  nd.set(NM('ColorSpace'), NM('DeviceRGB'));
  return PDFRawStream.of(nd, bytes);
}
async function smartCompress(bytes, lv, onProg, canceled) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context;
  let maxIn = 0;
  for (const p of doc.getPages()) { const { width, height } = p.getSize(); maxIn = Math.max(maxIn, width / 72, height / 72); }
  const cap = Math.max(300, Math.round((maxIn || 11.7) * lv.dpi));
  const all = ctx.enumerateIndirectObjects();
  const maskRefs = new Set();
  for (const [, obj] of all) {
    const d = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!d) continue;
    for (const k of ['SMask', 'Mask']) { const v = d.get(NM(k)); if (v instanceof PDFRef) maskRefs.add(v.toString()); }
  }
  const imgs = all.filter(([ref, o]) => o instanceof PDFRawStream && o.dict.lookup(NM('Subtype')) === NM('Image') && !maskRefs.has(ref.toString()));
  let i = 0, changed = 0;
  for (const [ref, obj] of imgs) {
    if (canceled()) throw new Error('canceled');
    try {
      const ns = await recompressImage(ctx, obj, cap, lv.q);
      if (ns) { ctx.assign(ref, ns); changed++; }
    } catch (err) { console.warn('이미지 건너뜀', err); }
    onProg(++i / Math.max(1, imgs.length) * 0.9);
    if (i % 4 === 0) await sleep(0);
  }
  const out = await doc.save({ useObjectStreams: true });
  onProg(1);
  return out;
}
// ---- 강력 압축: 페이지를 이미지로
async function rasterCompress(entry, lv, onProg, canceled) {
  const out = await PDFDocument.create();
  out.setProducer('Flipaper');
  out.setCreator('Flipaper');
  for (let n = 1; n <= entry.pages; n++) {
    if (canceled()) throw new Error('canceled');
    const page = await entry.doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const c = await renderPdfPage(entry.doc, n, lv.dpi);
    const blob = await canvasBlob(c, 'image/jpeg', lv.q);
    freeCanvas(c);
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const p = out.addPage([vp.width, vp.height]);
    p.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
    onProg(n / entry.pages);
  }
  return out.save({ useObjectStreams: true });
}
async function compressEntry(e, canceled) {
  const sig = zipSig();
  if (e.result && e.result.sig === sig) return e.result;
  const lv = ZIP_Q[Z.quality];
  e.state = 'run';
  e.progress = 0;
  e.error = null;
  updateZipRow(e);
  const onProg = (p) => { e.progress = p; updateZipRow(e); };
  let bytes, method = Z.method;
  try {
    if (method === 'smart') {
      try { bytes = await smartCompress(e.bytes, lv, onProg, canceled); }
      catch (err) {
        if (err.message === 'canceled') throw err;
        console.warn('스마트 압축 실패 → 강력 압축으로 진행', err);
        method = 'raster';
        bytes = await rasterCompress(e, lv, onProg, canceled);
      }
    } else bytes = await rasterCompress(e, lv, onProg, canceled);
  } catch (err) {
    e.state = err.message === 'canceled' ? 'idle' : 'err';
    if (e.state === 'err') e.error = '⚠️ 압축하지 못했어요';
    updateZipRow(e);
    throw err;
  }
  e.state = 'idle';
  e.result = { sig, bytes, size: bytes.length, same: bytes.length >= e.size * 0.97, method };
  updateZipRow(e);
  return e.result;
}
async function saveZipResult(e) {
  const r = e.result;
  if (!r || r.same) return null;
  const path = await saveBytes(S.folder, baseName(e.name) + Z.suffix, 'pdf', r.bytes);
  e.savedSig = r.sig;
  e.savedPath = path;
  updateZipRow(e);
  return path;
}

async function compressAll() {
  const list = Z.files.filter((f) => !f.locked);
  if (!list.length) return;
  Z.running = true;
  Z.cancel = false;
  renderZipSide();
  const outputs = [];
  let done = 0, before = 0, after = 0, same = 0;
  const upd = () => { Z.status = { kind: 'run', label: '용량을 줄이는 중…', done, total: list.length }; renderStatus($('#zipStatus'), Z.status, () => (Z.cancel = true)); };
  upd();
  try {
    for (const e of list) {
      if (Z.cancel) break;
      Z.selKey = e.key;
      $$('#zipList .zrow').forEach((r) => r.classList.toggle('on', r.dataset.key === e.key));
      let r;
      try { r = await compressEntry(e, () => Z.cancel); } catch (err) { if (err.message === 'canceled') break; done++; upd(); continue; }
      if (r.same) same++;
      else if (e.savedSig === r.sig && e.savedPath) { outputs.push(e.savedPath); before += e.size; after += r.size; }
      else { const p = await saveZipResult(e); if (p) { outputs.push(p); before += e.size; after += r.size; } }
      done++;
      upd();
    }
    if (outputs.length) {
      const pct = Math.round((1 - after / before) * 100);
      Z.status = { kind: 'ok', title: Z.cancel ? '중간에 멈췄어요' : `완료! 평균 ${pct}% 줄였어요`, sub: `${fmtBytes(before)} → ${fmtBytes(after)} · ${outputs.length}개 저장${same ? ` · ${same}개는 이미 최적화됨` : ''}`, paths: outputs };
      toast(`🎉 ${fmtBytes(before - after)}만큼 가벼워졌어요`);
      if (!Z.cancel && S.settings.revealAfter) api('/api/reveal', { paths: outputs }).catch(() => {});
    } else if (Z.cancel) Z.status = null;
    else Z.status = { kind: 'err', msg: same ? '이미 최적화돼 있어서 더 줄일 수 없었어요. ‘강력 압축’이나 더 낮은 화질을 시도해 보세요.' : '압축하지 못했어요' };
  } catch (err) {
    Z.status = { kind: 'err', msg: err.message };
  }
  Z.running = false;
  renderStatus($('#zipStatus'), Z.status);
  renderZipSide();
}
$('#zipConvertBtn').onclick = compressAll;

async function previewZip() {
  const e = zipSel();
  if (!e || e.locked) return;
  let closed = false, viewer = null;
  const body = document.createElement('div');
  body.className = 'center-msg';
  body.innerHTML = `<div style="font-size:40px">🗜️</div><b>압축 결과를 만드는 중이에요…</b><div class="bar"><i></i></div>`;
  openModal({
    title: '👀 압축 미리보기', sub: e.name, body,
    actions: [{ label: '💾 이대로 저장', primary: true, disabled: true, id: 'zpSave', onClick: async () => {
      try {
        const p = await saveZipResult(e);
        if (p) { Z.status = { kind: 'ok', title: '저장 완료!', sub: p.split('/').pop(), paths: [p] }; renderStatus($('#zipStatus'), Z.status); toast('🎉 저장했어요'); }
        closeModal();
      } catch (err) { toast('⚠️ ' + err.message); }
    } }],
    onClose: () => { closed = true; viewer?.destroy(); },
  });
  Z.running = true;
  renderZipSide();
  const tick = setInterval(() => { if (!closed) { const i = $('.bar i', body); if (i) i.style.width = (e.progress || 0) * 100 + '%'; } }, 150);
  try {
    const r = await compressEntry(e, () => closed);
    clearInterval(tick);
    if (closed) return;
    const pct = Math.round((1 - r.size / e.size) * 100);
    viewer = await pdfViewer(r.bytes);
    if (closed) { viewer.destroy(); return; }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex:1;min-width:0';
    wrap.innerHTML = `<div class="pv-side">
        <div class="compare"><div class="box"><span class="note">원본</span><b>${fmtBytes(e.size)}</b></div><div class="arrow">→</div>
        <div class="box after"><span class="note">압축 후</span><b>${fmtBytes(r.size)}</b></div></div>
        ${r.same ? '<div class="note warn" style="text-align:center;font-weight:700">이미 최적화돼 있어서 더 줄이기 어려워요</div>' : `<div class="bigsize" style="text-align:center;color:var(--ok)">−${pct}%</div>`}
        <hr><div class="kv"><span>방식</span><b>${r.method === 'smart' ? '스마트 압축' : '강력 압축'}</b></div>
        <div class="kv"><span>화질</span><b>${ZIP_Q[Z.quality].t}</b></div>
        <div class="kv"><span>페이지</span><b>${e.pages}쪽</b></div><hr>
        <div class="note">${r.method === 'smart' ? '글자·도형은 그대로이고 사진만 다시 압축했어요. 왼쪽에서 확대해 화질을 확인해 보세요.' : '페이지 전체를 이미지로 바꿨어요. 글자 선택·검색은 되지 않아요.'}</div>
        ${Z.method === 'smart' && r.method === 'raster' ? '<div class="note warn">이 PDF는 구조가 특이해서 강력 압축으로 처리했어요.</div>' : ''}
      </div>`;
    wrap.prepend(viewer.el);
    $('#modalBody').innerHTML = '';
    $('#modalBody').append(wrap);
    viewer.start();
    $('#zpSave').disabled = r.same;
  } catch (err) {
    clearInterval(tick);
    if (!closed) body.innerHTML = `<div style="font-size:34px">⚠️</div><b>${esc(err.message === 'canceled' ? '취소했어요' : '압축하지 못했어요')}</b>`;
  }
  Z.running = false;
  renderZipSide();
}
$('#zipPreviewBtn').onclick = previewZip;

// ════════════════════════════════════════════════════════════ 설정 · 종료
function openSettings() {
  const body = document.createElement('div');
  body.className = 'settings-body';
  const render = () => {
    const st = S.settings;
    const folder = st.resolvedDefaultFolder;
    body.innerHTML = `
      <div class="card"><div class="card-title">🌓 화면 모드</div>
        <div class="seg" id="stTheme"><button data-v="system">시스템 설정</button><button data-v="light">라이트</button><button data-v="dark">다크</button></div>
        <div class="note">‘시스템 설정’을 고르면 macOS의 라이트/다크 모드를 그대로 따라가요.</div></div>
      <div class="card"><div class="card-title">📁 기본 저장 폴더</div>
        <div class="folder-main"><span class="folder-ico">📁</span><div class="folder-text"><div class="folder-name">${esc(folder.split('/').pop() || folder)}</div><div class="folder-path">${esc(shortPath(folder))}</div></div>
        <button class="btn" id="stFolder">변경…</button></div>
        <div class="folder-sub"><span class="note">앱을 켤 때마다 이 폴더가 저장 위치로 선택돼요.</span>${st.defaultFolder ? '<button class="link" id="stReset">다운로드 폴더로 되돌리기</button>' : ''}</div></div>
      <div class="card"><div class="card-title">✅ 변환 후</div>
        <label class="switch-row"><input type="checkbox" id="stReveal" ${st.revealAfter ? 'checked' : ''}><span class="switch"></span>변환이 끝나면 Finder에서 결과 파일 보여주기</label></div>
      <div class="card"><div class="card-title">ℹ️ 정보</div>
        <div class="kv"><span>버전</span><b>Flipaper ${esc(st.build)}</b></div>
        <div class="kv"><span>업데이트</span><b>${U.st?.autoUpdate === false ? '자동 업데이트 꺼짐' : '자동 (6시간마다 확인)'}</b></div>
        <button class="btn" id="stUpdate" style="margin-top:4px">🔄 업데이트 확인…</button>
        <div class="kv"><span>임시 파일</span><b>앱을 끄면 자동으로 지워져요</b></div>
        <button class="btn" id="stQuit" style="margin-top:4px">⏻ Flipaper 종료</button></div>
      <div class="settings-foot">made by. Nevertheless_D</div>`;
    setSeg($('#stTheme', body), st.appearance || 'system');
    bindSeg($('#stTheme', body), async (v) => { applyTheme(v); S.settings = await api('/api/settings', { appearance: v }); render(); });
    $('#stFolder', body).onclick = async () => {
      const j = await api('/api/choose-folder', { start: folder, prompt: '기본으로 사용할 저장 폴더를 선택하세요' }).catch((e) => toast('⚠️ ' + e.message));
      if (j?.path) { S.settings = await api('/api/settings', { defaultFolder: j.path }); S.folder = S.settings.resolvedDefaultFolder; renderFolders(); render(); }
    };
    const rs = $('#stReset', body);
    if (rs) rs.onclick = async () => { S.settings = await api('/api/settings', { defaultFolder: '' }); S.folder = S.settings.resolvedDefaultFolder; renderFolders(); render(); };
    $('#stReveal', body).onchange = async (e) => { S.settings = await api('/api/settings', { revealAfter: e.target.checked }); };
    $('#stQuit', body).onclick = quitApp;
    $('#stUpdate', body).onclick = () => { closeModal(); openUpdate(true); };
  };
  render();
  openModal({ title: '⚙️ Flipaper 설정', body, small: true });
}
$('#settingsBtn').onclick = openSettings;

let ended = false;
function showEnded(msg) {
  ended = true;
  document.body.innerHTML = `<div style="height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;color:var(--muted)">
    <img src="/icon.png" width="84" height="84" style="opacity:.9"><b style="font-size:16px;color:var(--text)">${msg}</b><span>이 창은 닫아도 돼요. 다시 쓰려면 Flipaper 앱을 실행하세요.</span></div>`;
}
async function quitApp() {
  const busy = I.job || P.running || Z.running;
  if (busy && !confirm('변환 중인 작업이 있어요. 그래도 종료할까요?')) return;
  await api('/api/quit').catch(() => {});
  showEnded('Flipaper를 종료했어요 👋');
  setTimeout(() => window.close(), 400);
}
$('#quitBtn').onclick = quitApp;

// ════════════════════════════════════════════════════════════ 버전 · 업데이트
// 앱이 GitHub(NeverthelessD/Filpaper)의 releases/latest.json 을 보고 새 버전을 받아요.
const U = { st: null, open: false, poll: null, restarting: false, toldReady: '' };

async function refreshUpdate() {
  try { U.st = await api('/api/update/state'); } catch { return; }
  renderVersion();
  const sig = JSON.stringify(U.st);
  if (U.open && sig !== U.sig) renderUpdate();
  U.sig = sig;
  const st = U.st;
  if (st.status === 'ready' && st.installed && U.toldReady !== st.installed && !U.open) {
    U.toldReady = st.installed;
    toast(`✨ Flipaper ${st.installed} 준비 완료! 오른쪽 위 배지를 눌러 다시 시작하세요.`, 6000);
  }
  // 받는 중이면 자주, 아니면 가끔 확인
  const busy = st.status === 'downloading' || st.status === 'installing' || st.status === 'checking';
  clearTimeout(U.poll);
  U.poll = setTimeout(refreshUpdate, busy || U.open ? 700 : 30000);
}

function renderVersion() {
  const st = U.st;
  if (!st) return;
  const b = $('#verBadge');
  let txt = 'v' + st.current, isNew = false;
  if (st.status === 'available') { txt = `새 버전 ${st.latest.version}`; isNew = true; }
  else if (st.status === 'downloading') { txt = `받는 중 ${Math.round(st.progress * 100)}%`; isNew = true; }
  else if (st.status === 'installing') { txt = '설치 중…'; isNew = true; }
  else if (st.status === 'ready') { txt = '다시 시작해서 업데이트'; isNew = true; }
  $('#verText').textContent = txt;
  b.classList.toggle('new', isNew);
}

const updBody = document.createElement('div');
updBody.className = 'upd-body';

function fmtWhen(ms) {
  if (!ms) return '아직 확인 안 함';
  const d = new Date(ms), now = new Date();
  const hm = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? `오늘 ${hm}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm}`;
}

function renderUpdate() {
  const st = U.st;
  if (!st) return;
  const L = st.latest;
  let t1 = '', t2 = '', showVers = false, acts = [];
  switch (st.status) {
    case 'checking': t1 = '새 버전을 확인하고 있어요…'; t2 = 'GitHub에 물어보는 중이에요.'; break;
    case 'available':
      t1 = '새 버전이 나왔어요! 🎉'; t2 = '받는 데 몇 초면 끝나요. 하던 작업은 그대로 둬도 돼요.'; showVers = true;
      acts = [{ label: '⬇︎ 지금 업데이트', primary: true, onClick: installUpdate }]; break;
    case 'downloading': t1 = '새 버전을 받고 있어요…'; t2 = `${Math.round(st.progress * 100)}%`; showVers = true; break;
    case 'installing': t1 = '설치하고 있어요…'; t2 = '잠시만 기다려 주세요.'; showVers = true; break;
    case 'ready':
      t1 = `Flipaper ${st.installed} 준비 완료 ✨`; t2 = '다시 시작하면 새 버전으로 바뀌어요. (몇 초 걸려요)';
      acts = [{ label: '↻ 지금 다시 시작', primary: true, onClick: restartApp }]; break;
    case 'uptodate': t1 = '최신 버전을 쓰고 있어요 👍'; t2 = `Flipaper ${st.current}`; break;
    case 'error': t1 = '업데이트를 확인하지 못했어요'; t2 = '인터넷 연결을 확인한 뒤 다시 시도해 주세요.'; break;
    default: t1 = `Flipaper ${st.current}`; t2 = '버튼을 눌러 새 버전이 있는지 확인해 보세요.';
  }
  const busy = ['checking', 'downloading', 'installing'].includes(st.status);
  if (!['available', 'ready'].includes(st.status)) acts = [{ label: '🔄 업데이트 확인', primary: true, disabled: busy, onClick: checkUpdate }];
  const notes = (st.status === 'available' || st.status === 'downloading' || st.status === 'installing' || st.status === 'ready') && L?.notes?.length
    ? `<div class="card"><div class="card-title">📝 ${esc(L.version)}에서 바뀐 점</div><ul class="upd-notes">${L.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : '';
  updBody.innerHTML = `
    <div class="upd-hero"><img src="/icon.png" alt=""><div><div class="t1">${t1}</div><div class="t2">${esc(t2)}</div></div></div>
    ${showVers && L ? `<div class="upd-vers"><div class="upd-ver"><small>지금 버전</small><b>${esc(st.current)}</b></div><span class="upd-arrow">➜</span><div class="upd-ver new"><small>새 버전</small><b>${esc(L.version)}</b></div></div>` : ''}
    ${st.status === 'downloading' || st.status === 'installing' ? `<div class="upd-bar"><i style="width:${st.status === 'installing' ? 100 : Math.round(st.progress * 100)}%"></i></div>` : ''}
    ${st.status === 'error' && st.error ? `<div class="upd-err">${esc(st.error)}</div>` : ''}
    ${notes}
    <div class="card">
      <label class="switch-row"><input type="checkbox" id="updAuto" ${st.autoUpdate ? 'checked' : ''}><span class="switch"></span>자동 업데이트 (새 버전을 알아서 받아 둬요)</label>
      <div class="kv"><span>지금 버전</span><b>Flipaper ${esc(st.current)}</b></div>
      <div class="kv"><span>마지막 확인</span><b>${fmtWhen(st.lastCheck)}</b></div>
      ${st.canRollback ? `<div class="folder-sub"><span class="note">문제가 생겼다면 이전 버전(${esc(st.backupVersion)})으로 되돌릴 수 있어요.</span><button class="link" id="updRollback">되돌리기</button></div>` : ''}
    </div>`;
  $('#updAuto', updBody).onchange = async (e) => {
    S.settings = await api('/api/settings', { autoUpdate: e.target.checked });
    U.st.autoUpdate = e.target.checked;
    toast(e.target.checked ? '✅ 자동 업데이트를 켰어요' : '자동 업데이트를 껐어요. 필요할 때 직접 확인하세요.');
  };
  const rb = $('#updRollback', updBody);
  if (rb) rb.onclick = rollbackUpdate;
  setModalActions(acts);
}

function openUpdate(check = false) {
  U.open = true;
  openModal({ title: '🔄 업데이트', body: updBody, small: true, onClose: () => { U.open = false; refreshUpdate(); } });
  renderUpdate();
  if (check && !['available', 'ready', 'downloading', 'installing'].includes(U.st?.status)) checkUpdate();
  else refreshUpdate();
}
$('#verBadge').onclick = () => openUpdate(true);

async function checkUpdate() {
  if (U.st) { U.st.status = 'checking'; renderUpdate(); renderVersion(); }
  try { U.st = await api('/api/update/check'); } catch (e) { toast('⚠️ ' + e.message); }
  refreshUpdate();
}
async function installUpdate() {
  try { await api('/api/update/install', {}); } catch (e) { toast('⚠️ ' + e.message); }
  if (U.st) { U.st.status = 'downloading'; U.st.progress = 0; renderUpdate(); }
  refreshUpdate();
}
async function rollbackUpdate() {
  if (!confirm(`이전 버전(${U.st.backupVersion})으로 되돌릴까요?\n되돌리면 자동 업데이트는 꺼져요. (설정에서 다시 켤 수 있어요)`)) return;
  try { await api('/api/update/rollback', {}); } catch (e) { toast('⚠️ ' + e.message); return; }
  toast('↩︎ 이전 버전을 준비했어요. 다시 시작하면 바뀌어요.');
  refreshUpdate();
}

async function restartApp() {
  const busy = I.job || P.running || Z.running;
  if (busy && !confirm('변환 중인 작업이 있어요. 끝난 뒤에 다시 시작하는 게 좋아요.\n그래도 지금 다시 시작할까요?')) return;
  const from = U.st?.current;
  U.restarting = true;
  closeModal();
  const veil = document.createElement('div');
  veil.className = 'restart-veil';
  veil.innerHTML = '<img src="/icon.png" alt="">새 버전으로 다시 시작하고 있어요…<span>창을 닫지 말고 잠시만 기다려 주세요.</span>';
  document.body.append(veil);
  try { await api('/api/update/restart', {}); }
  catch (e) { veil.remove(); U.restarting = false; toast('⚠️ ' + e.message); return; }
  const t0 = Date.now();
  const tick = async () => {
    try {
      const j = await api('/api/ping');
      if (j.build && j.build !== from) { location.reload(); return; }
    } catch { /* 아직 다시 켜지는 중 */ }
    if (Date.now() - t0 > 60000) { showEnded('다시 시작에 시간이 걸리고 있어요. Flipaper 앱을 다시 실행해 주세요.'); return; }
    setTimeout(tick, 600);
  };
  setTimeout(tick, 1200);
}

// 연결 유지 (창이 열려 있는 동안 앱 엔진이 꺼지지 않게)
let pingFails = 0;
setInterval(async () => {
  if (ended || U.restarting) return;
  try { await api('/api/ping'); pingFails = 0; }
  catch { if (++pingFails >= 2) showEnded('Flipaper 엔진이 종료되었어요'); }
}, 20000);

// ════════════════════════════════════════════════════════════ 단축키
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'radio' && document.activeElement.type !== 'range';
  if (M.open) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    else if (e.key === 'ArrowLeft' && M.onPrev && !typing) { e.preventDefault(); M.onPrev(); }
    else if (e.key === 'ArrowRight' && M.onNext && !typing) { e.preventDefault(); M.onNext(); }
    return;
  }
  if (e.key === 'Escape') hideMenus();
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pickPick(S.mode); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    const btn = { img: '#imgConvertBtn', pdf: '#pdfConvertBtn', zip: '#zipConvertBtn' }[S.mode];
    if (!$(btn).disabled) $(btn).click();
    return;
  }
  if (typing || S.mode !== 'img') return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && I.sel.size) { e.preventDefault(); removeImages(new Set(I.sel)); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); I.sel = new Set(I.items.map((x) => x.key)); updateSel(); }
});

// ════════════════════════════════════════════════════════════ 시작
(async function init() {
  try {
    S.settings = await api('/api/settings');
  } catch (err) {
    showEnded('앱 엔진에 연결하지 못했어요');
    return;
  }
  applyTheme(S.settings.appearance);
  S.folder = S.settings.resolvedDefaultFolder;
  const ui = S.settings.ui || {};
  Object.assign(I, ui.img || {});
  Object.assign(P, ui.pdf || {});
  Object.assign(Z, ui.zip || {});
  renderFolders();
  renderImgSide();
  renderImgGrid();
  renderPdfMode();
  renderZipMode();
  setMode(ui.mode || 'img');
  requestAnimationFrame(movePill);
  document.fonts?.ready.then(movePill);
  $('#verText').textContent = 'v' + S.settings.build;
  refreshUpdate();
})();
