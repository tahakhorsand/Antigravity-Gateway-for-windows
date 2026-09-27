import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  createApiKeyDb, 
  listApiKeysDb, 
  deleteApiKeyDb, 
  toggleApiKeyDb, 
  validateApiKeyDb, 
  hasActiveApiKeysDb 
} from './db.js';

test('Virtual API Keys Lifecycle: create, list, validate, toggle, delete', () => {
  const key = createApiKeyDb({ name: 'Test Key' });
  assert.ok(key.id);
  assert.equal(key.name, 'Test Key');
  assert.ok(key.apiKey.startsWith('sk-ag-'));

  const list = listApiKeysDb();
  assert.ok(list.some(k => k.id === key.id));

  // Validation
  const validated = validateApiKeyDb(key.apiKey);
  assert.ok(validated);
  assert.equal(validated.id, key.id);

  // Toggle
  const nowActive = toggleApiKeyDb(key.id);
  assert.equal(nowActive, false);
  assert.equal(validateApiKeyDb(key.apiKey), null);

  toggleApiKeyDb(key.id);
  assert.ok(validateApiKeyDb(key.apiKey));

  // Delete
  assert.ok(deleteApiKeyDb(key.id));
  assert.equal(validateApiKeyDb(key.apiKey), null);
});
