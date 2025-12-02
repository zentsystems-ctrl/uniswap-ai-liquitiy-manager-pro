// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockUniswapV3Pool
 * @notice Mock Uniswap V3 Pool for testing
 * @dev Simulates essential Uniswap V3 pool functionality
 */
contract MockUniswapV3Pool {
    address public token0;
    address public token1;
    uint24 public fee;
    uint128 public liquidity;
    
    // Current state
    uint160 public sqrtPriceX96;
    int24 public tick;
    
    // TWAP simulation
    mapping(uint256 => int56) public tickCumulatives;
    mapping(uint256 => uint32) public timestamps;
    uint256 public observationIndex;
    
    // Slot0 structure
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint16 observationIndex;
        uint16 observationCardinality;
        uint16 observationCardinalityNext;
        uint8 feeProtocol;
        bool unlocked;
    }
    
    constructor(
        address _token0,
        address _token1,
        uint24 _fee,
        uint160 _sqrtPriceX96,
        int24 _tick
    ) {
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        sqrtPriceX96 = _sqrtPriceX96;
        tick = _tick;
        liquidity = 1000000 * 1e18; // Default liquidity
        
        // Initialize first observation
        timestamps[0] = uint32(block.timestamp);
        tickCumulatives[0] = 0;
        observationIndex = 0;
    }
    
    /**
     * @notice Get slot0 data
     */
    function slot0() external view returns (
        uint160 _sqrtPriceX96,
        int24 _tick,
        uint16 _observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    ) {
        return (
            sqrtPriceX96,
            tick,
            uint16(observationIndex),
            100, // observationCardinality
            100, // observationCardinalityNext
            0,   // feeProtocol
            true // unlocked
        );
    }
    
    /**
     * @notice Observe function for TWAP
     */
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory _tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        _tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        
        uint32 currentTime = uint32(block.timestamp);
        
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            uint32 targetTime = currentTime - secondsAgos[i];
            
            // Simple linear interpolation for testing
            int56 tickCumulative = int56(int256(tick)) * int56(int256(uint256(targetTime)));
            _tickCumulatives[i] = tickCumulative;
            secondsPerLiquidityCumulativeX128s[i] = 0;
        }
        
        return (_tickCumulatives, secondsPerLiquidityCumulativeX128s);
    }
    
    /**
     * @notice Update pool state (for testing)
     */
    function setPrice(uint160 _sqrtPriceX96, int24 _tick) external {
        sqrtPriceX96 = _sqrtPriceX96;
        tick = _tick;
        
        // Update observation
        observationIndex++;
        timestamps[observationIndex] = uint32(block.timestamp);
        tickCumulatives[observationIndex] = tickCumulatives[observationIndex - 1] + 
            int56(int256(_tick)) * int56(int256(uint256(block.timestamp - timestamps[observationIndex - 1])));
    }
    
    /**
     * @notice Set liquidity (for testing)
     */
    function setLiquidity(uint128 _liquidity) external {
        liquidity = _liquidity;
    }
    
   /**
     * @notice Simulate price movement - FIXED TYPE ERROR
     */
    function simulatePriceChange(int24 tickChange) external {
        tick += tickChange;
        
        // FIX: Explicitly cast uint160 to uint256 before casting to int256 to resolve the TypeError.
        // We also explicitly cast tickChange to int256 for consistent arithmetic.
        int256 currentPriceInt = int256(uint256(sqrtPriceX96));
        int256 priceChangeDelta = int256(tickChange) * 1000; // Linear approximation
        
        // Note: The resulting value must be positive, as sqrtPriceX96 is uint160.
        // We cast back to uint256 then uint160.
        uint256 newSqrtPrice = uint256(currentPriceInt + priceChangeDelta);
        sqrtPriceX96 = uint160(newSqrtPrice);
        
        // Update observation
        observationIndex++;
        timestamps[observationIndex] = uint32(block.timestamp);
        tickCumulatives[observationIndex] = tickCumulatives[observationIndex - 1] + 
            int56(int256(tick)) * int56(int256(uint256(block.timestamp - timestamps[observationIndex - 1])));
    }
}
