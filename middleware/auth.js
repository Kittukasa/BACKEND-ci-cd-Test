const jwt = require('jsonwebtoken');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { logger } = require('../config/logger');
const {
  sanitizeCustomerTypeConfig,
  DEFAULT_CUSTOMER_TYPE_CONFIG,
} = require('../utils/customerTypes');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || JWT_SECRET;
const STORE_WHATSAPP_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;
const ADMIN_PANEL_DEV_MODE = process.env.ADMIN_PANEL_DEV_MODE === 'true';

// Initialize DynamoDB client
const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const docClient = DynamoDBDocumentClient.from(client);

// JWT authentication middleware
const authenticateToken = async (req, res, next) => {
  if (req.path === '/api/admin/login') {
    return next();
  }

  // Skip auth entirely when admin panel dev mode is enabled for admin routes
  if (ADMIN_PANEL_DEV_MODE && req.path.startsWith('/api/admin')) {
    logger.warn('Admin panel dev mode enabled; skipping auth for admin endpoint', {
      path: req.path,
    });
    return next();
  }

  // Skip auth for vendor login and public webhook endpoints
  if (
    req.path === '/api/auth/login' ||
    req.path === '/api/auth/login/options' ||
    req.path === '/api/auth/login/send-otp' ||
    req.path === '/api/auth/login/password' ||
    req.path === '/api/auth/login/password/send-otp' ||
    req.path === '/api/auth/login/config' ||
    req.path === '/api/auth/login/password-only' ||
    req.path === '/api/auth/signup' ||
    req.path === '/api/auth/send-otp' ||
    req.path === '/api/auth/reset-password' ||
    req.path === '/api/auth/franchise/reset-password' ||
    req.path === '/api/auth/franchise/verify' ||
    req.path === '/api/whatsapp/webhook' ||
    req.path.startsWith('/api/franchise')
  ) {
    return next();
  }

  // Skip auth for non-API routes
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (req.path.startsWith('/api/admin')) {
    if (!token) {
      logger.warn('No admin token provided', { path: req.path });
      return res.status(401).json({ error: 'Admin access token required' });
    }

    return jwt.verify(token, ADMIN_JWT_SECRET, (err, admin) => {
      if (err || admin?.type !== 'admin') {
        logger.warn('Invalid admin token', { path: req.path, error: err?.message });
        return res.status(403).json({ error: 'Invalid or expired admin token' });
      }
      req.admin = admin;
      return next();
    });
  }

  if (!token) {
    logger.warn('No token provided', { path: req.path });
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) {
      logger.warn('Invalid token', { path: req.path, error: err.message });
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
      // Fetch WhatsApp configuration for the store
      const command = new GetCommand({
        TableName: STORE_WHATSAPP_CONFIG_TABLE,
        Key: { store_id: user.store_id },
      });

      const result = await docClient.send(command);

      if (result.Item) {
        const config = result.Item;

        if (config.session_revoked_at) {
          const revokedAt = Number(config.session_revoked_at);
          const tokenIssuedAt = Number(user.iat || 0);
          if (Number.isFinite(revokedAt) && tokenIssuedAt <= revokedAt) {
            return res.status(401).json({ error: 'Session expired. Please log in again.' });
          }
        }

        if (typeof config.session_version !== 'undefined') {
          const storedVersion = Number(config.session_version);
          if (Number.isFinite(storedVersion)) {
            const tokenVersion = Number(user.session_version);
            if (!Number.isFinite(tokenVersion) || tokenVersion !== storedVersion) {
              return res.status(401).json({ error: 'Session invalidated. Please log in again.' });
            }
          }
        }

        // Add WhatsApp config to user context
        req.user = {
          ...user,
          whatsapp_api_url: config.whatsapp_api_url || null,
          access_token: config.access_token || null,
          waba_id: config.waba_id || null,
          phone_number_id: config.phone_number_id || null,
          waba_mobile_number: config.waba_mobile_number || null,
          template_name: config.template_name || null,
          template_language: config.template_language || null,
          vendor_name: config.vendor_name || null,
          verified_name: config.verified_name || null,
          store_name: config.store_name || null,
          webhook_config: config.webhook_config || null,
          customer_type_config: sanitizeCustomerTypeConfig(
            config.customer_type_config || DEFAULT_CUSTOMER_TYPE_CONFIG
          ),
        };
      } else {
        req.user = {
          ...user,
          customer_type_config: sanitizeCustomerTypeConfig(DEFAULT_CUSTOMER_TYPE_CONFIG),
        };
      }

      next();
    } catch (error) {
      logger.error('Error fetching WhatsApp config', {
        store_id: user.store_id,
        error: error.message,
      });
      req.user = user;
      next();
    }
  });
};

module.exports = authenticateToken;
