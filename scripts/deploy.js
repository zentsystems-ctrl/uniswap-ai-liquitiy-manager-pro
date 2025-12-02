// scripts/deploy.js
// ✅ UPDATED FOR PERCENTAGE METHOD - Production deployment
const { ethers, network } = require("hardhat");

async function main() {
  console.log("🚀 Deploying contracts (PERCENTAGE METHOD)...");
  console.log("🔗 Network:", network.name);

  // Prevent accidental local deployment with this script
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("⚠️  This script is intended for public/test networks only.");
    console.log("   Use deploy_local.js for local deployment.");
    return;
  }

  const [deployer] = await ethers.getSigners();
  const balance = await deployer.getBalance();

  console.log("👤 Deployer address:", deployer.address);
  console.log("💰 Deployer balance:", ethers.formatEther(balance), "ETH");

  // ═══════════════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════════════
  const nfpmAddress = process.env.NFPM_ADDRESS;
  if (!nfpmAddress) {
    console.error("❌ NFPM_ADDRESS environment variable is required.");
    console.error("   Set the address of NonfungiblePositionManager in your .env file.");
    return;
  }

  console.log("ℹ️  Using NFPM address:", nfpmAddress);
  console.log("📊 Deployment Method: PERCENTAGE-BASED (No TMath)");

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOY MATH LIBRARIES (PERCENTAGE METHOD - NO TMath!)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n📚 Deploying Math Libraries (Percentage Method)...");
  console.log("   NOTE: TMath is NO LONGER NEEDED - using percentage calculations");

  let deployedLibs = {};

  // Deploy FullMath (still needed for precision)
  try {
    const FullMath = await ethers.getContractFactory("FullMath");
    const fullMath = await FullMath.deploy();
    await fullMath.waitForDeployment();
    const fullMathAddr = await fullMath.getAddress();
    deployedLibs.FullMath = fullMathAddr;
    console.log("✅ FullMath deployed at:", fullMathAddr);
  } catch (err) {
    console.log("ℹ️  FullMath not needed or already available");
  }

  // Deploy TickMath if needed
  try {
    const TickMath = await ethers.getContractFactory("TickMath");
    const tickMath = await TickMath.deploy();
    await tickMath.waitForDeployment();
    const tickMathAddr = await tickMath.getAddress();
    deployedLibs.TickMath = tickMathAddr;
    console.log("✅ TickMath deployed at:", tickMathAddr);
  } catch (err) {
    console.log("ℹ️  TickMath not needed or already available");
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOY INDEX CONTRACT (PERCENTAGE-BASED)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n📊 Deploying Index Contract (Percentage Method)...");

  const Index = await ethers.getContractFactory("Index", {
    libraries: deployedLibs.FullMath ? { FullMath: deployedLibs.FullMath } : {},
  });

  const adminAddress = process.env.ADMIN_ADDRESS || deployer.address;
  console.log("👥 Using admin address:", adminAddress);

  const unifiedIndex = await Index.deploy(adminAddress);
  await unifiedIndex.waitForDeployment();
  const indexAddr = await unifiedIndex.getAddress();
  console.log("✅ Index deployed at:", indexAddr);

  // Verify percentage levels
  try {
    const pctLevels = await unifiedIndex.getPctLevels();
    console.log("📊 Percentage levels:", pctLevels.map(p => `${p}%`).join(", "));
  } catch (err) {
    console.log("⚠️  Could not verify percentage levels");
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOY POSITION MANAGER (PERCENTAGE-BASED)
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n⚡ Deploying PositionManager (Percentage Method)...");

  const PositionManager = await ethers.getContractFactory("PositionManager", {
    libraries: deployedLibs,
  });

  const positionManager = await PositionManager.deploy(indexAddr, nfpmAddress);
  await positionManager.waitForDeployment();
  const pmAddr = await positionManager.getAddress();
  console.log("✅ PositionManager deployed at:", pmAddr);

  // ═══════════════════════════════════════════════════════════════════════════════
  // LINK INDEX WITH POSITION MANAGER
  // ═══════════════════════════════════════════════════════════════════════════════
  if (typeof unifiedIndex.setPositionManager === "function") {
    try {
      console.log("\n🔗 Linking Index with PositionManager...");
      const tx = await unifiedIndex.setPositionManager(pmAddr);
      await tx.wait();
      console.log("✅ Index linked with PositionManager");
    } catch (err) {
      console.log("⚠️  setPositionManager call failed:", err.message);
    }
  } else {
    console.log("ℹ️  setPositionManager() not found on Index — skipping link");
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEPLOYMENT SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("✅ DEPLOYMENT FINISHED SUCCESSFULLY!");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("Network:", network.name);
  console.log("Method: PERCENTAGE-BASED (No TMath)");
  console.log("\nDeployed Contracts:");
  console.log("  Index:", indexAddr);
  console.log("  PositionManager:", pmAddr);
  console.log("  NFPM:", nfpmAddress);
  console.log("\nDeployed Libraries:");
  Object.entries(deployedLibs).forEach(([name, addr]) => {
    console.log(`  ${name}:`, addr);
  });
  console.log("\n💡 Add these addresses to your .env file:");
  console.log(`INDEX_ADDRESS=${indexAddr}`);
  console.log(`PM_ADDRESS=${pmAddr}`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});