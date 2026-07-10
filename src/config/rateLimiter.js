export function createInMemoryRateLimiter({ limit, windowMs, keyPrefix = 'default' }) {
  const buckets = new Map();

  // Cleanup periódico de buckets expirados
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets.entries()) {
      if (now - bucket.startedAt >= windowMs) {
        buckets.delete(key);
      }
    }
  }, Math.min(windowMs, 60000)); // Cleanup a cada janela ou 1min
  cleanupInterval.unref(); // Não impede o processo de fechar

  return {
    consume(key) {
      const now = Date.now();
      const bucketKey = `${keyPrefix}:${key}`;
      const bucket = buckets.get(bucketKey);

      if (!bucket || now - bucket.startedAt >= windowMs) {
        buckets.set(bucketKey, { startedAt: now, count: 1 });
        return true;
      }

      if (bucket.count >= limit) {
        return false;
      }

      bucket.count += 1;
      return true;
    },
  };
}
