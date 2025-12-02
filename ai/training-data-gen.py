#!/usr/bin/env python3
"""
🎲 Synthetic Training Data Generator v2.2
- Updated to match ai_engine.py (20 features, explicit units)
- Fixed: Gas cost counted only once in reward (net_reward already includes gas)
- Emits records compatible with auto_retrain.prepare_training_data()
"""

import json
import random
import time
import math
import numpy as np
from pathlib import Path
from dataclasses import dataclass
from typing import Dict, List, Tuple


@dataclass
class MarketRegime:
    name: str
    volatility_range: Tuple[float, float]
    deviation_mult: Tuple[float, float]
    gas_range: Tuple[float, float]
    volume_mult: Tuple[float, float]
    weight: float


REGIMES = [
    MarketRegime('calm', (0.01, 0.05), (0.1, 0.5), (10, 30), (0.001, 0.01), 0.30),
    MarketRegime('normal', (0.05, 0.15), (0.3, 1.0), (20, 60), (0.005, 0.03), 0.40),
    MarketRegime('volatile', (0.15, 0.35), (0.8, 2.0), (40, 120), (0.02, 0.08), 0.20),
    MarketRegime('extreme', (0.35, 0.80), (1.5, 4.0), (80, 300), (0.05, 0.15), 0.10),
]

LEVELS = {
    0: {'name': 'L1', 'threshold_bps': 100, 'threshold_pct': 1.0},
    1: {'name': 'L5', 'threshold_bps': 500, 'threshold_pct': 5.0},
    2: {'name': 'L10', 'threshold_bps': 1000, 'threshold_pct': 10.0},
    3: {'name': 'L20', 'threshold_bps': 2000, 'threshold_pct': 20.0},
}


class ImprovedTrainingDataGenerator:
    def __init__(self, output_dir: str = './data', seed: int = None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        if seed is None:
            seed = int(time.time())
        self.seed = seed
        random.seed(seed)
        np.random.seed(seed)
        print(f"🎲 Using seed: {seed}")

    def generate_dataset(self, num_samples: int = 5000, rebalance_ratio: float = 0.4) -> str:
        print(f"🎲 Generating {num_samples} samples...")
        output_file = self.output_dir / 'training_log.ndjson'
        num_rebalance = int(num_samples * rebalance_ratio)
        num_hold = num_samples - num_rebalance

        samples = []
        for i in range(num_rebalance):
            samples.append(self._generate_rebalance_sample())
            if (i + 1) % 500 == 0:
                print(f"   ✓ {i + 1}/{num_rebalance} rebalance")

        for i in range(num_hold):
            samples.append(self._generate_hold_sample())
            if (i + 1) % 500 == 0:
                print(f"   ✓ {i + 1}/{num_hold} hold")

        random.shuffle(samples)

        # Validate a few
        validation_errors = 0
        for i, sample in enumerate(samples[:10]):
            issues = validate_compatibility(sample)
            if issues:
                validation_errors += 1
                print(f"   ⚠️ Sample {i}: {issues[:3]}")
        if validation_errors == 0:
            print("   ✓ Sample validation passed (first 10)")

        with open(output_file, 'w') as f:
            for sample in samples:
                f.write(json.dumps(sample) + '\n')

        print(f"\n✅ Generated {len(samples)} samples -> {output_file}")
        self._print_statistics(samples)
        return str(output_file)

    def _sample_regime(self) -> MarketRegime:
        weights = [r.weight for r in REGIMES]
        return random.choices(REGIMES, weights=weights)[0]

    def _generate_correlated_market(self, regime: MarketRegime, level: int) -> Dict:
        level_cfg = LEVELS[level]
        vol_24h = random.uniform(*regime.volatility_range)
        vol_1h = vol_24h * random.uniform(0.6, 1.4)
        gas_base = random.uniform(*regime.gas_range)
        gas_spike = 1.0 + (vol_24h * random.uniform(0, 2))
        gas_price_gwei = gas_base * gas_spike
        p_ref = random.uniform(1500, 4500)
        dev_mult = random.uniform(*regime.deviation_mult)
        return {
            'vol_1h': vol_1h,
            'vol_24h': vol_24h,
            'gas_price_gwei': gas_price_gwei,
            'p_ref': p_ref,
            'threshold_pct': level_cfg['threshold_pct'],
            'threshold_bps': level_cfg['threshold_bps'],
            'dev_mult': dev_mult,
            'volume_mult': random.uniform(*regime.volume_mult),
        }

    def _generate_rebalance_sample(self) -> Dict:
        regime = self._sample_regime()
        level = random.randint(0, 3)
        market = self._generate_correlated_market(regime, level)

        threshold_pct = market['threshold_pct']
        min_deviation = threshold_pct * 1.05
        max_deviation = threshold_pct * max(1.1, market['dev_mult'])
        deviation_pct = random.uniform(min_deviation, max_deviation)
        deviation_bps = int(deviation_pct * 100)
        p_ref = market['p_ref']
        direction = random.choice([-1, 1])
        p_now = p_ref * (1 + direction * deviation_pct / 100)

        position_value_eth = random.uniform(0.5, 20.0)
        liquidity = position_value_eth * 1e18
        pool_liquidity = liquidity * random.uniform(100, 10000)
        current_tick = int(np.log(max(p_now, 1e-12) / 1e12) / np.log(1.0001)) if p_now > 0 else 0
        tick_width = random.randint(1000, 8000)
        in_range_before = random.random() < 0.2

        gas_price_gwei = market['gas_price_gwei']
        gas_cost_eth = (gas_price_gwei * 500_000) / 1e9
        gas_cost_pct = (gas_cost_eth / position_value_eth) * 100 if position_value_eth > 0 else 0.0

        reward_components = self._calculate_reward(
            deviation_pct=deviation_pct,
            threshold_pct=threshold_pct,
            vol_24h=market['vol_24h'],
            in_range_before=in_range_before,
            gas_cost_eth=gas_cost_eth,
            position_value_eth=position_value_eth,
            action='rebalance',
            pool_volume_24h=pool_liquidity * market['volume_mult'] * 10,
            pool_tvl=pool_liquidity,
            fee_tier=3000,
            tick_width=tick_width
        )

        net_reward = reward_components['net_reward']

        # Compose features including the 20 requested feature names (approximate)
        # These are helpful for retraining and for downstream model extraction
        position_in_range = 1.0 if in_range_before else 0.0
        denom_lower = max(abs(current_tick - (current_tick - tick_width // 2)), 1.0)
        dist_to_lower = min(1.0, abs(0) / denom_lower)  # placeholder (detailed tick math not needed)
        denom_upper = max(abs((current_tick + tick_width // 2) - current_tick), 1.0)
        dist_to_upper = min(1.0, abs(0) / denom_upper)

        liquidity_util = (liquidity / pool_liquidity) if pool_liquidity > 0 else 0.0
        total_value_normalized = position_value_eth / 1e6
        vol_24h = market['vol_24h']
        vol_1h = market['vol_1h']
        volatility_ratio = vol_1h / vol_24h if vol_24h > 0 else 1.0
        total_fees = (position_value_eth * random.uniform(0, 0.03))
        fee_rate = total_fees / max(1e-9, position_value_eth)
        price_ratio = max(1e-9, (p_now / p_ref))
        il_factor = abs(2.0 * np.sqrt(price_ratio) / (1.0 + price_ratio) - 1.0) if price_ratio > 0 else 0.0
        pool_liquidity_normalized = pool_liquidity / 1e24
        volume_per_liquidity = (pool_liquidity * market['volume_mult']) / pool_liquidity if pool_liquidity > 0 else 0.0
        concentration_risk = liquidity_util * (1.0 - position_in_range)
        range_risk = 0.0
        try:
            tick_midpoint = (current_tick + (current_tick - tick_width)) / 2.0
            range_denom = tick_width / max(abs(tick_midpoint), 1.0)
            range_risk = min(1.0, 1.0 / range_denom) if range_denom != 0 else 0.0
        except Exception:
            range_risk = 0.0
        gas_normalized = min((gas_cost_eth / 0.1), 1.0)
        deviation_severity = max(0.0, (deviation_pct - threshold_pct) / threshold_pct) if threshold_pct > 0 else 0.0
        threshold_ratio = (deviation_pct / threshold_pct) if threshold_pct > 0 else 0.0
        rebalance_urgency = min(deviation_pct / 20.0, 1.0)

    # Build features dict (includes both legacy-style and new 20 features)
        features = {
            # legacy-ish
            'deviation_pct': deviation_pct,
            'threshold_pct': threshold_pct,
            'is_out_of_bounds': True,
            'price_vs_twap_24h': p_now / p_ref,
            'price_vs_twap_1h': p_now / (p_ref * random.uniform(0.98, 1.02)),
            'position_value_eth': position_value_eth,
            'fees_accumulated_eth': total_fees,
            'gas_price_gwei': gas_price_gwei,
            'gas_cost_pct': gas_cost_pct,
            'in_range_before': in_range_before,
            'tick_width': tick_width,

            # VOLATILITY fields (fix: add volatility_1h)
            'volatility_1h': vol_1h,
            'volatility_24h': vol_24h,

            # approx 20-feature mapping (FeatureEngineering.get_feature_names)
            'price_dev_24h': deviation_pct,
            'price_dev_ref': deviation_pct,
            'price_ratio_ref': price_ratio,
            'current_deviation': deviation_pct,
            'within_bounds': 0.0,
            'position_in_range': position_in_range,
            'dist_to_lower': dist_to_lower,
            'dist_to_upper': dist_to_upper,
            'liquidity_util': liquidity_util,
            'total_value_normalized': total_value_normalized,
            'volatility_ratio': volatility_ratio,
            'fee_rate': fee_rate,
            'il_factor': il_factor,
            'pool_liquidity_normalized': pool_liquidity_normalized,
            'volume_per_liquidity': volume_per_liquidity,
            'concentration_risk': concentration_risk,
            'range_risk': range_risk,
            'gas_normalized': gas_normalized,
            'rebalance_urgency': rebalance_urgency,
        }


        outcome = {
            'tick_shift': int(deviation_pct * 100 * direction),
            'width_change': random.randint(-500, 500),
            'range_improved': not in_range_before,
            'in_range_after': True,
            'gas_cost_eth': gas_cost_eth,
            'slippage_cost_eth': reward_components['slippage_cost'],
            'il_cost_eth': reward_components['il_cost'],
            'total_cost_eth': reward_components['total_cost'],
            'fee_improvement_eth': reward_components['fee_improvement'],
            'range_improvement_eth': reward_components['range_improvement'],
            'centering_benefit_eth': reward_components['centering_benefit'],
            'total_benefit_eth': reward_components['total_benefit'],
            'net_reward_eth': net_reward,
            'roi_pct': (net_reward / position_value_eth) * 100 if position_value_eth > 0 else 0.0,
            'value_change_eth': reward_components['value_change'],
            'fees_earned_eth': reward_components['fees_earned'],
        }

        extra = {
            'inRange': in_range_before,
            'currentTick': current_tick,
            'p_ref': p_ref,
            'p_now': p_now,
            'deviation_bps': deviation_bps,
            'threshold_bps': market['threshold_bps'],
            'is_out_of_bounds': True,
            'decimals0': 18,
            'decimals1': 6,
            'poolAddress': f"0x{''.join(random.choices('0123456789abcdef', k=40))}",
        }

        position = {
            'id': random.randint(1000, 9999),
            'owner': f"0x{''.join(random.choices('0123456789abcdef', k=40))}",
            'level': level,
            'lowerTick': current_tick - tick_width // 2,
            'upperTick': current_tick + tick_width // 2,
            'liquidity': liquidity,
            'token0_balance': position_value_eth / 2,
            'token1_balance': position_value_eth / 2,
            'fees_earned_0': total_fees / 2,
            'fees_earned_1': total_fees / 2,
            'age_seconds': random.randint(3600, 86400 * 30),
        }

        context = {
            'poolId': f"0x{''.join(random.choices('0123456789abcdef', k=64))}",
            'currentPrice': p_now,
            'deviation_pct': deviation_pct,
            'threshold_pct': threshold_pct,
            'within_bounds': False,
            'volatility_24h': market['vol_24h'],
            'gas_price_gwei': gas_price_gwei,
            'pool_liquidity': pool_liquidity,
            'volume_24h': pool_liquidity * market['volume_mult'],
        }

        record = {
            'timestamp': time.time() - random.randint(0, 86400 * 30),
            'action': 'rebalance',
            'executed': True,
            'scenario': regime.name,
            'level': level,
            'features': features,
            'outcome': outcome,
            'context': context,
            'position': position,
            'extra': extra,
            'reposition_context': {
                'level': level,
                'p_ref': p_ref,
                'p_now': p_now,
                'deviation_bps': deviation_bps,
                'threshold_bps': market['threshold_bps'],
            },
            # explicit units expected by auto_retrain and ai_engine
            'price_unit': 'eth',
            'gas_unit': 'gwei',
            'label': {
                'action': 'rebalance',
                'net_reward': net_reward,
                'was_profitable': net_reward > 0,
                'reward_score': self._score_reward(net_reward, True),
            }
        }
        return record

    def _generate_hold_sample(self) -> Dict:
        regime = self._sample_regime()
        level = random.randint(0, 3)
        market = self._generate_correlated_market(regime, level)
        threshold_pct = market['threshold_pct']

        if random.random() < 0.8:
            deviation_pct = random.uniform(0, threshold_pct * 0.7)
        else:
            deviation_pct = random.uniform(threshold_pct * 0.7, threshold_pct * 0.95)
        deviation_bps = int(deviation_pct * 100)
        p_ref = market['p_ref']
        direction = random.choice([-1, 1])
        p_now = p_ref * (1 + direction * deviation_pct / 100)

        position_value_eth = random.uniform(0.5, 20.0)
        liquidity = position_value_eth * 1e18
        pool_liquidity = liquidity * random.uniform(100, 10000)
        current_tick = int(np.log(max(p_now, 1e-12) / 1e12) / np.log(1.0001)) if p_now > 0 else 0
        tick_width = random.randint(1000, 8000)
        in_range = random.random() < 0.85

        gas_price_gwei = market['gas_price_gwei']
        gas_cost_eth = (gas_price_gwei * 500_000) / 1e9

        counterfactual = self._calculate_reward(
            deviation_pct=deviation_pct,
            threshold_pct=threshold_pct,
            vol_24h=market['vol_24h'],
            in_range_before=in_range,
            gas_cost_eth=gas_cost_eth,
            position_value_eth=position_value_eth,
            action='rebalance',
            pool_volume_24h=pool_liquidity * market['volume_mult'] * 10,
            pool_tvl=pool_liquidity,
            fee_tier=3000,
            tick_width=tick_width
        )
        counterfactual_net = counterfactual['net_reward']

        fee_rate = 3000 / 1_000_000
        daily_pool_fees = pool_liquidity * market['volume_mult'] * 10 * fee_rate
        liquidity_share = position_value_eth / pool_liquidity if pool_liquidity > 0 else 0.0
        concentration_factor = 4000 / max(tick_width, 100)
        concentration_factor = min(concentration_factor, 10)
        if in_range:
            pre_fees = daily_pool_fees * liquidity_share * concentration_factor * 0.5
            post_fees = daily_pool_fees * liquidity_share * concentration_factor
            hold_fees = pre_fees
        else:
            hold_fees = 0.0

        price_ratio = 1 + (deviation_pct / 100)
        standard_il = abs(2 * math.sqrt(price_ratio) / (1 + price_ratio) - 1) if price_ratio > 0 else 0.0
        range_factor = 4000 / max(tick_width, 100)
        hold_il = position_value_eth * standard_il * min(range_factor, 5)

        hold_reward = hold_fees - hold_il
        hold_was_correct = hold_reward >= counterfactual_net

        extra = {
            'inRange': in_range,
            'currentTick': current_tick,
            'p_ref': p_ref,
            'p_now': p_now,
            'deviation_bps': deviation_bps,
            'threshold_bps': market['threshold_bps'],
            'is_out_of_bounds': False,
        }

        context = {
            'poolId': f"0x{''.join(random.choices('0123456789abcdef', k=64))}",
            'currentPrice': p_now,
            'deviation_pct': deviation_pct,
            'threshold_pct': threshold_pct,
            'within_bounds': True,
            'volatility_24h': market['vol_24h'],
            'gas_price_gwei': gas_price_gwei,
            'in_range': in_range,
            'pool_liquidity': pool_liquidity,
            'volume_24h': pool_liquidity * market['volume_mult'],
        }

        position = {
            'id': random.randint(1000, 9999),
            'owner': f"0x{''.join(random.choices('0123456789abcdef', k=40))}",
            'level': level,
            'lowerTick': current_tick - tick_width // 2,
            'upperTick': current_tick + tick_width // 2,
            'liquidity': liquidity,
            'token0_balance': position_value_eth / 2,
            'token1_balance': position_value_eth / 2,
            'fees_earned_0': hold_fees / 2,
            'fees_earned_1': hold_fees / 2,
            'age_seconds': random.randint(3600, 86400 * 30),
        }

        features = {
            'deviation_pct': deviation_pct,
            'threshold_pct': threshold_pct,
            'is_out_of_bounds': False,
            'price_dev_ref': deviation_pct,
            'price_ratio_ref': p_now / p_ref if p_ref else 1.0,
            'level_encoded': [0.25, 0.5, 0.75, 1.0][level],
            'volatility_1h': market['vol_1h'],
            'volatility_24h': market['vol_24h'],
            'in_range_before': in_range,
            'position_value_eth': position_value_eth,
            'gas_price_gwei': gas_price_gwei,
            'gas_cost_pct': (gas_cost_eth / position_value_eth) * 100 if position_value_eth > 0 else 0.0
        }

        record = {
            'timestamp': time.time() - random.randint(0, 86400 * 30),
            'action': 'hold',
            'executed': False,
            'scenario': regime.name,
            'level': level,
            'features': features,
            'context': context,
            'position': position,
            'extra': extra,
            'decision': {
                'confidence': random.uniform(0.5, 0.85),
                'expectedReward': hold_reward,
                'riskLevel': 'low' if deviation_pct < threshold_pct * 0.5 else 'medium',
                'reason': 'within_bounds' if deviation_pct < threshold_pct else 'borderline_hold',
            },
            'reposition_context': {
                'level': level,
                'p_ref': p_ref,
                'p_now': p_now,
                'deviation_bps': deviation_bps,
                'threshold_bps': market['threshold_bps'],
            },
            'price_unit': 'eth',
            'gas_unit': 'gwei',
            'counterfactual': {
                'rebalance_reward': counterfactual_net,
                'hold_reward': hold_reward,
                'hold_was_correct': hold_was_correct,
            },
            'label': {
                'action': 'hold',
                'confidence': random.uniform(0.5, 0.85),
                'was_correct': hold_was_correct,
                'net_reward': hold_reward
            }
        }
        return record

    def _calculate_reward(
        self,
        deviation_pct: float,
        threshold_pct: float,
        vol_24h: float,
        in_range_before: bool,
        gas_cost_eth: float,
        position_value_eth: float,
        action: str,
        pool_volume_24h: float = None,
        pool_tvl: float = None,
        fee_tier: int = 3000,
        tick_width: int = 2000
    ) -> Dict[str, float]:
        if pool_volume_24h is None:
            pool_volume_24h = position_value_eth * random.uniform(1000, 10000)
        if pool_tvl is None:
            pool_tvl = position_value_eth * random.uniform(100, 5000)

        fee_rate = fee_tier / 1_000_000
        pool_daily_fees = pool_volume_24h * fee_rate
        liquidity_share = position_value_eth / pool_tvl if pool_tvl > 0 else 0
        concentration_factor = 4000 / max(tick_width, 100)
        concentration_factor = min(concentration_factor, 10)

        if in_range_before:
            pre_fees = pool_daily_fees * liquidity_share * concentration_factor * 0.5
            post_fees = pool_daily_fees * liquidity_share * concentration_factor
            fee_improvement = post_fees - pre_fees
        else:
            pre_fees = 0.0
            post_fees = pool_daily_fees * liquidity_share * concentration_factor
            fee_improvement = post_fees

        price_ratio = 1 + (deviation_pct / 100)
        standard_il = abs(2 * math.sqrt(price_ratio) / (1 + price_ratio) - 1) if price_ratio > 0 else 0.0
        range_factor = 4000 / max(tick_width, 100)
        amplified_il = standard_il * min(range_factor, 5)
        il_cost = position_value_eth * amplified_il

        size_ratio = position_value_eth / pool_tvl if pool_tvl > 0 else 0.01
        base_slippage_bps = 10
        size_slippage_bps = size_ratio * 1000
        total_slippage_bps = base_slippage_bps + size_slippage_bps
        slippage_cost = position_value_eth * (total_slippage_bps / 10000) * 2

        range_improvement = post_fees if not in_range_before else 0.0
        excess_deviation = max(0, deviation_pct - threshold_pct)
        centering_benefit = position_value_eth * (excess_deviation / 100) * 0.1

        noise_std = vol_24h * position_value_eth * 0.05
        vol_noise = np.random.normal(0, noise_std)

        total_benefit = fee_improvement + range_improvement + centering_benefit

        # gas included once in total_cost
        total_cost = gas_cost_eth + slippage_cost + il_cost

        expected = total_benefit - total_cost
        actual = expected + vol_noise
        net_reward = actual

        return {
            'fee_improvement': fee_improvement,
            'range_improvement': range_improvement,
            'centering_benefit': centering_benefit,
            'total_benefit': total_benefit,
            'gas_cost': gas_cost_eth,
            'slippage_cost': slippage_cost,
            'il_cost': il_cost,
            'total_cost': total_cost,
            'expected': expected,
            'actual': actual,
            'net_reward': net_reward,
            'value_change': centering_benefit,
            'fees_earned': fee_improvement + range_improvement,
        }

    def _score_reward(self, net_reward: float, range_improved: bool) -> float:
        score = 0.5
        if net_reward > 0:
            score += min(0.3, net_reward * 5)
        else:
            score -= min(0.3, abs(net_reward) * 5)
        if range_improved:
            score += 0.2
        return max(0.0, min(1.0, score))

    def _print_statistics(self, samples: List[Dict]):
        rebalances = [s for s in samples if s['action'] == 'rebalance']
        holds = [s for s in samples if s['action'] == 'hold']
        print(f"\n{'='*60}\n📊 DATASET STATISTICS\n{'='*60}")
        if rebalances:
            profitable = [r for r in rebalances if r.get('label', {}).get('was_profitable')]
            rewards = [r.get('label', {}).get('net_reward', 0.0) for r in rebalances]
            print(f"\n🔄 Rebalance: {len(rebalances)} | Profitable: {len(profitable)} ({len(profitable)/len(rebalances)*100:.1f}%)")
            print(f"   Avg Reward: {np.mean(rewards):.6f} ETH | Std: {np.std(rewards):.6f} ETH")
            print(f"   Min: {np.min(rewards):.6f} | Max: {np.max(rewards):.6f}")
        if holds:
            correct_holds = [h for h in holds if h.get('label', {}).get('was_correct')]
            print(f"\n⏸️ Hold: {len(holds)} | Correct holds: {len(correct_holds)} ({len(correct_holds)/len(holds)*100:.1f}%)")

def validate_compatibility(sample: Dict) -> List[str]:
    issues = []
    required_top = ['timestamp', 'action', 'label']
    for field in required_top:
        if field not in sample:
            issues.append(f"Missing top-level field: {field}")

    if sample.get('action') == 'rebalance':
        if 'features' not in sample:
            issues.append("Rebalance sample missing 'features'")
        else:
            f = sample['features']
            required_features = [
                'deviation_pct', 'threshold_pct', 'is_out_of_bounds',
                'volatility_1h', 'volatility_24h', 'position_value_eth',
                'gas_price_gwei', 'in_range_before'
            ]
            for rf in required_features:
                if rf not in f:
                    issues.append(f"Missing feature: {rf}")
        if 'outcome' not in sample:
            issues.append("Rebalance sample missing 'outcome'")
        if 'label' in sample:
            lbl = sample['label']
            if 'net_reward' not in lbl:
                issues.append("Label missing 'net_reward'")

    if 'extra' in sample:
        extra = sample['extra']
        required_extra = ['inRange', 'currentTick', 'p_ref', 'p_now', 'deviation_bps', 'threshold_bps', 'is_out_of_bounds']
        for re in required_extra:
            if re not in extra:
                issues.append(f"Missing extra field: {re}")
    else:
        issues.append("Missing 'extra' context")

    if 'position' in sample:
        pos = sample['position']
        if 'level' not in pos:
            issues.append("Position missing 'level' field")
        if 'lowerTick' not in pos or 'upperTick' not in pos:
            issues.append("Position missing tick fields")
    else:
        issues.append("Missing 'position'")

    if 'reposition_context' not in sample:
        issues.append("Missing 'reposition_context'")
    else:
        rc = sample['reposition_context']
        required_rc = ['level', 'p_ref', 'p_now', 'deviation_bps', 'threshold_bps']
        for rrc in required_rc:
            if rrc not in rc:
                issues.append(f"Missing reposition_context field: {rrc}")

    return issues

def main():
    import argparse
    parser = argparse.ArgumentParser(description='🎲 Generate Training Data v2.2')
    parser.add_argument('--samples', type=int, default=5000)
    parser.add_argument('--rebalance-ratio', type=float, default=0.4)
    parser.add_argument('--output-dir', default='./data')
    parser.add_argument('--seed', type=int, default=None)
    parser.add_argument('--validate', type=str, help='Validate an existing file')
    args = parser.parse_args()

    if args.validate:
        print(f"🔍 Validating {args.validate}")
        total = errors = 0
        with open(args.validate, 'r') as f:
            for line in f:
                total += 1
                try:
                    sample = json.loads(line)
                except Exception:
                    errors += 1
                    continue
                issues = validate_compatibility(sample)
                if issues:
                    errors += 1
                    if errors <= 5:
                        print(f"   ⚠️ Line {total}: {issues[:2]}")
        pct = ((total - errors) / total * 100) if total > 0 else 0
        print(f"\n✅ Validated {total} samples: {total-errors} OK ({pct:.1f}%), {errors} errors")
        return

    print("="*60)
    print("🎲 SYNTHETIC TRAINING DATA GENERATOR v2.2")
    print("="*60)
    generator = ImprovedTrainingDataGenerator(output_dir=args.output_dir, seed=args.seed)
    output_file = generator.generate_dataset(num_samples=args.samples, rebalance_ratio=args.rebalance_ratio)
    print(f"\n📁 Output: {output_file}")
    print("Next: inspect samples, then run retrainer (python auto_retrain.py --force)")

if __name__ == '__main__':
    main()
