# 行情實驗室 · Market Replay


在儲存庫根目錄執行 `python backend/api.py`，再開啟 [本機行情實驗室](http://127.0.0.1:8783/)。一般回測不需額外套件。執行已核准的原生 Python 策略需其版本的相依套件。BTC-0183 使用 `numpy==2.2.6` 和 `pandas==2.2.3`。

- `dist/` 是瀏覽器介面，透過 HTTP API 呼叫 Python 後端。
- `backend/api.py` 處理 HTTP，`backend/services.py` 負責回測流程，`backend/repository.py` 儲存規則策略。未來可用資料庫替換同一儲存介面。
- `replay_engine/` 是不依賴網站的 Python 回測套件，可獨立匯入 `replay_engine.replay` 函式。它也提供原生策略 adapter 介面。
- 後端沿用本機應用資料目錄中的規則策略。可用 `MARKET_REPLAY_PORT` 或 `MARKET_REPLAY_DATA_DIR` 隔離測試。

在「歷史回測」的「回測策略」選擇 BTC-0183 即可執行原本的 Python 策略。它使用 BTCUSDT 永續合約 1h K 線和策略版本原有的成交及帳務設定，可下載完整 JSON。後端只執行已核准的本機版本，不提供任意 Python 檔上傳執行。專案內預設讀取共用的 `strategies/`，獨立下載網站時可用 `MARKET_REPLAY_STRATEGY_ROOT` 指定已交付的策略目錄。即時模擬目前執行規則 JSON，仍在瀏覽器運行。

使用「本機歷史資料」時，已匯入的規則會依各自週期在同一日期區間批次回測。也可以在「回測策略」選擇「批次 · 已匯入規則與本機 Python」，一併執行已核准且存在於本機的 Python 版本。批次會按週期共享讀取的 K 線，最多同時處理兩組。概覽列出個別結果和錯誤，點策略名稱可看明細。其他行情來源仍以單一週期回測。

即時模擬支援多個規則 JSON，按週期共用行情，每策略擁有獨立帳戶。儀表板可看各策略狀態、收盤權益、總報酬、損益與部位，點策略名稱可看曲線及逐筆成交。策略在每根新收盤增量更新指標。原生 Python 策略目前用於歷史回測。

在「歷史回測」或「即時模擬」匯入策略檔。執行時會自動使用所有符合行情、週期與模式的已匯入策略，依各策略的訊號進出場。策略清單會顯示無法在本次執行的原因。歷史回測可讀取 Binance 公開現貨 K 線、載入自備的 OHLCV CSV，或使用訊號 CSV 附帶的行情。每個策略各自記錄本金、部位、成交和損益。歷史回測的 K 線週期預設自動，優先採用歷史行情 CSV 的等距時間戳，否則採用規則 JSON 的 interval。回測會自動套用單一支援週期，多個支援週期時只顯示可用選項。內建 BTCUSDT 永續合約歷史行情可直接回測，資料範圍與更新方式見 [history_data](history_data/README.md)。單次最多 100,000 根（含暖機）。在即時頁可選 Binance 現貨或 USDⓈ-M 永續合約。交易對下拉選單從 Binance 載入該市場目前可交易的清單，支援搜尋。選擇交易對即切換報價及 K 線。沒有適用策略時，即時圖表預設顯示 15m、最近 120 根。有策略時自動帶入策略週期，右上角列出適用策略支援的週期。各策略在啟動模擬時選定週期，後續切換圖表不會改變已啟動策略。模擬執行中需先結束該輪，再切換交易對。歷史回測的圖表使用本次回測週期。畫面依瀏覽器繪圖節奏顯示最新一筆，策略仍以確認收盤的 K 線計算訊號。匯入策略後按「啟動即時模擬」，各策略按支援週期接收行情。REST 負責啟動暖機和重連補齊，策略以確認收盤的 K 線計算訊號。斷線會自動重連，缺口超過 1,000 根時暫停。請保留瀏覽器頁面開啟。

## 將現有 BTC Python 策略用於回測

在裝有 pandas 和該策略所需套件的 Python 環境，指定信任的策略檔、符合策略週期的已收盤行情和輸出位置。以下範例從自動交易策略專案根目錄執行。

    python sites/market-replay-lab/export_signals.py --strategy strategies/BTC-0094/v1.0.0/strategy.py --candles data/research-smoke/BTCUSDT-1h-2020-01.csv --output BTC-0094-signals.csv

再從策略庫匯入產出的 CSV，確認 K 線週期後執行回測。同一次回測會執行所有與目前行情完全一致的訊號 CSV，以及符合週期的規則 JSON。工具只保留 OHLCV 和四欄訊號。Python 執行在本機，請只執行已確認可信的原始碼。要用即時模式，須另以網站的 JSON 格式編寫規則。

## 模型

歷史與即時使用相同的單部位成交引擎。收盤決策、下一根開盤成交，滑價和手續費可設定。停損或停利須由策略本身的訊號或匯入規則明訂。淨損益和回撤按收盤權益計算，未平倉按收盤估值。遇到資料缺根時拒絕回測；即時模式可在公開端點保留範圍內補跑。歷史雙向訊號按 1 倍名義金額模擬；即時現貨支援做多。資金費、保證金、強平與掛單成交不在此模型內。現有 BTC 專案的嚴格 3 倍合約回測需使用獨立的合約引擎。

匯入的 JSON 存在當前瀏覽器。CSV、模擬帳戶和結果保留至頁面重整或關閉，逐筆成交可匯出 CSV。策略及上傳行情均由瀏覽器本機讀取。


即時策略 JSON 可用 `"interval": "1h"` 指定固定週期，或用 `"intervals": ["15m", "1h"]` 宣告支援的週期。多週期策略使用啟動時所選的圖表週期（若支援），否則採用 `interval` 指定的預設值或清單第一項。兩個欄位都省略時，策略可使用任何網站支援的週期。

## Render 免費雲端部署

使用此儲存庫根目錄的 `render.yaml` 建立 Render Blueprint，方案選 Free。服務使用 Render 提供的 HTTPS 網址，健康檢查為 `/api/health`。進入網站時使用帳號 `market-replay`，密碼從 Render 服務的 Environment 頁面讀取 `MARKET_REPLAY_PASSWORD`。請勿將密碼寫進 Git。

雲端版會讀取儲存庫的歷史行情，可以執行規則 JSON 和訊號 CSV 回測。原生 Python 策略目錄未隨公開儲存庫部署。免費服務會休眠，重啟可能清除雲端上傳的策略，建議保留匯入檔。即時模擬仍在開啟的瀏覽器頁面運行。

限制與配額見 [Render 免費方案](https://render.com/docs/free)。

## PythonAnywhere 免費雲端部署

使用免費 Beginner 帳號的 Web 頁面，新增 Manual configuration 的 Python 3.12 網站。將 GitHub 儲存庫下載到帳號家目錄的 `market-replay-lab`。部署只需要網站程式和公開歷史行情。

把服務的 WSGI 設定檔設為以下內容，並啟用 Force HTTPS。把範例網域換成實際網站網域，並在家目錄建立權限為 600 的 `.market-replay-password`，保存自行產生的至少 16 字元密碼。

    from pathlib import Path
    import sys

    base = Path.home()
    sys.path.insert(0, str(base / "market-replay-lab"))
    from backend.wsgi import create_application
    application = create_application(
        "YOUR-USERNAME.pythonanywhere.com",
        (base / ".market-replay-password").read_text().strip(),
        base / ".market-replay-data",
    )

登入帳號為 `market-replay`。匯入的規則策略存在該帳號的家目錄，可跨重啟保留。免費網站有一個 Web worker、512 MiB 空間，回測批次依序處理週期組。需依控制台提示延長網站效期。見 [PythonAnywhere 免費帳號](https://help.pythonanywhere.com/pages/FreeAccountsFeatures/)。
