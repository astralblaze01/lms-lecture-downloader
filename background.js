// LMS 강의 원클릭 다운로더 - background service worker
//
// 감지 (탭별로 storage.session에 저장 → 서비스워커가 잠들어도 유지)
//   1) LearningX 모드: 어느 사이트든 https://<host>/em/<ID> 요청이 보이면
//      같은 호스트의 content.php에서 강의 제목·영상 주소를 가져옴 (학교 목록 불필요)
//   2) 영상 스니핑 모드: 탭에서 재생된 mp4/webm 등 영상 요청을 그 요청의 Referer와 함께 기록
//      (HLS(.m3u8) 스트리밍은 감지만 하고 미지원 안내)
//
// 다운로드
//   - offscreen 페이지가 fetch로 8MB씩 Range 요청 (파일당 동시 연결 2~8개, 기본 6) → 끊기면 그 조각만 재시도 → Blob → chrome.downloads로 저장
//   - Referer는 호스트별 DNR 세션 규칙으로 붙임 (tabIds: [-1] → 확장 자신의 요청에만 적용, 일반 브라우징엔 영향 없음)
//   - 연속 클릭 → 대기열, 동시 다운로드 1~3개
//   - 팝업 스위치로 감지 끄기/켜기 (끄면 webRequest 리스너 제거, 배지 OFF)

const LX_EM = /^https?:\/\/([^/]+)\/em\/([A-Za-z0-9]+)(?:[/?#]|$)/;
const MEDIA_EXT = /\.(mp4|m4v|webm|mov|mkv)$/i;
const HLS_EXT = /\.m3u8$/i;
const MIN_MEDIA_BYTES = 1024 * 1024; // 1MB 미만(광고·효과음 등)은 무시
const DEFAULT_PARALLEL = 1;
const DEFAULT_CONNECTIONS = 6; // 파일 하나당 동시 연결 수 (크롬의 호스트당 HTTP/1.1 한도 6)

// ---------- 직렬화 락 ----------
let chain = Promise.resolve();
function withLock(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const S = (keys) => chrome.storage.session.get(keys);
const progress = {}; // url -> { received, total, fails }
const pathOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };

// ---------- 탭별 감지 저장 ----------
function updateTab(tabId, mutate) {
  return withLock(async () => {
    const { tabs = {} } = await S('tabs');
    const t = tabs[tabId] || { lx: [], media: [], hls: false };
    if (!mutate(t)) return; // 변경 없으면 저장 생략
    tabs[tabId] = t;
    await chrome.storage.session.set({ tabs });
    const n = t.lx.length + t.media.length;
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#10B981' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: n ? String(n) : (t.hls ? '!' : '') }).catch(() => {});
  });
}

function forgetTab(tabId) {
  withLock(async () => {
    const { tabs = {} } = await S('tabs');
    if (tabs[tabId]) {
      delete tabs[tabId];
      await chrome.storage.session.set({ tabs });
    }
  });
}
chrome.tabs.onRemoved.addListener(forgetTab);

// 최상위 페이지 이동(main_frame)이 오면 그 탭의 감지 목록 초기화
// (그 페이지의 하위 요청보다 항상 먼저 오므로 순서가 보장됨)
chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId >= 0) forgetTab(d.tabId); },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

// 1) LearningX 플레이어 (/em/<ID>) — URL 필터로 /em/ 경로만 감시
const EM_FILTER = { urls: ['*://*/em/*'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'other'] };
const onEmRequest = (d) => {
    if (d.tabId < 0) return;
    const m = d.url.match(LX_EM);
    if (!m) return;
    const origin = new URL(d.url).origin;
    const id = m[2];
    updateTab(d.tabId, (t) => {
      if (t.lx.some((x) => x.id === id && x.origin === origin)) return false;
      t.lx.push({ origin, id, embed: d.url });
      return true;
    });
};

// 2) 영상 스니핑: 요청 헤더에서 Referer 확보 → 응답 헤더에서 영상인지/크기 확인
//    Referer를 읽으려면 'extraHeaders'가 필요한데, 이건 해당 요청을 느린 경로로 처리하게 만듦.
//    그래서 모든 요청이 아니라 <video> 요청(media)과 영상 확장자 URL에만 건다.
const pendingRef = new Map(); // requestId -> referer
const VIDEO_URLS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'm3u8'].map((e) => `*://*/*.${e}*`);
const SNIFF_FILTERS = [
  { urls: ['<all_urls>'], types: ['media'] },
  { urls: VIDEO_URLS, types: ['xmlhttprequest', 'other', 'object'] }
];

function onSendHeaders(d) {
  if (d.tabId < 0) return;
  const p = pathOf(d.url);
  if (HLS_EXT.test(p)) {
    updateTab(d.tabId, (t) => { if (t.hls) return false; t.hls = true; return true; });
    return;
  }
  if (d.type !== 'media' && !MEDIA_EXT.test(p)) return;
  const ref = d.requestHeaders?.find((h) => h.name.toLowerCase() === 'referer')?.value || '';
  pendingRef.set(d.requestId, ref);
  if (pendingRef.size > 500) pendingRef.delete(pendingRef.keys().next().value);
}

function onHeadersReceived(d) {
  if (!pendingRef.has(d.requestId)) return;
  const referer = pendingRef.get(d.requestId);
  pendingRef.delete(d.requestId);
  if (d.statusCode >= 400) return;
  const h = (n) => d.responseHeaders?.find((x) => x.name.toLowerCase() === n)?.value || '';
  const ctype = h('content-type').toLowerCase();
  const p = pathOf(d.url);
  if (ctype.includes('mpegurl')) return;
  const isVideo = ctype.startsWith('video/') || (MEDIA_EXT.test(p) && !ctype.startsWith('text/'));
  if (!isVideo) return;
  const cr = h('content-range').match(/\/(\d+)\s*$/);
  const size = cr ? parseInt(cr[1], 10) : parseInt(h('content-length') || '0', 10) || null;
  if (size && size < MIN_MEDIA_BYTES) return;
  updateTab(d.tabId, (t) => {
    const ex = t.media.find((x) => pathOf(x.url) === p);
    if (ex) {
      if (size && !ex.size) { ex.size = size; return true; }
      return false;
    }
    t.media.push({ url: d.url, referer, size, ctype });
    return true;
  });
}

// ---------- 켜기/끄기 ----------
// 끄면 감지용 webRequest 리스너를 아예 떼어냄 → 일반 브라우징에 부담 0, 서비스워커도 이 요청들로 깨지 않음
// (진행 중인 다운로드·대기열은 그대로 끝까지 진행)
// 같은 함수를 두 번 addListener하면 크롬이 두 번째를 무시하므로, 필터마다 새 함수로 감싼다
const detectors = [[chrome.webRequest.onBeforeRequest, onEmRequest, EM_FILTER]];
for (const f of SNIFF_FILTERS) {
  detectors.push([chrome.webRequest.onSendHeaders, (d) => onSendHeaders(d), f, ['requestHeaders', 'extraHeaders']]);
  detectors.push([chrome.webRequest.onHeadersReceived, (d) => onHeadersReceived(d), f, ['responseHeaders']]);
  detectors.push([chrome.webRequest.onErrorOccurred, (d) => pendingRef.delete(d.requestId), f]);
}

function setDetection(on) {
  for (const [ev, fn, filter, extra] of detectors) {
    if (on && !ev.hasListener(fn)) extra ? ev.addListener(fn, filter, extra) : ev.addListener(fn, filter);
    if (!on && ev.hasListener(fn)) ev.removeListener(fn);
  }
}

async function applyEnabled(on) {
  setDetection(on);
  if (on) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  pendingRef.clear();
  // 감지 목록과 탭별 배지 지우고 전체 배지를 OFF로
  await withLock(async () => {
    const { tabs = {} } = await S('tabs');
    for (const id of Object.keys(tabs)) chrome.action.setBadgeText({ tabId: Number(id), text: '' }).catch(() => {});
    await chrome.storage.session.set({ tabs: {} });
  });
  chrome.action.setBadgeBackgroundColor({ color: '#9CA3AF' });
  chrome.action.setBadgeText({ text: 'OFF' });
}

// 서비스워커가 깨어날 때마다 리스너는 동기적으로 먼저 등록하고(MV3 규칙), 꺼져 있으면 바로 떼어냄
setDetection(true);
chrome.storage.local.get('enabled').then(({ enabled = true }) => { if (!enabled) applyEnabled(false); });
// 브라우저를 새로 켰을 때도 서비스워커를 깨워서 OFF 배지를 다시 표시
chrome.runtime.onStartup.addListener(() => {});

// ---------- 호스트별 Referer 규칙 (확장 자신의 요청에만 적용) ----------
// 락 안에서 호출해도 되도록 내부에서 withLock을 쓰지 않음
let refChain = Promise.resolve();
function setReferer(url, referer) {
  const run = async () => {
    if (!referer) return;
    const host = new URL(url).hostname;
    const { refRules = {}, refNextId = 1000 } = await S(['refRules', 'refNextId']);
    const cur = refRules[host];
    if (cur && cur.referer === referer) return;
    const id = cur ? cur.id : refNextId;
    let origin = '';
    try { origin = new URL(referer).origin; } catch {}
    const requestHeaders = [{ header: 'Referer', operation: 'set', value: referer }];
    if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          requestDomains: [host],
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest', 'media', 'other']
        }
      }]
    });
    refRules[host] = { id, referer };
    await chrome.storage.session.set({ refRules, refNextId: cur ? refNextId : refNextId + 1 });
  };
  const p = refChain.then(run, run);
  refChain = p.catch((e) => console.warn('setReferer failed', e));
  return p;
}

// ---------- offscreen ----------
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: '강의 영상을 조각 단위로 받아 Blob으로 저장'
    }).catch((e) => { if (!/single offscreen/i.test(e.message)) throw e; })
      .finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}
const toOffscreen = (m) => chrome.runtime.sendMessage({ ...m, target: 'offscreen' }).catch(() => {});

// ---------- 대기열 ----------
async function getParallel() {
  const { parallel } = await chrome.storage.local.get('parallel');
  return Math.min(Math.max(parseInt(parallel, 10) || DEFAULT_PARALLEL, 1), 3);
}

async function getConnections() {
  const { connections } = await chrome.storage.local.get('connections');
  return Math.min(Math.max(parseInt(connections, 10) || DEFAULT_CONNECTIONS, 1), 8);
}

function updateTitle(n) {
  chrome.action.setTitle({ title: n ? `강의 다운로드 (진행/대기 ${n}개)` : '강의 다운로드' });
}

function pump() {
  return withLock(async () => {
    const { queue = [], active = [] } = await S(['queue', 'active']);
    const parallel = await getParallel();
    const toStart = [];
    while (active.length < parallel && queue.length) {
      const next = queue.shift();
      active.push({ ...next, phase: 'fetching' });
      toStart.push(next);
    }
    await chrome.storage.session.set({ queue, active });
    updateTitle(queue.length + active.length);
    if (toStart.length) {
      await ensureOffscreen();
      const connections = await getConnections();
      for (const job of toStart) {
        await setReferer(job.url, job.referer);
        toOffscreen({ action: 'start', job: { ...job, connections } });
      }
    }
  });
}

async function setFailed(url, error) {
  const { failed = {} } = await S('failed');
  failed[url] = error || '알 수 없는 오류';
  await chrome.storage.session.set({ failed });
}

function enqueue(items) {
  return withLock(async () => {
    const { queue = [], active = [], failed = {} } = await S(['queue', 'active', 'failed']);
    let added = 0;
    for (const it of items) {
      if (queue.some((q) => q.url === it.url) || active.some((a) => a.url === it.url)) continue;
      delete failed[it.url];
      queue.push({ url: it.url, filename: it.filename, title: it.title, referer: it.referer });
      added++;
    }
    await chrome.storage.session.set({ queue, failed });
    return added;
  }).then(async (added) => { await pump(); return added; });
}

function onJobDone(url, blobUrl) {
  return withLock(async () => {
    const { active = [] } = await S('active');
    const a = active.find((x) => x.url === url);
    if (!a) { toOffscreen({ action: 'release', url }); return; }
    const start = (filename) => chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false });
    try {
      let downloadId;
      try {
        downloadId = await start(a.filename);
      } catch (e) {
        if (!/filename/i.test(e.message)) throw e;
        const dir = a.filename.includes('/') ? a.filename.slice(0, a.filename.lastIndexOf('/') + 1) : '';
        const ext = a.filename.split('.').pop();
        downloadId = await start(`${dir}lecture_${Date.now()}.${ext}`);
      }
      a.phase = 'saving';
      a.downloadId = downloadId;
    } catch (e) {
      active.splice(active.indexOf(a), 1);
      toOffscreen({ action: 'release', url });
      await setFailed(url, `저장 실패: ${e.message}`);
    }
    await chrome.storage.session.set({ active });
  }).then(pump);
}

function onJobFailed(url, error) {
  return withLock(async () => {
    const { active = [] } = await S('active');
    const i = active.findIndex((x) => x.url === url);
    if (i >= 0) active.splice(i, 1);
    delete progress[url];
    await chrome.storage.session.set({ active });
    if (error !== '취소됨') await setFailed(url, error);
  }).then(pump);
}

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  withLock(async () => {
    const { active = [] } = await S('active');
    const a = active.find((x) => x.downloadId === delta.id);
    if (!a) return;
    active.splice(active.indexOf(a), 1);
    toOffscreen({ action: 'release', url: a.url });
    delete progress[a.url];
    if (state === 'complete') {
      const { done = {} } = await chrome.storage.local.get('done');
      done[pathOf(a.url)] = delta.id;
      await chrome.storage.local.set({ done });
    } else {
      await setFailed(a.url, `저장 중단: ${delta.error?.current || ''}`);
    }
    await chrome.storage.session.set({ active });
  }).then(pump);
});

// ---------- 상태 조회 ----------
async function getStatus(urls) {
  const { queue = [], active = [], failed = {} } = await S(['queue', 'active', 'failed']);
  const { done = {} } = await chrome.storage.local.get('done');
  const out = {};
  for (const url of urls) {
    const a = active.find((x) => x.url === url);
    if (a) {
      if (a.phase === 'saving') { out[url] = { state: 'saving' }; continue; }
      const p = progress[url] || {};
      const pct = p.total ? Math.floor((p.received / p.total) * 100) : null;
      out[url] = { state: p.fails ? 'retrying' : 'downloading', pct, retries: p.fails || 0, received: p.received || 0, speed: p.speed || 0 };
      continue;
    }
    const qi = queue.findIndex((x) => x.url === url);
    if (qi >= 0) { out[url] = { state: 'queued', pos: qi + 1 }; continue; }
    if (failed[url]) { out[url] = { state: 'failed', error: failed[url] }; continue; }
    const did = done[pathOf(url)];
    if (did != null) {
      const [d] = await chrome.downloads.search({ id: did });
      if (d && d.state === 'complete' && d.exists) { out[url] = { state: 'complete', downloadId: d.id }; continue; }
    }
    out[url] = { state: 'none' };
  }
  return { items: out, queued: queue.length, active: active.length };
}

// ---------- 메시지 ----------
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.target === 'offscreen') return false;

  if (req.target === 'background') {
    if (req.action === 'progress') progress[req.url] = { received: req.received, total: req.total, fails: req.fails, speed: req.speed || 0 };
    else if (req.action === 'jobDone') onJobDone(req.url, req.blobUrl);
    else if (req.action === 'jobFailed') onJobFailed(req.url, req.error);
    return false;
  }

  (async () => {
    switch (req.action) {
      case 'getDetected': {
        const { tabs = {} } = await S('tabs');
        return tabs[req.tabId] || { lx: [], media: [], hls: false };
      }
      case 'getMetadata': {
        // LearningX content.php (같은 호스트) → 강의 제목·영상 주소 XML
        // 한 번 받은 정보는 세션 동안 캐시 (팝업을 다시 열 때 재요청 안 함)
        const key = `meta:${req.origin}|${req.id}`;
        const cached = (await chrome.storage.session.get(key))[key];
        if (cached) return { xml: cached };
        const url = `${req.origin}/viewer/ssplayer/uniplayer_support/content.php?content_id=${encodeURIComponent(req.id)}`;
        await setReferer(url, `${req.origin}/`);
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const xml = await res.text();
        chrome.storage.session.set({ [key]: xml }).catch(() => {});
        return { xml };
      }
      case 'enqueue':
        return { added: await enqueue(req.items || []) };
      case 'getStatus':
        return getStatus(req.urls || []);
      case 'cancelAll':
        await withLock(async () => {
          const { active = [] } = await S('active');
          for (const a of active) if (a.downloadId) await chrome.downloads.cancel(a.downloadId).catch(() => {});
          toOffscreen({ action: 'cancelAll' });
          await chrome.storage.session.set({ queue: [], active: [] });
        });
        updateTitle(0);
        return { ok: true };
      case 'setEnabled':
        await chrome.storage.local.set({ enabled: !!req.value });
        await applyEnabled(!!req.value);
        return { ok: true };
      case 'setConnections':
        // 다음에 시작하는 다운로드부터 적용
        await chrome.storage.local.set({ connections: req.value });
        return { ok: true };
      case 'setParallel':
        await chrome.storage.local.set({ parallel: req.value });
        await pump();
        return { ok: true };
      default:
        return undefined;
    }
  })()
    .then((r) => sendResponse(r))
    .catch((e) => sendResponse({ error: e.message }));
  return true;
});
