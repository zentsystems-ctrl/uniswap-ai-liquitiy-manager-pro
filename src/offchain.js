// src/offchain.js

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════════════════

const { config } = require('./config.js');
const { info, warn, error, debug, updateStats } = require('./logger.js');
const { withRetry, sleep } = require('./retry.js');
const { getAIClient } = require('./ai_client.js');
const { ResultTrackerV2 } = require('./result_tracker.js');
const { 
    getGasSettings, 
    estimateGasWithValidation,
    checkGasPriceStatus,
    getCacheStats,
    formatGwei
} = require('./gas.js');
const {
    computeDeviationBps,
    isWithinBounds,
    formatBps
} = require('./offchainPercentage.js');
const { performHealthCheck, getHealthStatus } = require('./healthCheck.js');
const metrics = require('./metrics_exporter');

// ═══════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════

const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '60000', 10);
const SHADOW_MODE = process.env.SHADOW_MODE === 'true';
const SHADOW_LOG_PATH = process.env.SHADOW_LOG || path.join(process.cwd(), 'data', 'shadow_log.ndjson');
const RESULTS_LOG_PATH = process.env.RESULTS_LOG || path.join(process.cwd(), 'data', 'results_log.ndjson');
const TRAINING_LOG_PATH = process.env.TRAINING_LOG || path.join(process.cwd(), 'data', 'training_log.ndjson');
const MIN_REBALANCE_INTERVAL_HOURS = parseFloat(process.env.MIN_REBALANCE_INTERVAL_HOURS || '6');
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || '100');
const MAX_GAS_PCT = parseFloat(process.env.MAX_GAS_PCT || '2.5');

// Ensure directories
[SHADOW_LOG_PATH, RESULTS_LOG_PATH, TRAINING_LOG_PATH].forEach(logPath => {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

if (SHADOW_MODE) {
    info(`👁️  SHADOW MODE ENABLED - Logging to: ${SHADOW_LOG_PATH}`);
} else {
    info(`📊 RESULT TRACKING ENABLED - Logging to: ${RESULTS_LOG_PATH}`);
}

// Start metrics server
try {
    metrics.startServer(9090);
} catch (err) {
    warn(`Metrics server failed to start: ${err.message}`);
}

// ═══════════════════════════════════════════════════════════════════
// CONTRACT ABIs
// ═══════════════════════════════════════════════════════════════════

const INDEX_ABI = [
    'function getAllLevels(bytes32) view returns (uint256[], uint256[], uint256[], uint32[], uint256[])',
    'function pools(bytes32) view returns (bool, address, uint8, uint8, bool, uint32, uint16, uint16, uint16)',
    'function processPool(bytes32) returns (bool[4])',
    'function getPctLevels() view returns (uint8[])',
    'function levelStates(bytes32, uint8) view returns (uint256, uint32, uint256, uint256, bool, uint256, uint32, uint256)'
];

const PM_ABI = [
    'function positions(uint256) view returns (address, bytes32, uint8, uint256, int24, int24, uint128, uint24, address, address, bool)',
    'function syncPosition(uint256)',
    'function nfpm() view returns (address)',
    'function nextPositionId() view returns (uint256)'
];

const POOL_ABI = [
    'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
    'function observe(uint32[]) view returns (int56[], uint160[])',
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
    'function token1() view returns (address)'
];

const NFPM_ABI = [
    'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
];

// ═══════════════════════════════════════════════════════════════════
// GLOBAL STATE
// ═══════════════════════════════════════════════════════════════════

let provider, wallet, indexContract, pmContract, aiClient;
let isRunning = false;

// ✅ Enhanced Result Tracker v2.0
const resultTracker = new ResultTrackerV2({
    resultsLogPath: RESULTS_LOG_PATH,
    trainingLogPath: TRAINING_LOG_PATH
});

const stats = {
    totalRuns: 0,
    decisionsRequested: 0,
    decisionsExecuted: 0,
    decisionsSkipped: 0,
    holdDecisions: 0,
    gasSkipped: 0,
    errors: 0,
    startTime: Date.now(),
    totalProfitETH: 0,
    totalGasCostETH: 0,
    profitableDecisions: 0
};

const rebalanceHistory = new Map();

// ═══════════════════════════════════════════════════════════════════
// POSITION INFO - FROM CONTRACTS ONLY
// ═══════════════════════════════════════════════════════════════════

async function getPositionInfo(positionId, pmContract, pool) {
    try {
        const posData = await pmContract.positions(positionId);
        const tokenId = posData[3];
        const tickLower = Number(posData[4]);
        const tickUpper = Number(posData[5]);
        const liquidity = Number(posData[6]);
        
        const slot0 = await pool.slot0();
        const currentTick = Number(slot0[1]);
        
        const inRange = currentTick >= tickLower && currentTick <= tickUpper;
        
        const nftpmAddress = await pmContract.nfpm();
        const nftpm = new ethers.Contract(nftpmAddress, NFPM_ABI, pmContract.runner);
        const nftData = await nftpm.positions(tokenId);
        
        const feesEarned0 = Number(ethers.formatUnits(nftData[10], 18));
        const feesEarned1 = Number(ethers.formatUnits(nftData[11], 18));
        
        const token0Balance = liquidity > 0 ? liquidity / 1e18 : 0;
        const token1Balance = liquidity > 0 ? liquidity / 1e18 : 0;
        
        return {
            tokenId: Number(tokenId),
            lowerTick: tickLower,
            upperTick: tickUpper,
            liquidity: liquidity,
            token0Balance: token0Balance,
            token1Balance: token1Balance,
            feesEarned0: feesEarned0,
            feesEarned1: feesEarned1,
            inRange: inRange,
            currentTick: currentTick
        };
    } catch (err) {
        error(`❌ Failed to get position info: ${err.message}`);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════
// ✅ ENHANCED: GET REPOSITION CONTEXT FROM INDEX
// ═══════════════════════════════════════════════════════════════════

async function getRepositionContext(poolId, levelIndex = 1) {
    try {
        const levels = await indexContract.getAllLevels(poolId);
        
        const p_ref = levels[0][levelIndex] ? Number(ethers.formatEther(levels[0][levelIndex])) : null;
        const p_now = levels[1][levelIndex] ? Number(ethers.formatEther(levels[1][levelIndex])) : null;
        const deviation_bps = levels[2][levelIndex] ? Number(levels[2][levelIndex]) : 0;
        const threshold_bps = levels[4][levelIndex] ? Number(levels[4][levelIndex]) : 500;
        
        return {
            p_ref,
            p_now,
            deviation_bps,
            threshold_bps,
            deviation_pct: deviation_bps / 100,
            threshold_pct: threshold_bps / 100,
            is_out_of_bounds: deviation_bps > threshold_bps
        };
    } catch (err) {
        warn(`Could not get reposition context: ${err.message}`);
        return {
            p_ref: null,
            p_now: null,
            deviation_bps: 0,
            threshold_bps: 500,
            deviation_pct: 0,
            threshold_pct: 5,
            is_out_of_bounds: false
        };
    }
}

// ═══════════════════════════════════════════════════════════════════
// TWAP CALCULATION
// ═══════════════════════════════════════════════════════════════════

async function getTWAP(pool, seconds) {
    try {
        const secondsAgos = [seconds, 0];
        const result = await pool.observe(secondsAgos);
        const tickCumulatives = result[0];
        const avgTick = Number(tickCumulatives[1] - tickCumulatives[0]) / seconds;
        return Math.pow(1.0001, avgTick);
    } catch (err) {
        warn(`TWAP calculation failed for ${seconds}s: ${err.message}`);
        return 0;
    }
}

async function validatePriceWithTWAP(pool, currentPrice) {
    try {
        const twap5min = await getTWAP(pool, 300);
        const twap30min = await getTWAP(pool, 1800);
        const twap1hour = await getTWAP(pool, 3600);
        
        if (twap5min === 0 || twap30min === 0 || twap1hour === 0) {
            return { valid: true, twap5min: currentPrice, twap30min: currentPrice, twap1hour: currentPrice, maxDeviation: 0 };
        }
        
        const dev5min = Math.abs(currentPrice - twap5min) / twap5min * 100;
        const dev30min = Math.abs(currentPrice - twap30min) / twap30min * 100;
        const dev1hour = Math.abs(currentPrice - twap1hour) / twap1hour * 100;
        
        const suspicious = dev5min > 5 || dev30min > 5 || dev1hour > 5;
        
        if (suspicious) {
            warn(`🚨 Suspicious price detected!`);
            warn(`   5min dev: ${dev5min.toFixed(2)}%, 30min dev: ${dev30min.toFixed(2)}%, 1h dev: ${dev1hour.toFixed(2)}%`);
        }
        
        return {
            valid: !suspicious,
            twap5min,
            twap30min,
            twap1hour,
            maxDeviation: Math.max(dev5min, dev30min, dev1hour)
        };
    } catch (err) {
        return { valid: true, twap5min: currentPrice, twap30min: currentPrice, twap1hour: currentPrice, maxDeviation: 0 };
    }
}

// ═══════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═══════════════════════════════════════════════════════════════════

function canRebalance(positionId, minIntervalHours = MIN_REBALANCE_INTERVAL_HOURS) {
    const lastRebalance = rebalanceHistory.get(positionId);
    
    if (!lastRebalance) {
        return { allowed: true, reason: 'first_rebalance' };
    }
    
    const hoursSince = (Date.now() - lastRebalance) / (1000 * 60 * 60);
    
    if (hoursSince < minIntervalHours) {
        return {
            allowed: false,
            reason: 'too_soon',
            hoursSince: hoursSince.toFixed(2),
            minHours: minIntervalHours
        };
    }
    
    return { allowed: true, reason: 'interval_passed', hoursSince: hoursSince.toFixed(2) };
}

function recordRebalance(positionId) {
    rebalanceHistory.set(positionId, Date.now());
}

// ═══════════════════════════════════════════════════════════════════
// ✅ GAS CHECK BEFORE PROCESSING
// ═══════════════════════════════════════════════════════════════════

async function checkGasBeforeProcessing() {
    try {
        const gasStatus = await checkGasPriceStatus(provider, {
            low: 30,
            high: MAX_GAS_GWEI
        });
        
        if (gasStatus.status === 'high') {
            warn(`⛽ Gas price too high: ${gasStatus.gasPriceGwei.toFixed(2)} gwei (max: ${MAX_GAS_GWEI})`);
            return { proceed: false, reason: 'high_gas', gasStatus };
        }
        
        debug(`⛽ Gas price: ${gasStatus.gasPriceGwei.toFixed(2)} gwei (${gasStatus.status})`);
        return { proceed: true, gasStatus };
        
    } catch (err) {
        warn(`Gas check failed: ${err.message}`);
        return { proceed: true, reason: 'check_failed' };
    }
}

// ═══════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════

async function validateExecution(decision, state, pool) {
    const checks = { passed: [], failed: [], warnings: [] };
    
    // Price validation
    const priceValidation = await validatePriceWithTWAP(pool, state.current_price);
    if (!priceValidation.valid) {
        checks.failed.push(`Price manipulation (${priceValidation.maxDeviation.toFixed(2)}% dev)`);
    } else {
        checks.passed.push('Price validation');
    }
    
    // Rate limit check
    const rateCheck = canRebalance(state.position.id);
    if (!rateCheck.allowed) {
        checks.failed.push(`Too frequent (${rateCheck.hoursSince}h < ${rateCheck.minHours}h)`);
    } else {
        checks.passed.push('Rate limiting');
    }
    
    // Position value check
    const positionValue = (state.position?.token0_balance || 0) + (state.position?.token1_balance || 0);
    if (positionValue <= 0) {
        checks.failed.push('Position value is zero');
    } else {
        checks.passed.push('Position value');
    }
    
    // Confidence check
    if (decision.confidence < 0.7) {
        checks.warnings.push(`Low confidence: ${decision.confidence.toFixed(2)}`);
    } else {
        checks.passed.push('Confidence');
    }
    
    // Risk check
    if (decision.risk_level === 'high' && decision.confidence < 0.8) {
        checks.failed.push('High risk + low confidence');
    } else {
        checks.passed.push('Risk assessment');
    }
    
    // Bounds check
    if (state.within_bounds) {
        checks.warnings.push('Position is within bounds');
    }
    
    return {
        canExecute: checks.failed.length === 0,
        checks,
        hasCriticalIssues: checks.failed.length > 0,
        hasWarnings: checks.warnings.length > 0
    };
}

// ═══════════════════════════════════════════════════════════════════
// SHADOW MODE LOGGING
// ═══════════════════════════════════════════════════════════════════

function logShadowDecision(state, decision, metadata = {}) {
    if (!SHADOW_MODE) return;
    
    try {
        const record = {
            timestamp: Date.now(),
            state: {
                timestamp: state.timestamp || Date.now(),
                poolId: state.poolId,
                current_price: state.current_price || state.price,
                twap_1h: state.twap_1h,
                twap_24h: state.twap_24h,
                deviation_pct: state.deviation_pct,
                threshold_pct: state.threshold_pct,
                within_bounds: state.within_bounds,
                volatility_1h: state.volatility_1h,
                volatility_24h: state.volatility_24h,
                pool_liquidity: state.pool_liquidity,
                gas_price: state.gas_price,
                position: state.position,
                extra: state.extra
            },
            decision: {
                action: decision.action,
                confidence: decision.confidence,
                score: decision.score,
                expected_reward: decision.expected_reward,
                reason: decision.reason,
                risk_level: decision.risk_level
            },
            metadata: { ...metadata, shadow_mode: true }
        };
        
        fs.appendFileSync(SHADOW_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
        error(`Failed to log shadow decision: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════

async function initialize() {
    info('═══════════════════════════════════════════════════════════');
    info('🤖 INITIALIZING OFFCHAIN AGENT v2.0 (Accurate Rewards)');
    info('═══════════════════════════════════════════════════════════');
    
    provider = new ethers.JsonRpcProvider(config.rpc);
    
    const network = await provider.getNetwork();
    info(`✅ Network: ${network.name} (Chain ID: ${network.chainId})`);
    
    wallet = new ethers.Wallet(config.privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    info(`✅ Wallet: ${wallet.address}`);
    info(`   Balance: ${ethers.formatEther(balance)} ETH`);
    
    indexContract = new ethers.Contract(config.indexAddress, INDEX_ABI, wallet);
    pmContract = new ethers.Contract(config.pmAddress, PM_ABI, wallet);
    info(`✅ Index: ${config.indexAddress}`);
    info(`✅ PositionManager: ${config.pmAddress}`);
    
    aiClient = getAIClient({
        url: process.env.AI_URL || 'http://localhost:8000/decide',
        timeout: 10000,
        shadowLog: SHADOW_LOG_PATH
    });
    
    const health = await aiClient.healthCheck();
    if (health.healthy) {
        info('✅ AI service is healthy');
    } else {
        warn(`⚠️ AI service unhealthy: ${health.reason}`);
    }
    
    // Initial gas check
    const gasStatus = await checkGasPriceStatus(provider);
    info(`⛽ Current gas: ${gasStatus.gasPriceGwei?.toFixed(2) || 'unknown'} gwei`);
    
    info('═══════════════════════════════════════════════════════════');
    info('✅ INITIALIZATION COMPLETE');
    info(`📊 Training log: ${TRAINING_LOG_PATH}`);
    info(`💰 Using accurate Uniswap V3 reward calculations`);
    info(`⛽ Max gas: ${MAX_GAS_GWEI} gwei, Max gas cost: ${MAX_GAS_PCT}%`);
    info('═══════════════════════════════════════════════════════════\n');
}

// ═══════════════════════════════════════════════════════════════════
// ✅ ENHANCED: DATA COLLECTION WITH REPOSITION CONTEXT
// ═══════════════════════════════════════════════════════════════════

async function collectMarketState(poolId, positionId) {
    info(`📊 Collecting market state...`);
    
    try {
        const poolConfig = await indexContract.pools(poolId);
        if (!poolConfig[0]) {
            throw new Error(`Pool ${poolId} not found in Index`);
        }
        
        const poolAddress = poolConfig[1];
        const decimals0 = poolConfig[2];
        const decimals1 = poolConfig[3];
        
        const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
        
        const slot0 = await pool.slot0();
        const sqrtPriceX96 = slot0[0];
        const currentTick = Number(slot0[1]);
        
        const Q96 = 2n ** 96n;
        const price = (Number(sqrtPriceX96) / Number(Q96)) ** 2;
        const adjustedPrice = price * (10 ** (decimals1 - decimals0));
        
        const twap1h = await getTWAP(pool, 3600);
        const twap24h = await getTWAP(pool, 86400);
        
        const volatility1h = twap1h > 0 ? Math.abs(adjustedPrice - twap1h) / twap1h : 0;
        const volatility24h = twap24h > 0 ? Math.abs(adjustedPrice - twap24h) / twap24h : 0;
        
        const poolLiquidity = await pool.liquidity();
        const poolLiquidityEth = Number(ethers.formatEther(poolLiquidity));
        
        const accuratePosition = await getPositionInfo(positionId, pmContract, pool);
        
        // ✅ Get reposition context from Index
        const posData = await pmContract.positions(positionId);
        const levelIndex = Number(posData[2]);
        const repoContext = await getRepositionContext(poolId, levelIndex);
        
        info(`   Reposition context: deviation=${repoContext.deviation_pct.toFixed(2)}%, threshold=${repoContext.threshold_pct.toFixed(2)}%`);
        info(`   Out of bounds: ${repoContext.is_out_of_bounds ? '❌ YES' : '✅ NO'}`);
        
        // ✅ Get current gas price
        const gasSettings = await getGasSettings(provider);
        const gasPriceGwei = gasSettings ? Number(gasSettings.maxFeePerGas) / 1e9 : 50;
        
        // ✅ Estimate pool volume (simplified)
        const estimatedVolume24h = poolLiquidityEth * adjustedPrice * 0.1;
        
        const marketState = {
            timestamp: Date.now() / 1000,
            poolId: poolId,
            current_price: adjustedPrice,
            price: adjustedPrice,
            twap_1h: twap1h || adjustedPrice,
            twap_24h: twap24h || adjustedPrice,
            volatility_1h: volatility1h,
            volatility_24h: volatility24h,
            pool_liquidity: poolLiquidityEth,
            volume_24h: estimatedVolume24h,
            gas_price: gasPriceGwei,
            
            // ✅ Reposition context from Index
            deviation_pct: repoContext.deviation_pct,
            threshold_pct: repoContext.threshold_pct,
            within_bounds: !repoContext.is_out_of_bounds,
            
            position: {
                id: positionId,
                owner: wallet.address,
                level: levelIndex,
                lowerTick: accuratePosition.lowerTick,
                upperTick: accuratePosition.upperTick,
                liquidity: accuratePosition.liquidity,
                token0_balance: accuratePosition.token0Balance,
                token1_balance: accuratePosition.token1Balance,
                fees_earned_0: accuratePosition.feesEarned0,
                fees_earned_1: accuratePosition.feesEarned1,
                age_seconds: 0
            },
            extra: {
                currentTick: currentTick,
                inRange: accuratePosition.inRange,
                decimals0,
                decimals1,
                poolAddress,
                p_ref: repoContext.p_ref,
                p_now: repoContext.p_now,
                deviation_bps: repoContext.deviation_bps,
                threshold_bps: repoContext.threshold_bps,
                is_out_of_bounds: repoContext.is_out_of_bounds
            }
        };
        
        info('✅ Market state collected with reposition context\n');
        return { state: marketState, pool };
        
    } catch (err) {
        error(`❌ Failed to collect market state: ${err.message}`);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════
// ✅ ENHANCED: EXECUTION WITH GAS.JS AND RESULT TRACKING v2.0
// ═══════════════════════════════════════════════════════════════════

async function executeRebalance(positionId, decision, state, pool) {
    info(`\n🔄 EXECUTING REBALANCE`);
    info(`   Position: ${positionId}`);
    
    let decisionId = null;
    
    try {
        const positionValue = state.position.token0_balance + state.position.token1_balance;
        
        if (positionValue <= 0) {
            warn('⛔ Position value is zero, aborting');
            return false;
        }
        
        // ✅ Capture pre-state
        decisionId = await resultTracker.capturePreState(
            positionId, 
            state, 
            decision, 
            pool, 
            pmContract,
            indexContract
        );
        
        // ✅ Use gas.js for estimation with validation
        const gasEstimate = await estimateGasWithValidation(
            pmContract,
            'syncPosition',
            [positionId],
            positionValue,
            { 
                priority: 'standard', 
                maxGasPct: MAX_GAS_PCT,
                bufferMultiplier: 1.2
            }
        );
        
        if (!gasEstimate) {
            warn('⛔ Gas estimation failed or unprofitable');
            stats.gasSkipped++;
            return false;
        }
        
        info('📤 Sending transaction...');
        const tx = await pmContract.syncPosition(positionId, {
            gasLimit: gasEstimate.gasLimit,
            maxFeePerGas: gasEstimate.maxFeePerGas,
            maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas
        });
        
        info(`✅ Transaction sent: ${tx.hash}`);
        
        const receipt = await tx.wait();
        
        if (receipt.status === 1) {
            info(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
            info(`   Gas used: ${receipt.gasUsed.toString()}`);
            
            // ✅ Capture with accurate reward calculations
            const result = await resultTracker.capturePostState(decisionId, receipt, pool, pmContract);
            
            if (result) {
                stats.totalProfitETH += result.reward.netRewardETH;
                stats.totalGasCostETH += result.reward.gasCost;
                if (result.reward.isProfitable) {
                    stats.profitableDecisions++;
                }
            }
            
            recordRebalance(positionId);
            stats.decisionsExecuted++;
            
            return true;
        } else {
            error('❌ Transaction failed');
            return false;
        }
        
    } catch (err) {
        error(`❌ Execution failed: ${err.message}`);
        stats.errors++;
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════
// ✅ ENHANCED: POSITION PROCESSING WITH ACCURATE HOLD LOGGING
// ═══════════════════════════════════════════════════════════════════

async function processPosition(poolId, positionId) {
    info(`\n${'═'.repeat(63)}`);
    info(`🔍 PROCESSING POSITION ${positionId}`);
    info(`${'═'.repeat(63)}\n`);
    
    try {
        const { state, pool } = await collectMarketState(poolId, positionId);
        
        // ✅ Pool data for accurate reward calculations
        const poolData = {
            currentPrice: state.current_price,
            currentTick: state.extra.currentTick,
            volume24h: state.volume_24h || 0,
            tvl: state.pool_liquidity * state.current_price * 2 || 1000000,
            feeTier: 3000
        };
        
        info('🧠 Requesting AI decision...');
        stats.decisionsRequested++;
        
        const decision = await withRetry(
            () => aiClient.decide(state),
            'AI Decision',
            { retries: 3, minDelayMs: 1000 }
        );
        
        info(`\n✅ AI Decision:`);
        info(`   Action: ${decision.action.toUpperCase()}`);
        info(`   Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
        info(`   Risk: ${decision.risk_level.toUpperCase()}`);
        info(`   Reason: ${decision.reason}`);
        info(`   Expected Reward: ${decision.expected_reward?.toFixed(6) || 'N/A'} ETH`);
        
        // ═══════════════════════════════════════════════════════════
        // HOLD Decision
        // ═══════════════════════════════════════════════════════════
        if (decision.action === 'hold') {
            info('\n⏸️  Decision: HOLD - No action needed');
            stats.decisionsSkipped++;
            stats.holdDecisions++;
            
            // ✅ Log HOLD with accurate reward calculations
            resultTracker.logHoldDecision(state, decision, poolData, 'ai_hold');
            
            if (SHADOW_MODE) {
                logShadowDecision(state, decision, { 
                    skipped: true,
                    reason: 'hold_action'
                });
            }
            return;
        }
        // ═══════════════════════════════════════════════════════════
        // Rate Limit Check
        // ═══════════════════════════════════════════════════════════
        const rateCheck = canRebalance(positionId);
        if (!rateCheck.allowed) {
            warn(`\n⏱️  Rate limiting: ${rateCheck.reason}`);
            warn(`   Last rebalance was ${rateCheck.hoursSince}h ago (min: ${rateCheck.minHours}h)`);
            stats.decisionsSkipped++;
            
            // ✅ Log rate-limited as HOLD with accurate calculations
            resultTracker.logHoldDecision(state, decision, poolData, 'rate_limited');
            
            if (SHADOW_MODE) {
                logShadowDecision(state, decision, { 
                    blocked: true,
                    reason: 'rate_limit',
                    rateCheck
                });
            }
            return;
        }
        
        // ═══════════════════════════════════════════════════════════
        // Gas Price Check
        // ═══════════════════════════════════════════════════════════
        const gasCheck = await checkGasBeforeProcessing();
        if (!gasCheck.proceed) {
            warn(`\n⛽ Gas too high, skipping execution`);
            stats.decisionsSkipped++;
            stats.gasSkipped++;
            
            resultTracker.logHoldDecision(state, decision, poolData, 'high_gas');
            
            if (SHADOW_MODE) {
                logShadowDecision(state, decision, { 
                    blocked: true,
                    reason: 'high_gas',
                    gasStatus: gasCheck.gasStatus
                });
            }
            return;
        }
        
        // ═══════════════════════════════════════════════════════════
        // Validation Check
        // ═══════════════════════════════════════════════════════════
        const validation = await validateExecution(decision, state, pool);
        
        if (validation.hasWarnings) {
            validation.checks.warnings.forEach(w => warn(`   ⚠️ ${w}`));
        }
        
        if (!validation.canExecute) {
            warn('\n⛔ Execution blocked by safety checks:');
            validation.checks.failed.forEach(f => warn(`   ❌ ${f}`));
            stats.decisionsSkipped++;
            
            // ✅ Log validation-blocked as HOLD with accurate calculations
            resultTracker.logHoldDecision(state, decision, poolData, 'validation_blocked');
            
            if (SHADOW_MODE) {
                logShadowDecision(state, decision, { 
                    blocked: true,
                    reason: 'safety_checks',
                    validation
                });
            }
            return;
        }
        
        // ═══════════════════════════════════════════════════════════
        // Execute or Shadow Log
        // ═══════════════════════════════════════════════════════════
        if (SHADOW_MODE) {
            info('\n👁️  SHADOW MODE: Logging without execution');
            logShadowDecision(state, decision, { 
                would_execute: true,
                validation,
                gasStatus: gasCheck.gasStatus
            });
            stats.decisionsSkipped++;
        } else {
            info('\n✅ All checks passed - Executing...');
            const success = await executeRebalance(positionId, decision, state, pool);
            
            if (success) {
                info('\n🎉 Rebalance completed successfully!');
                updateStats(true);
            } else {
                warn('\n⚠️  Rebalance failed');
                updateStats(false);
            }
        }
        
    } catch (err) {
        error(`\n❌ Error processing position ${positionId}: ${err.message}`);
        stats.errors++;
        updateStats(false);
    }
}

// ═══════════════════════════════════════════════════════════════════
// POOL PROCESSING
// ═══════════════════════════════════════════════════════════════════

async function getActivePositions(poolId) {
    try {
        const nextId = await pmContract.nextPositionId();
        const positions = [];
        
        for (let i = 1; i < nextId; i++) {
            try {
                const posData = await pmContract.positions(i);
                const posPoolId = posData[1];
                const isActive = posData[10];
                
                if (posPoolId === poolId && isActive) {
                    positions.push(i);
                }
            } catch (err) {
                continue;
            }
        }
        
        return positions;
    } catch (err) {
        warn(`Failed to get active positions: ${err.message}`);
        return [];
    }
}

async function processPool(poolId) {
    info(`\n${'═'.repeat(63)}`);
    info(`🏊 PROCESSING POOL: ${poolId.slice(0, 18)}...`);
    info(`${'═'.repeat(63)}\n`);
    
    try {
        const positionIds = await getActivePositions(poolId);
        
        if (positionIds.length === 0) {
            info('ℹ️  No active positions found');
            return;
        }
        
        info(`📊 Found ${positionIds.length} active position(s)`);
        
        for (let i = 0; i < positionIds.length; i++) {
            const positionId = positionIds[i];
            info(`\n[${i + 1}/${positionIds.length}] Position ${positionId}...`);
            
            await processPosition(poolId, positionId);
            
            if (i < positionIds.length - 1) {
                await sleep(5000);
            }
        }
        
    } catch (err) {
        error(`❌ Error processing pool: ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════════════

async function mainLoop() {
    info('\n🔄 Starting main loop...\n');
    
    while (isRunning) {
        const cycleStart = Date.now();
        stats.totalRuns++;
        
        info(`\n${'═'.repeat(63)}`);
        info(`🔄 CYCLE ${stats.totalRuns} - ${new Date().toISOString()}`);
        info(`${'═'.repeat(63)}\n`);
        
        try {
            // ✅ Check gas before starting cycle
            const gasCheck = await checkGasBeforeProcessing();
            if (!gasCheck.proceed) {
                warn(`⛽ Skipping cycle - gas too high (${gasCheck.gasStatus?.gasPriceGwei?.toFixed(2)} gwei)`);
                await sleep(INTERVAL_MS);
                continue;
            }
            
            // ✅ Periodic health check
            if (stats.totalRuns % 10 === 0) {
                info('🏥 Running health check...');
                const healthResult = await performHealthCheck(provider, wallet, indexContract, pmContract);
                if (healthResult.overall !== 'healthy') {
                    warn(`Health check: ${healthResult.overall}`);
                }
            }
            
            // Process all pools
            for (let i = 0; i < config.poolIds.length; i++) {
                const poolId = config.poolIds[i];
                await processPool(poolId);
                
                if (i < config.poolIds.length - 1) {
                    await sleep(10000);
                }
            }
            
            // ═══════════════════════════════════════════════════════
            // Print cycle stats
            // ═══════════════════════════════════════════════════════
            const elapsed = Date.now() - cycleStart;
            
            info(`\n${'═'.repeat(63)}`);
            info('📊 CYCLE STATS');
            info(`${'═'.repeat(63)}`);
            info(`   Cycle time: ${(elapsed / 1000).toFixed(2)}s`);
            info(`   Decisions requested: ${stats.decisionsRequested}`);
            info(`   Executed: ${stats.decisionsExecuted}`);
            info(`   Hold: ${stats.holdDecisions}`);
            info(`   Skipped: ${stats.decisionsSkipped}`);
            info(`   Gas skipped: ${stats.gasSkipped}`);
            info(`   Errors: ${stats.errors}`);
            
            if (!SHADOW_MODE) {
                info(`   Net profit: ${stats.totalProfitETH.toFixed(6)} ETH`);
                info(`   Total gas spent: ${stats.totalGasCostETH.toFixed(6)} ETH`);
            }
            
            // ✅ Show accurate reward stats
            const trackerStats = resultTracker.getStats();
            if (trackerStats.totalResults > 0) {
                info(`\n📈 Reward Stats (Accurate v2.0):`);
                info(`   Total rebalances: ${trackerStats.totalResults}`);
                info(`   Profitable: ${trackerStats.profitRate}%`);
                info(`   Beat Hold: ${trackerStats.beatHoldRate}%`);
                info(`   Total Reward: ${trackerStats.totalRewardETH} ETH`);
                info(`   Avg ROI: ${trackerStats.avgROIPct}%`);
            }
            
            // ✅ Show gas cache stats
            const gasCacheStats = getCacheStats();
            debug(`\n⛽ Gas Cache: ${gasCacheStats.hitRate} hit rate (${gasCacheStats.hits}/${gasCacheStats.total})`);
            
            const waitTime = Math.max(0, INTERVAL_MS - elapsed);
            if (waitTime > 0) {
                info(`\n⏳ Next cycle in ${(waitTime / 1000).toFixed(0)}s...\n`);
                await sleep(waitTime);
            }
            
        } catch (err) {
            error(`❌ Main loop error: ${err.message}`);
            stats.errors++;
            await sleep(30000);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// STARTUP & SHUTDOWN
// ═══════════════════════════════════════════════════════════════════

async function start() {
    try {
        await initialize();
        isRunning = true;
        await mainLoop();
    } catch (err) {
        error(`❌ Fatal error: ${err.message}`);
        process.exit(1);
    }
}

function shutdown() {
    info('\n👋 Shutting down...');
    isRunning = false;
    
    // ✅ Show final accurate stats
    const trackerStats = resultTracker.getStats();
    const gasCacheStats = getCacheStats();
    const uptime = (Date.now() - stats.startTime) / 1000 / 60;
    
    info(`\n${'═'.repeat(63)}`);
    info('📊 FINAL STATS');
    info(`${'═'.repeat(63)}`);
    info(`   Uptime: ${uptime.toFixed(2)} minutes`);
    info(`   Total cycles: ${stats.totalRuns}`);
    info(`   Decisions requested: ${stats.decisionsRequested}`);
    info(`   Executed: ${stats.decisionsExecuted}`);
    info(`   Hold decisions: ${stats.holdDecisions}`);
    info(`   Gas skipped: ${stats.gasSkipped}`);
    info(`   Errors: ${stats.errors}`);
    
    if (!SHADOW_MODE && trackerStats.totalResults > 0) {
        info(`\n💰 Reward Summary (Accurate v2.0):`);
        info(`   Total rebalances: ${trackerStats.totalResults}`);
        info(`   Profitable: ${trackerStats.profitRate}%`);
        info(`   Beat Hold: ${trackerStats.beatHoldRate}%`);
        info(`   Total Reward: ${trackerStats.totalRewardETH} ETH`);
        info(`   Avg ROI: ${trackerStats.avgROIPct}%`);
        info(`   Total Gas Spent: ${stats.totalGasCostETH.toFixed(6)} ETH`);
    }
    
    info(`\n⛽ Gas Cache Stats:`);
    info(`   Hit Rate: ${gasCacheStats.hitRate}`);
    info(`   Total Requests: ${gasCacheStats.total}`);
    
    info(`\n   Training log: ${TRAINING_LOG_PATH}`);
    info(`   Results log: ${RESULTS_LOG_PATH}`);
    info(`${'═'.repeat(63)}\n`);
    
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ═══════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════

if (require.main === module) {
    start().catch(err => {
        error(`❌ Startup failed: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    start,
    shutdown,
    initialize,
    collectMarketState,
    getPositionInfo,
    getRepositionContext,
    executeRebalance,
    processPosition,
    processPool,
    resultTracker,
    stats
};


