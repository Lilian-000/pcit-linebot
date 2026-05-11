/**
 * 訊息剖析 + AI prompt 建構（可自訂區）。
 *
 * 此檔被「刻意隔離」出來，方便後續單獨調整 prompt 與訊息處理規則，
 * 不必動 webhook / consumer 的流程程式。
 *
 * 兩個主要函式：
 *   - parseUserMessage(text)   清洗使用者輸入
 *   - buildPrompt(parsed)      組出送進 gpt-oss-120b 的 instructions + input
 */

/** 訊息剖析結果。MVP 先只處理文字，欄位刻意保留以便未來擴充。 */
export type ParsedMessage = {
  /** 已清洗的文字內容（去除前後空白、限制長度等） */
  text: string
  /** 原始字數（給 prompt 內可選引用，例如太短時提醒補充細節） */
  rawLength: number
}

/** 單一使用者訊息允許的最大長度（避免 prompt 爆量）。 */
const MAX_INPUT_LENGTH = 2000

/**
 * 清洗使用者文字輸入。
 *
 * - 去除前後空白
 * - 截斷過長內容（保留前 MAX_INPUT_LENGTH 字元）
 * - 保留原始長度給 prompt 參考
 *
 * 未來可以在這裡擴充：
 *   - OCR 圖片內容
 *   - 解析貼上的銀行交易明細
 *   - 偵測 URL / 帳號 / 電話等 entity
 */
export function parseUserMessage(text: string): ParsedMessage {
  const trimmed = (text ?? '').trim()
  const truncated =
    trimmed.length > MAX_INPUT_LENGTH ? trimmed.slice(0, MAX_INPUT_LENGTH) : trimmed
  return {
    text: truncated,
    rawLength: trimmed.length,
  }
}

/**
 * AI 系統提示 (instructions)。
 *
 * 這裡定義 bot 的角色與輸出規範。未來想調整風格、加入 few-shot 範例、
 * 或抽出多版本 A/B 測試，直接改這個常數即可。
 */
const SYSTEM_INSTRUCTIONS = `你是「防詐騙小幫手」，協助台灣的 LINE 使用者判斷金融交易風險、釐清申訴管道。

你會同時面對三種使用者，請先依訊息內容判斷對方的處境，再給出對應建議：

1. 匯款人（預防詐騙）
   - 確認收款對象的姓名是否與交易對象相符
   - 評估是否該改成面交、一手交錢一手交貨
   - 若已匯出且懷疑被騙：請先打電話給轉出銀行請求協助聯繫收款方，無法聯繫再考慮報警

2. 潛在人頭戶（保護自己）
   - 評估帳戶是否曾外洩
   - 建議網路交易時改用備用帳戶或面交
   - 若已把帳號交給他人：立即致電開戶銀行

3. 已受害者（警示申訴）
   - 引導申訴流程：報案 → 偵查隊 → 地檢署
   - 三層文件協助：
     * 第一層（即時免費）：AI 協助產生初步陳述書
     * 第二層：法律扶助基金會免費諮詢
     * 第三層：委任律師撰寫書狀、陪同偵訊

輸出規範：
- 使用繁體中文
- 用 Markdown 格式，含清楚的標題與條列
- 開頭先說明你判斷使用者屬於哪一種角色（或「資訊不足，需進一步釐清」）
- 接著給出具體下一步行動，最多 5 點
- 最後附一句溫和的提醒（不要嚇唬使用者）
- 切勿提供具體金額判斷、法律保證或診斷；僅給流程性建議
- 若資訊真的不夠，請列出需要使用者補充的關鍵問題`

/** 建構 prompt 的回傳格式 — 對齊 Workers AI Responses API 參數。 */
export type BuiltPrompt = {
  instructions: string
  input: string
}

/**
 * 將解析後的訊息包成 gpt-oss-120b 的 instructions + input。
 *
 * Workers AI 的 Responses API 接受兩個欄位：
 *   - instructions: 系統提示
 *   - input: 使用者單輪輸入
 * 我們不使用 messages 陣列（多輪會在 D1 接上後再導入）。
 */
export function buildPrompt(parsed: ParsedMessage): BuiltPrompt {
  // 若訊息過短，把這個 hint 也塞進 input，讓模型主動詢問細節。
  const note =
    parsed.rawLength < 10
      ? '\n\n[備註：使用者輸入較短，請主動詢問細節以判斷角色與風險]'
      : ''

  return {
    instructions: SYSTEM_INSTRUCTIONS,
    input: `使用者訊息：\n${parsed.text}${note}`,
  }
}
