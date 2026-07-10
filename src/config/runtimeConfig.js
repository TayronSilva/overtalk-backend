import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CONFIG = {
  rateLimits: {
    sessionPerMinute: 100,
    apiPerMinute: 1000,
    pinPerMinute: 10,
    maxSseConnections: 50,
    maxQueueSize: 50,
    maxDailySessions: 999999,
    queueTimeoutMs: 60000,
    maxAudioDurationSeconds: 60,
    maxPayloadBytes: 50 * 1024 * 1024,
  },
};

function readConfigFromEnv() {
  const parsed = {};
  const env = process.env;

  const readNumber = (envKey, fallback) => {
    const raw = env[envKey];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };

  parsed.rateLimits = {
    sessionPerMinute: readNumber('RATE_LIMITS__SESSION_PER_MINUTE', DEFAULT_CONFIG.rateLimits.sessionPerMinute),
    apiPerMinute: readNumber('RATE_LIMITS__API_PER_MINUTE', DEFAULT_CONFIG.rateLimits.apiPerMinute),
    pinPerMinute: readNumber('RATE_LIMITS__PIN_PER_MINUTE', DEFAULT_CONFIG.rateLimits.pinPerMinute),
    maxSseConnections: readNumber('RATE_LIMITS__MAX_SSE_CONNECTIONS', DEFAULT_CONFIG.rateLimits.maxSseConnections),
    maxQueueSize: readNumber('RATE_LIMITS__MAX_QUEUE_SIZE', DEFAULT_CONFIG.rateLimits.maxQueueSize),
    maxDailySessions: readNumber('RATE_LIMITS__MAX_DAILY_SESSIONS', DEFAULT_CONFIG.rateLimits.maxDailySessions),
    queueTimeoutMs: readNumber('RATE_LIMITS__QUEUE_TIMEOUT_MS', DEFAULT_CONFIG.rateLimits.queueTimeoutMs),
    maxAudioDurationSeconds: readNumber('RATE_LIMITS__MAX_AUDIO_DURATION_SECONDS', DEFAULT_CONFIG.rateLimits.maxAudioDurationSeconds),
    maxPayloadBytes: readNumber('RATE_LIMITS__MAX_PAYLOAD_BYTES', DEFAULT_CONFIG.rateLimits.maxPayloadBytes),
  };

  return parsed;
}

export function getRuntimeConfig() {
  const envConfig = readConfigFromEnv();
  return {
    ...DEFAULT_CONFIG,
    ...envConfig,
    rateLimits: {
      ...DEFAULT_CONFIG.rateLimits,
      ...envConfig.rateLimits,
    },
  };
}

export function getConfigPath() {
  return path.join(__dirname, '..', '..', '.env');
}

export function loadRuntimeConfig() {
  const config = getRuntimeConfig();
  if (fs.existsSync(getConfigPath())) {
    return config;
  }
  return config;
}
