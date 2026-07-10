export function createRateLimitMiddleware({ limiter, keyGenerator, message = 'Too many requests', statusCode = 429, logLabel = 'rate_limit' }) {
  return (req, res, next) => {
    const key = keyGenerator(req);
    const allowed = limiter.consume(key);

    if (!allowed) {
      console.warn(`[RATE_LIMIT] ${logLabel} bloqueado para key=${key}`);
      return res.status(statusCode).json({ error: message });
    }

    return next();
  };
}
