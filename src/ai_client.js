const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Configuration
const AI_URL = process.env.AI_URL || 'http://localhost:8000/decide';
const AI_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS || '5000', 10);
const SHADOW_LOG = process.env.SHADOW_LOG || path.join(process.cwd(), 'shadow_log.ndjson');
const MAX_RETRIES = parseInt(process.env.AI_MAX_RETRIES || '3', 10);
const CACHE_TTL_MS = parseInt(process.env.AI_CACHE_TTL_MS || '30000', 10); // 30 seconds
const CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.AI_CIRCUIT_THRESHOLD || '5', 10);
const CIRCUIT_BREAKER_TIMEOUT = parseInt(process.env.AI_CIRCUIT_TIMEOUT || '60000', 10);

// Circuit breaker states
const CircuitState = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

/**
 * Circuit Breaker pattern implementation
 */
class CircuitBreaker extends EventEmitter {
  constructor(threshold = 5, timeout = 60000) {
    super();
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.nextAttempt = Date.now();
  }

  async execute(fn) {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        const error = new Error('Circuit breaker is OPEN');
        error.code = 'CIRCUIT_OPEN';
        throw error;
      }
      this.state = CircuitState.HALF_OPEN;
      this.emit('half-open');
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.emit('closed');
    }
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = CircuitState.OPEN;
      this.nextAttempt = Date.now() + this.timeout;
      this.emit('open', this.nextAttempt);
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttempt: this.nextAttempt
    };
  }
}

/**
 * Simple LRU Cache
 */
class LRUCache {
  constructor(maxSize = 100, ttlMs = 30000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    if (Date.now() - item.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recent)
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value) {
    // Remove oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

/**
 * Professional AI Client
 */
class AIClient extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.url = options.url || AI_URL;
    this.timeout = options.timeout || AI_TIMEOUT_MS;
    this.maxRetries = options.maxRetries || MAX_RETRIES;
    this.shadowLog = options.shadowLog || SHADOW_LOG;
    
    // Circuit breaker
    this.circuitBreaker = new CircuitBreaker(
      CIRCUIT_BREAKER_THRESHOLD,
      CIRCUIT_BREAKER_TIMEOUT
    );
    
    // Cache
    this.cache = new LRUCache(100, CACHE_TTL_MS);
    
    // Metrics
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      cachedResponses: 0,
      circuitBreakerTrips: 0,
      averageResponseTime: 0,
      lastRequestTime: null
    };
    
    // Axios instance with connection pooling
    this.axios = axios.create({
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'AI-Client-v2/1.0'
      },
      // Connection pooling
      httpAgent: require('http').Agent({ keepAlive: true, maxSockets: 5 }),
      httpsAgent: require('https').Agent({ keepAlive: true, maxSockets: 5 })
    });
    
    // Setup circuit breaker listeners
    this.circuitBreaker.on('open', (nextAttempt) => {
      this.metrics.circuitBreakerTrips++;
      this.emit('circuit-open', { nextAttempt });
      console.warn(`⚠️  Circuit breaker OPEN. Will retry at ${new Date(nextAttempt).toISOString()}`);
    });
    
    this.circuitBreaker.on('half-open', () => {
      this.emit('circuit-half-open');
      console.info('🔄 Circuit breaker HALF-OPEN. Attempting request...');
    });
    
    this.circuitBreaker.on('closed', () => {
      this.emit('circuit-closed');
      console.info('✅ Circuit breaker CLOSED. Normal operation resumed.');
    });
    
    // Ensure shadow log directory exists
    this._ensureShadowLogDir();
  }

  /**
   * Main decision function
   */
  async decide(state) {
    this.metrics.totalRequests++;
    this.metrics.lastRequestTime = Date.now();
    
    // Check if AI URL is configured
    if (!this.url) {
      const fallback = this._getFallbackDecision('no-ai-url');
      this._writeShadowLog({ state, decision: fallback, cached: false, fallback: true });
      return fallback;
    }

    // Generate cache key
    const cacheKey = this._generateCacheKey(state);
    
    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.metrics.cachedResponses++;
      this.emit('cache-hit', { cacheKey });
      return cached;
    }

    // Make request with circuit breaker
    try {
      const decision = await this.circuitBreaker.execute(() => 
        this._makeRequest(state)
      );
      
      // Cache successful response
      this.cache.set(cacheKey, decision);
      
      // Log to shadow log
      this._writeShadowLog({ state, decision, cached: false, fallback: false });
      
      this.metrics.successfulRequests++;
      this.emit('decision-success', { decision });
      
      return decision;
      
    } catch (error) {
      this.metrics.failedRequests++;
      
      // Handle circuit breaker open
      if (error.code === 'CIRCUIT_OPEN') {
        console.warn('Circuit breaker is OPEN, using fallback');
        const fallback = this._getFallbackDecision('circuit-open');
        this._writeShadowLog({ state, decision: fallback, error: error.message, fallback: true });
        return fallback;
      }
      
      // Use fallback for any error
      const fallback = this._getFallbackDecision('ai-error');
      this._writeShadowLog({ state, decision: fallback, error: error.message, fallback: true });
      this.emit('decision-error', { error, state });
      
      return fallback;
    }
  }

  /**
   * Make actual HTTP request with retries
   */
  async _makeRequest(state) {
    const startTime = Date.now();
    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.axios.post(this.url, state);
        
        // Update metrics
        const responseTime = Date.now() - startTime;
        this._updateAverageResponseTime(responseTime);
        
        // Validate response
        const decision = this._validateResponse(response.data);
        
        this.emit('request-success', { attempt, responseTime });
        
        return decision;
        
      } catch (error) {
        lastError = error;
        
        const isLastAttempt = attempt === this.maxRetries;
        const errorMsg = error.response?.data?.detail || error.message;
        
        console.warn(
          `AI request attempt ${attempt + 1}/${this.maxRetries + 1} failed: ${errorMsg}`
        );
        
        if (!isLastAttempt) {
          // Exponential backoff
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000);
          await this._sleep(backoffMs);
        }
      }
    }

    // All retries exhausted
    throw lastError || new Error('AI request failed after all retries');
  }

  /**
   * Validate AI response
   */
  _validateResponse(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid response format');
    }

    const decision = {
      action: data.action || 'hold',
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.0,
      score: typeof data.score === 'number' ? data.score : 0.0,
      expected_reward: typeof data.expected_reward === 'number' ? data.expected_reward : 0.0,
      reason: data.reason || 'unknown',
      risk_level: data.risk_level || 'medium',
      recommended_params: data.recommended_params || null,
      metadata: data.metadata || {}
    };

    // Validate action
    const validActions = ['rebalance', 'reduce', 'hold', 'close'];
    if (!validActions.includes(decision.action)) {
      console.warn(`Invalid action '${decision.action}', defaulting to 'hold'`);
      decision.action = 'hold';
    }

    // Clamp confidence
    decision.confidence = Math.max(0, Math.min(1, decision.confidence));

    return decision;
  }

  /**
   * Get fallback decision when AI is unavailable
   */
  _getFallbackDecision(reason) {
    return {
      action: 'hold',
      confidence: 0.0,
      score: 0.0,
      expected_reward: 0.0,
      reason: `fallback_${reason}`,
      risk_level: 'unknown',
      recommended_params: null,
      metadata: { fallback: true }
    };
  }

  /**
   * Generate cache key from state
   */
  _generateCacheKey(state) {
    const key = JSON.stringify({
      poolId: state.poolId,
      positionId: state.position?.id,
      price: Math.round((state.price || state.current_price || 0) * 1000) / 1000,
      timestamp: Math.floor((state.timestamp || Date.now()) / CACHE_TTL_MS)
    });
    
    // Use hash for shorter keys
    const crypto = require('crypto');
    return crypto.createHash('md5').update(key).digest('hex').substring(0, 16);
  }

  /**
   * Write to shadow log
   */
  _writeShadowLog(record) {
    try {
      const logEntry = {
        timestamp: Date.now(),
        ...record
      };
      
      fs.appendFileSync(this.shadowLog, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch (error) {
      console.error('Failed to write shadow log:', error.message);
    }
  }

  /**
   * Ensure shadow log directory exists
   */
  _ensureShadowLogDir() {
    try {
      const dir = path.dirname(this.shadowLog);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create shadow log directory:', error.message);
    }
  }

  /**
   * Update average response time metric
   */
  _updateAverageResponseTime(responseTime) {
    const total = this.metrics.successfulRequests + this.metrics.failedRequests;
    if (total === 0) {
      this.metrics.averageResponseTime = responseTime;
    } else {
      this.metrics.averageResponseTime = 
        (this.metrics.averageResponseTime * (total - 1) + responseTime) / total;
    }
  }

  /**
   * Sleep utility
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get client metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      circuitBreaker: this.circuitBreaker.getState(),
      cacheSize: this.cache.size(),
      successRate: this.metrics.totalRequests > 0
        ? (this.metrics.successfulRequests / this.metrics.totalRequests * 100).toFixed(2) + '%'
        : 'N/A'
    };
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (!this.url) {
      return { healthy: false, reason: 'no-url-configured' };
    }

    try {
      const healthUrl = this.url.replace('/decide', '/health');
      const response = await this.axios.get(healthUrl, { timeout: 3000 });
      return { healthy: true, data: response.data };
    } catch (error) {
      return { healthy: false, reason: error.message };
    }
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    this.emit('cache-cleared');
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    Object.keys(this.metrics).forEach(key => {
      if (typeof this.metrics[key] === 'number') {
        this.metrics[key] = 0;
      } else {
        this.metrics[key] = null;
      }
    });
    this.emit('metrics-reset');
  }
}

// Singleton instance
let clientInstance = null;

/**
 * Get or create AI client instance
 */
function getAIClient(options = {}) {
  if (!clientInstance) {
    clientInstance = new AIClient(options);
  }
  return clientInstance;
}

/**
 * Legacy API for backward compatibility
 */
async function askAI(state) {
  const client = getAIClient();
  return await client.decide(state);
}

module.exports = {
  AIClient,
  getAIClient,
  askAI,
  SHADOW_LOG,
  CircuitState
};