// src/retry.js

const { warn, error } = require('./logger.js');

// ═══════════════════════════════════════════════════════════════════════════════
// RETRY CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_OPTIONS = {
  retries: 3,
  minDelayMs: 500,
  maxDelayMs: 60000,
  factor: 2,
  onRetry: null // Optional callback: (attempt, error, delay) => void
};

// ═══════════════════════════════════════════════════════════════════════════════
// RETRY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {string} label - Label for logging
 * @param {object} options - Retry options
 * @returns {Promise} Result of successful function execution
 */
async function withRetry(fn, label = "", options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let attempt = 0;
  let delay = opts.minDelayMs;
  const errors = [];

  while (true) {
    try {
      attempt++;
      const result = await fn();
      
      // Log success if there were previous failures
      if (attempt > 1) {
        warn(`${label} succeeded on attempt ${attempt}`, "", "info");
      }
      
      return result;
    } catch (err) {
      errors.push({
        attempt,
        error: err,
        message: err?.message || String(err),
        timestamp: new Date().toISOString()
      });

      if (attempt >= opts.retries) {
        // All retries exhausted
        const errorSummary = errors.map(e => 
          `  Attempt ${e.attempt}: ${e.message}`
        ).join('\n');
        
        const finalMessage = label
          ? `${label} failed after ${attempt} attempts:\n${errorSummary}`
          : `Operation failed after ${attempt} attempts:\n${errorSummary}`;
        
        error(finalMessage);
        
        // Throw aggregated error
        const aggregatedError = new Error(finalMessage);
        aggregatedError.attempts = errors;
        aggregatedError.lastError = errors[errors.length - 1].error;
        throw aggregatedError;
      }

      // Determine if error is retryable
      if (!isRetryableError(err)) {
        warn(`${label} failed with non-retryable error: ${err?.message || err}`);
        throw err;
      }

      // Log retry attempt
      const attemptLabel = label ? `${label} (attempt ${attempt}/${opts.retries})` : `attempt ${attempt}/${opts.retries}`;
      warn(`${attemptLabel} failed, retrying after ${delay}ms: ${err?.message || err}`);

      // Call onRetry callback if provided
      if (opts.onRetry && typeof opts.onRetry === 'function') {
        try {
          opts.onRetry(attempt, err, delay);
        } catch (callbackError) {
          warn(`onRetry callback failed: ${callbackError.message}`);
        }
      }

      // Wait before retry
      await sleep(delay);

      // Calculate next delay with exponential backoff
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * opts.factor));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Determine if an error is retryable
 * @param {Error} err - Error to check
 * @returns {boolean} Whether the error is retryable
 */
function isRetryableError(err) {
  if (!err) return true;

  const message = err.message || String(err);
  const code = err.code;

  // Network errors - retryable
  const retryableNetworkCodes = [
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'NETWORK_ERROR',
    'TIMEOUT',
    'SERVER_ERROR'
  ];

  if (code && retryableNetworkCodes.includes(code)) {
    return true;
  }

  // RPC errors - some are retryable
  const retryableMessages = [
    'timeout',
    'timed out',
    'rate limit',
    'too many requests',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'connection refused',
    'socket hang up',
    'nonce too low', // Can happen in concurrent scenarios
    'replacement transaction underpriced' // Can retry with higher gas
  ];

  const lowerMessage = message.toLowerCase();
  if (retryableMessages.some(msg => lowerMessage.includes(msg))) {
    return true;
  }

  // Non-retryable errors
  const nonRetryableMessages = [
    'invalid address',
    'invalid signature',
    'insufficient funds',
    'gas required exceeds allowance',
    'execution reverted',
    'missing role',
    'access denied',
    'unauthorized'
  ];

  if (nonRetryableMessages.some(msg => lowerMessage.includes(msg))) {
    return false;
  }

  // Default: assume retryable
  return true;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Promise that resolves after delay
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADVANCED RETRY STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retry with custom backoff strategy
 * @param {Function} fn - Function to retry
 * @param {string} label - Label for logging
 * @param {Function} backoffFn - Custom backoff function (attempt) => delayMs
 * @param {number} maxRetries - Maximum retry attempts
 */
async function withCustomBackoff(fn, label, backoffFn, maxRetries = 3) {
  let attempt = 0;

  while (true) {
    try {
      attempt++;
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) {
        throw err;
      }

      const delay = backoffFn(attempt);
      warn(`${label} failed (attempt ${attempt}), retrying after ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * Retry until condition is met or timeout
 * @param {Function} fn - Function to retry
 * @param {Function} conditionFn - Condition to check result: (result) => boolean
 * @param {object} options - Options: { timeoutMs, intervalMs, label }
 */
async function retryUntil(fn, conditionFn, options = {}) {
  const {
    timeoutMs = 30000,
    intervalMs = 1000,
    label = 'retryUntil'
  } = options;

  const startTime = Date.now();

  while (true) {
    try {
      const result = await fn();
      
      if (conditionFn(result)) {
        return result;
      }

      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`${label} timeout after ${timeoutMs}ms`);
      }

      await sleep(intervalMs);
    } catch (err) {
      if (Date.now() - startTime > timeoutMs) {
        throw err;
      }
      await sleep(intervalMs);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  withRetry,
  withCustomBackoff,
  retryUntil,
  isRetryableError,
  sleep
};