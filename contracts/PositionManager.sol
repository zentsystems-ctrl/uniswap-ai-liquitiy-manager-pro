// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "./libs/TickMath.sol";
import "./libs/FullMath.sol";
import "prb-math/contracts/PRBMathUD60x18.sol";

/**
 * @title PositionManager Contract
 * @notice Manages Uniswap V3 liquidity positions with percentage-based rebalancing
 */
contract PositionManager is AccessControl, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    uint256 public constant WAD = 1e18;
    uint256 public constant Q96 = 2**96;

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");
    bytes32 public constant RESCUE_ROLE = keccak256("RESCUE_ROLE");

    // ═══════════════════════════════════════════════════════════════════════════════
    // IMMUTABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    IIndex public immutable index;
    INonfungiblePositionManager public immutable nfpm;

    // ═══════════════════════════════════════════════════════════════════════════════
    // STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════════

    struct Position {
        address owner;
        bytes32 poolId;
        IIndex.Level level;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint24 feeTier;
        address token0;
        address token1;
        bool active;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    mapping(uint256 => Position) public positions;
    uint256 public nextPositionId = 1;
    mapping(address => mapping(address => uint256)) public withdrawable;
    
    mapping(uint256 => uint256) public stuckNFTs;
    mapping(uint256 => address) public stuckNFTOwners;

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    event OpenPosition(uint256 indexed id, address indexed owner, uint256 tokenId, int24 lower, int24 upper, uint128 liquidity);
    event IncreaseLiquidityEv(uint256 indexed id, uint128 added, uint256 used0, uint256 used1);
    event CollectFees(uint256 indexed id, uint256 amt0, uint256 amt1);
    event RepositionPerformed(uint256 indexed id, uint256 oldTokenId, uint256 newTokenId, uint128 oldLiq, uint128 newLiq, uint256 nonce);
    event SyncPositionCommitted(uint256 indexed id, int24 oldLower, int24 oldUpper, int24 newLower, int24 newUpper);
    event ClosePosition(uint256 indexed id);
    event Withdrawn(address indexed who, address indexed token, uint256 amount);
    event RefundQueued(address indexed who, address indexed token, uint256 amount);
    event SyncFailedDecrease(uint256 indexed posId, string reason);
    event SyncFailedCollect(uint256 indexed posId, string reason);
    event SyncFailedMint(uint256 indexed posId, string reason);
    event OldTokenStuck(uint256 indexed posId, uint256 oldTokenId);
    event NFTStuckRecorded(uint256 indexed posId, uint256 tokenId, address owner);
    event NFTRecovered(uint256 indexed posId, uint256 tokenId, address owner);
    event NFTCleanupPartialSuccess(uint256 indexed posId, uint256 tokenId, string method);

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    error ZeroAddr();
    error NotOwner();
    error Inactive();
    error UnsupportedFeeTier();
    error NoStuckNFT();

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    constructor(address unifiedIndex_, address nfpm_) {
        if (unifiedIndex_ == address(0) || nfpm_ == address(0)) revert ZeroAddr();
        index = IIndex(unifiedIndex_);
        nfpm = INonfungiblePositionManager(nfpm_);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MANAGER_ROLE, msg.sender);
        _grantRole(UPDATER_ROLE, msg.sender);
        _grantRole(RESCUE_ROLE, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════════

    modifier onlyOwnerOf(uint256 id) {
        if (positions[id].owner != msg.sender) revert NotOwner();
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERC721 RECEIVER
    // ═══════════════════════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata) 
        external 
        pure 
        override 
        returns (bytes4) 
    {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TICK MATH HELPERS
    // ═══════════════════════════════════════════════════════════════════════════════

    function _tickSpacing(uint24 fee) internal pure returns (int24) {
        if (fee == 100) return 1;
        if (fee == 500) return 10;
        if (fee == 3000) return 60;
        if (fee == 10000) return 200;
        revert UnsupportedFeeTier();
    }

    function _snapTickDown(int24 tick, int24 spacing) internal pure returns (int24) {
        if (spacing == 0) return tick;
        int256 t = int256(tick);
        int256 s = int256(spacing);
        int256 rem = t % s;
        if (rem < 0) rem += s;
        return int24(t - rem);
    }

    function _snapTickUp(int24 tick, int24 spacing) internal pure returns (int24) {
        if (spacing == 0) return tick;
        int256 t = int256(tick);
        int256 s = int256(spacing);
        int256 rem = t % s;
        if (rem < 0) rem += s;
        if (rem == 0) return tick;
        return int24(t + (s - rem));
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TICK COMPUTATION
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
    * @notice Compute ticks from percentage bounds
    * @param p_ref_wad Reference price in WAD
    * @param pctInt Percentage threshold (1 = 1%, 5 = 5%, etc.)
    * @param fee Fee tier for tick spacing
    * @param decimals0 Token0 decimals
    * @param decimals1 Token1 decimals
    * @return lower Lower tick
    * @return upper Upper tick
     */

       function _computeTicks(
        uint256 p_ref_wad,
        uint256 pctInt,
        uint24 fee,
        uint8 decimals0,
        uint8 decimals1
    ) internal view returns (int24 lower, int24 upper) {
        require(p_ref_wad > 0, "p_ref=0");
        require(pctInt > 0 && pctInt <= 100, "pct invalid");
        
        int24 spacing = _tickSpacing(fee);

        // Get price bounds from Index
        (uint256 Pmin_wad, uint256 Pmax_wad) = index.computePriceBounds(p_ref_wad, pctInt);
        
        // ✅ FIX: Properly adjust for decimals BEFORE any sqrt operations
        // The key insight: we need "raw" prices in the scale that Uniswap expects
        uint256 Pmin_raw_wad;
        uint256 Pmax_raw_wad;
        
        if (decimals1 >= decimals0) {
            uint256 diff = uint256(decimals1 - decimals0);
            require(diff <= 36, "decimals diff too large");
            uint256 factor = 10 ** diff;
            // Price in Uniswap terms: amount1/amount0 with decimal adjustment
            Pmin_raw_wad = FullMath.mulDiv(Pmin_wad, factor, 1);
            Pmax_raw_wad = FullMath.mulDiv(Pmax_wad, factor, 1);
        } else {
            uint256 diff = uint256(decimals0 - decimals1);
            require(diff <= 36, "decimals diff too large");
            uint256 factor = 10 ** diff;
            Pmin_raw_wad = FullMath.mulDiv(Pmin_wad, 1, factor);
            Pmax_raw_wad = FullMath.mulDiv(Pmax_wad, 1, factor);
        }

        // ✅ FIX: Use PRBMath sqrt which handles WAD format correctly
        // This maintains 18 decimals of precision throughout
        uint256 sqrtPmin_wad = PRBMathUD60x18.sqrt(Pmin_raw_wad);
        uint256 sqrtPmax_wad = PRBMathUD60x18.sqrt(Pmax_raw_wad);
        
        // Convert from WAD to Q96 format (Uniswap's sqrtPriceX96)
        uint256 sqrtPriceX96Min = FullMath.mulDiv(sqrtPmin_wad, Q96, WAD);
        uint256 sqrtPriceX96Max = FullMath.mulDiv(sqrtPmax_wad, Q96, WAD);

        // Clamp to Uniswap's valid range
        uint256 minRatio = uint256(TickMath.MIN_SQRT_RATIO);
        uint256 maxRatio = uint256(TickMath.MAX_SQRT_RATIO);
        
        if (sqrtPriceX96Min < minRatio) sqrtPriceX96Min = minRatio;
        if (sqrtPriceX96Min > maxRatio) sqrtPriceX96Min = maxRatio;
        if (sqrtPriceX96Max < minRatio) sqrtPriceX96Max = minRatio;
        if (sqrtPriceX96Max > maxRatio) sqrtPriceX96Max = maxRatio;

        // Get ticks from sqrtPrice
        int24 rawLower = TickMath.getTickAtSqrtRatio(uint160(sqrtPriceX96Min));
        int24 rawUpper = TickMath.getTickAtSqrtRatio(uint160(sqrtPriceX96Max));
        
        // Snap to tick spacing
        lower = _snapTickDown(rawLower, spacing);
        upper = _snapTickUp(rawUpper, spacing);
        
        // Ensure lower < upper
        if (lower > upper) (lower, upper) = (upper, lower);
        
        // Validate range
        require(lower >= -887272 && upper <= 887272, "ticks out of range");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REFUND MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════════

    function _queueRefund(address to, address token, uint256 amount) internal {
        if (amount == 0) return;
        withdrawable[to][token] += amount;
        emit RefundQueued(to, token, amount);
    }

    function _refundDelta(Position storage pos, uint256 bal0Before, uint256 bal1Before) internal {
        uint256 bal0After = IERC20(pos.token0).balanceOf(address(this));
        uint256 bal1After = IERC20(pos.token1).balanceOf(address(this));
        uint256 left0 = bal0After > bal0Before ? bal0After - bal0Before : 0;
        uint256 left1 = bal1After > bal1Before ? bal1After - bal1Before : 0;
        if (left0 > 0) _queueRefund(pos.owner, pos.token0, left0);
        if (left1 > 0) _queueRefund(pos.owner, pos.token1, left1);
    }

    function withdraw(address token) external nonReentrant {
        uint256 amt = withdrawable[msg.sender][token];
        require(amt > 0, "no funds");
        withdrawable[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amt);
        emit Withdrawn(msg.sender, token, amt);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // NFT CLEANUP HELPER
    // ═══════════════════════════════════════════════════════════════════════════════

    function _cleanupNFT(uint256 tokenId, address owner, uint256 posId) internal returns (bool success) {
        try nfpm.burn(tokenId) {
            emit NFTCleanupPartialSuccess(posId, tokenId, "burned");
            return true;
        } catch {
            try IERC721(address(nfpm)).safeTransferFrom(address(this), owner, tokenId) {
                emit NFTCleanupPartialSuccess(posId, tokenId, "transferred");
                return true;
            } catch {
                stuckNFTs[posId] = tokenId;
                stuckNFTOwners[tokenId] = owner;
                emit NFTStuckRecorded(posId, tokenId, owner);
                emit OldTokenStuck(posId, tokenId);
                return false;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // POSITION MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════════

    function openPosition(
        bytes32 poolId,
        IIndex.Level level,
        address token0,
        address token1,
        uint24 fee,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 id) {
        require(deadline >= block.timestamp, "deadline");
        
        uint8 li = uint8(level);
        require(li <= 3, "invalid level");
        
        uint8[] memory pctLevels = index.getPctLevels();
        require(li < pctLevels.length, "invalid level");
        uint256 pctInt = uint256(pctLevels[li]);
        
        (uint256[] memory p_refs, , , , ) = index.getAllLevels(poolId);
        require(li < p_refs.length, "invalid level");
        
        uint256 p_ref = p_refs[li];
        require(p_ref != 0, "zero pref");

        ( , , uint8 dec0, uint8 dec1, , , , , ) = index.pools(poolId);

        (int24 tickLower, int24 tickUpper) = _computeTicks(p_ref, pctInt, fee, dec0, dec1);

        int24 spacing = _tickSpacing(fee);
        require(tickLower < tickUpper, "invalid tick range");
        require((tickUpper - tickLower) % spacing == 0, "tick range not multiple of spacing");
        require(tickLower % spacing == 0, "tickLower not aligned to spacing");
        require(tickUpper % spacing == 0, "tickUpper not aligned to spacing");

        uint256 bal0Before = IERC20(token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(token1).balanceOf(address(this));

        IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1Desired);

        if (amount0Desired > 0) {
            IERC20(token0).safeApprove(address(nfpm), 0);
            IERC20(token0).safeApprove(address(nfpm), amount0Desired);
        }
        if (amount1Desired > 0) {
            IERC20(token1).safeApprove(address(nfpm), 0);
            IERC20(token1).safeApprove(address(nfpm), amount1Desired);
        }

        INonfungiblePositionManager.MintParams memory params = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: fee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            recipient: address(this),
            deadline: deadline
        });
        (uint256 tokenId, uint128 liquidity, , ) = nfpm.mint(params);
        require(liquidity > 0, "mint zero liq");

        if (amount0Desired > 0) IERC20(token0).safeApprove(address(nfpm), 0);
        if (amount1Desired > 0) IERC20(token1).safeApprove(address(nfpm), 0);

        uint256 bal0After = IERC20(token0).balanceOf(address(this));
        uint256 bal1After = IERC20(token1).balanceOf(address(this));
        uint256 left0 = bal0After > bal0Before ? bal0After - bal0Before : 0;
        uint256 left1 = bal1After > bal1Before ? bal1After - bal1Before : 0;
        if (left0 > 0) _queueRefund(msg.sender, token0, left0);
        if (left1 > 0) _queueRefund(msg.sender, token1, left1);

        id = nextPositionId++;
        positions[id] = Position({
            owner: msg.sender,
            poolId: poolId,
            level: level,
            tokenId: tokenId,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            feeTier: fee,
            token0: token0,
            token1: token1,
            active: true
        });
        emit OpenPosition(id, msg.sender, tokenId, tickLower, tickUpper, liquidity);
    }

    function increaseLiquidity(
        uint256 posId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external nonReentrant whenNotPaused onlyOwnerOf(posId) {
        require(deadline >= block.timestamp, "deadline");
        Position storage pos = positions[posId];
        if (!pos.active) revert Inactive();
        require(pos.tokenId != 0, "no token");

        uint256 bal0Before = IERC20(pos.token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(pos.token1).balanceOf(address(this));

        IERC20(pos.token0).safeTransferFrom(msg.sender, address(this), amount0Desired);
        IERC20(pos.token1).safeTransferFrom(msg.sender, address(this), amount1Desired);

        if (amount0Desired > 0) {
            IERC20(pos.token0).safeApprove(address(nfpm), 0);
            IERC20(pos.token0).safeApprove(address(nfpm), amount0Desired);
        }
        if (amount1Desired > 0) {
            IERC20(pos.token1).safeApprove(address(nfpm), 0);
            IERC20(pos.token1).safeApprove(address(nfpm), amount1Desired);
        }

        (uint128 added, uint256 used0, uint256 used1) = nfpm.increaseLiquidity(INonfungiblePositionManager.IncreaseLiquidityParams({
            tokenId: pos.tokenId,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            deadline: deadline
        }));

        if (amount0Desired > 0) IERC20(pos.token0).safeApprove(address(nfpm), 0);
        if (amount1Desired > 0) IERC20(pos.token1).safeApprove(address(nfpm), 0);

        uint256 bal0After = IERC20(pos.token0).balanceOf(address(this));
        uint256 bal1After = IERC20(pos.token1).balanceOf(address(this));
        uint256 left0 = bal0After > bal0Before ? bal0After - bal0Before : 0;
        uint256 left1 = bal1After > bal1Before ? bal1After - bal1Before : 0;
        if (left0 > 0) _queueRefund(pos.owner, pos.token0, left0);
        if (left1 > 0) _queueRefund(pos.owner, pos.token1, left1);

        pos.liquidity += added;
        emit IncreaseLiquidityEv(posId, added, used0, used1);
    }

    function collectFees(uint256 posId, uint128 amount0Max, uint128 amount1Max) 
        external 
        nonReentrant 
        whenNotPaused 
        onlyOwnerOf(posId) 
    {
        Position storage pos = positions[posId];
        if (!pos.active) revert Inactive();
        (uint256 amt0, uint256 amt1) = nfpm.collect(INonfungiblePositionManager.CollectParams({
            tokenId: pos.tokenId,
            recipient: address(this),
            amount0Max: amount0Max,
            amount1Max: amount1Max
        }));
        if (amt0 > 0) _queueRefund(pos.owner, pos.token0, amt0);
        if (amt1 > 0) _queueRefund(pos.owner, pos.token1, amt1);
        emit CollectFees(posId, amt0, amt1);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // POSITION SYNCING (REBALANCING)
    // ═══════════════════════════════════════════════════════════════════════════════

    function syncPosition(uint256 posId) external nonReentrant whenNotPaused onlyRole(UPDATER_ROLE) {
        Position storage pos = positions[posId];
        if (!pos.active) revert Inactive();
        require(pos.tokenId != 0, "no token");

        uint8[] memory pctLevels = index.getPctLevels();
        uint8 li = uint8(pos.level);
        require(li < pctLevels.length, "invalid level");
        uint256 pctInt = uint256(pctLevels[li]);
        
        (uint256[] memory p_refs, , , , ) = index.getAllLevels(pos.poolId);
        require(li < p_refs.length, "invalid level");
        uint256 p_ref = p_refs[li];
        require(p_ref != 0, "zero pref");

        uint256 currentNonce = index.getRepositionNonce(pos.poolId, pos.level);

        ( , , uint8 dec0, uint8 dec1, , , , , ) = index.pools(pos.poolId);
        
        (int24 newLower, int24 newUpper) = _computeTicks(p_ref, pctInt, pos.feeTier, dec0, dec1);

        int24 oldLower = pos.tickLower;
        int24 oldUpper = pos.tickUpper;
        uint256 oldTokenId = pos.tokenId;
        uint128 oldLiq = pos.liquidity;

        if (oldLower == newLower && oldUpper == newUpper) {
            emit SyncPositionCommitted(posId, oldLower, oldUpper, newLower, newUpper);
            return;
        }

        ( , , address token0Onchain, address token1Onchain, uint24 feeOnchain, , , uint128 reportedLiquidity, , , , ) = nfpm.positions(pos.tokenId);
        require(token0Onchain == pos.token0 && token1Onchain == pos.token1 && feeOnchain == pos.feeTier, "onchain mismatch");

        uint256 bal0Before = IERC20(pos.token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(pos.token1).balanceOf(address(this));

        uint128 toDrain = reportedLiquidity > 0 ? reportedLiquidity : pos.liquidity;
        if (toDrain > 0) {
            try nfpm.decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: pos.tokenId,
                liquidity: toDrain,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + 300
            })) returns (uint256, uint256) {
                pos.liquidity = pos.liquidity > toDrain ? pos.liquidity - toDrain : 0;
            } catch {
                _refundDelta(pos, bal0Before, bal1Before);
                emit SyncFailedDecrease(posId, "decreaseLiquidity_failed");
                return;
            }
        }

        try nfpm.collect(INonfungiblePositionManager.CollectParams({
            tokenId: pos.tokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        })) returns (uint256, uint256) {
            // collected
        } catch {
            _refundDelta(pos, bal0Before, bal1Before);
            emit SyncFailedCollect(posId, "collect_failed");
            return;
        }

        uint256 bal0Mid = IERC20(pos.token0).balanceOf(address(this));
        uint256 bal1Mid = IERC20(pos.token1).balanceOf(address(this));

        if (bal0Mid == bal0Before && bal1Mid == bal1Before) {
            pos.tickLower = newLower;
            pos.tickUpper = newUpper;
            _cleanupNFT(oldTokenId, pos.owner, posId);
            emit SyncPositionCommitted(posId, oldLower, oldUpper, newLower, newUpper);
            return;
        }

        int24 spacing = _tickSpacing(pos.feeTier);
        if (int256(newUpper) - int256(newLower) < int256(spacing)) {
            if (bal0Mid > 0) _queueRefund(pos.owner, pos.token0, bal0Mid);
            if (bal1Mid > 0) _queueRefund(pos.owner, pos.token1, bal1Mid);
            pos.tickLower = newLower;
            pos.tickUpper = newUpper;
            _cleanupNFT(oldTokenId, pos.owner, posId);
            emit SyncPositionCommitted(posId, oldLower, oldUpper, newLower, newUpper);
            return;
        }

        if (bal0Mid > 0) {
            IERC20(pos.token0).safeApprove(address(nfpm), 0);
            IERC20(pos.token0).safeApprove(address(nfpm), bal0Mid);
        }
        if (bal1Mid > 0) {
            IERC20(pos.token1).safeApprove(address(nfpm), 0);
            IERC20(pos.token1).safeApprove(address(nfpm), bal1Mid);
        }

        uint256 newTokenId = 0;
        uint128 newLiq = 0;

        try nfpm.mint(INonfungiblePositionManager.MintParams({
            token0: pos.token0,
            token1: pos.token1,
            fee: pos.feeTier,
            tickLower: newLower,
            tickUpper: newUpper,
            amount0Desired: bal0Mid,
            amount1Desired: bal1Mid,
            amount0Min: 0,
            amount1Min: 0,
            recipient: address(this),
            deadline: block.timestamp + 300
        })) returns (uint256 tokenId_, uint128 liquidity_, uint256, uint256) {
            newTokenId = tokenId_;
            newLiq = liquidity_;

            if (bal0Mid > 0) IERC20(pos.token0).safeApprove(address(nfpm), 0);
            if (bal1Mid > 0) IERC20(pos.token1).safeApprove(address(nfpm), 0);

            require(newLiq > 0, "mint zero liq");

        } catch {
            if (bal0Mid > 0) IERC20(pos.token0).safeApprove(address(nfpm), 0);
            if (bal1Mid > 0) IERC20(pos.token1).safeApprove(address(nfpm), 0);

            _refundDelta(pos, bal0Before, bal1Before);
            emit SyncFailedMint(posId, "mint_failed");
            return;
        }

        try index.confirmReposition(pos.poolId, pos.level, currentNonce) {
            // Reposition confirmed
        } catch {
            // Non-critical
        }

        _cleanupNFT(oldTokenId, pos.owner, posId);
        
        pos.tokenId = newTokenId;
        pos.tickLower = newLower;
        pos.tickUpper = newUpper;
        pos.liquidity = newLiq;

        emit RepositionPerformed(posId, oldTokenId, newTokenId, oldLiq, newLiq, currentNonce);
        emit SyncPositionCommitted(posId, oldLower, oldUpper, newLower, newUpper);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // CLOSE POSITION
    // ═══════════════════════════════════════════════════════════════════════════════

    function closePosition(uint256 posId) external nonReentrant whenNotPaused onlyOwnerOf(posId) {
        Position storage pos = positions[posId];
        if (!pos.active) revert Inactive();
        require(pos.tokenId != 0, "no token");

        uint256 bal0Before = IERC20(pos.token0).balanceOf(address(this));
        uint256 bal1Before = IERC20(pos.token1).balanceOf(address(this));

        uint128 liq = pos.liquidity;
        if (liq > 0) {
            nfpm.decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: pos.tokenId,
                liquidity: liq,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp + 300
            }));
            pos.liquidity = 0;
        }
        
        nfpm.collect(INonfungiblePositionManager.CollectParams({
            tokenId: pos.tokenId,
            recipient: address(this),
            amount0Max: type(uint128).max,
            amount1Max: type(uint128).max
        }));

        uint256 bal0After = IERC20(pos.token0).balanceOf(address(this));
        uint256 bal1After = IERC20(pos.token1).balanceOf(address(this));
        uint256 left0 = bal0After > bal0Before ? bal0After - bal0Before : 0;
        uint256 left1 = bal1After > bal1Before ? bal1After - bal1Before : 0;
        if (left0 > 0) _queueRefund(pos.owner, pos.token0, left0);
        if (left1 > 0) _queueRefund(pos.owner, pos.token1, left1);

        uint256 tokenIdToClean = pos.tokenId;
        _cleanupNFT(tokenIdToClean, pos.owner, posId);
        
        pos.active = false;
        
        emit ClosePosition(posId);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // NFT RECOVERY FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    function recoverStuckNFT(uint256 posId) external nonReentrant {
        uint256 tokenId = stuckNFTs[posId];
        
        if (tokenId == 0) revert NoStuckNFT();
        
        address nftOwner = stuckNFTOwners[tokenId];
        require(
            msg.sender == nftOwner || hasRole(RESCUE_ROLE, msg.sender),
            "Not authorized"
        );

        try nfpm.burn(tokenId) {
            delete stuckNFTs[posId];
            delete stuckNFTOwners[tokenId];
            emit NFTRecovered(posId, tokenId, nftOwner);
            return;
        } catch {
            try IERC721(address(nfpm)).safeTransferFrom(address(this), nftOwner, tokenId) {
                delete stuckNFTs[posId];
                delete stuckNFTOwners[tokenId];
                emit NFTRecovered(posId, tokenId, nftOwner);
                return;
            } catch {
                revert("Recovery failed");
            }
        }
    }

    function batchRecoverStuckNFTs(uint256[] calldata posIds) external nonReentrant onlyRole(RESCUE_ROLE) {
        for (uint256 i = 0; i < posIds.length; i++) {
            uint256 posId = posIds[i];
            uint256 tokenId = stuckNFTs[posId];
            
            if (tokenId == 0) continue;
            
            address nftOwner = stuckNFTOwners[tokenId];
            
            try nfpm.burn(tokenId) {
                delete stuckNFTs[posId];
                delete stuckNFTOwners[tokenId];
                emit NFTRecovered(posId, tokenId, nftOwner);
            } catch {
                try IERC721(address(nfpm)).safeTransferFrom(address(this), nftOwner, tokenId) {
                    delete stuckNFTs[posId];
                    delete stuckNFTOwners[tokenId];
                    emit NFTRecovered(posId, tokenId, nftOwner);
                } catch {
                    // Continue to next
                }
            }
        }
    }

    function getStuckNFTInfo(uint256 posId) external view returns (
        bool hasStuckNFT,
        uint256 tokenId,
        address owner
    ) {
        tokenId = stuckNFTs[posId];
        hasStuckNFT = tokenId != 0;
        owner = stuckNFTOwners[tokenId];
    }

    function emergencyRescueERC721(
        address token,
        uint256 tokenId,
        address to
    ) external nonReentrant onlyRole(RESCUE_ROLE) {
        require(to != address(0), "zero address");
        IERC721(token).safeTransferFrom(address(this), to, tokenId);
    }

    function emergencyRescueERC20(
        address token,
        address to,
        uint256 amount
    ) external nonReentrant onlyRole(RESCUE_ROLE) {
        require(to != address(0), "zero address");
        IERC20(token).safeTransfer(to, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { 
        _pause(); 
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { 
        _unpause(); 
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    
    function mint(MintParams calldata params) 
        external 
        payable 
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
        
    function increaseLiquidity(IncreaseLiquidityParams calldata params) 
        external 
        payable 
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
        
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) 
        external 
        returns (uint256 amount0, uint256 amount1);
        
    function collect(CollectParams calldata params) 
        external 
        returns (uint256 amount0, uint256 amount1);
        
    function burn(uint256 tokenId) external;
    
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

interface IIndex {
    enum Level { L1, L5, L10, L20 }
    
    function getAllLevels(bytes32 poolId)
        external
        view
        returns (
            uint256[] memory p_ref_wads,
            uint256[] memory p_now_wads,
            uint256[] memory deviationsBps,
            uint32[] memory lastRepositionTss,
            uint256[] memory thresholdsBps
        );
        
    function computePriceBounds(uint256 P_ref_wad, uint256 pctInt)
        external
        pure
        returns (uint256 Pmin, uint256 Pmax);
    
    function pools(bytes32 poolId) external view returns (
        bool exists,
        address poolAddress,
        uint8 decimals0,
        uint8 decimals1,
        bool useUniswapTwap,
        uint32 twapWindowSeconds,
        uint16 buffer_max_samples,
        uint16 buffer_count,
        uint16 buffer_next
    );
    
    function confirmReposition(bytes32 poolId, Level lvl, uint256 nonce) external;
    
    function getRepositionNonce(bytes32 poolId, Level lvl) external view returns (uint256);
    
    function getPctLevels() external view returns (uint8[] memory);
}