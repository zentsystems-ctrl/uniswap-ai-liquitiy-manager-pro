version: '3.8'

services:
  # AI Service
  ai-service:
    build:
      context: .
      dockerfile: Dockerfile.pro.v2
    container_name: liquidity-ai-service
    ports:
      - "${AI_PORT:-8000}:8000"
    environment:
      - PORT=8000
      - MODEL_PATH=/app/models/model_ensemble.joblib
      - SHADOW_LOG=/app/logs/shadow_log.ndjson
      - LOG_LEVEL=${AI_LOG_LEVEL:-info}
    volumes:
      - ./models:/app/models
      - ./logs:/app/logs
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    networks:
      - liquidity-network
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  # Offchain Agent
  offchain-agent:
    build:
      context: .
      dockerfile: Dockerfile.agent
    container_name: liquidity-offchain-agent
    environment:
      - RPC_URL=${RPC_URL}
      - PRIVATE_KEY=${PRIVATE_KEY}
      - INDEX_ADDRESS=${INDEX_ADDRESS}
      - PM_ADDRESS=${PM_ADDRESS}
      - POOL_IDS=${POOL_IDS}
      - AI_URL=http://ai-service:8000/decide
      - AI_TIMEOUT_MS=5000
      - AI_MAX_RETRIES=3
      - SHADOW_LOG=/app/logs/shadow_log.ndjson
      - MAX_SYNC_PER_RUN=${MAX_SYNC_PER_RUN:-10}
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      - ./logs:/app/logs
    depends_on:
      ai-service:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - liquidity-network
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G

  # Prometheus (Optional - for monitoring)
  prometheus:
    image: prom/prometheus:latest
    container_name: liquidity-prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
    restart: unless-stopped
    networks:
      - liquidity-network
    profiles:
      - monitoring

  # Grafana (Optional - for dashboards)
  grafana:
    image: grafana/grafana:latest
    container_name: liquidity-grafana
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=${GRAFANA_PASSWORD:-admin}
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana-data:/var/lib/grafana
      - ./grafana/dashboards:/etc/grafana/provisioning/dashboards
    depends_on:
      - prometheus
    restart: unless-stopped
    networks:
      - liquidity-network
    profiles:
      - monitoring

networks:
  liquidity-network:
    driver: bridge

volumes:
  prometheus-data:
  grafana-data:
