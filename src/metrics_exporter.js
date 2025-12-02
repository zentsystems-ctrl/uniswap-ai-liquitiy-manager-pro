// Prometheus metrics exporter for DeFi Agent
const prometheus = require('prom-client');
const express = require('express');

// Create registry
const register = new prometheus.Registry();

// Add default metrics (CPU, memory, etc.)
prometheus.collectDefaultMetrics({ register });

// Custom metrics
const totalPositions = new prometheus.Gauge({
    name: 'defi_total_positions',
    help: 'Total active positions',
    registers: [register]
});

const tvl = new prometheus.Gauge({
    name: 'defi_tvl_eth',
    help: 'Total value locked in ETH',
    registers: [register]
});

const profitLoss = new prometheus.Gauge({
    name: 'defi_profit_loss_eth',
    help: 'Profit/Loss in ETH',
    labelNames: ['period'],
    registers: [register]
});

const gasCosts = new prometheus.Counter({
    name: 'defi_gas_costs_eth',
    help: 'Cumulative gas costs in ETH',
    registers: [register]
});

const mlConfidence = new prometheus.Histogram({
    name: 'defi_ml_confidence',
    help: 'ML decision confidence',
    buckets: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95],
    registers: [register]
});

const decisionLatency = new prometheus.Histogram({
    name: 'defi_decision_latency_ms',
    help: 'Decision latency in milliseconds',
    buckets: [10, 50, 100, 500, 1000, 5000],
    registers: [register]
});

const actionsCounter = new prometheus.Counter({
    name: 'defi_actions_total',
    help: 'Total actions taken',
    labelNames: ['action', 'status'],
    registers: [register]
});

const gasPriceGauge = new prometheus.Gauge({
    name: 'defi_gas_price_gwei',
    help: 'Current gas price in gwei',
    registers: [register]
});

// Export metrics
module.exports = {
    register,
    totalPositions,
    tvl,
    profitLoss,
    gasCosts,
    mlConfidence,
    decisionLatency,
    actionsCounter,
    gasPriceGauge,
    
    // Start metrics server
    startServer: (port = 9090) => {
        const app = express();
        
        app.get('/metrics', async (req, res) => {
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());
        });
        
        app.listen(port, () => {
            console.log(`📊 Metrics server running on :${port}`);
        });
    }
};
