import { getRuntimeConfig } from './runtimeConfig.js';

const runtimeConfig = getRuntimeConfig();

export function getAudioDurationSeconds(buffer, sampleRate = 16000) {
  if (!Buffer.isBuffer(buffer)) return 0;
  return buffer.length / 4 / sampleRate;
}

export function isPayloadTooLarge(buffer, maxBytes = runtimeConfig.rateLimits.maxPayloadBytes) {
  return Buffer.isBuffer(buffer) && buffer.length > maxBytes;
}
