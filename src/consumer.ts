/**
 * Queue consumer — 非同步處理 AI 分析任務。
 *
 * 由 Cloudflare Workers runtime 透過 export default { queue } 觸發。
 * 對應藍圖第 6 步：取訊息 → 呼叫 AI → 結果寫回 R2。
 *
 * 失敗策略：
 *   - 預設 ack 後不重試（避免大量呼 AI 燒額度）；改為把 status=failed 寫進 R2，
 *     讓使用者看到錯誤訊息。
 *   - 若想啟用 Queue 自動 retry，把 catch 內的 msg.ack() 改成 msg.retry() 即可，
 *     並在 wrangler.jsonc 設定 dead_letter_queue。
 */
import type { Bindings, TaskQueueMessage } from './types'
import { updateTask } from './lib/storage'
import { parseUserMessage, buildPrompt } from './lib/prompt'
import { runAnalysis } from './lib/ai'

/**
 * 處理單一 queue 訊息：把 status 推進到 processing → done/failed。
 *
 * 包成獨立函式（不是直接寫在 queue handler 裡）的好處：
 *   - 容易加上單元測試
 *   - consumer 內可以 Promise.all 平行處理多筆
 */
export async function handleTaskMessage(
  env: Bindings,
  body: TaskQueueMessage,
): Promise<void> {
  const { taskId, userMessage } = body

  // 1. 標記為處理中（讓輪詢 API 可以看到狀態變化）
  await updateTask(env.TASK_BUCKET, taskId, { status: 'processing' })

  try {
    // 2. 剖析 + 建 prompt + 跑 AI
    const parsed = parseUserMessage(userMessage)
    const prompt = buildPrompt(parsed)
    const markdown = await runAnalysis(env.AI, prompt)

    // 3. 寫回完成狀態
    await updateTask(env.TASK_BUCKET, taskId, {
      status: 'done',
      completedAt: Date.now(),
      resultMarkdown: markdown,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('[consumer] AI 分析失敗', { taskId, errorMessage })
    await updateTask(env.TASK_BUCKET, taskId, {
      status: 'failed',
      completedAt: Date.now(),
      errorMessage,
    })
  }
}

/**
 * Cloudflare Queue handler — runtime 進入點。
 *
 * 一批內的訊息平行跑 AI（互不相依），但個別失敗只影響自己的任務狀態。
 */
export async function queueHandler(
  batch: MessageBatch<TaskQueueMessage>,
  env: Bindings,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (msg) => {
      try {
        await handleTaskMessage(env, msg.body)
      } catch (err) {
        // handleTaskMessage 內部已寫入 R2，這層只是保險
        console.error('[consumer] 未捕獲錯誤:', err)
      } finally {
        msg.ack()
      }
    }),
  )
}
