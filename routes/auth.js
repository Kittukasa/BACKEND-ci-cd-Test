const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { docClient } = require('../config/dynamodb');
const { GetCommand, ScanCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { logger } = require('../config/logger');
const { findFranchiseByIds, getFranchiseOwnerContact } = require('../services/franchiseService');
const {
  sanitizeCustomerTypeConfig,
  DEFAULT_CUSTOMER_TYPE_CONFIG,
} = require('../utils/customerTypes');

const router = express.Router();

const STORE_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;
const LEAD_SIGNUPS_TABLE = process.env.LEAD_SIGNUPS_TABLE || process.env.LEAD_SIGNUPS;
const FRANCHISES_TABLE = process.env.FRANCHISES_TABLE;
const JWT_SECRET = process.env.JWT_SECRET;
const SMS_TOKEN = process.env.SMS_TOKEN;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'BBXSMS';
const SMS_TEMPLATE_ID = process.env.SMS_TEMPLATE_ID || '199010';
const SIGNUP_SMS_TEMPLATE_ID = process.env.SIGNUP_SMS_TEMPLATE_ID || '203586';
const PHONE_FIELDS = ['mobile_number', 'contact_phone', 'vendor_phone', 'phone', 'mobile'];
const OTP_TTL_MS = 90 * 1000;
const otpStore = new Map();
const DEFAULT_LOGIN_METHOD = 'otp';
const TWO_STEP_VERIFICATION_ENABLED = process.env.TWO_STEP_VERIFICATION !== 'false';
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const SMART_EBILL_S3_BUCKET = process.env.SMART_EBILL_S3_BUCKET || 'billbox-frontend';
const SMART_EBILL_S3_PREFIX = (() => {
  const raw = process.env.SMART_EBILL_S3_PREFIX || 'Smart-e-bill-images/';
  const normalized = raw.replace(/^\/+/, '').replace(/\\/g, '/');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
})();
const SMART_EBILL_MAX_IMAGES = Number(process.env.SMART_EBILL_MAX_IMAGES || 10);
const SMART_EBILL_MAX_FILE_SIZE = Number(process.env.SMART_EBILL_MAX_FILE_SIZE || 5 * 1024 * 1024);
const s3Client =
  SMART_EBILL_S3_BUCKET && AWS_REGION
    ? new S3Client({
        region: AWS_REGION,
      })
    : null;
const smartEbillUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: SMART_EBILL_MAX_FILE_SIZE,
    files: SMART_EBILL_MAX_IMAGES,
  },
});
const smartEbillUploadMiddleware = (req, res, next) => {
  smartEbillUpload.array('images', SMART_EBILL_MAX_IMAGES)(req, res, (err) => {
    if (!err) {
      return next();
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxMb = Math.max(1, Math.round(SMART_EBILL_MAX_FILE_SIZE / (1024 * 1024)));
        return res.status(413).json({ error: `Image too large. Maximum size is ${maxMb}MB.` });
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res
          .status(413)
          .json({ error: `Too many images. Maximum is ${SMART_EBILL_MAX_IMAGES}.` });
      }
      return res.status(400).json({ error: err.message || 'Invalid upload.' });
    }
    return res.status(400).json({ error: 'Unable to upload images.' });
  });
};

const resolveFranchiseTrial = async (franchiseId) => {
  if (!FRANCHISES_TABLE || !franchiseId) {
    return null;
  }
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
      })
    );
    const item = result.Item || null;
    if (!item || !item.trial_start || !item.trial_end) {
      return null;
    }
    const start = new Date(item.trial_start);
    const end = new Date(item.trial_end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return null;
    }
    const diffMs = end.getTime() - start.getTime();
    const periodDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
    if (periodDays < 0) {
      return null;
    }
    return {
      trial_started: item.trial_start,
      trial_period: periodDays,
    };
  } catch (error) {
    logger.warn('Failed to resolve franchise trial', { franchiseId, error: error.message });
    return null;
  }
};

const createOtpKey = ({ storeId, phone, context }) => {
  if (storeId) {
    return `${context || 'store'}:${storeId}`;
  }
  return `${context || 'phone'}:${phone}`;
};

const saveOtp = (key, otp) => {
  const now = Date.now();
  otpStore.set(key, {
    otp,
    createdAt: now,
    expiresAt: now + OTP_TTL_MS,
  });
};

const consumeOtp = (key, otp) => {
  const record = otpStore.get(key);
  if (!record) {
    return false;
  }
  const issuedAt =
    record.createdAt || (record.expiresAt ? record.expiresAt - OTP_TTL_MS : Date.now());
  const isExpired = record.expiresAt < Date.now() || Date.now() - issuedAt > OTP_TTL_MS;
  if (isExpired) {
    otpStore.delete(key);
    return false;
  }
  const match = record.otp === otp;
  if (match) {
    otpStore.delete(key);
  }
  return match;
};

const maskPhone = (phone = '') => {
  if (!phone) return '';
  const trimmed = phone.trim();
  if (trimmed.length <= 3) {
    return trimmed;
  }
  const maskedPart = '*'.repeat(Math.max(0, trimmed.length - 3));
  return `${maskedPart}${trimmed.slice(-3)}`;
};

const resolveStorePhone = (store = {}) => {
  for (const field of PHONE_FIELDS) {
    if (store[field]) {
      return String(store[field]).replace(/\D/g, '');
    }
  }
  return null;
};

const buildSmartEbillKey = (storeId, originalName = 'image.jpg') => {
  const safeName =
    typeof originalName === 'string' ? originalName.replace(/[^a-zA-Z0-9.\-]/g, '') : 'upload.jpg';
  const extension = path.extname(safeName) || '.jpg';
  const randomSegment = crypto.randomBytes(8).toString('hex');
  return `${SMART_EBILL_S3_PREFIX}${storeId}/${Date.now()}-${randomSegment}${extension}`;
};

const buildSmartEbillUrl = (key) => {
  if (!key) {
    return '';
  }
  return `https://${SMART_EBILL_S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
};

const sanitizeSmartText = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, 500);
};

const normalizePhoneDigits = (value = '') => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\D/g, '');
};

const sanitizePin = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return /^\d{4,6}$/.test(trimmed) ? trimmed : null;
};

const fetchStoreRevenuePin = async (storeId) => {
  if (!STORE_CONFIG_TABLE) {
    return null;
  }
  const command = new GetCommand({
    TableName: STORE_CONFIG_TABLE,
    Key: { store_id: storeId },
    ProjectionExpression: 'revenue_pin, revenue_pin_updated_at',
  });
  const result = await docClient.send(command);
  if (!result.Item?.revenue_pin) {
    return null;
  }
  return {
    pin: String(result.Item.revenue_pin).trim(),
    updatedAt: result.Item.revenue_pin_updated_at || null,
  };
};

const buildFranchiseCandidateIds = (ids = []) =>
  Array.from(
    new Set(
      ids
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .flatMap((value) => [value, value.toLowerCase()])
    )
  );

const listStoresForFranchise = async (franchiseId) => {
  if (!STORE_CONFIG_TABLE || !franchiseId) {
    return [];
  }
  const candidates = buildFranchiseCandidateIds([franchiseId]);
  for (const candidate of candidates) {
    const stores = [];
    let lastEvaluatedKey;
    do {
      const command = new ScanCommand({
        TableName: STORE_CONFIG_TABLE,
        FilterExpression: 'franchise_id = :franchiseId',
        ExpressionAttributeValues: {
          ':franchiseId': candidate,
        },
        ProjectionExpression: 'store_id, franchise_id, franchise_password, updated_at',
        ExclusiveStartKey: lastEvaluatedKey,
      });
      const result = await docClient.send(command);
      if (result.Items && result.Items.length > 0) {
        stores.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (stores.length > 0) {
      return stores;
    }
  }
  return [];
};

const resolveClientLocation = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || 'unknown';
};

const appendAuditEntry = async (storeId, req) => {
  if (!STORE_CONFIG_TABLE || !storeId) {
    return;
  }

  const entry = {
    location: resolveClientLocation(req),
    time: new Date().toISOString(),
    system: req.get('user-agent') || 'unknown',
  };

  const command = new UpdateCommand({
    TableName: STORE_CONFIG_TABLE,
    Key: { store_id: storeId },
    UpdateExpression:
      'SET audit_history = list_append(:entry, if_not_exists(audit_history, :empty))',
    ExpressionAttributeValues: {
      ':entry': [entry],
      ':empty': [],
    },
  });

  await docClient.send(command);
};

const isPhoneNumberRegistered = async (digits) => {
  if (!STORE_CONFIG_TABLE || !digits) {
    return false;
  }

  let lastEvaluatedKey = undefined;
  do {
    const params = {
      TableName: STORE_CONFIG_TABLE,
      ProjectionExpression: PHONE_FIELDS.concat('store_id').join(', '),
      ExclusiveStartKey: lastEvaluatedKey,
    };

    const result = await docClient.send(new ScanCommand(params));
    const items = result.Items || [];
    const matchFound = items.some((item) =>
      PHONE_FIELDS.some((field) => normalizePhoneDigits(item[field]) === digits)
    );
    if (matchFound) {
      return true;
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return false;
};

const sendSignupCredentialsSMS = async ({ phone, storeId, franchiseId }) => {
  if (!SMS_TOKEN || !phone) {
    return;
  }
  try {
    await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        route: 'dlt',
        sender_id: SMS_SENDER_ID,
        message: SIGNUP_SMS_TEMPLATE_ID,
        variables_values: `${storeId || ''}|${franchiseId || ''}`,
        numbers: phone,
        schedule_time: '',
        flash: '0',
      },
      {
        headers: {
          authorization: SMS_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    logger.info('Signup credentials SMS sent', { store_id: storeId, franchise_id: franchiseId });
  } catch (error) {
    logger.warn('Failed to send signup credentials SMS', {
      store_id: storeId,
      franchise_id: franchiseId,
      status: error.response?.status,
      message: error.response?.data || error.message,
    });
  }
};

const createFranchiseId = (brandName = '', storeId = '') => {
  const brandSegment =
    brandName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 12) || 'brand';
  const storeSegment = storeId.slice(-4) || '0000';
  return `${brandSegment}${storeSegment}`;
};

// POST /auth/login - Authenticate store user via OTP
router.post('/login', async (req, res) => {
  const { store_id, otp } = req.body || {};

  if (!store_id) {
    return res.status(400).json({ error: 'store_id is required' });
  }
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({ error: 'Valid 6-digit OTP is required to log in.' });
  }

  try {
    logger.info('Login attempt', { store_id });

    // Query DynamoDB using only store_id as primary key
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: {
        store_id: store_id,
      },
    });

    const result = await docClient.send(command);

    if (!result.Item) {
      logger.warn('Store not found during login', { store_id });
      return res
        .status(404)
        .json({ error: 'Store not found. Please sign up to create an account.' });
    }

    const otpKey = createOtpKey({ storeId: store_id, context: 'login' });
    const verified = consumeOtp(otpKey, otp.trim());
    if (!verified) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    // Fetch WhatsApp configuration for the store
    const whatsappConfig = result.Item || {};
    const {
      whatsapp_api_url,
      access_token,
      waba_id,
      phone_number_id,
      waba_mobile_number,
      template_name,
      template_language,
      vendor_name,
      verified_name,
      store_name,
      webhook_config,
    } = whatsappConfig;
    const storeTrialStarted = whatsappConfig.trial_started ?? whatsappConfig.trail_started ?? null;
    const storeTrialPeriod = whatsappConfig.trial_period ?? null;

    // Generate JWT token
    const franchise_id = result.Item.franchise_id || null;
    const franchiseTrial = await resolveFranchiseTrial(franchise_id);
    const trial_started = franchiseTrial?.trial_started ?? storeTrialStarted;
    const trial_period = franchiseTrial?.trial_period ?? storeTrialPeriod;
    const rawSessionVersion = result.Item.session_version;
    const session_version = Number.isFinite(Number(rawSessionVersion))
      ? Number(rawSessionVersion)
      : null;
    const token = jwt.sign(
      {
        franchise_id,
        store_id,
        session_version,
        iat: Math.floor(Date.now() / 1000),
      },
      JWT_SECRET,
      { expiresIn: '3d' }
    );

    logger.info('Login successful', { store_id });

    const customerTypeConfig = sanitizeCustomerTypeConfig(
      result.Item.customer_type_config || DEFAULT_CUSTOMER_TYPE_CONFIG
    );

    appendAuditEntry(store_id, req).catch((err) => {
      logger.warn('Failed to append audit history', {
        store_id,
        error: err.message,
      });
    });

    res.json({
      token,
      store_id,
      franchise_id,
      whatsapp_api_url,
      access_token,
      waba_id: waba_id || null,
      phone_number_id: phone_number_id || null,
      waba_mobile_number: waba_mobile_number || null,
      template_name: template_name || null,
      template_language: template_language || null,
      vendor_name: vendor_name || null,
      verified_name: verified_name || null,
      store_name: store_name || null,
      webhook_config: webhook_config || null,
      trial_started,
      trial_period,
      customer_type_config: customerTypeConfig,
    });
  } catch (error) {
    logger.error('Login error', {
      franchise_id,
      store_id,
      error: error.message,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/login/config', async (req, res) => {
  return res.json({
    two_step_verification: TWO_STEP_VERIFICATION_ENABLED,
  });
});

router.get('/login/options', async (req, res) => {
  const storeId = (req.query?.store_id || '').toString().trim();
  if (!storeId) {
    return res.status(400).json({ error: 'store_id is required.' });
  }
  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      ProjectionExpression: 'store_id',
    });
    const result = await docClient.send(command);
    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    return res.json({
      store_id: storeId,
      login_method: DEFAULT_LOGIN_METHOD,
    });
  } catch (error) {
    logger.error('Failed to load login options', { store_id: storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to load login options.' });
  }
});

router.post('/login/send-otp', async (req, res) => {
  const { store_id } = req.body || {};
  if (!store_id || typeof store_id !== 'string') {
    return res.status(400).json({ error: 'store_id is required.' });
  }
  if (!SMS_TOKEN) {
    return res.status(500).json({ error: 'SMS service is not configured.' });
  }
  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id },
    });
    const result = await docClient.send(command);
    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    const phone = resolveStorePhone(result.Item);
    if (!phone || phone.length !== 10) {
      return res.status(400).json({ error: 'Registered phone number is missing or invalid.' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpKey = createOtpKey({ storeId: store_id, context: 'login' });
    saveOtp(otpKey, otp);

    await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        route: 'dlt',
        sender_id: SMS_SENDER_ID,
        message: SMS_TEMPLATE_ID,
        language: 'english',
        numbers: phone,
        variables_values: `${otp}|Billbox Login OTP`,
      },
      {
        headers: {
          authorization: SMS_TOKEN,
        },
      }
    );

    return res.json({
      success: true,
      masked_phone: maskPhone(phone),
    });
  } catch (error) {
    logger.error('Failed to send login OTP', { store_id, error: error.message });
    return res.status(500).json({ error: 'Unable to send login OTP right now.' });
  }
});

router.post('/login/password/send-otp', async (req, res) => {
  if (!TWO_STEP_VERIFICATION_ENABLED) {
    return res.status(400).json({ error: 'Two-step verification is disabled.' });
  }
  const { store_id, password } = req.body || {};
  const storeId = typeof store_id === 'string' ? store_id.trim() : '';
  const trimmedPassword = typeof password === 'string' ? password.trim() : '';

  if (!storeId) {
    return res.status(400).json({ error: 'store_id is required.' });
  }
  if (!trimmedPassword) {
    return res.status(400).json({ error: 'Password is required.' });
  }
  if (!SMS_TOKEN) {
    return res.status(500).json({ error: 'SMS service is not configured.' });
  }

  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      ProjectionExpression:
        'store_id, password, mobile_number, contact_phone, vendor_phone, phone, mobile',
    });
    const result = await docClient.send(command);

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }

    if (!result.Item.password) {
      return res
        .status(400)
        .json({ error: 'Password not set for this store. Use Forgot Password to set one.' });
    }

    if (String(result.Item.password).trim() !== trimmedPassword) {
      return res.status(401).json({ error: 'Invalid password.' });
    }

    let phone = result.Item.mobile_number
      ? String(result.Item.mobile_number).replace(/\D/g, '')
      : '';
    if (!phone || phone.length !== 10) {
      phone = resolveStorePhone(result.Item);
    }

    if (!phone || phone.length !== 10) {
      return res.status(400).json({ error: 'Registered phone number is missing or invalid.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpKey = createOtpKey({ storeId, context: 'login_pw' });
    saveOtp(otpKey, otp);

    await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        route: 'dlt',
        sender_id: SMS_SENDER_ID,
        message: SMS_TEMPLATE_ID,
        language: 'english',
        numbers: phone,
        variables_values: `${otp}|Billbox Login OTP`,
      },
      {
        headers: {
          authorization: SMS_TOKEN,
        },
      }
    );

    return res.json({
      success: true,
      masked_phone: maskPhone(phone),
    });
  } catch (error) {
    logger.error('Failed to send password login OTP', { store_id: storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to send login OTP right now.' });
  }
});

router.post('/login/password', async (req, res) => {
  if (!TWO_STEP_VERIFICATION_ENABLED) {
    return res.status(400).json({ error: 'Two-step verification is disabled.' });
  }
  const { store_id, otp } = req.body || {};

  if (!store_id) {
    return res.status(400).json({ error: 'store_id is required' });
  }
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({ error: 'Valid 6-digit OTP is required to log in.' });
  }

  try {
    logger.info('Password+OTP login attempt', { store_id });

    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: {
        store_id: store_id,
      },
    });

    const result = await docClient.send(command);

    if (!result.Item) {
      logger.warn('Store not found during login', { store_id });
      return res
        .status(404)
        .json({ error: 'Store not found. Please sign up to create an account.' });
    }

    const otpKey = createOtpKey({ storeId: store_id, context: 'login_pw' });
    const verified = consumeOtp(otpKey, otp.trim());
    if (!verified) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    const whatsappConfig = result.Item || {};
    const {
      whatsapp_api_url,
      access_token,
      waba_id,
      phone_number_id,
      waba_mobile_number,
      template_name,
      template_language,
      vendor_name,
      verified_name,
      store_name,
      webhook_config,
    } = whatsappConfig;
    const storeTrialStarted = whatsappConfig.trial_started ?? whatsappConfig.trail_started ?? null;
    const storeTrialPeriod = whatsappConfig.trial_period ?? null;

    const franchise_id = result.Item.franchise_id || null;
    const franchiseTrial = await resolveFranchiseTrial(franchise_id);
    const trial_started = franchiseTrial?.trial_started ?? storeTrialStarted;
    const trial_period = franchiseTrial?.trial_period ?? storeTrialPeriod;
    const rawSessionVersion = result.Item.session_version;
    const session_version = Number.isFinite(Number(rawSessionVersion))
      ? Number(rawSessionVersion)
      : null;
    const token = jwt.sign(
      {
        franchise_id,
        store_id,
        session_version,
        iat: Math.floor(Date.now() / 1000),
      },
      JWT_SECRET,
      { expiresIn: '3d' }
    );

    logger.info('Login successful', { store_id });

    const customerTypeConfig = sanitizeCustomerTypeConfig(
      result.Item.customer_type_config || DEFAULT_CUSTOMER_TYPE_CONFIG
    );

    appendAuditEntry(store_id, req).catch((err) => {
      logger.warn('Failed to append audit history', {
        store_id,
        error: err.message,
      });
    });

    res.json({
      token,
      store_id,
      franchise_id,
      whatsapp_api_url,
      access_token,
      waba_id: waba_id || null,
      phone_number_id: phone_number_id || null,
      waba_mobile_number: waba_mobile_number || null,
      template_name: template_name || null,
      template_language: template_language || null,
      vendor_name: vendor_name || null,
      verified_name: verified_name || null,
      store_name: store_name || null,
      webhook_config: webhook_config || null,
      trial_started,
      trial_period,
      customer_type_config: customerTypeConfig,
    });
  } catch (error) {
    logger.error('Password+OTP login error', {
      store_id,
      error: error.message,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login/password-only', async (req, res) => {
  if (TWO_STEP_VERIFICATION_ENABLED) {
    return res.status(400).json({ error: 'Password-only login is disabled.' });
  }

  const { store_id, password } = req.body || {};

  const storeId = typeof store_id === 'string' ? store_id.trim() : '';
  const trimmedPassword = typeof password === 'string' ? password.trim() : '';

  if (!storeId) {
    return res.status(400).json({ error: 'store_id is required.' });
  }
  if (!trimmedPassword) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
    });

    const result = await docClient.send(command);

    if (!result.Item) {
      return res
        .status(404)
        .json({ error: 'Store not found. Please sign up to create an account.' });
    }

    if (!result.Item.password) {
      return res
        .status(400)
        .json({ error: 'Password not set for this store. Use Reset with OTP to set one.' });
    }

    if (String(result.Item.password).trim() !== trimmedPassword) {
      return res.status(401).json({ error: 'Invalid password.' });
    }

    const whatsappConfig = result.Item || {};
    const {
      whatsapp_api_url,
      access_token,
      waba_id,
      phone_number_id,
      waba_mobile_number,
      template_name,
      template_language,
      vendor_name,
      verified_name,
      store_name,
      webhook_config,
    } = whatsappConfig;
    const storeTrialStarted = whatsappConfig.trial_started ?? whatsappConfig.trail_started ?? null;
    const storeTrialPeriod = whatsappConfig.trial_period ?? null;

    const franchise_id = result.Item.franchise_id || null;
    const franchiseTrial = await resolveFranchiseTrial(franchise_id);
    const trial_started = franchiseTrial?.trial_started ?? storeTrialStarted;
    const trial_period = franchiseTrial?.trial_period ?? storeTrialPeriod;
    const rawSessionVersion = result.Item.session_version;
    const session_version = Number.isFinite(Number(rawSessionVersion))
      ? Number(rawSessionVersion)
      : null;

    const token = jwt.sign(
      {
        franchise_id,
        store_id: storeId,
        session_version,
        iat: Math.floor(Date.now() / 1000),
      },
      JWT_SECRET,
      { expiresIn: '3d' }
    );

    const customerTypeConfig = sanitizeCustomerTypeConfig(
      result.Item.customer_type_config || DEFAULT_CUSTOMER_TYPE_CONFIG
    );

    appendAuditEntry(storeId, req).catch((err) => {
      logger.warn('Failed to append audit history', {
        store_id: storeId,
        error: err.message,
      });
    });

    return res.json({
      token,
      store_id: storeId,
      franchise_id,
      whatsapp_api_url,
      access_token,
      waba_id: waba_id || null,
      phone_number_id: phone_number_id || null,
      waba_mobile_number: waba_mobile_number || null,
      template_name: template_name || null,
      template_language: template_language || null,
      vendor_name: vendor_name || null,
      verified_name: verified_name || null,
      store_name: store_name || null,
      webhook_config: webhook_config || null,
      trial_started,
      trial_period,
      customer_type_config: customerTypeConfig,
    });
  } catch (error) {
    logger.error('Password-only login error', { store_id: storeId, error: error.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/profile', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
    });
    const result = await docClient.send(command);

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }

    const store = result.Item;
    res.json({
      store_id: store.store_id,
      franchise_id: store.franchise_id || null,
      store_name: store.store_name || null,
      brand_name: store.brand_name || null,
      business_type: store.business_type || null,
      contact_email: store.contact_email || null,
      contact_phone: resolveStorePhone(store),
      vendor_name: store.vendor_name || null,
      verified_name: store.verified_name || null,
      waba_mobile_number: store.waba_mobile_number || null,
      template_name: store.template_name || null,
      template_language: store.template_language || null,
      onboarding_status: store.onboarding_status || null,
      created_at: store.created_at || null,
      updated_at: store.updated_at || null,
      whatsapp_api_url: store.whatsapp_api_url || null,
      street_name: store.street_name || null,
      smart_img_urls: Array.isArray(store.smart_img_urls) ? store.smart_img_urls : [],
      smart_header_text: typeof store.smart_header_text === 'string' ? store.smart_header_text : '',
      smart_footer_text: typeof store.smart_footer_text === 'string' ? store.smart_footer_text : '',
      smart_address_text:
        typeof store.smart_address_text === 'string' ? store.smart_address_text : '',
      smart_header_images: Array.isArray(store.smart_header_images)
        ? store.smart_header_images
        : [],
      smart_bottom_banner:
        typeof store.smart_bottom_banner === 'string' ? store.smart_bottom_banner : null,
      audit_history: Array.isArray(store.audit_history) ? store.audit_history.slice(0, 10) : [],
    });
  } catch (error) {
    logger.error('Failed to load store profile', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to load store profile.' });
  }
});

router.post('/profile/smart-ebill/upload', smartEbillUploadMiddleware, async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }
  if (!STORE_CONFIG_TABLE || !s3Client || !SMART_EBILL_S3_BUCKET) {
    return res.status(500).json({ error: 'Smart E-bill storage is not configured.' });
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'Select at least one image to upload.' });
  }

  try {
    const uploadedUrls = [];
    for (const file of files) {
      const key = buildSmartEbillKey(storeId, file?.originalname);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: SMART_EBILL_S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file?.mimetype || 'application/octet-stream',
        })
      );
      uploadedUrls.push(buildSmartEbillUrl(key));
    }

    const now = new Date().toISOString();
    const updateCommand = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression:
        'SET smart_img_urls = list_append(if_not_exists(smart_img_urls, :empty), :newUrls), updated_at = :updated',
      ExpressionAttributeValues: {
        ':empty': [],
        ':newUrls': uploadedUrls,
        ':updated': now,
      },
      ReturnValues: 'ALL_NEW',
    });
    const result = await docClient.send(updateCommand);
    const finalImages = Array.isArray(result.Attributes?.smart_img_urls)
      ? result.Attributes.smart_img_urls
      : uploadedUrls;

    return res.json({ success: true, images: finalImages });
  } catch (error) {
    logger.error('Failed to upload Smart E-bill assets', {
      store_id: storeId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to upload Smart E-bill assets.' });
  }
});

router.patch('/profile/smart-ebill', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  const headerTextProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'headerText');
  const footerTextProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'footerText');
  const addressTextProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'addressText');
  const imagesProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'images');
  const headerImagesProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'headerImages');
  const bottomBannerProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'bottomBanner');

  const updateFragments = [];
  const expressionValues = { ':updated': new Date().toISOString() };

  if (headerTextProvided) {
    updateFragments.push('smart_header_text = :header');
    expressionValues[':header'] = sanitizeSmartText(req.body?.headerText || '');
  }

  if (footerTextProvided) {
    updateFragments.push('smart_footer_text = :footer');
    expressionValues[':footer'] = sanitizeSmartText(req.body?.footerText || '');
  }

  if (addressTextProvided) {
    updateFragments.push('smart_address_text = :address');
    expressionValues[':address'] = sanitizeSmartText(req.body?.addressText || '');
  }

  if (imagesProvided) {
    const candidateImages = Array.isArray(req.body?.images) ? req.body.images : [];
    const sanitized = candidateImages
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    updateFragments.push('smart_img_urls = :images');
    expressionValues[':images'] = sanitized;
  }

  if (headerImagesProvided) {
    const candidateHeaders = Array.isArray(req.body?.headerImages) ? req.body.headerImages : [];
    const sanitized = candidateHeaders
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    updateFragments.push('smart_header_images = :headerImages');
    expressionValues[':headerImages'] = sanitized;
  }

  if (bottomBannerProvided) {
    const bannerValue =
      typeof req.body?.bottomBanner === 'string' ? req.body.bottomBanner.trim() : '';
    updateFragments.push('smart_bottom_banner = :bottomBanner');
    expressionValues[':bottomBanner'] = bannerValue || null;
  }

  if (updateFragments.length === 0) {
    return res.status(400).json({
      error:
        'Provide headerText, footerText, addressText, images, headerImages, or bottomBanner to update.',
    });
  }

  const updateCommand = new UpdateCommand({
    TableName: STORE_CONFIG_TABLE,
    Key: { store_id: storeId },
    UpdateExpression: `SET ${updateFragments.join(', ')}, updated_at = :updated`,
    ExpressionAttributeValues: expressionValues,
    ReturnValues: 'ALL_NEW',
  });

  try {
    const result = await docClient.send(updateCommand);
    return res.json({
      success: true,
      smart_img_urls: Array.isArray(result.Attributes?.smart_img_urls)
        ? result.Attributes.smart_img_urls
        : [],
      smart_header_text:
        typeof result.Attributes?.smart_header_text === 'string'
          ? result.Attributes.smart_header_text
          : '',
      smart_footer_text:
        typeof result.Attributes?.smart_footer_text === 'string'
          ? result.Attributes.smart_footer_text
          : '',
      smart_address_text:
        typeof result.Attributes?.smart_address_text === 'string'
          ? result.Attributes.smart_address_text
          : '',
      smart_header_images: Array.isArray(result.Attributes?.smart_header_images)
        ? result.Attributes.smart_header_images
        : [],
      smart_bottom_banner:
        typeof result.Attributes?.smart_bottom_banner === 'string'
          ? result.Attributes.smart_bottom_banner
          : null,
    });
  } catch (error) {
    logger.error('Failed to update Smart E-bill settings', {
      store_id: storeId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to update Smart E-bill settings.' });
  }
});

router.get('/profile/audit-history', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      ProjectionExpression: 'store_id, audit_history',
    });
    const result = await docClient.send(command);

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }

    const history = Array.isArray(result.Item.audit_history) ? result.Item.audit_history : [];
    res.json({
      store_id: storeId,
      audit_history: history.slice(0, 10),
    });
  } catch (error) {
    logger.error('Failed to load store audit history', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to load audit history.' });
  }
});

router.get('/revenue-pin/status', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  try {
    const currentPin = await fetchStoreRevenuePin(storeId);
    res.json({
      has_pin: Boolean(currentPin?.pin),
      updated_at: currentPin?.updatedAt || null,
    });
  } catch (error) {
    logger.error('Failed to load revenue PIN status', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to load PIN status.' });
  }
});

router.post('/revenue-pin', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  const pin = sanitizePin(req.body?.pin);
  const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
  if (!pin) {
    return res.status(400).json({ error: 'PIN must be 4-6 numeric digits.' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Password is required to create a PIN.' });
  }

  try {
    const fetchCommand = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      ProjectionExpression: 'revenue_pin, password',
    });
    const result = await docClient.send(fetchCommand);

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }

    if (result.Item.revenue_pin) {
      return res
        .status(409)
        .json({ error: 'PIN already set. Use the update endpoint to change it.' });
    }

    if (!result.Item.password || result.Item.password !== password) {
      return res.status(401).json({ error: 'Password verification failed.' });
    }

    const now = new Date().toISOString();
    const updateCommand = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression: 'SET revenue_pin = :pin, revenue_pin_updated_at = :updated',
      ExpressionAttributeValues: {
        ':pin': pin,
        ':updated': now,
      },
      ReturnValues: 'NONE',
    });
    await docClient.send(updateCommand);
    res.status(201).json({ success: true, updated_at: now });
  } catch (error) {
    logger.error('Failed to create revenue PIN', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to save PIN at this time.' });
  }
});

router.patch('/revenue-pin', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  const currentPin = sanitizePin(req.body?.currentPin);
  const newPin = sanitizePin(req.body?.newPin);
  const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';

  if (!currentPin || !newPin) {
    return res.status(400).json({ error: 'Both current and new PINs must be 4-6 digits.' });
  }

  if (currentPin === newPin) {
    return res.status(400).json({ error: 'New PIN must be different from the current PIN.' });
  }

  if (!password) {
    return res.status(400).json({ error: 'Password is required to update the PIN.' });
  }

  try {
    const fetchCommand = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      ProjectionExpression: 'password',
    });
    const result = await docClient.send(fetchCommand);

    if (!result.Item?.password || result.Item.password !== password) {
      return res.status(401).json({ error: 'Password verification failed.' });
    }
    const now = new Date().toISOString();
    const command = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression: 'SET revenue_pin = :newPin, revenue_pin_updated_at = :updated',
      ConditionExpression: 'attribute_exists(revenue_pin) AND revenue_pin = :current',
      ExpressionAttributeValues: {
        ':newPin': newPin,
        ':updated': now,
        ':current': currentPin,
      },
      ReturnValues: 'NONE',
    });
    await docClient.send(command);
    res.json({ success: true, updated_at: now });
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return res.status(400).json({ error: 'Current PIN is incorrect or not set yet.' });
    }
    logger.error('Failed to update revenue PIN', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to update PIN at this time.' });
  }
});

router.post('/revenue-pin/reset', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  const newPin = sanitizePin(req.body?.newPin || req.body?.pin);
  const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';

  if (!newPin) {
    return res.status(400).json({ error: 'New PIN must be 4-6 numeric digits.' });
  }

  if (!password) {
    return res.status(400).json({ error: 'Password is required to reset the PIN.' });
  }

  try {
    const fetchCommand = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      ProjectionExpression: 'password, revenue_pin',
    });
    const result = await docClient.send(fetchCommand);

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }

    if (!result.Item.revenue_pin) {
      return res.status(404).json({ error: 'Revenue PIN is not set yet. Create one first.' });
    }

    if (!result.Item.password || result.Item.password !== password) {
      return res.status(401).json({ error: 'Password verification failed.' });
    }

    const now = new Date().toISOString();
    const command = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression: 'SET revenue_pin = :newPin, revenue_pin_updated_at = :updated',
      ConditionExpression: 'attribute_exists(revenue_pin)',
      ExpressionAttributeValues: {
        ':newPin': newPin,
        ':updated': now,
      },
      ReturnValues: 'NONE',
    });
    await docClient.send(command);
    return res.json({ success: true, updated_at: now });
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return res.status(404).json({ error: 'Revenue PIN is not set yet. Create one first.' });
    }
    logger.error('Failed to reset revenue PIN', { store_id: storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to reset PIN at this time.' });
  }
});

router.post('/revenue-pin/verify', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  const pin = sanitizePin(req.body?.pin);
  if (!pin) {
    return res.status(400).json({ error: 'PIN must be 4-6 numeric digits.' });
  }

  try {
    const existing = await fetchStoreRevenuePin(storeId);
    if (!existing?.pin) {
      return res.status(404).json({ error: 'Revenue PIN not set for this store.' });
    }

    if (pin !== existing.pin) {
      return res.status(401).json({ error: 'Invalid PIN provided.' });
    }

    return res.json({ success: true, updated_at: existing.updatedAt || null });
  } catch (error) {
    logger.error('Failed to verify revenue PIN', { store_id: storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to verify PIN at this time.' });
  }
});

router.patch('/profile/street-name', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  const { streetName } = req.body || {};
  if (typeof streetName !== 'string') {
    return res.status(400).json({ error: 'Street name must be a string.' });
  }

  const trimmed = streetName.trim();
  if (trimmed.length === 0) {
    return res.status(400).json({ error: 'Street name cannot be empty.' });
  }
  if (trimmed.length > 150) {
    return res.status(400).json({ error: 'Street name must be 150 characters or fewer.' });
  }

  try {
    const now = new Date().toISOString();
    const command = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression: 'SET street_name = :street, updated_at = :updated',
      ExpressionAttributeValues: {
        ':street': trimmed,
        ':updated': now,
      },
      ReturnValues: 'ALL_NEW',
    });
    const result = await docClient.send(command);
    res.json({
      street_name: result.Attributes?.street_name || trimmed,
      updated_at: result.Attributes?.updated_at || now,
    });
  } catch (error) {
    logger.error('Failed to update street name', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to update street name.' });
  }
});

router.patch('/profile/store-name', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not defined.' });
  }

  const { storeName } = req.body || {};
  if (typeof storeName !== 'string') {
    return res.status(400).json({ error: 'Store name must be a string.' });
  }

  const trimmed = storeName.trim();
  if (trimmed.length === 0) {
    return res.status(400).json({ error: 'Store name cannot be empty.' });
  }
  if (trimmed.length > 150) {
    return res.status(400).json({ error: 'Store name must be 150 characters or fewer.' });
  }

  try {
    const now = new Date().toISOString();
    const command = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression: 'SET store_name = :storeName, updated_at = :updated',
      ExpressionAttributeValues: {
        ':storeName': trimmed,
        ':updated': now,
      },
      ReturnValues: 'ALL_NEW',
    });
    const result = await docClient.send(command);
    res.json({
      store_name: result.Attributes?.store_name || trimmed,
      updated_at: result.Attributes?.updated_at || now,
    });
  } catch (error) {
    logger.error('Failed to update store name', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to update store name.' });
  }
});

const STORE_ID_BASE = Number(process.env.STORE_ID_BASE || '171000');

async function generateNextStoreId() {
  let lastEvaluatedKey;
  let maxId = STORE_ID_BASE - 1;

  do {
    const command = new ScanCommand({
      TableName: STORE_CONFIG_TABLE,
      ProjectionExpression: 'store_id',
      ExclusiveStartKey: lastEvaluatedKey,
    });

    const result = await docClient.send(command);
    (result.Items || []).forEach((item) => {
      const numericId = Number(item.store_id);
      if (Number.isFinite(numericId) && numericId > maxId) {
        maxId = numericId;
      }
    });
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const nextId = Math.max(maxId + 1, STORE_ID_BASE);
  return String(nextId).padStart(6, '0');
}

router.post('/signup', async (req, res) => {
  const { fullName, storeName, streetName, brandName, businessType, email, phone, password } =
    req.body || {};

  if (!LEAD_SIGNUPS_TABLE) {
    return res.status(500).json({ error: 'Lead signup table is not configured.' });
  }

  if (!fullName || !email || !phone || !password) {
    return res.status(400).json({ error: 'fullName, email, phone, and password are required' });
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone.trim();
    const normalizedPhoneDigits = normalizePhoneDigits(normalizedPhone);
    const normalizedStoreName = typeof storeName === 'string' ? storeName.trim() : '';
    const normalizedStreetName = typeof streetName === 'string' ? streetName.trim() : '';
    const normalizedBrandName = (brandName || '').trim() || normalizedStoreName;
    const normalizedBusinessType = typeof businessType === 'string' ? businessType.trim() : '';

    // Ensure email or phone is not already registered
    const duplicateCheck = await docClient.send(
      new ScanCommand({
        TableName: STORE_CONFIG_TABLE,
        FilterExpression: 'contact_email = :email OR contact_phone = :phone',
        ExpressionAttributeValues: {
          ':email': normalizedEmail,
          ':phone': normalizedPhone,
        },
        ProjectionExpression: 'store_id',
        Limit: 1,
      })
    );

    if (duplicateCheck.Items && duplicateCheck.Items.length > 0) {
      return res.status(409).json({
        error: 'An account with this email or phone already exists.',
      });
    }

    const leadDuplicateCheck = await docClient.send(
      new ScanCommand({
        TableName: LEAD_SIGNUPS_TABLE,
        FilterExpression: 'email = :email OR phone = :phone',
        ExpressionAttributeValues: {
          ':email': normalizedEmail,
          ':phone': normalizedPhone,
        },
        ProjectionExpression: 'lead_id',
        Limit: 1,
      })
    );

    if (leadDuplicateCheck.Items && leadDuplicateCheck.Items.length > 0) {
      return res.status(409).json({
        error: 'A signup with this email or phone already exists.',
      });
    }

    // Ensure mobile number is unique across all known phone fields
    if (await isPhoneNumberRegistered(normalizedPhoneDigits)) {
      return res.status(409).json({
        error: 'This mobile number is already registered. Please enter a different number.',
      });
    }

    if (!normalizedStoreName) {
      return res.status(400).json({ error: 'Store name is required.' });
    }
    if (/[^a-zA-Z0-9\s]/.test(normalizedStoreName)) {
      return res.status(400).json({ error: 'Store name contains invalid characters.' });
    }
    if (!normalizedStreetName) {
      return res.status(400).json({ error: 'Street name is required.' });
    }
    const now = new Date().toISOString();
    const leadId = crypto.randomUUID();

    const leadItem = {
      lead_id: leadId,
      created_at: now,
      full_name: fullName.trim(),
      store_name: normalizedStoreName || `${fullName.trim()}'s Store`,
      street_name: normalizedStreetName || null,
      brand_name: normalizedBrandName || null,
      business_type: normalizedBusinessType || null,
      email: normalizedEmail,
      phone: normalizedPhone,
      phone_digits: normalizedPhoneDigits || null,
      password,
      status: 'new',
      source: 'signup',
      updated_at: now,
    };

    await docClient.send(
      new PutCommand({
        TableName: LEAD_SIGNUPS_TABLE,
        Item: leadItem,
        ConditionExpression: 'attribute_not_exists(lead_id)',
      })
    );

    logger.info('Lead signup captured', { lead_id: leadId, email: normalizedEmail });
    return res.status(201).json({
      success: true,
      lead_id: leadId,
    });
  } catch (error) {
    logger.error('Signup error', { error: error.message });
    return res.status(500).json({ error: 'Unable to complete signup. Please try again.' });
  }
});

router.post('/send-otp', async (req, res) => {
  const { store_id, phone, franchise_id, purpose } = req.body || {};

  const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
  const normalizedDigits = normalizePhoneDigits(normalizedPhone);
  const normalizedFranchiseId = typeof franchise_id === 'string' ? franchise_id.trim() : '';
  const normalizedPurpose = typeof purpose === 'string' ? purpose.trim() : '';

  const isFranchiseFlow = Boolean(normalizedFranchiseId);
  const isFranchiseReset = isFranchiseFlow && normalizedPurpose === 'franchise_reset';
  const isFranchiseVerify = isFranchiseFlow && normalizedPurpose === 'franchise_verify';
  const canonicalFranchiseKey = normalizedFranchiseId ? normalizedFranchiseId.toLowerCase() : '';

  if (!isFranchiseFlow && (!normalizedDigits || normalizedDigits.length !== 10)) {
    return res.status(400).json({ error: 'Valid 10-digit phone number is required.' });
  }
  if (!SMS_TOKEN) {
    return res.status(500).json({ error: 'SMS service is not configured.' });
  }

  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  let destinationPhone = normalizedDigits;
  let otpKey = createOtpKey({ phone: normalizedPhone, context: 'signup' });

  try {
    if (store_id) {
      const storeResult = await docClient.send(
        new GetCommand({
          TableName: STORE_CONFIG_TABLE,
          Key: { store_id },
        })
      );

      if (!storeResult.Item) {
        return res
          .status(404)
          .json({ error: 'Store not found. Please sign up to create an account.' });
      }

      const storedPhone = resolveStorePhone(storeResult.Item);
      if (!storedPhone || storedPhone.length !== 10) {
        return res.status(400).json({
          error: 'Registered phone number is missing or invalid. Please contact support.',
        });
      }

      if (storedPhone !== normalizedDigits) {
        return res.status(400).json({ error: 'Phone number does not match our records.' });
      }

      destinationPhone = storedPhone;
      otpKey = createOtpKey({ storeId: store_id, context: 'reset' });
    } else if (!isFranchiseReset) {
      const alreadyRegistered = await isPhoneNumberRegistered(normalizedDigits);
      if (alreadyRegistered) {
        return res.status(409).json({
          error: 'This mobile number is already registered. Please enter a different number.',
        });
      }
    }

    if (isFranchiseFlow) {
      const ownerContact = await getFranchiseOwnerContact(normalizedFranchiseId);
      if (!ownerContact?.phone) {
        return res
          .status(404)
          .json({ error: 'Franchise owner contact not found. Please verify the Franchise ID.' });
      }
      destinationPhone = ownerContact.phone;
      const resolvedFranchiseKey =
        typeof ownerContact.franchiseId === 'string'
          ? ownerContact.franchiseId.trim().toLowerCase()
          : canonicalFranchiseKey;
      const franchiseContext = isFranchiseReset
        ? 'franchise_reset'
        : isFranchiseVerify
          ? 'franchise_verify'
          : 'franchise_signup';
      otpKey = createOtpKey({
        storeId: resolvedFranchiseKey || canonicalFranchiseKey || normalizedFranchiseId,
        context: franchiseContext,
      });
    } else if (!store_id) {
      destinationPhone = normalizedDigits;
      otpKey = createOtpKey({ phone: normalizedPhone, context: 'signup' });
    }

    saveOtp(otpKey, otp);

    await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        route: 'dlt',
        sender_id: SMS_SENDER_ID,
        message: SMS_TEMPLATE_ID,
        variables_values: otp,
        flash: 0,
        numbers: destinationPhone,
      },
      {
        headers: {
          authorization: SMS_TOKEN,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    return res.status(200).json({ success: true, masked_phone: maskPhone(destinationPhone) });
  } catch (error) {
    logger.error('Failed to send OTP', {
      store_id,
      franchise_id: normalizedFranchiseId,
      status: error.response?.status,
      message: error.response?.data || error.message,
    });
    return res.status(500).json({
      error: 'Unable to send OTP. Please check whether given phone number is correct!',
    });
  }
});

router.post('/reset-password', async (req, res) => {
  const { store_id, phone, password, otp } = req.body || {};
  if (!store_id || !phone || !password || !otp) {
    return res.status(400).json({ error: 'store_id, phone, password, and otp are required.' });
  }

  try {
    const storeCommand = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id },
    });
    const result = await docClient.send(storeCommand);
    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }

    const storedPhone = resolveStorePhone(result.Item) || null;

    if (!storedPhone || storedPhone !== phone.trim()) {
      return res.status(400).json({ error: 'Phone number does not match our records.' });
    }

    const resetOtpKey = createOtpKey({ storeId: store_id, context: 'reset' });
    if (!consumeOtp(resetOtpKey, otp)) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
    }

    await docClient.send(
      new PutCommand({
        TableName: STORE_CONFIG_TABLE,
        Item: {
          ...result.Item,
          password,
          updated_at: new Date().toISOString(),
        },
      })
    );

    logger.info('Password reset successful', { store_id });
    return res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error resetting password', { store_id, error: error.message });
    return res.status(500).json({ error: 'Unable to reset password. Please try again.' });
  }
});

router.post('/franchise/reset-password', async (req, res) => {
  const { franchise_id: franchiseId, password, otp } = req.body || {};

  if (!franchiseId || !password || !otp) {
    return res.status(400).json({
      error: 'franchise_id, password, and otp are required to reset the franchise password.',
    });
  }

  const normalizedFranchiseId = franchiseId.trim();
  const canonicalFranchiseKey = normalizedFranchiseId.toLowerCase();
  const franchiseOtpKey = createOtpKey({
    storeId: canonicalFranchiseKey || normalizedFranchiseId,
    context: 'franchise_reset',
  });

  if (!consumeOtp(franchiseOtpKey, otp)) {
    return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
  }

  try {
    const stores = await listStoresForFranchise(normalizedFranchiseId);
    if (!stores.length) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }

    const timestamp = new Date().toISOString();
    await Promise.all(
      stores.map((store) =>
        docClient.send(
          new UpdateCommand({
            TableName: STORE_CONFIG_TABLE,
            Key: { store_id: store.store_id },
            UpdateExpression: 'SET franchise_password = :password, updated_at = :updatedAt',
            ExpressionAttributeValues: {
              ':password': password,
              ':updatedAt': timestamp,
            },
          })
        )
      )
    );

    return res.json({
      success: true,
      franchise_id: stores[0].franchise_id,
      store_count: stores.length,
      updated_at: timestamp,
    });
  } catch (error) {
    logger.error('Franchise password reset failed', {
      franchise_id: normalizedFranchiseId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to reset franchise password. Please try again.' });
  }
});

router.post('/franchise/verify', async (req, res) => {
  const { franchise_id: franchiseId, otp } = req.body || {};

  if (!franchiseId || !otp) {
    return res.status(400).json({ error: 'franchise_id and otp are required.' });
  }

  const normalizedFranchiseId = franchiseId.trim();
  const canonicalFranchiseKey = normalizedFranchiseId.toLowerCase();
  const otpValue = otp.trim();
  const otpCandidates = Array.from(
    new Set(
      [canonicalFranchiseKey, normalizedFranchiseId]
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    )
  );

  let otpValid = false;
  for (const candidateKey of otpCandidates) {
    const verifyOtpKey = createOtpKey({ storeId: candidateKey, context: 'franchise_verify' });
    if (consumeOtp(verifyOtpKey, otpValue)) {
      otpValid = true;
      break;
    }
  }

  if (!otpValid) {
    return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new one.' });
  }

  try {
    const matched = await findFranchiseByIds([normalizedFranchiseId, canonicalFranchiseKey]);
    if (!matched) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }

    return res.json({
      success: true,
      franchise_id: matched.franchise_id,
      brand_name: matched.brand_name || '',
      business_type: matched.business_type || '',
    });
  } catch (error) {
    logger.error('Franchise verification lookup failed', {
      franchise_id: normalizedFranchiseId,
      error: error.message,
    });
    return res
      .status(500)
      .json({ error: 'Unable to verify franchise at this time. Please try again.' });
  }
});

module.exports = router;
