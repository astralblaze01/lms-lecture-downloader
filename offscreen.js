// 숨은(offscreen) 페이지: 실제 영상 데이터를 받는 곳
// - fetch 요청에는 background가 설정한 호스트별 Referer 규칙(DNR 세션 규칙)이 적용됨
// - 8MB 단위 Range 요청으로 받아서, 연결이 끊기면 그 조각만 다시 받음
// - 다 받으면 Blob URL을 만들어 background에 넘기고, background가 chrome.downloads로 저장

const CHUNK = 8 * 1024 * 1024;
const MAX_FAILS = 30;
const jobs = new Map(); // url -> { ctrl, blobUrl }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBg = (m) => chrome.runtime.sendMessage({ ...m, target: 'background' }).catch(() => {});

async function runJob(job) {
  const ctrl = new AbortController();
  jobs.set(job.url, { ctrl });
  let parts = [];
  let received = 0;
  let total = null;
  let fails = 0;
  let lastReport = 0;

  const report = (force) => {
    const now = Date.now();
    if (force || now - lastReport > 700) {
      lastReport = now;
      toBg({ action: 'progress', url: job.url, received, total, fails });
    }
  };

  while (total === null || received < total) {
    try {
      const res = await fetch(job.url, {
        headers: { Range: `bytes=${received}-${received + CHUNK - 1}` },
        signal: ctrl.signal,
        cache: 'no-store',
        credentials: 'include'
      });

      if (res.status === 206) {
        const cr = res.headers.get('Content-Range'); // bytes a-b/total
        const m = cr && cr.match(/\/(\d+)\s*$/);
        if (m) total = parseInt(m[1], 10);
        const b = await res.blob();
        parts.push(b);
        received += b.size;
        if (!m && b.size < CHUNK) total = received; // 전체 크기를 모르면 마지막 조각으로 판단
        if (b.size === 0) throw new Error('빈 응답');
      } else if (res.status === 200) {
        // 서버가 Range를 무시 → 통째로 스트리밍 (끊기면 처음부터)
        total = parseInt(res.headers.get('Content-Length') || '0', 10) || null;
        parts = [];
        received = 0;
        const reader = res.body.getReader();
        let buf = [];
        let bufSize = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf.push(value);
          bufSize += value.length;
          received += value.length;
          if (bufSize >= CHUNK) { parts.push(new Blob(buf)); buf = []; bufSize = 0; }
          report(false);
        }
        if (buf.length) parts.push(new Blob(buf));
        if (total && received < total) throw new Error('스트림이 중간에 끊김');
        total = received;
      } else if (res.status === 416 && total !== null) {
        break;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
      fails = 0;
      report(false);
    } catch (e) {
      if (ctrl.signal.aborted) throw new Error('취소됨');
      fails++;
      report(true);
      if (fails > MAX_FAILS) throw new Error(`연결 실패 반복 (${e.message})`);
      await sleep(Math.min(1000 * fails, 10000));
    }
  }

  const type = /\.mp4($|\?)/i.test(job.filename) ? 'video/mp4' : 'application/octet-stream';
  const blobUrl = URL.createObjectURL(new Blob(parts, { type }));
  jobs.get(job.url).blobUrl = blobUrl;
  report(true);
  return blobUrl;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.action) {
    case 'start':
      if (jobs.has(msg.job.url)) return;
      runJob(msg.job)
        .then((blobUrl) => toBg({ action: 'jobDone', url: msg.job.url, blobUrl }))
        .catch((e) => {
          jobs.delete(msg.job.url);
          toBg({ action: 'jobFailed', url: msg.job.url, error: e.message });
        });
      break;
    case 'release': {
      const j = jobs.get(msg.url);
      if (j?.blobUrl) URL.revokeObjectURL(j.blobUrl);
      jobs.delete(msg.url);
      break;
    }
    case 'cancelAll':
      for (const [url, j] of jobs) {
        j.ctrl.abort();
        if (j.blobUrl) URL.revokeObjectURL(j.blobUrl);
        jobs.delete(url);
      }
      break;
  }
});
