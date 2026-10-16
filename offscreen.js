// 숨은(offscreen) 페이지: 실제 영상 데이터를 받는 곳
// - fetch 요청에는 background가 설정한 호스트별 Referer 규칙(DNR 세션 규칙)이 적용됨
// - 8MB 조각(Range)을 동시에 여러 개 받아서 순서대로 합침 → 연결당 속도 제한이 있는 서버에서 빨라짐
// - 조각마다 크기를 검증하고, 실패한 조각만 다시 받음
// - 서버가 Range를 지원하지 않으면 통째로 스트리밍
// - 다 받으면 Blob URL을 만들어 background에 넘기고, background가 chrome.downloads로 저장

const CHUNK = 8 * 1024 * 1024;
const MAX_FAILS = 30;          // 한 파일에서 허용하는 연속 실패 횟수
const DEFAULT_CONNECTIONS = 4; // 파일 하나당 동시 연결 수
const jobs = new Map();        // url -> { ctrl, blobUrl }

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('취소됨')); }, { once: true });
});
const toBg = (m) => chrome.runtime.sendMessage({ ...m, target: 'background' }).catch(() => {});
const totalFromContentRange = (cr) => { const m = cr && cr.match(/\/(\d+)\s*$/); return m ? parseInt(m[1], 10) : null; };

async function runJob(job) {
  const ctrl = new AbortController();
  const signal = ctrl.signal;
  jobs.set(job.url, { ctrl });

  const st = { received: 0, total: null, fails: 0, lastReport: 0 };
  const report = (force) => {
    const now = Date.now();
    if (force || now - st.lastReport > 500) {
      st.lastReport = now;
      toBg({ action: 'progress', url: job.url, received: st.received, total: st.total, fails: st.fails });
    }
  };
  const get = (headers) => fetch(job.url, { headers, signal, cache: 'no-store', credentials: 'include' });

  // 실패하면 기다렸다가 다시 시도 (연속 실패가 MAX_FAILS를 넘으면 포기)
  async function withRetry(fn) {
    for (;;) {
      try {
        const r = await fn();
        st.fails = 0;
        return r;
      } catch (e) {
        if (signal.aborted) throw new Error('취소됨');
        st.fails++;
        report(true);
        if (st.fails > MAX_FAILS) throw new Error(`연결 실패 반복 (${e.message})`);
        await sleep(Math.min(1000 * st.fails, 10000), signal);
      }
    }
  }

  // Range 미지원: 통째로 스트리밍 (끊기면 처음부터)
  async function streamWhole(res) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (attempt > 0) {
          res = await get({});
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
        st.total = parseInt(res.headers.get('Content-Length') || '0', 10) || null;
        st.received = 0;
        const out = [];
        let buf = [];
        let bufSize = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf.push(value);
          bufSize += value.length;
          st.received += value.length;
          if (bufSize >= CHUNK) { out.push(new Blob(buf)); buf = []; bufSize = 0; }
          report(false);
        }
        if (buf.length) out.push(new Blob(buf));
        if (st.total && st.received < st.total) throw new Error('스트림이 중간에 끊김');
        st.total = st.received;
        return out;
      } catch (e) {
        if (signal.aborted) throw new Error('취소됨');
        st.fails++;
        report(true);
        if (st.fails > MAX_FAILS) throw new Error(`연결 실패 반복 (${e.message})`);
        await sleep(Math.min(1000 * st.fails, 10000), signal);
      }
    }
  }

  // 전체 크기를 모르는 206 응답: 한 조각씩 차례로
  async function sequential(firstBlob) {
    const out = [firstBlob];
    st.received = firstBlob.size;
    let last = firstBlob.size;
    while (last === CHUNK) {
      const start = st.received;
      const blob = await withRetry(async () => {
        const res = await get({ Range: `bytes=${start}-${start + CHUNK - 1}` });
        if (res.status === 416) return new Blob([]);
        if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      });
      out.push(blob);
      st.received += blob.size;
      last = blob.size;
      report(false);
    }
    st.total = st.received;
    return out;
  }

  // 전체 크기를 아는 경우: 남은 조각들을 동시에 받음
  async function parallel(firstBlob, total) {
    st.total = total;
    st.received = firstBlob.size;
    const n = Math.ceil(total / CHUNK);
    const out = new Array(n);
    out[0] = firstBlob;
    if (firstBlob.size !== Math.min(CHUNK, total)) throw new Error('첫 조각 크기가 맞지 않음');
    report(true);

    let next = 1;
    const conns = Math.max(1, Math.min(job.connections || DEFAULT_CONNECTIONS, n - 1));
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= n) return;
        const start = i * CHUNK;
        const end = Math.min(start + CHUNK, total) - 1;
        out[i] = await withRetry(async () => {
          const res = await get({ Range: `bytes=${start}-${end}` });
          if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          if (blob.size !== end - start + 1) throw new Error(`조각 크기 불일치 (${blob.size})`);
          return blob;
        });
        st.received += out[i].size;
        report(false);
      }
    };
    try {
      await Promise.all(Array.from({ length: conns }, worker));
    } catch (e) {
      ctrl.abort(); // 다른 연결도 정리
      throw e;
    }
    return out;
  }

  // 1) 첫 조각으로 전체 크기와 Range 지원 여부 확인
  const first = await withRetry(async () => {
    const res = await get({ Range: `bytes=0-${CHUNK - 1}` });
    if (res.status === 200) return { full: res };
    if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const total = totalFromContentRange(res.headers.get('Content-Range'));
    const blob = await res.blob();
    if (!blob.size) throw new Error('빈 응답');
    return { blob, total };
  });

  let parts;
  if (first.full) parts = await streamWhole(first.full);
  else if (first.total == null) parts = await sequential(first.blob);
  else parts = await parallel(first.blob, first.total);

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
