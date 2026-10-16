const $ = (s) => document.querySelector(s);
const listEl = $('#list');
const msgEl = $('#msg');
const lectures = []; // { title, url, ext, referer, filename, kind, el, statusEl }

const send = (m) => new Promise((resolve) => chrome.runtime.sendMessage(m, (r) => resolve(r || {})));
const pathOf = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };

function showMsg(t) {
  msgEl.textContent = t;
  msgEl.hidden = !t;
}

function safeName(s) {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 150) || 'lecture';
}

// canvas.knu.ac.kr → knu, canvas.ssu.ac.kr → ssu, lms.foo.edu → foo
function siteKey(host) {
  const parts = host.split('.');
  const i = parts.findIndex((p, idx) => idx > 0 && ['ac', 'edu', 'co', 'or', 'go', 'com', 'net', 'org', 'kr'].includes(p));
  return (i > 0 ? parts[i - 1] : parts[0]) || 'site';
}

// LearningX content.php XML → 실제 영상 주소
function parseMetadata(xmlText) {
  const dom = new DOMParser().parseFromString(xmlText, 'text/xml');
  const titleEl = dom.querySelector('content_metadata title');
  if (!titleEl) throw new Error('제목 정보 없음');
  const title = titleEl.textContent.trim();
  const type = (dom.querySelector('content_playing_info content_type')?.textContent || '').trim().toLowerCase();

  let url, ext;
  if (type === 'upf') {
    const mainMedia = dom.querySelector('main_media')?.textContent.trim();
    const tmpl = (dom.querySelector('service_root media_uri[method="progressive"]') ||
                  dom.querySelector('service_root media_uri'))?.textContent.trim();
    if (!mainMedia || !tmpl) throw new Error('영상 주소 정보 없음');
    url = tmpl.replace('[MEDIA_FILE]', mainMedia);
    ext = mainMedia.split('.').pop().trim();
  } else {
    const cpi = dom.querySelector('content_playing_info');
    const uris = cpi ? Array.from(cpi.getElementsByTagName('media_uri')) : [];
    const el = uris.find((e) => e.hasAttribute('auth_value')) || uris[0];
    if (!el) throw new Error('영상 주소 정보 없음');
    const base = el.textContent.trim();
    const auth = el.getAttribute('auth_value');
    url = auth ? `${base}${base.includes('?') ? '&' : '?'}token=${auth}` : base;
    ext = base.split('?')[0].split('.').pop();
  }
  if (/m3u8/i.test(url)) throw new Error('HLS 스트리밍 형식 (미지원)');
  if (!/^[a-z0-9]{2,4}$/i.test(ext)) ext = 'mp4';
  return { title, url, ext };
}

function render(lec) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.className = 'lec';
  btn.textContent = lec.title;
  btn.title = lec.kind === 'media' ? `페이지에서 재생된 영상\n${lec.url}` : '클릭하면 다운로드 대기열에 추가';
  const st = document.createElement('div');
  st.className = 'status';
  if (lec.sub) st.dataset.sub = lec.sub;
  li.append(btn, st);
  listEl.appendChild(li);
  lec.el = li;
  lec.statusEl = st;
  btn.addEventListener('click', () => onClick(lec));
}

const pick = (l) => ({ url: l.url, filename: l.filename, title: l.title, referer: l.referer });

async function onClick(lec) {
  if (lec.state === 'complete' && lec.downloadId) {
    chrome.downloads.show(lec.downloadId);
    return;
  }
  if (['queued', 'downloading', 'retrying', 'saving'].includes(lec.state)) return;
  lec.statusEl.textContent = '대기열에 추가 중...';
  await send({ action: 'enqueue', items: [pick(lec)] });
  refresh();
}

function fmtMB(n) {
  return n ? `${(n / 1048576).toFixed(n > 104857600 ? 0 : 1)}MB` : '';
}

async function refresh() {
  if (!lectures.length) return;
  const r = await send({ action: 'getStatus', urls: lectures.map((l) => l.url) });
  if (!r.items) return;
  for (const l of lectures) {
    const s = r.items[l.url] || { state: 'none' };
    l.state = s.state;
    l.downloadId = s.downloadId;
    l.el.dataset.state = s.state;
    let t = '';
    switch (s.state) {
      case 'queued': t = `대기 중 (${s.pos}번째)`; break;
      case 'downloading': t = s.pct != null ? `다운로드 중 ${s.pct}%` : `다운로드 중 ${fmtMB(s.received)}`; break;
      case 'retrying': t = `연결 끊김 → 이어받는 중 (${s.retries}회)`; break;
      case 'saving': t = '파일로 저장 중...'; break;
      case 'complete': t = '완료 · 클릭하면 폴더 열기'; break;
      case 'failed': t = `실패: ${s.error} · 다시 클릭하면 재시도`; break;
      default: t = l.sub || '';
    }
    l.statusEl.textContent = t;
  }
  $('#cancelBtn').hidden = !(r.queued || r.active);
}

async function getTargetTab() {
  // 테스트용: popup.html?tabId=123
  const qs = new URLSearchParams(location.search).get('tabId');
  if (qs) return chrome.tabs.get(parseInt(qs, 10));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const { autoOne = true, parallel = 1 } = await chrome.storage.local.get(['autoOne', 'parallel']);
  $('#autoOne').checked = autoOne;
  $('#parallel').value = String(parallel);
  $('#autoOne').addEventListener('change', (e) => chrome.storage.local.set({ autoOne: e.target.checked }));
  $('#parallel').addEventListener('change', (e) => send({ action: 'setParallel', value: parseInt(e.target.value, 10) }));
  $('#allBtn').addEventListener('click', async () => {
    const todo = lectures.filter((l) => !['queued', 'downloading', 'retrying', 'saving', 'complete'].includes(l.state));
    if (todo.length) await send({ action: 'enqueue', items: todo.map(pick) });
    refresh();
  });
  $('#cancelBtn').addEventListener('click', async () => {
    await send({ action: 'cancelAll' });
    refresh();
  });

  const tab = await getTargetTab();
  if (!tab || !/^https?:/.test(tab.url || '')) {
    showMsg('강의 페이지에서 눌러주세요.');
    return;
  }
  const host = new URL(tab.url).hostname;
  const dir = `LMS/${siteKey(host)}`;
  $('#site').textContent = host;
  $('#dir').textContent = siteKey(host);

  const det = await send({ action: 'getDetected', tabId: tab.id });
  const lx = det.lx || [];
  const media = det.media || [];

  if (!lx.length && !media.length) {
    showMsg(det.hls
      ? '이 페이지 영상은 HLS 스트리밍(.m3u8) 방식이라 아직 지원하지 않아요.'
      : '아직 감지된 강의 영상이 없어요.\n강의 영상을 재생한 뒤 다시 눌러주세요.\n(이미 열려 있던 페이지면 새로고침 F5 후 재생)');
    return;
  }

  showMsg('강의 정보를 가져오는 중...');

  // 1) LearningX: 제목 있는 강의
  //    강의 정보는 동시에 요청하고, 화면에는 원래 순서대로 표시
  const metas = await Promise.all(lx.map(async (x) => {
    try {
      const r = await send({ action: 'getMetadata', origin: x.origin, id: x.id });
      if (r.error) throw new Error(r.error);
      return { x, m: parseMetadata(r.xml) };
    } catch (e) {
      console.warn('LearningX metadata failed', x, e);
      return null;
    }
  }));
  for (const item of metas) {
    if (!item) continue;
    const { x, m } = item;
    if (lectures.some((l) => pathOf(l.url) === pathOf(m.url))) continue;
    const lec = { kind: 'lx', ...m, referer: `${x.origin}/`, filename: `${dir}/${safeName(m.title)}.${m.ext}` };
    lectures.push(lec);
    render(lec);
  }

  // 2) 스니핑된 영상: LearningX로 이미 잡힌 것은 제외
  for (const m of media) {
    if (lectures.some((l) => pathOf(l.url) === pathOf(m.url))) continue;
    let base = decodeURIComponent(new URL(m.url).pathname.split('/').pop() || 'video');
    const ext = (base.match(/\.([a-z0-9]{2,4})$/i)?.[1] || (m.ctype?.split('/')[1] || 'mp4')).replace(/[^a-z0-9]/gi, '');
    base = base.replace(/\.[a-z0-9]{2,4}$/i, '');
    const pageTitle = safeName(tab.title || '').slice(0, 60);
    const title = /^[0-9a-f_-]{12,}$/i.test(base) && pageTitle ? `${pageTitle} (${base.slice(0, 8)})` : base;
    const lec = {
      kind: 'media',
      title,
      url: m.url,
      ext,
      referer: m.referer || `${new URL(tab.url).origin}/`,
      filename: `${dir}/${safeName(title)}.${ext}`,
      sub: `재생 중 감지된 영상${m.size ? ' · ' + fmtMB(m.size) : ''}`
    };
    lectures.push(lec);
    render(lec);
  }

  if (!lectures.length) {
    showMsg('강의 정보를 가져오지 못했어요. 페이지를 새로고침(F5)하고 영상을 재생한 뒤 다시 시도해주세요.');
    return;
  }
  showMsg('');
  $('#toolbar').hidden = lectures.length < 2;

  await refresh();

  if (autoOne && lectures.length === 1 && lectures[0].state === 'none') {
    await onClick(lectures[0]);
  }

  // 진행 중인 게 있을 때는 1초마다, 없을 때는 3초마다 상태 갱신
  const tick = async () => {
    await refresh();
    const busy = lectures.some((l) => ['queued', 'downloading', 'retrying', 'saving'].includes(l.state));
    setTimeout(tick, busy ? 1000 : 3000);
  };
  setTimeout(tick, 1000);
}

init().catch((e) => showMsg(`오류: ${e.message}`));
