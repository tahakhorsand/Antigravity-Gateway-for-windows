import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from './config.js';
import { createLoginUrl, completeLogin } from './account-login.js';

test('sign-in URL asks for offline access with PKCE and a one-time state', (t) => {
  if (!CONFIG.CLIENT_ID) return t.skip('no oauth-client.json configured');
  const { url, state } = createLoginUrl('http://127.0.0.1:8045/oauth/callback');
  const params = new URL(url).searchParams;
  assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:8045/oauth/callback');
  assert.equal(params.get('access_type'), 'offline');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.ok(params.get('code_challenge').length >= 43);
  assert.equal(params.get('state'), state);
});

test('a callback with an unknown state is rejected before anything is saved', async () => {
  await assert.rejects(completeLogin({ code: 'x', state: 'not-a-real-state' }), /expired or was already used/);
  await assert.rejects(completeLogin({ error: 'access_denied' }), /cancelled or failed/);
});
