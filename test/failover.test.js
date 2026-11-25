import test from "node:test";
import assert from "node:assert/strict";
import worker, { updatePrices } from "../src/index.js";

function db(seed = []) {
  const rows = new Map(seed.map(r => [r.symbol, r]));
  return {
    rows,
    prepare() {
      return {
        all: async () => ({ results: [...rows.values()] }),
        bind(...a) { return { run: async () => { rows.set(a[0], { symbol: a[0], price_usd: a[1], source: a[2], updated_at: a[3] }); } }; }
      };
    }
  };
}
const PRICES = { BTC: "90000", ETH: "3000", SOL: "200" };
const binanceOk = url => { const pair = new URL(url).searchParams.get("symbol"); return new Response(JSON.stringify({ symbol: pair, price: PRICES[pair.replace("USDT", "")] }), { status: 200 }); };
const coinbaseOk = url => { const base = new URL(url).pathname.split("/")[3].split("-")[0]; return new Response(JSON.stringify({ data: { base, currency: "USD", amount: PRICES[base] } }), { status: 200 }); };
async function withFetch(fn, body) {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return fn(String(url)); };
  try { await body(calls); } finally { globalThis.fetch = original; }
}

test("uses the Binance market-data API first", async () => {
  await withFetch(binanceOk, async calls => {
    const database = db();
    await updatePrices({ DB: database });
    assert.ok(calls.every(u => u.startsWith("https://data-api.binance.vision/")));
    assert.match(database.rows.get("BTC").source, /market-data API/);
  });
});
test("falls back to api.binance.com when the mirror is blocked (HTTP 451)", async () => {
  await withFetch(url => url.includes("data-api.binance.vision") ? new Response("", { status: 451 }) : binanceOk(url), async () => {
    const database = db();
    await updatePrices({ DB: database });
    assert.equal(database.rows.size, 3);
    assert.equal(database.rows.get("ETH").source, "Binance spot USDT");
  });
});
test("falls back to Coinbase when every Binance host fails", async () => {
  await withFetch(url => url.includes("binance") ? new Response("", { status: 451 }) : coinbaseOk(url), async () => {
    const database = db();
    await updatePrices({ DB: database });
    assert.equal(database.rows.size, 3);
    assert.equal(database.rows.get("SOL").price_usd, 200);
    assert.equal(database.rows.get("SOL").source, "Coinbase spot USD");
  });
});
test("rejects a Coinbase answer for the wrong asset", async () => {
  await withFetch(url => url.includes("binance") ? new Response("", { status: 500 }) : new Response(JSON.stringify({ data: { base: "DOGE", currency: "USD", amount: "1" } }), { status: 200 }), async () => {
    const database = db();
    await assert.rejects(updatePrices({ DB: database }), /All market price refreshes failed/);
    assert.equal(database.rows.size, 0);
  });
});
test("network errors and timeouts fall through to the next provider", async () => {
  await withFetch(url => { if (url.includes("binance")) throw new TypeError("network down"); return coinbaseOk(url); }, async () => {
    const database = db();
    await updatePrices({ DB: database });
    assert.equal(database.rows.size, 3);
  });
});
test("/prices flags stale snapshots", async () => {
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 3600_000).toISOString();
  const res = await worker.fetch(new Request("https://x.test/prices"), { DB: db([
    { symbol: "BTC", price_usd: 1, source: "s", updated_at: fresh },
    { symbol: "ETH", price_usd: 1, source: "s", updated_at: old }
  ]) });
  const body = await res.json();
  assert.equal(body.stale_count, 1);
  assert.equal(body.assets.find(a => a.symbol === "ETH").stale, true);
  assert.equal(body.assets.find(a => a.symbol === "BTC").stale, false);
});
