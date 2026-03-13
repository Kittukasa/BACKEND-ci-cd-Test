const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const { logger } = require('../config/logger');
const {
  collectFranchiseStores,
  collectFranchiseStoreIds,
  getStoreDailyStats,
} = require('../services/franchiseService');
const billingService = require('../services/billingService');
const crypto = require('crypto');
const { docClient } = require('../config/dynamodb');
const { GetCommand, UpdateCommand, QueryCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
  sanitizeCustomerTypeConfig,
  DEFAULT_CUSTOMER_TYPE_CONFIG,
} = require('../utils/customerTypes');

const router = express.Router();
const STORE_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;
const FRANCHISES_TABLE = process.env.FRANCHISES_TABLE;
const JWT_SECRET = process.env.JWT_SECRET;
const FRANCHISE_JWT_SECRET = process.env.FRANCHISE_JWT_SECRET || process.env.JWT_SECRET;
const FRANCHISE_TOKEN_TTL = process.env.FRANCHISE_TOKEN_TTL || '3d';
const WALLET_TABLE = process.env.FRANCHISE_WALLET_TABLE || null;
const WALLET_EVENTS_TABLE = process.env.WALLET_EVENTS_TABLE || null;
const WALLET_PAYMENTS_TABLE = process.env.WALLET_PAYMENTS_TABLE || 'Wallet_Payments';
const WALLET_EVENTS_SORT_KEY = process.env.WALLET_EVENTS_SORT_KEY || 'timestamp#event_id';
const DEFAULT_WALLET_STORE_ID = 'ALL';
const DEFAULT_WALLET_CURRENCY = 'INR';
const FRANCHISE_DOCS_BUCKET = process.env.FRANCHISE_DOCS_BUCKET || 'billbox-frontend';
const FRANCHISE_DOCS_PREFIX = process.env.FRANCHISE_DOCS_PREFIX || 'franchise_documents/';
const SMART_EBILL_S3_BUCKET = process.env.SMART_EBILL_S3_BUCKET || 'billbox-frontend';
const SMART_EBILL_S3_PREFIX = (() => {
  const raw = process.env.SMART_EBILL_S3_PREFIX || 'Smart-e-bill-images/';
  const normalized = raw.replace(/^\/+/, '').replace(/\\/g, '/');
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
})();
const SMART_EBILL_MAX_IMAGES = Number(process.env.SMART_EBILL_MAX_IMAGES || 10);
const SMART_EBILL_MAX_FILE_SIZE = Number(process.env.SMART_EBILL_MAX_FILE_SIZE || 5 * 1024 * 1024);
const AWS_REGION = process.env.AWS_REGION || 'ap-south-2';
const SMS_TOKEN = process.env.SMS_TOKEN;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID || 'BBXSMS';
const FRANCHISE_LOGIN_SMS_TEMPLATE_ID =
  process.env.FRANCHISE_LOGIN_SMS_TEMPLATE_ID || process.env.SMS_TEMPLATE_ID || '199010';
const FRANCHISE_LOGIN_OTP_TTL_MS = Number(
  process.env.FRANCHISE_LOGIN_OTP_TTL_MS || process.env.OTP_TTL_MS || 5 * 60 * 1000
);
const TWO_STEP_VERIFICATION_ENABLED = process.env.TWO_STEP_VERIFICATION !== 'false';
const franchiseOtpStore = new Map();
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

logger.info('Wallet payments table config', {
  table: WALLET_PAYMENTS_TABLE,
  region: process.env.AWS_REGION || null,
});

const s3Client = new S3Client({ region: AWS_REGION });
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

const buildSmartEbillKey = (franchiseId, originalName = 'image.jpg') => {
  const safeName =
    typeof originalName === 'string' ? originalName.replace(/[^a-zA-Z0-9.\-]/g, '') : 'upload.jpg';
  const extension = path.extname(safeName) || '.jpg';
  const randomSegment = crypto.randomBytes(8).toString('hex');
  return `${SMART_EBILL_S3_PREFIX}${franchiseId}/${Date.now()}-${randomSegment}${extension}`;
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

const buildSmartEbillPayload = (item) => ({
  smart_img_urls: Array.isArray(item?.smart_img_urls) ? item.smart_img_urls : [],
  smart_header_text: typeof item?.smart_header_text === 'string' ? item.smart_header_text : '',
  smart_footer_text: typeof item?.smart_footer_text === 'string' ? item.smart_footer_text : '',
  smart_address_text: typeof item?.smart_address_text === 'string' ? item.smart_address_text : '',
  smart_header_images: Array.isArray(item?.smart_header_images) ? item.smart_header_images : [],
  smart_bottom_banner:
    typeof item?.smart_bottom_banner === 'string' ? item.smart_bottom_banner : null,
});

const appendSmartImagesToStores = async (franchiseId, uploadedUrls = []) => {
  const storeIds = await collectFranchiseStoreIds([franchiseId]);
  if (!storeIds.length || !uploadedUrls.length) {
    return 0;
  }

  const now = new Date().toISOString();
  await Promise.all(
    storeIds.map((storeId) =>
      docClient.send(
        new UpdateCommand({
          TableName: STORE_CONFIG_TABLE,
          Key: { store_id: storeId },
          UpdateExpression:
            'SET smart_img_urls = list_append(if_not_exists(smart_img_urls, :empty), :newUrls), updated_at = :updated',
          ExpressionAttributeValues: {
            ':empty': [],
            ':newUrls': uploadedUrls,
            ':updated': now,
          },
        })
      )
    )
  );

  return storeIds.length;
};

const applySmartEbillConfigToStores = async (franchiseId, config) => {
  const storeIds = await collectFranchiseStoreIds([franchiseId]);
  if (!storeIds.length) {
    return 0;
  }

  const now = new Date().toISOString();
  await Promise.all(
    storeIds.map((storeId) =>
      docClient.send(
        new UpdateCommand({
          TableName: STORE_CONFIG_TABLE,
          Key: { store_id: storeId },
          UpdateExpression:
            'SET smart_img_urls = :images, smart_header_text = :headerText, smart_footer_text = :footerText, smart_address_text = :addressText, smart_header_images = :headerImages, smart_bottom_banner = :bottomBanner, updated_at = :updated',
          ExpressionAttributeValues: {
            ':images': config.smart_img_urls,
            ':headerText': config.smart_header_text,
            ':footerText': config.smart_footer_text,
            ':addressText': config.smart_address_text,
            ':headerImages': config.smart_header_images,
            ':bottomBanner': config.smart_bottom_banner,
            ':updated': now,
          },
        })
      )
    )
  );

  return storeIds.length;
};

const loadFranchiseCampaignLimit = async (franchiseId) => {
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
    const limit = Number(result?.Item?.campaign_free_messages);
    return Number.isFinite(limit) && limit > 0 ? limit : null;
  } catch (error) {
    logger.warn('Failed to load franchise campaign limit', { franchiseId, error: error.message });
    return null;
  }
};

const loadFranchiseSettings = async (franchiseId) => {
  if (!FRANCHISES_TABLE || !franchiseId) {
    return {
      wallet_enabled: true,
      trial_start: null,
      trial_end: null,
      trial_start_date: null,
      trial_end_date: null,
    };
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
      })
    );
    const item = result?.Item || {};
    const trialStart = item.trial_start_date || item.trial_start || null;
    const trialEnd = item.trial_end_date || item.trial_end || null;
    return {
      wallet_enabled: item.wallet_enabled !== false,
      trial_start: trialStart,
      trial_end: trialEnd,
      trial_start_date: trialStart,
      trial_end_date: trialEnd,
    };
  } catch (error) {
    logger.warn('Failed to load franchise settings', { franchiseId, error: error.message });
    return {
      wallet_enabled: true,
      trial_start: null,
      trial_end: null,
      trial_start_date: null,
      trial_end_date: null,
    };
  }
};

const computeCampaignQuota = async (franchiseId, metrics = {}) => {
  const campaignFreeMessages = await loadFranchiseCampaignLimit(franchiseId);
  const usedMessages = Number(metrics?.totalMessages ?? 0);
  const campaignRemaining =
    campaignFreeMessages !== null
      ? Math.max(campaignFreeMessages - (Number.isFinite(usedMessages) ? usedMessages : 0), 0)
      : null;
  return { campaignFreeMessages, campaignRemaining };
};

const buildFranchiseOverviewPayload = (stores) => {
  const storeSummaries = stores.map((store) => ({
    store_id: store.store_id,
    franchise_id: store.franchise_id,
    store_name: store.store_name || store.brand_name || `Store ${store.store_id}`,
    brand_name: store.brand_name || '',
    business_type: store.business_type || '',
    contact_phone: store.contact_phone || null,
    contact_email: store.contact_email || null,
    onboarding_status: store.onboarding_status || null,
    created_at: store.created_at || null,
    updated_at: store.updated_at || null,
    total_revenue: Number(store.total_revenue ?? 0),
    total_invoices: Number(store.total_invoices ?? 0),
    total_ebill_customers: Number(store.total_ebill_customers ?? store.total_customers ?? 0),
    total_anonymous_customers: Number(store.total_anonymous_customers ?? 0),
    total_campaigns: Number(store.total_campaigns ?? 0),
    total_campaign_messages: Number(store.total_campaign_messages ?? 0),
    total_customers:
      Number(store.total_ebill_customers ?? store.total_customers ?? 0) +
      Number(store.total_anonymous_customers ?? 0),
    franchise_access: store.franchise_access !== false,
  }));

  const aggregateMetric = (key) =>
    storeSummaries.reduce((sum, store) => sum + (Number.isFinite(store[key]) ? store[key] : 0), 0);

  const totalRevenue = aggregateMetric('total_revenue');
  const totalInvoices = aggregateMetric('total_invoices');
  const totalEbillCustomers = aggregateMetric('total_ebill_customers');
  const totalAnonymousCustomers = aggregateMetric('total_anonymous_customers');
  const totalCustomers = totalEbillCustomers + totalAnonymousCustomers;
  const totalCampaigns = aggregateMetric('total_campaigns');
  const totalMessages = aggregateMetric('total_campaign_messages');

  return {
    storeSummaries,
    metrics: {
      storeCount: storeSummaries.length,
      totalRevenue,
      totalInvoices,
      totalCustomers,
      totalEbillCustomers,
      totalAnonymousCustomers,
      totalCampaigns,
      totalMessages,
    },
  };
};

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildWalletPayload = (item = {}, franchiseId) => {
  const payload = {
    franchise_id: franchiseId,
    store_id: DEFAULT_WALLET_STORE_ID,
    balance: 0,
    currency: DEFAULT_WALLET_CURRENCY,
    min_balance: 0,
    low_balance_threshold: 0,
    reserved_balance: 0,
    pricing_ebill_invoice: 0,
    pricing_smart_ebill: 0,
    pricing_campaign_message: 0,
  };
  if (!item) {
    return payload;
  }
  if (typeof item.currency === 'string' && item.currency.trim()) {
    payload.currency = item.currency.trim();
  }
  if (Object.prototype.hasOwnProperty.call(item, 'balance')) {
    payload.balance = toNumber(item.balance);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'min_balance')) {
    payload.min_balance = toNumber(item.min_balance);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'low_balance_threshold')) {
    payload.low_balance_threshold = toNumber(item.low_balance_threshold);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'reserved_balance')) {
    payload.reserved_balance = toNumber(item.reserved_balance);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'pricing_ebill_invoice')) {
    payload.pricing_ebill_invoice = toNumber(item.pricing_ebill_invoice);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'pricing_smart_ebill')) {
    payload.pricing_smart_ebill = toNumber(item.pricing_smart_ebill);
  }
  if (Object.prototype.hasOwnProperty.call(item, 'pricing_campaign_message')) {
    payload.pricing_campaign_message = toNumber(item.pricing_campaign_message);
  }
  return payload;
};

const buildWalletRange = (range, customStart, customEnd) => {
  const now = new Date();
  const end = new Date(now.getTime());
  const start = new Date(now.getTime());
  const parseDateInput = (value, endOfDay = false) => {
    if (!value) {
      return null;
    }
    const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  switch ((range || '').toLowerCase()) {
    case 'today': {
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case 'this_week': {
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case 'this_month': {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case 'this_year': {
      start.setMonth(0, 1);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case 'custom': {
      const customStartDate = parseDateInput(customStart, false);
      const customEndDate = parseDateInput(customEnd, true);
      if (!customStartDate || !customEndDate) {
        return { start: null, end: null };
      }
      return { start: customStartDate, end: customEndDate };
    }
    case 'all': {
      return { start: null, end: null };
    }
    default: {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
      break;
    }
  }
  return { start, end };
};

const queryWalletEvents = async (franchiseId, range, customStart, customEnd) => {
  if (!WALLET_EVENTS_TABLE) {
    return [];
  }
  const { start, end } = buildWalletRange(range, customStart, customEnd);
  const items = [];
  let lastEvaluatedKey;
  do {
    const params = {
      TableName: WALLET_EVENTS_TABLE,
      KeyConditionExpression: 'franchise_id = :fid',
      ExpressionAttributeValues: {
        ':fid': franchiseId,
      },
      ScanIndexForward: false,
      ExclusiveStartKey: lastEvaluatedKey,
    };
    if (start && end) {
      params.KeyConditionExpression = 'franchise_id = :fid AND #event_key BETWEEN :start AND :end';
      params.ExpressionAttributeNames = {
        '#event_key': WALLET_EVENTS_SORT_KEY,
      };
      params.ExpressionAttributeValues[':start'] = `${start.toISOString()}#`;
      params.ExpressionAttributeValues[':end'] = `${end.toISOString()}#~`;
    }
    const result = await docClient.send(new QueryCommand(params));
    if (result.Items) {
      items.push(...result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
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

const toPaise = (value) => Math.round(toNumber(value) * 100);

const verifyRazorpaySignature = ({ orderId, paymentId, signature }) => {
  if (!RAZORPAY_KEY_SECRET) {
    return false;
  }
  const payload = `${orderId}|${paymentId}`;
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(payload).digest('hex');
  return expected === signature;
};

const verifyRazorpayWebhookSignature = (payload, signature) => {
  if (!RAZORPAY_WEBHOOK_SECRET) {
    return false;
  }
  const expected = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  return expected === signature;
};

const recordPaymentOrder = async ({ franchiseId, orderId, amount, currency }) => {
  if (!WALLET_PAYMENTS_TABLE) {
    return;
  }
  const now = new Date().toISOString();
  const item = {
    franchise_id: franchiseId,
    payment_id: `order#${orderId}`,
    order_id: orderId,
    amount,
    amount_paise: toPaise(amount),
    currency,
    status: 'created',
    created_at: now,
    updated_at: now,
  };
  try {
    await docClient.send(
      new PutCommand({
        TableName: WALLET_PAYMENTS_TABLE,
        Item: item,
      })
    );
  } catch (error) {
    logger.error('Failed to record Razorpay order in wallet payments table', {
      franchiseId,
      orderId,
      error: error.message,
    });
  }
};

const markPaymentCapturedAndCredit = async ({
  franchiseId,
  orderId,
  paymentId,
  amount,
  currency,
  payload,
}) => {
  if (!WALLET_PAYMENTS_TABLE) {
    return { credited: false, reason: 'payments_table_missing' };
  }
  const now = new Date().toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: WALLET_PAYMENTS_TABLE,
        Key: {
          franchise_id: franchiseId,
          payment_id: `order#${orderId}`,
        },
        UpdateExpression:
          'SET #status = :status, #payment_id = :payment_id, #updated_at = :updated_at, #credited_at = :credited_at, #amount = :amount, #currency = :currency, #payload = :payload',
        ConditionExpression: 'attribute_not_exists(#credited_at)',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#payment_id': 'razorpay_payment_id',
          '#updated_at': 'updated_at',
          '#credited_at': 'credited_at',
          '#amount': 'amount',
          '#currency': 'currency',
          '#payload': 'gateway_payload',
        },
        ExpressionAttributeValues: {
          ':status': 'paid',
          ':payment_id': paymentId,
          ':updated_at': now,
          ':credited_at': now,
          ':amount': amount,
          ':currency': currency,
          ':payload': payload || null,
        },
      })
    );
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      return { credited: false, reason: 'already_credited' };
    }
    throw error;
  }

  const creditResult = await billingService.creditWallet({
    franchiseId,
    amount,
    sourceId: paymentId,
    reason: 'wallet_topup',
    metadata: {
      order_id: orderId,
    },
  });

  return { credited: !creditResult?.skipped, creditResult };
};

const appendStoreAuditEntry = async (storeId, req) => {
  if (!STORE_CONFIG_TABLE || !storeId) {
    return;
  }

  const entry = {
    location: resolveClientLocation(req),
    time: new Date().toISOString(),
    system: req.get('user-agent') || 'unknown',
  };

  await docClient.send(
    new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression:
        'SET audit_history = list_append(:entry, if_not_exists(audit_history, :empty))',
      ExpressionAttributeValues: {
        ':entry': [entry],
        ':empty': [],
      },
    })
  );
};

const authenticateFranchiseSession = (req, res, next) => {
  if (!FRANCHISE_JWT_SECRET) {
    return res.status(500).json({ error: 'Franchise session secret not configured.' });
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Franchise authorization required.' });
  }
  try {
    const decoded = jwt.verify(token, FRANCHISE_JWT_SECRET);
    req.franchiseSession = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired franchise session.' });
  }
};

router.get('/login/config', async (req, res) => {
  return res.json({
    two_step_verification: TWO_STEP_VERIFICATION_ENABLED,
  });
});

router.post('/login/send-otp', async (req, res) => {
  const { franchise_id: franchiseId } = req.body || {};
  const trimmedId = typeof franchiseId === 'string' ? franchiseId.trim() : '';
  if (!trimmedId) {
    return res.status(400).json({ error: 'franchise_id is required.' });
  }
  if (!SMS_TOKEN) {
    return res.status(500).json({ error: 'SMS service is not configured.' });
  }
  try {
    const stores = await collectFranchiseStores([trimmedId]);
    if (!stores.length) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }
    const ownerStore =
      stores.find((store) => store.franchise_owner_phone) ||
      stores.find((store) => store.franchise_role === 'owner');
    const ownerPhone = ownerStore?.franchise_owner_phone || stores[0].franchise_owner_phone || '';
    const digits = ownerPhone ? ownerPhone.toString().replace(/\D/g, '') : '';
    if (digits.length !== 10) {
      return res
        .status(400)
        .json({
          error: 'Franchise owner phone number is missing or invalid. Please contact support.',
        });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpKey = createFranchiseOtpKey(stores[0].franchise_id || trimmedId);
    saveFranchiseOtp(otpKey, otp);

    await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        route: 'dlt',
        sender_id: SMS_SENDER_ID,
        message: FRANCHISE_LOGIN_SMS_TEMPLATE_ID,
        language: 'english',
        numbers: digits,
        variables_values: `${otp}|Billbox Owner Login OTP`,
      },
      {
        headers: {
          authorization: SMS_TOKEN,
        },
      }
    );

    return res.json({
      success: true,
      masked_phone: maskPhoneNumber(digits),
    });
  } catch (error) {
    logger.error('Failed to send franchise login OTP', {
      franchise_id: trimmedId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to send login OTP right now.' });
  }
});

router.post('/login/password/send-otp', async (req, res) => {
  if (!TWO_STEP_VERIFICATION_ENABLED) {
    return res.status(400).json({ error: 'Two-step verification is disabled.' });
  }
  const { franchise_id: franchiseId, password } = req.body || {};
  const trimmedId = typeof franchiseId === 'string' ? franchiseId.trim() : '';
  const trimmedPassword = typeof password === 'string' ? password.trim() : '';

  if (!trimmedId) {
    return res.status(400).json({ error: 'franchise_id is required.' });
  }
  if (!trimmedPassword) {
    return res.status(400).json({ error: 'Password is required.' });
  }
  if (!SMS_TOKEN) {
    return res.status(500).json({ error: 'SMS service is not configured.' });
  }

  try {
    const stores = await collectFranchiseStores([trimmedId]);
    if (!stores.length) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }

    const canonicalId = stores[0].franchise_id || trimmedId;
    const storedPassword = stores[0].franchise_password
      ? String(stores[0].franchise_password).trim()
      : '';
    if (!storedPassword) {
      return res
        .status(400)
        .json({ error: 'Franchise password is not set. Use Forgot Password to set one.' });
    }

    if (storedPassword !== trimmedPassword) {
      return res.status(401).json({ error: 'Invalid password.' });
    }

    const ownerStore =
      stores.find((store) => store.franchise_owner_phone) ||
      stores.find((store) => store.franchise_role === 'owner');
    const ownerPhone = ownerStore?.franchise_owner_phone || stores[0].franchise_owner_phone || '';
    const digits = ownerPhone ? ownerPhone.toString().replace(/\D/g, '') : '';
    if (digits.length !== 10) {
      return res
        .status(400)
        .json({
          error: 'Franchise owner phone number is missing or invalid. Please contact support.',
        });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpKey = createFranchiseOtpKey(canonicalId, 'franchise_login_pw');
    saveFranchiseOtp(otpKey, otp);

    await axios.post(
      'https://www.fast2sms.com/dev/bulkV2',
      {
        route: 'dlt',
        sender_id: SMS_SENDER_ID,
        message: FRANCHISE_LOGIN_SMS_TEMPLATE_ID,
        language: 'english',
        numbers: digits,
        variables_values: `${otp}|Billbox Owner Login OTP`,
      },
      {
        headers: {
          authorization: SMS_TOKEN,
        },
      }
    );

    return res.json({
      success: true,
      masked_phone: maskPhoneNumber(digits),
    });
  } catch (error) {
    logger.error('Failed to send franchise password login OTP', {
      franchise_id: trimmedId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to send login OTP right now.' });
  }
});

router.post('/login/password', async (req, res) => {
  if (!TWO_STEP_VERIFICATION_ENABLED) {
    return res.status(400).json({ error: 'Two-step verification is disabled.' });
  }
  const { franchise_id: franchiseId, otp } = req.body || {};

  const trimmedId = typeof franchiseId === 'string' ? franchiseId.trim() : '';
  if (!trimmedId) {
    return res.status(400).json({ error: 'franchise_id is required.' });
  }
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({ error: 'Valid 6-digit OTP is required.' });
  }

  try {
    const stores = await collectFranchiseStores([trimmedId]);
    if (!stores.length) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }

    const canonicalId = stores[0].franchise_id || trimmedId;
    const otpKey = createFranchiseOtpKey(canonicalId, 'franchise_login_pw');
    if (!consumeFranchiseOtp(otpKey, otp.trim())) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    const { storeSummaries, metrics } = buildFranchiseOverviewPayload(stores);
    const { campaignFreeMessages, campaignRemaining } = await computeCampaignQuota(
      storeSummaries[0].franchise_id,
      metrics
    );
    const franchiseSettings = await loadFranchiseSettings(storeSummaries[0].franchise_id);
    const sessionToken = FRANCHISE_JWT_SECRET
      ? jwt.sign({ franchise_id: storeSummaries[0].franchise_id }, FRANCHISE_JWT_SECRET, {
          expiresIn: FRANCHISE_TOKEN_TTL,
        })
      : null;

    return res.json({
      success: true,
      token: sessionToken,
      session_token: sessionToken,
      franchise_id: storeSummaries[0].franchise_id,
      store_count: storeSummaries.length,
      metrics,
      stores: storeSummaries,
      wallet_enabled: franchiseSettings.wallet_enabled,
      trial_start: franchiseSettings.trial_start,
      trial_end: franchiseSettings.trial_end,
      trial_start_date: franchiseSettings.trial_start_date,
      trial_end_date: franchiseSettings.trial_end_date,
      campaign_free_messages: campaignFreeMessages,
      campaign_remaining_messages: campaignRemaining,
    });
  } catch (error) {
    logger.error('Franchise password login verify error', {
      franchise_id: trimmedId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to verify franchise. Please try again.' });
  }
});
router.post('/login', async (req, res) => {
  const { franchise_id: franchiseId, otp } = req.body || {};

  const trimmedId = typeof franchiseId === 'string' ? franchiseId.trim() : '';
  if (!trimmedId) {
    return res.status(400).json({ error: 'franchise_id is required.' });
  }
  if (typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    return res.status(400).json({ error: 'Valid 6-digit OTP is required.' });
  }

  try {
    const stores = await collectFranchiseStores([trimmedId]);
    if (!stores.length) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }

    const canonicalId = stores[0].franchise_id || trimmedId;
    const otpKey = createFranchiseOtpKey(canonicalId);
    if (!consumeFranchiseOtp(otpKey, otp.trim())) {
      return res.status(401).json({ error: 'Invalid or expired OTP.' });
    }

    const { storeSummaries, metrics } = buildFranchiseOverviewPayload(stores);
    const { campaignFreeMessages, campaignRemaining } = await computeCampaignQuota(
      storeSummaries[0].franchise_id,
      metrics
    );
    const franchiseSettings = await loadFranchiseSettings(storeSummaries[0].franchise_id);

    const sessionToken = FRANCHISE_JWT_SECRET
      ? jwt.sign({ franchise_id: storeSummaries[0].franchise_id }, FRANCHISE_JWT_SECRET, {
          expiresIn: FRANCHISE_TOKEN_TTL,
        })
      : null;

    return res.json({
      success: true,
      franchise_id: storeSummaries[0].franchise_id,
      store_count: storeSummaries.length,
      metrics,
      stores: storeSummaries,
      campaign_free_messages: campaignFreeMessages,
      campaign_remaining_messages: campaignRemaining,
      session_token: sessionToken,
      wallet_enabled: franchiseSettings.wallet_enabled,
      trial_start: franchiseSettings.trial_start,
      trial_end: franchiseSettings.trial_end,
      trial_start_date: franchiseSettings.trial_start_date,
      trial_end_date: franchiseSettings.trial_end_date,
    });
  } catch (error) {
    logger.error('Franchise login error', { error: error.message });
    return res.status(500).json({ error: 'Unable to verify franchise. Please try again.' });
  }
});

router.get('/session/overview', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }

  try {
    const stores = await collectFranchiseStores([franchiseId]);
    if (!stores.length) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }

    const { storeSummaries, metrics } = buildFranchiseOverviewPayload(stores);
    const { campaignFreeMessages, campaignRemaining } = await computeCampaignQuota(
      storeSummaries[0].franchise_id,
      metrics
    );
    const franchiseSettings = await loadFranchiseSettings(storeSummaries[0].franchise_id);
    return res.json({
      success: true,
      franchise_id: storeSummaries[0].franchise_id,
      store_count: storeSummaries.length,
      metrics,
      stores: storeSummaries,
      campaign_free_messages: campaignFreeMessages,
      campaign_remaining_messages: campaignRemaining,
      wallet_enabled: franchiseSettings.wallet_enabled,
      trial_start: franchiseSettings.trial_start,
      trial_end: franchiseSettings.trial_end,
      trial_start_date: franchiseSettings.trial_start_date,
      trial_end_date: franchiseSettings.trial_end_date,
    });
  } catch (error) {
    logger.error('Franchise session refresh error', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to refresh franchise data. Please try again.' });
  }
});

router.get('/wallet', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!WALLET_TABLE) {
    return res.status(500).json({ error: 'Wallet table is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: WALLET_TABLE,
        Key: {
          franchise_id: franchiseId,
          store_id: DEFAULT_WALLET_STORE_ID,
        },
      })
    );
    const wallet = buildWalletPayload(result.Item || {}, franchiseId);
    return res.json({ success: true, wallet });
  } catch (error) {
    logger.error('Failed to load franchise wallet', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet details.' });
  }
});

router.get('/wallet-events', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!WALLET_EVENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet events table is not configured.' });
  }

  const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50', 10)));

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: WALLET_EVENTS_TABLE,
        KeyConditionExpression: 'franchise_id = :fid',
        ExpressionAttributeValues: {
          ':fid': franchiseId,
        },
        ScanIndexForward: false,
        Limit: limit,
      })
    );

    const events = (result.Items || []).map((item) => ({
      franchise_id: item.franchise_id || franchiseId,
      event_key: item[WALLET_EVENTS_SORT_KEY] || null,
      type: item.type || null,
      usage_type: item.usage_type || null,
      amount: item.amount ?? 0,
      unit_price: item.unit_price ?? 0,
      quantity: item.quantity ?? 0,
      balance_after: item.balance_after ?? null,
      store_id: item.store_id || null,
      source_id: item.source_id || null,
      currency: item.currency || null,
      timestamp: item.timestamp || null,
    }));

    return res.json({ success: true, events });
  } catch (error) {
    logger.error('Failed to load franchise wallet events', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet events.' });
  }
});

router.get('/wallet-events/summary', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  const range = typeof req.query?.range === 'string' ? req.query.range.trim() : 'this_month';

  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!WALLET_EVENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet events table is not configured.' });
  }

  try {
    const items = await queryWalletEvents(franchiseId, range, req.query?.start, req.query?.end);
    let ebillCount = 0;
    let smartEbillCount = 0;
    let campaignCount = 0;
    let ebillSpend = 0;
    let smartEbillSpend = 0;
    let campaignSpend = 0;

    items.forEach((item) => {
      const usageType = (item.usage_type || item.type || '').toString().toLowerCase();
      const amount = toNumber(item.amount);
      if (usageType === 'ebill_invoice') {
        ebillCount += 1;
        ebillSpend += amount;
      }
      if (usageType === 'smart_ebill_invoice') {
        smartEbillCount += 1;
        smartEbillSpend += amount;
      }
      if (usageType === 'campaign_message') {
        campaignCount += 1;
        campaignSpend += amount;
      }
    });

    return res.json({
      success: true,
      range,
      ebillCount,
      ebillSpend,
      smartEbillCount,
      smartEbillSpend,
      campaignCount,
      campaignSpend,
    });
  } catch (error) {
    logger.error('Failed to load franchise wallet summary', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet summary.' });
  }
});

router.get('/wallet-events/range', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  const range = typeof req.query?.range === 'string' ? req.query.range.trim() : 'this_month';

  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!WALLET_EVENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet events table is not configured.' });
  }

  try {
    const items = await queryWalletEvents(franchiseId, range, req.query?.start, req.query?.end);
    const events = items.map((item) => ({
      franchise_id: item.franchise_id || franchiseId,
      event_key: item[WALLET_EVENTS_SORT_KEY] || null,
      type: item.type || null,
      usage_type: item.usage_type || null,
      amount: item.amount ?? 0,
      unit_price: item.unit_price ?? 0,
      quantity: item.quantity ?? 0,
      balance_after: item.balance_after ?? null,
      store_id: item.store_id || null,
      source_id: item.source_id || null,
      currency: item.currency || null,
      timestamp: item.timestamp || null,
      category: item.category || item.template_category || item.sub_category || null,
    }));
    return res.json({ success: true, range, events });
  } catch (error) {
    logger.error('Failed to load franchise wallet events (range)', {
      franchiseId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to load wallet events.' });
  }
});

router.get('/wallet-events/by-store', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  const range = typeof req.query?.range === 'string' ? req.query.range.trim() : 'this_month';

  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!WALLET_EVENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet events table is not configured.' });
  }

  try {
    const items = await queryWalletEvents(franchiseId, range, req.query?.start, req.query?.end);
    const storeMap = new Map();

    items.forEach((item) => {
      const storeId = item.store_id || 'UNKNOWN';
      const usageType = (item.usage_type || item.type || '').toString().toLowerCase();
      const amount = toNumber(item.amount);
      if (!storeMap.has(storeId)) {
        storeMap.set(storeId, {
          store_id: storeId,
          ebillCount: 0,
          ebillSpend: 0,
          smartEbillCount: 0,
          smartEbillSpend: 0,
          campaignCount: 0,
          campaignSpend: 0,
          totalSpend: 0,
        });
      }
      const entry = storeMap.get(storeId);
      if (usageType === 'ebill_invoice') {
        entry.ebillCount += 1;
        entry.ebillSpend += amount;
        entry.totalSpend += amount;
      }
      if (usageType === 'smart_ebill_invoice') {
        entry.smartEbillCount += 1;
        entry.smartEbillSpend += amount;
        entry.totalSpend += amount;
      }
      if (usageType === 'campaign_message') {
        entry.campaignCount += 1;
        entry.campaignSpend += amount;
        entry.totalSpend += amount;
      }
    });

    return res.json({
      success: true,
      range,
      stores: Array.from(storeMap.values()),
    });
  } catch (error) {
    logger.error('Failed to load franchise usage by store', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load store usage.' });
  }
});

router.get('/billing-profile', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!FRANCHISES_TABLE) {
    return res.status(500).json({ error: 'Franchise table is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
      })
    );
    const item = result?.Item || {};
    return res.json({
      success: true,
      profile: {
        franchise_id: franchiseId,
        franchise_name: item.franchise_name || item.name || null,
        billing_address: item.billing_address || item.address || null,
        billing_city: item.billing_city || null,
        billing_state: item.billing_state || null,
        billing_country: item.billing_country || null,
        billing_zip: item.billing_zip || null,
        gst_number: item.gst_number || item.gst || null,
        billing_email: item.billing_email || null,
        billing_phone: item.billing_phone || null,
        payment_method: item.payment_method || null,
        plan_name: item.plan_name || item.subscription_plan || null,
        plan_start_date: item.plan_start_date || item.plan_start || null,
        plan_end_date: item.plan_end_date || item.plan_end || null,
        plan_status: item.plan_status || item.subscription_status || null,
        plan_amount_year: item.plan_amount_year || item.subscription_amount || null,
      },
    });
  } catch (error) {
    logger.error('Failed to load franchise billing profile', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load billing profile.' });
  }
});

router.get('/profile', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!FRANCHISES_TABLE) {
    return res.status(500).json({ error: 'Franchise table is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
      })
    );
    const item = result?.Item || {};
    return res.json({
      success: true,
      profile: {
        franchise_id: franchiseId,
        legal_business_name: item.legal_business_name || item.franchise_name || '',
        owner_full_name: item.owner_full_name || item.franchise_owner_name || '',
        business_email: item.business_email || item.billing_email || '',
        phone_primary: item.phone_primary || item.franchise_owner_phone || '',
        whatsapp_number: item.whatsapp_number || '',
        phone_alternate: item.phone_alternate || '',
        address_line1: item.address_line1 || item.billing_address || '',
        address_line2: item.address_line2 || '',
        city: item.city || item.billing_city || '',
        state: item.state || item.billing_state || '',
        country: item.country || item.billing_country || 'India',
        pincode: item.pincode || item.billing_zip || '',
        gst_registered: Boolean(item.gst_registered),
        gst_number: item.gst_number || '',
        pan_number: item.pan_number || '',
        gst_certificate_url: item.gst_certificate_url || '',
        gst_certificate_key: item.gst_certificate_key || '',
        ...buildSmartEbillPayload(item),
      },
    });
  } catch (error) {
    logger.error('Failed to load franchise profile', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load franchise profile.' });
  }
});

router.get('/smart-ebill', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!FRANCHISES_TABLE) {
    return res.status(500).json({ error: 'Franchise table is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
      })
    );
    return res.json({
      success: true,
      ...buildSmartEbillPayload(result?.Item || {}),
    });
  } catch (error) {
    logger.error('Failed to load franchise Smart E-bill settings', {
      franchiseId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to load Smart E-bill settings.' });
  }
});

router.post(
  '/smart-ebill/upload',
  authenticateFranchiseSession,
  smartEbillUploadMiddleware,
  async (req, res) => {
    const franchiseId = req.franchiseSession?.franchise_id;
    if (!franchiseId) {
      return res.status(401).json({ error: 'Franchise session is invalid.' });
    }
    if (!FRANCHISES_TABLE || !STORE_CONFIG_TABLE || !SMART_EBILL_S3_BUCKET) {
      return res.status(500).json({ error: 'Smart E-bill storage is not configured.' });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ error: 'Select at least one image to upload.' });
    }

    try {
      const uploadedUrls = [];
      for (const file of files) {
        const key = buildSmartEbillKey(franchiseId, file?.originalname);
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
      const result = await docClient.send(
        new UpdateCommand({
          TableName: FRANCHISES_TABLE,
          Key: { franchise_id: franchiseId },
          UpdateExpression:
            'SET smart_img_urls = list_append(if_not_exists(smart_img_urls, :empty), :newUrls), updated_at = :updated',
          ExpressionAttributeValues: {
            ':empty': [],
            ':newUrls': uploadedUrls,
            ':updated': now,
          },
          ReturnValues: 'ALL_NEW',
        })
      );

      const propagatedStores = await appendSmartImagesToStores(franchiseId, uploadedUrls);
      return res.json({
        success: true,
        images: Array.isArray(result.Attributes?.smart_img_urls)
          ? result.Attributes.smart_img_urls
          : uploadedUrls,
        updated_store_count: propagatedStores,
      });
    } catch (error) {
      logger.error('Failed to upload franchise Smart E-bill assets', {
        franchiseId,
        error: error.message,
      });
      return res.status(500).json({ error: 'Unable to upload Smart E-bill assets.' });
    }
  }
);

router.patch('/smart-ebill', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!FRANCHISES_TABLE || !STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Smart E-bill storage is not configured.' });
  }

  const images = Array.isArray(req.body?.images)
    ? req.body.images
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    : [];
  const headerImages = Array.isArray(req.body?.headerImages)
    ? req.body.headerImages
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    : [];
  const bottomBanner =
    typeof req.body?.bottomBanner === 'string' && req.body.bottomBanner.trim()
      ? req.body.bottomBanner.trim()
      : null;
  const smartConfig = {
    smart_img_urls: images,
    smart_header_text: sanitizeSmartText(req.body?.headerText || ''),
    smart_footer_text: sanitizeSmartText(req.body?.footerText || ''),
    smart_address_text: sanitizeSmartText(req.body?.addressText || ''),
    smart_header_images: headerImages,
    smart_bottom_banner: bottomBanner,
  };

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
        UpdateExpression:
          'SET smart_img_urls = :images, smart_header_text = :headerText, smart_footer_text = :footerText, smart_address_text = :addressText, smart_header_images = :headerImages, smart_bottom_banner = :bottomBanner, updated_at = :updated',
        ExpressionAttributeValues: {
          ':images': smartConfig.smart_img_urls,
          ':headerText': smartConfig.smart_header_text,
          ':footerText': smartConfig.smart_footer_text,
          ':addressText': smartConfig.smart_address_text,
          ':headerImages': smartConfig.smart_header_images,
          ':bottomBanner': smartConfig.smart_bottom_banner,
          ':updated': new Date().toISOString(),
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    const propagatedStores = await applySmartEbillConfigToStores(franchiseId, smartConfig);
    return res.json({
      success: true,
      ...buildSmartEbillPayload(result.Attributes || smartConfig),
      updated_store_count: propagatedStores,
    });
  } catch (error) {
    logger.error('Failed to update franchise Smart E-bill settings', {
      franchiseId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to update Smart E-bill settings.' });
  }
});

router.put('/profile', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!FRANCHISES_TABLE) {
    return res.status(500).json({ error: 'Franchise table is not configured.' });
  }

  const {
    legal_business_name,
    owner_full_name,
    business_email,
    phone_primary,
    whatsapp_number,
    phone_alternate,
    address_line1,
    address_line2,
    city,
    state,
    country,
    pincode,
    gst_registered,
    gst_number,
    pan_number,
    gst_certificate_url,
    gst_certificate_key,
  } = req.body || {};

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
        UpdateExpression:
          'SET legal_business_name = :legal, owner_full_name = :owner, business_email = :email, phone_primary = :phone1, phone_alternate = :phone2, ' +
          'whatsapp_number = :whatsapp, ' +
          'address_line1 = :addr1, address_line2 = :addr2, city = :city, #state = :state, country = :country, pincode = :pincode, ' +
          'gst_registered = :gstreg, gst_number = :gst, gst_certificate_url = :gstUrl, gst_certificate_key = :gstKey, ' +
          'pan_number = :pan, updated_at = :updatedAt',
        ExpressionAttributeNames: {
          '#state': 'state',
        },
        ExpressionAttributeValues: {
          ':legal': legal_business_name || '',
          ':owner': owner_full_name || '',
          ':email': business_email || '',
          ':phone1': phone_primary || '',
          ':phone2': phone_alternate || '',
          ':whatsapp': whatsapp_number || '',
          ':addr1': address_line1 || '',
          ':addr2': address_line2 || '',
          ':city': city || '',
          ':state': state || '',
          ':country': country || 'India',
          ':pincode': pincode || '',
          ':gstreg': Boolean(gst_registered),
          ':gst': gst_number || '',
          ':pan': pan_number || '',
          ':gstUrl': gst_certificate_url || '',
          ':gstKey': gst_certificate_key || '',
          ':updatedAt': new Date().toISOString(),
        },
      })
    );
    return res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update franchise profile', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to update franchise profile.' });
  }
});

router.get('/profile/gst-upload-url', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!FRANCHISE_DOCS_BUCKET) {
    return res.status(500).json({ error: 'Franchise documents bucket is not configured.' });
  }

  const filename = typeof req.query?.filename === 'string' ? req.query.filename : '';
  const contentType = typeof req.query?.contentType === 'string' ? req.query.contentType : '';
  const size = Number(req.query?.size || 0);
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
  if (!filename || !contentType) {
    return res.status(400).json({ error: 'filename and contentType are required.' });
  }
  if (!allowedTypes.includes(contentType)) {
    return res.status(400).json({ error: 'Unsupported file type.' });
  }
  if (!Number.isFinite(size) || size <= 0 || size > 5 * 1024 * 1024) {
    return res.status(400).json({ error: 'File size must be <= 5MB.' });
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${FRANCHISE_DOCS_PREFIX}${franchiseId}/${Date.now()}_${safeName}`;

  try {
    const uploadUrl = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: FRANCHISE_DOCS_BUCKET,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: 60 * 5 }
    );
    const publicUrl = `https://${FRANCHISE_DOCS_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
    return res.json({ success: true, uploadUrl, publicUrl, key });
  } catch (error) {
    logger.error('Failed to create GST upload URL', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to create upload URL.' });
  }
});

router.get('/payments/history', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  if (!franchiseId) {
    return res.status(401).json({ error: 'Franchise session is invalid.' });
  }
  if (!WALLET_PAYMENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet payments table is not configured.' });
  }

  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit || '50', 10)));

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: WALLET_PAYMENTS_TABLE,
        KeyConditionExpression: 'franchise_id = :fid',
        ExpressionAttributeValues: {
          ':fid': franchiseId,
        },
      })
    );
    const items = Array.isArray(result.Items) ? result.Items : [];
    items.sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      return bTime - aTime;
    });
    return res.json({
      success: true,
      payments: items.slice(0, limit),
    });
  } catch (error) {
    logger.error('Failed to load wallet payments history', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load payment history.' });
  }
});

router.get('/stores/:storeId/daily-stats', async (req, res) => {
  const { storeId } = req.params;
  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required' });
  }

  try {
    const stats = await getStoreDailyStats(storeId);
    return res.json({ success: true, store_id: storeId, stats });
  } catch (error) {
    logger.error('Failed to load store daily stats', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to fetch store statistics.' });
  }
});

router.get('/stores/:storeId/audit-history', async (req, res) => {
  const { storeId } = req.params;
  const franchiseId = req.query?.franchise_id;

  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'franchise_id is required' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    if (result.Item.franchise_id !== franchiseId) {
      return res.status(403).json({ error: 'Store does not belong to the provided franchise.' });
    }

    const auditHistory = Array.isArray(result.Item.audit_history) ? result.Item.audit_history : [];
    return res.json({
      success: true,
      store_id: storeId,
      audit_history: auditHistory,
    });
  } catch (error) {
    logger.error('Failed to fetch audit history', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to fetch audit history.' });
  }
});

router.delete('/stores/:storeId/audit-history', async (req, res) => {
  const { storeId } = req.params;
  const { franchise_id: franchiseId } = req.body || {};

  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'franchise_id is required' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    if (result.Item.franchise_id !== franchiseId) {
      return res.status(403).json({ error: 'Store does not belong to the provided franchise.' });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: 'REMOVE audit_history',
      })
    );

    return res.json({ success: true, store_id: storeId, audit_history: [] });
  } catch (error) {
    logger.error('Failed to clear audit history', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to clear audit history.' });
  }
});

router.post('/stores/:storeId/logout-all', async (req, res) => {
  const { storeId } = req.params;
  const { franchise_id: franchiseId } = req.body || {};

  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'franchise_id is required' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    if (result.Item.franchise_id !== franchiseId) {
      return res.status(403).json({ error: 'Store does not belong to the provided franchise.' });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const sessionVersion = Date.now();
    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: 'SET session_revoked_at = :ts, session_version = :ver',
        ExpressionAttributeValues: {
          ':ts': timestamp,
          ':ver': sessionVersion,
        },
      })
    );

    return res.json({
      success: true,
      store_id: storeId,
      session_revoked_at: timestamp,
      session_version: sessionVersion,
    });
  } catch (error) {
    logger.error('Failed to revoke store sessions', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to logout store sessions.' });
  }
});

router.post('/payments/create-order', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  const amount = toNumber(req.body?.amount);

  if (!franchiseId) {
    return res.status(400).json({ error: 'franchise_id is required.' });
  }
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Razorpay keys are not configured.' });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount must be greater than 0.' });
  }

  try {
    const response = await axios.post(
      'https://api.razorpay.com/v1/orders',
      {
        amount: toPaise(amount),
        currency: DEFAULT_WALLET_CURRENCY,
        payment_capture: 1,
        notes: {
          franchise_id: franchiseId,
        },
        receipt: `fr_${franchiseId}_${Date.now()}`,
      },
      {
        auth: {
          username: RAZORPAY_KEY_ID,
          password: RAZORPAY_KEY_SECRET,
        },
      }
    );

    const order = response.data || {};
    if (!order.id) {
      return res.status(502).json({ error: 'Razorpay order creation failed.' });
    }

    await recordPaymentOrder({
      franchiseId,
      orderId: order.id,
      amount,
      currency: order.currency || DEFAULT_WALLET_CURRENCY,
    });

    return res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency || DEFAULT_WALLET_CURRENCY,
      key_id: RAZORPAY_KEY_ID,
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    const responseData = error?.response?.data || null;
    logger.error('Failed to create Razorpay order', {
      franchiseId,
      status,
      error: error.message,
      response: responseData,
    });
    const message =
      responseData?.error?.description ||
      responseData?.error?.message ||
      'Unable to create Razorpay order.';
    return res.status(500).json({ error: message });
  }
});

router.post('/payments/verify', authenticateFranchiseSession, async (req, res) => {
  const franchiseId = req.franchiseSession?.franchise_id;
  const {
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature,
  } = req.body || {};

  if (!franchiseId) {
    return res.status(400).json({ error: 'franchise_id is required.' });
  }
  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({ error: 'Missing Razorpay verification fields.' });
  }

  const isValid = verifyRazorpaySignature({
    orderId,
    paymentId,
    signature,
  });

  if (!isValid) {
    return res.status(400).json({ error: 'Invalid Razorpay signature.' });
  }

  try {
    const paymentResponse = await axios.get(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      auth: {
        username: RAZORPAY_KEY_ID,
        password: RAZORPAY_KEY_SECRET,
      },
    });

    const payment = paymentResponse.data || {};
    if (payment.status !== 'captured') {
      return res.status(409).json({ error: 'Payment not captured yet.' });
    }

    const amount = Number(payment.amount || 0) / 100;
    const result = await markPaymentCapturedAndCredit({
      franchiseId,
      orderId,
      paymentId,
      amount,
      currency: payment.currency || DEFAULT_WALLET_CURRENCY,
      payload: payment,
    });

    return res.json({
      success: true,
      credited: result.credited,
      balance_updated: !result.creditResult?.skipped,
    });
  } catch (error) {
    logger.error('Failed to verify Razorpay payment', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to verify Razorpay payment.' });
  }
});

router.post('/payments/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body || {});

  if (!signature || !verifyRazorpayWebhookSignature(rawBody, signature)) {
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  const event = req.body || {};
  const payload = event?.payload?.payment?.entity || {};
  const paymentId = payload.id;
  const orderId = payload.order_id;
  const franchiseId = payload?.notes?.franchise_id;

  if (!paymentId || !orderId || !franchiseId) {
    return res.status(400).json({ error: 'Webhook payload missing required fields.' });
  }

  if (event.event !== 'payment.captured') {
    return res.json({ received: true });
  }

  try {
    const amount = Number(payload.amount || 0) / 100;
    await markPaymentCapturedAndCredit({
      franchiseId,
      orderId,
      paymentId,
      amount,
      currency: payload.currency || DEFAULT_WALLET_CURRENCY,
      payload,
    });
    return res.json({ received: true });
  } catch (error) {
    logger.error('Failed to process Razorpay webhook', { error: error.message });
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

router.post('/stores/:storeId/sso-token', authenticateFranchiseSession, async (req, res) => {
  const { storeId } = req.params;
  const franchiseId = req.franchiseSession?.franchise_id;

  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required.' });
  }
  if (!franchiseId) {
    return res.status(403).json({ error: 'Franchise context missing.' });
  }
  if (!STORE_CONFIG_TABLE || !JWT_SECRET) {
    return res.status(500).json({ error: 'Authentication is not configured.' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    if (!result.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    if ((result.Item.franchise_id || '').toLowerCase() !== franchiseId.toLowerCase()) {
      return res.status(403).json({ error: 'Store does not belong to the provided franchise.' });
    }

    const store = result.Item;
    const rawSessionVersion = store.session_version;
    const sessionVersion = Number.isFinite(Number(rawSessionVersion))
      ? Number(rawSessionVersion)
      : null;
    const tokenPayload = {
      franchise_id: store.franchise_id || null,
      store_id: store.store_id,
      session_version: sessionVersion,
      iat: Math.floor(Date.now() / 1000),
    };

    const storeToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '3d' });
    const customerTypeConfig = sanitizeCustomerTypeConfig(
      store.customer_type_config || DEFAULT_CUSTOMER_TYPE_CONFIG
    );

    await appendStoreAuditEntry(store.store_id, req);

    return res.json({
      token: storeToken,
      store_id: store.store_id,
      franchise_id: store.franchise_id || null,
      whatsapp_api_url: store.whatsapp_api_url || null,
      access_token: store.access_token || null,
      waba_id: store.waba_id || null,
      phone_number_id: store.phone_number_id || null,
      waba_mobile_number: store.waba_mobile_number || null,
      template_name: store.template_name || null,
      template_language: store.template_language || null,
      vendor_name: store.vendor_name || null,
      verified_name: store.verified_name || null,
      store_name: store.store_name || null,
      webhook_config: store.webhook_config || null,
      trial_started: store.trial_started ?? store.trail_started ?? null,
      trial_period: store.trial_period ?? null,
      customer_type_config: customerTypeConfig,
    });
  } catch (error) {
    logger.error('Failed to create SSO token', { store_id: storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to generate store token.' });
  }
});

router.post('/stores/:storeId/access', async (req, res) => {
  const { storeId } = req.params;
  const { franchise_id: franchiseId, allowed } = req.body || {};

  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'franchise_id is required' });
  }
  if (typeof allowed !== 'boolean') {
    return res.status(400).json({ error: 'allowed must be a boolean.' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not configured.' });
  }

  try {
    const storeResult = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    if (!storeResult.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    if (storeResult.Item.franchise_id !== franchiseId) {
      return res.status(403).json({ error: 'Store does not belong to the provided franchise.' });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: 'SET franchise_access = :allowed',
        ExpressionAttributeValues: {
          ':allowed': allowed,
        },
      })
    );

    return res.json({ success: true, store_id: storeId, franchise_access: allowed });
  } catch (error) {
    logger.error('Failed to update store access', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to update store access. Please try again.' });
  }
});

router.get('/:franchiseId', async (req, res) => {
  const { franchiseId } = req.params;
  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'Franchise ID is required' });
  }

  const stores = await collectFranchiseStores([franchiseId]);
  if (stores.length > 0) {
    const match = stores[0];
    return res.json({
      franchise_id: match.franchise_id,
      brand_name: match.brand_name || '',
      business_type: match.business_type || '',
    });
  }

  return res.status(404).json({
    error:
      'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
  });
});

router.get('/:franchiseId/customer-types', async (req, res) => {
  const { franchiseId } = req.params;
  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'Franchise ID is required' });
  }

  try {
    const stores = await collectFranchiseStores([franchiseId]);
    if (!stores.length) {
      return res.status(404).json({ error: 'Franchise not found.' });
    }

    const storeWithConfig = stores.find((store) => store.customer_type_config) || stores[0];
    const config = sanitizeCustomerTypeConfig(
      storeWithConfig.customer_type_config || DEFAULT_CUSTOMER_TYPE_CONFIG
    );
    return res.json({
      franchise_id: franchiseId,
      customer_type_config: config,
      updated_at: storeWithConfig.customer_type_config_updated_at || null,
      store_count: stores.length,
    });
  } catch (error) {
    logger.error('Failed to fetch customer type config', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to fetch customer type configuration.' });
  }
});

router.post('/:franchiseId/customer-types', async (req, res) => {
  const { franchiseId } = req.params;
  const { franchise_password: franchisePassword, config } = req.body || {};

  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'Franchise ID is required' });
  }
  if (!franchisePassword || typeof franchisePassword !== 'string') {
    return res.status(400).json({ error: 'franchise_password is required' });
  }
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'config object is required' });
  }

  try {
    const stores = await collectFranchiseStores([franchiseId]);
    if (!stores.length) {
      return res.status(404).json({ error: 'Franchise not found.' });
    }

    const matched = stores[0];
    if (!matched.franchise_password || matched.franchise_password !== franchisePassword) {
      return res.status(401).json({ error: 'Invalid franchise credentials.' });
    }

    const normalizedConfig = sanitizeCustomerTypeConfig(config);
    const timestamp = new Date().toISOString();

    await Promise.all(
      stores.map((store) =>
        docClient.send(
          new UpdateCommand({
            TableName: STORE_CONFIG_TABLE,
            Key: { store_id: store.store_id },
            UpdateExpression:
              'SET customer_type_config = :config, customer_type_config_updated_at = :updatedAt',
            ExpressionAttributeValues: {
              ':config': normalizedConfig,
              ':updatedAt': timestamp,
            },
          })
        )
      )
    );

    return res.json({
      success: true,
      franchise_id: franchiseId,
      customer_type_config: normalizedConfig,
      updated_at: timestamp,
      store_count: stores.length,
    });
  } catch (error) {
    logger.error('Failed to update customer type config', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to update customer type configuration.' });
  }
});

router.get('/stores/:storeId/customer-types', async (req, res) => {
  const { storeId } = req.params;
  const { franchise_id: franchiseId } = req.query;

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not configured.' });
  }
  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required' });
  }

  try {
    const storeResult = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    if (!storeResult.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    if (franchiseId && storeResult.Item.franchise_id !== franchiseId) {
      return res.status(403).json({ error: 'Store does not belong to the provided franchise.' });
    }

    const config = sanitizeCustomerTypeConfig(
      storeResult.Item.customer_type_config || DEFAULT_CUSTOMER_TYPE_CONFIG
    );

    return res.json({
      store_id: storeId,
      franchise_id: storeResult.Item.franchise_id,
      customer_type_config: config,
      updated_at: storeResult.Item.customer_type_config_updated_at || null,
    });
  } catch (error) {
    logger.error('Failed to fetch store customer type config', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to fetch customer type configuration.' });
  }
});

router.post('/stores/:storeId/customer-types', async (req, res) => {
  const { storeId } = req.params;
  const { franchise_id: franchiseId, config } = req.body || {};

  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store configuration table is not configured.' });
  }
  if (!storeId || typeof storeId !== 'string') {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!franchiseId || typeof franchiseId !== 'string') {
    return res.status(400).json({ error: 'franchise_id is required' });
  }
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'config object is required' });
  }

  try {
    const storeResult = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    if (!storeResult.Item) {
      return res.status(404).json({ error: 'Store not found.' });
    }
    if (storeResult.Item.franchise_id !== franchiseId) {
      return res.status(403).json({ error: 'Store does not belong to the provided franchise.' });
    }

    const normalizedConfig = sanitizeCustomerTypeConfig(config);
    const timestamp = new Date().toISOString();

    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression:
          'SET customer_type_config = :config, customer_type_config_updated_at = :updatedAt',
        ExpressionAttributeValues: {
          ':config': normalizedConfig,
          ':updatedAt': timestamp,
        },
      })
    );

    return res.json({
      success: true,
      store_id: storeId,
      customer_type_config: normalizedConfig,
      updated_at: timestamp,
    });
  } catch (error) {
    logger.error('Failed to update store customer type config', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to update customer type configuration.' });
  }
});

router.post('/login/password-only', async (req, res) => {
  if (TWO_STEP_VERIFICATION_ENABLED) {
    return res.status(400).json({ error: 'Password-only login is disabled.' });
  }

  const { franchise_id: franchiseId, password } = req.body || {};
  const trimmedId = typeof franchiseId === 'string' ? franchiseId.trim() : '';
  const trimmedPassword = typeof password === 'string' ? password.trim() : '';

  if (!trimmedId) {
    return res.status(400).json({ error: 'franchise_id is required.' });
  }
  if (!trimmedPassword) {
    return res.status(400).json({ error: 'Password is required.' });
  }

  try {
    const stores = await collectFranchiseStores([trimmedId]);
    if (!stores.length) {
      return res.status(404).json({
        error:
          'Franchise ID not found. Enter the ID you received during your first store signup or choose to create a new franchise.',
      });
    }

    const canonicalId = stores[0].franchise_id || trimmedId;
    const storedPassword = stores[0].franchise_password
      ? String(stores[0].franchise_password).trim()
      : '';
    if (!storedPassword) {
      return res
        .status(400)
        .json({ error: 'Franchise password is not set. Use Reset with OTP to set one.' });
    }

    if (storedPassword !== trimmedPassword) {
      return res.status(401).json({ error: 'Invalid password.' });
    }

    const { storeSummaries, metrics } = buildFranchiseOverviewPayload(stores);
    const { campaignFreeMessages, campaignRemaining } = await computeCampaignQuota(
      storeSummaries[0].franchise_id,
      metrics
    );
    const franchiseSettings = await loadFranchiseSettings(storeSummaries[0].franchise_id);

    const sessionToken = FRANCHISE_JWT_SECRET
      ? jwt.sign({ franchise_id: storeSummaries[0].franchise_id }, FRANCHISE_JWT_SECRET, {
          expiresIn: FRANCHISE_TOKEN_TTL,
        })
      : null;

    return res.json({
      success: true,
      token: sessionToken,
      session_token: sessionToken,
      franchise_id: storeSummaries[0].franchise_id,
      store_count: storeSummaries.length,
      metrics,
      stores: storeSummaries,
      campaign_free_messages: campaignFreeMessages,
      campaign_remaining_messages: campaignRemaining,
      wallet_enabled: franchiseSettings.wallet_enabled,
      trial_start: franchiseSettings.trial_start,
      trial_end: franchiseSettings.trial_end,
      trial_start_date: franchiseSettings.trial_start_date,
      trial_end_date: franchiseSettings.trial_end_date,
    });
  } catch (error) {
    logger.error('Franchise password-only login error', {
      franchise_id: trimmedId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to verify franchise. Please try again.' });
  }
});

module.exports = router;
const createFranchiseOtpKey = (franchiseId, context = 'franchise_login') => {
  if (!franchiseId) {
    return null;
  }
  const normalized = franchiseId.trim().toLowerCase();
  return normalized ? `${context}:${normalized}` : null;
};

const saveFranchiseOtp = (key, otp) => {
  if (!key) {
    return;
  }
  franchiseOtpStore.set(key, {
    otp,
    expiresAt: Date.now() + FRANCHISE_LOGIN_OTP_TTL_MS,
  });
};

const consumeFranchiseOtp = (key, otp) => {
  if (!key) {
    return false;
  }
  const record = franchiseOtpStore.get(key);
  if (!record) {
    return false;
  }
  if (record.expiresAt < Date.now()) {
    franchiseOtpStore.delete(key);
    return false;
  }
  const verified = record.otp === otp;
  if (verified) {
    franchiseOtpStore.delete(key);
  }
  return verified;
};

const maskPhoneNumber = (phone) => {
  if (!phone) {
    return '';
  }
  const digits = phone.toString().trim();
  if (digits.length <= 3) {
    return digits;
  }
  const masked = '*'.repeat(Math.max(0, digits.length - 3));
  return `${masked}${digits.slice(-3)}`;
};
