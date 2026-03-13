const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const analyticsRoutes = require('./routes/analytics');
const whatsappRoutes = require('./routes/whatsapp');
const authRoutes = require('./routes/auth');
const templatesRoutes = require('./routes/templates');
const franchiseRoutes = require('./routes/franchise');
const adminRoutes = require('./routes/admin');
const automationRoutes = require('./routes/automation');
const authenticateToken = require('./middleware/auth');
const { logger } = require('./config/logger');
const { reconcileAll } = require('./services/billingReconciler');

const SENSITIVE_FIELDS = new Set(['password', 'otp', 'token', 'access_token', 'authorization']);

const sanitizePayload = (payload) => {
  if (payload === null || typeof payload !== 'object') {
    return payload;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizePayload(item));
  }

  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      acc[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      acc[key] = sanitizePayload(value);
    } else {
      acc[key] = value;
    }
    return acc;
  }, {});
};

const app = express();
const PORT = process.env.PORT || 5050;
const BILLING_RECONCILE_ENABLED = process.env.BILLING_RECONCILE_ENABLED === 'true';
const BILLING_RECONCILE_INTERVAL_MINUTES = Math.max(
  1,
  parseInt(process.env.BILLING_RECONCILE_INTERVAL_MINUTES || '10', 10)
);
let billingReconcileRunning = false;

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Validate WhatsApp environment variables on startup
function validateEnvironment() {
  const required = ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WEBHOOK_VERIFY_TOKEN'];
  const missing = required.filter(
    (key) => !process.env[key] || process.env[key].includes('placeholder')
  );

  if (missing.length > 0) {
    logger.warn('Missing or placeholder WhatsApp environment variables', { missing });
    console.warn('⚠️  Missing WhatsApp credentials:', missing.join(', '));
  } else {
    logger.info('WhatsApp environment variables validated successfully');
  }
}

// Middleware
app.use(cors());
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      if (req.originalUrl === '/api/franchise/payments/webhook') {
        req.rawBody = buf.toString('utf8');
      }
    },
  })
);
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = Date.now();
  const requestDetails = {
    method: req.method,
    url: req.originalUrl,
    query: sanitizePayload(req.query),
    body: sanitizePayload(req.body),
  };

  logger.info('Incoming request', requestDetails);

  res.on('finish', () => {
    logger.info('Request completed', {
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Date.now() - start,
      storeId: req.user?.store_id || null,
    });
  });

  next();
});

// Auth middleware (protects all /api/** routes except /api/auth/login)
app.use(authenticateToken);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/franchise', franchiseRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/automation', automationRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'BillBox WhatsApp Analytics Backend',
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('BillBox WhatsApp Analytics Backend - Service is running');
});

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
  });

  res.status(500).json({
    error: 'Internal server error',
    timestamp: new Date().toISOString(),
  });
});

// Validate environment and start server
validateEnvironment();

app.listen(PORT, () => {
  logger.info('Server started successfully', { port: PORT });
  console.log(`???? Server running on port ${PORT}`);
  console.log(`???? Analytics: http://localhost:${PORT}/api/analytics`);
  console.log(`???? WhatsApp: http://localhost:${PORT}/api/whatsapp`);
  console.log(`???? Health: http://localhost:${PORT}/health`);
});

if (BILLING_RECONCILE_ENABLED) {
  const intervalMs = BILLING_RECONCILE_INTERVAL_MINUTES * 60 * 1000;
  logger.info('Billing reconciliation enabled', {
    intervalMinutes: BILLING_RECONCILE_INTERVAL_MINUTES,
  });
  setInterval(async () => {
    if (billingReconcileRunning) {
      return;
    }
    billingReconcileRunning = true;
    try {
      await reconcileAll();
    } finally {
      billingReconcileRunning = false;
    }
  }, intervalMs);
}
