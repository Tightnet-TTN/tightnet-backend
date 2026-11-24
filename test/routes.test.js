import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
const req = p => new Request('https://example.test'+p);
test('health with D1', async () => { const DB={prepare:()=>({first:async()=>({ok:1})})}; const r=await worker.fetch(req('/health'),{DB}); assert.equal(r.status,200); assert.equal((await r.json()).database,true); });
test('prices with D1', async () => { const DB={prepare:()=>({all:async()=>({results:[{symbol:'BTC',price_usd:100}]})})}; const r=await worker.fetch(req('/prices'),{DB}); assert.equal(r.status,200); assert.equal((await r.json()).count,1); });
test('unknown path',async()=>assert.equal((await worker.fetch(req('/missing'),{})).status,404));
