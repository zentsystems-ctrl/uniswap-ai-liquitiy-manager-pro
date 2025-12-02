#!/usr/bin/env python3
"""
💰 Accurate Reward Calculator for Uniswap V3 Positions - FIXED VERSION
Based on actual DeFi economics with proper error handling
"""

import math
import numpy as np
from dataclasses import dataclass
from typing import Dict, Optional, Tuple


@dataclass
class PositionState:
    """Position state at a point in time"""
    lower_tick: int
    upper_tick: int
    liquidity: float
    token0_balance: float  # in token units
    token1_balance: float
    current_tick: int
    current_price: float  # token1/token0
    fees_earned_0: float = 0.0
    fees_earned_1: float = 0.0


@dataclass 
class PoolState:
    """Pool state for calculations"""
    fee_tier: int  # 500, 3000, 10000 (bps)
    volume_24h: float  # in USD or ETH
    tvl: float  # total value locked
    token0_decimals: int = 18
    token1_decimals: int = 6
    active_liquidity_ratio: float = 0.3  # ✅ NEW: assume 30% of TVL is active


class UniswapV3Math:
    """Core Uniswap V3 mathematical functions"""
    
    Q96 = 2 ** 96
    MIN_TICK = -887272
    MAX_TICK = 887272
    
    @staticmethod
    def tick_to_price(tick: int) -> float:
        """Convert tick to price (token1/token0)"""
        try:
            # Clamp tick to valid range
            tick = max(UniswapV3Math.MIN_TICK, min(UniswapV3Math.MAX_TICK, tick))
            return 1.0001 ** tick
        except (OverflowError, ValueError):
            return 1.0
    
    @staticmethod
    def price_to_tick(price: float) -> int:
        """Convert price to tick"""
        if price <= 0:
            return 0
        try:
            tick = int(math.floor(math.log(price) / math.log(1.0001)))
            return max(UniswapV3Math.MIN_TICK, min(UniswapV3Math.MAX_TICK, tick))
        except (ValueError, OverflowError):
            return 0
    
    @staticmethod
    def tick_to_sqrt_price(tick: int) -> float:
        """Convert tick to sqrt price"""
        try:
            tick = max(UniswapV3Math.MIN_TICK, min(UniswapV3Math.MAX_TICK, tick))
            return 1.0001 ** (tick / 2)
        except (OverflowError, ValueError):
            return 1.0
    
    @staticmethod
    def get_amounts_for_liquidity(
        liquidity: float,
        sqrt_price_current: float,
        sqrt_price_lower: float,
        sqrt_price_upper: float
    ) -> Tuple[float, float]:
        """
        Calculate token amounts for a given liquidity
        Returns (amount0, amount1)
        """
        if liquidity <= 0 or sqrt_price_lower <= 0 or sqrt_price_upper <= 0:
            return 0.0, 0.0
        
        if sqrt_price_upper <= sqrt_price_lower:
            return 0.0, 0.0
        
        try:
            if sqrt_price_current <= sqrt_price_lower:
                # Below range - all token0
                amount0 = liquidity * (1/sqrt_price_lower - 1/sqrt_price_upper)
                amount1 = 0
            elif sqrt_price_current >= sqrt_price_upper:
                # Above range - all token1
                amount0 = 0
                amount1 = liquidity * (sqrt_price_upper - sqrt_price_lower)
            else:
                # In range - mix of both
                amount0 = liquidity * (1/sqrt_price_current - 1/sqrt_price_upper)
                amount1 = liquidity * (sqrt_price_current - sqrt_price_lower)
            
            return max(0, amount0), max(0, amount1)
        except (ZeroDivisionError, OverflowError, ValueError):
            return 0.0, 0.0


class RewardCalculator:
    """
    💰 Accurate reward calculation for rebalancing decisions - FIXED
    """
    
    def __init__(self, token1_price_usd: float = 1.0):
        """
        Args:
            token1_price_usd: Price of token1 in USD (e.g., 1.0 for USDC)
        """
        self.math = UniswapV3Math()
        self.token1_price_usd = token1_price_usd
    
    def calculate_position_value(
        self, 
        position: PositionState,
        in_token1: bool = True
    ) -> float:
        """
        Calculate total position value
        
        Args:
            position: Current position state
            in_token1: If True, return value in token1 units
        
        Returns:
            Total value (tokens + fees)
        """
        try:
            if position.current_price <= 0:
                return 0.0
            
            # Token values
            if in_token1:
                token0_value = position.token0_balance * position.current_price
                token1_value = position.token1_balance
                fees_value = (position.fees_earned_0 * position.current_price + 
                             position.fees_earned_1)
            else:
                token0_value = position.token0_balance
                token1_value = position.token1_balance / position.current_price
                fees_value = (position.fees_earned_0 + 
                             position.fees_earned_1 / position.current_price)
            
            total = token0_value + token1_value + fees_value
            return max(0.0, total)
        except (ZeroDivisionError, OverflowError, ValueError):
            return 0.0
    
    def calculate_impermanent_loss(
        self,
        entry_price: float,
        current_price: float,
        lower_tick: int,
        upper_tick: int
    ) -> float:
        """
        ✅ FIXED: Calculate impermanent loss for concentrated liquidity position
        
        Returns:
            IL as a decimal (0.05 = 5% loss)
        """
        # Input validation
        if entry_price <= 0 or current_price <= 0:
            return 0.0
        
        if lower_tick >= upper_tick:
            return 0.0
        
        try:
            sqrt_entry = math.sqrt(entry_price)
            sqrt_current = math.sqrt(current_price)
            sqrt_lower = self.math.tick_to_sqrt_price(lower_tick)
            sqrt_upper = self.math.tick_to_sqrt_price(upper_tick)
            
            # ✅ FIXED: Validate sqrt prices
            if sqrt_upper <= sqrt_lower or sqrt_lower <= 0:
                return 0.0
            
            # Calculate IL based on position relative to range
            if sqrt_current <= sqrt_lower:
                # Below range - only token0
                il = abs((sqrt_current / sqrt_entry) - 1)
            elif sqrt_current >= sqrt_upper:
                # Above range - only token1
                il = abs((sqrt_entry / sqrt_current) - 1)
            else:
                # ✅ FIXED: In range - use accurate Uniswap V3 formula
                # Value at current price
                value_current_0 = 1/sqrt_current - 1/sqrt_upper
                value_current_1 = sqrt_current - sqrt_lower
                value_current = value_current_0 + value_current_1
                
                # Value at entry price
                value_entry_0 = 1/sqrt_entry - 1/sqrt_upper
                value_entry_1 = sqrt_entry - sqrt_lower
                value_entry = value_entry_0 + value_entry_1
                
                if value_entry <= 0:
                    return 0.0
                
                il = abs(value_current / value_entry - 1)
            
            # ✅ FIXED: Safe concentration factor calculation
            range_width = sqrt_upper - sqrt_lower
            if range_width <= 0 or sqrt_entry <= 0:
                concentration = 1.0
            else:
                # Concentration factor: narrower range = higher concentration
                range_factor = range_width / sqrt_entry
                # Safe division with bounds
                concentration = max(1.0, min(5.0, 1.0 / max(range_factor, 0.1)))
            
            # Amplified IL for concentrated positions
            concentrated_il = il * concentration
            
            return max(0.0, min(concentrated_il, 1.0))  # Cap at 100%
            
        except (ZeroDivisionError, OverflowError, ValueError, TypeError) as e:
            # Safe fallback
            return 0.0
    
    def estimate_fee_yield(
        self,
        position: PositionState,
        pool: PoolState,
        time_period_hours: float = 24
    ) -> float:
        """
        ✅ FIXED: Estimate fee yield for a position
        
        Args:
            position: Position state
            pool: Pool state
            time_period_hours: Time period to estimate
        
        Returns:
            Expected fees earned in token1 units
        """
        # Check if in range
        in_range = position.lower_tick <= position.current_tick <= position.upper_tick
        if not in_range:
            return 0.0
        
        # Input validation
        if pool.tvl <= 0 or pool.volume_24h <= 0 or position.current_price <= 0:
            return 0.0
        
        try:
            # Position value
            position_value = self.calculate_position_value(position, in_token1=True)
            if position_value <= 0:
                return 0.0
            
            # ✅ FIXED: Use active liquidity instead of total TVL
            active_tvl = pool.tvl * pool.active_liquidity_ratio
            if active_tvl <= 0:
                return 0.0
            
            liquidity_share = position_value / active_tvl
            
            # ✅ FIXED: Safe concentration calculation
            sqrt_lower = self.math.tick_to_sqrt_price(position.lower_tick)
            sqrt_upper = self.math.tick_to_sqrt_price(position.upper_tick)
            sqrt_current = math.sqrt(position.current_price)
            
            range_width = sqrt_upper - sqrt_lower
            
            if range_width <= 0 or sqrt_current <= 0:
                concentration_bonus = 1.0
            else:
                # ✅ FIXED: Safe calculation with bounds
                full_range_width = 2 * sqrt_current  # Approximate full range
                
                # Concentration: narrower range gets more fees when in range
                # But cap it at reasonable levels
                concentration_bonus = min(
                    full_range_width / range_width, 
                    10.0  # Maximum 10x concentration
                )
                concentration_bonus = max(1.0, concentration_bonus)  # Minimum 1x
            
            # Fee calculation
            fee_rate = pool.fee_tier / 1_000_000  # Convert bps to decimal
            daily_fees = pool.volume_24h * fee_rate
            
            # Position's share of fees with concentration bonus
            position_fees = daily_fees * liquidity_share * concentration_bonus
            
            # Adjust for time period
            time_factor = time_period_hours / 24.0
            result = position_fees * time_factor
            
            return max(0.0, result)
            
        except (ZeroDivisionError, OverflowError, ValueError, TypeError):
            return 0.0
    
    def calculate_rebalance_cost(
        self,
        pre_position: PositionState,
        post_position: PositionState,
        gas_cost_eth: float,
        slippage_bps: int = 30  # 0.3% default slippage
    ) -> Dict[str, float]:
        """
        Calculate all costs associated with rebalancing
        
        Returns:
            Dict with cost breakdown
        """
        try:
            pre_value = self.calculate_position_value(pre_position)
            
            if pre_value <= 0:
                return {
                    'gas_cost': gas_cost_eth,
                    'slippage_cost': 0.0,
                    'il_crystallized': 0.0,
                    'price_impact': 0.0,
                    'total_cost': gas_cost_eth
                }
            
            # Slippage cost (from removing and adding liquidity)
            slippage_cost = pre_value * (slippage_bps / 10000) * 2  # 2x for remove + add
            
            # IL crystallization (if price moved since position was opened)
            # This is the IL that gets "locked in" when you rebalance
            entry_tick = (pre_position.lower_tick + pre_position.upper_tick) // 2
            entry_price = self.math.tick_to_price(entry_tick)
            
            il_pct = self.calculate_impermanent_loss(
                entry_price=entry_price,
                current_price=pre_position.current_price,
                lower_tick=pre_position.lower_tick,
                upper_tick=pre_position.upper_tick
            )
            il_cost = pre_value * il_pct
            
            # Price impact (simplified model)
            price_impact = 0.0
            
            return {
                'gas_cost': max(0.0, gas_cost_eth),
                'slippage_cost': max(0.0, slippage_cost),
                'il_crystallized': max(0.0, il_cost),
                'price_impact': max(0.0, price_impact),
                'total_cost': max(0.0, gas_cost_eth + slippage_cost + il_cost + price_impact)
            }
            
        except Exception:
            return {
                'gas_cost': gas_cost_eth,
                'slippage_cost': 0.0,
                'il_crystallized': 0.0,
                'price_impact': 0.0,
                'total_cost': gas_cost_eth
            }
    
    def calculate_rebalance_benefit(
        self,
        pre_position: PositionState,
        post_position: PositionState,
        pool: PoolState,
        forecast_hours: float = 24
    ) -> Dict[str, float]:
        """
        Calculate benefits of rebalancing
        
        Returns:
            Dict with benefit breakdown
        """
        try:
            # 1. Fee yield improvement
            pre_fee_yield = self.estimate_fee_yield(pre_position, pool, forecast_hours)
            post_fee_yield = self.estimate_fee_yield(post_position, pool, forecast_hours)
            fee_improvement = post_fee_yield - pre_fee_yield
            
            # 2. Range improvement value
            pre_in_range = pre_position.lower_tick <= pre_position.current_tick <= pre_position.upper_tick
            post_in_range = post_position.lower_tick <= post_position.current_tick <= post_position.upper_tick
            
            range_improvement_value = 0.0
            if not pre_in_range and post_in_range:
                # Big benefit - now earning fees
                range_improvement_value = post_fee_yield * 0.5  # Value half day of fees
            
            # 3. Future IL avoidance (if old range was very off-center)
            pre_center = (pre_position.lower_tick + pre_position.upper_tick) / 2
            post_center = (post_position.lower_tick + post_position.upper_tick) / 2
            
            pre_distance = abs(pre_position.current_tick - pre_center)
            post_distance = abs(post_position.current_tick - post_center)
            
            # Better centering reduces future IL risk
            position_value = self.calculate_position_value(pre_position)
            centering_benefit = 0.0
            if post_distance < pre_distance and pre_distance > 0:
                improvement_pct = (pre_distance - post_distance) / pre_distance
                centering_benefit = position_value * improvement_pct * 0.001  # Small factor
            
            total = fee_improvement + range_improvement_value + centering_benefit
            
            return {
                'fee_improvement': max(0.0, fee_improvement),
                'range_improvement': max(0.0, range_improvement_value),
                'centering_benefit': max(0.0, centering_benefit),
                'total_benefit': max(0.0, total)
            }
            
        except Exception:
            return {
                'fee_improvement': 0.0,
                'range_improvement': 0.0,
                'centering_benefit': 0.0,
                'total_benefit': 0.0
            }
    
    def calculate_net_reward(
        self,
        pre_position: PositionState,
        post_position: PositionState,
        pool: PoolState,
        gas_cost_eth: float,
        forecast_hours: float = 24
    ) -> Dict[str, float]:
        """
        ✅ FIXED: Calculate net reward from rebalancing
        
        This is the TRUE reward that should be used for ML training
        
        Returns:
            Complete reward breakdown with clear accounting
        """
        costs = self.calculate_rebalance_cost(
            pre_position, post_position, gas_cost_eth
        )
        
        benefits = self.calculate_rebalance_benefit(
            pre_position, post_position, pool, forecast_hours
        )
        
        # ✅ CLEAR: net_reward = total_benefit - total_cost
        # total_cost already includes gas_cost, so no double counting
        net_reward = benefits['total_benefit'] - costs['total_cost']
        
        # ROI calculation
        pre_value = self.calculate_position_value(pre_position)
        roi_pct = (net_reward / pre_value * 100) if pre_value > 0 else 0
        
        return {
            # Cost components (for analysis)
            'gas_cost': costs['gas_cost'],
            'slippage_cost': costs['slippage_cost'],
            'il_crystallized': costs['il_crystallized'],
            'total_cost': costs['total_cost'],  # ✅ Includes all costs
            
            # Benefit components (for analysis)
            'fee_improvement': benefits['fee_improvement'],
            'range_improvement': benefits['range_improvement'],
            'centering_benefit': benefits['centering_benefit'],
            'total_benefit': benefits['total_benefit'],
            
            # Net result (for training)
            'net_reward': net_reward,  # ✅ CLEAR: benefit - cost
            'roi_pct': roi_pct,
            'is_profitable': net_reward > 0,
            
            # Context
            'pre_value': pre_value,
            'post_value': self.calculate_position_value(post_position),
            'forecast_hours': forecast_hours,
            
            # ✅ Documentation
            'note': 'net_reward = total_benefit - total_cost (total_cost includes gas)'
        }
    
    def calculate_hold_reward(
        self,
        position: PositionState,
        pool: PoolState,
        price_change_pct: float,
        hold_hours: float = 24
    ) -> Dict[str, float]:
        """
        Calculate reward from holding (not rebalancing)
        Used for counterfactual comparison
        """
        try:
            # Fees earned while holding
            fees_earned = self.estimate_fee_yield(position, pool, hold_hours)
            
            # IL from price movement
            new_price = position.current_price * (1 + price_change_pct / 100)
            il_pct = self.calculate_impermanent_loss(
                entry_price=position.current_price,
                current_price=new_price,
                lower_tick=position.lower_tick,
                upper_tick=position.upper_tick
            )
            
            position_value = self.calculate_position_value(position)
            il_cost = position_value * il_pct
            
            net_reward = fees_earned - il_cost
            
            return {
                'fees_earned': max(0.0, fees_earned),
                'il_cost': max(0.0, il_cost),
                'net_reward': net_reward,
                'roi_pct': (net_reward / position_value * 100) if position_value > 0 else 0
            }
            
        except Exception:
            return {
                'fees_earned': 0.0,
                'il_cost': 0.0,
                'net_reward': 0.0,
                'roi_pct': 0.0
            }
    
    def should_rebalance(
        self,
        pre_position: PositionState,
        post_position: PositionState,
        pool: PoolState,
        gas_cost_eth: float,
        min_roi_threshold: float = 0.1  # 0.1% minimum ROI
    ) -> Dict[str, any]:
        """
        Decision function: should we rebalance?
        
        Returns:
            Decision with reasoning
        """
        reward = self.calculate_net_reward(
            pre_position, post_position, pool, gas_cost_eth
        )
        
        # Also calculate what happens if we hold
        hold_reward = self.calculate_hold_reward(
            pre_position, pool, 
            price_change_pct=0,  # Assume no change for comparison
            hold_hours=24
        )
        
        should_rebalance = (
            reward['is_profitable'] and 
            reward['roi_pct'] > min_roi_threshold and
            reward['net_reward'] > hold_reward['net_reward']
        )
        
        return {
            'should_rebalance': should_rebalance,
            'rebalance_reward': reward,
            'hold_reward': hold_reward,
            'advantage': reward['net_reward'] - hold_reward['net_reward'],
            'reasoning': self._generate_reasoning(reward, hold_reward, should_rebalance)
        }
    
    def _generate_reasoning(
        self, 
        rebalance: Dict, 
        hold: Dict, 
        decision: bool
    ) -> str:
        """Generate human-readable reasoning"""
        if decision:
            return (f"Rebalance: net +{rebalance['net_reward']:.6f} "
                   f"({rebalance['roi_pct']:.2f}% ROI), "
                   f"beats hold by {rebalance['net_reward'] - hold['net_reward']:.6f}")
        else:
            if not rebalance['is_profitable']:
                return f"Hold: rebalance would lose {abs(rebalance['net_reward']):.6f}"
            else:
                return f"Hold: marginal gain not worth risk (ROI: {rebalance['roi_pct']:.2f}%)"


# Example usage
if __name__ == '__main__':
    calc = RewardCalculator(token1_price_usd=1.0)
    
    # Example: ETH/USDC position
    pre = PositionState(
        lower_tick=-887220,
        upper_tick=-886220,
        liquidity=1e18,
        token0_balance=0.5,
        token1_balance=1000,
        current_tick=-887000,
        current_price=2000,
        fees_earned_0=0.001,
        fees_earned_1=2.0
    )
    
    post = PositionState(
        lower_tick=-887500,
        upper_tick=-886500,
        liquidity=1e18,
        token0_balance=0.5,
        token1_balance=1000,
        current_tick=-887000,
        current_price=2000,
        fees_earned_0=0,
        fees_earned_1=0
    )
    
    pool = PoolState(
        fee_tier=3000,
        volume_24h=10_000_000,
        tvl=50_000_000
    )
    
    result = calc.should_rebalance(pre, post, pool, gas_cost_eth=0.01)
    
    print("=" * 60)
    print("💰 REWARD CALCULATION RESULT (FIXED)")
    print("=" * 60)
    print(f"\nDecision: {'REBALANCE' if result['should_rebalance'] else 'HOLD'}")
    print(f"Reasoning: {result['reasoning']}")
    print(f"\nRebalance reward: {result['rebalance_reward']['net_reward']:.6f}")
    print(f"Hold reward: {result['hold_reward']['net_reward']:.6f}")
    print(f"Advantage: {result['advantage']:.6f}")