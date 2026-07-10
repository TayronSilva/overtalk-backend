import test from 'node:test';
import assert from 'node:assert/strict';

import { getAudioDurationSeconds, isPayloadTooLarge } from '../src/config/payloadProtection.js';

test('detects payloads above the configured size', () => {
  const buffer = Buffer.alloc(1024);
  assert.equal(isPayloadTooLarge(buffer, 512), true);
  assert.equal(isPayloadTooLarge(buffer, 2048), false);
});

test('calculates audio duration from PCM buffer size', () => {
  const buffer = Buffer.alloc(16000 * 4);
  assert.equal(getAudioDurationSeconds(buffer, 16000), 1);
});
