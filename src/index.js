const ASSETS = Object.freeze({ BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT" });
const SOURCE = "Binance spot USDT pairs";
const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const errorMessage = (err) => err instanceof Error ? err.message : String(err);

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
        return json({ assets: results, count: results.length, as_of: new Date().toISOString(), note: "Prices are stored snapshots; check updated_at for freshness." });
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

export async function updatePrices(env) {
  if (!env.DB) throw new Error("Missing D1 DB binding");
  const results = await Promise.allSettled(Object.entries(ASSETS).map(async ([symbol, pair]) => {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`Binance returned HTTP ${response.status} for ${symbol}`);
    const payload = await response.json();
    const price = Number(payload.price);
    if (payload.symbol !== pair || !Number.isFinite(price) || price <= 0) throw new Error(`Invalid Binance price for ${symbol}`);
    await env.DB.prepare(`INSERT INTO market_prices (symbol, price_usd, source, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET price_usd=excluded.price_usd, source=excluded.source, updated_at=excluded.updated_at`)
      .bind(symbol, price, SOURCE, new Date().toISOString()).run();
    return symbol;
  }));
  const failures = results.filter(x => x.status === "rejected");
  if (failures.length) {
    console.error("Price refresh partially/fully failed", failures.map(x => errorMessage(x.reason)));
    if (failures.length === results.length) throw new Error("All market price refreshes failed");
  }
  console.log("Price refresh finished", { success: results.length - failures.length, failed: failures.length });
}
