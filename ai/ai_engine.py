from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Tuple
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from collections import deque

import numpy as np

# Optional ML imports
try:
    from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
    from sklearn.preprocessing import StandardScaler
    import joblib
    import xgboost as xgb
    HAS_ML = True
except Exception:
    RandomForestRegressor = None
    GradientBoostingRegressor = None
    StandardScaler = None
    joblib = None
    xgb = None
    HAS_ML = False

# Logger
logger = logging.getLogger('ai_engine_v4_1')
if not logger.handlers:
    h = logging.StreamHandler()
    fmt = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')
    h.setFormatter(fmt)
    logger.addHandler(h)
    logger.setLevel(logging.INFO)


# ---------------------------
# CONFIG
# ---------------------------
@dataclass
class EngineConfig:
    MIN_POOL_LIQUIDITY: float = 1000.0
    DEFAULT_POOL_LIQUIDITY: float = 1_000_000.0
    DEFAULT_GAS_GWEI: float = 50.0
    GAS_LIMITS: Dict[str, int] = field(default_factory=lambda: {
        'rebalance': 600_000,
        'reduce': 400_000,
        'close': 500_000,
        'hold': 0
    })
    TICK_SPACING_DEFAULT: int = 60
    SAFETY_MAX_GAS_ETH: float = 0.01
    SAFETY_MAX_LOSS_PCT: float = 0.05
    FEATURE_CLIP: float = 10.0
    MIN_TICK_RANGE: float = 1.0
    ETH_PRICE_USD_FALLBACK: Optional[float] = None  # if USD->ETH conversions are needed and no oracle


CONFIG = EngineConfig()


# ---------------------------
# DATA STRUCTURES (compatible)
# ---------------------------
@dataclass
class Position:
    id: Any
    owner: str
    lowerTick: float
    upperTick: float
    liquidity: float
    token0_balance: float = 0.0  # quantity of token0
    token1_balance: float = 0.0  # quantity of token1
    fees_earned_0: float = 0.0
    fees_earned_1: float = 0.0
    age_seconds: int = 0

    def __post_init__(self):
        self.token0_balance = max(0.0, float(self.token0_balance or 0))
        self.token1_balance = max(0.0, float(self.token1_balance or 0))
        self.liquidity = max(0.0, float(self.liquidity or 0))


@dataclass
class MarketState:
    timestamp: float
    poolId: str
    current_price: float
    price_unit: str = 'eth'   # 'eth'|'wei'|'usd'
    twap_1h: float = 0.0
    twap_24h: float = 0.0
    volatility_1h: float = 0.0
    volatility_24h: float = 0.0
    pool_liquidity: float = 0.0
    volume_24h: float = 0.0
    gas_price: float = CONFIG.DEFAULT_GAS_GWEI
    gas_unit: str = 'gwei'
    position: Position = None
    extra: Dict[str, Any] = field(default_factory=dict)

    deviation_pct: Optional[float] = None
    threshold_pct: Optional[float] = None
    within_bounds: Optional[bool] = None
    price_impact: Optional[str] = None

    def __post_init__(self):
        try:
            self.current_price = float(self.current_price or 0.0)
        except Exception:
            self.current_price = 0.0
        self.pool_liquidity = max(CONFIG.MIN_POOL_LIQUIDITY, float(self.pool_liquidity or CONFIG.DEFAULT_POOL_LIQUIDITY))
        self.gas_price = float(self.gas_price or CONFIG.DEFAULT_GAS_GWEI)
        if self.price_unit not in ('eth', 'wei', 'usd', 'gwei'):
            logger.warning(f"Unknown price_unit '{self.price_unit}', treating as 'eth'")
            self.price_unit = 'eth'
        if self.gas_unit not in ('gwei', 'wei', 'eth'):
            logger.warning(f"Unknown gas_unit '{self.gas_unit}', treating as 'gwei'")
            self.gas_unit = 'gwei'


@dataclass
class Decision:
    action: str
    confidence: float
    score: float
    expected_reward: float
    reason: str
    risk_level: str
    recommended_params: Optional[Dict] = None
    metadata: Dict = field(default_factory=dict)

    def __post_init__(self):
        self.confidence = max(0.0, min(1.0, float(self.confidence or 0.0)))
        self.expected_reward = float(self.expected_reward or 0.0)


# ---------------------------
# NUMERIC & UNIT UTILITIES
# ---------------------------
import re

class UnitConverter:

    @staticmethod
    def _to_float_safe(value: Any) -> float:
        if value is None:
            return 0.0
        try:
            if isinstance(value, (int, float, np.number)):
                v = float(value)
                return v if np.isfinite(v) else 0.0
            if isinstance(value, str):
                s = value.strip().replace(',', '')
                # accept scientific notation
                if re.match(r'^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$', s):
                    v = float(s)
                    return v if np.isfinite(v) else 0.0
            return 0.0
        except Exception:
            return 0.0

    @staticmethod
    def to_eth(value: Any, unit: str = 'eth', eth_price_usd: Optional[float] = None) -> float:
        num = UnitConverter._to_float_safe(value)
        if not np.isfinite(num) or num < 0:
            return 0.0
        if unit == 'wei':
            return num / 1e18
        if unit == 'gwei':
            return num / 1e9
        if unit == 'eth':
            return num
        if unit == 'usd':
            # require explicit eth_price_usd or fallback config
            price = eth_price_usd if eth_price_usd is not None else CONFIG.ETH_PRICE_USD_FALLBACK
            if price is None or price <= 0:
                raise ValueError('USD->ETH conversion requires eth_price_usd in call or CONFIG.ETH_PRICE_USD_FALLBACK')
            return num / price
        # fallback
        return num

    @staticmethod
    def to_gwei(value: Any, unit: str = 'gwei') -> float:
        num = UnitConverter._to_float_safe(value)
        if not np.isfinite(num) or num <= 0:
            return CONFIG.DEFAULT_GAS_GWEI
        if unit == 'wei':
            return num / 1e9
        if unit == 'gwei':
            return num
        if unit == 'eth':
            return num * 1e9
        return num


# ---------------------------
# SAFE MATH
# ---------------------------

def _safe_division(numerator: float, denominator: float, default: float = 0.0) -> float:
    try:
        if numerator is None or denominator is None:
            return default
        num = float(numerator)
        den = float(denominator)
        if den == 0.0 or not np.isfinite(den) or not np.isfinite(num):
            return default
        res = num / den
        return res if np.isfinite(res) else default
    except Exception:
        return default


# ---------------------------
# PERCENTAGE UTIL
# ---------------------------
class PercentageCalculator:
    @staticmethod
    def compute_deviation_pct(current: float, reference: float) -> float:
        try:
            if reference == 0 or not np.isfinite(reference):
                return 0.0
            deviation = abs(current - reference) / abs(reference) * 100.0
            return deviation if np.isfinite(deviation) else 0.0
        except Exception:
            return 0.0

    @staticmethod
    def is_within_bounds(deviation_pct: float, threshold_pct: float) -> bool:
        try:
            if not np.isfinite(deviation_pct) or not np.isfinite(threshold_pct):
                return True
            return deviation_pct <= threshold_pct
        except Exception:
            return True


# ---------------------------
# FEATURE ENGINEERING (improved)
# ---------------------------
class FeatureEngineering:
    def __init__(self):
        self.converter = UnitConverter()
        self.pct = PercentageCalculator()

    def extract_features(self, state: MarketState) -> np.ndarray:
        try:
            pos = state.position
            extra = state.extra or {}

            # Ensure token prices exist (token price in ETH), else we try to infer using 'price_unit' for current_price
            token0_price_eth = extra.get('token0_price_eth')
            token1_price_eth = extra.get('token1_price_eth')
            eth_price_usd = extra.get('eth_price_usd')

            # If token prices absent but current_price is in ETH and tokens are ETH equivalent (common for ETH/XXX pools), fallback
            if token0_price_eth is None or token1_price_eth is None:
                # Try to infer: if token0 or token1 is ETH-like and current_price given, use that
                token0_price_eth = token0_price_eth or (state.current_price if extra.get('token0_is_price_denominated', False) else None)
                token1_price_eth = token1_price_eth or (state.current_price if extra.get('token1_is_price_denominated', False) else None)

            # Convert main prices to ETH if needed
            current_price_eth = UnitConverter.to_eth(state.current_price, state.price_unit, eth_price_usd)
            twap_1h_eth = UnitConverter.to_eth(state.twap_1h or current_price_eth, state.price_unit, eth_price_usd)
            twap_24h_eth = UnitConverter.to_eth(state.twap_24h or current_price_eth, state.price_unit, eth_price_usd)

            reference_price = twap_24h_eth
            if extra.get('p_ref'):
                reference_price = UnitConverter.to_eth(extra.get('p_ref'), state.price_unit, eth_price_usd)

            # Price deviations
            price_dev_24h = self.pct.compute_deviation_pct(current_price_eth, twap_24h_eth)
            price_dev_ref = self.pct.compute_deviation_pct(current_price_eth, reference_price)
            price_ratio_ref = _safe_division(current_price_eth, reference_price, 1.0)

            # current deviation (percent)
            if state.deviation_pct is not None and state.deviation_pct > 0:
                current_deviation = float(state.deviation_pct)
            else:
                current_deviation = price_dev_24h

            # threshold
            if state.threshold_pct is not None and state.threshold_pct > 0:
                threshold = float(state.threshold_pct)
            else:
                threshold = float(extra.get('threshold_pct') or 5.0)

            threshold_ratio = _safe_division(current_deviation, threshold, 0.0)

            # position ticks
            current_tick = float(extra.get('currentTick', 0))
            tick_lower = float(pos.lowerTick)
            tick_upper = float(pos.upperTick)
            tick_range = max(CONFIG.MIN_TICK_RANGE, abs(tick_upper - tick_lower))
            tick_midpoint = (tick_upper + tick_lower) / 2.0

            position_in_range = float(np.clip((current_tick - tick_lower) / tick_range, 0.0, 1.0))

            denom_lower = max(abs(tick_lower), 1.0)
            denom_upper = max(abs(tick_upper), 1.0)
            dist_to_lower = _safe_division(abs(current_tick - tick_lower), denom_lower, 0.0)
            dist_to_upper = _safe_division(abs(tick_upper - current_tick), denom_upper, 0.0)

            in_range = bool(extra.get('inRange', True))
            in_range_score = 1.0 if in_range else 0.0

            # Compute position value using token prices (if available)
            pos_val_eth = 0.0
            try:
                # Prefer explicit token prices
                if token0_price_eth is not None and token1_price_eth is not None:
                    pos_val_eth = float(pos.token0_balance) * float(token0_price_eth) + float(pos.token1_balance) * float(token1_price_eth)
                else:
                    # Fallback: assume balances already denominated in ETH (legacy behavior)
                    pos_val_eth = UnitConverter.to_eth(pos.token0_balance, state.price_unit, eth_price_usd) + UnitConverter.to_eth(pos.token1_balance, state.price_unit, eth_price_usd)
            except Exception:
                pos_val_eth = 0.0

            total_value_normalized = _safe_division(pos_val_eth, 1e6, 0.0)

            pool_liquidity = max(CONFIG.MIN_POOL_LIQUIDITY, float(state.pool_liquidity or CONFIG.DEFAULT_POOL_LIQUIDITY))
            liquidity_util = _safe_division(float(pos.liquidity), pool_liquidity, 0.0)
            liquidity_normalized = _safe_division(float(pos.liquidity), 1e18, 0.0)

            total_fees = float(pos.fees_earned_0 or 0.0) + float(pos.fees_earned_1 or 0.0)
            fee_rate = _safe_division(total_fees, max(1e-9, pos_val_eth), 0.0)

            # IL factor
            price_ratio = _safe_division(current_price_eth, twap_24h_eth, 1.0)
            il_factor = 0.0
            if price_ratio > 0:
                try:
                    il_factor = abs(2.0 * np.sqrt(price_ratio) / (1.0 + price_ratio) - 1.0)
                except Exception:
                    il_factor = 0.0

            vol_24h = max(0.0, float(state.volatility_24h or 0.0))
            volatility_ratio = _safe_division(float(state.volatility_1h or 0.0), vol_24h or 1.0, 1.0)

            volume_24h = max(0.0, float(state.volume_24h or 0.0))
            volume_per_liquidity = _safe_division(volume_24h, pool_liquidity, 0.0)
            pool_liquidity_normalized = _safe_division(pool_liquidity, 1e24, 0.0)
            volume_normalized = _safe_division(volume_24h, 1e24, 0.0)

            age_days = max(0.0, float(pos.age_seconds or 0) / 86400.0)
            age_normalized = min(age_days / 30.0, 1.0)

            concentration_risk = liquidity_util * (1.0 - position_in_range)

            range_risk = 0.0
            if tick_range > 0 and abs(tick_midpoint) > 0:
                try:
                    range_denom = tick_range / abs(tick_midpoint)
                    range_risk = min(1.0, _safe_division(1.0, range_denom, 0.0))
                except Exception:
                    range_risk = 0.0

            # gas normalized
            gas_price_gwei = UnitConverter.to_gwei(state.gas_price, state.gas_unit)
            gas_cost_eth = (gas_price_gwei * CONFIG.GAS_LIMITS.get('rebalance', 500_000)) / 1e9
            gas_normalized = min(gas_cost_eth / 0.1, 1.0)

            deviation_severity = max(0.0, (current_deviation - threshold) / threshold) if threshold > 0 else 0.0
            rebalance_urgency = min(current_deviation / 20.0, 1.0)

            # 20 features (compatible ordering)
            features = np.array([
                price_dev_24h,
                price_dev_ref,
                price_ratio_ref,
                current_deviation,
                1.0 if state.within_bounds else 0.0,
                position_in_range,
                dist_to_lower,
                dist_to_upper,
                liquidity_util,
                total_value_normalized,
                vol_24h,
                volatility_ratio,
                fee_rate,
                il_factor,
                pool_liquidity_normalized,
                volume_per_liquidity,
                concentration_risk,
                range_risk,
                gas_normalized,
                rebalance_urgency
            ], dtype=np.float64)

            features = np.nan_to_num(features, nan=0.0, posinf=1.0, neginf=0.0)
            features = np.clip(features, -CONFIG.FEATURE_CLIP, CONFIG.FEATURE_CLIP)
            return features
        except Exception as e:
            logger.error(f"Feature extraction failed: {e}")
            return np.zeros(20, dtype=np.float64)

    @staticmethod
    def get_feature_names() -> List[str]:
        return [
            'price_dev_24h', 'price_dev_ref', 'price_ratio_ref', 'current_deviation', 'within_bounds',
            'position_in_range', 'dist_to_lower', 'dist_to_upper', 'liquidity_util', 'total_value_normalized',
            'volatility_24h', 'volatility_ratio', 'fee_rate', 'il_factor', 'pool_liquidity_normalized',
            'volume_per_liquidity', 'concentration_risk', 'range_risk', 'gas_normalized', 'rebalance_urgency'
        ]


# ---------------------------
# MODEL ENSEMBLE (safer save/load)
# ---------------------------
class ModelEnsemble:
    def __init__(self):
        self.models: Dict[str, Any] = {}
        self.scaler = StandardScaler() if HAS_ML else None
        self.is_trained = False
        self.feature_importance = None
        self.version = '4.1'

    def train(self, X: np.ndarray, y: np.ndarray, model_types: List[str] = None):
        if not HAS_ML:
            raise RuntimeError('ML libraries not available')
        if len(X) == 0 or len(y) == 0:
            raise ValueError('No training data provided')
        if X.shape[0] != len(y):
            raise ValueError('X and y have different lengths')

        X = np.nan_to_num(X, nan=0.0)
        y = np.nan_to_num(y, nan=0.0)
        model_types = model_types or (['rf', 'gbm', 'xgb'] if xgb else ['rf', 'gbm'])

        try:
            X_scaled = self.scaler.fit_transform(X)
        except Exception as e:
            logger.warning(f'Scaling failed, using raw features: {e}')
            X_scaled = X

        trained = 0
        if 'rf' in model_types:
            try:
                rf = RandomForestRegressor(n_estimators=100, max_depth=8, min_samples_split=15, min_samples_leaf=5, random_state=42, n_jobs=-1)
                rf.fit(X_scaled, y)
                self.models['rf'] = rf
                self.feature_importance = getattr(rf, 'feature_importances_', None)
                trained += 1
                logger.info('RandomForest trained')
            except Exception as e:
                logger.error(f'RF train failed: {e}')
        if 'gbm' in model_types:
            try:
                gbm = GradientBoostingRegressor(n_estimators=100, learning_rate=0.05, max_depth=4, min_samples_split=15, min_samples_leaf=5, random_state=42)
                gbm.fit(X_scaled, y)
                self.models['gbm'] = gbm
                trained += 1
                logger.info('GradientBoosting trained')
            except Exception as e:
                logger.error(f'GBM train failed: {e}')
        if 'xgb' in model_types and xgb:
            try:
                xgbm = xgb.XGBRegressor(n_estimators=100, learning_rate=0.05, max_depth=4, min_child_weight=5, random_state=42, n_jobs=-1)
                xgbm.fit(X_scaled, y)
                self.models['xgb'] = xgbm
                trained += 1
                logger.info('XGBoost trained')
            except Exception as e:
                logger.error(f'XGB train failed: {e}')

        if trained == 0:
            raise RuntimeError('No models could be trained')
        self.is_trained = True
        logger.info(f'Ensemble training complete ({trained} models)')

    def predict(self, X: np.ndarray) -> Tuple[float, float]:
        if not self.is_trained or not self.models:
            raise ValueError('No trained models available')
        if X is None or len(X) == 0:
            return 0.0, 1.0
        X_clean = np.nan_to_num(X, nan=0.0).reshape(1, -1)
        try:
            X_scaled = self.scaler.transform(X_clean)
        except Exception:
            X_scaled = X_clean

        preds = []
        for name, model in self.models.items():
            try:
                p = model.predict(X_scaled)[0]
                if np.isfinite(p):
                    preds.append(float(p))
            except Exception as e:
                logger.debug(f'Model {name} predict skipped: {e}')
        if not preds:
            return 0.0, 1.0
        return float(np.mean(preds)), float(np.std(preds) or 0.1)

    def save(self, path: str):
        """Save model to path and create a .sha256 file with checksum. Requires joblib available."""
        if not HAS_ML or joblib is None:
            raise RuntimeError('ML libraries not available')
        if not self.is_trained:
            raise ValueError('Cannot save untrained model')
        data = {
            'models': self.models,
            'scaler': self.scaler,
            'is_trained': self.is_trained,
            'feature_importance': self.feature_importance,
            'version': self.version,
            'timestamp': time.time()
        }
        joblib.dump(data, path)
        # compute checksum
        sha = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                sha.update(chunk)
        checksum = sha.hexdigest()
        with open(path + '.sha256', 'w') as f:
            f.write(checksum)
        logger.info(f'Model saved to {path} (sha256: {checksum[:16]}...)')

    @classmethod
    def load(cls, path: str, allow_unverified: bool = False) -> 'ModelEnsemble':
        if not HAS_ML or joblib is None:
            raise RuntimeError('ML libraries not available')
        if not Path(path).exists():
            raise FileNotFoundError(f'Model file not found: {path}')
        checksum_path = path + '.sha256'
        if Path(checksum_path).exists():
            # verify
            sha = hashlib.sha256()
            with open(path, 'rb') as f:
                for chunk in iter(lambda: f.read(8192), b''):
                    sha.update(chunk)
            computed = sha.hexdigest()
            with open(checksum_path, 'r') as f:
                stored = f.read().strip()
            if computed != stored:
                raise ValueError('Model checksum mismatch - possible tampering')
        else:
            if not allow_unverified:
                raise ValueError('Model has no .sha256 checksum file. Provide allow_unverified=True to bypass (not recommended)')
            logger.warning('Loading unverified model (dangerous)')

        data = joblib.load(path)
        ensemble = cls()
        ensemble.models = data.get('models', {})
        ensemble.scaler = data.get('scaler')
        ensemble.is_trained = bool(data.get('is_trained', False) and ensemble.models)
        ensemble.feature_importance = data.get('feature_importance')
        logger.info(f'Model loaded from {path} (trained={ensemble.is_trained})')
        return ensemble


# ---------------------------
# RISK MANAGER (improved)
# ---------------------------
class RiskManager:
    def __init__(self, max_loss_pct: float = CONFIG.SAFETY_MAX_LOSS_PCT, max_gas_eth: float = CONFIG.SAFETY_MAX_GAS_ETH):
        self.max_loss_pct = max(0.001, min(0.2, max_loss_pct))
        self.max_gas_eth = max(0.0001, min(0.5, max_gas_eth))
        self.converter = UnitConverter()
        self.pct = PercentageCalculator()

    def calculate_position_value(self, position: Position, state: MarketState) -> float:
        extra = state.extra or {}
        token0_price_eth = extra.get('token0_price_eth')
        token1_price_eth = extra.get('token1_price_eth')
        eth_price_usd = extra.get('eth_price_usd')
        if token0_price_eth is not None and token1_price_eth is not None:
            try:
                v0 = float(position.token0_balance) * float(token0_price_eth)
                v1 = float(position.token1_balance) * float(token1_price_eth)
                return max(0.0, v0 + v1)
            except Exception:
                return 0.0
        # fallback (legacy): balances are denominated in price_unit.
        try:
            v0 = UnitConverter.to_eth(position.token0_balance, state.price_unit, eth_price_usd)
            v1 = UnitConverter.to_eth(position.token1_balance, state.price_unit, eth_price_usd)
            return max(0.0, v0 + v1)
        except Exception:
            return 0.0

    def calculate_gas_cost(self, gas_price: float, gas_unit: str = 'gwei', action: str = 'rebalance') -> float:
        gas_limit = CONFIG.GAS_LIMITS.get(action, 500_000)
        gas_price_gwei = max(1.0, UnitConverter.to_gwei(gas_price, gas_unit))
        gas_cost_eth = (gas_price_gwei * gas_limit) / 1e9
        return min(gas_cost_eth, 0.5)

    def assess_risk(self, state: MarketState, predicted_reward: float) -> Tuple[str, float]:
        vol_24h = max(0.0, float(state.volatility_24h or 0.0))
        volatility_risk = min(vol_24h / 1.0, 1.0)

        if state.deviation_pct is not None:
            price_dev = max(0.0, float(state.deviation_pct))
        else:
            price_dev = self.pct.compute_deviation_pct(state.current_price, state.twap_24h or state.current_price)
        price_risk = min(price_dev / 20.0, 1.0)

        in_range = state.extra.get('inRange', True)
        range_risk = 0.0 if in_range else 0.5

        gas_cost_eth = self.calculate_gas_cost(state.gas_price, state.gas_unit, 'rebalance')
        position_value = max(1e-9, self.calculate_position_value(state.position, state))
        gas_risk = min(_safe_division(gas_cost_eth, position_value * 0.01, 1.0), 1.0)

        price_ratio = _safe_division(state.current_price, state.twap_24h or state.current_price, 1.0)
        il_risk = 0.0
        if price_ratio > 0:
            try:
                il_factor = abs(2 * np.sqrt(price_ratio) / (1 + price_ratio) - 1)
                il_risk = min(il_factor / 0.1, 1.0)
            except Exception:
                il_risk = 0.0

        bounds_risk = 0.0
        if state.threshold_pct and state.threshold_pct > 0 and state.within_bounds is False:
            bounds_risk = min(_safe_division(price_dev - state.threshold_pct, state.threshold_pct, 0.0), 1.0)

        components = [0.25 * volatility_risk, 0.20 * price_risk, 0.20 * range_risk, 0.15 * il_risk, 0.10 * gas_risk, 0.10 * bounds_risk]
        risk_score = sum(components)
        risk_score = max(0.0, min(1.0, risk_score))

        if risk_score < 0.3:
            risk_level = 'low'
        elif risk_score < 0.6:
            risk_level = 'medium'
        else:
            risk_level = 'high'
        return risk_level, risk_score

    def should_execute(self, decision: Decision, state: MarketState) -> bool:
        if not decision or decision.action == 'hold':
            logger.debug('Decision is hold or invalid -> not executing')
            return False

        gas_price_gwei = UnitConverter.to_gwei(state.gas_price, state.gas_unit)
        reasons = []

        if gas_price_gwei > 200.0:
            reasons.append(f'gas_price_gwei_too_high:{gas_price_gwei:.1f}')

        position_value = self.calculate_position_value(state.position, state)
        if position_value <= 0:
            reasons.append('position_value_zero_or_missing')

        gas_cost_eth = self.calculate_gas_cost(state.gas_price, state.gas_unit, decision.action)
        if gas_cost_eth > self.max_gas_eth:
            reasons.append(f'gas_cost_eth_too_high:{gas_cost_eth:.6f}')

        gas_cost_pct = _safe_division(gas_cost_eth, position_value, 0.0) * 100.0 if position_value > 0 else float('inf')
        if gas_cost_pct > 12.5:
            reasons.append(f'gas_cost_pct_too_high:{gas_cost_pct:.3f}')

        if decision.risk_level == 'high' and decision.confidence < 0.8:
            reasons.append(f'high_risk_low_confidence:{decision.confidence:.3f}')

        if reasons:
            logger.warning('Execution blocked: ' + '; '.join(reasons))
            return False
        logger.info('All safety checks passed')
        return True


# ---------------------------
# AIEngine (enhanced)
# ---------------------------
class AIEngine:
    def __init__(self, model_path: Optional[str] = None, allow_unverified_model: bool = False):
        self.feature_eng = FeatureEngineering()
        self.ensemble: Optional[ModelEnsemble] = None
        self.risk_manager = RiskManager()
        self.decision_history = deque(maxlen=5000)
        self.converter = UnitConverter()
        self.pct = PercentageCalculator()
        self.allow_unverified_model = allow_unverified_model

        if model_path:
            self._safe_model_load(model_path)

        self.stats = {'total_decisions': 0, 'ml_decisions': 0, 'rule_decisions': 0, 'blocked_decisions': 0, 'errors': 0, 'actions': {'rebalance': 0, 'reduce': 0, 'hold': 0, 'close': 0}}
        self._recent_actions = deque(maxlen=20)

    def _safe_model_load(self, model_path: str):
        try:
            if Path(model_path).exists():
                self.ensemble = ModelEnsemble.load(model_path, allow_unverified=self.allow_unverified_model)
                logger.info('Pre-trained model loaded')
            else:
                logger.warning('Model file not found, using rule-based fallback')
        except Exception as e:
            logger.warning(f'Model loading failed: {e} — using rule-based fallback')
            self.ensemble = None

    def decide(self, state: MarketState) -> Decision:
        self.stats['total_decisions'] += 1
        try:
            self._validate_state(state)
            features = self.feature_eng.extract_features(state)

            if self.ensemble and self.ensemble.is_trained:
                try:
                    predicted_reward, uncertainty = self.ensemble.predict(features)
                    confidence = self._calculate_confidence(predicted_reward, uncertainty, state)
                    reason = 'ml_ensemble'
                    self.stats['ml_decisions'] += 1
                except Exception as e:
                    logger.warning(f'ML failed, fallback rules: {e}')
                    predicted_reward, confidence = self._heuristic_prediction(state, features)
                    reason = 'rule_fallback'
                    self.stats['rule_decisions'] += 1
            else:
                predicted_reward, confidence = self._heuristic_prediction(state, features)
                reason = 'rule_based'
                self.stats['rule_decisions'] += 1

            # risk + dynamic threshold
            risk_level, risk_score = self.risk_manager.assess_risk(state, predicted_reward)
            action = self._determine_action(predicted_reward, confidence, risk_level, state)
            recommended_params = self._generate_params(action, state) if action != 'hold' else None

            decision = Decision(action=action, confidence=float(np.clip(confidence, 0.0, 1.0)), score=float(predicted_reward), expected_reward=float(predicted_reward), reason=reason, risk_level=risk_level, recommended_params=recommended_params, metadata={'risk_score': risk_score, 'timestamp': state.timestamp, 'position_id': state.position.id, 'gas_price_gwei': UnitConverter.to_gwei(state.gas_price, state.gas_unit), 'position_value_eth': self.risk_manager.calculate_position_value(state.position, state), 'features_used': len(features)})

            # safety checks
            if not self.risk_manager.should_execute(decision, state):
                decision.action = 'hold'
                decision.reason += '_safety_blocked'
                decision.confidence = max(0.05, decision.confidence - 0.2)
                self.stats['blocked_decisions'] += 1

            self.stats['actions'][decision.action] = self.stats['actions'].get(decision.action, 0) + 1
            self._record_decision(state, decision)
            self._recent_actions.append(decision.action)

            # anti-bias: if same action repeated many times, reduce confidence
            if len(self._recent_actions) == self._recent_actions.maxlen:
                if len(set(self._recent_actions)) == 1:
                    decision.confidence *= 0.7

            logger.info(f"Decision: {decision.action} (conf={decision.confidence:.2f}, risk={risk_level})")
            return decision
        except Exception as e:
            self.stats['errors'] += 1
            logger.error(f"Decision error: {e}")
            return self._create_fallback_decision(str(e))

    def _validate_state(self, state: MarketState):
        if not state or not state.position:
            raise ValueError('Invalid state: missing position')
        # convert/validate
        # current_price should be numeric; use eth_price_usd for USD conversions
        eth_price_usd = state.extra.get('eth_price_usd')
        state.current_price = max(1e-9, UnitConverter.to_eth(state.current_price or 1.0, state.price_unit, eth_price_usd))
        state.pool_liquidity = max(CONFIG.MIN_POOL_LIQUIDITY, float(state.pool_liquidity or CONFIG.DEFAULT_POOL_LIQUIDITY))
        state.gas_price = float(state.gas_price or CONFIG.DEFAULT_GAS_GWEI)
        state.position.token0_balance = max(0.0, float(state.position.token0_balance or 0))
        state.position.token1_balance = max(0.0, float(state.position.token1_balance or 0))
        state.position.liquidity = max(0.0, float(state.position.liquidity or 0))

    def _calculate_confidence(self, reward: float, uncertainty: float, state: MarketState) -> float:
        base_conf = 1.0 / (1.0 + max(0.0, uncertainty))
        vol_24h = float(state.volatility_24h or 0.0)
        vol_factor = 1.0 - min(vol_24h / 1.0, 0.6)
        if reward > 0.01:
            reward_factor = min(reward / 0.05, 1.0)
        elif reward < -0.01:
            reward_factor = min(abs(reward) / 0.05, 1.0)
        else:
            reward_factor = 0.3
        confidence = base_conf * vol_factor * reward_factor
        return float(np.clip(confidence, 0.05, 0.95))

    def _heuristic_prediction(self, state: MarketState, features: np.ndarray) -> Tuple[float, float]:
        pos = state.position
        pos_val = self.risk_manager.calculate_position_value(pos, state)
        gas_cost_eth = self.risk_manager.calculate_gas_cost(state.gas_price, state.gas_unit, 'rebalance')
        gas_cost_pct = _safe_division(gas_cost_eth, pos_val, 0.0) * 100.0 if pos_val > 0 else float('inf')

        gas_price_gwei = UnitConverter.to_gwei(state.gas_price, state.gas_unit)
        if gas_price_gwei > 150.0 or gas_cost_pct > 12.5:
            return - (gas_cost_pct / 100.0), 0.9

        if (state.price_impact and isinstance(state.price_impact, str) and state.price_impact.lower() in ('high', 'very_high')):
            return -0.01, 0.7

        in_range = state.extra.get('inRange', True)
        rebalance_benefit = 0.0
        if state.within_bounds is False:
            deviation = state.deviation_pct or self.pct.compute_deviation_pct(state.current_price, state.twap_24h or state.current_price)
            rebalance_benefit = deviation * 0.8
        elif not in_range:
            current_tick = state.extra.get('currentTick', 0)
            tick_midpoint = (pos.upperTick + pos.lowerTick) / 2.0
            if tick_midpoint != 0:
                deviation = abs(current_tick - tick_midpoint) / abs(tick_midpoint) * 100.0
                rebalance_benefit = deviation * 0.5

        total_balance = (pos.token0_balance or 0) + (pos.token1_balance or 0)
        fee_benefit = 0.0
        if total_balance > 0:
            fee_rate = _safe_division(pos.fees_earned_0 + pos.fees_earned_1, total_balance, 0.0)
            volume_ratio = _safe_division(state.volume_24h, state.pool_liquidity, 0.0)
            fee_benefit = fee_rate * volume_ratio * 100.0

        price_ratio = _safe_division(state.current_price, state.twap_24h or state.current_price, 1.0)
        il_cost = 0.0
        if price_ratio > 0:
            try:
                il_factor = abs(2 * np.sqrt(price_ratio) / (1 + price_ratio) - 1)
                il_cost = il_factor * 100.0 * 0.5
            except Exception:
                pass

        predicted_pct = rebalance_benefit + fee_benefit - il_cost - gas_cost_pct

        vol_24h = float(state.volatility_24h or 0.0)
        if vol_24h >= 0.5:
            predicted_pct *= 0.4
            confidence_mult = 0.6
        elif vol_24h >= 0.35:
            predicted_pct *= 0.7
            confidence_mult = 0.8
        else:
            confidence_mult = 1.0

        predicted_reward = predicted_pct / 100.0
        signal_strength = min(abs(predicted_pct) / 10.0, 1.0)
        if state.within_bounds is False:
            signal_strength = min(signal_strength * 1.4, 1.0)

        confidence = signal_strength * confidence_mult
        return predicted_reward, float(np.clip(confidence, 0.05, 0.9))

    def _determine_action(self, reward: float, confidence: float, risk_level: str, state: MarketState) -> str:
        pos_val = self.risk_manager.calculate_position_value(state.position, state)

        # dynamic threshold: adapt to volatility and gas
        vol = float(state.volatility_24h or 0.0)
        gas_gwei = UnitConverter.to_gwei(state.gas_price, state.gas_unit)
        base_thresh = float(state.threshold_pct or 3.0)
        dynamic_thresh = base_thresh + vol * 5.0 + (gas_gwei / 1000.0)

        # fast rejects
        if gas_gwei > 120.0 or _safe_division(self.risk_manager.calculate_gas_cost(state.gas_price, state.gas_unit, 'rebalance'), pos_val, 0.0) * 100.0 > 12.5:
            return 'hold'

        if (state.price_impact and isinstance(state.price_impact, str) and state.price_impact.lower() in ('high', 'very_high') and pos_val < 5.0):
            return 'hold'

        in_range = state.extra.get('inRange', True)


        if state.within_bounds:
            pass
            # return 'hold'

        if confidence > 0.7:
            return 'rebalance'

        if confidence > 0.75 and reward > (dynamic_thresh / 100.0):
            return 'rebalance'
        if confidence > 0.8 and reward > 0.05 and risk_level != 'high':
            return 'rebalance'
        if not in_range and confidence > 0.5 and reward > 0.01:
            return 'rebalance'

        return 'hold'

    def _generate_params(self, action: str, state: MarketState) -> Dict:
        if action == 'rebalance':
            current_tick = state.extra.get('currentTick', 0)
            volatility = max(0.1, float(state.volatility_24h or 0.3))
            range_pct = (1.0 + volatility) * 5.0
            tick_range = int((range_pct / 100.0) * 2000)
            tick_spacing = CONFIG.TICK_SPACING_DEFAULT
            lower_tick = int(np.floor((current_tick - tick_range) / tick_spacing) * tick_spacing)
            upper_tick = int(np.ceil((current_tick + tick_range) / tick_spacing) * tick_spacing)
            return {'new_lower_tick': lower_tick, 'new_upper_tick': upper_tick, 'range_percentage': range_pct, 'current_tick': current_tick, 'reason': f'rebalance_±{range_pct:.1f}%'}
        elif action == 'reduce':
            return {'reduce_percentage': 0.5, 'reason': 'risk_mitigation'}
        elif action == 'close':
            return {'close_full_position': True, 'reason': 'high_risk_exit'}
        return {}

    def _create_fallback_decision(self, reason: str) -> Decision:
        return Decision(action='hold', confidence=0.05, score=0.0, expected_reward=0.0, reason=reason, risk_level='high', metadata={'fallback': True, 'error': True})

    def _record_decision(self, state: MarketState, decision: Decision):
        try:
            rec = {'timestamp': state.timestamp, 'pool_id': state.poolId, 'position_id': state.position.id, 'decision': asdict(decision), 'state_hash': hashlib.md5(f"{state.poolId}_{state.position.id}_{state.timestamp}".encode()).hexdigest()[:16]}
            self.decision_history.append(rec)
        except Exception as e:
            logger.debug(f'Failed to record decision: {e}')

    def train_from_history(self, history_path: str, output_model_path: str):
        if not HAS_ML:
            raise RuntimeError('ML not available')
        X_list, y_list = [], []
        logger.info(f'Training from {history_path}')
        with open(history_path, 'r') as f:
            for ln, line in enumerate(f, 1):
                try:
                    rec = json.loads(line)
                    reward = rec.get('reward') or rec.get('label')
                    if reward is None:
                        continue
                    state_data = rec.get('state', {})
                    pos_data = state_data.get('position', {})
                    position = Position(id=pos_data.get('id'), owner=pos_data.get('owner',''), lowerTick=pos_data.get('lowerTick',0), upperTick=pos_data.get('upperTick',0), liquidity=pos_data.get('liquidity',0), token0_balance=pos_data.get('token0_balance',0), token1_balance=pos_data.get('token1_balance',0), fees_earned_0=pos_data.get('fees_earned_0',0), fees_earned_1=pos_data.get('fees_earned_1',0), age_seconds=pos_data.get('age_seconds',0))
                    state = MarketState(timestamp=state_data.get('timestamp', time.time()), poolId=state_data.get('poolId',''), current_price=state_data.get('current_price') or state_data.get('price',0), price_unit=state_data.get('price_unit','eth'), twap_1h=state_data.get('twap_1h',0), twap_24h=state_data.get('twap_24h',0), volatility_1h=state_data.get('volatility_1h',0.2), volatility_24h=state_data.get('volatility_24h',0.3), pool_liquidity=state_data.get('pool_liquidity',0), volume_24h=state_data.get('volume_24h',0), gas_price=state_data.get('gas_price',50), gas_unit=state_data.get('gas_unit','gwei'), position=position, extra=state_data.get('extra',{}), deviation_pct=state_data.get('deviation_pct'), threshold_pct=state_data.get('threshold_pct'), within_bounds=state_data.get('within_bounds'), price_impact=state_data.get('price_impact'))
                    features = self.feature_eng.extract_features(state)
                    X_list.append(features)
                    y_list.append(float(reward))
                except Exception as e:
                    logger.debug(f'Skipped line {ln}: {e}')
                    continue
        if len(X_list) < 50:
            raise ValueError(f'Need at least 50 samples, got {len(X_list)}')
        X, y = np.array(X_list), np.array(y_list)
        self.ensemble = ModelEnsemble()
        self.ensemble.train(X, y)
        self.ensemble.save(output_model_path)
        logger.info(f'Training complete -> {output_model_path}')

    def get_stats(self) -> Dict:
        total = self.stats['total_decisions']
        return {**self.stats, 'ml_usage_pct': (self.stats['ml_decisions']/total*100) if total>0 else 0, 'block_rate_pct': (self.stats['blocked_decisions']/total*100) if total>0 else 0, 'error_rate_pct': (self.stats['errors']/total*100) if total>0 else 0, 'has_ml_model': self.ensemble is not None and self.ensemble.is_trained, 'recent_decisions': len(self.decision_history)}


# Convenience factory

def create_engine(model_path: Optional[str] = None, allow_unverified_model: bool = False) -> AIEngine:
    return AIEngine(model_path=model_path, allow_unverified_model=allow_unverified_model)


# ---------------------------
# TRAINING & UTILITY FUNCTIONS
# ---------------------------

def train_model(history_path: str, output_path: str, model_types: List[str] = None):
    """
    Convenience function to train model from historical data
    
    Args:
        history_path: Path to NDJSON training data file
        output_path: Path to save the trained model
        model_types: List of model types to train ['rf', 'gbm', 'xgb']
    
    Raises:
        RuntimeError: If ML libraries not available
        ValueError: If insufficient training data
        FileNotFoundError: If history file doesn't exist
    
    Example:
        >>> train_model('data/training_log.ndjson', 'data/models/model.joblib')
    """
    if not HAS_ML:
        raise RuntimeError("❌ ML libraries not available. Install: pip install scikit-learn xgboost joblib")
    
    history_file = Path(history_path)
    if not history_file.exists():
        raise FileNotFoundError(f"❌ Training data file not found: {history_path}")
    
    logger.info("=" * 60)
    logger.info("🎓 MODEL TRAINING STARTED")
    logger.info("=" * 60)
    logger.info(f"📂 Input: {history_path}")
    logger.info(f"💾 Output: {output_path}")
    
    # Create engine instance
    engine = AIEngine()
    
    # Train using engine's method
    try:
        engine.train_from_history(history_path, output_path)
        logger.info("=" * 60)
        logger.info("✅ MODEL TRAINING COMPLETE")
        logger.info("=" * 60)
    except Exception as e:
        logger.error("=" * 60)
        logger.error("❌ MODEL TRAINING FAILED")
        logger.error("=" * 60)
        raise


def validate_training_data(history_path: str) -> Dict[str, Any]:
    """
    Validate training data file before training
    
    Args:
        history_path: Path to NDJSON training data
    
    Returns:
        Dict with validation results and statistics
    """
    if not Path(history_path).exists():
        return {
            'valid': False,
            'error': f"File not found: {history_path}"
        }
    
    total_records = 0
    valid_records = 0
    errors = []
    
    try:
        with open(history_path, 'r') as f:
            for line_num, line in enumerate(f, 1):
                if not line.strip():
                    continue
                
                total_records += 1
                
                try:
                    record = json.loads(line)
                    
                    # Check required fields
                    if 'reward' not in record and 'label' not in record:
                        errors.append(f"Line {line_num}: missing reward/label")
                        continue
                    
                    if 'state' not in record:
                        errors.append(f"Line {line_num}: missing state")
                        continue
                    
                    valid_records += 1
                    
                except json.JSONDecodeError:
                    errors.append(f"Line {line_num}: invalid JSON")
                    continue
    
    except Exception as e:
        return {
            'valid': False,
            'error': str(e)
        }
    
    valid = valid_records >= 50  # Minimum required
    
    return {
        'valid': valid,
        'total_records': total_records,
        'valid_records': valid_records,
        'error_count': len(errors),
        'errors': errors[:10],  # First 10 errors
        'message': f"✅ Ready for training" if valid else f"❌ Need at least 50 valid records (have {valid_records})"
    }


# ---------------------------
# EXPORTS
# ---------------------------

__all__ = [
    'AIEngine', 
    'Position', 
    'MarketState', 
    'Decision',
    'UnitConverter', 
    'PercentageCalculator', 
    'FeatureEngineering', 
    'ModelEnsemble', 
    'RiskManager', 
    'create_engine', 
    'train_model',  # ✅ Export train_model
    'validate_training_data'  # ✅ Bonus utility
]