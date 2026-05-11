/**
 * 測試用路由（不經 LINE，方便本機開發 / curl 直接測）。
 *
 * 全部掛在 /test 下：
 *   - POST /test/tasks         走完整非同步流程（webhook 一樣的邏輯但免簽章）
 *   - POST /test/analyze-sync  直接同步呼叫 AI、立刻回 Markdown（debug prompt 用）
 *   - GET  /test/health        健康檢查，回 200 OK
 *
 * 生產環境若不想暴露，可在 wrangler.jsonc 用 routes 限制或在這裡加 token 驗證。
 */
import { Hono } from 'hono'
import type { Bindings } from '../types'
import { createTask } from '../lib/storage'
import { parseUserMessage, buildPrompt } from '../lib/prompt'
import { runAnalysis } from '../lib/ai'

export const testRoute = new Hono<{ Bindings: Bindings }>()

/** 健康檢查 — 確認 Worker 有起來、bindings 都註冊到。 */
testRoute.get('/test/health', (c) => {
  return c.json({
    ok: true,
    bindings: {
      AI: typeof c.env.AI?.run === 'function',
      TASK_BUCKET: typeof c.env.TASK_BUCKET?.get === 'function',
      TASK_QUEUE: typeof c.env.TASK_QUEUE?.send === 'function',
    },
    now: Date.now(),
  })
})

/**
 * 非同步測試：模擬 webhook 行為，建立任務並丟進 Queue。
 *
 * Request body 範例：
 *   { "message": "我要匯款給網路賣家，這樣安全嗎？" }
 *
 * Response：
 *   { "taskId": "...", "resultUrl": "https://.../tasks/..." }
 *
 * 接著用瀏覽器打開 resultUrl 看 Markdown 結果，或 curl GET /api/tasks/{taskId}。
 */
testRoute.post('/test/tasks', async (c) => {
  let body: { message?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const message = (body.message ?? '').trim()
  if (!message) {
    return c.json({ error: 'body.message is required' }, 400)
  }

  const taskId = crypto.randomUUID()
  await createTask(c.env.TASK_BUCKET, taskId, message)
  await c.env.TASK_QUEUE.send({ taskId, userMessage: message })

  const resultUrl = `${new URL(c.req.url).origin}/tasks/${taskId}`
  return c.json({ taskId, resultUrl, statusUrl: `/api/tasks/${taskId}` }, 202)
})

/**
 * 同步測試：直接呼叫 AI、不過 Queue/R2，立刻回 Markdown。
 *
 * 適合用來：
 *   - 在開發 prompt 時快速 iterate
 *   - 確認 AI binding 是否能跑（檢查 model id、回應格式）
 *
 * Request body：
 *   { "message": "請幫我判斷……" }
 *
 * Response：
 *   { "markdown": "...", "elapsedMs": 12345 }
 */
testRoute.post('/test/analyze-sync', async (c) => {
  let body: { message?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const message = (body.message ?? '').trim()
  if (!message) {
    return c.json({ error: 'body.message is required' }, 400)
  }

  const startedAt = Date.now()
  try {
    const parsed = parseUserMessage(message)
    const prompt = buildPrompt(parsed)
    const markdown = await runAnalysis(c.env.AI, prompt)
    return c.json({ markdown, elapsedMs: Date.now() - startedAt })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: msg, elapsedMs: Date.now() - startedAt }, 500)
  }
})
