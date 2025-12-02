# 🚀 Quick Start Guide

Get up and running with the Uniswap V3 AI Manager in under 10 minutes!

## Prerequisites Checklist

- [ ] Node.js 18+ installed
- [ ] Python 3.9+ installed
- [ ] Git installed
- [ ] Ethereum RPC endpoint (Infura/Alchemy)
- [ ] Wallet with some ETH for gas

## Installation (5 minutes)

### 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/yourusername/uniswap-v3-ai-manager.git
cd uniswap-v3-ai-manager

# Install Node.js dependencies
npm install

# Install Python dependencies
pip install -r requirements_ai.txt
```

### 2. Configure Environment

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your configuration
nano .env  # or use your preferred editor
```

**Minimum required configuration:**

```bash
# .env
RPC_URL=https://mainnet.infura.io/v3/YOUR_API_KEY
PRIVATE_KEY=your_private_key_without_0x
INDEX_ADDRESS=0xYourIndexContractAddress
PM_ADDRESS=0xYourPositionManagerAddress
POOL_IDS=0xYourPoolId

# Start in shadow mode for testing
SHADOW_MODE=true
```

### 3. Generate Training Data

```bash
# Generate 5000 synthetic samples
python training-data-gen.py --samples 5000
```

### 4. Train Initial Model

```bash
# Train the ML model
python -c "from ai_engine import train_model; train_model('./data/training_log.ndjson', './data/models/model.joblib')"
```

## Running the System (2 minutes)

### Option A: Shadow Mode (Recommended for First Run)

Shadow mode simulates decisions without executing transactions:

```bash
# Terminal 1: Start AI Service
python api.py

# Terminal 2: Start Agent in Shadow Mode
SHADOW_MODE=true node src/offchain.js
```

### Option B: Production Mode

⚠️ **Warning**: This will execute real transactions with real money!

```bash
# Terminal 1: Start AI Service
python api.py

# Terminal 2: Start Agent in Production Mode
SHADOW_MODE=false node src/offchain.js
```

## Verification (1 minute)

### Check AI Service Health

```bash
curl http://localhost:8000/health
```

Expected output:
```json
{
  "status": "healthy",
  "has_ml_model": true,
  "engine_initialized": true
}
```

### Check Agent Logs

Look for these log messages:

```
✅ Network: mainnet (Chain ID: 1)
✅ Wallet: 0x...
✅ AI service is healthy
✅ INITIALIZATION COMPLETE
```

### View Shadow Mode Decisions

```bash
tail -f ./data/shadow_log.ndjson | jq .
```

## Quick Commands

### Start/Stop Services

```bash
# Start AI service
python api.py

# Start agent
node src/offchain.js

# Stop (Ctrl+C in each terminal)
```

### View Performance

```bash
# Real-time stats
python performance_dashboard.py

# Export report
python performance_dashboard.py --export
```

### Retrain Model

```bash
# Manual retrain
python auto_retrain.py --force

# View model status
python auto_retrain.py --status
```

## Testing Your Setup

### 1. Run Unit Tests

```bash
# Smart contract tests
npm test

# AI engine tests
pytest test_ai_engine.py -v
```

### 2. Run Backtest

```bash
# Simulate 30 days of trading
python backtest_fixed.py
```

This will generate `backtest_results.png` showing performance.

### 3. Test AI Decisions

```bash
# Make a test decision
curl -X POST http://localhost:8000/decide \
  -H "Content-Type: application/json" \
  -d @test/sample_state.json
```

## Common Issues

### Issue: "AI service unhealthy"

**Solution:**
```bash
# Check if service is running
curl http://localhost:8000/health

# Restart service
pkill -f api.py
python api.py
```

### Issue: "Model not found"

**Solution:**
```bash
# Regenerate training data and train model
python training-data-gen.py --samples 5000
python -c "from ai_engine import train_model; train_model('./data/training_log.ndjson', './data/models/model.joblib')"
```

### Issue: "RPC connection failed"

**Solution:**
```bash
# Verify RPC URL
curl -X POST $RPC_URL \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'

# Try alternative RPC
export RPC_URL=https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY
```

### Issue: "Gas price too high"

**Solution:**
```bash
# Increase gas threshold
export MAX_GAS_GWEI=150

# Or wait for lower gas
# Check: https://etherscan.io/gastracker
```

## Next Steps

### 1. Production Deployment

Once comfortable with shadow mode:

1. Set `SHADOW_MODE=false` in `.env`
2. Fund your wallet with ETH for gas
3. Set appropriate gas limits
4. Enable monitoring (see below)

### 2. Setup Monitoring

```bash
# Install monitoring stack
chmod +x advanced_monitoring_implementation.sh
./advanced_monitoring_implementation.sh

# Start monitoring
cd monitoring
./start-monitoring.sh

# Access dashboards
open http://localhost:3000  # Grafana (admin/admin)
```

### 3. Configure Alerts

Edit `monitoring/alertmanager/alertmanager.yml` to add:
- Telegram notifications
- Email alerts
- Slack webhooks

### 4. Optimize Performance

```bash
# Adjust rebalancing frequency
export MIN_REBALANCE_INTERVAL_HOURS=12

# Adjust loop interval
export INTERVAL_MS=120000  # 2 minutes

# Enable auto-retraining
python auto_retrain.py  # runs continuously
```

## Understanding the Output

### Agent Logs

```
🔍 PROCESSING POSITION 1
═══════════════════════════════════════
📊 Collecting market state...
   Reposition context: deviation=3.2%, threshold=5.0%
   Out of bounds: ✅ NO
✅ Market state collected

🧠 Requesting AI decision...

✅ AI Decision:
   Action: HOLD
   Confidence: 75.3%
   Risk: LOW
   Reason: within_bounds
   Expected Reward: 0.002 ETH

⏸️ Decision: HOLD - No action needed
```

### Shadow Mode Logs

Shadow mode logs all decisions to `./data/shadow_log.ndjson`:

```json
{
  "timestamp": 1699564800000,
  "state": { ... },
  "decision": {
    "action": "hold",
    "confidence": 0.753,
    "reason": "within_bounds"
  },
  "metadata": {
    "shadow_mode": true,
    "would_execute": false
  }
}
```

## Performance Metrics

After running for a while, check performance:

```bash
python performance_dashboard.py --section overview
```

Expected output:
```
📊 PERFORMANCE OVERVIEW
══════════════════════════════════════
📈 Execution Stats:
   Total Decisions: 150
   Successful: 142 (94.7%)
   Profitable: 95 (63.3%)

💰 Financial Performance:
   Total Profit: 0.452 ETH
   Average Profit: 0.003 ETH
   Net Profit: 0.401 ETH
```

## Tips for Success

1. **Start Small**: Begin with small positions in shadow mode
2. **Monitor Closely**: Check logs frequently in first 24 hours
3. **Set Conservative Limits**: Use lower gas thresholds initially
4. **Review Decisions**: Analyze shadow mode logs before going live
5. **Enable Monitoring**: Always use Prometheus/Grafana in production
6. **Backup Keys**: Keep your private key secure and backed up
7. **Test Thoroughly**: Run backtests and check AI performance

## Getting Help

- **Documentation**: Check [README.md](README.md) and [Wiki](https://github.com/yourusername/uniswap-v3-ai-manager/wiki)
- **Issues**: [GitHub Issues](https://github.com/yourusername/uniswap-v3-ai-manager/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/uniswap-v3-ai-manager/discussions)

## Security Reminders

🔒 **Before going to production:**

- [ ] Never commit private keys
- [ ] Use separate keys for testing and production
- [ ] Set appropriate gas limits
- [ ] Enable monitoring and alerts
- [ ] Test emergency pause functionality
- [ ] Have a plan for handling errors
- [ ] Keep your RPC endpoints secure
- [ ] Regular security audits

## What's Next?

Now that you're running, explore:

1. **Customization**: Adjust thresholds and parameters
2. **Advanced Features**: Multi-pool management, custom strategies
3. **Optimization**: Fine-tune ML models with production data
4. **Scaling**: Add more positions and pools
5. **Integration**: Connect to your own systems

---

**Ready to dive deeper?** Check out the full [README.md](README.md) for comprehensive documentation!

**Questions?** Open an issue or start a discussion on GitHub!

🚀 **Happy Trading!**
