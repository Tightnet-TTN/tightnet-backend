import test from "node:test";
import assert from "node:assert/strict";
import worker, { updatePrices } from "../src/index.js";

function db() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        first: async () => ({ ok: 1 }),
        all: async () => ({ results: [...rows.values()].sort((a,b) => a.symbol.localeCompare(b.symbol)) }),
        bind(...args) {
          return { run: async () => { rows.set(args[0], { symbol: args[0], price_usd: args[1], source: args[2], updated_at: args[3] }); } };
        }
      };
    }
  };
}
test("health confirms D1", async () => {
  const res = await worker.fetch(new Request("https://example.com/health"), { DB: db() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).database, true);
});
test("health fails closed when DB missing", async () => {
  const res = await worker.fetch(new Request("https://example.com/health"), {});
  assert.equal(res.status, 503);
});
test("prices starts empty with clear freshness disclaimer", async () => {
  const res = await worker.fetch(new Request("https://example.com/prices"), { DB: db() });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.count, 0);
  assert.match(payload.note, /snapshots/);
});
test("unknown routes return 404", async () => {
  const res = await worker.fetch(new Request("https://example.com/"), { DB: db() });
  assert.equal(res.status, 404);
});
test("scheduled refresh persists validated Binance prices", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const pair = new URL(url).searchParams.get("symbol");
    return new Response(JSON.stringify({ symbol: pair, price: pair === "BTCUSDT" ? "90000" : pair === "ETHUSDT" ? "3000" : "200" }), { status: 200 });
  };
  try {
    const database = db();
    await updatePrices({ DB: database });
    assert.equal(database.rows.size, 3);
    assert.equal(database.rows.get("BTC").price_usd, 90000);
  } finally { globalThis.fetch = original; }
});
test("rejects nonpositive prices without persisting", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => new Response(JSON.stringify({ symbol: new URL(url).searchParams.get("symbol"), price: "-1" }), { status: 200 });
  try {
    const database = db();
    await assert.rejects(updatePrices({ DB: database }), /All market price refreshes failed/);
    assert.equal(database.rows.size, 0);
  } finally { globalThis.fetch = original; }
});
