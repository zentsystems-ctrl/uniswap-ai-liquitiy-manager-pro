"""
Comprehensive Test Suite for AI Engine
Tests all components: FeatureEngineering, ModelEnsemble, RiskManager, AIEngine
"""

import pytest
import numpy as np
import tempfile
import json
import os
from unittest.mock import Mock, patch

from ai_engine import (
    AIEngine, MarketState, Position, Decision,
    FeatureEngineering, ModelEnsemble, RiskManager
)


class TestFeatureEngineering:
    """Test feature extraction and engineering"""
    
    def setup_method(self):
        """Setup test fixtures"""
        self.feature_eng = FeatureEngineering()
        
        self.sample_position = Position(
            id=1,
            owner="0x1234",
            lowerTick=-100000,
            upperTick=100000,
            liquidity=50000,
            token0_balance=1000,
            token1_balance=1850000,
            fees_earned_0=10,
            fees_earned_1=18500,
            age_seconds=86400 * 7
        )
        
        self.sample_state = MarketState(
            timestamp=1699564800.0,
            poolId="0xpool1",
            current_price=1850.0,
            twap_1h=1848.0,
            twap_24h=1845.0,
            volatility_1h=0.15,
            volatility_24h=0.25,
            pool_liquidity=1000000.0,
            volume_24h=5000000.0,
            gas_price=50.0,
            position=self.sample_position
        )
    
    def test_extract_features_shape(self):
        """✅ FIXED: Test that features have correct shape (20 features)"""
        features = self.feature_eng.extract_features(self.sample_state)
        
        assert isinstance(features, np.ndarray)
        # FIXED: Changed from 24 to 20
        assert features.shape == (20,), f"Expected 20 features, got {features.shape}"
    
    def test_extract_features_types(self):
        """Test that all features are numeric"""
        features = self.feature_eng.extract_features(self.sample_state)
        
        assert features.dtype in [np.float64, np.float32]
        assert not np.any(np.isnan(features)), "Features contain NaN values"
        assert not np.any(np.isinf(features)), "Features contain Inf values"
    
    def test_price_deviation_calculation(self):
        """Test price deviation features"""
        features = self.feature_eng.extract_features(self.sample_state)
        
        # Feature 0: price_dev_24h
        expected_dev_24h = abs(1850.0 - 1845.0) / 1845.0
        assert abs(features[0] - expected_dev_24h) < 0.001
        
        # Feature 1: price_dev_ref
        # Uses twap_24h as reference
        expected_dev_ref = abs(1850.0 - 1845.0) / 1845.0
        assert abs(features[1] - expected_dev_ref) < 0.001
    
    def test_position_in_range_calculation(self):
        """Test position-in-range feature"""
        features = self.feature_eng.extract_features(self.sample_state)
        
        # Feature 5: position_in_range
        assert 0 <= features[5] <= 1
    
    def test_zero_price_handling(self):
        """Test handling of edge case: zero price"""
        state = self.sample_state
        state.current_price = 0.0
        
        features = self.feature_eng.extract_features(state)
        assert not np.any(np.isnan(features))
    
    def test_feature_names_match_count(self):
        """✅ FIXED: Test that feature names match feature count"""
        names = self.feature_eng.get_feature_names()
        features = self.feature_eng.extract_features(self.sample_state)
        
        # FIXED: Should be 20 names for 20 features
        assert len(names) == 20, f"Expected 20 feature names"
        assert len(names) == len(features), \
            f"Feature names ({len(names)}) don't match features ({len(features)})"


class TestModelEnsemble:
    """Test model ensemble training and prediction"""
    
    def setup_method(self):
        """Setup test fixtures"""
        self.ensemble = ModelEnsemble()
        
        # FIXED: Generate 20 features instead of 24
        np.random.seed(42)
        self.X_train = np.random.randn(200, 20)  # Changed from 24 to 20
        self.y_train = 0.05 * self.X_train[:, 0] + 0.03 * self.X_train[:, 4] + \
                       np.random.randn(200) * 0.01
    
    def test_train_ensemble(self):
        """Test ensemble training"""
        self.ensemble.train(self.X_train, self.y_train)
        
        assert self.ensemble.is_trained
        assert len(self.ensemble.models) > 0
    
    def test_predict_after_training(self):
        """✅ FIXED: Test prediction after training"""
        self.ensemble.train(self.X_train, self.y_train)
        
        # FIXED: Use 20 features
        X_test = np.random.randn(20)
        mean_pred, std_pred = self.ensemble.predict(X_test)
        
        assert isinstance(mean_pred, (float, np.floating))
        assert isinstance(std_pred, (float, np.floating))
        assert std_pred >= 0
    
    def test_predict_without_training_raises_error(self):
        """✅ FIXED: Test that prediction without training raises error"""
        X_test = np.random.randn(20)  # Changed from 24 to 20
        
        with pytest.raises(ValueError, match="Models not trained"):
            self.ensemble.predict(X_test)
    
    def test_save_and_load(self):
        """✅ FIXED: Test model saving and loading"""
        self.ensemble.train(self.X_train, self.y_train)
        
        with tempfile.NamedTemporaryFile(delete=False, suffix='.joblib') as f:
            temp_path = f.name
        
        try:
            self.ensemble.save(temp_path)
            assert os.path.exists(temp_path)
            
            loaded_ensemble = ModelEnsemble.load(temp_path)
            assert loaded_ensemble.is_trained
            assert len(loaded_ensemble.models) == len(self.ensemble.models)
            
            # FIXED: Use 20 features
            X_test = np.random.randn(20)
            pred1, std1 = self.ensemble.predict(X_test)
            pred2, std2 = loaded_ensemble.predict(X_test)
            
            assert abs(pred1 - pred2) < 0.001
            
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
    
    def test_feature_importance_calculated(self):
        """✅ FIXED: Test that feature importance is calculated"""
        self.ensemble.train(self.X_train, self.y_train, model_types=['rf'])
        
        assert self.ensemble.feature_importance is not None
        # FIXED: Changed from 24 to 20
        assert len(self.ensemble.feature_importance) == 20


class TestRiskManager:
    """Test risk management system"""
    
    def setup_method(self):
        """Setup test fixtures"""
        self.risk_manager = RiskManager(max_loss_pct=0.05, max_gas_eth=0.01)
        
        self.sample_position = Position(
            id=1,
            owner="0x1234",
            lowerTick=-100000,
            upperTick=100000,
            liquidity=50000,
            token0_balance=1000,
            token1_balance=1850000
        )
        
        self.sample_state = MarketState(
            timestamp=1699564800.0,
            poolId="0xpool1",
            current_price=1850.0,
            twap_1h=1848.0,
            twap_24h=1845.0,
            volatility_1h=0.15,
            volatility_24h=0.25,
            pool_liquidity=1000000.0,
            volume_24h=5000000.0,
            gas_price=50.0,
            position=self.sample_position
        )
    
    def test_assess_risk_returns_valid_output(self):
        """Test that risk assessment returns valid output"""
        risk_level, risk_score = self.risk_manager.assess_risk(
            self.sample_state, 
            predicted_reward=0.03
        )
        
        assert risk_level in ['low', 'medium', 'high']
        assert 0 <= risk_score <= 1
    
    def test_high_volatility_increases_risk(self):
        """Test that high volatility increases risk score"""
        state_low_vol = self.sample_state
        state_low_vol.volatility_24h = 0.1
        
        state_high_vol = self.sample_state
        state_high_vol.volatility_24h = 0.8
        
        _, risk_low = self.risk_manager.assess_risk(state_low_vol, 0.03)
        _, risk_high = self.risk_manager.assess_risk(state_high_vol, 0.03)
        
        assert risk_high > risk_low
    
    def test_should_execute_blocks_high_risk_low_confidence(self):
        """Test that high-risk low-confidence actions are blocked"""
        decision = Decision(
            action='rebalance',
            confidence=0.5,
            score=0.02,
            expected_reward=0.02,
            reason='test',
            risk_level='high'
        )
        
        should_execute = self.risk_manager.should_execute(decision, self.sample_state)
        assert not should_execute
    
    def test_should_execute_allows_high_confidence(self):
        """Test that high-confidence actions are allowed"""
        decision = Decision(
            action='rebalance',
            confidence=0.9,
            score=0.05,
            expected_reward=0.05,
            reason='test',
            risk_level='high'
        )
        
        should_execute = self.risk_manager.should_execute(decision, self.sample_state)
        assert should_execute
    
    def test_should_execute_blocks_high_gas_cost(self):
        """Test that high gas cost blocks execution"""
        state_high_gas = self.sample_state
        state_high_gas.gas_price = 1000
        
        decision = Decision(
            action='rebalance',
            confidence=0.8,
            score=0.03,
            expected_reward=0.03,
            reason='test',
            risk_level='medium'
        )
        
        should_execute = self.risk_manager.should_execute(decision, state_high_gas)
        assert not should_execute


class TestAIEngine:
    """Test main AI engine"""
    
    def setup_method(self):
        """Setup test fixtures"""
        self.ai_engine = AIEngine()
        
        self.sample_position = Position(
            id=1,
            owner="0x1234",
            lowerTick=-100000,
            upperTick=100000,
            liquidity=50000,
            token0_balance=1000,
            token1_balance=1850000,
            fees_earned_0=10,
            fees_earned_1=18500,
            age_seconds=86400
        )
        
        self.sample_state = MarketState(
            timestamp=1699564800.0,
            poolId="0xpool1",
            current_price=1850.0,
            twap_1h=1848.0,
            twap_24h=1845.0,
            volatility_1h=0.15,
            volatility_24h=0.25,
            pool_liquidity=1000000.0,
            volume_24h=5000000.0,
            gas_price=50.0,
            position=self.sample_position
        )
    
    def test_decide_returns_valid_decision(self):
        """Test that decide returns valid decision"""
        decision = self.ai_engine.decide(self.sample_state)
        
        assert isinstance(decision, Decision)
        assert decision.action in ['rebalance', 'reduce', 'hold', 'close']
        assert 0 <= decision.confidence <= 1
        assert decision.risk_level in ['low', 'medium', 'high']
    
    def test_decide_without_model_uses_heuristics(self):
        """Test that heuristics work when model unavailable"""
        assert self.ai_engine.ensemble is None
        
        decision = self.ai_engine.decide(self.sample_state)
        
        assert 'heuristic' in decision.reason.lower()
    
    def test_decide_records_decision(self):
        """Test that decisions are recorded in history"""
        initial_count = len(self.ai_engine.decision_history)
        
        self.ai_engine.decide(self.sample_state)
        
        assert len(self.ai_engine.decision_history) == initial_count + 1
    
    def test_decide_handles_errors_gracefully(self):
        """Test that errors are handled gracefully"""
        invalid_state = self.sample_state
        invalid_state.current_price = float('nan')
        
        decision = self.ai_engine.decide(invalid_state)
        
        assert decision.action == 'hold'
        assert 'error' in decision.reason.lower()
    
    def test_out_of_range_triggers_rebalance(self):
        """Test that out-of-range position triggers rebalance"""
        state_out_of_range = self.sample_state
        state_out_of_range.current_price = 10000.0
        
        decision = self.ai_engine.decide(state_out_of_range)
        
        if decision.confidence > 0.6:
            assert decision.action in ['rebalance', 'reduce', 'close']


class TestIntegration:
    """Integration tests for complete workflow"""
    
    def test_complete_workflow(self):
        """Test complete workflow from state to decision"""
        ai_engine = AIEngine()
        
        position = Position(
            id=1,
            owner="0x1234",
            lowerTick=-100000,
            upperTick=100000,
            liquidity=50000,
            token0_balance=1000,
            token1_balance=1850000
        )
        
        state = MarketState(
            timestamp=1699564800.0,
            poolId="0xpool1",
            current_price=1850.0,
            twap_1h=1848.0,
            twap_24h=1845.0,
            volatility_1h=0.15,
            volatility_24h=0.25,
            pool_liquidity=1000000.0,
            volume_24h=5000000.0,
            gas_price=50.0,
            position=position
        )
        
        decision = ai_engine.decide(state)
        
        # Verify complete decision object
        assert hasattr(decision, 'action')
        assert hasattr(decision, 'confidence')
        assert hasattr(decision, 'score')
        assert hasattr(decision, 'expected_reward')
        assert hasattr(decision, 'reason')
        assert hasattr(decision, 'risk_level')
        
        # Verify values are reasonable
        assert decision.action in ['rebalance', 'reduce', 'hold', 'close']
        assert 0 <= decision.confidence <= 1
        assert decision.risk_level in ['low', 'medium', 'high']


if __name__ == '__main__':
    pytest.main([__file__, '-v', '--cov=ai_engine', '--cov-report=html'])
