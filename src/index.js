const ASSETS = Object.freeze({ BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" });
const STALE_AFTER_SECONDS = 900;
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const errorMessage = (err) => err instanceof Error ? err.message : String(err);

// Price providers, tried in order for each asset.
// api.binance.com rejects requests from some regions (HTTP 451), and Cloudflare
// Workers can run from those regions, so the public market-data mirror goes first
// and Coinbase is the independent fallback.
async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function binanceProvider(name, base) {
  return {
    name,
    async price(symbol, pair) {
      const payload = await getJson(`${base}/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`);
      const price = Number(payload.price);
      if (payload.symbol !== pair || !Number.isFinite(price) || price <= 0) throw new Error(`invalid price for ${symbol}`);
      return price;
    }
  };
}
export const PROVIDERS = Object.freeze([
  binanceProvider("Binance spot USDT (market-data API)", "https://data-api.binance.vision"),
  binanceProvider("Binance spot USDT", "https://api.binance.com"),
  {
    name: "Coinbase spot USD",
    async price(symbol) {
      const payload = await getJson(`https://api.coinbase.com/v2/prices/${encodeURIComponent(symbol)}-USD/spot`);
      const data = payload && payload.data;
      const price = Number(data && data.amount);
      if (!data || data.base !== symbol || data.currency !== "USD" || !Number.isFinite(price) || price <= 0) throw new Error(`invalid price for ${symbol}`);
      return price;
    }
  }
]);

export async function fetchPrice(symbol, pair, providers = PROVIDERS) {
  const errors = [];
  for (const provider of providers) {
    try {
      return { price: await provider.price(symbol, pair), source: provider.name };
    } catch (err) {
      errors.push(`${provider.name}: ${errorMessage(err)}`);
    }
  }
  throw new Error(`All providers failed for ${symbol} (${errors.join("; ")})`);
}

function withFreshness(row, now = Date.now()) {
  const age = Math.round((now - Date.parse(row.updated_at)) / 1000);
  return { ...row, age_seconds: Number.isFinite(age) ? age : null, stale: !Number.isFinite(age) || age > STALE_AFTER_SECONDS };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
    if (url.pathname === "/health") {
      if (!env.DB) return json({ service: "TIGHTNET", status: "degraded", database: false }, 503);
      try {
        await env.DB.prepare("SELECT 1 AS ok").first();
        return json({ service: "TIGHTNET", status: "online", database: true });
      } catch {
        return json({ service: "TIGHTNET", status: "degraded", database: false }, 503);
      }
    }
    if (url.pathname === "/prices") {
      if (!env.DB) return json({ error: "Database binding unavailable" }, 503);
      try {
        const { results } = await env.DB.prepare("SELECT symbol, price_usd, source, updated_at FROM market_prices ORDER BY symbol").all();
        const assets = results.map(row => withFreshness(row));
        return json({
          assets,
          count: assets.length,
          stale_count: assets.filter(a => a.stale).length,
          stale_after_seconds: STALE_AFTER_SECONDS,
          as_of: new Date().toISOString(),
          note: "Prices are stored snapshots; check updated_at for freshness."
        });
      } catch {
        return json({ error: "Price database query failed; verify migration" }, 503);
      }
    }
    return json({ error: "Not found", endpoints: ["/health", "/prices"] }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updatePrices(env));
  }
};

export async function updatePrices(env, providers = PROVIDERS) {
  if (!env.DB) throw new Error("Missing D1 DB binding");
  const results = await Promise.allSettled(Object.entries(ASSETS).map(async ([symbol, pair]) => {
    const { price, source } = await fetchPrice(symbol, pair, providers);
    await env.DB.prepare(`INSERT INTO market_prices (symbol, price_usd, source, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET price_usd=excluded.price_usd, source=excluded.source, updated_at=excluded.updated_at`)
      .bind(symbol, price, source, new Date().toISOString()).run();
    return { symbol, source };
  }));
  const failures = results.filter(x => x.status === "rejected");
  if (failures.length) {
    console.error("Price refresh partially/fully failed", failures.map(x => errorMessage(x.reason)));
    if (failures.length === results.length) throw new Error("All market price refreshes failed");
  }
  console.log("Price refresh finished", {
    success: results.length - failures.length,
    failed: failures.length,
    sources: results.filter(x => x.status === "fulfilled").map(x => x.value)
  });
}
