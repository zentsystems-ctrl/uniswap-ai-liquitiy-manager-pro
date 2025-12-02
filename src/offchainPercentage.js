// src/offchainPercentage.js
// Percentage-based calculations for offchain agent

const { debug } = require('./logger.js');

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const WAD = 10n ** 18n;
const BPS_BASE = 10000n; // 10000 basis points = 100%
const MAX_UINT256 = 2n ** 256n - 1n;

// ═══════════════════════════════════════════════════════════════════════════════
// CORE MATH FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute percentage deviation between prices
 * @param {bigint} P_now_wad - Current price in WAD
 * @param {bigint} P_ref_wad - Reference price in WAD
 * @returns {bigint} Deviation in basis points (10000 = 100%)
 */
function computeDeviationBps(P_now_wad, P_ref_wad) {
  // Validation
  if (typeof P_now_wad !== 'bigint' || typeof P_ref_wad !== 'bigint') {
    throw new Error('P_now_wad and P_ref_wad must be BigInt');
  }
  
  if (P_ref_wad === 0n) {
    throw new Error('P_ref cannot be zero');
  }
  
  if (P_now_wad === 0n) {
    return 0n;
  }
  
  if (P_now_wad < 0n || P_ref_wad < 0n) {
    throw new Error('Prices must be positive');
  }

  try {
    // Calculate absolute difference
    const diff = P_now_wad > P_ref_wad 
      ? P_now_wad - P_ref_wad 
      : P_ref_wad - P_now_wad;
    
    // Return in basis points: 10000 = 100%
    const deviationBps = (diff * BPS_BASE) / P_ref_wad;
    
    return deviationBps;
    
  } catch (err) {
    throw new Error(`computeDeviationBps failed: ${err.message}`);
  }
}

/**
 * Convert percentage integer to basis points
 * @param {number} pctInt - Percentage as integer (1 = 1%, 5 = 5%)
 * @returns {bigint} Threshold in basis points
 */
function thresholdFromPctInt(pctInt) {
  if (!Number.isInteger(pctInt)) {
    throw new Error('pctInt must be an integer');
  }
  
  if (pctInt < 0 || pctInt > 100) {
    throw new Error('pctInt must be between 0 and 100');
  }

  return BigInt(pctInt) * 100n; // Convert to basis points (1% = 100 bps)
}

/**
 * Compute price bounds from percentage
 * @param {bigint} P_ref_wad - Reference price in WAD
 * @param {number} pctInt - Percentage as integer (1 = 1%, 5 = 5%)
 * @returns {object} {Pmin, Pmax} in WAD
 */
function computePriceBounds(P_ref_wad, pctInt) {
  if (typeof P_ref_wad !== 'bigint') {
    throw new Error('P_ref_wad must be BigInt');
  }
  
  if (P_ref_wad === 0n) {
    throw new Error('P_ref cannot be zero');
  }
  
  if (!Number.isInteger(pctInt) || pctInt < 0 || pctInt > 100) {
    throw new Error('pctInt must be integer between 0 and 100');
  }

  try {
    // Convert percentage to WAD (1% = 0.01e18)
    const pctWad = BigInt(pctInt) * 10n ** 16n;
    
    // Pmax = P_ref * (1 + pct)
    const Pmax = (P_ref_wad * (WAD + pctWad)) / WAD;
    
    // Pmin = P_ref / (1 + pct)
    const Pmin = (P_ref_wad * WAD) / (WAD + pctWad);
    
    debug(`Computed bounds for ${pctInt}%: Pmin=${Pmin.toString()}, Pmax=${Pmax.toString()}`);
    
    return { Pmin, Pmax };
    
  } catch (err) {
    throw new Error(`computePriceBounds failed for ${pctInt}%: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if price is within bounds
 * @param {bigint} P_now_wad - Current price
 * @param {bigint} P_ref_wad - Reference price
 * @param {number} pctInt - Percentage threshold
 * @returns {boolean} True if within bounds
 */
function isWithinBounds(P_now_wad, P_ref_wad, pctInt) {
  const deviationBps = computeDeviationBps(P_now_wad, P_ref_wad);
  const thresholdBps = thresholdFromPctInt(pctInt);
  return deviationBps <= thresholdBps;
}

/**
 * Format basis points to human-readable percentage
 * @param {bigint} bps - Basis points (10000 = 100%)
 * @param {number} decimals - Decimal places
 * @returns {string} Formatted percentage (e.g., "5.23%")
 */
function formatBps(bps, decimals = 2) {
  if (typeof bps !== 'bigint') {
    return '0.00%';
  }
  
  const pct = Number(bps) / 100;
  return `${pct.toFixed(decimals)}%`;
}

/**
 * Format BigInt WAD value to human-readable decimal
 * @param {bigint} wadValue - Value in WAD format
 * @param {number} decimals - Number of decimal places
 * @returns {string} Formatted string
 */
function formatWad(wadValue, decimals = 4) {
  if (typeof wadValue !== 'bigint') {
    return '0.0000';
  }
  
  const value = Number(wadValue) / Number(WAD);
  return value.toFixed(decimals);
}

/**
 * Parse decimal string to WAD BigInt
 * @param {string|number} value - Decimal value
 * @returns {bigint} Value in WAD format
 */
function parseToWad(value) {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(num)) {
    throw new Error('Invalid number for parseToWad');
  }
  
  return BigInt(Math.floor(num * Number(WAD)));
}

/**
 * Compute price impact as percentage string
 * @param {bigint} P_now - Current price
 * @param {bigint} P_ref - Reference price
 * @returns {string} Percentage as string (e.g., "+5.23%" or "-3.45%")
 */
function computePriceImpact(P_now, P_ref) {
  if (P_ref === 0n) return '0.00%';
  
  const diff = P_now - P_ref;
  const impact = (diff * 10000n) / P_ref;
  const impactPercent = Number(impact) / 100;
  
  return `${impactPercent >= 0 ? '+' : ''}${impactPercent.toFixed(2)}%`;
}

/**
 * Get deviation category (low/medium/high)
 * @param {bigint} deviationBps - Deviation in basis points
 * @returns {string} Category: 'low', 'medium', 'high'
 */
function getDeviationCategory(deviationBps) {
  const pct = Number(deviationBps) / 100;
  
  if (pct < 1) return 'low';
  if (pct < 5) return 'medium';
  return 'high';
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that value is a valid WAD BigInt
 */
function validateWad(value, name = 'value') {
  if (typeof value !== 'bigint') {
    throw new Error(`${name} must be BigInt, got ${typeof value}`);
  }
  
  if (value < 0n) {
    throw new Error(`${name} must be non-negative`);
  }
  
  if (value > MAX_UINT256) {
    throw new Error(`${name} exceeds MAX_UINT256`);
  }
}

/**
 * Validate percentage integer
 */
function validatePctInt(pctInt, name = 'pctInt') {
  if (!Number.isInteger(pctInt)) {
    throw new Error(`${name} must be an integer`);
  }
  
  if (pctInt < 0 || pctInt > 100) {
    throw new Error(`${name} must be between 0 and 100`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISON WITH T METHOD (for backwards compatibility if needed)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert deviation in basis points to approximate T value
 * For backwards compatibility only - not used in normal operation
 * @param {bigint} deviationBps - Deviation in basis points
 * @returns {bigint} Approximate T value in WAD
 */
function deviationToApproxT(deviationBps) {
  // This is approximate conversion for logging/comparison purposes
  // T = 1 when deviation = 0
  // T increases with deviation
  
  const deviationPct = Number(deviationBps) / 10000;
  const ratio = 1 + deviationPct;
  
  // Approximate T formula: T ≈ 2*sqrt(r) / (1 + sqrt(r))
  const sqrtR = Math.sqrt(ratio);
  const T = (2 * sqrtR) / (1 + sqrtR);
  
  return BigInt(Math.floor(T * Number(WAD)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Core functions
  computeDeviationBps,
  thresholdFromPctInt,
  computePriceBounds,
  
  // Utilities
  isWithinBounds,
  formatBps,
  formatWad,
  parseToWad,
  computePriceImpact,
  getDeviationCategory,
  
  // Validation
  validateWad,
  validatePctInt,
  
  // Backwards compatibility
  deviationToApproxT,
  
  // Constants
  WAD,
  BPS_BASE,
  MAX_UINT256
};