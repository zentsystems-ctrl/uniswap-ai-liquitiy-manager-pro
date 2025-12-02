// src/config.js
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

// Load .env from project root
const envPath = path.join(__dirname, '..', '.env');
console.log(`Loading .env from: ${envPath}`);

if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log('✅ .env file loaded');
} else {
    console.error('❌ .env file not found at:', envPath);
    process.exit(1);
}

// Helper function
function parsePoolIds(raw) {
    if (!raw) return [];
    
    try {
        const s = String(raw).trim();
        if (s.startsWith("[")) {
            const arr = JSON.parse(s);
            if (!Array.isArray(arr)) throw new Error("not array");
            return arr;
        } else {
            return s.split(",").map(x => x.trim()).filter(x => x !== "");
        }
    } catch (e) {
        console.warn("WARNING: POOL_IDS parse error:", e.message);
        return [];
    }
}

function isValidAddress(address) {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// ✅ Configuration object
const config = {
    rpc: process.env.RPC_URL || process.env.RPC || "http://127.0.0.1:8545",
    privateKey: process.env.PRIVATE_KEY || null,
    
    indexAddress: process.env.INDEX_ADDRESS || null,
    pmAddress: process.env.PM_ADDRESS || null,
    positionManagerAddress: process.env.PM_ADDRESS || null, // Alias
    
    poolIds: parsePoolIds(process.env.POOL_IDS),
    maxSyncPerRun: parseInt(process.env.MAX_SYNC_PER_RUN || "10", 10),
    gasLimitDefault: parseInt(process.env.GAS_LIMIT_DEFAULT || "600000", 10),
    
    logLevel: process.env.LOG_LEVEL || "info",
    logToFile: process.env.LOG_TO_FILE === "true",
    logFilePath: process.env.LOG_FILE_PATH || "./logs/offchain.log",
    
    enableMetrics: process.env.ENABLE_METRICS === "true",
    metricsPort: parseInt(process.env.METRICS_PORT || "9090", 10),
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "60000", 10)
};

// ✅ Validation
const errors = [];
const warnings = [];

if (!config.rpc) {
    errors.push('❌ RPC_URL is required');
}

if (!config.privateKey) {
    errors.push('❌ PRIVATE_KEY is required');
}

if (!config.indexAddress) {
    errors.push('❌ INDEX_ADDRESS is required');
} else if (!isValidAddress(config.indexAddress)) {
    errors.push('❌ INDEX_ADDRESS is not a valid Ethereum address');
}

if (!config.pmAddress) {
    errors.push('❌ PM_ADDRESS is required');
} else if (!isValidAddress(config.pmAddress)) {
    errors.push('❌ PM_ADDRESS is not a valid Ethereum address');
}

if (!config.poolIds || config.poolIds.length === 0) {
    errors.push('❌ POOL_IDS is required');
}

// Print validation results
if (warnings.length > 0) {
    console.warn('\n⚠️  Configuration Warnings:');
    warnings.forEach(w => console.warn(w));
}

if (errors.length > 0) {
    console.error('\n❌ Configuration Errors:');
    errors.forEach(e => console.error(e));
    console.error('\n💡 Please check your .env file and fix the errors above.\n');
    process.exit(1);
}

console.log('✅ Configuration validated successfully');
console.log(`📊 Monitoring ${config.poolIds.length} pool(s)`);

// Debug output
console.log('\n📋 Configuration:');
console.log(`   RPC: ${config.rpc}`);
console.log(`   Index: ${config.indexAddress}`);
console.log(`   PM: ${config.pmAddress}`);
console.log(`   Pools: ${config.poolIds.length}`);
console.log('');

module.exports = { config };
