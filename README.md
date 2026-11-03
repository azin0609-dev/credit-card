# credit-card：信用卡管理

管理自己的多張信用卡：

- **結帳日／繳款截止日**：設定每月幾號結帳、幾號繳款，自動算出每一期的日期（31 號遇到小月以月底計算）。
- **最低應繳金額**：依台灣多數銀行的規則試算，也可以直接輸入銀行帳單上的實際金額。
- **欠款追蹤**：已出帳未繳、未出帳消費、未到期分期、總欠款與可用額度。
- **提醒**：即將截止、已逾期的帳單一打開就看得到；繳款截止日可以加到手機行事曆，由行事曆提前通知。

有兩種用法，計算規則完全相同：

| | 手機 App（`web/`） | 命令列工具（`creditcard/`） |
| --- | --- | --- |
| 適合 | 日常使用、家人各自在自己手機上用 | 在電腦終端機操作 |
| 資料存放 | 各自手機的瀏覽器裡，不會上傳 | 電腦上的 SQLite 檔 |
| 提醒 | 打開 App 時提醒＋手機行事曆 | `ccm upcoming` |

---

## 手機 App

一個可以「加到主畫面」的網頁 App（PWA），不需要伺服器、不需要帳號：

- **每個人的資料只存在自己的手機。** 夫妻、家人打開同一個網址，各自記錄，互相看不到對方的資料。
- 加到主畫面後就像一般 App，沒有網路也能開啟。
- 支援深色模式。

### 怎麼用

1. 用手機打開 App 的網址（見下方「部署」）。
2. 加到主畫面：
   - **iPhone**：用 Safari 開啟 → 點下方「分享」→「加入主畫面」。
   - **Android**：用 Chrome 開啟 → 右上角選單 ⋮ →「安裝應用程式」或「加到主畫面」。
3. 新增卡片（名稱、結帳日、繳款截止日、額度）。
4. 若手上已經有一張還沒繳的帳單，在卡片頁點「輸入最近一期帳單」，填入銀行帳單上的應繳總額與最低應繳。
5. 之後刷卡就到「記一筆」記錄；繳款可以在卡片頁一鍵「繳最低」或「繳清」。
6. 到「提醒」頁把繳款截止日加到手機行事曆（.ics 檔，或逐張加到 Google 日曆）。

### 備份（很重要）

資料只存在手機的瀏覽器裡。**換手機、清除瀏覽器資料、刪除 App 之前，請先到「設定 → 匯出備份檔」**，把檔案存到雲端硬碟或傳給自己，到新手機再「匯入備份檔」。超過 30 天沒備份，總覽頁會提醒你。

### 部署

`web/` 資料夾是純靜態網站，放到任何支援 HTTPS 的靜態網站空間都可以（PWA 與離線功能需要 HTTPS）。網站本身不含任何個人資料。

**方法一：GitHub Pages（已附自動部署設定 `.github/workflows/pages.yml`）**

1. GitHub Pages 用在 private repo 需要付費方案（GitHub Pro）。免費帳號請先把 repo 改成 public（程式碼裡沒有任何個人資料），或改用方法二。
2. 到 repo 的 **Settings → Pages**，把 **Source** 設為 **GitHub Actions**。
3. 把程式合併到 `main` 分支，就會自動部署。網址會是 `https://<帳號>.github.io/credit-card/`。

**方法二：Cloudflare Pages（private repo 也免費）**

在 Cloudflare Pages 連結這個 repo，Framework preset 選 None、Build command 留空、Build output directory 填 `web`。

### 本機試用

```bash
npm run serve
```

然後用瀏覽器開 <http://localhost:8000>。

---

## 命令列工具（ccm）

只需要 Python 3.10 以上，不需要任何第三方套件。

```bash
pip install -e .
```

安裝後即可使用 `ccm` 指令（不安裝也可以在專案目錄下用 `python3 -m creditcard`）。資料預設存放在 `~/.credit-card/cards.db`，可用環境變數 `CREDIT_CARD_DB` 或 `--db` 指定。

```bash
ccm card add 國泰CUBE --bank 國泰世華 --last4 1234 -s 25 -d 9 --limit 100000
ccm stmt set 國泰CUBE 2026-10-25 --balance 12345 --min 1235   # 輸入手上的帳單
ccm txn add 國泰CUBE 2655 晚餐 -c 餐飲                         # 記一筆消費
ccm txn add 國泰CUBE 300 退貨 --refund                         # 退款
ccm inst add 國泰CUBE 36000 12 iPhone --start-date 2026-08-10   # 分期
ccm pay add 國泰CUBE --min                                      # 繳最低（或 --full、或直接輸入金額）
ccm                                                              # 總覽
ccm upcoming                                                     # 未來 7 天提醒
ccm card show 國泰CUBE                                           # 單張卡片詳情
ccm stmt list 國泰CUBE                                           # 歷期帳單
```

| 指令 | 說明 |
| --- | --- |
| `ccm` / `ccm summary` | 所有卡片總覽 |
| `ccm upcoming [--days N]` | 未來 N 天（預設 7）內的繳款、結帳提醒與逾期警示 |
| `ccm card add NAME -s 結帳日 -d 繳款日 [--bank] [--last4] [--limit] [--min-rate] [--min-floor] [--note]` | 新增卡片 |
| `ccm card list` / `show CARD` / `edit CARD [...]` / `remove CARD [-y]` | 列出、查看、修改、刪除卡片 |
| `ccm txn add CARD 金額 [說明] [--date] [-c 類別] [--refund]` | 記錄消費（退款用 `--refund` 或負數） |
| `ccm txn list [--card] [--from] [--to] [-n]` / `remove ID` | 列出、刪除消費 |
| `ccm pay add CARD [金額 \| --full \| --min] [--date] [--note]` | 記錄繳款 |
| `ccm pay list [--card] [--from] [--to] [-n]` / `remove ID` | 列出、刪除繳款 |
| `ccm inst add CARD 總額 期數 [說明] [--start-date]` | 新增分期，每月自動入帳一期 |
| `ccm inst list [--card] [--all]` / `remove ID` | 列出、刪除分期 |
| `ccm stmt list CARD [-n]` | 歷期帳單 |
| `ccm stmt set CARD 結帳日 [--balance] [--min]` / `unset CARD 結帳日` | 輸入／移除銀行帳單實際金額 |

`CARD` 可以是卡片名稱或 ID。全域選項 `--db`、`--today` 要放在指令前面，例如 `ccm --today 2026-12-01 upcoming` 可以試算某一天的狀況。

---

## 計算規則

- **帳單週期**：上一個結帳日的隔天 ～ 本次結帳日（含）。結帳日當天仍屬於進行中的週期，隔天才算出帳。
- **繳款截止日**：結帳日之後第一個「每月繳款日」。例如 25 日結帳、9 日繳款 → 10/25 結帳的帳單在 11/9 截止。
- **本期應繳總額** = 上期應繳總額 − 週期內的繳款 + 週期內的新增消費（含分期入帳、退款）。
- **最低應繳金額** = 一般消費 × 比例（預設 10%，無條件進位到元）+ 分期當期金額 + 超過信用額度的部分 + 上期未繳足的最低應繳。不足下限（預設 $1,000）以下限計；應繳總額低於下限時須全額繳清。
- **已繳金額**：該期結帳日之後到下一個結帳日（含）之間的繳款。
- **狀態**：免繳／待繳／已繳最低／已繳清／逾期（截止日後仍未繳足最低應繳）。
- **總欠款** = 目前帳上欠款（已出帳未繳 + 未出帳消費）+ 尚未入帳的分期金額；**可用額度** = 信用額度 − 總欠款。
- **分期**：每期金額取整數元，餘數併入第一期；從第一期入帳日起每月同一天入帳一期。

> 各銀行的最低應繳算法（預借現金、利息、手續費等）不盡相同，程式的數字是試算值。
> 收到帳單後建議輸入實際的「本期應繳總額」與「最低應繳金額」，之後各期會以此為基礎接續計算。
> 目前不計算循環利息與違約金；變更卡片的結帳日會讓過去的帳單依新結帳日重新計算。

---

## 開發

```bash
python3 -m unittest discover -s tests -v   # Python（命令列工具）
npm test                                   # JavaScript（手機 App）
```

推送到 GitHub 時會自動執行兩邊的測試（`.github/workflows/test.yml`）。兩邊的測試案例互相對應，修改計算規則時請兩邊一起改。

| 路徑 | 內容 |
| --- | --- |
| `web/billing.js` | 手機 App 的日期、金額與帳單計算 |
| `web/calendar.js` | 行事曆提醒（.ics、Google 日曆連結） |
| `web/store.js` | 資料儲存（localStorage）與備份檔驗證 |
| `web/app.js` | 畫面與操作 |
| `web/sw.js`、`web/manifest.webmanifest` | 離線使用與加到主畫面 |
| `creditcard/billing.py` 等 | 命令列工具（Python） |
| `tests/` | Python 測試；`tests/web/` 為 JavaScript 測試 |
