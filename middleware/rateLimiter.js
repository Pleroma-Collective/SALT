const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

// Rate limiting can be disabled via environment variable
// Default is enabled (true) unless explicitly set to 'false'
const rateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== 'false';

if (!rateLimitEnabled) {
  console.log('⚠️  Rate limiting DISABLED');
  module.exports = {
    apiLimiter: (req, res, next) => next(),
    apiMutationLimiter: (req, res, next) => next(),
    onboardingLimiter: (req, res, next) => next(),
    authLimiter: (req, res, next) => next(),
    strictLimiter: (req, res, next) => next(),
    uploadLimiter: (req, res, next) => next()
  };
  return;
}

console.log('✅ Rate limiting ENABLED');

function isOnboardingReadRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const requestPath = String(req.originalUrl || '')
    .split('?')[0]
    .replace(/\/$/, '')
    .toLowerCase();
  return requestPath === '/api/config' || requestPath === '/api/access/setup';
}

function isReadRequest(req) {
  return req.method === 'GET' || req.method === 'HEAD';
}

// General API rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // Dashboard pages poll several independent status APIs. Keep this coarse
  // per-IP ceiling above normal multi-tab use; sensitive operations retain
  // their stricter route-specific limiters below.
  max: 600,
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Public onboarding reads have their own bucket so normal dashboard API
  // traffic cannot lock a user out of setup progress.
  skip: req => !isReadRequest(req) || isOnboardingReadRequest(req),
  // Removed keyGenerator - use default (handles IPv6 correctly)
});

// Keep state-changing API traffic on the original, lower allowance rather
// than letting mutations inherit the larger dashboard polling budget.
const apiMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isReadRequest,
});

const onboardingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { error: 'Too many setup requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limiter for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 login attempts per window
  message: { error: 'Too many login attempts, please try again in 15 minutes.' },
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false
});

// Strict limiter for sensitive operations
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  // Authenticated traffic keys per account so players sharing a NAT/ISP IP do
  // not pool into one bucket; anonymous traffic keeps the library's IP keying
  // (IPv6-safe).
  keyGenerator: (req) => (req.user && req.user.id) ? `user:${req.user.id}` : ipKeyGenerator(req.ip),
  message: (req, res) => {
    // Handler-only code path: runs exactly when the limit is hit, so this
    // doubles as the rate-limit monitoring log (v8 removed onLimitReached).
    console.log(`🚦 Rate limit reached: ${req.user && req.user.id ? `user:${req.user.id}` : req.ip} -> ${req.originalUrl}`);
    const reset = Number(res.getHeader('RateLimit-Reset')) ||
      Number(String(res.getHeader('RateLimit') || '').split(/reset=/)?.[1]) || 0;
    const minutes = Math.max(1, Math.ceil(reset / 60));
    return {
      error: `Too many requests, please slow down.${reset > 0 ? ` Try again in ~${minutes} minute${minutes === 1 ? '' : 's'}.` : ''}`,
    };
  },
  standardHeaders: true,
  legacyHeaders: false
});

// File upload limiter
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 uploads per hour
  message: { error: 'Too many file uploads, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = {
  apiLimiter,
  apiMutationLimiter,
  onboardingLimiter,
  authLimiter,
  strictLimiter,
  uploadLimiter
};
