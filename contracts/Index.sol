// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./libs/TickMath.sol";
import "./libs/FullMath.sol";

/**
 * @title Index Contract
 * @notice Manages dynamic liquidity rebalancing using percentage-based thresholds
 */
contract Index is AccessControl, Pausable, ReentrancyGuard {
    using FullMath for uint256;

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════════

    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");
    bytes32 public constant POSITION_MANAGER_ROLE = keccak256("POSITION_MANAGER_ROLE");
    
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS_BASE = 10000; // 10000 basis points = 100%
    uint256 public constant MAX_TWAP_WINDOW = 7 days;
    uint256 public constant MIN_TWAP_WINDOW = 1 minutes;
    uint32 public constant REPOSITION_TIMEOUT = 6 hours;

    // ═══════════════════════════════════════════════════════════════════════════════
    // ENUMS & STRUCTS
    // ═══════════════════════════════════════════════════════════════════════════════

    enum Level { L1, L5, L10, L20 }

    struct PoolConfig {
        bool   exists;
        address poolAddress;
        uint8  decimals0;
        uint8  decimals1;
        bool   useUniswapTwap;
        uint32 twapWindowSeconds;
        uint16 buffer_max_samples;
        uint16 buffer_count;
        uint16 buffer_next;
    }

    struct Sample {
        uint32  ts;
        uint256 priceWad;
    }

    struct LevelState {
        uint256 p_ref_wad;              // Reference price in WAD
        uint32  lastRepositionTs;       // Last reposition timestamp
        uint256 p_now_wad;              // Current price in WAD
        uint256 pending_p_ref_wad;      // Pending new reference price
        bool hasPendingReposition;      // Reposition in progress flag
        uint256 repositionNonce;        // Nonce for two-phase commit
        uint32 repositionRequestTime;   // When reposition was requested
        uint256 lastDeviationBps;       // Last computed deviation (for analytics)
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // STATE VARIABLES
    // ═══════════════════════════════════════════════════════════════════════════════

    mapping(bytes32 => PoolConfig) public pools;
    mapping(bytes32 => mapping(uint16 => Sample)) public samples;
    mapping(bytes32 => mapping(Level => LevelState)) public levelStates;

    uint8[] public pctLevels;
    bytes32[] public poolIds;

    // ═══════════════════════════════════════════════════════════════════════════════
    // EVENTS
    // ═══════════════════════════════════════════════════════════════════════════════

    event PoolRegistered(bytes32 indexed poolId, address poolAddr);
    event SamplePushed(bytes32 indexed poolId, uint256 priceWad, uint32 ts);
    event PriceObserved(
        bytes32 indexed poolId, 
        Level level, 
        uint256 p_now_wad, 
        uint256 deviationBps
    );
    event DeviationThresholdExceeded(
        bytes32 indexed poolId, 
        Level level, 
        uint256 deviationBps, 
        uint256 thresholdBps
    );
    event RepositionRequested(
        bytes32 indexed poolId, 
        Level level, 
        uint256 oldPRef, 
        uint256 pendingPRef, 
        uint256 nonce, 
        uint32 timestamp
    );
    event RepositionConfirmed(
        bytes32 indexed poolId, 
        Level level, 
        uint256 oldPRef, 
        uint256 newPRef, 
        uint256 nonce
    );
    event RepositionTimedOut(bytes32 indexed poolId, Level level, uint256 nonce);
    event RepositionCancelled(
        bytes32 indexed poolId, 
        Level level, 
        uint256 nonce, 
        address cancelledBy
    );

    // ═══════════════════════════════════════════════════════════════════════════════
    // ERRORS
    // ═══════════════════════════════════════════════════════════════════════════════

    error StaleNonce();
    error NoPendingReposition();
    error InvalidTwapWindow();
    error InvalidPctLevel();
    error PoolAlreadyExists();
    error PoolNotFound();
    error TwapFailed();

    // ═══════════════════════════════════════════════════════════════════════════════
    // CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════════

    constructor(address admin) {
        require(admin != address(0), "admin=0");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPDATER_ROLE, admin);
        
        // Initialize default percentage levels: 1%, 5%, 10%, 20%
        pctLevels.push(1);
        pctLevels.push(5);
        pctLevels.push(10);
        pctLevels.push(20);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // MATHEMATICAL FUNCTIONS - PERCENTAGE BASED
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Calculate percentage deviation between prices
     * @dev Returns deviation in basis points (10000 = 100%)
     * @param P_now_wad Current price in WAD
     * @param P_ref_wad Reference price in WAD
     * @return deviationBps Deviation in basis points
     */
    function computeDeviationBps(uint256 P_now_wad, uint256 P_ref_wad) 
        public 
        pure 
        returns (uint256 deviationBps) 
    {
        require(P_ref_wad > 0, "P_ref>0");
        if (P_now_wad == 0) return 0;
        
        uint256 diff = P_now_wad > P_ref_wad 
            ? P_now_wad - P_ref_wad 
            : P_ref_wad - P_now_wad;
        
        // Return in basis points: 10000 = 100%
        deviationBps = FullMath.mulDiv(diff, BPS_BASE, P_ref_wad);
    }

    /**
     * @notice Get threshold in basis points from percentage integer
     * @param pctInt Percentage as integer (1 = 1%, 5 = 5%)
     * @return thresholdBps Threshold in basis points
     */
    function thresholdFromPctInt(uint256 pctInt) 
        public 
        pure 
        returns (uint256 thresholdBps) 
    {
        if (pctInt > 100) revert InvalidPctLevel();
        return pctInt * 100; // Convert to basis points (1% = 100 bps)
    }

    /**
     * @notice Compute price bounds from percentage
     * @dev Calculates Pmin and Pmax based on percentage deviation
     * @param P_ref_wad Reference price in WAD
     * @param pctInt Percentage as integer (1 = 1%, 5 = 5%, etc.)
     * @return Pmin Minimum price bound
     * @return Pmax Maximum price bound
     */
    function computePriceBounds(uint256 P_ref_wad, uint256 pctInt)
        public
        pure
        returns (uint256 Pmin, uint256 Pmax)
    {
        require(P_ref_wad > 0, "P_ref>0");
        if (pctInt > 100) revert InvalidPctLevel();
        
        uint256 pctWad = pctInt * 1e16; // Convert to WAD (1% = 0.01e18)
        
        // Pmax = P_ref * (1 + pct)
        Pmax = FullMath.mulDiv(P_ref_wad, WAD + pctWad, WAD);
        
        // Pmin = P_ref / (1 + pct)
        Pmin = FullMath.mulDiv(P_ref_wad, WAD, WAD + pctWad);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // POOL MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Register a new pool for liquidity management
     * @param poolId Unique pool identifier
     * @param poolAddr Pool contract address
     * @param decimals0 Decimals of token0
     * @param decimals1 Decimals of token1
     * @param useUniswapTwap Whether to use Uniswap's built-in TWAP
     * @param initialPRefWad Initial reference price in WAD
     * @param twapWindowSeconds TWAP window in seconds
     * @param bufferMax Maximum buffer size for custom TWAP
     */
    function registerPool(
        bytes32 poolId,
        address poolAddr,
        uint8   decimals0,
        uint8   decimals1,
        bool    useUniswapTwap,
        uint256 initialPRefWad,
        uint32  twapWindowSeconds,
        uint16  bufferMax
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pools[poolId].exists) revert PoolAlreadyExists();
        require(poolAddr != address(0), "pool=0");
        if (twapWindowSeconds < MIN_TWAP_WINDOW || twapWindowSeconds > MAX_TWAP_WINDOW) {
            revert InvalidTwapWindow();
        }
        require(initialPRefWad > 0, "initialPRef>0");
        if (!useUniswapTwap) require(bufferMax > 0, "bufferMax=0");

        pools[poolId] = PoolConfig({
            exists: true,
            poolAddress: poolAddr,
            decimals0: decimals0,
            decimals1: decimals1,
            useUniswapTwap: useUniswapTwap,
            twapWindowSeconds: twapWindowSeconds,
            buffer_max_samples: bufferMax,
            buffer_count: 0,
            buffer_next: 0
        });

        poolIds.push(poolId);

        // Initialize all levels with the same reference price
        uint8 L = uint8(Level.L20) + 1;
        for (uint8 i; i < L;) {
            levelStates[poolId][Level(i)] = LevelState({
                p_ref_wad: initialPRefWad,
                lastRepositionTs: uint32(block.timestamp),
                p_now_wad: initialPRefWad,
                pending_p_ref_wad: 0,
                hasPendingReposition: false,
                repositionNonce: 0,
                repositionRequestTime: 0,
                lastDeviationBps: 0
            });
            unchecked { ++i; }
        }

        emit PoolRegistered(poolId, poolAddr);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // PRICE ORACLE (TWAP)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Push a new price sample (for custom TWAP)
     * @param poolId Pool identifier
     * @param priceWad Price in WAD format
     */
    function pushSample(bytes32 poolId, uint256 priceWad) 
        external 
        whenNotPaused 
        onlyRole(UPDATER_ROLE)
    {
        PoolConfig storage p = pools[poolId];
        if (!p.exists) revert PoolNotFound();
        require(!p.useUniswapTwap, "use uniswap twap");
        require(p.buffer_max_samples > 0, "buffer disabled");

        uint16 idx = p.buffer_next;
        samples[poolId][idx] = Sample({ 
            ts: uint32(block.timestamp), 
            priceWad: priceWad 
        });
        emit SamplePushed(poolId, priceWad, uint32(block.timestamp));

        unchecked {
            p.buffer_next = uint16((uint256(idx) + 1) % uint256(p.buffer_max_samples));
            if (p.buffer_count < p.buffer_max_samples) {
                ++p.buffer_count;
            }
        }
    }

    /**
     * @notice Get Time-Weighted Average Price (TWAP)
     * @param poolId Pool identifier
     * @return ok Whether TWAP calculation succeeded
     * @return priceWad TWAP price in WAD
     */
    function getTwap(bytes32 poolId) 
        public 
        view 
        returns (bool ok, uint256 priceWad) 
    {
        PoolConfig storage p = pools[poolId];
        if (!p.exists) return (false, 0);

        if (p.useUniswapTwap) {
            return _getUniswapTwap(p);
        } else {
            return _getCustomTwap(poolId, p);
        }
    }

    /**
     * @notice Get TWAP from Uniswap V3 pool
     * @param p Pool configuration
     * @return ok Whether TWAP calculation succeeded
     * @return priceWad TWAP price in WAD
     */
    function _getUniswapTwap(PoolConfig storage p) 
        internal 
        view 
        returns (bool ok, uint256 priceWad) 
    {
        if (p.twapWindowSeconds == 0) return (false, 0);
        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(p.poolAddress);
        uint32 window = p.twapWindowSeconds;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;

        try pool.observe(secondsAgos) returns (
            int56[] memory tickCumulatives, 
            uint160[] memory
        ) {
            if (tickCumulatives.length < 2) return (false, 0);

            int256 delta = int256(tickCumulatives[1]) - int256(tickCumulatives[0]);
            int256 avgTick = delta / int256(uint256(window));

            int24 avgTick24;
            if (avgTick > int256(type(int24).max)) {
                avgTick24 = type(int24).max;
            } else if (avgTick < int256(type(int24).min)) {
                avgTick24 = type(int24).min;
            } else {
                avgTick24 = int24(avgTick);
            }

            uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(avgTick24);
            priceWad = sqrtPriceX96ToPriceWad(sqrtPriceX96, p.decimals0, p.decimals1);

            if (priceWad == 0) return (false, 0);
            return (true, priceWad);
        } catch {
            return (false, 0);
        }
    }

    /**
     * @notice Get TWAP from custom price samples
     * @param poolId Pool identifier
     * @param p Pool configuration
     * @return ok Whether TWAP calculation succeeded
     * @return priceWad TWAP price in WAD
     */
    function _getCustomTwap(bytes32 poolId, PoolConfig storage p) 
        internal 
        view 
        returns (bool ok, uint256 priceWad) 
    {
        if (p.buffer_count == 0) return (false, 0);

        uint16 count = p.buffer_count;
        uint16 maxSamples = p.buffer_max_samples;
        uint16 next = p.buffer_next;
        uint16 start = next >= count 
            ? next - count 
            : uint16(uint256(maxSamples) + uint256(next) - uint256(count));

        uint32 nowTs = uint32(block.timestamp);
        uint32 startTime = nowTs > p.twapWindowSeconds 
            ? nowTs - p.twapWindowSeconds 
            : 0;

        uint32 prevTs = 0;
        uint256 prevPrice = 0;
        uint256 totalW = 0;
        uint256 totalT = 0;

        for (uint16 i; i < count;) {
            uint16 idx = uint16((uint256(start) + uint256(i)) % uint256(maxSamples));
            Sample memory s = samples[poolId][idx];
            if (s.ts == 0) {
                unchecked { ++i; }
                continue;
            }

            if (prevTs == 0) {
                prevTs = s.ts < startTime ? startTime : s.ts;
                prevPrice = s.priceWad;
                unchecked { ++i; }
                continue;
            }

            if (s.ts > prevTs) {
                unchecked {
                    uint256 d = uint256(s.ts - prevTs);
                    totalW += FullMath.mulDiv(d, prevPrice, 1);
                    totalT += d;
                }
            }

            prevTs = s.ts;
            prevPrice = s.priceWad;
            unchecked { ++i; }
        }

        if (prevTs > 0 && nowTs > prevTs) {
            unchecked {
                uint256 d = uint256(nowTs - prevTs);
                totalW += FullMath.mulDiv(d, prevPrice, 1);
                totalT += d;
            }
        }

        if (totalT == 0) return (false, 0);

        priceWad = totalW / totalT;
        return (true, priceWad);
    }

    /**
     * @notice Convert Uniswap sqrtPriceX96 to human-readable price in WAD
     * @param sqrtPriceX96 Square root price in Q96 format
     * @param decimals0 Token0 decimals
     * @param decimals1 Token1 decimals
     * @return priceWad Price in WAD format
     */
    function sqrtPriceX96ToPriceWad(
        uint160 sqrtPriceX96, 
        uint8 decimals0, 
        uint8 decimals1
    ) 
        internal 
        pure 
        returns (uint256 priceWad) 
    {
        if (sqrtPriceX96 == 0) return 0;
        uint256 Q96 = 2**96;
        uint256 s = uint256(sqrtPriceX96);
        uint256 sqrtP_wad = FullMath.mulDiv(s, WAD, Q96);
        if (sqrtP_wad == 0) return 0;
        uint256 priceWadRaw = FullMath.mulDiv(sqrtP_wad, sqrtP_wad, WAD);

        uint256 diff;
        bool invert;
        if (decimals0 >= decimals1) {
            diff = uint256(decimals0 - decimals1);
            invert = false;
        } else {
            diff = uint256(decimals1 - decimals0);
            invert = true;
        }
        require(diff <= 36, "decimals diff too large");
        uint256 factor = 10 ** diff;

        priceWad = invert 
            ? FullMath.mulDiv(priceWadRaw, 1, factor) 
            : FullMath.mulDiv(priceWadRaw, factor, 1);
        return priceWad;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // REBALANCING LOGIC - PERCENTAGE BASED
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Process a pool and check if rebalancing is needed
     * @param poolId Pool identifier
     * @return repositionRequested Array indicating which levels need rebalancing
     */
    function processPool(bytes32 poolId) 
        public 
        whenNotPaused 
        onlyRole(UPDATER_ROLE)
        returns (bool[4] memory repositionRequested)
    {
        PoolConfig storage p = pools[poolId];
        if (!p.exists) revert PoolNotFound();
        uint8 L = uint8(Level.L20) + 1;
        require(pctLevels.length >= L, "pctLevels bad length");

        (bool ok, uint256 P_now_wad) = getTwap(poolId);
        if (!ok || P_now_wad == 0) revert TwapFailed();

        for (uint8 i; i < L;) {
            Level lvl = Level(i);
            LevelState storage ls = levelStates[poolId][lvl];

            // Check for timed out repositions
            if (ls.hasPendingReposition && 
                block.timestamp > ls.repositionRequestTime + REPOSITION_TIMEOUT) {
                ls.hasPendingReposition = false;
                ls.pending_p_ref_wad = 0;
                emit RepositionTimedOut(poolId, lvl, ls.repositionNonce);
            }

            // Compute deviation in basis points
            uint256 deviationBps = computeDeviationBps(P_now_wad, ls.p_ref_wad);
            
            // Update current state
            ls.p_now_wad = P_now_wad;
            ls.lastDeviationBps = deviationBps;
            
            emit PriceObserved(poolId, lvl, P_now_wad, deviationBps);

            // Check bounds using percentage threshold
            uint256 thresholdBps = thresholdFromPctInt(pctLevels[i]);
            bool outOfBounds = deviationBps > thresholdBps;

            if (outOfBounds) {
                emit DeviationThresholdExceeded(poolId, lvl, deviationBps, thresholdBps);
                
                if (!ls.hasPendingReposition) {
                    bool success = _requestReposition(poolId, lvl, P_now_wad);
                    repositionRequested[i] = success;
                }
            }
            
            unchecked { ++i; }
        }

        return repositionRequested;
    }

    /**
     * @notice Request a reposition for a specific level
     * @param poolId Pool identifier
     * @param lvl Level to reposition
     * @param newPRef New reference price
     * @return success Whether request succeeded
     */
    function _requestReposition(
        bytes32 poolId, 
        Level lvl, 
        uint256 newPRef
    ) 
        internal 
        returns (bool success) 
    {
        LevelState storage ls = levelStates[poolId][lvl];
        uint256 oldPRef = ls.p_ref_wad;

        unchecked {
            ++ls.repositionNonce;
        }
        
        ls.pending_p_ref_wad = newPRef;
        ls.hasPendingReposition = true;
        ls.repositionRequestTime = uint32(block.timestamp);

        emit RepositionRequested(
            poolId, 
            lvl, 
            oldPRef, 
            newPRef, 
            ls.repositionNonce, 
            uint32(block.timestamp)
        );
        return true;
    }

    /**
     * @notice Confirm a reposition (called by Position Manager)
     * @param poolId Pool identifier
     * @param lvl Level being repositioned
     * @param nonce Reposition nonce for verification
     */
    function confirmReposition(bytes32 poolId, Level lvl, uint256 nonce) 
        external 
        whenNotPaused 
        onlyRole(POSITION_MANAGER_ROLE) 
    {
        LevelState storage ls = levelStates[poolId][lvl];
        if (!ls.hasPendingReposition) revert NoPendingReposition();
        if (ls.repositionNonce != nonce) revert StaleNonce();
        
        // Check timeout
        if (block.timestamp > ls.repositionRequestTime + REPOSITION_TIMEOUT) {
            ls.hasPendingReposition = false;
            ls.pending_p_ref_wad = 0;
            emit RepositionTimedOut(poolId, lvl, nonce);
            revert("Reposition timed out");
        }
        
        uint256 oldPRef = ls.p_ref_wad;
        uint256 newPRef = ls.pending_p_ref_wad;

        ls.p_ref_wad = newPRef;
        ls.lastRepositionTs = uint32(block.timestamp);
        ls.p_now_wad = newPRef;
        
        ls.pending_p_ref_wad = 0;
        ls.hasPendingReposition = false;
        ls.repositionRequestTime = 0;
        ls.lastDeviationBps = 0; // Reset after reposition

        emit RepositionConfirmed(poolId, lvl, oldPRef, newPRef, nonce);
    }

    /**
     * @notice Cancel a pending reposition (admin only)
     * @param poolId Pool identifier
     * @param lvl Level to cancel
     */
    function cancelReposition(bytes32 poolId, Level lvl) 
        external 
        whenNotPaused 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        LevelState storage ls = levelStates[poolId][lvl];
        if (!ls.hasPendingReposition) revert NoPendingReposition();
        
        uint256 nonce = ls.repositionNonce;
        ls.hasPendingReposition = false;
        ls.pending_p_ref_wad = 0;
        ls.repositionRequestTime = 0;
        
        emit RepositionCancelled(poolId, lvl, nonce, msg.sender);
    }

    /**
     * @notice Process multiple pools in one transaction
     * @param poolIds_ Array of pool identifiers
     */
    function processPools(bytes32[] calldata poolIds_) 
        external 
        whenNotPaused 
        onlyRole(UPDATER_ROLE) 
    {
        uint256 length = poolIds_.length;
        for (uint256 i; i < length;) {
            processPool(poolIds_[i]);
            unchecked { ++i; }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Get all level states for a pool
     * @param poolId Pool identifier
     * @return p_ref_wads Reference prices for all levels
     * @return p_now_wads Current prices for all levels
     * @return deviationsBps Deviations in basis points
     * @return lastRepositionTss Last reposition timestamps
     * @return thresholdsBps Thresholds in basis points
     */
    function getAllLevels(bytes32 poolId)
        external
        view
        returns (
            uint256[] memory p_ref_wads,
            uint256[] memory p_now_wads,
            uint256[] memory deviationsBps,
            uint32[] memory lastRepositionTss,
            uint256[] memory thresholdsBps
        )
    {
        if (!pools[poolId].exists) revert PoolNotFound();
        uint8 L = uint8(Level.L20) + 1;
        require(pctLevels.length >= L, "pctLevels bad length");

        p_ref_wads = new uint256[](L);
        p_now_wads = new uint256[](L);
        deviationsBps = new uint256[](L);
        lastRepositionTss = new uint32[](L);
        thresholdsBps = new uint256[](L);

        for (uint8 i; i < L;) {
            Level lvl = Level(i);
            LevelState storage ls = levelStates[poolId][lvl];
            
            p_ref_wads[i] = ls.hasPendingReposition ? ls.pending_p_ref_wad : ls.p_ref_wad;
            p_now_wads[i] = ls.p_now_wad;
            deviationsBps[i] = ls.lastDeviationBps;
            lastRepositionTss[i] = ls.lastRepositionTs;
            thresholdsBps[i] = thresholdFromPctInt(pctLevels[i]);
            
            unchecked { ++i; }
        }
    }

    /**
     * @notice Get reposition nonce for a level
     * @param poolId Pool identifier
     * @param lvl Level
     * @return Reposition nonce
     */
    function getRepositionNonce(bytes32 poolId, Level lvl) 
        external 
        view 
        returns (uint256) 
    {
        return levelStates[poolId][lvl].repositionNonce;
    }

    /**
     * @notice Get all registered pool IDs
     * @return Array of pool IDs
     */
    function getPoolIds() external view returns (bytes32[] memory) {
        return poolIds;
    }

    /**
     * @notice Get percentage levels configuration
     * @return Array of percentage levels
     */
    function getPctLevels() external view returns (uint8[] memory) {
        return pctLevels;
    }

    /**
     * @notice Check if reposition is pending for a level
     * @param poolId Pool identifier
     * @param lvl Level
     * @return Whether reposition is pending
     */
    function isRepositionPending(bytes32 poolId, Level lvl) 
        external 
        view 
        returns (bool) 
    {
        return levelStates[poolId][lvl].hasPendingReposition;
    }

    /**
     * @notice Get detailed reposition status
     * @param poolId Pool identifier
     * @param lvl Level
     * @return isPending Whether reposition is pending
     * @return nonce Current reposition nonce
     * @return pendingPRef Pending reference price
     * @return requestTime When reposition was requested
     * @return timeoutAt When reposition will timeout
     */
    function getRepositionStatus(bytes32 poolId, Level lvl) 
        external 
        view 
        returns (
            bool isPending,
            uint256 nonce,
            uint256 pendingPRef,
            uint32 requestTime,
            uint32 timeoutAt
        ) 
    {
        LevelState storage ls = levelStates[poolId][lvl];
        isPending = ls.hasPendingReposition;
        nonce = ls.repositionNonce;
        pendingPRef = ls.pending_p_ref_wad;
        requestTime = ls.repositionRequestTime;
        timeoutAt = ls.repositionRequestTime + REPOSITION_TIMEOUT;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * @notice Set new percentage levels
     * @dev Must provide exactly 4 levels (L1, L5, L10, L20)
     * @param newPcts Array of percentage values
     */
    function setPctLevels(uint8[] calldata newPcts) 
        external 
        nonReentrant 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {
        uint8 L = uint8(Level.L20) + 1;
        require(newPcts.length == L, "length mismatch");
        delete pctLevels;
        for (uint256 i; i < newPcts.length;) {
            if (newPcts[i] > 100) revert InvalidPctLevel();
            pctLevels.push(newPcts[i]);
            unchecked { ++i; }
        }
    }

    /**
     * @notice Pause contract operations
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { 
        _pause(); 
    }

    /**
     * @notice Unpause contract operations
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { 
        _unpause(); 
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @title IUniswapV3PoolMinimal
 * @notice Minimal interface for Uniswap V3 pool
 */
interface IUniswapV3PoolMinimal {
    function observe(uint32[] calldata secondsAgos) 
        external 
        view 
        returns (int56[] memory, uint160[] memory);
}