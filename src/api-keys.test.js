import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  createApiKeyDb, 
  listApiKeysDb, 
  deleteApiKeyDb, 
  toggleApiKeyDb, 
  validateApiKeyDb, 
  hasActiveApiKeysDb,
  updateApiKeyLimitDb,
  resetApiKeyUsageDb,
  recordApiKeyTokensDb
} from './db.js';

test('Virtual API Keys Lifecycle: create, list, validate, toggle, delete', () => {
  const key = createApiKeyDb({ name: 'Test Key' });
  assert.ok(key.id);
  assert.equal(key.name, 'Test Key');
  assert.ok(key.apiKey.startsWith('sk-ag-'));

  const list = listApiKeysDb();
  assert.ok(list.some(k => k.id === key.id));

  // Validation succeeds
  const validated = validateApiKeyDb(key.apiKey);
  assert.equal(validated.valid, true);
  assert.equal(validated.key.id, key.id);

  // Toggle disabled
  const nowActive = toggleApiKeyDb(key.id);
  assert.equal(nowActive, false);
  const disabledRes = validateApiKeyDb(key.apiKey);
  assert.equal(disabledRes.valid, false);
  assert.equal(disabledRes.reason, 'disabled');

  // Toggle re-enabled
  toggleApiKeyDb(key.id);
  const reenabledRes = validateApiKeyDb(key.apiKey);
  assert.equal(reenabledRes.valid, true);

  // Delete
  assert.ok(deleteApiKeyDb(key.id));
  const deletedRes = validateApiKeyDb(key.apiKey);
  assert.equal(deletedRes.valid, false);
  assert.equal(deletedRes.reason, 'not_found');
});

test('Virtual API Keys: Request limits and reset', () => {
  const key = createApiKeyDb({ name: 'Rate Limited Key', maxRequests: 2 });
  assert.equal(key.max_requests, 2);

  // Request 1: succeeds (count becomes 1)
  const req1 = validateApiKeyDb(key.apiKey);
  assert.equal(req1.valid, true);

  // Request 2: succeeds (count becomes 2)
  const req2 = validateApiKeyDb(key.apiKey);
  assert.equal(req2.valid, true);

  // Request 3: blocked due to limit
  const req3 = validateApiKeyDb(key.apiKey);
  assert.equal(req3.valid, false);
  assert.equal(req3.reason, 'request_limit_exceeded');
  assert.equal(req3.requestsCount, 2);
  assert.equal(req3.maxRequests, 2);

  // Reset usage
  const resetOk = resetApiKeyUsageDb(key.id);
  assert.ok(resetOk);

  // Request 4: succeeds after reset
  const req4 = validateApiKeyDb(key.apiKey);
  assert.equal(req4.valid, true);

  deleteApiKeyDb(key.id);
});

test('Virtual API Keys: Token limits and update limits', () => {
  const key = createApiKeyDb({ name: 'Token Limited Key', maxTokens: 1000 });
  assert.equal(key.max_tokens, 1000);

  // First request passes
  const req1 = validateApiKeyDb(key.apiKey);
  assert.equal(req1.valid, true);

  // Record 500 tokens burned
  recordApiKeyTokensDb(key.id, 500);

  // Still within limit
  const req2 = validateApiKeyDb(key.apiKey);
  assert.equal(req2.valid, true);

  // Record another 600 tokens burned (total: 1100 > 1000)
  recordApiKeyTokensDb(key.id, 600);

  // Blocked due to token limit
  const req3 = validateApiKeyDb(key.apiKey);
  assert.equal(req3.valid, false);
  assert.equal(req3.reason, 'token_limit_exceeded');

  // Upgrade limit via updateApiKeyLimitDb
  const updated = updateApiKeyLimitDb(key.id, { maxTokens: 5000 });
  assert.ok(updated);

  // Now allowed again
  const req4 = validateApiKeyDb(key.apiKey);
  assert.equal(req4.valid, true);

  deleteApiKeyDb(key.id);
});
