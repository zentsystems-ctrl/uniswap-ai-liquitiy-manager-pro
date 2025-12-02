#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# Install: Prometheus + Grafana + AlertManager
# ═══════════════════════════════════════════════════════════════════


# Check prerequisites
echo "🔍 Checking prerequisites..."

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not installed"
    exit 1
fi

# Check Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose not installed"
    exit 1
fi

# Check Node.js for metrics
if ! command -v node &> /dev/null; then
    echo "⚠️  Node.js not installed - metrics exporter will need it"
fi

# Check port availability
check_port() {
    if lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null ; then
        echo "❌ Port $1 is already in use"
        return 1
    fi
}

check_port 3000
check_port 9091
check_port 9093
check_port 9100

set -e

echo "═══════════════════════════════════════════════════════════════"
echo "📊 ADVANCED MONITORING SETUP"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "This will install:"
echo "  1. Prometheus (metrics collection)"
echo "  2. Grafana (visualization)"
echo "  3. Node Exporter (system metrics)"
echo "  4. AlertManager (alerts)"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 0
fi

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_ROOT="$(pwd)"
MONITORING_DIR="$PROJECT_ROOT/monitoring"

echo ""
echo -e "${YELLOW}📁 Creating monitoring directory...${NC}"
mkdir -p "$MONITORING_DIR"/{prometheus,grafana,alertmanager}

# ═══════════════════════════════════════════════════════════════════
# STEP 1: Create Prometheus Configuration
# ═══════════════════════════════════════════════════════════════════

echo -e "${YELLOW}⚙️  Creating Prometheus config...${NC}"

cat > "$MONITORING_DIR/prometheus/prometheus.yml" <<'EOF'
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    monitor: 'defi-agent-monitor'

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - "/etc/prometheus/alerts.yml"

scrape_configs:
  # DeFi Agent Metrics
  - job_name: 'defi-agent'
    static_configs:
      - targets: ['host.docker.internal:9090']
        labels:
          service: 'agent'
  
  # AI API Metrics
  - job_name: 'ai-api'
    static_configs:
      - targets: ['host.docker.internal:8000']
        labels:
          service: 'api'
  
  # System Metrics
  - job_name: 'node-exporter'
    static_configs:
      - targets: ['node-exporter:9100']
        labels:
          service: 'system'
  
  # Prometheus itself
  - job_name: 'prometheus'
    static_configs:
      - targets: ['localhost:9090']
EOF

# ═══════════════════════════════════════════════════════════════════
# STEP 2: Create Alert Rules
# ═══════════════════════════════════════════════════════════════════

echo -e "${YELLOW}🚨 Creating alert rules...${NC}"

cat > "$MONITORING_DIR/prometheus/alerts.yml" <<'EOF'
groups:
  - name: defi_critical
    interval: 30s
    rules:
      # Agent Down
      - alert: AgentDown
        expr: up{job="defi-agent"} == 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "DeFi Agent is down"
          description: "Agent has been down for 2 minutes"
      
      # High Gas Price
      - alert: HighGasPrice
        expr: defi_gas_price_gwei > 200
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Gas price is high"
          description: "Gas price is {{ $value }} gwei (threshold: 200)"
      
      # Daily Loss
      - alert: DailyLoss
        expr: defi_profit_loss_eth{period="today"} < -1
        labels:
          severity: critical
        annotations:
          summary: "Daily losses exceed 1 ETH"
          description: "Current loss: {{ $value }} ETH"
      
      # Low Success Rate
      - alert: LowSuccessRate
        expr: |
          (
            rate(defi_actions_total{status="success"}[1h]) / 
            rate(defi_actions_total[1h])
          ) < 0.7
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "Success rate below 70%"
          description: "Success rate: {{ $value | humanizePercentage }}"
      
      # High Memory Usage
      - alert: HighMemoryUsage
        expr: |
          (
            node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes
          ) / node_memory_MemTotal_bytes > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Memory usage above 90%"
      
      # Disk Space Low
      - alert: DiskSpaceLow
        expr: |
          (
            node_filesystem_avail_bytes{mountpoint="/"} / 
            node_filesystem_size_bytes{mountpoint="/"}
          ) < 0.1
        labels:
          severity: warning
        annotations:
          summary: "Disk space below 10%"

  - name: defi_performance
    interval: 1m
    rules:
      # Slow Decisions
      - alert: SlowDecisions
        expr: |
          histogram_quantile(0.95, 
            rate(defi_decision_latency_ms_bucket[5m])
          ) > 5000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "95th percentile latency > 5s"
      
      # Low ML Confidence
      - alert: LowMLConfidence
        expr: |
          avg_over_time(defi_ml_confidence[15m]) < 0.6
        for: 15m
        labels:
          severity: info
        annotations:
          summary: "Average ML confidence below 0.6"
EOF

# ═══════════════════════════════════════════════════════════════════
# STEP 3: Create AlertManager Configuration
# ═══════════════════════════════════════════════════════════════════

echo -e "${YELLOW}📧 Creating AlertManager config...${NC}"

cat > "$MONITORING_DIR/alertmanager/alertmanager.yml" <<'EOF'
global:
  resolve_timeout: 5m

route:
  group_by: ['alertname', 'severity']
  group_wait: 10s
  group_interval: 10s
  repeat_interval: 12h
  receiver: 'telegram'
  
  routes:
    - match:
        severity: critical
      receiver: 'telegram-critical'
      continue: true
    
    - match:
        severity: warning
      receiver: 'telegram'

receivers:
  # Telegram for all alerts
  - name: 'telegram'
    webhook_configs:
      - url: 'http://telegram-bot:8080/alert'
  
  # Telegram with @mention for critical
  - name: 'telegram-critical'
    webhook_configs:
      - url: 'http://telegram-bot:8080/alert/critical'

inhibit_rules:
  - source_match:
      severity: 'critical'
    target_match:
      severity: 'warning'
    equal: ['alertname']
EOF

# ═══════════════════════════════════════════════════════════════════
# STEP 4: Create Docker Compose
# ═══════════════════════════════════════════════════════════════════

echo -e "${YELLOW}🐳 Creating Docker Compose...${NC}"

cat > "$MONITORING_DIR/docker-compose.yml" <<'EOF'
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    volumes:
      - ./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - ./prometheus/alerts.yml:/etc/prometheus/alerts.yml
      - prometheus_data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/usr/share/prometheus/console_libraries'
      - '--web.console.templates=/usr/share/prometheus/consoles'
    ports:
      - "9091:9090"
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    volumes:
      - grafana_data:/var/lib/grafana
      - ./grafana/provisioning:/etc/grafana/provisioning
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
    restart: unless-stopped

  alertmanager:
    image: prom/alertmanager:latest
    container_name: alertmanager
    volumes:
      - ./alertmanager/alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - alertmanager_data:/alertmanager
    command:
      - '--config.file=/etc/alertmanager/alertmanager.yml'
      - '--storage.path=/alertmanager'
    ports:
      - "9093:9093"
    restart: unless-stopped

  node-exporter:
    image: prom/node-exporter:latest
    container_name: node-exporter
    command:
      - '--path.procfs=/host/proc'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    ports:
      - "9100:9100"
    restart: unless-stopped

volumes:
  prometheus_data:
  grafana_data:
  alertmanager_data:
EOF

# ═══════════════════════════════════════════════════════════════════
# STEP 5: Create Grafana Provisioning
# ═══════════════════════════════════════════════════════════════════

echo -e "${YELLOW}📊 Creating Grafana dashboards...${NC}"

mkdir -p "$MONITORING_DIR/grafana/provisioning/datasources"
mkdir -p "$MONITORING_DIR/grafana/provisioning/dashboards"

cat > "$MONITORING_DIR/grafana/provisioning/datasources/prometheus.yml" <<'EOF'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true
EOF

cat > "$MONITORING_DIR/grafana/provisioning/dashboards/dashboard.yml" <<'EOF'
apiVersion: 1

providers:
  - name: 'DeFi Agent'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards
EOF

# Simple dashboard JSON
cat > "$MONITORING_DIR/grafana/provisioning/dashboards/defi-agent.json" <<'EOF'
{
  "dashboard": {
    "title": "DeFi Agent Dashboard",
    "tags": ["defi", "agent"],
    "timezone": "browser",
    "panels": [
      {
        "id": 1,
        "title": "Total Value Locked",
        "type": "stat",
        "gridPos": {"h": 8, "w": 6, "x": 0, "y": 0},
        "targets": [
          {
            "expr": "defi_tvl_eth",
            "legendFormat": "TVL (ETH)"
          }
        ]
      },
      {
        "id": 2,
        "title": "Profit/Loss Today",
        "type": "stat",
        "gridPos": {"h": 8, "w": 6, "x": 6, "y": 0},
        "targets": [
          {
            "expr": "defi_profit_loss_eth{period=\"today\"}",
            "legendFormat": "P&L (ETH)"
          }
        ]
      },
      {
        "id": 3,
        "title": "Success Rate",
        "type": "gauge",
        "gridPos": {"h": 8, "w": 6, "x": 12, "y": 0},
        "targets": [
          {
            "expr": "rate(defi_actions_total{status=\"success\"}[1h]) / rate(defi_actions_total[1h]) * 100"
          }
        ]
      }
    ]
  }
}
EOF

# ═══════════════════════════════════════════════════════════════════
# STEP 6: Create Metrics Exporter for Agent
# ═══════════════════════════════════════════════════════════════════

echo -e "${YELLOW}📊 Creating metrics exporter...${NC}"

cat > "$PROJECT_ROOT/src/metrics_exporter.js" <<'EOF'
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
EOF

# ═══════════════════════════════════════════════════════════════════
# STEP 7: Create Usage Example
# ═══════════════════════════════════════════════════════════════════

cat > "$PROJECT_ROOT/src/metrics_usage_example.js" <<'EOF'
// Example: How to use metrics in your code

const metrics = require('./metrics_exporter');

// Start metrics server
metrics.startServer(9090);

// Update metrics in your code:

// 1. Update position count
metrics.totalPositions.set(12);

// 2. Update TVL
metrics.tvl.set(125.5);

// 3. Record profit/loss
metrics.profitLoss.set({ period: 'today' }, 2.34);
metrics.profitLoss.set({ period: 'all_time' }, 45.67);

// 4. Record gas costs
metrics.gasCosts.inc(0.0025); // Add 0.0025 ETH

// 5. Record ML confidence
metrics.mlConfidence.observe(0.87);

// 6. Record decision latency
const startTime = Date.now();
// ... make decision ...
const latency = Date.now() - startTime;
metrics.decisionLatency.observe(latency);

// 7. Record action
metrics.actionsCounter.inc({
    action: 'rebalance',
    status: 'success'
});

// 8. Update gas price
metrics.gasPriceGauge.set(45.5);
EOF

# ═══════════════════════════════════════════════════════════════════
# STEP 8: Create Start Script
# ═══════════════════════════════════════════════════════════════════

cat > "$MONITORING_DIR/start-monitoring.sh" <<'EOF'
#!/bin/bash
echo "🚀 Starting monitoring stack..."
docker-compose up -d

echo ""
echo "✅ Monitoring started!"
echo ""
echo "Access URLs:"
echo "  📊 Grafana:      http://localhost:3000 (admin/admin)"
echo "  📈 Prometheus:   http://localhost:9091"
echo "  🚨 AlertManager: http://localhost:9093"
echo ""
echo "Wait 30 seconds for everything to initialize..."
EOF

chmod +x "$MONITORING_DIR/start-monitoring.sh"

# ═══════════════════════════════════════════════════════════════════
# STEP 9: Create Stop Script
# ═══════════════════════════════════════════════════════════════════

cat > "$MONITORING_DIR/stop-monitoring.sh" <<'EOF'
#!/bin/bash
echo "🛑 Stopping monitoring stack..."
docker-compose down
echo "✅ Monitoring stopped!"
EOF

chmod +x "$MONITORING_DIR/stop-monitoring.sh"

# ═══════════════════════════════════════════════════════════════════
# DONE
# ═══════════════════════════════════════════════════════════════════

echo ""
echo -e "${GREEN}✅ Monitoring setup complete!${NC}"
echo ""
echo "📁 Files created in: $MONITORING_DIR"
echo ""
echo "🚀 Next steps:"
echo ""
echo "1. Install dependencies:"
echo "   npm install prom-client express"
echo ""
echo "2. Start monitoring stack:"
echo "   cd $MONITORING_DIR"
echo "   ./start-monitoring.sh"
echo ""
echo "3. Add metrics to your agent (see metrics_usage_example.js)"
echo ""
echo "4. Access dashboards:"
echo "   Grafana:    http://localhost:3000 (admin/admin)"
echo "   Prometheus: http://localhost:9091"
echo ""
echo "5. Setup Telegram alerts (optional):"
echo "   https://github.com/metalmatze/alertmanager-bot"
echo ""
