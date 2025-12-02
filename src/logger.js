// src/logger.js
// ✅ مُحسّن مع file logging, rotation, وإحصائيات مفصّلة

const fs = require('fs');
const path = require('path');
const { config } = require('./config.js');

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

const stats = {
  totalRuns: 0,
  successes: 0,
  failures: 0,
  lastReset: Date.now(),
  logCounts: {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0
  }
};

let logStream = null;
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

function initLogger() {
  if (config.logToFile && !logStream) {
    try {
      const logDir = path.dirname(config.logFilePath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      logStream = fs.createWriteStream(config.logFilePath, { 
        flags: 'a',
        encoding: 'utf8'
      });

      logStream.on('error', (err) => {
        console.error('❌ Log file stream error:', err.message);
        logStream = null;
      });

      // Log rotation check (if file > 100MB, rotate)
      checkLogRotation();
    } catch (err) {
      console.error('❌ Failed to initialize log file:', err.message);
    }
  }
}

function checkLogRotation() {
  try {
    if (!fs.existsSync(config.logFilePath)) return;
    
    const stats = fs.statSync(config.logFilePath);
    const maxSize = 100 * 1024 * 1024; // 100MB

    if (stats.size > maxSize) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedPath = config.logFilePath.replace('.log', `-${timestamp}.log`);
      
      if (logStream) {
        logStream.end();
        logStream = null;
      }

      fs.renameSync(config.logFilePath, rotatedPath);
      console.log(`📦 Log file rotated to: ${rotatedPath}`);
      
      // Reinitialize stream
      initLogger();
    }
  } catch (err) {
    console.error('⚠️  Log rotation failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main logging function
 * @param {string} message - Log message
 * @param {string} poolId - Optional pool ID
 * @param {string} level - Log level: debug, info, warn, error
 */
function log(message, poolId = "", level = "info") {
  const normalizedLevel = level.toLowerCase();
  
  // Check if this level should be logged
  const configLevel = LOG_LEVELS[config.logLevel] || LOG_LEVELS.info;
  const messageLevel = LOG_LEVELS[normalizedLevel] || LOG_LEVELS.info;
  
  if (messageLevel < configLevel) {
    return; // Skip messages below configured level
  }

  const timestamp = new Date().toISOString();
  const prefix = poolId ? `[${poolId}]` : "";
  const levelTag = normalizedLevel.toUpperCase().padEnd(5);
  const logLine = `${timestamp} ${levelTag} ${prefix} ${message}`;

  // Update stats
  if (stats.logCounts[normalizedLevel] !== undefined) {
    stats.logCounts[normalizedLevel]++;
  }

  // Console output with colors
  const coloredOutput = colorize(logLine, normalizedLevel);
  console.log(coloredOutput);

  // File output (no colors)
  if (logStream && logStream.writable) {
    try {
      logStream.write(logLine + '\n');
    } catch (err) {
      console.error('⚠️  Failed to write to log file:', err.message);
    }
  }
}

function colorize(text, level) {
  const colors = {
    debug: '\x1b[36m',  // Cyan
    info: '\x1b[32m',   // Green
    warn: '\x1b[33m',   // Yellow
    error: '\x1b[31m',  // Red
    reset: '\x1b[0m'
  };

  const color = colors[level] || colors.reset;
  return `${color}${text}${colors.reset}`;
}

/**
 * Specialized logging functions
 */
function debug(message, poolId = "") {
  log(message, poolId, "debug");
}

function info(message, poolId = "") {
  log(message, poolId, "info");
}

function warn(message, poolId = "") {
  log(message, poolId, "warn");
}

function error(message, poolId = "") {
  log(message, poolId, "error");
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATISTICS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Update success/failure statistics
 * @param {boolean} success - Whether operation succeeded
 */
function updateStats(success) {
  stats.totalRuns++;
  if (success) {
    stats.successes++;
  } else {
    stats.failures++;
  }

  // Log stats every 20 runs
  if (stats.totalRuns % 20 === 0) {
    logStats();
  }

  // Check for log rotation every 100 runs
  if (stats.totalRuns % 100 === 0) {
    checkLogRotation();
  }
}

function logStats() {
  const successRate = stats.totalRuns > 0 
    ? ((stats.successes / stats.totalRuns) * 100).toFixed(2)
    : "0.00";
  
  const uptime = Date.now() - stats.lastReset;
  const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(2);

  const statsMessage = [
    '\n═══════════════════════════════════════════════════════════════',
    '📊 AGENT STATISTICS',
    '═══════════════════════════════════════════════════════════════',
    `Total Runs:      ${stats.totalRuns}`,
    `Successes:       ${stats.successes}`,
    `Failures:        ${stats.failures}`,
    `Success Rate:    ${successRate}%`,
    `Uptime:          ${uptimeHours} hours`,
    '───────────────────────────────────────────────────────────────',
    'Log Counts:',
    `  DEBUG:  ${stats.logCounts.debug}`,
    `  INFO:   ${stats.logCounts.info}`,
    `  WARN:   ${stats.logCounts.warn}`,
    `  ERROR:  ${stats.logCounts.error}`,
    '═══════════════════════════════════════════════════════════════\n'
  ].join('\n');

  console.log(statsMessage);
  
  if (logStream && logStream.writable) {
    logStream.write(statsMessage + '\n');
  }
}

/**
 * Get current statistics
 * @returns {object} Current stats object
 */
function getStats() {
  const uptime = Date.now() - stats.lastReset;
  const successRate = stats.totalRuns > 0 
    ? ((stats.successes / stats.totalRuns) * 100).toFixed(2)
    : "0.00";

  return {
    ...stats,
    uptime,
    uptimeHours: (uptime / (1000 * 60 * 60)).toFixed(2),
    successRate: parseFloat(successRate)
  };
}

/**
 * Reset statistics (useful for testing or manual reset)
 */
function resetStats() {
  stats.totalRuns = 0;
  stats.successes = 0;
  stats.failures = 0;
  stats.lastReset = Date.now();
  stats.logCounts = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0
  };
  log('Statistics reset', '', 'info');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

function closeLogger() {
  if (logStream) {
    logStats(); // Log final stats
    logStream.end();
    logStream = null;
  }
}

// Handle process termination
process.on('SIGINT', closeLogger);
process.on('SIGTERM', closeLogger);
process.on('exit', closeLogger);

// ═══════════════════════════════════════════════════════════════════════════════
// INITIALIZATION & EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

initLogger();

module.exports = {
  log,
  debug,
  info,
  warn,
  error,
  updateStats,
  getStats,
  resetStats,
  logStats,
  closeLogger
};