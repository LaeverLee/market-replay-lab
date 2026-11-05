# Binance BTCUSDT USDⓈ-M 歷史資料

資料時間使用 UTC。已收錄 2020-01-01 至 2026-11-05 的完整 1m 成交 K 線，另保存同期間可取得的標記價格和資金費率。標記價格在 2020-01-19 與 2020-12-17 仍有兩段缺口，共缺 53 根，官方日檔與 REST 均無法補齊。來源為 Binance Public Data 及 Binance USDⓈ-M REST。未來日期隨官方公布後再補入。

- `binance-usdm/monthly/` 與 `binance-usdm/daily/` 保留官方 ZIP 和 SHA-256 校驗檔。
- `binance-usdm/rest/` 保存缺少的成交及標記價格補檔和 2026-11-01 至 11-05 的資金費率。補檔的來源及本機 SHA-256 記錄在 `manifest.json`。
- `coverage-audit.json` 記錄逐根檢查結果。 `strategy-requirements-summary.json` 是研究策略的需求彙總。
- 回測服務按 UTC 邊界由 1m 成交 K 線組合 3m、5m、15m、30m、1h、4h、1d。只使用完整 K 線，遇到缺根會停止並顯示日期。標記價格和資金費率保留原資料，現有回測仍依各策略版本的原執行規則，不會自行加入這些成本。

從儲存庫根目錄更新與驗證：

    python history_data/sync_binance.py --through 2026-11-05 --rest-days 2026-10-28 2026-11-05 --rest-funding-days 2026-11-01 2026-11-02 2026-11-03 2026-11-04 2026-11-05 --rest-mark-gaps history_data/initial-mark-gaps.json
    python history_data/audit.py

標記價格補檔使用首次檢查的缺口清單，可加 `--strict-mark` 讓任何標記價格缺口視為檢查失敗。

來源：[Binance Public Data](https://github.com/binance/binance-public-data)、[Binance USDⓈ-M Market Data API](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data)。
