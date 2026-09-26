import test from 'node:test';
import assert from 'node:assert/strict';
import { orderAccountCandidates, shouldAdoptActiveSession } from './account-order.js';

const mushfiq = { id: 'diit', email: 'alice@example.com' };
const nabiaz = { id: 'nabiaz', email: 'bob@example.com' };
const aqualink = { id: 'aqua', email: 'carol@example.com' };

const statsAccounts = {
  diit: { geminiWeekly: { pct: 100 }, gemini5h: { pct: 100 }, subscriptionTier: 'PRO' },
  nabiaz: { geminiWeekly: { pct: 76.7 }, gemini5h: { pct: 0 }, subscriptionTier: 'PRO' },
  aqua: { geminiWeekly: { pct: 51.1 }, gemini5h: { pct: 100 }, subscriptionTier: 'PRO' }
};

test('token account matches the active session while that account can still serve', () => {
  const ordered = orderAccountCandidates(
    [nabiaz, aqualink, mushfiq],
    statsAccounts,
    {
      activeSessionId: 'diit',
      activeSessionEmail: 'alice@example.com',
      isCoolingDown: () => false
    }
  );

  assert.equal(ordered[0].email, 'alice@example.com');
  assert.equal(shouldAdoptActiveSession({
    activeSessionAccountId: 'diit',
    activeSessionEmail: 'alice@example.com'
  }, ordered[0]), false);
});

test('after the session account is exhausted, fallback serves another account and the session follows it', () => {
  const ordered = orderAccountCandidates(
    [mushfiq, nabiaz, aqualink],
    statsAccounts,
    {
      activeSessionId: 'diit',
      activeSessionEmail: 'alice@example.com',
      isCoolingDown: (id) => id === 'diit'
    }
  );

  assert.equal(ordered[0].email, 'carol@example.com');
  assert.equal(shouldAdoptActiveSession({
    activeSessionAccountId: 'diit',
    activeSessionEmail: 'alice@example.com'
  }, ordered[0]), true);
  assert.notEqual(ordered[0].email, 'bob@example.com');
});

test('disabled accounts are completely excluded from candidate list', () => {
  const disabledBob = { id: 'nabiaz', email: 'bob@example.com', enabled: false };
  const ordered = orderAccountCandidates(
    [mushfiq, disabledBob, aqualink],
    statsAccounts,
    { isCoolingDown: () => false }
  );

  assert.equal(ordered.some(a => a.email === 'bob@example.com'), false);
  assert.equal(ordered.length, 2);
});
