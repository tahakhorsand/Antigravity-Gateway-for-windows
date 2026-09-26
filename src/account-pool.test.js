import test from 'node:test';
import assert from 'node:assert/strict';
import { knownAccountRecord, mergeAccount } from './account-pool.js';

const pool = [
  'dave@example.com',
  'carol@example.com',
  'bob@example.com',
  'alice@example.com'
];

test('all pooled accounts are configured, with room for another', () => {
  const record = knownAccountRecord('alice@example.com', pool);
  assert.equal(record.active, 'alice@example.com');
  assert.deepEqual(record.old, [
    'dave@example.com',
    'carol@example.com',
    'bob@example.com'
  ]);

  const withFifth = knownAccountRecord('alice@example.com', [...pool, 'new.account@gmail.com']);
  assert.equal(withFifth.old.length, 4);
  assert.equal(withFifth.old.at(-1), 'new.account@gmail.com');
});

test('re-authorizing an account keeps its saved project', () => {
  const merged = mergeAccount(
    { id: 'keep', email: 'carol@example.com', project_id: 'aicode-consumers', name: 'Old' },
    { id: 'ignore', email: 'carol@example.com', name: 'New', access_token: 'fresh' }
  );
  assert.equal(merged.id, 'keep');
  assert.equal(merged.project_id, 'aicode-consumers');
  assert.equal(merged.name, 'New');
});
