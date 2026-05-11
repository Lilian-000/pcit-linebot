/**
 * LINE Messaging API 相關工具。
 *
 * 1. `verifyLineSignature` — 驗證 webhook 的 x-line-signature
 * 2. `replyToLine` — 呼叫 Reply API 回覆使用者
 */

const LINE_REPLY_ENDPOINT = 'https://api.line.me/v2/bot/message/reply'

/**
 * 驗證 LINE webhook 簽章。
 *
 * LINE 平台會用 channel secret 對 raw body 計算 HMAC-SHA256，
 * base64 後放進 `x-line-signature` header。本函式以相同金鑰重新計算後
 * 以「等長時間比對」(constant-time compare) 避免 timing attack。
 *
 * @param channelSecret LINE Channel secret
 * @param rawBody webhook request 的原始 body（必須未經 JSON.parse）
 * @param signature `x-line-signature` header 值；若不存在傳 undefined
 * @returns 簽章相符回傳 true；缺少 header 或不符回傳 false
 */
export async function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const macBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  )
  const expected = btoa(String.fromCharCode(...new Uint8Array(macBuf)))

  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

/**
 * 透過 LINE Reply API 回覆使用者一則文字訊息。
 *
 * Reply token 在 webhook 收到後約 30 秒內有效，因此 webhook handler 拿到
 * token 後應該「立刻」呼叫本函式 — 不要等 AI 跑完。
 *
 * @param accessToken LINE Channel access token
 * @param replyToken webhook 事件中的 replyToken
 * @param text 要回覆的文字內容（會被包成單則 text message）
 * @throws 若 LINE API 回非 2xx，拋出含錯誤訊息的 Error
 */
export async function replyToLine(
  accessToken: string,
  replyToken: string,
  text: string,
): Promise<void> {
  const response = await fetch(LINE_REPLY_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: 'text', text }],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`LINE Reply API error ${response.status}: ${errorText}`)
  }
}
