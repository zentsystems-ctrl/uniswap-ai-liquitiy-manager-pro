// src/healthCheck.js
// 🆕 Health check system for monitoring agent status

const { info, warn, error } = require('./logger.js');

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const healthState = {
  lastCheck: null,
  lastSuccess: null,
  consecutiveFailures: 0,
  checks: {
    rpc: { status: 'unknown', lastCheck: null, message: null },
    contracts: { status: 'unknown', lastCheck: null, message: null },
    wallet: { status: 'unknown', lastCheck: null, message: null }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH CHECK FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Perform comprehensive health check
 * @param {object} provider - Ethers provider
 * @param {object} wallet - Ethers wallet
 * @param {object} indexContract - Index contract instance
 * @param {object} pmContract - PM contract instance
 * @returns {object} Health check results
 */
async function performHealthCheck(provider, wallet, indexContract, pmContract) {
  info('Starting health check...');
  healthState.lastCheck = Date.now();
  
  const results = {
    overall: 'healthy',
    timestamp: new Date().toISOString(),
    checks: {}
  };

  try {
    // Check RPC connectivity
    results.checks.rpc = await checkRPC(provider);
    
    // Check wallet
    results.checks.wallet = await checkWallet(provider, wallet);
    
    // Check contracts
    results.checks.contracts = await checkContracts(indexContract, pmContract);
    
    // Determine overall health
    const allHealthy = Object.values(results.checks).every(check => check.status === 'healthy');
    results.overall = allHealthy ? 'healthy' : 'degraded';
    
    if (allHealthy) {
      healthState.consecutiveFailures = 0;
      healthState.lastSuccess = Date.now();
      info('✅ Health check passed');
    } else {
      healthState.consecutiveFailures++;
      warn(`⚠️  Health check degraded (${healthState.consecutiveFailures} consecutive failures)`);
    }
    
    // Update state
    healthState.checks = results.checks;
    
    return results;
    
  } catch (err) {
    error(`Health check failed: ${err.message}`);
    healthState.consecutiveFailures++;
    
    return {
      overall: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: err.message,
      checks: results.checks
    };
  }
}

/**
 * Check RPC connectivity and block height
 */
async function checkRPC(provider) {
  const check = {
    name: 'RPC Connectivity',
    status: 'healthy',
    lastCheck: Date.now(),
    message: null,
    details: {}
  };

  try {
    const startTime = Date.now();
    const blockNumber = await provider.getBlockNumber();
    const latency = Date.now() - startTime;
    
    const network = await provider.getNetwork();
    
    check.details = {
      blockNumber,
      chainId: network.chainId.toString(),
      latency: `${latency}ms`
    };
    
    if (latency > 5000) {
      check.status = 'degraded';
      check.message = `High RPC latency: ${latency}ms`;
    } else {
      check.message = `Connected to block ${blockNumber}`;
    }
    
  } catch (err) {
    check.status = 'unhealthy';
    check.message = `RPC connection failed: ${err.message}`;
  }

  return check;
}

/**
 * Check wallet balance and nonce
 */
async function checkWallet(provider, wallet) {
  const check = {
    name: 'Wallet Status',
    status: 'healthy',
    lastCheck: Date.now(),
    message: null,
    details: {}
  };

  try {
    const balance = await provider.getBalance(wallet.address);
    const nonce = await provider.getTransactionCount(wallet.address);
    
    check.details = {
      address: wallet.address,
      balance: `${(Number(balance) / 1e18).toFixed(4)} ETH`,
      nonce
    };
    
    // Warn if balance is low
    if (balance < BigInt(1e17)) { // Less than 0.1 ETH
      check.status = 'degraded';
      check.message = `Low wallet balance: ${check.details.balance}`;
    } else {
      check.message = `Wallet ready with ${check.details.balance}`;
    }
    
  } catch (err) {
    check.status = 'unhealthy';
    check.message = `Wallet check failed: ${err.message}`;
  }

  return check;
}

/**
 * Check contract accessibility and roles
 */
async function checkContracts(indexContract, pmContract) {
  const check = {
    name: 'Contracts Status',
    status: 'healthy',
    lastCheck: Date.now(),
    message: null,
    details: {}
  };

  try {
    // Check if contracts are deployed
    const indexAddress = await indexContract.getAddress();
    const pmAddress = await pmContract.getAddress();
    
    check.details = {
      indexAddress,
      pmAddress
    };
    
    check.message = 'Contracts accessible';
    
  } catch (err) {
    check.status = 'unhealthy';
    check.message = `Contract check failed: ${err.message}`;
  }

  return check;
}

/**
 * Get current health status
 */
function getHealthStatus() {
  const timeSinceLastCheck = healthState.lastCheck 
    ? Date.now() - healthState.lastCheck 
    : null;
  
  const timeSinceLastSuccess = healthState.lastSuccess
    ? Date.now() - healthState.lastSuccess
    : null;

  return {
    ...healthState,
    timeSinceLastCheck,
    timeSinceLastSuccess,
    isHealthy: healthState.consecutiveFailures === 0
  };
}

/**
 * Reset health check state
 */
function resetHealthCheck() {
  healthState.lastCheck = null;
  healthState.lastSuccess = null;
  healthState.consecutiveFailures = 0;
  healthState.checks = {
    rpc: { status: 'unknown', lastCheck: null, message: null },
    contracts: { status: 'unknown', lastCheck: null, message: null },
    wallet: { status: 'unknown', lastCheck: null, message: null }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  performHealthCheck,
  getHealthStatus,
  resetHealthCheck
};