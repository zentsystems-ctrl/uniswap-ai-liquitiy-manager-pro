# 🤖 AI-Powered Uniswap V3 Liquidity Manager

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Solidity](https://img.shields.io/badge/Solidity-0.8.20-orange.svg)
![Python](https://img.shields.io/badge/Python-3.9+-green.svg)
![Node.js](https://img.shields.io/badge/Node.js-18+-brightgreen.svg)

An intelligent, production-ready system for automated Uniswap V3 liquidity management using machine learning and rebalancing strategies.

## 🌟 Features

### Smart Contract Layer
- **Percentage-Based Rebalancing**: Dynamic tick ranges based on deviation thresholds (1%, 5%, 10%, 20%)
- **Multi-Level Position Management**: Four configurable risk levels (L1, L5, L10, L20)
- **TWAP Integration**: Built-in Time-Weighted Average Price calculations
- **Gas Optimization**: Efficient rebalancing with minimal transaction costs
- **Emergency Controls**: Pause functionality and role-based access control

### AI Decision Engine
- **ML Ensemble**: RandomForest, GradientBoosting, and XGBoost models
- **20+ Features**: Price deviation, volatility, IL factor, gas costs, and more
- **Risk Management**: Multi-factor risk assessment with dynamic thresholds
- **Reward Calculation**: Accurate Uniswap V3 fee estimation and IL calculations
- **Auto-Retraining**: Continuous learning from production data

### Monitoring & Analytics
- **Prometheus Metrics**: Real-time performance tracking
- **Grafana Dashboards**: Comprehensive visualization
- **Alert System**: Telegram notifications for critical events
- **Result Tracking**: Detailed logging of all decisions and outcomes

## 📋 Table of Contents

- [Architecture](#-architecture)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [Development](#-development)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Monitoring](#-monitoring)
- [API Documentation](#-api-documentation)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Blockchain Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │    Index     │  │   Position   │  │   Uniswap    │      │
│  │   Contract   │◄─┤   Manager    │◄─┤   V3 Pool    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                    Offchain Agent                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Market     │  │      AI      │  │    Result    │      │
│  │   Monitor    │─►│    Engine    │─►│   Tracker    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │
┌───────────────────────────┼─────────────────────────────────┐
│                       ML Layer                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Training   │  │     Model    │  │     Auto     │      │
│  │  Data Gen    │─►│   Ensemble   │◄─┤   Retrain    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

1. **Smart Contracts** (`contracts/`)
   - `Index.sol`: Manages price tracking and rebalancing logic
   - `PositionManager.sol`: Handles Uniswap V3 position operations

2. **Offchain Agent** (`src/`)
   - `offchain.js`: Main orchestration loop
   - `ai_client.js`: AI service integration with circuit breaker
   - `result_tracker.js`: Accurate reward calculations

3. **AI Engine** (`ai_engine.py`)
   - Feature engineering (20 features)
   - Model ensemble (RF, GBM, XGBoost)
   - Risk management
   - Auto-retraining pipeline

4. **Monitoring** (`monitoring/`)
   - Prometheus metrics collection
   - Grafana dashboards
   - AlertManager configuration

## 🔧 Prerequisites

### System Requirements
- **OS**: Linux (Ubuntu 20.04+) or macOS
- **RAM**: 8GB minimum, 16GB recommended
- **Storage**: 20GB free space
- **Network**: Reliable Ethereum RPC endpoint

### Software Dependencies
- **Node.js**: 18.x or higher
- **Python**: 3.9 or higher
- **Docker**: 20.10+ (for monitoring)
- **Docker Compose**: 2.0+

### Blockchain Access
- Ethereum mainnet RPC URL (Infura, Alchemy, or local node)
- Private key with ETH for gas fees
- Access to Uniswap V3 NonfungiblePositionManager

## 📦 Installation

### 1. Clone Repository

```bash
git clone https://github.com/zentsystems-ctrl/uniswap-ai-liquitiy-manager-pro.git
cd uniswap-ai-liquitiy-manager-pro
```

### 2. Install Node.js Dependencies

```bash
npm install
```

### 3. Install Python Dependencies

```bash
sudo apt update
sudo apt install python3-venv
source venv/bin/activare
cd ai
pip install -r requirements_ai.txt
```

### 4. Install Monitoring Stack (Optional)

```bash
chmod +x advanced_monitoring_implementation.sh
./advanced_monitoring_implementation.sh
```

### 5. Compile Smart Contracts

```bash
npx hardhat compile
```

## ⚙️ Configuration

### 1. Environment Variables

Create a `.env` file in the project root:

```bash
# Blockchain
RPC_URL=https://mainnet.infura.io/v3/YOUR_API_KEY
PRIVATE_KEY=0x...
INDEX_ADDRESS=0x...
PM_ADDRESS=0x...
POOL_IDS=0x...

# Agent Configuration
INTERVAL_MS=60000
SHADOW_MODE=false
MAX_GAS_GWEI=100
MAX_GAS_PCT=2.5
MIN_REBALANCE_INTERVAL_HOURS=6

# AI Service
AI_URL=http://localhost:8000/decide
AI_TIMEOUT_MS=5000
MODEL_PATH=./data/models/model.joblib

# Logging
LOG_LEVEL=info
RESULTS_LOG=./data/results_log.ndjson
TRAINING_LOG=./data/training_log.ndjson
SHADOW_LOG=./data/shadow_log.ndjson

# Monitoring (Optional)
GRAFANA_PASSWORD=admin
```

### 2. Smart Contract Deployment

If deploying new contracts:

```bash
npx hardhat run scripts/deploy.js --network mainnet
```

Update `.env` with deployed addresses.

### 3. AI Model Training

Generate synthetic training data:

```bash
python training-data-gen.py --samples 5000 --output-dir ./data
```

Train the model:

```bash
python -c "from ai_engine import train_model; train_model('./data/training_log.ndjson', './data/models/model.joblib')"
```

## 🚀 Usage

### Starting the System

#### 1. Start AI Service

```bash
python api.py
```

The AI service will start on `http://localhost:8000`

#### 2. Start Offchain Agent

**Shadow Mode** (simulation without execution):
```bash
SHADOW_MODE=true node src/offchain.js
```

**Production Mode**:
```bash
node src/offchain.js
```

#### 3. Start Monitoring (Optional)

```bash
cd monitoring
./start-monitoring.sh
```

Access dashboards:
- Grafana: http://localhost:3000 (admin/admin)
- Prometheus: http://localhost:9091

### Command Line Tools

#### Check AI Service Health

```bash
curl http://localhost:8000/health
```

#### View Statistics

```bash
curl http://localhost:8000/stats
```

#### Reload ML Model

```bash
curl -X POST http://localhost:8000/reload-model
```

#### View Performance Dashboard

```bash
python performance_dashboard.py --section all
```

#### Trigger Manual Retraining

```bash
python auto_retrain.py --force
```

## 🔬 Development

### Project Structure

```
├── contracts/              # Solidity smart contracts
│   ├── Index.sol
│   ├── PositionManager.sol
│   └── libs/              # Math libraries
├── src/                   # Node.js offchain agent
│   ├── offchain.js        # Main loop
│   ├── ai_client.js       # AI integration
│   ├── result_tracker.js  # Reward tracking
│   ├── gas.js             # Gas optimization
│   └── metrics_exporter.js
├── ai_engine.py           # Python AI engine
├── api.py                 # FastAPI service
├── auto_retrain.py        # Auto-retraining
├── training-data-gen.py   # Synthetic data
├── backtest_fixed.py      # Backtesting
├── test/                  # Test files
├── monitoring/            # Monitoring stack
├── data/                  # Data directory
│   ├── models/           # Trained models
│   ├── results_log.ndjson
│   └── training_log.ndjson
└── scripts/              # Deployment scripts
```

### Running Tests

#### Smart Contract Tests

```bash
# Run all tests
npm test

# Run specific test
npx hardhat test test/Index.test.js

# Run with coverage
npx hardhat coverage
```

#### AI Engine Tests

```bash
pytest test_ai_engine.py -v --cov=ai_engine --cov-report=html
```

### Code Style

- **Solidity**: Follow [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html)
- **JavaScript**: ESLint with Airbnb config
- **Python**: PEP 8 with Black formatter

## 🧪 Testing

### Test Coverage

| Component | Coverage |
|-----------|----------|
| Smart Contracts | 00%+ |
| AI Engine | 00%+ |
| Offchain Agent | 00%+ |

### Production Checklist

- [ ] Smart contracts audited
- [ ] Environment variables configured
- [ ] ML model trained on production data
- [ ] Monitoring stack deployed
- [ ] Alert notifications configured
- [ ] Private key secured
- [ ] Gas price limits set
- [ ] Emergency pause tested

### Deployment Options

#### Option 1: Manual Deployment

1. Deploy contracts
2. Start AI service on server
3. Start offchain agent
4. Configure monitoring

#### Option 2: Docker Deployment

```bash
docker-compose -f Dockerfile.pro up -d
```

#### Option 3: Kubernetes (Advanced)

See `k8s/` directory for Kubernetes manifests.

### Security Considerations

1. **Private Key Management**: Use hardware wallet or HSM
2. **RPC Security**: Use authenticated endpoints
3. **Rate Limiting**: Implement request throttling
4. **Access Control**: Restrict admin functions
5. **Monitoring**: Set up 24/7 alerts

## 📊 Monitoring

### Key Metrics

| Metric | Description | Alert Threshold |
|--------|-------------|-----------------|
| `defi_tvl_eth` | Total value locked | - |
| `defi_profit_loss_eth` | Daily P&L | < -1 ETH |
| `defi_gas_price_gwei` | Current gas price | > 200 gwei |
| `defi_ml_confidence` | ML confidence | < 0.6 |
| `defi_actions_total` | Action counter | - |
| `defi_decision_latency_ms` | Decision time | > 5000ms |

### Grafana Dashboards

Access pre-built dashboards at http://localhost:3000:

1. **Overview**: TVL, P&L, success rate
2. **Performance**: Latency, throughput, errors
3. **ML Metrics**: Confidence, predictions, accuracy
4. **System**: CPU, memory, disk usage

### Alerting

Alerts are configured in `monitoring/prometheus/alerts.yml`:

- Agent down
- High gas prices
- Daily losses
- Low success rate
- Low ML confidence

## 📚 API Documentation

### AI Service Endpoints

#### POST `/decide`

Make a liquidity management decision.

**Request:**
```json
{
  "timestamp": 1699564800.0,
  "poolId": "0x...",
  "current_price": 2000.0,
  "price_unit": "eth",
  "twap_1h": 1998.0,
  "twap_24h": 1995.0,
  "volatility_1h": 0.15,
  "volatility_24h": 0.25,
  "pool_liquidity": 1000000.0,
  "volume_24h": 5000000.0,
  "gas_price": 50.0,
  "gas_unit": "gwei",
  "deviation_pct": 3.5,
  "threshold_pct": 5.0,
  "within_bounds": true,
  "position": {
    "id": 1,
    "owner": "0x...",
    "lowerTick": -100000,
    "upperTick": 100000,
    "liquidity": 50000,
    "token0_balance": 1000,
    "token1_balance": 1850000,
    "fees_earned_0": 10,
    "fees_earned_1": 18500,
    "age_seconds": 604800
  },
  "extra": {
    "inRange": true,
    "currentTick": -50000
  }
}
```

**Response:**
```json
{
  "action": "rebalance",
  "confidence": 0.87,
  "score": 0.045,
  "expected_reward": 0.045,
  "reason": "ml_ensemble",
  "risk_level": "medium",
  "recommended_params": {
    "new_lower_tick": -102000,
    "new_upper_tick": -98000
  },
  "metadata": {
    "risk_score": 0.42,
    "timestamp": 1699564800.0
  },
  "timestamp": 1699564800.0
}
```

#### GET `/health`

Check service health.

**Response:**
```json
{
  "status": "healthy",
  "has_ml_model": true,
  "model_path": "./data/models/model.joblib",
  "decisions_count": 1523,
  "errors_count": 12,
  "uptime_seconds": 86400,
  "engine_initialized": true
}
```

## 🐛 Troubleshooting

### Common Issues

#### Issue: AI Service Not Starting

```bash
# Check Python dependencies
pip install -r requirements_ai.txt

# Verify model file exists
ls -la ./data/models/model.joblib

# Check logs
tail -f ./logs/ai_service.log
```

#### Issue: High Gas Costs

```bash
# Increase gas threshold
export MAX_GAS_GWEI=150

# Reduce rebalancing frequency
export MIN_REBALANCE_INTERVAL_HOURS=12
```

#### Issue: Low ML Confidence

```bash
# Retrain model with more data
python auto_retrain.py --force --min-samples 100

# Check training data quality
python training-data-gen.py --validate ./data/training_log.ndjson
```

#### Issue: RPC Rate Limiting

```bash
# Use fallback RPC
export RPC_URL=https://eth-mainnet.alchemyapi.io/v2/YOUR_KEY

# Increase interval
export INTERVAL_MS=120000
```

### Debug Mode

Enable detailed logging:

```bash
export LOG_LEVEL=debug
export DEBUG=*
node src/offchain.js
```

### Health Checks

```bash
# Check all services
./scripts/health_check.sh

# Check blockchain connection
curl http://localhost:8000/stats | jq '.engine_stats'

# Check monitoring
curl http://localhost:9091/-/healthy
```

## 🤝 Contributing

We welcome contributions! Please follow these guidelines:

### Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Make your changes
4. Run tests: `npm test && pytest`
5. Commit: `git commit -m 'Add amazing feature'`
6. Push: `git push origin feature/amazing-feature`
7. Open a Pull Request

### Code Review Process

- All PRs require at least one review
- Tests must pass
- Code coverage must not decrease
- Follow existing code style

### Reporting Bugs

Use GitHub Issues with the following template:

```markdown
**Description**
Clear description of the bug

**Steps to Reproduce**
1. Step 1
2. Step 2
3. ...

**Expected Behavior**
What should happen

**Actual Behavior**
What actually happens

**Environment**
- OS:
- Node.js version:
- Python version:
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Uniswap V3](https://uniswap.org/) for the DEX protocol
- [OpenZeppelin](https://openzeppelin.com/) for secure contract libraries
- [PRBMath](https://github.com/paulrberg/prb-math) for fixed-point math
- [scikit-learn](https://scikit-learn.org/) for ML algorithms

## 📞 Support

- **Documentation**: [Wiki](https://github.com/zentsystems-ctrl/uniswap-ai-liquitiy-manager-pro/wiki)
- **Issues**: [GitHub Issues](https://github.com/zentsystems-ctrl/uniswap-ai-liquitiy-manager-pro/issues)
- **Discussions**: [GitHub Discussions](https://github.com/zentsystems-ctrl/uniswap-ai-liquitiy-manager-pro/discussions)

## 🗺️ Roadmap

- [ ] Support for multiple DEXs (SushiSwap, PancakeSwap)
- [ ] Advanced ML models (LSTM, Transformer)
- [ ] Multi-chain support (Polygon, Arbitrum, Optimism)
- [ ] Web dashboard for monitoring
- [ ] Mobile app for alerts
- [ ] Advanced risk models
- [ ] Automated parameter optimization

---

**⚠️ Disclaimer**: This software is provided "as is" without warranty. Use at your own risk. Always test thoroughly before deploying to mainnet with real funds.


