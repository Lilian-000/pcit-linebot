/**
 * R2 任務狀態存取層。
 *
 * 設計選擇：每個任務只用「一個」JSON 檔 (`tasks/{taskId}.json`) 表示完整狀態，
 * 這樣讀寫各只需 1 次 R2 操作，前端輪詢成本低。代價是每次更新都要先 read 後 write，
 * 由於目前流程是 webhook → consumer 單向交付，不會有競態問題。
 */
import type { TaskState } from '../types'

/** 把 taskId 轉成 R2 object key。 */
function keyFor(taskId: string): string {
  return `tasks/${taskId}.json`
}

/**
 * 建立新任務並寫入 R2（initial state = queued）。
 *
 * @param bucket R2 bucket binding
 * @param taskId webhook 端產生的 UUID
 * @param userMessage 使用者原始輸入
 * @param estimatedSeconds 預期完成時間（給前端顯示用），預設 60 秒
 */
export async function createTask(
  bucket: R2Bucket,
  taskId: string,
  userMessage: string,
  estimatedSeconds = 60,
): Promise<TaskState> {
  const now = Date.now()
  const state: TaskState = {
    taskId,
    status: 'queued',
    createdAt: now,
    estimatedSeconds,
    input: { userMessage },
  }
  await bucket.put(keyFor(taskId), JSON.stringify(state), {
    httpMetadata: { contentType: 'application/json' },
  })
  return state
}

/**
 * 讀取任務狀態；若 R2 中不存在回傳 null（前端應回 404）。
 */
export async function readTask(
  bucket: R2Bucket,
  taskId: string,
): Promise<TaskState | null> {
  const obj = await bucket.get(keyFor(taskId))
  if (!obj) return null
  const text = await obj.text()
  try {
    return JSON.parse(text) as TaskState
  } catch {
    return null
  }
}

/**
 * 部分更新任務狀態 — 先讀後寫，將 patch 合併進現有 state。
 *
 * Consumer 會用這個函式更新 status 為 processing / done / failed。
 *
 * @param bucket R2 bucket binding
 * @param taskId 任務 ID
 * @param patch 要覆蓋的欄位
 * @returns 更新後的完整 state；若任務不存在回傳 null
 */
export async function updateTask(
  bucket: R2Bucket,
  taskId: string,
  patch: Partial<TaskState>,
): Promise<TaskState | null> {
  const current = await readTask(bucket, taskId)
  if (!current) return null
  const next: TaskState = { ...current, ...patch }
  await bucket.put(keyFor(taskId), JSON.stringify(next), {
    httpMetadata: { contentType: 'application/json' },
  })
  return next
}
