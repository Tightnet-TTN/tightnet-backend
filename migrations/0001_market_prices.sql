CREATE TABLE IF NOT EXISTS market_prices (
  symbol TEXT PRIMARY KEY,
  price_usd REAL NOT NULL CHECK(price_usd > 0),
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
