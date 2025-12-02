#!/usr/bin/env python3
"""
📊 Performance Dashboard - لوحة مراقبة أداء نظام ML
تعرض إحصائيات مفصلة عن أداء النموذج والقرارات
"""

import json
import sys
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict
import statistics


class PerformanceDashboard:
    """لوحة مراقبة الأداء"""
    
    def __init__(self, results_log_path='./data/results_log.ndjson'):
        self.results_log_path = Path(results_log_path)
        self.results = []
        self._load_results()
    
    def _load_results(self):
        """تحميل النتائج"""
        if not self.results_log_path.exists():
            print(f"❌ Results log not found: {self.results_log_path}")
            return
        
        with open(self.results_log_path, 'r') as f:
            for line in f:
                try:
                    result = json.loads(line)
                    self.results.append(result)
                except:
                    continue
        
        print(f"📊 Loaded {len(self.results)} results")
    
    def show_overview(self):
        """عرض نظرة عامة"""
        if not self.results:
            print("❌ No results available")
            return
        
        successful = [r for r in self.results if r['summary']['success']]
        profitable = [r for r in self.results if r['summary']['netProfitETH'] > 0]
        
        total_profit = sum(r['summary']['netProfitETH'] for r in self.results)
        avg_profit = total_profit / len(self.results)
        
        total_gas = sum(r['post']['transaction']['gasCostETH'] for r in self.results)
        avg_gas = total_gas / len(self.results)
        
        roi_values = [r['reward']['roi'] for r in self.results]
        avg_roi = statistics.mean(roi_values)
        median_roi = statistics.median(roi_values)
        
        print("\n" + "="*70)
        print("📊 PERFORMANCE OVERVIEW")
        print("="*70)
        print(f"\n📈 Execution Stats:")
        print(f"   Total Decisions: {len(self.results)}")
        print(f"   Successful: {len(successful)} ({len(successful)/len(self.results)*100:.1f}%)")
        print(f"   Profitable: {len(profitable)} ({len(profitable)/len(self.results)*100:.1f}%)")
        
        print(f"\n💰 Financial Performance:")
        print(f"   Total Profit: {total_profit:.6f} ETH")
        print(f"   Average Profit per Decision: {avg_profit:.6f} ETH")
        print(f"   Total Gas Costs: {total_gas:.6f} ETH")
        print(f"   Average Gas Cost: {avg_gas:.6f} ETH")
        print(f"   Net Profit: {(total_profit - total_gas):.6f} ETH")
        
        print(f"\n📊 ROI Statistics:")
        print(f"   Average ROI: {avg_roi:.2f}%")
        print(f"   Median ROI: {median_roi:.2f}%")
        print(f"   Best ROI: {max(roi_values):.2f}%")
        print(f"   Worst ROI: {min(roi_values):.2f}%")
        
        # Confidence analysis
        confidence_profitable = [r['pre']['decision']['confidence'] 
                                for r in self.results 
                                if r['summary']['netProfitETH'] > 0]
        confidence_unprofitable = [r['pre']['decision']['confidence'] 
                                  for r in self.results 
                                  if r['summary']['netProfitETH'] <= 0]
        
        if confidence_profitable and confidence_unprofitable:
            avg_conf_profitable = statistics.mean(confidence_profitable)
            avg_conf_unprofitable = statistics.mean(confidence_unprofitable)
            
            print(f"\n🎯 Confidence Analysis:")
            print(f"   Avg Confidence (Profitable): {avg_conf_profitable:.3f}")
            print(f"   Avg Confidence (Unprofitable): {avg_conf_unprofitable:.3f}")
            print(f"   Confidence Correlation: {avg_conf_profitable > avg_conf_unprofitable and '✅ Positive' or '⚠️  Negative'}")
    
    def show_action_breakdown(self):
        """تفصيل حسب نوع الإجراء"""
        actions = defaultdict(lambda: {'count': 0, 'profitable': 0, 'total_profit': 0})
        
        for r in self.results:
            action = r['pre']['decision']['action']
            actions[action]['count'] += 1
            
            if r['summary']['netProfitETH'] > 0:
                actions[action]['profitable'] += 1
            
            actions[action]['total_profit'] += r['summary']['netProfitETH']
        
        print("\n" + "="*70)
        print("📋 BREAKDOWN BY ACTION")
        print("="*70)
        
        for action, stats in actions.items():
            profit_rate = (stats['profitable'] / stats['count'] * 100) if stats['count'] > 0 else 0
            avg_profit = stats['total_profit'] / stats['count'] if stats['count'] > 0 else 0
            
            print(f"\n🎯 {action.upper()}:")
            print(f"   Count: {stats['count']}")
            print(f"   Profitable: {stats['profitable']}/{stats['count']} ({profit_rate:.1f}%)")
            print(f"   Total Profit: {stats['total_profit']:.6f} ETH")
            print(f"   Avg Profit: {avg_profit:.6f} ETH")
    
    def show_time_analysis(self):
        """تحليل عبر الزمن"""
        if not self.results:
            return
        
        # Sort by time
        sorted_results = sorted(self.results, key=lambda r: r['executionTimestamp'])
        
        # Group by day
        daily_stats = defaultdict(lambda: {'count': 0, 'profit': 0, 'gas': 0})
        
        for r in sorted_results:
            timestamp = r['executionTimestamp']
            date = datetime.fromtimestamp(timestamp / 1000).date()
            
            daily_stats[date]['count'] += 1
            daily_stats[date]['profit'] += r['summary']['netProfitETH']
            daily_stats[date]['gas'] += r['post']['transaction']['gasCostETH']
        
        print("\n" + "="*70)
        print("📅 TIME ANALYSIS")
        print("="*70)
        
        print("\nDaily Performance:")
        for date in sorted(daily_stats.keys())[-7:]:  # Last 7 days
            stats = daily_stats[date]
            print(f"\n   {date}:")
            print(f"      Decisions: {stats['count']}")
            print(f"      Profit: {stats['profit']:.6f} ETH")
            print(f"      Gas: {stats['gas']:.6f} ETH")
            print(f"      Net: {(stats['profit'] - stats['gas']):.6f} ETH")
    
    def show_risk_analysis(self):
        """تحليل المخاطر"""
        risk_levels = defaultdict(lambda: {'count': 0, 'profitable': 0, 'total_profit': 0})
        
        for r in self.results:
            risk = r['pre']['decision']['riskLevel']
            risk_levels[risk]['count'] += 1
            
            if r['summary']['netProfitETH'] > 0:
                risk_levels[risk]['profitable'] += 1
            
            risk_levels[risk]['total_profit'] += r['summary']['netProfitETH']
        
        print("\n" + "="*70)
        print("⚠️  RISK ANALYSIS")
        print("="*70)
        
        for risk, stats in sorted(risk_levels.items()):
            profit_rate = (stats['profitable'] / stats['count'] * 100) if stats['count'] > 0 else 0
            avg_profit = stats['total_profit'] / stats['count'] if stats['count'] > 0 else 0
            
            print(f"\n🎯 {risk.upper()} Risk:")
            print(f"   Count: {stats['count']}")
            print(f"   Profitable: {stats['profitable']}/{stats['count']} ({profit_rate:.1f}%)")
            print(f"   Avg Profit: {avg_profit:.6f} ETH")
    
    def show_ml_performance(self):
        """تقييم أداء ML"""
        print("\n" + "="*70)
        print("🧠 ML MODEL PERFORMANCE")
        print("="*70)
        
        # Confidence bins
        bins = {
            'Very Low (0.0-0.3)': (0.0, 0.3),
            'Low (0.3-0.5)': (0.3, 0.5),
            'Medium (0.5-0.7)': (0.5, 0.7),
            'High (0.7-0.9)': (0.7, 0.9),
            'Very High (0.9-1.0)': (0.9, 1.0)
        }
        
        for bin_name, (min_conf, max_conf) in bins.items():
            bin_results = [r for r in self.results 
                          if min_conf <= r['pre']['decision']['confidence'] < max_conf]
            
            if not bin_results:
                continue
            
            profitable = len([r for r in bin_results if r['summary']['netProfitETH'] > 0])
            profit_rate = (profitable / len(bin_results) * 100) if bin_results else 0
            avg_profit = sum(r['summary']['netProfitETH'] for r in bin_results) / len(bin_results)
            
            print(f"\n📊 {bin_name}:")
            print(f"   Count: {len(bin_results)}")
            print(f"   Profitable Rate: {profit_rate:.1f}%")
            print(f"   Avg Profit: {avg_profit:.6f} ETH")
        
        # Expected vs Actual Reward
        print("\n🎯 Prediction Accuracy:")
        
        expected_rewards = [r['pre']['decision']['expectedReward'] for r in self.results]
        actual_rewards = [r['reward']['totalRewardETH'] for r in self.results]
        
        # Calculate correlation (simple)
        if len(expected_rewards) > 1:
            expected_mean = statistics.mean(expected_rewards)
            actual_mean = statistics.mean(actual_rewards)
            
            covariance = sum((e - expected_mean) * (a - actual_mean) 
                           for e, a in zip(expected_rewards, actual_rewards))
            
            expected_std = statistics.stdev(expected_rewards)
            actual_std = statistics.stdev(actual_rewards)
            
            if expected_std > 0 and actual_std > 0:
                correlation = covariance / (len(expected_rewards) * expected_std * actual_std)
                print(f"   Reward Correlation: {correlation:.3f}")
                
                if correlation > 0.5:
                    print(f"   Status: ✅ Good prediction accuracy")
                elif correlation > 0.2:
                    print(f"   Status: ⚠️  Moderate prediction accuracy")
                else:
                    print(f"   Status: ❌ Poor prediction accuracy - needs retraining")
    
    def export_report(self, output_path='./data/performance_report.txt'):
        """تصدير التقرير"""
        import sys
        from io import StringIO
        
        # Capture output
        old_stdout = sys.stdout
        sys.stdout = StringIO()
        
        self.show_overview()
        self.show_action_breakdown()
        self.show_time_analysis()
        self.show_risk_analysis()
        self.show_ml_performance()
        
        report = sys.stdout.getvalue()
        sys.stdout = old_stdout
        
        # Save to file
        with open(output_path, 'w') as f:
            f.write(report)
        
        print(f"\n✅ Report exported to: {output_path}")


def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='📊 Performance Dashboard')
    parser.add_argument('--results', default='./data/results_log.ndjson')
    parser.add_argument('--export', action='store_true', help='Export report')
    parser.add_argument('--section', choices=['overview', 'actions', 'time', 'risk', 'ml', 'all'], 
                       default='all', help='Section to show')
    
    args = parser.parse_args()
    
    dashboard = PerformanceDashboard(args.results)
    
    if not dashboard.results:
        print("❌ No results available. Run some decisions first!")
        return
    
    if args.export:
        dashboard.export_report()
        return
    
    if args.section == 'all':
        dashboard.show_overview()
        dashboard.show_action_breakdown()
        dashboard.show_time_analysis()
        dashboard.show_risk_analysis()
        dashboard.show_ml_performance()
    elif args.section == 'overview':
        dashboard.show_overview()
    elif args.section == 'actions':
        dashboard.show_action_breakdown()
    elif args.section == 'time':
        dashboard.show_time_analysis()
    elif args.section == 'risk':
        dashboard.show_risk_analysis()
    elif args.section == 'ml':
        dashboard.show_ml_performance()


if __name__ == '__main__':
    main()
