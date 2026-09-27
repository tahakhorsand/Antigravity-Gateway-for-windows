import test from 'node:test';
import assert from 'node:assert/strict';
import { getTailscaleStatus } from './tailscale.js';

test('getTailscaleStatus returns structured status object', async () => {
  const status = await getTailscaleStatus();
  assert.equal(typeof status.available, 'boolean');
  assert.equal(typeof status.running, 'boolean');
  assert.equal(typeof status.serve, 'object');
  if (status.running) {
    assert.ok(status.dnsName, 'DNS name should be present when running');
    assert.ok(Array.isArray(status.ips), 'IPs should be an array');
  }
});
