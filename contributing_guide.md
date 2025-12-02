# Contributing to Uniswap V3 AI Manager

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to this project.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Process](#development-process)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing Guidelines](#testing-guidelines)
- [Documentation](#documentation)

## 📜 Code of Conduct

### Our Pledge

We pledge to make participation in our project a harassment-free experience for everyone, regardless of age, body size, disability, ethnicity, gender identity and expression, level of experience, nationality, personal appearance, race, religion, or sexual identity and orientation.

### Our Standards

**Positive behavior includes:**
- Using welcoming and inclusive language
- Being respectful of differing viewpoints
- Gracefully accepting constructive criticism
- Focusing on what is best for the community
- Showing empathy towards other community members

**Unacceptable behavior includes:**
- Trolling, insulting/derogatory comments, and personal attacks
- Public or private harassment
- Publishing others' private information
- Other conduct which could reasonably be considered inappropriate

## 🚀 Getting Started

### Prerequisites

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/zentsystems-ctrl/uniswap-ai-liquidity-manager-pro.git
   cd uniswap-ai-liquidity-manager-pro
   ```

3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/uniswap-ai-liquidity-manager-pro.git
   ```

4. **Install dependencies**:
   ```bash
   npm install
   pip install -r requirements_ai.txt
   ```

5. **Set up environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

### Development Environment Setup

1. **Install Hardhat** (for smart contract development):
   ```bash
   npm install --save-dev hardhat
   ```

2. **Install Python dev tools**:
   ```bash
   pip install pytest pytest-cov black flake8 mypy
   ```

3. **Install Git hooks** (optional):
   ```bash
   npm run prepare
   ```

## 💻 Development Process

### Branching Strategy

We use **Git Flow** branching model:

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - New features
- `bugfix/*` - Bug fixes
- `hotfix/*` - Urgent fixes for production

### Creating a Feature Branch

```bash
# Update your local develop branch
git checkout develop
git pull upstream develop

# Create feature branch
git checkout -b feature/your-feature-name
```

### Making Changes

1. **Write your code** following our [Coding Standards](#coding-standards)
2. **Add tests** for new functionality
3. **Update documentation** if needed
4. **Run tests** to ensure everything works:
   ```bash
   npm test
   pytest
   ```

5. **Commit your changes**:
   ```bash
   git add .
   git commit -m "feat: add amazing feature"
   ```

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(ai-engine): add XGBoost model support

Implemented XGBoost integration to improve prediction accuracy.
Added model ensemble voting mechanism.

Closes #123
```

```
fix(offchain): resolve gas estimation error

Fixed issue where gas estimation would fail for large positions.
Added fallback to static gas limits when estimation fails.

Fixes #456
```

## 🔀 Pull Request Process

### Before Submitting

1. **Sync with upstream**:
   ```bash
   git checkout develop
   git pull upstream develop
   git checkout feature/your-feature-name
   git rebase develop
   ```

2. **Run all tests**:
   ```bash
   npm run test:full
   pytest test_ai_engine.py -v
   ```

3. **Check code style**:
   ```bash
   npm run lint
   black . --check
   flake8 .
   ```

4. **Update documentation** if needed

### Submitting Pull Request

1. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create PR** on GitHub with:
   - Clear title following commit message format
   - Detailed description of changes
   - Link to related issues
   - Screenshots (if UI changes)
   - Checklist of completed tasks

### PR Template

```markdown
## Description
Brief description of what this PR does.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Related Issues
Closes #123

## Changes Made
- Change 1
- Change 2
- Change 3

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
- [ ] No new warnings generated
- [ ] Tests added/updated
- [ ] All tests pass
```

### Review Process

1. **Automated checks** must pass (CI/CD)
2. **At least one reviewer** must approve
3. **All comments** must be resolved
4. **No merge conflicts** with target branch

## 📝 Coding Standards

### Solidity Style Guide

Follow [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html):

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ContractName
 * @notice Brief description
 */
contract ContractName {
    // State variables
    uint256 public stateVar;
    
    // Events
    event EventName(address indexed user, uint256 amount);
    
    // Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }
    
    // Functions: external, public, internal, private
    function externalFunc() external { }
    
    function publicFunc() public { }
    
    function _internalFunc() internal { }
    
    function _privateFunc() private { }
}
```

**Key points:**
- Use 4 spaces for indentation
- Maximum line length: 120 characters
- Use NatSpec comments for documentation
- Order: state variables, events, modifiers, functions

### JavaScript Style Guide

Follow [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript):

```javascript
// Use const/let, not var
const MAX_RETRIES = 3;
let currentAttempt = 0;

// Use arrow functions
const calculateReward = (amount, rate) => amount * rate;

// Use async/await over promises
async function fetchData() {
    try {
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        console.error('Error:', error);
        throw error;
    }
}

// Use template literals
const message = `Processing ${count} items`;

// Use destructuring
const { x, y } = point;
const [first, second] = array;
```

**Key points:**
- Use semicolons
- 2 spaces for indentation
- Single quotes for strings
- No trailing commas in objects/arrays
- Use JSDoc comments for functions

### Python Style Guide

Follow [PEP 8](https://pep8.org/):

```python
"""Module docstring."""

import os
import sys
from typing import List, Dict, Optional

# Constants in UPPER_CASE
MAX_ITERATIONS = 100
DEFAULT_TIMEOUT = 30


class ExampleClass:
    """Class docstring."""
    
    def __init__(self, param: str):
        """Initialize with param."""
        self.param = param
        self._private_var = 0
    
    def public_method(self, arg: int) -> float:
        """
        Public method description.
        
        Args:
            arg: Argument description
            
        Returns:
            Return value description
        """
        return self._calculate(arg)
    
    def _private_method(self, value: float) -> float:
        """Private method."""
        return value * 2.0
```

**Key points:**
- 4 spaces for indentation
- Maximum line length: 88 characters (Black default)
- Use type hints
- Use docstrings for all public functions/classes
- snake_case for functions/variables
- PascalCase for classes

## 🧪 Testing Guidelines

### Smart Contract Tests

```javascript
// test/Contract.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ContractName", function() {
    let contract;
    let owner, addr1;
    
    beforeEach(async function() {
        [owner, addr1] = await ethers.getSigners();
        const Contract = await ethers.getContractFactory("ContractName");
        contract = await Contract.deploy();
    });
    
    describe("Function Name", function() {
        it("Should do something", async function() {
            await contract.someFunction();
            expect(await contract.someValue()).to.equal(expectedValue);
        });
        
        it("Should revert when...", async function() {
            await expect(
                contract.someFunction()
            ).to.be.revertedWith("Error message");
        });
    });
});
```

### Python Tests

```python
# test_module.py
import pytest
from module import function_to_test


class TestClassName:
    """Test class description."""
    
    def setup_method(self):
        """Setup before each test."""
        self.test_data = create_test_data()
    
    def test_function_success(self):
        """Test successful case."""
        result = function_to_test(self.test_data)
        assert result == expected_value
    
    def test_function_failure(self):
        """Test failure case."""
        with pytest.raises(ValueError):
            function_to_test(invalid_data)
    
    @pytest.mark.parametrize("input,expected", [
        (1, 2),
        (2, 4),
        (3, 6),
    ])
    def test_function_parametrized(self, input, expected):
        """Test with multiple inputs."""
        assert function_to_test(input) == expected
```

### Test Coverage Requirements

- **Smart Contracts**: Minimum 90% coverage
- **Python Code**: Minimum 85% coverage
- **JavaScript Code**: Minimum 80% coverage

Run coverage:
```bash
npx hardhat coverage
pytest --cov=. --cov-report=html
```

## 📚 Documentation

### Code Comments

- Use comments to explain **why**, not **what**
- Keep comments up-to-date with code changes
- Use JSDoc/docstrings for public APIs

### README Updates

When adding new features, update:
- Features section
- Usage examples
- Configuration options
- API documentation

### Wiki Contributions

For substantial documentation:
1. Create page in Wiki
2. Link from main README
3. Include examples and diagrams

## 🏷️ Issue Labels

We use the following labels:

- `bug` - Something isn't working
- `enhancement` - New feature or request
- `documentation` - Documentation improvements
- `good first issue` - Good for newcomers
- `help wanted` - Extra attention needed
- `question` - Further information requested
- `wontfix` - This will not be worked on
- `duplicate` - This issue already exists
- `invalid` - This doesn't seem right

## 💬 Communication Channels

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: Questions and general discussion
- **Pull Requests**: Code review and technical discussion

## 🎯 What to Contribute

### Good First Issues

- Documentation improvements
- Adding tests
- Fixing typos
- Improving error messages
- Adding examples

### Feature Ideas

- Support for additional DEXs
- New ML models
- Performance optimizations
- Better monitoring
- UI/Dashboard improvements

### High Priority Areas

Check issues labeled with:
- `priority: high`
- `help wanted`
- `good first issue`

## ✅ PR Checklist

Before submitting, ensure:

- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex logic
- [ ] Documentation updated
- [ ] Tests added/updated
- [ ] All tests pass
- [ ] No console.log or print statements left
- [ ] No commented-out code
- [ ] No merge conflicts
- [ ] Branch is up-to-date with target

## 🙏 Thank You!

Your contributions make this project better for everyone. We appreciate your time and effort!

For questions, reach out via:
- GitHub Issues
- GitHub Discussions
- Email: maintainer@example.com

---

**Happy Contributing! 🚀**
