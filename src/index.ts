/**
 * Worker 進入點。
 *
 * 同時匯出兩個 handler：
 *   - fetch  — Hono app（webhook + tasks + test）
 *   - queue  — 處理 TASK_QUEUE 的訊息（呼叫 AI、寫 R2）
 *
 * 路由總表：
 *   GET  /                    健康提示頁
 *   POST /line/webhook        LINE webhook（驗簽 + 派工）
 *   GET  /tasks/:taskId       使用者看的 HTML 結果頁
 *   GET  /api/tasks/:taskId   前端輪詢用 JSON
 *   GET  /test/health         測試：bindings 是否齊全
 *   POST /test/tasks          測試：非同步建任務（免 LINE）
 *   POST /test/analyze-sync   測試：同步呼叫 AI（debug prompt 用）
 */
import { Hono } from 'hono'
import type { Bindings, TaskQueueMessage } from './types'
import { webhookRoute } from './routes/webhook'
import { tasksRoute } from './routes/tasks'
import { testRoute } from './routes/test'
import { queueHandler } from './consumer'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', (c) =>
  c.text(
    'PCIT LINE Bot — 防詐騙小幫手\n' +
      '\n路由：' +
      '\n  POST /line/webhook' +
      '\n  GET  /tasks/:taskId' +
      '\n  GET  /api/tasks/:taskId' +
      '\n  GET  /test/health' +
      '\n  POST /test/tasks' +
      '\n  POST /test/analyze-sync\n',
  ),
)

app.route('/', webhookRoute)
app.route('/', tasksRoute)
app.route('/', testRoute)

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<TaskQueueMessage>, env: Bindings) {
    await queueHandler(batch, env)
  },
}
