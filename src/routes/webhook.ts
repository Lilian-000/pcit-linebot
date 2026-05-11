/**
 * POST /line/webhook — LINE Messaging API 入口。
 *
 * 流程（藍圖第 1–5 步）：
 *   1. 驗證 x-line-signature
 *   2. 解析 events，僅處理 message + text
 *   3. 產生 taskId、寫初始狀態到 R2
 *   4. 把 (taskId, userMessage) 丟進 Queue
 *   5. 立刻用 Reply API 回覆使用者「結果頁網址」
 *
 * Reply token 30 秒內有效，所以這裡「絕對不能」等 AI 完成。
 */
import { Hono } from 'hono'
import type { Bindings } from '../types'
import { verifyLineSignature, replyToLine } from '../lib/line'
import { createTask } from '../lib/storage'

type LineMessageEvent = {
  type: string
  replyToken: string
  timestamp: number
  source?: { userId?: string; type: string }
  message?: { type: string; text?: string }
}

type LineWebhookBody = {
  events?: LineMessageEvent[]
}

const REPLY_TOKEN_TTL_MS = 50_000

export const webhookRoute = new Hono<{ Bindings: Bindings }>()

webhookRoute.post('/line/webhook', async (c) => {
  // ── 1. 簽章驗證 ──
  const rawBody = await c.req.text()
  const signature = c.req.header('x-line-signature')
  const ok = await verifyLineSignature(
    c.env.LINE_CHANNEL_SECRET,
    rawBody,
    signature,
  )
  if (!ok) {
    console.error('[webhook] 簽章驗證失敗')
    return c.text('Invalid signature', 401)
  }

  // ── 2. 解析 events ──
  let body: LineWebhookBody
  try {
    body = JSON.parse(rawBody) as LineWebhookBody
  } catch {
    return c.text('Invalid JSON payload', 400)
  }

  // LINE 可能一次傳多個事件；MVP 只處理第一個 message+text。
  const events = body.events ?? []
  if (events.length === 0) return c.text('OK', 200)

  // 結果頁 base URL — 直接從這個 request 的 origin 推導，避免再加環境變數
  const baseUrl = new URL(c.req.url).origin

  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue
    const replyToken = event.replyToken
    const userText = event.message.text ?? ''

    // Reply token 過期保護
    const timeDiff = Date.now() - event.timestamp
    if (timeDiff > REPLY_TOKEN_TTL_MS) {
      console.error('[webhook] replyToken 可能已過期，略過此事件')
      continue
    }

    // ── 3. 建立任務、寫入 R2 ──
    const taskId = crypto.randomUUID()
    await createTask(c.env.TASK_BUCKET, taskId, userText)

    // ── 4. 送進 Queue 給 consumer 處理 ──
    await c.env.TASK_QUEUE.send({ taskId, userMessage: userText })

    // ── 5. 立刻 Reply 使用者結果頁 URL ──
    const resultUrl = `${baseUrl}/tasks/${taskId}`
    const replyText =
      `資料分析中，請點擊此連結查看結果（約 60 秒內完成）：\n${resultUrl}`

    try {
      await replyToLine(c.env.LINE_CHANNEL_ACCESS_TOKEN, replyToken, replyText)
    } catch (err) {
      console.error('[webhook] Reply API 錯誤:', err)
      // 即使 reply 失敗也回 200，避免 LINE 重送 webhook 引發重複任務
    }
  }

  return c.text('OK', 200)
})
