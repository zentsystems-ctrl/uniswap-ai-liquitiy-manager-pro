// src/gas.js

const { debug, warn, info } = require('./logger.js');

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE STATE
// ═══════════════════════════════════════════════════════════════════════════════

let cache = {
    timestamp: 0,
    value: null,
    ttlMs: 15000,  // 15 seconds cache
    hits: 0,
    misses: 0
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN GAS SETTINGS FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get gas settings with caching and fallback strategies
 * @param {object} provider - Ethers provider instance
 * @param {object} options - Options: { priority, maxFeeMultiplier, forceRefresh }
 * @returns {object|null} Gas settings or null if unavailable
 */
async function getGasSettings(provider, options = {}) {
    const {
        priority = 'standard', // 'low' | 'standard' | 'high' | 'urgent'
        maxFeeMultiplier = 1.2,
        forceRefresh = false
    } = options;

    try {
        const now = Date.now();

        // Check cache
        if (!forceRefresh && cache.value && (now - cache.timestamp) < cache.ttlMs) {
            cache.hits++;
            debug(`Gas settings cache hit (${cache.hits} hits, ${cache.misses} misses)`);
            return adjustGasForPriority(cache.value, priority, maxFeeMultiplier);
        }

        cache.misses++;

        // Fetch fresh fee data
        const feeData = await provider.getFeeData();

        // Parse maxFeePerGas
        let maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? null;
        if (maxFeePerGas === null) {
            warn('Gas fee data unavailable from provider');
            return getFallbackGasSettings(priority);
        }

        maxFeePerGas = parseBigIntSafe(maxFeePerGas);

        // Parse maxPriorityFeePerGas
        let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? null;
        if (maxPriorityFeePerGas !== null) {
            maxPriorityFeePerGas = parseBigIntSafe(maxPriorityFeePerGas);
        } else {
            // Fallback: 2 gwei priority fee
            maxPriorityFeePerGas = BigInt(2_000_000_000);
        }

        // Get gas limit from env or use default
        const gasLimit = Number(process.env.GAS_LIMIT_DEFAULT || 600_000);

        const baseSettings = {
            maxFeePerGas,
            maxPriorityFeePerGas,
            gasLimit,
            timestamp: now
        };

        // Update cache
        cache = {
            timestamp: now,
            value: baseSettings,
            ttlMs: cache.ttlMs,
            hits: cache.hits,
            misses: cache.misses
        };

        debug(`Gas settings refreshed: ${formatGwei(maxFeePerGas)} gwei max, ${formatGwei(maxPriorityFeePerGas)} gwei priority`);

        return adjustGasForPriority(baseSettings, priority, maxFeeMultiplier);

    } catch (err) {
        warn(`Failed to fetch gas settings: ${err?.message || err}`);
        
        // Return cached value if available
        if (cache.value) {
            warn('Using cached gas settings due to fetch failure');
            return adjustGasForPriority(cache.value, priority, maxFeeMultiplier);
        }

        // Return fallback
        return getFallbackGasSettings(priority);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Adjust gas prices based on priority level
 */
function adjustGasForPriority(baseSettings, priority, maxFeeMultiplier) {
    const multipliers = {
        low: { max: 0.9, priority: 0.8 },
        standard: { max: 1.0, priority: 1.0 },
        high: { max: 1.2, priority: 1.5 },
        urgent: { max: 1.5, priority: 2.0 }
    };

    const mult = multipliers[priority] || multipliers.standard;

    return {
        maxFeePerGas: BigInt(Math.floor(Number(baseSettings.maxFeePerGas) * mult.max * maxFeeMultiplier)),
        maxPriorityFeePerGas: BigInt(Math.floor(Number(baseSettings.maxPriorityFeePerGas) * mult.priority)),
        gasLimit: baseSettings.gasLimit,
        priority,
        timestamp: baseSettings.timestamp
    };
}

/**
 * Get fallback gas settings when provider fails
 */
function getFallbackGasSettings(priority) {
    warn('Using fallback gas settings');
    
    const baseFallback = {
        maxFeePerGas: BigInt(50_000_000_000), // 50 gwei
        maxPriorityFeePerGas: BigInt(2_000_000_000), // 2 gwei
        gasLimit: Number(process.env.GAS_LIMIT_DEFAULT || 600_000),
        timestamp: Date.now(),
        isFallback: true
    };

    return adjustGasForPriority(baseFallback, priority, 1.0);
}

/**
 * Safely parse BigInt from various types
 */
function parseBigIntSafe(value) {
    try {
        if (typeof value === 'bigint') return value;
        if (typeof value === 'object' && value.toString) {
            return BigInt(value.toString());
        }
        return BigInt(value);
    } catch {
        return BigInt(0);
    }
}

/**
 * Format wei to gwei for display
 */
function formatGwei(wei) {
    try {
        const gwei = Number(wei) / 1e9;
        return gwei.toFixed(2);
    } catch {
        return '0.00';
    }
}

/**
 * Format wei to ETH for display
 */
function formatEth(wei) {
    try {
        const eth = Number(wei) / 1e18;
        return eth.toFixed(6);
    } catch {
        return '0.000000';
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAS ESTIMATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Estimate gas for a specific transaction
 * @param {object} contract - Contract instance
 * @param {string} method - Method name
 * @param {array} args - Method arguments
 * @param {object} options - Additional options
 * @returns {object|null} Gas estimate or null if failed
 */
async function estimateGasForTx(contract, method, args, options = {}) {
    try {
        const gasEstimate = await contract[method].estimateGas(...args);
        const bufferMultiplier = options.bufferMultiplier || 1.2;
        const gasLimit = Math.floor(Number(gasEstimate) * bufferMultiplier);

        debug(`Gas estimate for ${method}: ${gasEstimate.toString()} (using ${gasLimit} with ${((bufferMultiplier - 1) * 100).toFixed(0)}% buffer)`);

        return {
            gasEstimate: Number(gasEstimate),
            gasLimit,
            method,
            ...options
        };
    } catch (err) {
        warn(`Gas estimation failed for ${method}: ${err?.message || err}`);
        return null;
    }
}

/**
 * Calculate transaction cost in ETH
 * @param {object} gasSettings - Gas settings from getGasSettings
 * @param {number} gasUsed - Actual gas used (optional, defaults to gasLimit)
 * @returns {object} Cost breakdown
 */
function calculateTxCost(gasSettings, gasUsed = null) {
    const gas = BigInt(gasUsed || gasSettings.gasLimit);
    const costWei = gas * gasSettings.maxFeePerGas;
    const costEth = Number(costWei) / 1e18;
    
    return {
        costWei,
        costEth: costEth.toFixed(6),
        costEthNumber: costEth,
        gasUsed: gas.toString(),
        maxFeePerGas: gasSettings.maxFeePerGas.toString(),
        maxFeePerGasGwei: formatGwei(gasSettings.maxFeePerGas),
        priority: gasSettings.priority
    };
}

/**
 * Check if gas cost is acceptable for position value
 * @param {number} gasCostEth - Gas cost in ETH
 * @param {number} positionValueEth - Position value in ETH
 * @param {number} maxPct - Maximum acceptable percentage (default 2.5%)
 * @returns {object} Validation result
 */
function validateGasCost(gasCostEth, positionValueEth, maxPct = 2.5) {
    if (positionValueEth <= 0) {
        return {
            isAcceptable: false,
            reason: 'Position value is zero or negative',
            gasCostPct: Infinity
        };
    }

    const gasCostPct = (gasCostEth / positionValueEth) * 100;
    const isAcceptable = gasCostPct <= maxPct;

    return {
        isAcceptable,
        gasCostPct,
        gasCostEth,
        positionValueEth,
        maxPct,
        reason: isAcceptable 
            ? `Gas cost ${gasCostPct.toFixed(2)}% is acceptable` 
            : `Gas cost ${gasCostPct.toFixed(2)}% exceeds max ${maxPct}%`
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPLETE GAS ESTIMATION WITH VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete gas estimation with all validations
 * This is the main function to use in offchain.js
 * 
 * @param {object} contract - Contract instance
 * @param {string} method - Method name
 * @param {array} args - Method arguments
 * @param {number} positionValueEth - Position value in ETH
 * @param {object} options - Options { priority, maxGasPct }
 * @returns {object|null} Complete gas settings or null if not profitable
 */
async function estimateGasWithValidation(contract, method, args, positionValueEth, options = {}) {
    const {
        priority = 'standard',
        maxGasPct = 2.5,
        bufferMultiplier = 1.2
    } = options;

    try {
        // 1. Estimate gas for the specific transaction
        const gasEstimate = await estimateGasForTx(contract, method, args, { bufferMultiplier });
        
        if (!gasEstimate) {
            warn(`Failed to estimate gas for ${method}`);
            return null;
        }

        // 2. Get current gas prices
        const gasSettings = await getGasSettings(contract.runner.provider, {
            priority,
            maxFeeMultiplier: 1.2
        });

        if (!gasSettings) {
            warn('Could not get gas settings');
            return null;
        }

        // 3. Calculate cost
        const txCost = calculateTxCost(
            { ...gasSettings, gasLimit: gasEstimate.gasLimit },
            gasEstimate.gasLimit
        );

        // 4. Validate cost is acceptable
        const validation = validateGasCost(
            txCost.costEthNumber,
            positionValueEth,
            maxGasPct
        );

        if (!validation.isAcceptable) {
            warn(`⛔ ${validation.reason}`);
            return null;
        }

        info(`   Gas: ${gasEstimate.gasLimit} (${txCost.costEth} ETH, ${validation.gasCostPct.toFixed(2)}%)`);

        // 5. Return complete settings
        return {
            gasLimit: gasEstimate.gasLimit,
            maxFeePerGas: gasSettings.maxFeePerGas,
            maxPriorityFeePerGas: gasSettings.maxPriorityFeePerGas,
            gasCostEth: txCost.costEthNumber,
            gasCostPct: validation.gasCostPct,
            priority: gasSettings.priority,
            method
        };

    } catch (err) {
        warn(`Gas estimation with validation failed: ${err.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get cache statistics
 */
function getCacheStats() {
    const total = cache.hits + cache.misses;
    const hitRate = total > 0 ? ((cache.hits / total) * 100).toFixed(2) : '0.00';
    
    return {
        hits: cache.hits,
        misses: cache.misses,
        total,
        hitRate: `${hitRate}%`,
        lastUpdate: cache.timestamp ? new Date(cache.timestamp).toISOString() : null,
        isCached: cache.value !== null,
        ttlMs: cache.ttlMs
    };
}

/**
 * Clear gas cache
 */
function clearCache() {
    const oldStats = getCacheStats();
    
    cache = {
        timestamp: 0,
        value: null,
        ttlMs: cache.ttlMs,
        hits: 0,
        misses: 0
    };
    
    debug('Gas cache cleared');
    return oldStats;
}

/**
 * Set cache TTL
 * @param {number} ttlMs - Time to live in milliseconds
 */
function setCacheTTL(ttlMs) {
    if (ttlMs < 1000) {
        warn('Cache TTL should be at least 1000ms');
        ttlMs = 1000;
    }
    if (ttlMs > 60000) {
        warn('Cache TTL should not exceed 60000ms');
        ttlMs = 60000;
    }
    
    cache.ttlMs = ttlMs;
    debug(`Gas cache TTL set to ${ttlMs}ms`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAS PRICE MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if current gas prices are favorable
 * @param {object} provider - Ethers provider
 * @param {object} thresholds - { low, high } in gwei
 * @returns {object} Gas price status
 */
async function checkGasPriceStatus(provider, thresholds = { low: 30, high: 100 }) {
    try {
        const gasSettings = await getGasSettings(provider, { forceRefresh: true });
        
        if (!gasSettings) {
            return { status: 'unknown', reason: 'Could not fetch gas prices' };
        }

        const gasPriceGwei = Number(gasSettings.maxFeePerGas) / 1e9;

        if (gasPriceGwei <= thresholds.low) {
            return {
                status: 'low',
                gasPriceGwei,
                message: `Gas price is low (${gasPriceGwei.toFixed(2)} gwei)`,
                recommended: true
            };
        } else if (gasPriceGwei <= thresholds.high) {
            return {
                status: 'normal',
                gasPriceGwei,
                message: `Gas price is normal (${gasPriceGwei.toFixed(2)} gwei)`,
                recommended: true
            };
        } else {
            return {
                status: 'high',
                gasPriceGwei,
                message: `Gas price is high (${gasPriceGwei.toFixed(2)} gwei)`,
                recommended: false
            };
        }
    } catch (err) {
        return { status: 'error', reason: err.message };
    }
}

/**
 * Wait for gas price to be below threshold
 * @param {object} provider - Ethers provider
 * @param {number} maxGwei - Maximum acceptable gas price in gwei
 * @param {number} timeoutMs - Maximum wait time in ms
 * @param {number} checkIntervalMs - Check interval in ms
 * @returns {Promise<boolean>} True if gas became acceptable, false if timeout
 */
async function waitForLowGas(provider, maxGwei = 50, timeoutMs = 300000, checkIntervalMs = 15000) {
    const startTime = Date.now();
    
    info(`Waiting for gas price to be below ${maxGwei} gwei...`);

    while (Date.now() - startTime < timeoutMs) {
        const status = await checkGasPriceStatus(provider, { low: maxGwei, high: maxGwei * 2 });
        
        if (status.gasPriceGwei && status.gasPriceGwei <= maxGwei) {
            info(`Gas price is now ${status.gasPriceGwei.toFixed(2)} gwei - proceeding`);
            return true;
        }

        debug(`Gas price ${status.gasPriceGwei?.toFixed(2) || 'unknown'} gwei, waiting...`);
        await new Promise(resolve => setTimeout(resolve, checkIntervalMs));
    }

    warn(`Timeout waiting for low gas (max ${maxGwei} gwei)`);
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    // Main functions
    getGasSettings,
    estimateGasForTx,
    estimateGasWithValidation,
    calculateTxCost,
    validateGasCost,
    
    // Gas monitoring
    checkGasPriceStatus,
    waitForLowGas,
    
    // Cache management
    getCacheStats,
    clearCache,
    setCacheTTL,
    
    // Utilities
    formatGwei,
    formatEth,
    parseBigIntSafe,
    
    // For testing
    adjustGasForPriority,
    getFallbackGasSettings
};