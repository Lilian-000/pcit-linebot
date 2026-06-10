# PCIT LINE Bot — 防詐騙小幫手

在 Cloudflare Workers 上實作的 LINE Messaging API bot，整合 Workers AI (`@cf/openai/gpt-oss-120b`) 提供「匯款前風險判斷／人頭戶自保／已受害申訴」三種情境的 AI 諮詢。

> 詳細工程藍圖：[issue #2](https://github.com/Lilian-000/pcit-linebot/issues/2#issuecomment-4425768321)

🌐 倡議網站：[pcit-tw.pages.dev](https://pcit-tw.pages.dev)
📋 政策提案（附議中）：[reurl.cc/R2moVe](https://reurl.cc/R2moVe)
📧 聯絡：pcit.tw@gmail.com

---

## 這個專案從哪裡來

發起人林俐伶（Liliane），台中榮總婦產科暨母胎醫學專科醫師。

2026 年 3 月，她的銀行帳戶在毫不知情的情況下收到詐騙集團的金流，隨即遭到警示凍結。跑完整個申訴流程後，她意識到：台灣的收款端保護是空白，而大多數當事人連第一步該打給誰都不知道。

她因此創辦 **PCIT 倡議**，要求金管會參考加拿大 Interac e-Transfer 模型，建立「收款人入帳確認機制」——在陌生款項入帳前通知收款人，給他們選擇接受或拒絕的權利。

> 掛號信要簽收，匯款為什麼不用？

這個 LINE Bot 是倡議的延伸：**在制度改變之前，至少有一個工具能陪著那些被卡住的人，在最茫然的時候得到第一個可靠的答案。**

---

## 服務對象與使用情境

Bot 服務三類使用者：

| 角色 | 情境 | Bot 能做什麼 |
|------|------|-------------|
| **A：準備匯款** | 看到網拍、租屋、求職訊息，不確定安不安全 | 風險評估 → 提醒注意事項 → 建議查證方式 |
| **B：收到不明匯款** | 帳戶多了一筆陌生轉帳，擔心被當人頭戶 | 說明風險 → 引導通報 165 → 解釋後續流程 |
| **C：帳戶已被警示** | 帳戶凍結中，不知道怎麼申訴 | 申訴流程說明 → 文件清單 → 協助起草申訴書 |

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

| Method | Path                 | 用途                                       |
| ------ | -------------------- | ---------------------------------------- |
| `POST` | `/line/webhook`      | LINE webhook（驗簽 + 派工）                    |
| `GET`  | `/tasks/:taskId`     | 使用者實際看到的 HTML 結果頁（含 Markdown 渲染與輪詢）      |
| `GET`  | `/api/tasks/:taskId` | 前端輪詢用的 JSON 狀態 API                       |
| `GET`  | `/test/health`       | 健康檢查，回傳各 binding 是否註冊                    |
| `POST` | `/test/tasks`        | 測試：跑完整非同步流程（免 LINE 簽章）                   |
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

| 種類      | 名稱                          | 取得／建立方式                                                                  |
| ------- | --------------------------- | ------------------------------------------------------------------------ |
| Secret  | `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers Console → Messaging API → Issue long-lived token         |
| Secret  | `LINE_CHANNEL_SECRET`       | LINE Developers Console → Basic settings                                 |
| Binding | `AI`                        | Workers AI（無需建立資源）                                                       |
| Binding | `TASK_BUCKET`               | `npx wrangler r2 bucket create pcit-tasks`                               |
| Binding | `TASK_QUEUE`                | `npx wrangler queues create pcit-tasks`（需 Workers Paid 方案才能上 production） |

> 本機 `wrangler dev` 會自動模擬 R2 與 Queue，**完全不需先建立雲端資源**，可立刻開測。

---

## 快速啟動（本機）

```bash
# 1. 安裝依賴
npm install

# 2. 設定本機環境變數
cp .dev.vars.example .dev.vars
# 編輯 .dev.vars，填入實際 LINE token / secret
# （若只想跑 /test/* 路由，可以先填假值，但 /line/webhook 會回 401）

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

### C. 完整非同步流程（模擬 LINE webhook 行為，不需簽章）

```bash
# 1. 建立任務
curl -X POST http://localhost:8787/test/tasks \
  -H 'Content-Type: application/json' \
  -d '{"message":"我前天匯了 30000 元給網拍賣家，現在他封鎖我，怎麼辦？"}'

# 2. 用瀏覽器打開 resultUrl，會看到「處理中……」並自動每 5 秒輪詢
open "http://localhost:8787/tasks/<taskId>"
```

### D. 真正用 LINE App 測試

1. 在 `.dev.vars` 填入真實 token/secret 後 `npm run deploy`
2. 把部署後的 URL `https://YOUR-WORKER.workers.dev/line/webhook` 貼到 LINE Developers Console → Webhook URL
3. 按 **Verify**，應顯示 `Success`
4. 加 bot 為好友後直接傳訊息，bot 會回一個分析結果頁的連結

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

## 如何貢獻

這是公益倡議專案，開放協作。

**目前可以協助的方向：**

- `src/lib/prompt.ts`：優化 AI prompt，讓回覆更準確、更有溫度
- 使用者體驗：結果頁的 HTML 設計與 Markdown 渲染
- 多語系：英文或其他語言支援

**參與方式：** 開 Issue 或直接 PR。沒有最低投入門檻。

---

## 相關專案

| 專案 | 說明 | Repo |
|------|------|------|
| pcit-website | 倡議網站（靜態 HTML + Cloudflare Pages） | [Lilian-000/pcit-website](https://github.com/Lilian-000/pcit-website) |

---

## 授權

[MIT License](LICENSE)

---

*PCIT Taiwan 倡議 · 林俐伶 × bestian · 2026*
