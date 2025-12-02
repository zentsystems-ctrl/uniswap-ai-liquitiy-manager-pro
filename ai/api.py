# api.py
import os
import time
import logging
from pathlib import Path
from typing import Optional, Dict, Any
from contextlib import asynccontextmanager
from dataclasses import asdict

from fastapi import FastAPI, HTTPException, BackgroundTasks, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator, ConfigDict
import uvicorn

# Import AI Engine
try:
    from ai_engine import AIEngine, MarketState, Position, Decision
    HAS_AI_ENGINE = True
except Exception as e:
    print(f"⚠️  Warning: ai_engine import failed: {e}")
    HAS_AI_ENGINE = False

# Prometheus metrics - IMPORTANT: Clear registry first
from prometheus_client import REGISTRY, Counter, Histogram, Gauge, generate_latest

# Clear existing metrics to avoid duplication
def clear_existing_metrics():
    """Clear existing metrics to avoid duplication errors"""
    metrics_to_remove = []
    try:
        names_map = getattr(REGISTRY, "_names_to_collectors", {})
    except Exception:
        names_map = {}
    for metric_name in list(names_map.keys()):
        if any(prefix in metric_name for prefix in ['ai_', 'defi_']):
            metrics_to_remove.append(metric_name)

    for metric_name in metrics_to_remove:
        try:
            REGISTRY.unregister(names_map[metric_name])
        except Exception:
            pass

# Clear before defining new metrics
clear_existing_metrics()

# Define metrics with unique names
api_requests = Counter('defi_ai_api_requests_total', 'Total API requests', ['endpoint', 'status'])
decision_latency = Histogram('defi_ai_decision_latency_seconds', 'Decision latency')
ml_confidence = Gauge('defi_ai_ml_confidence', 'ML confidence score')

# Logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════

MODEL_PATH = os.getenv('MODEL_PATH', './data/models/model.joblib')
SHADOW_LOG_PATH = os.getenv('SHADOW_LOG', './data/shadow_log.ndjson')
DECISIONS_LOG_PATH = os.getenv('DECISIONS_LOG', './data/decisions_log.ndjson')

# Create directories
for path in [MODEL_PATH, SHADOW_LOG_PATH, DECISIONS_LOG_PATH]:
    Path(path).parent.mkdir(parents=True, exist_ok=True)

# ═══════════════════════════════════════════════════════════════════
# INITIALIZE AI ENGINE
# ═══════════════════════════════════════════════════════════════════

ai_engine: Optional[AIEngine] = None
engine_stats = {
    'initialized': False,
    'model_loaded': False,
    'model_path': MODEL_PATH,
    'decisions_count': 0,
    'errors_count': 0,
    'start_time': time.time()
}

def initialize_engine():
    """Initialize AI Engine with ML model (auto-detect)."""
    global ai_engine, engine_stats

    try:
        if not HAS_AI_ENGINE:
            logger.error("❌ ai_engine module not available")
            engine_stats['initialized'] = False
            engine_stats['model_loaded'] = False
            return False

        logger.info("🚀 Initializing AI Engine...")

        model_exists = Path(MODEL_PATH).exists()

        if model_exists:
            logger.info(f"📦 Loading model from: {MODEL_PATH}")
            ai_engine = AIEngine(model_path=MODEL_PATH, allow_unverified_model=True)
            engine_stats['model_loaded'] = True
            logger.info("✅ AI Engine initialized WITH ML model")
        else:
            logger.warning(f"⚠️  Model not found at: {MODEL_PATH}")
            logger.info("🔧 Initializing with rule-based fallback")
            ai_engine = AIEngine(model_path=None)
            engine_stats['model_loaded'] = False
            logger.info("✅ AI Engine initialized (rule-based mode)")

        engine_stats['initialized'] = True
        return True

    except Exception as e:
        logger.error(f"❌ Engine initialization failed: {e}", exc_info=True)
        engine_stats['initialized'] = False
        engine_stats['model_loaded'] = False
        return False

# ═══════════════════════════════════════════════════════════════════
# PYDANTIC MODELS (UPDATED FOR V2)
# ═══════════════════════════════════════════════════════════════════

class PositionInput(BaseModel):
    """Position data input with validation"""
    model_config = ConfigDict(protected_namespaces=())

    id: Any
    owner: str = ""
    lowerTick: float
    upperTick: float
    liquidity: float = 0.0
    token0_balance: float = 0.0
    token1_balance: float = 0.0
    fees_earned_0: float = 0.0
    fees_earned_1: float = 0.0
    age_seconds: int = 0

    @field_validator('token0_balance', 'token1_balance', 'liquidity', 'fees_earned_0', 'fees_earned_1')
    @classmethod
    def validate_positive(cls, v):
        """Ensure non-negative values"""
        return max(0.0, float(v or 0))

    @field_validator('age_seconds')
    @classmethod
    def validate_age(cls, v):
        """Ensure non-negative age"""
        return max(0, int(v or 0))


class StateInput(BaseModel):
    """Market state input with comprehensive validation"""
    model_config = ConfigDict(protected_namespaces=())

    timestamp: float = Field(default_factory=time.time)
    poolId: str

    # Price fields (current_price preferred)
    current_price: Optional[float] = None
    price: Optional[float] = None
    twap_1h: Optional[float] = None
    twap_24h: Optional[float] = None
    price_unit: str = 'eth'   # explicit unit: 'eth'|'wei'|'usd'|'auto'

    # Percentage-based fields
    deviation_pct: Optional[float] = None
    threshold_pct: Optional[float] = None
    within_bounds: Optional[bool] = None

    # Market metrics
    volatility_1h: float = 0.2
    volatility_24h: float = 0.3
    pool_liquidity: float = 1_000_000.0
    volume_24h: float = 0.0
    gas_price: float = 50.0
    gas_unit: str = 'gwei'    # explicit unit: 'gwei'|'wei'|'eth'|'auto'

    # Position
    position: PositionInput

    # Optional
    price_impact: Optional[str] = None
    extra: Dict[str, Any] = Field(default_factory=dict)

    @field_validator('current_price', 'price', 'twap_1h', 'twap_24h')
    @classmethod
    def validate_price(cls, v):
        """Ensure positive prices (or None)"""
        if v is None:
            return None
        return max(0.001, float(v))

    @field_validator('pool_liquidity')
    @classmethod
    def validate_liquidity(cls, v):
        """Ensure minimum liquidity"""
        return max(1000.0, float(v or 1_000_000.0))

    @field_validator('gas_price')
    @classmethod
    def validate_gas(cls, v):
        """Ensure reasonable gas price"""
        return max(1.0, min(1000.0, float(v or 50.0)))

    @field_validator('volatility_1h', 'volatility_24h')
    @classmethod
    def validate_volatility(cls, v):
        """Ensure non-negative volatility"""
        return max(0.0, float(v or 0.0))

    @field_validator('price_unit')
    @classmethod
    def validate_price_unit(cls, v):
        allowed = ('eth', 'wei', 'usd', 'auto')
        if v not in allowed:
            # default to 'eth' with warning
            logger.warning(f"Unknown price_unit '{v}' -> defaulting to 'eth'")
            return 'eth'
        return v

    @field_validator('gas_unit')
    @classmethod
    def validate_gas_unit(cls, v):
        allowed = ('gwei', 'wei', 'eth', 'auto')
        if v not in allowed:
            logger.warning(f"Unknown gas_unit '{v}' -> defaulting to 'gwei'")
            return 'gwei'
        return v


class DecisionOutput(BaseModel):
    """AI decision output"""
    model_config = ConfigDict(protected_namespaces=())

    action: str
    confidence: float
    score: float
    expected_reward: float
    reason: str
    risk_level: str
    recommended_params: Optional[Dict] = None
    metadata: Dict = Field(default_factory=dict)
    timestamp: float = Field(default_factory=time.time)


class HealthResponse(BaseModel):
    """Health check response"""
    model_config = ConfigDict(protected_namespaces=())

    status: str
    has_ml_model: bool
    model_path: str
    decisions_count: int
    errors_count: int
    uptime_seconds: float
    engine_initialized: bool
    engine_stats: Optional[Dict] = None


# ═══════════════════════════════════════════════════════════════════
# LIFESPAN MANAGEMENT (UPDATED FOR FASTAPI)
# ═══════════════════════════════════════════════════════════════════

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown events"""
    # Startup
    logger.info("=" * 60)
    logger.info("🚀 ML-Powered AI Service Starting...")
    logger.info("=" * 60)

    # Initialize engine
    initialize_engine()

    logger.info(f"Model path: {MODEL_PATH}")
    logger.info(f"Model loaded: {engine_stats['model_loaded']}")
    logger.info(f"Engine initialized: {engine_stats['initialized']}")
    logger.info("=" * 60)

    yield

    # Shutdown
    logger.info("👋 Shutting down AI Service...")
    if ai_engine:
        try:
            stats = ai_engine.get_stats()
            logger.info(f"Final stats: {stats}")
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════════
# FASTAPI APP (UPDATED WITH LIFESPAN)
# ═══════════════════════════════════════════════════════════════════

app = FastAPI(
    title="ML-Powered AI Service",
    description="Production AI decision service with ML integration",
    version="4.0.1",
    lifespan=lifespan
)


# ═══════════════════════════════════════════════════════════════════
# ENDPOINTS
# ═══════════════════════════════════════════════════════════

@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "service": "ML-Powered AI Service",
        "version": "4.0.1",
        "status": "running",
        "ml_enabled": engine_stats['model_loaded'],
        "engine_initialized": engine_stats['initialized']
    }


@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check endpoint"""
    uptime = time.time() - engine_stats['start_time']

    # Get engine stats if available
    engine_detail = None
    if ai_engine:
        try:
            engine_detail = ai_engine.get_stats()
        except Exception:
            pass

    return HealthResponse(
        status="healthy" if engine_stats['initialized'] else "degraded",
        has_ml_model=engine_stats['model_loaded'],
        model_path=MODEL_PATH,
        decisions_count=engine_stats['decisions_count'],
        errors_count=engine_stats['errors_count'],
        uptime_seconds=uptime,
        engine_initialized=engine_stats['initialized'],
        engine_stats=engine_detail
    )


@app.post("/decide", response_model=DecisionOutput)
async def decide(state: StateInput, background_tasks: BackgroundTasks):
    """
    🤖 ML-Powered Decision Endpoint

    Returns AI decision using ML model (if available) or rule-based fallback
    """
    start_time = time.time()

    # Check if engine is initialized
    if not ai_engine:
        engine_stats['errors_count'] += 1
        api_requests.labels(endpoint='decide', status='error').inc()
        raise HTTPException(
            status_code=503,
            detail="AI Engine not initialized"
        )

    try:
        # Convert input to internal format
        position = Position(
            id=state.position.id,
            owner=state.position.owner,
            lowerTick=state.position.lowerTick,
            upperTick=state.position.upperTick,
            liquidity=state.position.liquidity,
            token0_balance=state.position.token0_balance,
            token1_balance=state.position.token1_balance,
            fees_earned_0=state.position.fees_earned_0,
            fees_earned_1=state.position.fees_earned_1,
            age_seconds=state.position.age_seconds
        )

        # Determine current price (with fallbacks)
        current_price = (
            state.current_price
            or state.price
            or state.twap_24h
            or state.twap_1h
            or 1.0
        )

        market_state = MarketState(
            timestamp=state.timestamp,
            poolId=state.poolId,
            current_price=current_price,
            price_unit=state.price_unit,
            twap_1h=state.twap_1h or current_price,
            twap_24h=state.twap_24h or current_price,
            volatility_1h=state.volatility_1h,
            volatility_24h=state.volatility_24h,
            pool_liquidity=state.pool_liquidity,
            volume_24h=state.volume_24h,
            gas_price=state.gas_price,
            gas_unit=state.gas_unit,
            position=position,
            deviation_pct=state.deviation_pct,
            threshold_pct=state.threshold_pct,
            within_bounds=state.within_bounds,
            price_impact=state.price_impact,
            extra=state.extra
        )

        # Get ML decision
        logger.info(f"🤖 Processing decision for position {state.position.id}")
        decision: Decision = ai_engine.decide(market_state)

        # Record metrics
        api_requests.labels(endpoint='decide', status='success').inc()
        decision_latency.observe(time.time() - start_time)
        try:
            ml_confidence.set(float(decision.confidence))
        except Exception:
            pass

        # Log decision in background (use asdict to ensure dataclass -> dict)
        background_tasks.add_task(
            log_decision,
            state.model_dump(),
            asdict(decision)
        )

        # Update stats
        engine_stats['decisions_count'] += 1

        # Return decision
        return DecisionOutput(
            action=decision.action,
            confidence=decision.confidence,
            score=decision.score,
            expected_reward=decision.expected_reward,
            reason=decision.reason,
            risk_level=decision.risk_level,
            recommended_params=decision.recommended_params,
            metadata=decision.metadata,
            timestamp=time.time()
        )

    except Exception as e:
        # Record error metrics
        api_requests.labels(endpoint='decide', status='error').inc()
        engine_stats['errors_count'] += 1
        logger.error(f"❌ Decision error: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Decision processing failed: {str(e)}"
        )


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint"""
    return Response(content=generate_latest(), media_type="text/plain")


@app.post("/reload-model")
async def reload_model():
    """Reload ML model (admin endpoint)"""
    try:
        logger.info("🔄 Reloading model...")
        success = initialize_engine()

        if success:
            return {
                "status": "success",
                "message": "Model reloaded successfully",
                "model_loaded": engine_stats['model_loaded']
            }
        else:
            return JSONResponse(
                status_code=503,
                content={
                    "status": "failed",
                    "message": "Model reload failed"
                }
            )

    except Exception as e:
        logger.error(f"❌ Reload failed: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Reload failed: {str(e)}"
        )


@app.get("/stats")
async def get_stats():
    """Get detailed statistics"""
    uptime = time.time() - engine_stats['start_time']

    stats = {
        **engine_stats,
        'uptime_seconds': uptime,
        'uptime_hours': uptime / 3600
    }

    # Add engine stats if available
    if ai_engine:
        try:
            stats['engine_stats'] = ai_engine.get_stats()
        except Exception as e:
            stats['engine_stats_error'] = str(e)

    return stats


# ═══════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ═══════════════════════════════════════════════════════════════════

def log_decision(state: Dict, decision: Dict):
    """Log decision to file (background task)"""
    try:
        import json

        record = {
            'timestamp': time.time(),
            'state': state,
            'decision': decision
        }

        # Log to decisions file
        with open(DECISIONS_LOG_PATH, 'a') as f:
            f.write(json.dumps(record) + '\n')

    except Exception as e:
        logger.warning(f"Failed to log decision: {e}")


# ═══════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════

if __name__ == '__main__':
    # Initialize engine now so CLI prints accurate status
    initialize_engine()

    port = int(os.getenv('PORT', 8000))
    host = os.getenv('HOST', '0.0.0.0')

    print("=" * 60)
    print("🚀 STARTING ML-POWERED AI SERVICE")
    print("=" * 60)
    print(f"Host: {host}:{port}")
    print(f"Model: {MODEL_PATH}")
    print(f"ML Enabled: {engine_stats['model_loaded']}")
    print(f"Engine initialized: {engine_stats['initialized']}")
    print("=" * 60)

    uvicorn.run(
        "api:app",
        host=host,
        port=port,
        reload=False,
        log_level="info"
    )
