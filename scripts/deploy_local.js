// scripts/deploy_local.js
// ✅ UPDATED FOR PERCENTAGE METHOD - No more TMath!
const hre = require("hardhat");
const { ethers, artifacts, network } = hre;

/**
 * Check whether an artifact exists for the given contract/library name.
 */
async function artifactExists(name) {
  try {
    await artifacts.readArtifact(name);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * returns true if the compiled artifact references a given library name
 */
async function needsLibrary(contractName, libName) {
  try {
    const libExists = await artifactExists(libName);
    if (!libExists) return false;

    const art = await artifacts.readArtifact(contractName);
    return art && art.linkReferences && JSON.stringify(art.linkReferences).includes(libName);
  } catch (e) {
    return false;
  }
}

/**
 * Deploy a library artifact if exists and return its address (or null)
 */
async function deployLibraryIfPresent(libName, deployer) {
  const exists = await artifactExists(libName);
  if (!exists) {
    console.log(`ℹ️  Library artifact "${libName}" not found – skipping deployment.`);
    return null;
  }
  console.log(`📦 Deploying library: ${libName} ...`);
  const LibFactory = await ethers.getContractFactory(libName);
  const lib = await LibFactory.connect(deployer).deploy();
  await lib.waitForDeployment();
  const libAddr = await lib.getAddress();
  console.log(`✅ ${libName} deployed at: ${libAddr}`);
  return libAddr;
}

async function main() {
  console.log("🚀 Deploying contracts to local Hardhat network...");
  console.log("📊 METHOD: Percentage-based (NO TMath)");
  console.log("🔗 Network:", network.name);

  if (network.name !== "hardhat" && network.name !== "localhost") {
    console.log(`⚠️  This script is intended for local deployment only. Current network: ${network.name}`);
    return;
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddress);

  console.log("👤 Deployer address:", deployerAddress);
  console.log("💰 Deployer balance:", ethers.formatEther(balance), "ETH");

  // ═══════════════════════════════════════════════════════════════════════════════
  // NFPM ADDRESS CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════════
  let nfpmAddress = process.env.NFPM_ADDRESS || null;
  const UNISWAP_V3_NFPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

  if (!nfpmAddress) {
    if (network.name === "hardhat" || network.name === "localhost") {
      console.log("ℹ️  No NFPM_ADDRESS provided – assuming Mainnet fork.");
      console.log("   Using Uniswap V3 NonfungiblePositionManager mainnet address.");
      nfpmAddress = UNISWAP_V3_NFPM;
    } else {
      console.error("❌ NFPM_ADDRESS is required for non-fork local deployment.");
      console.error("   Set NFPM_ADDRESS in your .env or deploy a mock NFPM.");
      process.exit(1);
    }
  }

  console.log("ℹ️  Using NFPM address:", nfpmAddress);

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOY MATH LIBRARIES (PERCENTAGE METHOD - NO TMath!)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n📚 Deploying Math Libraries (Percentage Method)...");
  console.log("   NOTE: TMath is NO LONGER NEEDED - using percentage calculations");
  
  let deployedLibs = {};

  // Only FullMath and TickMath are needed for percentage method
  const candidateLibs = ["FullMath", "TickMath"];

  for (const libName of candidateLibs) {
    const indexNeeds = await needsLibrary("Index", libName);
    const pmNeeds = await needsLibrary("PositionManager", libName);
    
    if (!indexNeeds && !pmNeeds) {
      console.log(`ℹ️  ${libName} not needed by contracts – skipping`);
      continue;
    }
    
    const libAddr = await deployLibraryIfPresent(libName, deployer);
    if (libAddr) {
      deployedLibs[libName] = libAddr;
    }
  }

  if (Object.keys(deployedLibs).length === 0) {
    console.log("✅ No libraries needed - contracts are self-contained");
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOY INDEX CONTRACT (PERCENTAGE-BASED)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n📊 Deploying Index Contract (Percentage Method)...");
  
  let IndexFactory;
  const indexLibsToLink = {};
  
  if (deployedLibs["FullMath"]) indexLibsToLink["FullMath"] = deployedLibs["FullMath"];
  if (deployedLibs["TickMath"]) indexLibsToLink["TickMath"] = deployedLibs["TickMath"];

  try {
    if (Object.keys(indexLibsToLink).length > 0) {
      console.log("🔗 Index requires library linking:", Object.keys(indexLibsToLink).join(", "));
      IndexFactory = await ethers.getContractFactory("Index", { libraries: indexLibsToLink });
    } else {
      console.log("ℹ️  Index deploying without library linking.");
      IndexFactory = await ethers.getContractFactory("Index");
    }
  } catch (err) {
    console.error("❌ Failed to get Index contract factory:", err.message);
    throw err;
  }

  const adminAddress = process.env.ADMIN_ADDRESS || deployerAddress;
  console.log("👥 Using admin address:", adminAddress);

  const unifiedIndex = await IndexFactory.connect(deployer).deploy(adminAddress);
  await unifiedIndex.waitForDeployment();
  const unifiedAddr = await unifiedIndex.getAddress();
  console.log("✅ Index deployed at:", unifiedAddr);

  // Verify percentage levels
  try {
    const pctLevels = await unifiedIndex.getPctLevels();
    console.log("📊 Percentage levels configured:", pctLevels.map(p => `${p}%`).join(", "));
    console.log("   L1: 1%, L5: 5%, L10: 10%, L20: 20%");
  } catch (err) {
    console.log("⚠️  Could not verify percentage levels:", err.message);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOY POSITION MANAGER (PERCENTAGE-BASED)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n⚡ Deploying PositionManager (Percentage Method)...");
  
  let PositionManagerFactory;
  const pmLibsToLink = {};
  
  if (deployedLibs["FullMath"]) pmLibsToLink["FullMath"] = deployedLibs["FullMath"];
  if (deployedLibs["TickMath"]) pmLibsToLink["TickMath"] = deployedLibs["TickMath"];

  try {
    if (Object.keys(pmLibsToLink).length > 0) {
      console.log("🔗 PositionManager requires library linking:", Object.keys(pmLibsToLink).join(", "));
      PositionManagerFactory = await ethers.getContractFactory("PositionManager", { 
        libraries: pmLibsToLink 
      });
    } else {
      console.log("ℹ️  PositionManager deploying without library linking.");
      PositionManagerFactory = await ethers.getContractFactory("PositionManager");
    }
  } catch (err) {
    console.error("❌ Failed to get PositionManager contract factory:", err.message);
    throw err;
  }

  let positionManager;
  let pmAddr;
  
  // Try different constructor signatures gracefully
  try {
    console.log("⚙️  Attempting to deploy PositionManager with (indexAddress, nfpmAddress) constructor...");
    positionManager = await PositionManagerFactory.connect(deployer).deploy(unifiedAddr, nfpmAddress);
    await positionManager.waitForDeployment();
    pmAddr = await positionManager.getAddress();
    console.log("✅ PositionManager deployed at:", pmAddr, "(with two-arg constructor)");
  } catch (errTwoArgs) {
    console.log("ℹ️  Two-arg constructor deploy failed:", errTwoArgs.message);
    try {
      console.log("⚙️  Attempting to deploy PositionManager with (indexAddress) constructor...");
      positionManager = await PositionManagerFactory.connect(deployer).deploy(unifiedAddr);
      await positionManager.waitForDeployment();
      pmAddr = await positionManager.getAddress();
      console.log("✅ PositionManager deployed at:", pmAddr, "(with single-arg constructor)");
    } catch (errOneArg) {
      console.error("❌ Failed to deploy PositionManager with either constructor signature.");
      console.error("   Two-arg error:", errTwoArgs.message);
      console.error("   One-arg error:", errOneArg.message);
      throw new Error("PositionManager deployment failed. Check constructor signature.");
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // LINK INDEX WITH POSITION MANAGER
  // ═══════════════════════════════════════════════════════════════════════════════
  try {
    let canLink = false;
    try {
      unifiedIndex.interface.getFunction("setPositionManager");
      canLink = true;
    } catch (e) {
      canLink = false;
    }

    if (canLink) {
      console.log("\n🔗 Calling setPositionManager on Index to link PositionManager...");
      const tx = await unifiedIndex.connect(deployer).setPositionManager(pmAddr);
      await tx.wait();
      console.log("✅ Index linked with PositionManager");
    } else {
      console.log("ℹ️  setPositionManager() not present on Index – skipping link");
    }
  } catch (err) {
    console.log("⚠️  setPositionManager call failed or not needed:", err.message);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOYMENT SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════════
  const deployed = {
    Index: unifiedAddr,
    PositionManager: pmAddr,
    NFPM: nfpmAddress,
    libraries: deployedLibs,
    method: "PERCENTAGE-BASED (No TMath)",
    percentageLevels: "L1: 1%, L5: 5%, L10: 10%, L20: 20%"
  };

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ LOCAL DEPLOYMENT FINISHED SUCCESSFULLY!");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Deployed addresses:");
  console.log(JSON.stringify(deployed, null, 2));
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("\n💡 IMPORTANT NOTES:");
  console.log("   • Contracts use PERCENTAGE-BASED calculations (no TMath)");
  console.log("   • Percentage levels: 1%, 5%, 10%, 20%");
  console.log("   • Use these addresses in your .env file");
  console.log("   • Configure offchain agent with these addresses");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});