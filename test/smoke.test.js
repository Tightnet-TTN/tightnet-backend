import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
test('health returns 503 without DB', async () => { const r = await worker.fetch(new Request('https://example.com/health'), {}); assert.equal(r.status, 503); });
