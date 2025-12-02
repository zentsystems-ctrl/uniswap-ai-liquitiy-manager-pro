require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const MAINNET_RPC = process.env.MAINNET_RPC || process.env.RPC || "";

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true
        }
      },
      {
        version: "0.7.6",
        settings: {
          optimizer: { enabled: true, runs: 200 }
        }
      }
    ],
    overrides: {
      "@uniswap/v3-core/contracts/libraries/FullMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/TickMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/BitMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/FixedPoint128.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/LiquidityMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/LowGasSafeMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/Position.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/SafeCast.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/SqrtPriceMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/SwapMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/Tick.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/TickBitmap.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/TransferHelper.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/UnsafeMath.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } },
      "@uniswap/v3-core/contracts/libraries/Oracle.sol": { version: "0.7.6", settings: { optimizer: { enabled: true, runs: 200 } } }
    }
  },

  networks: {
    hardhat: {
      forking: {
        url: MAINNET_RPC,
        blockNumber:
          process.env.FORK_BLOCK_NUMBER && Number(process.env.FORK_BLOCK_NUMBER) > 0
            ? Number(process.env.FORK_BLOCK_NUMBER)
            : undefined
      },
      chainId: 1,
      initialBaseFeePerGas: 0,
      gasPrice: "auto",
      gas: "auto"
    },

    localhost: {
      url: "http://127.0.0.1:8545",
      gasPrice: "auto",
      gas: "auto",
      timeout: 60000
    },

    sepolia: {
      url: process.env.SEPOLIA_RPC || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    },
    goerli: {
      url: process.env.GOERLI_RPC || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    }
  },

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || ""
  },

  // ✅ Optional: Increase test timeout for complex fork tests
  mocha: {
    timeout: 120000 // 2 minutes
  }
};