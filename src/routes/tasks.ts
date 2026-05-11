/**
 * 結果相關路由：
 *   - GET /tasks/:taskId     使用者看的 HTML 結果頁（含輪詢 JS）
 *   - GET /api/tasks/:taskId 前端輪詢用的 JSON 狀態 API
 */
import { Hono } from 'hono'
import type { Bindings, TaskApiResponse } from '../types'
import { readTask } from '../lib/storage'

export const tasksRoute = new Hono<{ Bindings: Bindings }>()

/**
 * 狀態 API — 給結果頁的 JavaScript 每 5 秒輪詢一次。
 * 依任務狀態回不同 schema（藍圖第 8–10 步）。
 */
tasksRoute.get('/api/tasks/:taskId', async (c) => {
  const taskId = c.req.param('taskId')
  const state = await readTask(c.env.TASK_BUCKET, taskId)
  if (!state) {
    return c.json({ error: 'task not found' }, 404)
  }

  let body: TaskApiResponse
  if (state.status === 'done') {
    body = {
      taskId: state.taskId,
      status: 'done',
      createdAt: state.createdAt,
      completedAt: state.completedAt ?? Date.now(),
      resultMarkdown: state.resultMarkdown ?? '',
    }
  } else if (state.status === 'failed') {
    body = {
      taskId: state.taskId,
      status: 'failed',
      message: state.errorMessage ?? '分析失敗，請稍後再試。',
    }
  } else {
    body = {
      taskId: state.taskId,
      status: state.status,
      createdAt: state.createdAt,
      elapsedSeconds: Math.floor((Date.now() - state.createdAt) / 1000),
      estimatedSeconds: state.estimatedSeconds,
    }
  }
  // 結果頁同源，但加上 no-store 避免中間層快取掉 processing 結果
  return c.json(body, 200, { 'Cache-Control': 'no-store' })
})

/**
 * 使用者實際打開的 HTML 結果頁。
 *
 * 為了 MVP 簡單，直接內嵌一段 vanilla JS：
 *   - 每 5 秒打 /api/tasks/:taskId
 *   - 處理中：顯示已等待秒數 / 預估秒數
 *   - 完成：用 marked (CDN) 把 Markdown 渲染成 HTML
 *   - 失敗：顯示錯誤訊息
 *   - 300 秒後仍未完成：停止輪詢、提示使用者
 *
 * 注意：HTML 內的 `${taskId}` 是「Server 端」字串插入；Client 端的
 * 模板字串 / `${...}` 都已用反斜線跳脫，不會被 server 模板誤解析。
 */
tasksRoute.get('/tasks/:taskId', async (c) => {
  const taskId = c.req.param('taskId')
  const html = renderResultPage(taskId)
  return c.html(html)
})

/** 產生結果頁 HTML。 */
function renderResultPage(taskId: string): string {
  // 注意：以下 JS 內的反引號 / ${} 都是「客戶端」要執行的，
  // 我們用普通字串相加組裝，避免與 server-side template literal 衝突。
  const js = `
(function () {
  var taskId = ${JSON.stringify(taskId)};
  var startedAt = Date.now();
  var TIMEOUT_MS = 300000; // 5 分鐘
  var POLL_INTERVAL_MS = 5000;
  var statusEl = document.getElementById('status');
  var resultEl = document.getElementById('result');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function renderMarkdown(md) {
    if (window.marked && typeof window.marked.parse === 'function') {
      return window.marked.parse(md);
    }
    return '<pre>' + escapeHtml(md) + '</pre>';
  }

  function poll() {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      statusEl.textContent = '⏱ 已等待超過 5 分鐘，請稍後再重新整理本頁。';
      return;
    }
    fetch('/api/tasks/' + encodeURIComponent(taskId), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) throw new Error('找不到此任務');
        return r.json();
      })
      .then(function (data) {
        if (data.status === 'done') {
          statusEl.textContent = '✅ 分析完成';
          resultEl.innerHTML = renderMarkdown(data.resultMarkdown || '');
          return;
        }
        if (data.status === 'failed') {
          statusEl.textContent = '❌ ' + (data.message || '分析失敗');
          return;
        }
        // queued / processing
        statusEl.textContent =
          '⏳ 處理中…… 已等待 ' + data.elapsedSeconds +
          ' 秒，通常約需 ' + data.estimatedSeconds + ' 秒。';
        setTimeout(poll, POLL_INTERVAL_MS);
      })
      .catch(function (err) {
        statusEl.textContent = '⚠️ ' + (err && err.message ? err.message : '查詢失敗');
        setTimeout(poll, POLL_INTERVAL_MS);
      });
  }

  poll();
})();
`

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>分析結果</title>
  <style>
    body { font-family: -apple-system, "Segoe UI", "Noto Sans TC", sans-serif;
           max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #1f2937; }
    h1 { font-size: 1.25rem; color: #111827; }
    #status { padding: 0.75rem 1rem; background: #f3f4f6; border-radius: 8px; margin: 1rem 0; }
    #result { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem 1.25rem; }
    #result:empty { display: none; }
    #result h1, #result h2, #result h3 { margin-top: 1rem; }
    #result ul, #result ol { padding-left: 1.5rem; }
    code { background: #f3f4f6; padding: 0.1em 0.3em; border-radius: 4px; }
    .task-id { color: #6b7280; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>防詐騙小幫手 — 分析結果</h1>
  <div class="task-id">任務編號：${escapeHtml(taskId)}</div>
  <div id="status">⏳ 載入中……</div>
  <article id="result"></article>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>${js}</script>
</body>
</html>`
}

/** 伺服器端 HTML escape（給 taskId 安全嵌入頁面用）。 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}
