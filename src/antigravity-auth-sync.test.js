import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildJetskiDocument,
  idTokenEmail,
  writeJetskiToken,
  formatRFC3339Micros,
  preserveConversationLayout,
  isAntigravitySessionBusy,
  scheduleLanguageServerSwitch,
  getPendingSwitch,
  cancelPendingSwitch
} from './antigravity-auth-sync.js';

function jwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `e30.${body}.sig`;
}

test('jetski token document carries the switched account identity', () => {
  const idToken = jwt({ email: 'alice@example.com' });
  const doc = buildJetskiDocument({
    access_token: 'access',
    refresh_token: 'refresh',
    expiry_timestamp: 1790413779
  }, idToken);

  assert.equal(doc.auth_method, 'consumer');
  assert.equal(doc.token.token_type, 'Bearer');
  assert.equal(doc.token.refresh_token, 'refresh');
  assert.equal(doc.id_token, idToken);
  assert.equal(idTokenEmail(doc.id_token), 'alice@example.com');
  assert.notEqual(idTokenEmail(doc.id_token), 'bob@example.com');
});

test('writing the jetski file replaces the previous account token', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-auth-'));
  writeJetskiToken(dir, {
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expiry_timestamp: 1790410000
  }, jwt({ email: 'bob@example.com' }));

  writeJetskiToken(dir, {
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expiry_timestamp: 1790413779
  }, jwt({ email: 'alice@example.com' }));

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'jetski-standalone-oauth-token'), 'utf8'));
  assert.equal(saved.token.refresh_token, 'new-refresh');
  assert.equal(idTokenEmail(saved.id_token), 'alice@example.com');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatRFC3339Micros formats timestamp with 6 decimal places', () => {
  const formatted = formatRFC3339Micros(1790413779);
  assert.match(formatted, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
});

test('preserveConversationLayout persists active conversation and pane to app_storage.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-storage-'));
  const storageFile = path.join(dir, 'app_storage.json');
  fs.writeFileSync(storageFile, JSON.stringify({
    'antigravity-multi-conversation-layout-v3-index': '[]'
  }));

  const testConvId = '12345678-abcd-ef01-2345-6789abcdef01';
  const success = preserveConversationLayout(testConvId, storageFile);
  assert.equal(success, true);

  const saved = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
  const index = JSON.parse(saved['antigravity-multi-conversation-layout-v3-index']);
  assert.deepEqual(index[0], [testConvId]);

  const layout = JSON.parse(saved[`antigravity-multi-conversation-layout-v3-${testConvId}`]);
  assert.equal(layout.rootNode.cascadeId, testConvId);
  assert.equal(layout.rootNode.type, 'pane');
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeGeminiDirWithTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gemini-'));
  const logDir = path.join(dir, 'antigravity', 'brain', 'conv-1', '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'transcript.jsonl');
  fs.writeFileSync(logFile, '{}\n');
  return { dir, logFile };
}

test('isAntigravitySessionBusy waits for a finished answer to settle', () => {
  const { dir, logFile } = fakeGeminiDirWithTranscript();
  fs.writeFileSync(logFile, [
    { step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE' },
    { step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'All done.' }
  ].map((step) => JSON.stringify(step)).join('\n') + '\n');
  const tenSecondsAgo = new Date(Date.now() - 10000);
  fs.utimesSync(logFile, tenSecondsAgo, tenSecondsAgo);
  assert.equal(isAntigravitySessionBusy(dir, 8000), false);
  assert.equal(isAntigravitySessionBusy(dir, 20000), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a switch requested while a task is running stays pending until cancelled or superseded', () => {
  const { dir } = fakeGeminiDirWithTranscript(); // transcript just written => busy
  const pending = scheduleLanguageServerSwitch(
    { email: 'Carol@example.com', refresh_token: 'r', access_token: 'a' },
    { geminiDir: dir, idleMs: 60000, pollMs: 50 }
  );
  assert.equal(pending.email, 'carol@example.com');
  assert.equal(getPendingSwitch().email, 'carol@example.com');

  scheduleLanguageServerSwitch(
    { email: 'alice@example.com', refresh_token: 'r', access_token: 'a' },
    { geminiDir: dir, idleMs: 60000, pollMs: 50 }
  );
  assert.equal(getPendingSwitch().email, 'alice@example.com');

  cancelPendingSwitch();
  assert.equal(getPendingSwitch(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
