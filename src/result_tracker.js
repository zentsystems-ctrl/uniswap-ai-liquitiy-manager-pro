// src/result_tracker.js

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// ═══════════════════════════════════════════════════════════════════
// UNISWAP V3 MATH
// ═══════════════════════════════════════════════════════════════════

class UniswapV3Math {
    static tickToPrice(tick) {
        return Math.pow(1.0001, tick);
    }

    static priceToTick(price) {
        if (price <= 0) return 0;
        return Math.floor(Math.log(price) / Math.log(1.0001));
    }

    static tickToSqrtPrice(tick) {
        return Math.pow(1.0001, tick / 2);
    }

    static calculateStandardIL(priceRatio) {
        if (priceRatio <= 0) return 0;
        return Math.abs(2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1);
    }

    static calculateConcentratedIL(priceRatio, tickLower, tickUpper) {
        const standardIL = this.calculateStandardIL(priceRatio);
        const tickWidth = Math.abs(tickUpper - tickLower);
        const concentrationFactor = Math.min(4000 / Math.max(tickWidth, 100), 5);
        return standardIL * concentrationFactor;
    }

    static isInRange(currentTick, tickLower, tickUpper) {
        return currentTick >= tickLower && currentTick <= tickUpper;
    }
}

// ═══════════════════════════════════════════════════════════════════
// REWARD CALCULATOR
// ═══════════════════════════════════════════════════════════════════

class RewardCalculator {
    constructor(options = {}) {
        this.defaultFeeTier = options.feeTier || 3000;
        this.gasLimit = options.gasLimit || 500000;
    }

    calculatePositionValue(position, currentPrice) {
        const token0Value = (position.token0Balance || 0) * currentPrice;
        const token1Value = position.token1Balance || 0;
        const feesValue = ((position.feesEarned0 || 0) * currentPrice) + 
                         (position.feesEarned1 || 0);
        return token0Value + token1Value + feesValue;
    }

    estimateFeeYield(position, pool, hours = 24) {
        const inRange = UniswapV3Math.isInRange(
            position.currentTick,
            position.lowerTick,
            position.upperTick
        );
        
        if (!inRange) return 0;

        const feeTier = pool.feeTier || this.defaultFeeTier;
        const feeRate = feeTier / 1_000_000;
        const dailyPoolFees = (pool.volume24h || 0) * feeRate;
        const positionValue = this.calculatePositionValue(position, pool.currentPrice || 1);
        const liquidityShare = pool.tvl > 0 ? positionValue / pool.tvl : 0;
        const tickWidth = Math.abs(position.upperTick - position.lowerTick);
        const concentrationBonus = Math.min(4000 / Math.max(tickWidth, 100), 10);
        const positionFees = dailyPoolFees * liquidityShare * concentrationBonus;
        
        return positionFees * (hours / 24);
    }

    calculateRebalanceCosts(prePosition, postPosition, pool, gasCostETH) {
        const preValue = this.calculatePositionValue(prePosition, pool.currentPrice || 1);
        const sizeRatio = pool.tvl > 0 ? preValue / pool.tvl : 0.01;
        const baseSlippageBps = 10;
        const sizeSlippageBps = sizeRatio * 1000;
        const totalSlippageBps = baseSlippageBps + sizeSlippageBps;
        const slippageCost = preValue * (totalSlippageBps / 10000) * 2;

        const midTick = (prePosition.lowerTick + prePosition.upperTick) / 2;
        const entryPrice = UniswapV3Math.tickToPrice(midTick);
        const currentPrice = pool.currentPrice || UniswapV3Math.tickToPrice(prePosition.currentTick);
        const priceRatio = currentPrice / entryPrice;
        
        const ilPct = UniswapV3Math.calculateConcentratedIL(
            priceRatio,
            prePosition.lowerTick,
            prePosition.upperTick
        );
        const ilCost = preValue * ilPct;
        const priceImpactBps = sizeRatio * 100;
        const priceImpactCost = preValue * (priceImpactBps / 10000);

        return {
            gasCost: gasCostETH,
            slippageCost,
            ilCrystallized: ilCost,
            priceImpact: priceImpactCost,
            totalCost: gasCostETH + slippageCost + ilCost + priceImpactCost
        };
    }

    calculateRebalanceBenefits(prePosition, postPosition, pool, forecastHours = 24) {
        const preFeeYield = this.estimateFeeYield(prePosition, pool, forecastHours);
        const postFeeYield = this.estimateFeeYield(postPosition, pool, forecastHours);
        const feeImprovement = postFeeYield - preFeeYield;

        const preInRange = UniswapV3Math.isInRange(
            prePosition.currentTick,
            prePosition.lowerTick,
            prePosition.upperTick
        );
        const postInRange = UniswapV3Math.isInRange(
            postPosition.currentTick,
            postPosition.lowerTick,
            postPosition.upperTick
        );
        
        let rangeImprovement = 0;
        if (!preInRange && postInRange) {
            rangeImprovement = postFeeYield * 0.5;
        }

        const preCenter = (prePosition.lowerTick + prePosition.upperTick) / 2;
        const postCenter = (postPosition.lowerTick + postPosition.upperTick) / 2;
        const preDistance = Math.abs(prePosition.currentTick - preCenter);
        const postDistance = Math.abs(postPosition.currentTick - postCenter);
        
        const preValue = this.calculatePositionValue(prePosition, pool.currentPrice || 1);
        let centeringBenefit = 0;
        if (postDistance < preDistance && preDistance > 0) {
            const improvement = (preDistance - postDistance) / preDistance;
            centeringBenefit = preValue * improvement * 0.001;
        }

        return {
            feeImprovement,
            rangeImprovement,
            centeringBenefit,
            totalBenefit: feeImprovement + rangeImprovement + centeringBenefit
        };
    }

    calculateNetReward(prePosition, postPosition, pool, gasCostETH, forecastHours = 24) {
        const costs = this.calculateRebalanceCosts(prePosition, postPosition, pool, gasCostETH);
        const benefits = this.calculateRebalanceBenefits(prePosition, postPosition, pool, forecastHours);
        
        const netReward = benefits.totalBenefit - costs.totalCost;
        const preValue = this.calculatePositionValue(prePosition, pool.currentPrice || 1);
        const roiPct = preValue > 0 ? (netReward / preValue) * 100 : 0;

        return {
            gasCost: costs.gasCost,
            slippageCost: costs.slippageCost,
            ilCrystallized: costs.ilCrystallized,
            priceImpact: costs.priceImpact,
            totalCost: costs.totalCost,
            feeImprovement: benefits.feeImprovement,
            rangeImprovement: benefits.rangeImprovement,
            centeringBenefit: benefits.centeringBenefit,
            totalBenefit: benefits.totalBenefit,
            netReward,
            roiPct,
            isProfitable: netReward > 0,
            preValue,
            postValue: this.calculatePositionValue(postPosition, pool.currentPrice || 1),
            forecastHours
        };
    }

    calculateHoldReward(position, pool, priceChangePct = 0, holdHours = 24) {
        const feesEarned = this.estimateFeeYield(position, pool, holdHours);
        const priceRatio = 1 + (priceChangePct / 100);
        const ilPct = UniswapV3Math.calculateConcentratedIL(
            priceRatio,
            position.lowerTick,
            position.upperTick
        );
        
        const positionValue = this.calculatePositionValue(position, pool.currentPrice || 1);
        const ilCost = positionValue * ilPct;
        const netReward = feesEarned - ilCost;

        return {
            feesEarned,
            ilCost,
            netReward,
            roiPct: positionValue > 0 ? (netReward / positionValue) * 100 : 0
        };
    }
}

// ═══════════════════════════════════════════════════════════════════
// ✅ FIXED RESULT TRACKER V2.1
// ═══════════════════════════════════════════════════════════════════

class ResultTrackerV2 {
    constructor(options = {}) {
        this.resultsLogPath = options.resultsLogPath || './data/results_log.ndjson';
        this.trainingLogPath = options.trainingLogPath || './data/training_log.ndjson';
        this.trackingMap = new Map();
        this.rewardCalculator = new RewardCalculator();

        [this.resultsLogPath, this.trainingLogPath].forEach(logPath => {
            const dir = path.dirname(logPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });

        console.log('📊 ResultTracker v2.1 initialized (Fixed Compatibility)');
    }

    /**
     * ✅ FIXED: Capture pre-state with full compatibility
     */
    async capturePreState(positionId, state, decision, pool, pmContract, indexContract) {
        const decisionId = this._generateDecisionId(positionId, state.timestamp);
        console.log(`📸 Capturing pre-state for decision ${decisionId}`);

        const positionInfo = await this._getPositionInfo(positionId, pmContract, pool);
        const feeData = await pmContract.runner.provider.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
        const poolData = await this._getPoolData(pool, state);

        // ✅ FIX: Get level from PM contract
        let level = 0;
        try {
            const posData = await pmContract.positions(positionId);
            level = Number(posData[2]); // level is index 2
        } catch (err) {
            console.warn(`⚠️ Could not get level from PM: ${err.message}`);
            level = state.position?.level || 0;
        }

        // ✅ Get reposition context from Index
        let repositionContext = {};
        try {
            if (indexContract && state.poolId) {
                const levels = await indexContract.getAllLevels(state.poolId);
                repositionContext = {
                    level: level,
                    p_ref: levels[0][level] ? Number(ethers.formatEther(levels[0][level])) : null,
                    p_now: levels[1][level] ? Number(ethers.formatEther(levels[1][level])) : null,
                    deviation_bps: levels[2][level] ? Number(levels[2][level]) : 0,
                    threshold_bps: levels[4][level] ? Number(levels[4][level]) : 500,
                    is_out_of_bounds: levels[2][level] > levels[4][level]
                };
            }
        } catch (err) {
            console.warn(`⚠️ Could not get reposition context: ${err.message}`);
            // ✅ Fallback to state data
            repositionContext = {
                level: level,
                p_ref: state.extra?.p_ref || null,
                p_now: state.extra?.p_now || state.current_price,
                deviation_bps: state.extra?.deviation_bps || 0,
                threshold_bps: state.extra?.threshold_bps || 500,
                is_out_of_bounds: state.extra?.is_out_of_bounds || false
            };
        }

        const preState = {
            decisionId,
            positionId,
            timestamp: Date.now(),
            captureTime: new Date().toISOString(),

            market: {
                poolId: state.poolId,
                currentPrice: state.current_price,
                twap1h: state.twap_1h,
                twap24h: state.twap_24h,
                volatility1h: state.volatility_1h,
                volatility24h: state.volatility_24h,
                gasPrice: ethers.formatUnits(gasPrice, 'gwei')
            },

            pool: poolData,
            
            // ✅ FIX: Include full reposition context
            repositionContext,

            position: {
                tokenId: positionInfo.tokenId,
                level: level, // ✅ FIX: Added level
                lowerTick: positionInfo.lowerTick,
                upperTick: positionInfo.upperTick,
                liquidity: positionInfo.liquidity,
                token0Balance: positionInfo.token0Balance,
                token1Balance: positionInfo.token1Balance,
                totalValueETH: positionInfo.token0Balance + positionInfo.token1Balance,
                feesEarned0: positionInfo.feesEarned0,
                feesEarned1: positionInfo.feesEarned1,
                totalFeesETH: positionInfo.feesEarned0 + positionInfo.feesEarned1,
                inRange: positionInfo.inRange,
                currentTick: positionInfo.currentTick
            },

            decision: {
                action: decision.action,
                confidence: decision.confidence,
                expectedReward: decision.expected_reward,
                riskLevel: decision.risk_level,
                reason: decision.reason
            },

            // ✅ FIX: Store full state for compatibility
            fullState: state,
            fullDecision: decision
        };

        this.trackingMap.set(decisionId, preState);
        console.log(`✅ Pre-state captured with level=${level}`);
        
        return decisionId;
    }

    /**
     * ✅ FIXED: Capture post-state with accurate reward calculation
     */
    async capturePostState(decisionId, txReceipt, pool, pmContract) {
        console.log(`📸 Capturing post-state for decision ${decisionId}`);

        const preState = this.trackingMap.get(decisionId);
        if (!preState) {
            console.error(`❌ No pre-state found for decision ${decisionId}`);
            return null;
        }

        const positionId = preState.positionId;

        try {
            await this._sleep(5000);

            const positionInfo = await this._getPositionInfo(positionId, pmContract, pool);
            const gasCostWei = txReceipt.gasUsed * (txReceipt.gasPrice || txReceipt.effectiveGasPrice);
            const gasCostETH = Number(ethers.formatEther(gasCostWei));

            const postPosition = {
                tokenId: positionInfo.tokenId,
                level: preState.position.level, // ✅ Preserve level
                lowerTick: positionInfo.lowerTick,
                upperTick: positionInfo.upperTick,
                liquidity: positionInfo.liquidity,
                token0Balance: positionInfo.token0Balance,
                token1Balance: positionInfo.token1Balance,
                totalValueETH: positionInfo.token0Balance + positionInfo.token1Balance,
                feesEarned0: positionInfo.feesEarned0,
                feesEarned1: positionInfo.feesEarned1,
                totalFeesETH: positionInfo.feesEarned0 + positionInfo.feesEarned1,
                inRange: positionInfo.inRange,
                currentTick: positionInfo.currentTick
            };

            const reward = this.rewardCalculator.calculateNetReward(
                preState.position,
                postPosition,
                preState.pool,
                gasCostETH
            );

            const holdReward = this.rewardCalculator.calculateHoldReward(
                preState.position,
                preState.pool,
                0,
                24
            );

            const postState = {
                timestamp: Date.now(),
                captureTime: new Date().toISOString(),
                transaction: {
                    hash: txReceipt.hash,
                    blockNumber: txReceipt.blockNumber,
                    gasUsed: txReceipt.gasUsed.toString(),
                    gasCostETH,
                    status: txReceipt.status
                },
                position: postPosition
            };

            const completeRecord = {
                decisionId,
                positionId,
                executionTimestamp: Date.now(),
                executionTime: new Date().toISOString(),

                pre: preState,
                post: postState,
                
                reward: {
                    gasCostETH: reward.gasCost,
                    slippageCostETH: reward.slippageCost,
                    ilCrystallizedETH: reward.ilCrystallized,
                    priceImpactETH: reward.priceImpact,
                    totalCostETH: reward.totalCost,
                    feeImprovementETH: reward.feeImprovement,
                    rangeImprovementETH: reward.rangeImprovement,
                    centeringBenefitETH: reward.centeringBenefit,
                    totalBenefitETH: reward.totalBenefit,
                    netRewardETH: reward.netReward,
                    roiPct: reward.roiPct,
                    isProfitable: reward.isProfitable
                },

                counterfactual: {
                    holdRewardETH: holdReward.netReward,
                    rebalanceAdvantage: reward.netReward - holdReward.netReward,
                    wasCorrectDecision: reward.netReward > holdReward.netReward
                },

                summary: {
                    action: preState.decision.action,
                    executed: true,
                    success: txReceipt.status === 1,
                    netRewardETH: reward.netReward,
                    gasCostETH,
                    roiPct: reward.roiPct,
                    isProfitable: reward.isProfitable,
                    duration: (postState.timestamp - preState.timestamp) / 1000
                },

                // ✅ FIX: Create fully compatible training data
                trainingData: this._createTrainingRecord(preState, postState, reward, holdReward)
            };

            console.log(`\n💰 Reward Calculation (v2.1):`);
            console.log(`   Benefits: +${reward.totalBenefit.toFixed(6)} ETH`);
            console.log(`   Costs: -${reward.totalCost.toFixed(6)} ETH`);
            console.log(`   Net Reward: ${reward.netReward >= 0 ? '+' : ''}${reward.netReward.toFixed(6)} ETH`);
            console.log(`   ROI: ${reward.roiPct.toFixed(2)}%`);

            this._writeResultsLog(completeRecord);
            this._writeTrainingLog(completeRecord.trainingData);
            this.trackingMap.delete(decisionId);

            return completeRecord;

        } catch (err) {
            console.error(`❌ Failed to capture post-state: ${err.message}`);
            return null;
        }
    }

    /**
     * ✅ FIXED: Log HOLD decisions with full compatibility
     */
    logHoldDecision(state, decision, pool, reason = 'ai_hold') {
        const position = {
            level: state.position?.level || 0, // ✅ Include level
            lowerTick: state.position?.lowerTick || 0,
            upperTick: state.position?.upperTick || 0,
            currentTick: state.extra?.currentTick || 0,
            token0Balance: state.position?.token0_balance || 0,
            token1Balance: state.position?.token1_balance || 0,
            feesEarned0: state.position?.fees_earned_0 || 0,
            feesEarned1: state.position?.fees_earned_1 || 0
        };

        const poolData = {
            currentPrice: state.current_price || 1,
            volume24h: state.volume_24h || 0,
            tvl: state.pool_liquidity || 1000000,
            feeTier: 3000
        };

        const holdReward = this.rewardCalculator.calculateHoldReward(position, poolData, 0, 24);

        // ✅ FIX: Extract or use reposition context
        const repoContext = state.extra || {};

        const holdRecord = {
            timestamp: Date.now(),
            action: 'hold',
            executed: false,

            context: {
                poolId: state.poolId,
                currentPrice: state.current_price,
                deviation_pct: state.deviation_pct || 0,
                threshold_pct: state.threshold_pct || 5,
                within_bounds: state.within_bounds,
                volatility_24h: state.volatility_24h,
                gas_price_gwei: state.gas_price,
                in_range: state.extra?.inRange
            },

            position: state.position,
            
            decision: {
                confidence: decision.confidence,
                expectedReward: decision.expected_reward,
                riskLevel: decision.risk_level,
                reason: decision.reason
            },

            reward: {
                feesEarnedETH: holdReward.feesEarned,
                ilCostETH: holdReward.ilCost,
                netRewardETH: holdReward.netReward,
                roiPct: holdReward.roiPct
            },

            holdReason: reason,

            // ✅ FIX: Add reposition_context for auto_retrain.py
            reposition_context: {
                level: position.level,
                p_ref: repoContext.p_ref,
                p_now: repoContext.p_now,
                deviation_bps: repoContext.deviation_bps || 0,
                threshold_bps: repoContext.threshold_bps || 500
            },

            // ✅ FIX: Add extra for ai_engine.py
            extra: {
                inRange: state.extra?.inRange || true,
                currentTick: state.extra?.currentTick || 0,
                p_ref: repoContext.p_ref,
                p_now: repoContext.p_now,
                deviation_bps: repoContext.deviation_bps || 0,
                threshold_bps: repoContext.threshold_bps || 500,
                is_out_of_bounds: repoContext.is_out_of_bounds || false
            },

            label: {
                action: 'hold',
                net_reward: holdReward.netReward,
                confidence: decision.confidence,
                was_correct: null
            }
        };

        this._writeTrainingLog(holdRecord);
        console.log(`📝 Logged HOLD decision (expected reward: ${holdReward.netReward.toFixed(6)} ETH)`);
    }

    /**
     * ✅ FIXED: Create training record with FULL compatibility
     */
    _createTrainingRecord(preState, postState, reward, holdReward) {
        const rc = preState.repositionContext || {};
        const pos = preState.position;

        return {
            timestamp: Date.now(),
            action: 'rebalance',
            executed: true,
            scenario: 'production', // Could be extracted from metadata
            level: pos.level, // ✅ Top-level for easy access

            features: {
                // Price context
                deviation_pct: (rc.deviation_bps || 0) / 100,
                threshold_pct: (rc.threshold_bps || 500) / 100,
                is_out_of_bounds: rc.is_out_of_bounds || false,
                price_vs_twap_1h: preState.market.currentPrice / (preState.market.twap1h || preState.market.currentPrice),
                price_vs_twap_24h: preState.market.currentPrice / (preState.market.twap24h || preState.market.currentPrice),

                // ✅ FIX: Add reference price features
                price_dev_ref: (rc.deviation_bps || 0) / 100,
                price_ratio_ref: rc.p_now && rc.p_ref ? rc.p_now / rc.p_ref : 1.0,
                level_encoded: [0.25, 0.5, 0.75, 1.0][pos.level] || 0.5,

                // Volatility
                volatility_1h: preState.market.volatility1h || 0,
                volatility_24h: preState.market.volatility24h || 0,

                // Position state
                in_range_before: pos.inRange,
                tick_width: pos.upperTick - pos.lowerTick,
                distance_to_lower_pct: pos.currentTick && pos.lowerTick ? 
                    Math.abs(pos.currentTick - pos.lowerTick) / Math.abs(pos.upperTick - pos.lowerTick) : 0,
                distance_to_upper_pct: pos.currentTick && pos.upperTick ?
                    Math.abs(pos.upperTick - pos.currentTick) / Math.abs(pos.upperTick - pos.lowerTick) : 0,
                
                position_value_eth: pos.totalValueETH,
                fees_accumulated_eth: pos.totalFeesETH,

                // Gas
                gas_price_gwei: parseFloat(preState.market.gasPrice) || 50,
                gas_cost_pct: pos.totalValueETH > 0 ? (reward.gasCost / pos.totalValueETH) * 100 : 0,

                // AI decision
                ai_confidence: preState.decision.confidence,
                ai_expected_reward: preState.decision.expectedReward
            },

            outcome: {
                tick_shift: postState.position.lowerTick - pos.lowerTick,
                width_change: (postState.position.upperTick - postState.position.lowerTick) - (pos.upperTick - pos.lowerTick),
                range_improved: !pos.inRange && postState.position.inRange,
                in_range_after: postState.position.inRange,

                // Costs breakdown
                gas_cost_eth: reward.gasCost,
                slippage_cost_eth: reward.slippageCost,
                il_cost_eth: reward.ilCrystallized,
                total_cost_eth: reward.totalCost,

                // Benefits breakdown
                fee_improvement_eth: reward.feeImprovement,
                range_improvement_eth: reward.rangeImprovement,
                centering_benefit_eth: reward.centeringBenefit,
                total_benefit_eth: reward.totalBenefit,

                // Net result
                net_reward_eth: reward.netReward,
                roi_pct: reward.roiPct,
                
                // Legacy fields for backward compatibility
                value_change_eth: reward.centeringBenefit,
                fees_earned_eth: reward.feeImprovement + reward.rangeImprovement
            },

            // ✅ FIX: Add context for auto_retrain.py
            context: {
                poolId: preState.market.poolId,
                currentPrice: preState.market.currentPrice,
                deviation_pct: (rc.deviation_bps || 0) / 100,
                threshold_pct: (rc.threshold_bps || 500) / 100,
                within_bounds: !rc.is_out_of_bounds,
                volatility_24h: preState.market.volatility24h || 0,
                gas_price_gwei: parseFloat(preState.market.gasPrice) || 50,
                pool_liquidity: preState.pool.tvl,
                volume_24h: preState.pool.volume24h
            },

            // ✅ FIX: Add position with all required fields
            position: {
                id: preState.positionId,
                owner: preState.fullState?.position?.owner || '',
                level: pos.level, // ✅ Critical for auto_retrain.py
                lowerTick: pos.lowerTick,
                upperTick: pos.upperTick,
                liquidity: pos.liquidity,
                token0_balance: pos.token0Balance,
                token1_balance: pos.token1Balance,
                fees_earned_0: pos.feesEarned0,
                fees_earned_1: pos.feesEarned1,
                age_seconds: 0
            },

            // ✅ FIX: Add extra for ai_engine.py compatibility
            extra: {
                inRange: pos.inRange,
                currentTick: pos.currentTick,
                p_ref: rc.p_ref,
                p_now: rc.p_now,
                deviation_bps: rc.deviation_bps || 0,
                threshold_bps: rc.threshold_bps || 500,
                is_out_of_bounds: rc.is_out_of_bounds || false,
                decimals0: preState.fullState?.extra?.decimals0 || 18,
                decimals1: preState.fullState?.extra?.decimals1 || 6,
                poolAddress: preState.fullState?.extra?.poolAddress || ''
            },

            // ✅ FIX: Add reposition_context for auto_retrain.py
            reposition_context: {
                level: pos.level,
                p_ref: rc.p_ref,
                p_now: rc.p_now,
                deviation_bps: rc.deviation_bps || 0,
                threshold_bps: rc.threshold_bps || 500
            },

            counterfactual: {
                hold_reward_eth: holdReward.netReward,
                rebalance_advantage: reward.netReward - holdReward.netReward,
                was_correct_decision: reward.netReward > holdReward.netReward
            },

            label: {
                action: 'rebalance',
                net_reward: reward.netReward,
                was_profitable: reward.isProfitable,
                beat_hold: reward.netReward > holdReward.netReward,
                reward_score: this._calculateRewardScore(reward.netReward, !pos.inRange && postState.position.inRange)
            }
        };
    }

    /**
     * Calculate reward score (0-1) for training
     */
    _calculateRewardScore(netReward, rangeImproved) {
        let score = 0.5;
        if (netReward > 0) {
            score += Math.min(0.3, netReward * 5);
        } else {
            score -= Math.min(0.3, Math.abs(netReward) * 5);
        }
        if (rangeImproved) {
            score += 0.2;
        }
        return Math.max(0.0, Math.min(1.0, score));
    }

    /**
     * Get pool data for calculations
     */
    async _getPoolData(pool, state) {
        try {
            const liquidity = await pool.liquidity();
            const slot0 = await pool.slot0();
            
            return {
                currentPrice: state.current_price || 1,
                currentTick: Number(slot0[1]),
                tvl: Number(ethers.formatEther(liquidity)) * (state.current_price || 1) * 2,
                volume24h: state.volume_24h || 0,
                feeTier: 3000
            };
        } catch (err) {
            return {
                currentPrice: state.current_price || 1,
                currentTick: state.extra?.currentTick || 0,
                tvl: state.pool_liquidity || 1000000,
                volume24h: state.volume_24h || 0,
                feeTier: 3000
            };
        }
    }

    /**
     * ✅ FIXED: Get position info with level from contracts
     */
    async _getPositionInfo(positionId, pmContract, pool) {
        const posData = await pmContract.positions(positionId);
        const tokenId = posData[3];
        const tickLower = Number(posData[4]);
        const tickUpper = Number(posData[5]);
        const liquidity = Number(posData[6]);

        const slot0 = await pool.slot0();
        const currentTick = Number(slot0[1]);
        const inRange = currentTick >= tickLower && currentTick <= tickUpper;

        const nftpmAddress = await pmContract.nfpm();
        const NFPM_ABI = [
            'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
        ];
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
            liquidity,
            token0Balance,
            token1Balance,
            feesEarned0,
            feesEarned1,
            inRange,
            currentTick
        };
    }

    _writeResultsLog(record) {
        try {
            fs.appendFileSync(this.resultsLogPath, JSON.stringify(record) + '\n', 'utf8');
            console.log(`✅ Result logged to ${this.resultsLogPath}`);
        } catch (err) {
            console.error(`❌ Failed to write results log: ${err.message}`);
        }
    }

    _writeTrainingLog(record) {
        try {
            fs.appendFileSync(this.trainingLogPath, JSON.stringify(record) + '\n', 'utf8');
        } catch (err) {
            console.error(`❌ Failed to write training log: ${err.message}`);
        }
    }

    _generateDecisionId(positionId, timestamp) {
        return `${positionId}_${Math.floor(timestamp / 1000)}`;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    getStats() {
        if (!fs.existsSync(this.resultsLogPath)) {
            return { totalResults: 0 };
        }

        try {
            const lines = fs.readFileSync(this.resultsLogPath, 'utf8')
                .split('\n').filter(l => l.trim());

            const results = lines.map(l => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(r => r !== null);

            const successful = results.filter(r => r.summary?.success);
            const profitable = results.filter(r => r.reward?.isProfitable);
            const beatHold = results.filter(r => r.counterfactual?.wasCorrectDecision);

            const totalReward = results.reduce((sum, r) => sum + (r.reward?.netRewardETH || 0), 0);
            const avgROI = results.length > 0 
                ? results.reduce((sum, r) => sum + (r.reward?.roiPct || 0), 0) / results.length 
                : 0;

            return {
                totalResults: results.length,
                successful: successful.length,
                profitable: profitable.length,
                beatHold: beatHold.length,
                successRate: results.length > 0 ? (successful.length / results.length * 100).toFixed(2) : 0,
                profitRate: results.length > 0 ? (profitable.length / results.length * 100).toFixed(2) : 0,
                beatHoldRate: results.length > 0 ? (beatHold.length / results.length * 100).toFixed(2) : 0,
                totalRewardETH: totalReward.toFixed(6),
                avgROIPct: avgROI.toFixed(2)
            };
        } catch (err) {
            return { totalResults: 0, error: err.message };
        }
    }
}

module.exports = { 
    ResultTrackerV2, 
    RewardCalculator, 
    UniswapV3Math 
};