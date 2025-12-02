# 🔒 Security Policy

## Reporting Security Vulnerabilities

**Please DO NOT file a public issue for security vulnerabilities.**

Instead, send an email to: **security@example.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will respond within 48 hours and work with you to address the issue.

## Security Best Practices

### Private Key Management

**Critical: Never commit private keys to version control!**

✅ **Recommended Approaches:**

1. **Hardware Wallet** (Most Secure)
   ```bash
   # Use Ledger/Trezor for signing
   # Configure in offchain.js to use hardware wallet
   ```

2. **Environment Variables**
   ```bash
   # Store in .env (never committed)
   PRIVATE_KEY=your_key_here
   
   # Or use secure environment management
   export PRIVATE_KEY=$(vault read -field=key secret/eth)
   ```

3. **Key Management Service**
   ```bash
   # AWS KMS, Azure Key Vault, Google Cloud KMS
   # HashiCorp Vault
   ```

❌ **Never Do:**
- Commit keys to Git
- Store keys in code
- Share keys via email/chat
- Use production keys in development

### Smart Contract Security

#### Access Control

```solidity
// Use OpenZeppelin AccessControl
contract MyContract is AccessControl {
    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");
    
    modifier onlyUpdater() {
        require(hasRole(UPDATER_ROLE, msg.sender), "Not updater");
        _;
    }
}
```

#### Emergency Controls

```solidity
// Implement pause functionality
contract MyContract is Pausable {
    function emergencyPause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
}
```

#### Reentrancy Protection

```solidity
// Use ReentrancyGuard
contract MyContract is ReentrancyGuard {
    function criticalFunction() external nonReentrant {
        // Protected code
    }
}
```

### RPC Endpoint Security

✅ **Best Practices:**

1. **Use Authenticated Endpoints**
   ```bash
   RPC_URL=https://mainnet.infura.io/v3/YOUR_SECRET_KEY
   ```

2. **Implement Rate Limiting**
   ```javascript
   // In code, implement retry logic with backoff
   const response = await withRetry(() => provider.call(...));
   ```

3. **Use Multiple Fallbacks**
   ```bash
   RPC_URLS=https://rpc1.com,https://rpc2.com,https://rpc3.com
   ```

4. **Monitor RPC Usage**
   ```javascript
   // Track and alert on high usage
   metrics.rpcCalls.inc();
   ```

### Gas Price Protection

```javascript
// In offchain.js
const MAX_GAS_GWEI = 200;
const MAX_GAS_PCT = 5.0;

if (gasPriceGwei > MAX_GAS_GWEI) {
    console.warn('Gas price too high, skipping');
    return;
}

if (gasCostPct > MAX_GAS_PCT) {
    console.warn('Gas cost too high relative to position');
    return;
}
```

### Input Validation

```javascript
// Validate all inputs
function validateState(state) {
    if (!state.poolId || typeof state.poolId !== 'string') {
        throw new Error('Invalid poolId');
    }
    
    if (state.current_price <= 0) {
        throw new Error('Invalid price');
    }
    
    // ... more validations
}
```

### API Security

#### Rate Limiting

```python
# In api.py
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.post("/decide")
@limiter.limit("10/minute")
async def decide(state: StateInput):
    # ...
```

#### Authentication

```python
# Add API key authentication
from fastapi import Security, HTTPException
from fastapi.security import APIKeyHeader

API_KEY_HEADER = APIKeyHeader(name="X-API-Key")

async def verify_api_key(api_key: str = Security(API_KEY_HEADER)):
    if api_key != os.getenv("API_KEY"):
        raise HTTPException(status_code=403, detail="Invalid API key")
    return api_key
```

#### HTTPS Only

```python
# Force HTTPS in production
from fastapi.middleware.httpsredirect import HTTPSRedirectMiddleware

if os.getenv("ENV") == "production":
    app.add_middleware(HTTPSRedirectMiddleware)
```

### Model Security

#### Model Integrity

```python
# In ai_engine.py - Model checksum verification
def save_model(self, path: str):
    joblib.dump(self.model, path)
    
    # Calculate and save checksum
    with open(path, 'rb') as f:
        checksum = hashlib.sha256(f.read()).hexdigest()
    
    with open(f"{path}.sha256", 'w') as f:
        f.write(checksum)

def load_model(self, path: str):
    # Verify checksum before loading
    with open(f"{path}.sha256", 'r') as f:
        expected = f.read().strip()
    
    with open(path, 'rb') as f:
        actual = hashlib.sha256(f.read()).hexdigest()
    
    if actual != expected:
        raise ValueError("Model checksum mismatch!")
    
    return joblib.load(path)
```

#### Model Poisoning Protection

```python
# Validate training data before using
def validate_training_data(data):
    # Check for outliers
    if np.abs(data).max() > REASONABLE_MAX:
        raise ValueError("Suspicious training data detected")
    
    # Check data distribution
    if np.std(data) > REASONABLE_STD:
        raise ValueError("Unusual data distribution")
```

### Monitoring & Alerting

```yaml
# monitoring/prometheus/alerts.yml
groups:
  - name: security_alerts
    rules:
      # Detect unusual activity
      - alert: UnusualTransactionRate
        expr: rate(defi_actions_total[5m]) > 10
        for: 5m
        annotations:
          summary: "Unusual transaction rate detected"
      
      # Detect losses
      - alert: LargeLoss
        expr: defi_profit_loss_eth < -5
        annotations:
          summary: "Large loss detected"
      
      # Detect high error rate
      - alert: HighErrorRate
        expr: rate(defi_errors_total[5m]) > 1
        for: 5m
        annotations:
          summary: "High error rate detected"
```

## Deployment Security

### Pre-Deployment Checklist

- [ ] **Smart Contract Audit**: Get contracts audited by professional firm
- [ ] **Code Review**: Peer review all code changes
- [ ] **Dependency Audit**: `npm audit` and `pip check`
- [ ] **Environment Isolation**: Separate dev/staging/production
- [ ] **Secrets Management**: No secrets in code or env files
- [ ] **Access Control**: Limit who can deploy
- [ ] **Monitoring**: All alerts configured
- [ ] **Backup Strategy**: Backup plans in place
- [ ] **Incident Response**: Plan documented
- [ ] **Rate Limits**: All APIs rate-limited
- [ ] **HTTPS Only**: Force HTTPS in production
- [ ] **Logging**: All sensitive operations logged

### Production Environment

```bash
# .env.production
# Never use development keys in production!
PRIVATE_KEY=production_key_from_secure_vault

# Use authenticated RPC
RPC_URL=https://mainnet.infura.io/v3/PRODUCTION_KEY

# Strict limits
MAX_GAS_GWEI=100
MAX_GAS_PCT=2.5
MIN_REBALANCE_INTERVAL_HOURS=6

# Production logging
LOG_LEVEL=info
SENTRY_DSN=your_sentry_dsn

# Security headers
ENABLE_CORS=false
ENABLE_RATE_LIMITING=true
REQUIRE_API_KEY=true
```

### Infrastructure Security

#### Firewall Rules

```bash
# Allow only necessary ports
ufw allow 22/tcp    # SSH (from specific IPs only)
ufw allow 80/tcp    # HTTP (redirect to HTTPS)
ufw allow 443/tcp   # HTTPS
ufw deny 8545/tcp   # Block direct RPC access
ufw enable
```

#### SSH Hardening

```bash
# /etc/ssh/sshd_config
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AllowUsers your_user
```

#### Docker Security

```yaml
# docker-compose.yml
services:
  ai-service:
    security_opt:
      - no-new-privileges:true
    read_only: true
    user: "1000:1000"
    cap_drop:
      - ALL
```

## Incident Response

### If Private Key Compromised

1. **Immediately**:
   - Stop all services
   - Revoke compromised key access in contracts
   - Move funds to new address

2. **Within 1 Hour**:
   - Generate new keys
   - Update all services
   - Review transaction history

3. **Within 24 Hours**:
   - Investigate how compromise occurred
   - Document incident
   - Implement additional safeguards

### If Contract Exploited

1. **Immediately**:
   - Call `pause()` on all contracts
   - Alert users
   - Assess damage

2. **Within 4 Hours**:
   - Identify exploit vector
   - Develop fix
   - Test fix thoroughly

3. **Within 24 Hours**:
   - Deploy fix
   - Resume operations
   - Post-mortem report

### If Model Poisoned

1. **Immediately**:
   - Stop using affected model
   - Revert to known-good model
   - Review recent training data

2. **Within 24 Hours**:
   - Identify poisoned data
   - Retrain with clean data
   - Add validation checks

## Security Auditing

### Regular Audits

- **Monthly**: Dependency updates and security patches
- **Quarterly**: Full security review
- **Annually**: Professional penetration testing

### Audit Checklist

```bash
# Smart Contracts
npm audit
slither contracts/

# Python Dependencies
pip check
safety check

# Node Dependencies
npm audit
snyk test

# Code Quality
npm run lint
pytest --cov

# Environment
grep -r "private" . --exclude-dir=node_modules
grep -r "password" . --exclude-dir=node_modules
```

## Responsible Disclosure

We appreciate security researchers who:
- Privately disclose vulnerabilities
- Give us reasonable time to fix
- Don't exploit vulnerabilities
- Don't disclose to others before fix

We commit to:
- Respond within 48 hours
- Provide regular updates
- Credit researchers (if desired)
- Fix within reasonable timeframe

## Security Resources

- [Smart Contract Security Best Practices](https://consensys.github.io/smart-contract-best-practices/)
- [OpenZeppelin Security](https://docs.openzeppelin.com/contracts/4.x/security)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security](https://nodejs.org/en/docs/guides/security/)
- [Python Security](https://python.readthedocs.io/en/stable/library/security.html)

## Contact

For security issues: **security@example.com**

PGP Key: [Link to public key]

---

**Last Updated**: 2024-01-01

**Security Policy Version**: 1.0
