# PCIT LINE Bot — 防詐騙小幫手

在 Cloudflare Workers 上實作的 LINE Messaging API bot，整合 Workers AI (`@cf/openai/gpt-oss-120b`) 提供「匯款前風險判斷／人頭戶自保／已受害申訴」三種情境的 AI 諮詢。

> 詳細工程藍圖：[issue #2](https://github.com/Lilian-000/pcit-linebot/issues/2#issuecomment-4425768321)

---

## 架構總覽

```
LINE 使用者
  │
  ▼
POST /line/webhook  ←─ 驗 x-line-signature
  │
  ├─ 產生 taskId + 寫入 R2（status=queued）
  ├─ 送進 Cloudflare Queue
  └─ Reply API 立刻回覆使用者：「請點 /tasks/:taskId 看結果」
                                  │
                                  ▼
                  Queue consumer ──► gpt-oss-120b ──► 寫回 R2（status=done）
                                  │
                                  ▼
       使用者打開 /tasks/:taskId（HTML 頁）── JS 每 5 秒輪詢 /api/tasks/:taskId
```

這樣設計：
- **不卡 Reply token**：webhook 在數百毫秒內回覆 LINE，不必等 AI 跑完
- **不必用 Push API**：使用者自己打開結果頁，省 LINE 推播費用
- **AI 處理可慢**：Queue consumer 沒有 webhook 的時限

---

## 路由

| Method | Path | 用途 |
| --- | --- | --- |
| `POST` | `/line/webhook` | LINE webhook（驗簽 + 派工） |
| `GET`  | `/tasks/:taskId` | 使用者實際看到的 HTML 結果頁（含 Markdown 渲染與輪詢） |
| `GET`  | `/api/tasks/:taskId` | 前端輪詢用的 JSON 狀態 API |
| `GET`  | `/test/health` | 健康檢查，回傳各 binding 是否註冊 |
| `POST` | `/test/tasks` | 測試：跑完整非同步流程（免 LINE 簽章） |
| `POST` | `/test/analyze-sync` | 測試：同步呼叫 AI，立即拿到 Markdown（debug prompt 用） |

---

## 專案結構

```
src/
├── index.ts                  # Worker 入口（fetch + queue handler）
├── types.ts                  # 共用型別（Bindings、TaskState、API response）
├── consumer.ts               # Queue consumer：呼叫 AI 並寫回 R2
├── lib/
│   ├── line.ts              # LINE 簽章驗證 + Reply API
│   ├── storage.ts           # R2 任務狀態 CRUD
│   ├── ai.ts                # 包住 env.AI.run('@cf/openai/gpt-oss-120b', …)
│   └── prompt.ts            # 訊息剖析 + AI prompt（可自訂）
└── routes/
    ├── webhook.ts           # POST /line/webhook
    ├── tasks.ts             # /tasks/:taskId 與 /api/tasks/:taskId
    └── test.ts              # 測試路由（不過 LINE）
```

每個檔案的重要函式都有中文註解，新工程師可從 `src/index.ts` → `routes/` → `lib/` 順著看。

> **想改提示詞？** 直接編輯 `src/lib/prompt.ts` 內的 `SYSTEM_INSTRUCTIONS` 與 `buildPrompt()`，其他層完全不用動。
> **想改訊息剖析？** 改 `parseUserMessage()`（同檔案）。

---

## 必要的 Cloudflare 設定

| 種類 | 名稱 | 取得／建立方式 |
| --- | --- | --- |
| Secret | `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → Messaging API → Issue long-lived token |
| Secret | `LINE_CHANNEL_SECRET` | LINE Developers Console → Basic settings |
| Binding | `AI` | Workers AI（無需建立資源） |
| Binding | `TASK_BUCKET` | `npx wrangler r2 bucket create pcit-tasks` |
| Binding | `TASK_QUEUE` | `npx wrangler queues create pcit-tasks`（需 Workers Paid 方案才能上 production） |

> 本機 `wrangler dev` 會自動模擬 R2 與 Queue，**完全不需先建立雲端資源**，可立刻開測。

---

## 快速啟動（本機）

```bash
# 1. 安裝依賴
npm install

# 2. 設定本機環境變數
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入實際 LINE token / secret
#   （若只想跑 /test/* 路由，可以先填假值，但 /line/webhook 會回 401）

# 3. 啟動 dev server（會同時跑 fetch + queue consumer）
npm run dev
```

預設會聽 `http://localhost:8787`。

> **多個 Cloudflare 帳號？** Workers AI 在 dev 模式必須遠端代理到 Cloudflare 才能跑，若你 `wrangler login` 過多個帳號，會看到 `More than one account available` 錯誤。請先用 `npx wrangler whoami` 找到目標帳號 ID，然後：
>
> ```bash
> CLOUDFLARE_ACCOUNT_ID=xxxxxxxx npm run dev
> ```
>
> 或把 `CLOUDFLARE_ACCOUNT_ID=...` 加進 `.dev.vars`（已被 gitignore）。

---

## 測試方式

### A. 健康檢查（無依賴）

```bash
curl http://localhost:8787/test/health
```

預期回應：

```json
{
  "ok": true,
  "bindings": { "AI": true, "TASK_BUCKET": true, "TASK_QUEUE": true },
  "now": 1710000000000
}
```

若有任何 binding 是 `false`，請檢查 `wrangler.jsonc` 是否完整。

### B. 同步測試 prompt（最快迭代方式，會打到 Cloudflare AI）

```bash
curl -X POST http://localhost:8787/test/analyze-sync \
  -H 'Content-Type: application/json' \
  -d '{"message":"我在臉書社團看到有人賣便宜的演唱會門票，賣家叫我先匯款 6000 元到他的個人帳戶，這樣安全嗎？"}'
```

回應會包含：

```json
{
  "markdown": "## 角色判斷\n您屬於「匯款人 — 預防詐騙」……",
  "elapsedMs": 8421
}
```

要調整 prompt 風格、口吻、輸出格式 → 改 `src/lib/prompt.ts` 後重存檔，`wrangler dev` 會熱重載。

### C. 完整非同步流程（模擬 LINE webhook 行為，不需簽章）

```bash
# 1. 建立任務
curl -X POST http://localhost:8787/test/tasks \
  -H 'Content-Type: application/json' \
  -d '{"message":"我前天匯了 30000 元給網拍賣家，現在他封鎖我，怎麼辦？"}'
```

回應：

```json
{
  "taskId": "f1a2b3c4-...",
  "resultUrl": "http://localhost:8787/tasks/f1a2b3c4-...",
  "statusUrl": "/api/tasks/f1a2b3c4-..."
}
```

```bash
# 2. 用瀏覽器打開 resultUrl，會看到「處理中……」並自動每 5 秒輪詢
open "http://localhost:8787/tasks/f1a2b3c4-..."

# 或用 curl 看 JSON 狀態
curl http://localhost:8787/api/tasks/f1a2b3c4-...
```

`status` 會從 `queued` → `processing` → `done`，完成後 `resultMarkdown` 會出現在回應中（也會在瀏覽器頁面渲染成 Markdown）。

### D. 真正用 LINE App 測試

1. 在 `.dev.vars` 填入真實 token/secret 後 `npm run deploy`
2. 把部署後的 URL `https://YOUR-WORKER.workers.dev/line/webhook` 貼到 LINE Developers Console → Webhook URL
3. 按 **Verify**，應顯示 `Success`
4. 加 bot 為好友後直接傳訊息，bot 會回一個分析結果頁的連結

### E. 自行計算簽章測試 `/line/webhook`

```bash
SECRET="your-channel-secret"
BODY='{"events":[{"type":"message","replyToken":"FAKE","timestamp":'$(($(date +%s)*1000))',"source":{"type":"user","userId":"U1"},"message":{"type":"text","text":"哈囉"}}]}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)

curl -X POST http://localhost:8787/line/webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $SIG" \
  -d "$BODY"
```

> Reply API 那一段會打到真實 LINE 平台，假 `replyToken` 會被回 400，Worker 端 log 會印錯誤但仍回 200（避免 LINE 重送）。建議用真實 LINE 訊息或上面的 `/test/tasks` 才能看到完整流程。

---

## 部署到 Cloudflare

```bash
# 1. 登入
npx wrangler login

# 2. 建立 R2 bucket 與 Queue（一次即可）
npx wrangler r2 bucket create pcit-tasks
npx wrangler queues create pcit-tasks

# 3. 設定 Secret
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET

# 4. 部署
npm run deploy
```

> **注意**：Cloudflare Queue 需要 Workers **Paid** 方案。

---

## 授權

[MIT License](LICENSE)
