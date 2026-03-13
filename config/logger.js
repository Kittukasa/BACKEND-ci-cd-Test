const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// In-memory log buffer for /logs endpoint
const logBuffer = [];
const LOG_BUFFER_SIZE = parseInt(process.env.LOG_BUFFER_SIZE) || 500;

// Custom format for structured logging
const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `[${timestamp}] ${level}: ${message} ${metaStr}`;
  })
);

// Create rotating file transport
const fileTransport = new DailyRotateFile({
  filename: 'logs/whatsapp-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '1m',
  maxFiles: '3d',
  format: logFormat
});

// Create logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    fileTransport,
    new winston.transports.Console({
      format: consoleFormat
    })
  ]
});

// Custom transport to capture logs in memory buffer
class MemoryTransport extends winston.Transport {
  log(info, callback) {
    const logEntry = {
      timestamp: info.timestamp,
      level: info.level.toUpperCase(),
      message: info.message,
      meta: info.meta || {}
    };
    
    logBuffer.push(logEntry);
    
    // Keep buffer size limited
    if (logBuffer.length > LOG_BUFFER_SIZE) {
      logBuffer.shift();
    }
    
    callback();
  }
}

logger.add(new MemoryTransport());

// Export logger and buffer access
module.exports = {
  logger,
  getLogBuffer: () => [...logBuffer],
  LOG_BUFFER_SIZE
};
