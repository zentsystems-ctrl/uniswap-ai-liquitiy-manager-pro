#!/usr/bin/env python3

import os
import json
import time
import logging
import shutil
from pathlib import Path
from datetime import datetime

import schedule

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class AutoRetrainer:
    """Enhanced auto-retraining with better data handling"""
    
    def __init__(
        self,
        training_log_path: str = './data/training_log.ndjson',
        results_log_path: str = './data/results_log.ndjson',
        model_path: str = './data/models/model.joblib',
        min_new_samples: int = 50,
        check_interval_hours: int = 6,
        min_profitable_rate: float = 0.0
    ):
        self.training_log_path = Path(training_log_path)
        self.results_log_path = Path(results_log_path)
        self.model_path = Path(model_path)
        self.min_new_samples = int(min_new_samples)
        self.check_interval_hours = int(check_interval_hours)
        self.min_profitable_rate = float(min_profitable_rate)
        
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        
        self.last_training_time = None
        self.last_processed_count = 0
        self.training_history = []
        
        self._load_state()
        
        logger.info("🔄 AutoRetrainer initialized")
        logger.info(f"   Training log: {self.training_log_path}")
        logger.info(f"   Model: {self.model_path}")
    
    def _state_file(self) -> Path:
        return self.model_path.parent / 'retrainer_state.json'
    
    def _load_state(self):
        state_file = self._state_file()
        if state_file.exists():
            try:
                with open(state_file, 'r') as f:
                    state = json.load(f)
                    self.last_training_time = state.get('last_training_time')
                    self.last_processed_count = int(state.get('last_processed_count', 0))
                    self.training_history = state.get('training_history', [])
                    logger.debug(f"Loaded retrainer state: {state_file}")
            except Exception as e:
                logger.warning(f"Failed to load state {state_file}: {e}")
    
    def _save_state(self):
        state_file = self._state_file()
        state = {
            'last_training_time': self.last_training_time,
            'last_processed_count': self.last_processed_count,
            'training_history': self.training_history[-10:]
        }
        try:
            with open(state_file, 'w') as f:
                json.dump(state, f, indent=2)
        except Exception as e:
            logger.warning(f"Failed to save state to {state_file}: {e}")
    
    def prepare_training_data(self):
        """
        Prepare enhanced training data from training_log.ndjson (preferred) or results_log.ndjson.
        Output: training_data_enhanced.ndjson in same models folder.
        """
        logger.info("📊 Preparing enhanced training data...")
        
        log_path = self.training_log_path if self.training_log_path.exists() else self.results_log_path
        if not log_path.exists():
            logger.error(f"❌ No log file found at {self.training_log_path} or {self.results_log_path}")
            return None
        
        records = []
        try:
            with open(log_path, 'r') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        records.append(json.loads(line))
                    except Exception:
                        # ignore bad lines, but continue
                        logger.debug("Skipped malformed line in log")
                        continue
        except Exception as e:
            logger.exception(f"Failed reading log file {log_path}: {e}")
            return None
        
        if not records:
            logger.warning("⚠️ No records found in log")
            return None
        
        logger.info(f"📊 Found {len(records)} records in {log_path.name}")
        
        # Collect simple stats
        rebalance_records = [r for r in records if r.get('action') == 'rebalance' and r.get('executed', False)]
        hold_records = [r for r in records if r.get('action') == 'hold' or (r.get('action') == 'rebalance' and not r.get('executed', True))]
        
        profitable = [r for r in rebalance_records if (r.get('label', {}) and r.get('label', {}).get('was_profitable')) or (r.get('outcome', {}) and r.get('outcome', {}).get('net_reward_eth', 0) > 0)]
        profitable_rate = len(profitable) / len(rebalance_records) if rebalance_records else 0.0
        
        logger.info(f"   Rebalance records: {len(rebalance_records)}")
        logger.info(f"   Hold (or skipped) records: {len(hold_records)}")
        logger.info(f"   Profitable rate: {profitable_rate*100:.1f}%")
        
        # Create enhanced training file
        enhanced_path = self.model_path.parent / 'training_data_enhanced.ndjson'
        created = 0
        try:
            with open(enhanced_path, 'w') as out_f:
                for rec in records:
                    training_record = self._convert_to_training_format(rec)
                    if training_record:
                        out_f.write(json.dumps(training_record) + '\n')
                        created += 1
        except Exception as e:
            logger.exception(f"Failed to write enhanced training file: {e}")
            return None
        
        logger.info(f"✅ Enhanced training data saved to: {enhanced_path} (records written: {created})")
        
        return {
            'path': str(enhanced_path),
            'samples': created,
            'rebalance_samples': len(rebalance_records),
            'hold_samples': len(hold_records),
            'profitable_rate': profitable_rate
        }
    
    def _convert_to_training_format(self, record: dict):
        """
        Convert various legacy/new record shapes into the uniform format:
        {
          timestamp, state: {...}, decision: {...}, reward, label
        }
        The returned `state` must contain keys consumed by AIEngine.train_from_history:
        - timestamp, poolId, current_price, twap_1h, twap_24h, volatility_1h, volatility_24h,
          pool_liquidity, volume_24h, gas_price, gas_unit, price_unit,
          position: {...}, extra:{...}, deviation_pct, threshold_pct, within_bounds, price_impact
        """
        try:
            # If record already has 'state' and 'reward' -> assume close to desired format
            if 'state' in record and ('reward' in record or 'label' in record):
                state = record['state'] or {}
                # Ensure minimal required keys and sensible defaults
                state_out = {
                    'timestamp': state.get('timestamp', record.get('timestamp', time.time())),
                    'poolId': state.get('poolId', state.get('pool_id', '')),
                    'current_price': state.get('current_price', state.get('price', 1.0)),
                    'price_unit': state.get('price_unit', 'eth'),
                    'twap_1h': state.get('twap_1h', state.get('twap1h', state.get('current_price', 1.0))),
                    'twap_24h': state.get('twap_24h', state.get('twap24h', state.get('current_price', 1.0))),
                    'volatility_1h': state.get('volatility_1h', 0.02),
                    'volatility_24h': state.get('volatility_24h', 0.05),
                    'pool_liquidity': state.get('pool_liquidity', 1_000_000),
                    'volume_24h': state.get('volume_24h', 0.0),
                    'gas_price': state.get('gas_price', state.get('gas_price_gwei', 50.0)),
                    'gas_unit': state.get('gas_unit', 'gwei'),
                    'deviation_pct': state.get('deviation_pct'),
                    'threshold_pct': state.get('threshold_pct'),
                    'within_bounds': state.get('within_bounds'),
                    'price_impact': state.get('price_impact'),
                    'extra': state.get('extra', {}),
                    'position': state.get('position', {})
                }
                
                reward = record.get('reward', record.get('label', 0))
                # Some datasets put reward inside nested dicts
                if isinstance(reward, dict):
                    reward = reward.get('net_reward', reward.get('net_reward_eth', 0))
                
                return {
                    'timestamp': record.get('timestamp', time.time()),
                    'state': state_out,
                    'decision': record.get('decision', {'action': record.get('action', 'hold'), 'confidence': record.get('confidence', 0.5)}),
                    'reward': reward,
                    'label': record.get('label', reward)
                }
            
            # If record has 'features' produced by service logging, convert those
            if 'features' in record:
                features = record.get('features', {})
                outcome = record.get('outcome', {}) or {}
                label = record.get('label', {}) or {}
                reposition_ctx = record.get('reposition_context', {}) or {}
                context = record.get('context', {}) or {}
                
                current_price = features.get('price_vs_twap_24h', features.get('current_price', 1.0))
                # construct position object using available clues
                position_value_eth = features.get('position_value_eth', features.get('position_value', 0.0))
                lower = features.get('tick_lower', 0)
                upper = features.get('tick_upper', features.get('tick_lower', 0) + features.get('tick_width', 1000))
                
                state_out = {
                    'timestamp': record.get('timestamp', time.time()),
                    'poolId': context.get('poolId', ''),
                    'current_price': current_price,
                    'price_unit': record.get('price_unit', 'eth'),
                    'twap_1h': features.get('twap_1h', current_price),
                    'twap_24h': features.get('twap_24h', current_price),
                    'volatility_1h': features.get('volatility_1h', 0.02),
                    'volatility_24h': features.get('volatility_24h', 0.05),
                    'pool_liquidity': features.get('pool_liquidity', 1_000_000),
                    'volume_24h': features.get('volume_24h', 0.0),
                    'gas_price': features.get('gas_price_gwei', features.get('gas_price', 50)),
                    'gas_unit': record.get('gas_unit', 'gwei'),
                    'deviation_pct': features.get('deviation_pct', None),
                    'threshold_pct': features.get('threshold_pct', None),
                    'within_bounds': not bool(features.get('is_out_of_bounds', False)),
                    'price_impact': features.get('price_impact', None),
                    'extra': {
                        'inRange': features.get('in_range_before', True),
                        'currentTick': features.get('currentTick', 0),
                        'p_ref': reposition_ctx.get('p_ref'),
                        'p_now': reposition_ctx.get('p_now'),
                        'deviation_bps': reposition_ctx.get('deviation_bps', 0),
                        'threshold_bps': reposition_ctx.get('threshold_bps', 0),
                        'is_out_of_bounds': features.get('is_out_of_bounds', False)
                    },
                    'position': {
                        'id': features.get('position_id', 0),
                        'owner': features.get('owner', ''),
                        'lowerTick': lower,
                        'upperTick': upper,
                        'liquidity': features.get('liquidity', 0),
                        'token0_balance': position_value_eth / 2.0 if position_value_eth else 0.0,
                        'token1_balance': position_value_eth / 2.0 if position_value_eth else 0.0,
                        'fees_earned_0': features.get('fees_earned_0', 0.0),
                        'fees_earned_1': features.get('fees_earned_1', 0.0),
                        'age_seconds': int(features.get('age_seconds', 3600))
                    }
                }
                
                reward_val = label.get('net_reward', outcome.get('net_reward_eth', 0)) if (label or outcome) else record.get('reward', 0)
                try:
                    reward_val = float(reward_val or 0)
                except Exception:
                    reward_val = 0.0
                
                return {
                    'timestamp': record.get('timestamp', time.time()),
                    'state': state_out,
                    'decision': {
                        'action': record.get('action', 'hold'),
                        'confidence': float(features.get('ai_confidence', 0.5))
                    },
                    'reward': reward_val,
                    'label': reward_val
                }
            
            # Legacy formats: 'pre' + 'reward'
            if 'pre' in record and 'reward' in record:
                pre = record.get('pre', {})
                reward_val = record.get('reward', {})
                try:
                    r = float(reward_val.get('totalRewardETH', reward_val)) if isinstance(reward_val, dict) else float(reward_val)
                except Exception:
                    r = 0.0
                state_in = pre.get('fullState', {}) or {}
                decision_in = pre.get('fullDecision', {}) or {}
                # ensure minimal state keys
                state_in.setdefault('current_price', state_in.get('price', 1.0))
                return {
                    'timestamp': record.get('executionTimestamp', time.time()),
                    'state': state_in,
                    'decision': decision_in,
                    'reward': r,
                    'label': r
                }
            
            # If none matched, skip
            return None
        except Exception as e:
            logger.debug(f"Failed to convert record: {e}")
            return None
    
    def count_new_records(self):
        """Count new training records"""
        total = 0
        log_path = self.training_log_path if self.training_log_path.exists() else self.results_log_path
        if not log_path.exists():
            return 0
        try:
            with open(log_path, 'r') as f:
                for line in f:
                    if line.strip():
                        total += 1
        except Exception as e:
            logger.debug(f"Failed counting records: {e}")
            total = 0
        new_count = max(0, total - int(self.last_processed_count or 0))
        logger.info(f"📊 New records since last processed: {new_count} (total lines: {total})")
        return new_count
    
    def check_and_retrain(self):
        """Check if retraining is needed and trigger retrain if conditions met"""
        logger.info("🔍 Checking retraining conditions...")
        new_records = self.count_new_records()
        if new_records < self.min_new_samples:
            logger.info(f"Not enough new records for retrain: {new_records}/{self.min_new_samples}")
            return False
        logger.info(f"✅ Sufficient new records ({new_records}) -> starting retrain")
        return self.retrain()
    
    def retrain(self):
        """Retrain the model using prepared enhanced data"""
        try:
            from ai_engine import train_model  # uses train_from_history internally
            
            start_time = time.time()
            logger.info("=" * 60)
            logger.info("🎓 AUTOMATIC RETRAINING STARTED")
            logger.info("=" * 60)
            
            data_info = self.prepare_training_data()
            if not data_info or data_info['samples'] < self.min_new_samples:
                logger.error("❌ No usable data prepared for training")
                return False
            
            # Backup current model
            if self.model_path.exists():
                backup_path = self.model_path.parent / f"model_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.joblib"
                try:
                    shutil.copy(self.model_path, backup_path)
                    logger.info(f"💾 Model backed up to: {backup_path.name}")
                except Exception as e:
                    logger.warning(f"Backup failed: {e}")
            
            temp_model_path = self.model_path.parent / 'model_temp.joblib'
            
            logger.info(f"📚 Training with {data_info['samples']} samples...")
            logger.info(f"   Rebalance: {data_info['rebalance_samples']}")
            logger.info(f"   Hold: {data_info['hold_samples']}")
            
            # Train (this will raise on failure)
            train_model(data_info['path'], str(temp_model_path))
            
            # Validate
            if self._validate_model(str(temp_model_path)):
                # Deploy
                try:
                    shutil.move(str(temp_model_path), str(self.model_path))
                except Exception as e:
                    logger.exception(f"Failed to deploy model: {e}")
                    return False
                
                self.last_training_time = datetime.now().isoformat()
                
                # Update processed count (total lines)
                log_path = self.training_log_path if self.training_log_path.exists() else self.results_log_path
                try:
                    total = sum(1 for _ in open(log_path, 'r') if _.strip())
                except Exception:
                    total = self.last_processed_count
                self.last_processed_count = total
                
                training_time = time.time() - start_time
                self.training_history.append({
                    'timestamp': self.last_training_time,
                    'samples': data_info['samples'],
                    'rebalance_samples': data_info['rebalance_samples'],
                    'hold_samples': data_info['hold_samples'],
                    'profitable_rate': data_info['profitable_rate'],
                    'training_time_seconds': training_time
                })
                
                self._save_state()
                
                logger.info("=" * 60)
                logger.info("✅ RETRAINING COMPLETE")
                logger.info(f"   Time: {training_time:.1f}s")
                logger.info(f"   Total samples: {data_info['samples']}")
                logger.info(f"   Model: {self.model_path}")
                logger.info("=" * 60)
                return True
            else:
                logger.error("❌ Model validation failed")
                if temp_model_path.exists():
                    try:
                        temp_model_path.unlink()
                    except Exception:
                        pass
                return False
        except Exception as e:
            logger.exception(f"❌ Retraining failed: {e}")
            return False
    
    def _validate_model(self, model_path: str) -> bool:
        """Validate the newly trained model by loading and running a sample prediction"""
        try:
            from ai_engine import ModelEnsemble, FeatureEngineering
            import numpy as np
            
            ensemble = ModelEnsemble.load(model_path)
            if not ensemble or not ensemble.is_trained or len(ensemble.models) == 0:
                logger.error("Loaded ensemble invalid or untrained")
                return False
            
            # Determine expected feature length from FeatureEngineering if available
            try:
                expected_len = len(FeatureEngineering.get_feature_names())
            except Exception:
                expected_len = 20  # fallback to 20
            
            test_features = np.random.randn(expected_len).astype(float)
            mean_pred, std_pred = ensemble.predict(test_features)
            
            if not (isinstance(mean_pred, (int, float)) and isinstance(std_pred, (int, float))):
                logger.error("Prediction output types invalid")
                return False
            
            logger.info("✅ Model validation passed")
            return True
        except Exception as e:
            logger.exception(f"Model validation failed: {e}")
            return False
    
    def get_status(self):
        """Get retrainer status"""
        new_records = self.count_new_records()
        return {
            'last_training_time': self.last_training_time,
            'new_records_available': new_records,
            'min_samples_required': self.min_new_samples,
            'ready_for_training': new_records >= self.min_new_samples,
            'training_history': self.training_history[-5:],
            'model_exists': self.model_path.exists()
        }
    
    def run_scheduler(self):
        """Run scheduled retraining loop"""
        logger.info(f"🔄 Starting scheduler (every {self.check_interval_hours}h)")
        schedule.every(self.check_interval_hours).hours.do(self.check_and_retrain)
        # initial check
        try:
            self.check_and_retrain()
        except Exception:
            logger.exception("Initial check failed")
        
        try:
            while True:
                schedule.run_pending()
                time.sleep(60)
        except KeyboardInterrupt:
            logger.info("👋 Scheduler stopped")


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='🔄 Enhanced Auto Retraining')
    parser.add_argument('--once', action='store_true', help='Check once and exit')
    parser.add_argument('--force', action='store_true', help='Force retrain regardless of counts')
    parser.add_argument('--status', action='store_true', help='Show status')
    parser.add_argument('--min-samples', type=int, default=50)
    args = parser.parse_args()
    
    retrainer = AutoRetrainer(min_new_samples=args.min_samples)
    
    if args.status:
        status = retrainer.get_status()
        print(f"\n{'='*50}")
        print("🔄 RETRAINER STATUS")
        print(f"{'='*50}")
        print(f"Last training: {status['last_training_time'] or 'Never'}")
        print(f"New records: {status['new_records_available']}/{status['min_samples_required']}")
        print(f"Ready: {'✅' if status['ready_for_training'] else '❌'}")
        print(f"Model exists: {'✅' if status['model_exists'] else '❌'}")
        return
    
    if args.force:
        retrainer.retrain()
        return
    
    if args.once:
        retrainer.check_and_retrain()
        return
    
    retrainer.run_scheduler()


if __name__ == '__main__':
    main()
