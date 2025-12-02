// test/ai_LINK_fixed.js  (REPLACEMENT)
const { expect } = require("chai");
const { ethers } = require("hardhat");
const axios = require("axios");

describe("Visual syncPosition test (LINK/WETH) - With AI Engine - FIXED", function () {
  let deployer, updater, user;
  let index, positionManager;
  let link, weth;

  // LINK/WETH addresses on Ethereum Mainnet
  const LINK_ADDRESS = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
  const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const NFPM_ADDRESS = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
  
  // LINK/WETH 0.3% pool on Uniswap V3
  const LINK_WETH_POOL = "0xa6Cc3C2531FdaA6Ae1A3CA84c2855806728693e8";
  
  // Whales with LINK and WETH
  const WHALE_LINK = "0xfbc4d9e54d64C3853CdE6084A6707800f0796A24";
  const WHALE_WETH = "0x8EB8a3b98659Cce290402893d0123abb75E3ab28";

  // AI Engine configuration
  const AI_ENGINE_URL = process.env.AI_ENGINE_URL || "http://localhost:8000/decide";
  const MIN_CONFIDENCE = 0.7;
  const AI_ENABLED = true;

  const LEVELS = [0, 1, 2, 3]; // L1, L5, L10, L20

  let poolId, whaleLink, whaleWeth;

  // map to store actual amounts used when opening positions (FIX)
  const posAmounts = {};

  function parseOpenPositionEvent(rcpt, contractInterface, contractAddress) {
    const logsFromAddress = rcpt.logs.filter(l => l.address && l.address.toLowerCase() === contractAddress.toLowerCase());
    for (const l of logsFromAddress) {
      try {
        const parsed = contractInterface.parseLog(l);
        if (parsed && parsed.name === "OpenPosition") return parsed;
      } catch (e) { /* ignore */ }
    }
    return undefined;
  }

  async function getDeadline(offset = 3600) {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp + offset;
  }

  // AI Engine Helper Functions - FIXED BigInt conversions & position value derivation
  async function callAIEngine(marketState) {
    if (!AI_ENABLED) {
      console.log("   🤖 AI Disabled - Using rule-based fallback");
      // Rule-based fallback logic
      const deviation = marketState.deviation_pct || 0;
      const inRange = marketState.extra?.inRange || false;
      
      if (deviation > 5 || !inRange) {
        return {
          action: 'rebalance',
          confidence: 0.85,
          expected_reward: 0.03,
          risk_level: 'medium',
          reason: 'rule_based_fallback_high_deviation'
        };
      } else {
        return {
          action: 'hold',
          confidence: 0.6,
          expected_reward: 0,
          risk_level: 'low',
          reason: 'rule_based_fallback_within_bounds'
        };
      }
    }

    try {
      console.log("   🤖 Calling AI Engine...");
      const response = await axios.post(AI_ENGINE_URL, marketState, {
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json'
        }
      });
      console.log("   ✅ AI Response Received");
      return response.data;
    } catch (error) {
      console.log('❌ AI Engine call failed:', error.message);
      // Fallback to conservative decision
      return {
        action: 'hold',
        confidence: 0.3,
        expected_reward: 0,
        risk_level: 'high',
        reason: `ai_service_failed: ${error.message}`
      };
    }
  }

  // FIXED: Proper BigInt to Number conversions and use pNow as current_price when available.
  async function collectMarketStateForAI(poolId, positionId) {
    try {
      const poolConfig = await index.pools(poolId);
      const pool = await ethers.getContractAt([
        "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16, uint16, uint16, uint8, bool)",
        "function liquidity() view returns (uint128)",
        "function token0() view returns (address)",
        "function token1() view returns (address)"
      ], poolConfig.poolAddress);
      
      // Get current pool state - PROPERLY HANDLE BigInt
      const slot0 = await pool.slot0();
      const currentTick = Number(slot0[1].toString()); // ✅ Convert BigInt to Number
      const sqrtPriceX96 = slot0[0];
      const poolLiquidity = await pool.liquidity();
      
      // Get position data
      const position = await positionManager.positions(positionId);
      
      // Get level states - PROPERLY HANDLE BigInt conversions
      const levels = await index.getAllLevels(poolId);
      const levelState = await index.levelStates(poolId, position.level);
      
      // pRef & pNow from levels when possible (these come as WAD/ether-format in index)
      const levelIndex = Number(position.level.toString());
      const pRef = (levels[0] && levels[0][levelIndex]) ? Number(ethers.formatEther(levels[0][levelIndex].toString())) : null;
      const pNow = (levels[1] && levels[1][levelIndex]) ? Number(ethers.formatEther(levels[1][levelIndex].toString())) : null;
      const deviationBps = (levels[2] && levels[2][levelIndex]) ? Number(levels[2][levelIndex].toString()) : 0;
      const thresholdBps = (levels[4] && levels[4][levelIndex]) ? Number(levels[4][levelIndex].toString()) : 500; // 5% default
      
      // Compute fallback adjustedPrice only if levels do NOT provide pNow/pRef
      let adjustedPrice = null;
      if (!pNow && sqrtPriceX96) {
        try {
          const Q96 = BigInt(2) ** BigInt(96);
          const sqrtPriceX96Big = BigInt(sqrtPriceX96.toString());
          // Compute as float with moderate precision: (sqrtQ^2 / Q96^2)
          const num = Number(sqrtPriceX96Big.toString());
          const denom = Number(Q96.toString());
          adjustedPrice = (num * num) / (denom * denom);
        } catch (e) {
          adjustedPrice = 0.0;
        }
      }

      // Decide current price: prefer pNow, fallback to pRef, then adjustedPrice, lastly 1.0
      const current_price = pNow ?? pRef ?? adjustedPrice ?? 1.0; // FIX: prefer pNow
      
      // Get gas data (safe fallback)
      const feeData = await ethers.provider.getFeeData();
      const gasPriceGwei = feeData && feeData.gasPrice ? Number(ethers.formatUnits(feeData.gasPrice.toString(), 'gwei')) : 50.0;
      
      // Determine token balances for the position:
      // FIX: prefer amounts used at creation (posAmounts) if available, otherwise keep placeholders but compute positionValue
      let token0_balance = 0;
      let token1_balance = 0;
      let positionValue = 0;
      const key = positionId.toString();
      if (posAmounts[key]) {
        token0_balance = Number(ethers.formatEther(posAmounts[key].amount0));
        token1_balance = Number(ethers.formatEther(posAmounts[key].amount1));
        positionValue = token1_balance + token0_balance * current_price;
      } else {
        // Fallback: try to infer token balances from position (if the contract exposes; often not), else approximate
        // We'll approximate using a tiny default to avoid zero division issues
        token0_balance = 0.0;
        token1_balance = 0.0;
        positionValue = Math.max(0.001, Number(ethers.formatEther(position.liquidity.toString())) * current_price * 1e-6);
      }
      
      // Calculate if position is in range (tick-based)
      const inRange = currentTick >= Number(position.tickLower.toString()) && 
                     currentTick <= Number(position.tickUpper.toString());
      
      // Build comprehensive market state for AI
      const marketState = {
        timestamp: Math.floor(Date.now() / 1000),
        poolId: poolId,
        current_price: current_price,
        price: current_price,
        twap_1h: pNow ?? current_price,
        twap_24h: pRef ?? current_price,
        volatility_1h: 0.02,
        volatility_24h: 0.05,
        pool_liquidity: Number(ethers.formatEther(poolLiquidity.toString())),
        volume_24h: 500000,
        gas_price: gasPriceGwei,
        deviation_pct: deviationBps / 100, // Convert BPS to percentage
        threshold_pct: thresholdBps / 100,
        within_bounds: deviationBps <= thresholdBps,
        position: {
          id: Number(positionId.toString()),
          owner: position.owner,
          lowerTick: Number(position.tickLower.toString()),
          upperTick: Number(position.tickUpper.toString()),
          liquidity: Number(position.liquidity.toString()),
          token0_balance: token0_balance,
          token1_balance: token1_balance,
          fees_earned_0: 0,
          fees_earned_1: 0,
          age_seconds: 3600
        },
        price_impact: 'low',
        extra: {
          currentTick: currentTick,
          inRange: inRange,
          decimals0: Number(poolConfig.decimals0.toString()),
          decimals1: Number(poolConfig.decimals1.toString()),
          poolAddress: poolConfig.poolAddress,
          positionValueETH: positionValue, // FIX: set computed value here
          level: Number(position.level.toString()),
          hasPendingReposition: levelState.hasPendingReposition
        }
      };

      return marketState;
    } catch (error) {
      console.log('❌ Error collecting market state for AI:', error.message);
      throw error;
    }
  }

  async function shouldRebalanceWithAI(poolId, positionId) {
    console.log(`\n🧠 Consulting AI Engine for position ${positionId}...`);
    
    try {
      // Collect market state
      const marketState = await collectMarketStateForAI(poolId, positionId);
      
      // Call AI Engine
      const aiDecision = await callAIEngine(marketState);
      
      console.log(`   AI Decision: ${aiDecision.action.toUpperCase()}`);
      console.log(`   Confidence: ${(aiDecision.confidence * 100).toFixed(1)}%`);
      console.log(`   Expected Reward: ${aiDecision.expected_reward} ETH`);
      console.log(`   Risk Level: ${aiDecision.risk_level.toUpperCase()}`);
      console.log(`   Reason: ${aiDecision.reason}`);
      
      // Decision criteria
      const shouldExecute = aiDecision.action === 'rebalance' && 
                           aiDecision.confidence >= MIN_CONFIDENCE &&
                           aiDecision.risk_level !== 'high';
      
      return {
        shouldExecute,
        decision: aiDecision,
        marketState
      };
    } catch (error) {
      console.log(`❌ AI analysis failed: ${error.message}`);
      // Conservative fallback - don't rebalance on error
      return {
        shouldExecute: false,
        decision: {
          action: 'hold',
          confidence: 0.1,
          expected_reward: 0,
          risk_level: 'high',
          reason: `analysis_failed: ${error.message}`
        },
        marketState: null
      };
    }
  }

  before(async function () {
    [deployer, updater, user] = await ethers.getSigners();

    link = await ethers.getContractAt("IERC20", LINK_ADDRESS);
    weth = await ethers.getContractAt("IERC20", WETH_ADDRESS);

    const Index = await ethers.getContractFactory("Index");
    index = await Index.deploy(deployer.address);
    await index.waitForDeployment();

    const PositionManager = await ethers.getContractFactory("PositionManager");
    positionManager = await PositionManager.deploy(await index.getAddress(), NFPM_ADDRESS);
    await positionManager.waitForDeployment();

    // Grant roles
    const UPDATER_ROLE = await index.UPDATER_ROLE();
    await index.grantRole(UPDATER_ROLE, updater.address);
    await index.grantRole(UPDATER_ROLE, deployer.address);
    
    const PM_UPDATER = await positionManager.UPDATER_ROLE();
    await positionManager.grantRole(PM_UPDATER, updater.address);
    await positionManager.grantRole(PM_UPDATER, deployer.address);
    
    const POSMAN_ROLE = await index.POSITION_MANAGER_ROLE();
    await index.grantRole(POSMAN_ROLE, await positionManager.getAddress());

    // Impersonate whales
    await ethers.provider.send("hardhat_impersonateAccount", [WHALE_LINK]);
    await ethers.provider.send("hardhat_impersonateAccount", [WHALE_WETH]);
    whaleLink = await ethers.getSigner(WHALE_LINK);
    whaleWeth = await ethers.getSigner(WHALE_WETH);
    
    // Fund whales with ETH for gas
    await deployer.sendTransaction({ to: WHALE_LINK, value: ethers.parseEther("0.5") });
    await deployer.sendTransaction({ to: WHALE_WETH, value: ethers.parseEther("0.5") });

    // Register pool
    poolId = ethers.keccak256(ethers.toUtf8Bytes("LINK_WETH_MAIN"));
    
    // Get current pool price
    const pool = await ethers.getContractAt([
      "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16, uint16, uint16, uint8, bool)"
    ], LINK_WETH_POOL);
    
    const slot0 = await pool.slot0();
    const initialPRef = ethers.parseEther("0.00439835");

    await index.registerPool(
      poolId,
      LINK_WETH_POOL,
      18, // LINK decimals
      18, // WETH decimals
      false, // Use custom TWAP
      initialPRef,
      1800, // 30 min TWAP window
      10 // Buffer size
    );

    // Push multiple samples to establish TWAP
    console.log("\n📊 Establishing TWAP baseline...");
    for (let i = 0; i < 5; i++) {
      await index.connect(updater).pushSample(poolId, initialPRef);
      await ethers.provider.send("evm_increaseTime", [300]);
      await ethers.provider.send("evm_mine");
    }
    
    console.log("\n🤖 AI Engine Configuration:");
    console.log(`   URL: ${AI_ENGINE_URL}`);
    console.log(`   Enabled: ${AI_ENABLED}`);
    console.log(`   Min Confidence: ${MIN_CONFIDENCE * 100}%`);
  });

  after(async function () {
    try {
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [WHALE_LINK]);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [WHALE_WETH]);
    } catch (e) {}
  });

  it("visualizes AI-driven rebalancing with +15% price increase", async function () {
    // Amounts for opening positions
    const amount0 = ethers.parseEther("1000"); // 1000 LINK
    const amount1 = ethers.parseEther("4");     // 4 WETH
    const amount0Min = 0, amount1Min = 0;

    // Open positions for each level
    const posIds = [];
    console.log("\n🔷 Opening positions for AI testing...");
    
    for (const lvl of LEVELS) {
      // Fund user
      await link.connect(whaleLink).transfer(user.address, amount0);
      await weth.connect(whaleWeth).transfer(user.address, amount1);
      
      // Approve
      await link.connect(user).approve(await positionManager.getAddress(), amount0);
      await weth.connect(user).approve(await positionManager.getAddress(), amount1);
      
      // Open position
      const tx = await positionManager.connect(user).openPosition(
        poolId, 
        lvl, 
        LINK_ADDRESS, 
        WETH_ADDRESS, 
        3000, // 0.3% fee tier
        amount0, 
        amount1, 
        amount0Min, 
        amount1Min, 
        await getDeadline()
      );
      
      const rcpt = await tx.wait();
      const log = parseOpenPositionEvent(rcpt, positionManager.interface, await positionManager.getAddress());
      expect(log).to.not.be.undefined;
      const pid = log.args.id.toString();
      posIds.push(pid);

      // FIX: store actual amounts used for this position so marketState can compute positionValue
      posAmounts[pid] = { amount0: amount0, amount1: amount1 };
      
      const levelNames = ["L1 (1%)", "L5 (5%)", "L10 (10%)", "L20 (20%)"];
      console.log(`✓ Opened position ${pid} at ${levelNames[lvl]}`);
    }

    // Helper to print levels
    async function readLevels() {
      const levels = await index.getAllLevels(poolId);
      const p_refs = levels[0];
      const p_nows = levels[1];
      const deviations = levels[2];
      const lastRepoTss = levels[3];
      const thresholds = levels[4];

      const out = [];
      for (let i = 0; i < p_refs.length; i++) {
        const st = await index.levelStates(poolId, i);
        
        const devBps = Number(deviations[i].toString());
        const threshBps = Number(thresholds[i].toString());

        out.push({
          level: `L${i === 0 ? '1' : i === 1 ? '5' : i === 2 ? '10' : '20'}`,
          p_ref_ETH: Number(ethers.formatEther(p_refs[i].toString())).toFixed(6),
          p_now_ETH: Number(ethers.formatEther(p_nows[i].toString())).toFixed(6),
          deviation: `${(devBps / 100).toFixed(2)}%`,
          threshold: `${(threshBps / 100).toFixed(2)}%`,
          status: devBps > threshBps ? "⚠️ OUT" : "✓ IN",
          pending: st.hasPendingReposition ? "YES" : "NO"
        });
      }
      console.table(out);
      return out;
    }

    // Helper to print positions
    async function readPositions(ids) {
      const out = [];
      for (const id of ids) {
        const p = await positionManager.positions(id);
        const levelNames = ["L1", "L5", "L10", "L20"];
        out.push({
          posId: id.toString(),
          level: levelNames[Number(p.level.toString())],
          tokenId: p.tokenId.toString(),
          tickLower: Number(p.tickLower.toString()),
          tickUpper: Number(p.tickUpper.toString()),
          width: Number(p.tickUpper.toString()) - Number(p.tickLower.toString()),
          liquidity: ethers.formatUnits(p.liquidity.toString(), 0)
        });
      }
      console.table(out);
      return out;
    }

    console.log('\n' + '='.repeat(80));
    console.log('📸 SNAPSHOT: BEFORE PRICE CHANGE');
    console.log('='.repeat(80));
    
    console.log('\n📊 Level States:');
    await readLevels();
    
    console.log('\n📍 Position Details:');
    await readPositions(posIds);

    // Create price increase event
    const levelsNow = await index.getAllLevels(poolId);
    const currentPNow = BigInt(levelsNow[1][0].toString());
    
    const priceIncrease = 15n; // 15%
    const exactTargetPrice = (currentPNow * (100n + priceIncrease)) / 100n;

    console.log('\n' + '='.repeat(80));
    console.log(`🔥 PRICE EVENT: +${priceIncrease}% INCREASE`);
    console.log('='.repeat(80));
    console.log(`Current price: ${ethers.formatEther(currentPNow.toString())} ETH per LINK`);
    console.log(`Target price: ${ethers.formatEther(exactTargetPrice.toString())} ETH per LINK`);

    // Push multiple samples to establish new TWAP
    console.log('\n📊 Pushing multiple samples to establish new TWAP...');
    for (let i = 0; i < 10; i++) {
      await index.connect(updater).pushSample(poolId, exactTargetPrice);
      await ethers.provider.send("evm_increaseTime", [300]);
      await ethers.provider.send("evm_mine");
    }

    await index.connect(updater).processPool(poolId);
    
    console.log('\n📊 Level States After Price Push:');
    await readLevels();

    // 🤖 AI-DRIVEN REBALANCING
    console.log('\n' + '='.repeat(80));
    console.log('🤖 AI-DRIVEN REBALANCING DECISIONS');
    console.log('='.repeat(80));
    
    const aiResults = [];
    for (const id of posIds) {
      const before = await positionManager.positions(id);
      const levelNames = ["L1 (1%)", "L5 (5%)", "L10 (10%)", "L20 (20%)"];
      
      console.log(`\n🔍 Analyzing position ${id.toString()} [${levelNames[Number(before.level.toString())]}]...`);
      
      // Consult AI Engine
      const aiAnalysis = await shouldRebalanceWithAI(poolId, id);
      
      if (aiAnalysis.shouldExecute) {
        console.log(`🔄 AI recommends REBALANCE - Executing syncPosition...`);
        
        const tx = await positionManager.connect(updater).syncPosition(id);
        const rcpt = await tx.wait();
        
        const after = await positionManager.positions(id);
        const tickShift = Number(after.tickLower.toString()) - Number(before.tickLower.toString());
        
        aiResults.push({
          posId: id.toString(),
          level: levelNames[Number(before.level.toString())],
          aiAction: aiAnalysis.decision.action,
          aiConfidence: (aiAnalysis.decision.confidence * 100).toFixed(1) + '%',
          aiReward: aiAnalysis.decision.expected_reward.toFixed(6),
          aiRisk: aiAnalysis.decision.risk_level,
          executed: true,
          tickShift: tickShift,
          gasUsed: rcpt.gasUsed.toString(),
          reason: aiAnalysis.decision.reason
        });
        
        console.log(`   ✅ Executed - Ticks shifted: ${tickShift > 0 ? '+' : ''}${tickShift}`);
        console.log(`   ⛽ Gas used: ${rcpt.gasUsed.toString()}`);
      } else {
        console.log(`⏸️  AI recommends HOLD - No action taken`);
        
        aiResults.push({
          posId: id.toString(),
          level: levelNames[Number(before.level.toString())],
          aiAction: aiAnalysis.decision.action,
          aiConfidence: (aiAnalysis.decision.confidence * 100).toFixed(1) + '%',
          aiReward: aiAnalysis.decision.expected_reward.toFixed(6),
          aiRisk: aiAnalysis.decision.risk_level,
          executed: false,
          tickShift: 0,
          gasUsed: 'N/A',
          reason: aiAnalysis.decision.reason
        });
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 AI REBALANCING RESULTS SUMMARY');
    console.log('='.repeat(80));
    console.table(aiResults);

    // AI Statistics
    const executedCount = aiResults.filter(r => r.executed).length;
    const holdCount = aiResults.filter(r => !r.executed).length;
    const avgConfidence = aiResults.reduce((sum, r) => sum + parseFloat(r.aiConfidence), 0) / aiResults.length;
    
    console.log(`\n📈 AI DECISION STATISTICS:`);
    console.log(`   Total Positions: ${aiResults.length}`);
    console.log(`   Rebalanced: ${executedCount}`);
    console.log(`   Held: ${holdCount}`);
    console.log(`   Rebalance Rate: ${((executedCount / aiResults.length) * 100).toFixed(1)}%`);
    console.log(`   Average Confidence: ${avgConfidence.toFixed(1)}%`);
    console.log(`   AI Engine: ${AI_ENABLED ? '✅ ENABLED' : '❌ DISABLED'}`);

    // Show final states
    console.log('\n📊 Final Level States:');
    await readLevels();

    console.log('\n📍 Final Position Details:');
    await readPositions(posIds);

    // Validations
    console.log('\n' + '='.repeat(80));
    console.log('✅ VALIDATIONS');
    console.log('='.repeat(80));
    
    for (const result of aiResults) {
      if (result.executed) {
        const position = await positionManager.positions(result.posId);
        expect(Number(position.tickLower.toString())).to.be.at.least(-887272, `Position ${result.posId} tickLower out of range`);
        expect(Number(position.tickUpper.toString())).to.be.at.most(887272, `Position ${result.posId} tickUpper out of range`);
        expect(Number(position.tickUpper.toString()) - Number(position.tickLower.toString())).to.be.greaterThan(0, `Position ${result.posId} has invalid width`);
        console.log(`✓ Position ${result.posId} (${result.level}): Valid after AI rebalancing`);
      } else {
        console.log(`✓ Position ${result.posId} (${result.level}): AI decided to hold`);
      }
    }

    // Print AI Insights
    console.log('\n' + '='.repeat(80));
    console.log('💡 AI INSIGHTS');
    console.log('='.repeat(80));
    
    const rebalancedResults = aiResults.filter(r => r.executed);
    if (rebalancedResults.length > 0) {
      const avgTickShift = rebalancedResults.reduce((sum, r) => sum + r.tickShift, 0) / rebalancedResults.length;
      console.log(`Average tick shift for rebalanced positions: ${avgTickShift.toFixed(0)} ticks`);
      
      rebalancedResults.forEach(r => {
        console.log(`  - ${r.level}: ${r.tickShift > 0 ? '+' : ''}${r.tickShift} ticks (confidence: ${r.aiConfidence})`);
      });
    }
    
    const holdResults = aiResults.filter(r => !r.executed);
    if (holdResults.length > 0) {
      console.log(`\nPositions held by AI:`);
      holdResults.forEach(r => {
        console.log(`  - ${r.level}: ${r.reason} (confidence: ${r.aiConfidence})`);
      });
    }
  });

  it("tests AI behavior with -12% price decrease", async function () {
    // Amounts
    const amount0 = ethers.parseEther("500"); // 500 LINK
    const amount1 = ethers.parseEther("2");    // 2 WETH

    console.log("\n🔷 Opening fresh position at L5 for price decrease test...");
    
    // Fund and open one position
    await link.connect(whaleLink).transfer(user.address, amount0);
    await weth.connect(whaleWeth).transfer(user.address, amount1);
    await link.connect(user).approve(await positionManager.getAddress(), amount0);
    await weth.connect(user).approve(await positionManager.getAddress(), amount1);
    
    const tx = await positionManager.connect(user).openPosition(
      poolId, 1, LINK_ADDRESS, WETH_ADDRESS, 3000, 
      amount0, amount1, 0, 0, await getDeadline()
    );
    
    const rcpt = await tx.wait();
    const log = parseOpenPositionEvent(rcpt, positionManager.interface, await positionManager.getAddress());
    const posId = log.args.id;
    
    console.log(`✓ Opened position ${posId.toString()} at L5 (5%)`);

    // <-- FIX: store actual amounts used for this position so marketState can compute positionValue
    posAmounts[posId.toString()] = { amount0, amount1 };


    // Get current state
    const before = await positionManager.positions(posId);
    const levels = await index.getAllLevels(poolId);
    const currentPNow = levels[1][1]; // p_now for L5
    
    console.log('\n📊 Before state:');
    console.log(`  Price (p_now for L5): ${ethers.formatEther(currentPNow.toString())} ETH per LINK`);
    console.log(`  Tick range: [${before.tickLower.toString()}, ${before.tickUpper.toString()}]`);

    // Create price DECREASE event
    const priceDecrease = 12n; // 12%
    const newPrice = (BigInt(currentPNow.toString()) * 88n) / 100n; // -12%
    
    console.log('\n' + '='.repeat(80));
    console.log('🔥 PRICE EVENT: -12% DECREASE');
    console.log('='.repeat(80));
    console.log(`  Current price: ${ethers.formatEther(currentPNow.toString())} ETH per LINK`);
    console.log(`  Target price: ${ethers.formatEther(newPrice.toString())} ETH per LINK`);
    
    // Push multiple samples to ensure TWAP updates
    console.log('\n📊 Updating TWAP with price decrease...');
    for (let i = 0; i < 10; i++) {
      await index.connect(updater).pushSample(poolId, newPrice);
      await ethers.provider.send("evm_increaseTime", [300]);
      await ethers.provider.send("evm_mine");
    }
    
    await index.connect(updater).processPool(poolId);
    
    // 🤖 AI Decision for Price Decrease
    console.log('\n' + '='.repeat(80));
    console.log('🤖 AI ANALYSIS FOR PRICE DECREASE');
    console.log('='.repeat(80));
    
    const aiAnalysis = await shouldRebalanceWithAI(poolId, posId);
    
    if (aiAnalysis.shouldExecute) {
      console.log(`🔄 AI recommends REBALANCE for price decrease scenario`);
      console.log(`   Reason: ${aiAnalysis.decision.reason}`);
      
      const syncTx = await positionManager.connect(updater).syncPosition(posId);
      const syncRcpt = await syncTx.wait();
      
      const after = await positionManager.positions(posId);
      
      console.log('\n📊 After AI-driven rebalancing:');
      console.log(`  Old tick range: [${before.tickLower.toString()}, ${before.tickUpper.toString()}]`);
      console.log(`  New tick range: [${after.tickLower.toString()}, ${after.tickUpper.toString()}]`);
      console.log(`  Tick shift: ${Number(after.tickLower.toString()) - Number(before.tickLower.toString())}`);
      console.log(`  Gas used: ${syncRcpt.gasUsed.toString()}`);
      
      // Validate the direction makes sense for price decrease
      if (Number(after.tickLower.toString()) !== Number(before.tickLower.toString())) {
        expect(Number(after.tickLower.toString())).to.be.lessThan(Number(before.tickLower.toString()),
          "With price decrease, ticks should shift downward");
        console.log("✅ AI correctly shifted ticks downward for price decrease");
      }
    } else {
      console.log(`⏸️  AI recommends HOLDING despite price decrease`);
      console.log(`   Reason: ${aiAnalysis.decision.reason}`);
      console.log(`   Confidence: ${(aiAnalysis.decision.confidence * 100).toFixed(1)}%`);
      console.log(`   Risk Level: ${aiAnalysis.decision.risk_level}`);
      
      // This could be valid if AI considers other factors like gas costs, volatility, etc.
      console.log("ℹ️  AI may be considering factors beyond simple price deviation");
    }

    // Show final level states
    console.log('\n📊 Final Level States:');
    const levelsAfter = await index.getAllLevels(poolId);
    const deviations = levelsAfter[2];
    const thresholds = levelsAfter[4];
    
    console.log(`  L5 Deviation: ${(Number(deviations[1].toString()) / 100).toFixed(2)}%`);
    console.log(`  L5 Threshold: ${(Number(thresholds[1].toString()) / 100).toFixed(2)}%`);
    console.log(`  Out of bounds: ${Number(deviations[1].toString()) > Number(thresholds[1].toString()) ? 'YES' : 'NO'}`);
  });



it("compares AI vs rule-based decisions - FULLY FIXED", async function () {
    console.log("\n" + "=".repeat(80));
    console.log("🔬 COMPARISON: AI vs RULE-BASED DECISIONS");
    console.log("=".repeat(80));

    const scenarios = [
        { name: "Small Deviation (+3%)", change: 3 },
        { name: "Medium Deviation (+8%)", change: 8 },
        { name: "Large Deviation (+18%)", change: 18 },
        { name: "Small Decrease (-4%)", change: -4 },
        { name: "Large Decrease (-15%)", change: -15 }
    ];

    const comparisonResults = [];

    for (const scenario of scenarios) {
        console.log(`\n🧪 Testing: ${scenario.name}`);
        
      
        const scenarioPoolId = ethers.keccak256(
            ethers.toUtf8Bytes(`LINK_WETH_SCENARIO_${scenario.name}`)
        );
        
        const basePrice = ethers.parseEther("0.00439835");
        
        await index.registerPool(
            scenarioPoolId,
            LINK_WETH_POOL,
            18, 18,
            false,
            basePrice,  // ✅ p_ref = basePrice
            1800,
            10
        );

      
        for (let i = 0; i < 10; i++) {
            await index.connect(updater).pushSample(scenarioPoolId, basePrice);
            await ethers.provider.send("evm_increaseTime", [180]);
            await ethers.provider.send("evm_mine");
        }

        const changeBig = BigInt(Math.abs(scenario.change));
        let newPrice;
        
        if (scenario.change > 0) {
            newPrice = (basePrice * (100n + changeBig)) / 100n;
        } else {
            newPrice = (basePrice * (100n - changeBig)) / 100n;
        }

      
        for (let i = 0; i < 15; i++) {
            await index.connect(updater).pushSample(scenarioPoolId, newPrice);
            await ethers.provider.send("evm_increaseTime", [180]);
            await ethers.provider.send("evm_mine");
        }

        await index.connect(updater).processPool(scenarioPoolId);

      
        const expectedDeviation = Math.abs(scenario.change);
        
        // Get actual deviation from contract
        const levels = await index.getAllLevels(scenarioPoolId);
        const deviation = Number(levels[2][1].toString()) / 100; // to percentage
        const threshold = Number(levels[4][1].toString()) / 100;
        
        console.log(`   Expected Deviation: ${expectedDeviation.toFixed(2)}%`);
        console.log(`   Actual Deviation: ${deviation.toFixed(2)}%`);
        console.log(`   Deviation Error: ${Math.abs(deviation - expectedDeviation).toFixed(2)}%`);
        
      
        const amount0 = ethers.parseEther("100");
        const amount1 = ethers.parseEther("0.4");
        
        await link.connect(whaleLink).transfer(user.address, amount0);
        await weth.connect(whaleWeth).transfer(user.address, amount1);
        await link.connect(user).approve(await positionManager.getAddress(), amount0);
        await weth.connect(user).approve(await positionManager.getAddress(), amount1);
        
        const tx = await positionManager.connect(user).openPosition(
            scenarioPoolId, 1, LINK_ADDRESS, WETH_ADDRESS, 3000,
            amount0, amount1, 0, 0, await getDeadline()
        );
        
        const rcpt = await tx.wait();
        const log = parseOpenPositionEvent(
            rcpt, 
            positionManager.interface, 
            await positionManager.getAddress()
        );
        const posId = log.args.id;
        
        // Store amounts for AI
        posAmounts[posId.toString()] = { amount0, amount1 };

        // Get decisions
        const ruleBasedDecision = deviation > threshold ? "REBALANCE" : "HOLD";
        const aiAnalysis = await shouldRebalanceWithAI(scenarioPoolId, posId);
        const aiDecision = aiAnalysis.shouldExecute ? "REBALANCE" : "HOLD";

        comparisonResults.push({
            scenario: scenario.name,
            priceChange: `${scenario.change}%`,
            expectedDev: `${expectedDeviation.toFixed(2)}%`,
            actualDev: `${deviation.toFixed(2)}%`,
            devError: `${Math.abs(deviation - expectedDeviation).toFixed(2)}%`,
            threshold: `${threshold.toFixed(2)}%`,
            ruleBased: ruleBasedDecision,
            aiDecision: aiDecision,
            aiConfidence: `${(aiAnalysis.decision.confidence * 100).toFixed(1)}%`,
            match: ruleBasedDecision === aiDecision ? "✅" : "❌"
        });
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 DECISION COMPARISON RESULTS - FULLY FIXED');
    console.log('='.repeat(80));
    console.table(comparisonResults);
});
});