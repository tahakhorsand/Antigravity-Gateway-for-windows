import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptTurnState, isQuotaErrorStep } from './antigravity-auth-sync.js';
import { planShieldSwitch } from './account-order.js';

const SEC = 1000;
const MIN = 60 * SEC;
const user = { source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE' };
const toolCall = { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'run_command', args: {} }] };
const toolResult = { source: 'MODEL', type: 'GENERIC', status: 'DONE' };
const answer = { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Done.' };
const sysMsg = { source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE' };
// Exact error texts seen in real Antigravity transcripts
const quotaError = { source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h53m58s.' };
const streamError = { source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', content: 'Error: The stream was interrupted. Please continue the task you were working on.' };
const serverError = { source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'API error (attempt 1): INTERNAL (code 500): Internal error encountered.' };

test('a finished answer counts as idle only after it settles', () => {
  assert.equal(transcriptTurnState([user, toolCall, toolResult, answer], 2 * SEC).state, 'busy');
  assert.equal(transcriptTurnState([user, toolCall, toolResult, answer], 10 * SEC).state, 'idle');
  assert.equal(transcriptTurnState([user, answer, sysMsg, sysMsg], 10 * SEC).state, 'idle', 'trailing system messages are ignored');
});

test('mid-turn steps are busy, even when a tool runs for minutes', () => {
  assert.equal(transcriptTurnState([user], 3 * SEC).state, 'busy');
  assert.equal(transcriptTurnState([user, toolCall], 10 * MIN).state, 'busy', 'long build or test run');
  assert.equal(transcriptTurnState([user, toolCall, toolResult], 40 * SEC).state, 'busy', 'model thinking about the next step');
});

test('abandoned turns stop blocking a switch', () => {
  assert.equal(transcriptTurnState([user], 6 * MIN).state, 'idle', 'model never answered');
  assert.equal(transcriptTurnState([user, toolCall], 16 * MIN).state, 'idle', 'tool call untouched for 15+ minutes');
});

test('a quota error allows an immediate switch; other errors wait for Antigravity to retry', () => {
  assert.equal(isQuotaErrorStep(quotaError), true);
  assert.equal(isQuotaErrorStep(streamError), false);
  assert.equal(transcriptTurnState([user, toolCall, quotaError], 1 * SEC).state, 'quota_exhausted');
  assert.equal(transcriptTurnState([user, answer, streamError], 2 * SEC).state, 'busy');
  assert.equal(transcriptTurnState([user, serverError], 5 * SEC).state, 'busy');
  assert.equal(transcriptTurnState([user, serverError], 45 * SEC).state, 'idle');
});

const accounts = [
  { id: 'nabiaz', email: 'bob@example.com' },
  { id: 'aqua', email: 'carol@example.com' },
  { id: 'diit', email: 'alice@example.com' }
];
const quota = (weekly, burst, extra = {}) => ({ enabled: true, geminiWeekly: { pct: weekly }, gemini5h: { pct: burst }, ...extra });

test('shield leaves a healthy account alone', () => {
  const plan = planShieldSwitch({
    accounts,
    statsAccounts: { nabiaz: quota(60, 70), aqua: quota(90, 90), diit: quota(90, 90) },
    currentId: 'nabiaz',
    threshold: 20
  });
  assert.equal(plan.action, 'none');
});

test('shield moves to the healthiest account when the 5h window runs low', () => {
  const plan = planShieldSwitch({
    accounts,
    statsAccounts: { nabiaz: quota(60, 12), aqua: quota(51, 100), diit: quota(95, 90) },
    currentId: 'nabiaz',
    threshold: 20
  });
  assert.equal(plan.action, 'switch');
  assert.equal(plan.target.account.email, 'alice@example.com');
});

test('shield skips banned, cooling and nearly empty accounts', () => {
  const plan = planShieldSwitch({
    accounts,
    statsAccounts: { nabiaz: quota(5, 50), aqua: quota(90, 90, { is403Banned: true }), diit: quota(90, 90) },
    currentId: 'nabiaz',
    threshold: 20,
    isCoolingDown: (id) => id === 'diit'
  });
  assert.equal(plan.action, 'stranded');

  const nearlyEmpty = planShieldSwitch({
    accounts,
    statsAccounts: { nabiaz: quota(5, 50), aqua: quota(22, 90), diit: quota(90, 18) },
    currentId: 'nabiaz',
    threshold: 20
  });
  assert.equal(nearlyEmpty.action, 'stranded', 'candidates must be clearly above the threshold');
});

test('a quota error forces a switch even when the stored numbers still look fine', () => {
  const plan = planShieldSwitch({
    accounts,
    statsAccounts: { nabiaz: quota(80, 80), aqua: quota(90, 90), diit: quota(40, 40) },
    currentId: 'nabiaz',
    threshold: 20,
    forceLow: true
  });
  assert.equal(plan.action, 'switch');
  assert.equal(plan.target.account.id, 'aqua');
});

// Reproduces the live test of 2026-09-26: the switch fired while `sleep 40` ran as a
// background task, killing it. The agent's "waiting" message is not the end of the turn.
const bgStart = (id, cmd) => ({ source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: `Tool is running as a background task with task id: conv-1/${id}\nTask Description: ${cmd}` });
const bgDone = (id) => ({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: `<SYSTEM_MESSAGE>\n[Message] sender=conv-1/${id} content=Task id "conv-1/${id}" finished with result:\n\nThe command exited with code 0.` });
const waiting = { source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'I have started the command and will wait for it to complete.' };

test('a turn waiting on a background command is busy, however quiet it is', () => {
  const steps = [user, toolCall, toolResult, toolCall, bgStart('task-4', 'sleep 40'), waiting, bgDone('task-4'), toolCall, bgStart('task-8', 'sleep 40'), waiting];
  const verdict = transcriptTurnState(steps, 60 * SEC);
  assert.equal(verdict.state, 'busy');
  assert.deepEqual(verdict.backgroundTasks, ['conv-1/task-8']);

  const finished = [...steps, bgDone('task-8'), toolCall, toolResult, answer];
  assert.equal(transcriptTurnState(finished, 10 * SEC).state, 'idle');
});

test('background commands from an earlier turn do not block forever', () => {
  const steps = [user, toolCall, bgStart('task-2', 'npm run dev'), answer, user, toolCall, toolResult, answer];
  assert.equal(transcriptTurnState(steps, 10 * SEC).state, 'idle');
  assert.equal(transcriptTurnState([user, toolCall, bgStart('task-9', 'npm run dev'), answer], 16 * MIN).state, 'idle', 'capped by the stale window');
});
