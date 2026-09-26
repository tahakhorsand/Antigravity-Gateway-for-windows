import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAppWindow, openConversationInWindow } from './antigravity-window.js';

test('picks the Antigravity app window served by the current language server', () => {
  const targets = [
    { type: 'page', url: 'https://example.com/', id: 'browser-tab' },
    { type: 'page', url: 'https://127.0.0.1:61000/', id: 'old-window' },
    { type: 'page', url: 'https://127.0.0.1:61388/c/abc', id: 'app' },
    { type: 'service_worker', url: 'https://127.0.0.1:61388/sw.js', id: 'sw' }
  ];
  assert.equal(pickAppWindow(targets, [61388, 61389]).id, 'app');
  assert.equal(pickAppWindow(targets, []).id, 'old-window');
  assert.equal(pickAppWindow([{ type: 'page', url: 'https://example.com/' }], [1]), null);
});

test('refuses anything that is not a conversation id', async () => {
  const result = await openConversationInWindow('"); alert(1); ("');
  assert.equal(result.ok, false);
});
