/**
 * 全專案共用型別 / Shared types across the project.
 *
 * 主要包含三類：
 *   1. Bindings：Cloudflare Worker 注入的服務 (env)
 *   2. LINE webhook 解析結果
 *   3. 任務狀態 (TaskState) — 透過 R2 在 webhook 與 queue consumer 之間傳遞
 */

/**
 * Cloudflare Worker 環境綁定。
 * 對應 wrangler.jsonc 內 `ai` / `r2_buckets` / `queues.producers` 三項，
 * 加上兩個由 `wrangler secret put` 注入的 LINE 機敏設定。
 */
export type Bindings = {
  /** LINE Channel access token — 呼叫 Reply API 時帶在 Authorization header */
  LINE_CHANNEL_ACCESS_TOKEN: string
  /** LINE Channel secret — 驗證 webhook 簽章用 (HMAC-SHA256 金鑰) */
  LINE_CHANNEL_SECRET: string
  /** Workers AI binding — 透過 env.AI.run() 呼叫 gpt-oss-120b */
  AI: Ai
  /** R2 bucket binding — 存放任務狀態 + 分析結果 */
  TASK_BUCKET: R2Bucket
  /** Queue producer binding — webhook 把任務丟進來，由 consumer 非同步處理 */
  TASK_QUEUE: Queue<TaskQueueMessage>
}

/**
 * Queue 傳遞的訊息格式。
 * 把使用者輸入一起放進來，consumer 就不必再去 R2 讀一次。
 */
export type TaskQueueMessage = {
  taskId: string
  userMessage: string
}

/** 任務目前的處理狀態。 */
export type TaskStatus = 'queued' | 'processing' | 'done' | 'failed'

/**
 * 任務狀態 — 存在 R2 的 `tasks/{taskId}.json`，
 * 同時被 webhook (寫入)、consumer (更新)、結果頁 API (讀取) 三方共用。
 */
export type TaskState = {
  taskId: string
  status: TaskStatus
  /** 建立時間 (ms epoch) — 用來算「已處理幾秒」 */
  createdAt: number
  /** 完成時間 (ms epoch) — 僅在 status=done/failed 時存在 */
  completedAt?: number
  /** 預期處理時間（秒） — 給前端顯示「通常約需 N 秒」 */
  estimatedSeconds: number
  /** 使用者原始輸入 */
  input: {
    userMessage: string
  }
  /** AI 分析結果 (Markdown) — status=done 時存在 */
  resultMarkdown?: string
  /** 失敗訊息 — status=failed 時存在 */
  errorMessage?: string
}

/** 結果頁 API (`GET /api/tasks/:taskId`) 的回應格式。 */
export type TaskApiResponse =
  | {
      taskId: string
      status: 'queued' | 'processing'
      createdAt: number
      elapsedSeconds: number
      estimatedSeconds: number
    }
  | {
      taskId: string
      status: 'done'
      createdAt: number
      completedAt: number
      resultMarkdown: string
    }
  | {
      taskId: string
      status: 'failed'
      message: string
    }
