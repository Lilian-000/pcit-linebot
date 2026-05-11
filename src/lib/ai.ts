/**
 * Cloudflare Workers AI 呼叫層 — 包住 `env.AI.run('@cf/openai/gpt-oss-120b', ...)`。
 *
 * 文件: https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/
 *
 * 模型支援兩種輸入格式，我們選 Responses API（instructions + input），原因：
 *   - 單輪對話比 messages 陣列乾淨
 *   - 未來要接 tool use / 多輪時再切換
 *
 * ⚠️ 重要：gpt-oss-120b 是「reasoning model」，回應的 `response` 欄位會把
 * 推理過程 (analysis channel) 與最終答案 (final channel) 串在一起。
 * 必須改用 `output[]` 結構，過濾掉 `type === 'reasoning'` 的項目，
 * 只取 `type === 'message'` 內的 `output_text` 才是給使用者看的內容。
 */
import type { BuiltPrompt } from './prompt'

/** 預設 model id；單獨抽出方便未來換模型。 */
const MODEL_ID = '@cf/openai/gpt-oss-120b'

/**
 * gpt-oss-120b 的回應結構（依實測 Cloudflare 回傳的鍵）。
 *
 * 形狀近似 OpenAI Responses API：
 *   output: [
 *     { type: 'reasoning', content: [...] },        // 推理過程，要丟掉
 *     { type: 'message',  content: [{ type: 'output_text', text: '...' }] }
 *   ]
 *
 * 偶爾 Cloudflare 會把整段（含 reasoning）塞進 top-level `response` 欄位 —
 * 那是最後手段的 fallback。
 */
type GptOssOutputItem = {
  type?: string
  content?: Array<{ type?: string; text?: string }>
}

type GptOssResponse = {
  response?: string
  output?: GptOssOutputItem[]
  output_messages?: GptOssOutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * 從 output[] 抽出「最終答案」文字，過濾掉所有 reasoning。
 *
 * @returns 若找不到任何非推理文字回傳空字串，呼叫端用 response 欄位 fallback
 */
function extractFinalText(items: GptOssOutputItem[] | undefined): string {
  if (!Array.isArray(items)) return ''
  const parts: string[] = []
  for (const item of items) {
    if (item?.type === 'reasoning') continue // 丟掉推理過程
    if (!Array.isArray(item?.content)) continue
    for (const c of item.content!) {
      // 接受 output_text 與單純帶 text 的項目
      if (typeof c?.text === 'string' && c.text.length > 0) {
        parts.push(c.text)
      }
    }
  }
  return parts.join('').trim()
}

/**
 * 呼叫 gpt-oss-120b 取得分析結果（Markdown 文字）。
 *
 * @param ai Workers AI binding (`env.AI`)
 * @param prompt 由 `buildPrompt()` 產生的 { instructions, input }
 * @param options 可選參數 — temperature/max_tokens 等
 * @returns 模型生成的純文字回應（Markdown）
 * @throws 若回應結構不含可用文字，拋出 Error 由 consumer 寫入 failed 狀態
 */
export async function runAnalysis(
  ai: Ai,
  prompt: BuiltPrompt,
  options: {
    /** 預設 1024，給 gpt-oss-120b 比較完整的輸出空間 */
    max_tokens?: number
    /** 預設 0.4，分析建議型輸出不需要太發散 */
    temperature?: number
  } = {},
): Promise<string> {
  const { max_tokens = 1024, temperature = 0.4 } = options

  // env.AI.run 的型別在 workers-types 為較寬鬆的 unknown，
  // 我們 cast 成已知形狀後再做 narrowing。
  const raw = (await ai.run(MODEL_ID as any, {
    instructions: prompt.instructions,
    input: prompt.input,
    max_tokens,
    temperature,
  } as any)) as GptOssResponse

  // 1. 優先解析 output[] —— 過濾掉 reasoning，只留 message 內容
  const fromOutput = extractFinalText(raw?.output)
  if (fromOutput.length > 0) return fromOutput

  // 2. 退而求其次：output_messages（部分版本回傳這個鍵）
  const fromMessages = extractFinalText(raw?.output_messages)
  if (fromMessages.length > 0) return fromMessages

  // 3. 最後 fallback：top-level response 字串（會包含 reasoning，但總比沒有好）
  if (typeof raw?.response === 'string' && raw.response.trim().length > 0) {
    console.warn('[ai] 只能 fallback 到 response 欄位，可能含推理過程')
    return raw.response
  }

  throw new Error(
    `gpt-oss-120b 回應格式無法解析: ${JSON.stringify(raw).slice(0, 300)}`,
  )
}
