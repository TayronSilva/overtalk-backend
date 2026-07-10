import test from 'node:test';
import assert from 'node:assert/strict';

import { getRuntimeConfig } from '../src/config/runtimeConfig.js';
import { createInMemoryRateLimiter } from '../src/config/rateLimiter.js';

test('getRuntimeConfig exposes centralized technical limits', () => {
  const config = getRuntimeConfig();

  assert.ok(config.rateLimits);
  assert.equal(typeof config.rateLimits.maxQueueSize, 'number');
  assert.equal(typeof config.rateLimits.maxSseConnections, 'number');
  assert.equal(config.rateLimits.maxDailyVoiceRegistrations, undefined);
});

test('rate limiter blocks requests above the configured limit', async () => {
  const limiter = createInMemoryRateLimiter({ limit: 2, windowMs: 1000, keyPrefix: 'test' });

  assert.equal(limiter.consume('alice'), true);
  assert.equal(limiter.consume('alice'), true);
  assert.equal(limiter.consume('alice'), false);
});
