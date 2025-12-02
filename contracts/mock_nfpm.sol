// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockNonfungiblePositionManager
 * @notice Mock NFPM for testing liquidity positions
 */
contract MockNonfungiblePositionManager is ERC721 {
    uint256 public nextTokenId = 1;
    
    struct Position {
        uint96 nonce;
        address operator;
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
    }
    
    mapping(uint256 => Position) public positions;
    
    // Simulate accumulated fees
    mapping(uint256 => uint256) public accumulatedFees0;
    mapping(uint256 => uint256) public accumulatedFees1;
    
    constructor() ERC721("Mock Uniswap V3 Positions NFT", "UNI-V3-POS") {}
    
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
    
    function mint(MintParams calldata params)
        external
        payable
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        )
    {
        require(block.timestamp <= params.deadline, "expired");
        require(params.amount0Desired >= params.amount0Min, "amount0Min");
        require(params.amount1Desired >= params.amount1Min, "amount1Min");
        
        tokenId = nextTokenId++;
        
        // Transfer tokens from sender
        if (params.amount0Desired > 0) {
            IERC20(params.token0).transferFrom(msg.sender, address(this), params.amount0Desired);
        }
        if (params.amount1Desired > 0) {
            IERC20(params.token1).transferFrom(msg.sender, address(this), params.amount1Desired);
        }
        
        // Simplified liquidity calculation
        liquidity = uint128((params.amount0Desired + params.amount1Desired) / 2);
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        
        // Store position
        positions[tokenId] = Position({
            nonce: 0,
            operator: address(0),
            token0: params.token0,
            token1: params.token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            liquidity: liquidity,
            feeGrowthInside0LastX128: 0,
            feeGrowthInside1LastX128: 0,
            tokensOwed0: 0,
            tokensOwed1: 0
        });
        
        // Mint NFT
        _mint(params.recipient, tokenId);
        
        return (tokenId, liquidity, amount0, amount1);
    }
    
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "expired");
        require(_ownerOf(params.tokenId) != address(0), "invalid token");
        
        Position storage position = positions[params.tokenId];
        
        // Transfer tokens
        if (params.amount0Desired > 0) {
            IERC20(position.token0).transferFrom(msg.sender, address(this), params.amount0Desired);
        }
        if (params.amount1Desired > 0) {
            IERC20(position.token1).transferFrom(msg.sender, address(this), params.amount1Desired);
        }
        
        liquidity = uint128((params.amount0Desired + params.amount1Desired) / 2);
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        
        position.liquidity += liquidity;
        
        return (liquidity, amount0, amount1);
    }
    
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        require(block.timestamp <= params.deadline, "expired");
        require(_ownerOf(params.tokenId) != address(0), "invalid token");
        
        Position storage position = positions[params.tokenId];
        require(position.liquidity >= params.liquidity, "insufficient liquidity");
        
        // Simplified amount calculation
        amount0 = uint256(params.liquidity) / 2;
        amount1 = uint256(params.liquidity) / 2;
        
        require(amount0 >= params.amount0Min, "amount0Min");
        require(amount1 >= params.amount1Min, "amount1Min");
        
        position.liquidity -= params.liquidity;
        position.tokensOwed0 += uint128(amount0);
        position.tokensOwed1 += uint128(amount1);
        
        return (amount0, amount1);
    }
    
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    
    function collect(CollectParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        require(_ownerOf(params.tokenId) != address(0), "invalid token");
        
        Position storage position = positions[params.tokenId];
        
        // Collect owed tokens
        amount0 = position.tokensOwed0 > params.amount0Max ? params.amount0Max : position.tokensOwed0;
        amount1 = position.tokensOwed1 > params.amount1Max ? params.amount1Max : position.tokensOwed1;
        
        // Add accumulated fees
        uint256 fees0 = accumulatedFees0[params.tokenId];
        uint256 fees1 = accumulatedFees1[params.tokenId];
        
        amount0 += fees0;
        amount1 += fees1;
        
        if (amount0 > 0) {
            position.tokensOwed0 = position.tokensOwed0 > uint128(amount0) 
                ? position.tokensOwed0 - uint128(amount0) 
                : 0;
            IERC20(position.token0).transfer(params.recipient, amount0);
            accumulatedFees0[params.tokenId] = 0;
        }
        
        if (amount1 > 0) {
            position.tokensOwed1 = position.tokensOwed1 > uint128(amount1) 
                ? position.tokensOwed1 - uint128(amount1) 
                : 0;
            IERC20(position.token1).transfer(params.recipient, amount1);
            accumulatedFees1[params.tokenId] = 0;
        }
        
        return (amount0, amount1);
    }
    
    function burn(uint256 tokenId) external {
        require(_ownerOf(tokenId) == msg.sender || getApproved(tokenId) == msg.sender, "not authorized");
        Position storage position = positions[tokenId];
        require(position.liquidity == 0, "not cleared");
        require(position.tokensOwed0 == 0 && position.tokensOwed1 == 0, "tokens owed");
        
        delete positions[tokenId];
        _burn(tokenId);
    }
    
    // Helper functions for testing
    
    function simulateFees(uint256 tokenId, uint256 fees0, uint256 fees1) external {
        accumulatedFees0[tokenId] += fees0;
        accumulatedFees1[tokenId] += fees1;
    }
    
    function setPosition(
        uint256 tokenId,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity
    ) external {
        Position storage position = positions[tokenId];
        position.tickLower = tickLower;
        position.tickUpper = tickUpper;
        position.liquidity = liquidity;
    }
}
