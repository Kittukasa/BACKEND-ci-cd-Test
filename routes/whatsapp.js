const express = require('express');
const axios = require('axios');
const { URL } = require('url');
const router = express.Router();
const { logger, getLogBuffer } = require('../config/logger');
const whatsappService = require('../services/whatsappService');
const automationService = require('../services/automationService');
const EventBuffer = require('../services/eventBuffer');
const analyticsService = require('../services/analyticsService');
const resendService = require('../services/resendService');
const franchiseService = require('../services/franchiseService');
const billingService = require('../services/billingService');
const {
  initCampaignProgress,
  updateRecipientProgress,
  finalizeCampaignProgress,
  failCampaignProgress,
  getCampaignProgress,
  getActiveCampaignsByStore,
} = require('../utils/campaignProgressStore');
const { docClient } = require('../config/dynamodb');
const {
  GetCommand,
  UpdateCommand,
  ScanCommand,
  PutCommand,
  QueryCommand,
  BatchWriteCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const FormData = require('form-data');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const { randomUUID } = require('crypto');
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION;

const STORE_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;
const INVOICES_TABLE = process.env.DYNAMODB_TABLE;
const BILL_SLUG_TABLE = process.env.BILL_SLUG_TABLE;
const FRANCHISES_TABLE = process.env.FRANCHISES_TABLE;
const STORE_CONFIG_PHONE_INDEX =
  process.env.STORE_WHATSAPP_CONFIG_PHONE_INDEX ||
  process.env.STORE_CONFIG_PHONE_INDEX ||
  'phone_number_id-waba_id-index';
const WHATSAPP_MESSAGES_TABLE = process.env.STORE_WHATSAPP_MESSAGES_TABLE;
const CUSTOMER_RECORDS_TABLE = process.env.CUSTOMER_RECORDS_TABLE || null;
const WHATSAPP_MESSAGES_CUSTOMER_INDEX = 'customerConnect';
const DEFAULT_TEMPLATE_FIELDS = [
  'language',
  'name',
  'rejected_reason',
  'status',
  'category',
  'sub_category',
  'last_updated_time',
  'components',
  'quality_score',
].join(',');

const phoneNumberStoreCache = new Map();
const wabaStoreCache = new Map();
const displayPhoneStoreCache = new Map();
let storePhoneIndexUnavailable = false;
let latestOnboardingSnapshot = null;
let latestOnboardingRawPayload = null;
const STATIC_WABA_ACCESS_TOKEN = process.env.WABA_ACCESS_TOKEN || null;
const DEFAULT_COUNTRY_CODE =
  (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91').replace(/[^\d]/g, '') || '91';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const digitsOnly = (value) => {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'number') {
    return value.toString().replace(/[^\d]/g, '');
  }
  if (typeof value === 'string') {
    return value.trim().replace(/[^\d]/g, '');
  }
  return '';
};

const CHAT_MEDIA_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
]);

const resolveChatMediaType = (file) => {
  if (!file || !file.mimetype) {
    return null;
  }
  if (file.mimetype.startsWith('image/')) {
    return 'IMAGE';
  }
  if (CHAT_MEDIA_MIME_TYPES.has(file.mimetype)) {
    return 'DOCUMENT';
  }
  return null;
};

const parseCatalogPrice = (rawPrice) => {
  if (rawPrice === null || rawPrice === undefined) {
    return { amount: null, currency: null, display: null };
  }
  if (typeof rawPrice === 'number') {
    return { amount: rawPrice, currency: null, display: rawPrice.toString() };
  }
  if (typeof rawPrice === 'string') {
    const trimmed = rawPrice.trim();
    if (!trimmed) {
      return { amount: null, currency: null, display: null };
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const possibleAmount = parseFloat(parts[0].replace(/[^0-9.]/g, ''));
      const possibleCurrency = parts[parts.length - 1].replace(/[^A-Z]/g, '');
      if (!Number.isNaN(possibleAmount)) {
        const currency = possibleCurrency || null;
        let display = `${possibleAmount}`;
        if (currency) {
          try {
            display = new Intl.NumberFormat('en-IN', {
              style: 'currency',
              currency,
            }).format(possibleAmount);
          } catch {
            display = `${possibleAmount} ${currency}`;
          }
        }
        return { amount: possibleAmount, currency, display };
      }
    }
    const numeric = parseFloat(trimmed.replace(/[^0-9.]/g, ''));
    if (!Number.isNaN(numeric)) {
      return { amount: numeric, currency: null, display: numeric.toString() };
    }
    return { amount: null, currency: null, display: trimmed };
  }
  return { amount: null, currency: null, display: null };
};

const fetchCatalogProducts = async ({
  catalogId,
  accessToken,
  graphVersion,
  limit = 100,
  productSetId = null,
}) => {
  const products = [];
  const resourceId = productSetId || catalogId;
  if (!resourceId || !accessToken) {
    return products;
  }

  const version = graphVersion || GRAPH_API_VERSION || 'v18.0';
  const fields = [
    'id',
    'name',
    'retailer_id',
    'price',
    'currency',
    'image_url',
    'availability',
  ].join(',');

  let nextUrl = `https://graph.facebook.com/${version}/${resourceId}/products?fields=${fields}&limit=${limit}`;

  while (nextUrl && products.length < limit) {
    const response = await axios.get(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 12000,
    });
    const data = response.data || {};
    const items = Array.isArray(data.data) ? data.data : [];
    items.forEach((item) => {
      const priceInfo = parseCatalogPrice(item.price ?? item.price_amount ?? null);
      products.push({
        id: item.id || '',
        name: item.name || item.retailer_id || 'Product',
        image: item.image_url || '',
        product_retailer_id: item.retailer_id || '',
        price: priceInfo.display || item.price || '',
        price_value: priceInfo.amount,
        currency: item.currency || priceInfo.currency || null,
        availability: item.availability || null,
      });
    });
    const nextLink = data?.paging?.next || null;
    nextUrl = nextLink && products.length < limit ? nextLink : null;
  }

  return products;
};

const fetchCatalogCollections = async ({ catalogId, accessToken, graphVersion, limit = 100 }) => {
  const collections = [];
  if (!catalogId || !accessToken) {
    return collections;
  }

  const version = graphVersion || GRAPH_API_VERSION || 'v18.0';
  const fields = ['id', 'name', 'product_count', 'updated_time'].join(',');
  let nextUrl = `https://graph.facebook.com/${version}/${catalogId}/product_sets?fields=${fields}&limit=${limit}`;

  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    });
    const data = response.data?.data || [];
    data.forEach((item) => {
      collections.push({
        id: item.id || null,
        name: item.name || null,
        product_count: item.product_count ?? null,
        updated_time: item.updated_time || null,
      });
    });
    nextUrl = response.data?.paging?.next || null;
  }

  return collections.filter((item) => item.id);
};

const uploadChatMedia = async ({ file, phoneNumberId, accessToken, graphVersion }) => {
  const uploadUrl = `https://graph.facebook.com/${graphVersion || GRAPH_API_VERSION}/${phoneNumberId}/media`;
  const formData = new FormData();
  formData.append('file', file.buffer, {
    filename: file.originalname || `media_${Date.now()}`,
    contentType: file.mimetype,
  });
  formData.append('messaging_product', 'whatsapp');

  const response = await axios.post(uploadUrl, formData, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...formData.getHeaders(),
    },
  });

  const mediaId = response.data?.id || null;
  if (!mediaId) {
    throw new Error('Media upload succeeded but no media ID returned');
  }
  return mediaId;
};

const normalizePhoneWithDefaultCountry = (rawValue) => {
  let digits = digitsOnly(rawValue);
  if (!digits) {
    return '';
  }

  const ccLength = DEFAULT_COUNTRY_CODE.length;

  if (digits.length === 10) {
    digits = `${DEFAULT_COUNTRY_CODE}${digits}`;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = `${DEFAULT_COUNTRY_CODE}${digits.slice(1)}`;
  } else if (digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length > ccLength + 10) {
    digits = digits.slice(0, ccLength + 10);
  } else if (!digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length <= 10) {
    digits = `${DEFAULT_COUNTRY_CODE}${digits.padStart(10, '0')}`;
  }

  return digits;
};

const formatPhoneToE164 = (rawValue) => {
  const normalizedDigits = normalizePhoneWithDefaultCountry(rawValue);
  if (!normalizedDigits) {
    return null;
  }
  return `+${normalizedDigits}`;
};

const formatPhoneWithCountryDigits = (rawValue) => {
  const normalizedDigits = normalizePhoneWithDefaultCountry(rawValue);
  return normalizedDigits || null;
};
const CAMPAIGN_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.WHATSAPP_CAMPAIGN_CONCURRENCY || '10', 10)
);
const CAMPAIGN_MAX_MPS = Math.max(0, parseInt(process.env.WHATSAPP_CAMPAIGN_MAX_MPS || '20', 10));
const CAMPAIGN_MAX_RETRIES = Math.max(
  0,
  parseInt(process.env.WHATSAPP_CAMPAIGN_MAX_RETRIES || '3', 10)
);
const CAMPAIGN_RETRY_BASE_DELAY_MS = Math.max(
  100,
  parseInt(process.env.WHATSAPP_CAMPAIGN_RETRY_BASE_DELAY_MS || '1000', 10)
);

function createRateLimiter(maxPerSecond) {
  if (!Number.isFinite(maxPerSecond) || maxPerSecond <= 0) {
    return { acquire: async () => {} };
  }
  let availableTokens = maxPerSecond;
  const waiters = [];
  const replenish = () => {
    availableTokens = maxPerSecond;
    while (availableTokens > 0 && waiters.length > 0) {
      availableTokens--;
      const resolve = waiters.shift();
      resolve();
    }
  };
  const interval = setInterval(replenish, 1000);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }
  return {
    acquire: () => {
      if (availableTokens > 0) {
        availableTokens--;
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const campaignRateLimiter = createRateLimiter(CAMPAIGN_MAX_MPS);

const retryableNetworkCodes = new Set([
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNABORTED',
]);
const RESEND_SCHEDULER_ENABLED = process.env.RESEND_SCHEDULER_ENABLED !== 'false';
const RESEND_SCHEDULER_INTERVAL_MS = Math.max(
  30 * 1000,
  Number(process.env.RESEND_SCHEDULER_INTERVAL_MS || 60 * 1000)
);
const RESEND_MAX_ATTEMPTS = Math.max(1, Number(process.env.RESEND_MAX_ATTEMPTS || 4));
const RESEND_SUCCESS_THRESHOLD = Number(process.env.RESEND_SUCCESS_THRESHOLD || 0.9);
const META_LIMIT_ERROR_CODES = new Set(['131047', '131048', '80007', '88']);

function isRetryableError(error) {
  if (!error) {
    return false;
  }
  const status = error.response?.status;
  if (status === 429 || status === 423) {
    return true;
  }
  if (status >= 500) {
    return true;
  }
  const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  if (retryableNetworkCodes.has(code)) {
    return true;
  }
  return false;
}

function resolveErrorInfo(error, fallbackMessage = 'Failed to send message') {
  const graphError = error?.response?.data?.error;
  const message =
    graphError?.error_user_msg || graphError?.message || error?.message || fallbackMessage;
  const rawCode =
    graphError?.code ??
    graphError?.error_subcode ??
    (typeof error?.code === 'string' || typeof error?.code === 'number' ? error.code : null);
  return {
    message,
    code: rawCode ?? null,
  };
}

function isMetaLimitedRecipient(recipient) {
  if (!recipient) {
    return false;
  }
  const status = (recipient.status || '').toString().toLowerCase();
  if (status.includes('limit')) {
    return true;
  }
  const errorCode = recipient.errorCode ?? recipient.error_code ?? null;
  if (errorCode !== null && META_LIMIT_ERROR_CODES.has(String(errorCode))) {
    return true;
  }
  const errorMessage = (recipient.error || recipient.error_reason || '').toString().toLowerCase();
  return errorMessage.includes('limit');
}

function isResendEligible(recipient) {
  if (!recipient) {
    return false;
  }
  const status = (recipient.status || '').toString().toLowerCase();
  const errorCode = recipient.errorCode ?? recipient.error_code ?? null;
  if (status === 'failed' && errorCode !== null && errorCode !== undefined && errorCode !== '') {
    return true;
  }
  return isMetaLimitedRecipient(recipient);
}

function collapseRecipientsByPhone(recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return [];
  }
  const latestByPhone = new Map();
  recipients.forEach((recipient) => {
    const phone = recipient?.phone || recipient?.customer_phone || '';
    if (!phone) {
      return;
    }
    const timestamp = new Date(
      recipient?.lastStatusUpdate || recipient?.sentDate || recipient?.sent_at || 0
    ).getTime();
    const existing = latestByPhone.get(phone);
    if (!existing) {
      latestByPhone.set(phone, recipient);
      return;
    }
    const existingTime = new Date(
      existing?.lastStatusUpdate || existing?.sentDate || existing?.sent_at || 0
    ).getTime();
    if (timestamp >= existingTime) {
      latestByPhone.set(phone, recipient);
    }
  });
  return Array.from(latestByPhone.values());
}

function summarizeCampaignRecipients(recipients) {
  const summary = { total: 0, success: 0, failed: 0, pending: 0 };
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return summary;
  }
  summary.total = recipients.length;
  recipients.forEach((recipient) => {
    const status = (recipient?.status || '').toString().toLowerCase();
    const errorCode = recipient?.errorCode ?? recipient?.error_code ?? null;
    const hasErrorCode = errorCode !== null && errorCode !== undefined && errorCode !== '';
    const isFailed = status === 'failed' || hasErrorCode;
    const isDelivered = status === 'delivered' || status === 'read';
    if (isFailed) {
      summary.failed += 1;
      return;
    }
    if (isDelivered) {
      summary.success += 1;
      return;
    }
    summary.pending += 1;
  });
  return summary;
}

function normalizeResendSettingsInput(payload) {
  if (!payload) {
    return { enabled: false };
  }
  const enabled = Boolean(payload.enabled);
  if (!enabled) {
    return { enabled: false };
  }
  return {
    enabled: true,
    delayOption: payload.delayOption || payload.delay_option || null,
  };
}

async function runWithConcurrency(items, worker, concurrency) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const results = new Array(items.length);
  let currentIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  const runWorker = async () => {
    while (true) {
      const index = currentIndex++;
      if (index >= items.length) {
        break;
      }
      results[index] = await worker(items[index], index);
    }
  };

  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function normalizePhoneNumber(value) {
  if (!value) {
    return null;
  }
  const digits = value.toString().replace(/[^\d]/g, '');
  if (!digits) {
    return null;
  }
  if (digits.length > 10) {
    return digits.slice(-10);
  }
  return digits;
}

function choosePreferredPhoneNumber(current, candidate) {
  if (!candidate) {
    return current;
  }
  if (!current) {
    return candidate;
  }

  const candidateHasPlus = candidate.startsWith('+');
  const currentHasPlus = current.startsWith('+');

  if (candidateHasPlus && !currentHasPlus) {
    return candidate;
  }

  if (candidateHasPlus === currentHasPlus) {
    if (candidate.length > current.length) {
      return candidate;
    }
  }

  return current;
}

function collectPhoneVariants(targetSet, value) {
  if (!value) {
    return;
  }
  const trimmed = value.toString().trim();
  if (!trimmed) {
    return;
  }
  targetSet.add(trimmed);
  const withoutPlus = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  if (withoutPlus && withoutPlus !== trimmed) {
    targetSet.add(withoutPlus);
  }
  const normalized = normalizePhoneNumber(trimmed);
  if (normalized) {
    targetSet.add(normalized);
    if (DEFAULT_COUNTRY_CODE) {
      const prefixed = `${DEFAULT_COUNTRY_CODE}${normalized}`;
      const withPlus = `+${prefixed}`;
      targetSet.add(prefixed);
      targetSet.add(withPlus);
    }
  }
}

function extractDigits(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return value.toString().replace(/[^\d]/g, '');
}

function isZeroPlaceholderPhone(value) {
  const digits = extractDigits(value);
  if (digits.length < 10) {
    return false;
  }
  const lastTen = digits.slice(-10);
  return /^0+$/.test(lastTen);
}

async function getBillSlugRecord(storeId, invoiceIdentifier) {
  if (!BILL_SLUG_TABLE) {
    throw new Error('Bill slug table not configured');
  }

  const attempts = [];
  const normalized = invoiceIdentifier ? invoiceIdentifier.toString().trim() : '';
  if (normalized) {
    attempts.push(normalized);
    const withoutPdf = normalized.replace(/\.pdf$/i, '');
    if (withoutPdf !== normalized) {
      attempts.push(withoutPdf);
    }
  }

  const attemptedKeys = [];

  for (const attempt of attempts) {
    attemptedKeys.push(attempt);
  }

  if (attempts.length === 0) {
    return { item: null, attemptedKeys };
  }

  const baseExpressionAttributeNames = {
    '#invoice_id': 'invoice_id',
  };
  const baseExpressionAttributeValues = {};
  attempts.forEach((value, index) => {
    baseExpressionAttributeValues[`:invoiceId${index}`] = value;
  });

  let queriedViaIndex = false;
  try {
    const invoiceIndexName = process.env.BILL_SLUG_INVOICE_ID_INDEX || 'invoice_id_slug';
    for (const [index] of attempts.entries()) {
      let lastEvaluatedKey = undefined;
      const expressionAttributeNames = { ...baseExpressionAttributeNames };
      const expressionAttributeValues = {
        [`:invoiceId${index}`]: baseExpressionAttributeValues[`:invoiceId${index}`],
      };
      do {
        const response = await docClient.send(
          new QueryCommand({
            TableName: BILL_SLUG_TABLE,
            IndexName: invoiceIndexName,
            KeyConditionExpression: `#invoice_id = :invoiceId${index}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ExclusiveStartKey: lastEvaluatedKey,
            Limit: 1,
          })
        );
        queriedViaIndex = true;

        if (response.Items && response.Items.length > 0) {
          return {
            item: response.Items[0],
            attemptedKeys,
          };
        }

        lastEvaluatedKey = response.LastEvaluatedKey;
      } while (lastEvaluatedKey);
    }
  } catch (error) {
    const message = error?.message || '';
    if (
      error?.name === 'ResourceNotFoundException' ||
      /Requested resource not found/i.test(message)
    ) {
      logger.error('Bill slug table or index not found', {
        tableName: BILL_SLUG_TABLE,
        indexName: process.env.BILL_SLUG_INVOICE_ID_INDEX || 'invoice_id_slug',
        error: message,
      });
      throw new Error('Bill slug table or index not found');
    }
    logger.warn('Query lookup for bill slug failed, falling back to scan', {
      storeId,
      invoiceIdentifier,
      error: message,
    });
  }

  if (queriedViaIndex) {
    logger.warn('No bill slug found via invoice_id index, considering scan fallback', {
      storeId,
      invoiceIdentifier,
      attemptedKeys,
    });
  }

  const allowScanFallback = process.env.BILL_SLUG_ALLOW_SCAN === 'true';
  if (!allowScanFallback) {
    return { item: null, attemptedKeys };
  }

  try {
    const invoiceConditions = attempts
      .map((_, index) => `#invoice_id = :invoiceId${index}`)
      .join(' OR ');
    const expressionAttributeNames = {
      '#store_id': 'store_id',
      '#invoice_id': 'invoice_id',
    };
    const expressionAttributeValues = {
      ':storeId': storeId,
    };
    attempts.forEach((value, index) => {
      expressionAttributeValues[`:invoiceId${index}`] = value;
    });
    const filterExpression = `#store_id = :storeId AND (${invoiceConditions})`;
    let lastEvaluatedKey = undefined;
    do {
      const response = await docClient.send(
        new ScanCommand({
          TableName: BILL_SLUG_TABLE,
          FilterExpression: filterExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ExclusiveStartKey: lastEvaluatedKey,
          Limit: 1,
        })
      );

      if (response.Items && response.Items.length > 0) {
        return {
          item: response.Items[0],
          attemptedKeys,
        };
      }

      lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);
  } catch (error) {
    const message = error?.message || '';
    if (
      error?.name === 'ResourceNotFoundException' ||
      /Requested resource not found/i.test(message)
    ) {
      logger.error('Bill slug table not found', {
        tableName: BILL_SLUG_TABLE,
        error: message,
      });
      throw new Error('Bill slug table not found');
    }
    logger.error('Error scanning bill slug records', {
      storeId,
      invoiceIdentifier,
      attempts,
      error: message,
    });
    throw error;
  }

  return { item: null, attemptedKeys };
}

async function findInvoiceRecordForUpdate(storeId, invoiceNo, invoiceId) {
  if (!INVOICES_TABLE) {
    return null;
  }

  const invoiceFilters = [];
  const expressionAttributeNames = {
    '#store_id': 'store_id',
  };
  const expressionAttributeValues = {
    ':storeId': storeId,
  };

  if (invoiceNo) {
    expressionAttributeNames['#invoice_no'] = 'invoice_no';
    expressionAttributeValues[':invoiceNo'] = invoiceNo.toString().trim();
    invoiceFilters.push('#invoice_no = :invoiceNo');
  }

  if (invoiceId) {
    expressionAttributeNames['#invoice_id'] = 'invoice_id';
    expressionAttributeValues[':invoiceId'] = invoiceId.toString().trim();
    invoiceFilters.push('#invoice_id = :invoiceId');
  }

  if (!invoiceFilters.length) {
    return null;
  }

  const filterExpressionParts = ['#store_id = :storeId'];
  if (invoiceFilters.length) {
    filterExpressionParts.push(`(${invoiceFilters.join(' OR ')})`);
  }

  const scanParams = {
    TableName: INVOICES_TABLE,
    FilterExpression: filterExpressionParts.join(' AND '),
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    Limit: 1,
  };

  const result = await docClient.send(new ScanCommand(scanParams));
  if (result?.Items && result.Items.length > 0) {
    return result.Items[0];
  }
  return null;
}

async function updateInvoiceCustomerPhoneRecord(storeId, invoiceNo, invoiceId, phoneNumber) {
  try {
    if (!INVOICES_TABLE) {
      return false;
    }

    const normalizedStoreId =
      storeId !== undefined && storeId !== null ? storeId.toString().trim() : '';
    if (!normalizedStoreId) {
      return false;
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);

    const buildUpdateParams = (key, conditionAttr) => {
      const expressionAttributeNames = {
        '#customer_phone': 'customer_phone',
      };
      const expressionAttributeValues = {
        ':phone': phoneNumber,
      };

      let updateExpression = 'SET #customer_phone = :phone';

      expressionAttributeNames['#normalized_customer_phone'] = 'normalized_customer_phone';

      if (normalizedPhone) {
        expressionAttributeValues[':normalized_customer_phone'] = normalizedPhone;
        updateExpression += ', #normalized_customer_phone = :normalized_customer_phone';
      }

      let finalExpression = updateExpression;
      if (!normalizedPhone) {
        finalExpression += ' REMOVE #normalized_customer_phone';
      }

      const params = {
        TableName: INVOICES_TABLE,
        Key: key,
        UpdateExpression: finalExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      };

      if (conditionAttr) {
        expressionAttributeNames['#__cond'] = conditionAttr;
        params.ConditionExpression = 'attribute_exists(#__cond)';
      }

      return params;
    };

    const tryKeyUpdate = async (key, conditionAttr) => {
      if (!key || Object.keys(key).length === 0) {
        return false;
      }
      try {
        const params = buildUpdateParams(key, conditionAttr);
        await docClient.send(new UpdateCommand(params));
        return true;
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') {
          return false;
        }
        if (error.name === 'ValidationException' || error.name === 'ResourceNotFoundException') {
          return false;
        }
        logger.warn('Attempt to update invoice customer phone failed', {
          storeId,
          invoiceNo,
          invoiceId,
          key,
          error: error.message,
        });
        return false;
      }
    };

    let updated = false;
    if (invoiceId) {
      updated = await tryKeyUpdate(
        {
          store_id: normalizedStoreId,
          invoice_id: invoiceId.toString().trim(),
        },
        'invoice_id'
      );
    }

    if (!updated && invoiceNo) {
      updated = await tryKeyUpdate(
        {
          store_id: normalizedStoreId,
          invoice_no: invoiceNo.toString().trim(),
        },
        'invoice_no'
      );
    }

    if (updated) {
      return true;
    }

    const record = await findInvoiceRecordForUpdate(normalizedStoreId, invoiceNo, invoiceId);
    if (!record) {
      logger.warn('Invoice record not found while updating customer phone', {
        storeId,
        invoiceNo,
        invoiceId,
      });
      return false;
    }

    const updatedRecord = {
      ...record,
      customer_phone: phoneNumber,
    };

    if (normalizedPhone) {
      updatedRecord.normalized_customer_phone = normalizedPhone;
    } else {
      delete updatedRecord.normalized_customer_phone;
    }

    Object.keys(updatedRecord).forEach((key) => {
      if (updatedRecord[key] === undefined) {
        delete updatedRecord[key];
      }
    });

    await docClient.send(
      new PutCommand({
        TableName: INVOICES_TABLE,
        Item: updatedRecord,
      })
    );

    return true;
  } catch (error) {
    logger.error('Failed to update invoice customer phone', {
      storeId,
      invoiceNo,
      invoiceId,
      error: error.message,
    });
    return false;
  }
}

async function getStoreConfigById(storeId) {
  if (!storeId) {
    return null;
  }

  try {
    const response = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );
    return response.Item || null;
  } catch (error) {
    logger.error('Error fetching store WhatsApp config', {
      storeId,
      error: error.message,
    });
    throw error;
  }
}

function buildStoreContextFromItem(item) {
  if (!item?.store_id) {
    return null;
  }

  return {
    storeId: item.store_id,
    wabaId: item.waba_id || null,
    phoneNumberId: item.phone_number_id || null,
    verifiedName: item.verified_name || null,
    accessToken: item.access_token || null,
    whatsappApiUrl: item.whatsapp_api_url || null,
    displayPhoneNumber: item.waba_mobile_number || null,
  };
}

async function queryStoreByPhoneNumber(phoneNumberId, wabaId) {
  if (!phoneNumberId || !STORE_CONFIG_PHONE_INDEX || storePhoneIndexUnavailable) {
    return null;
  }

  const keyExpressionParts = ['#phone_number_id = :phoneNumberId'];
  const expressionAttributeNames = {
    '#phone_number_id': 'phone_number_id',
  };
  const expressionAttributeValues = {
    ':phoneNumberId': phoneNumberId,
  };

  if (wabaId) {
    keyExpressionParts.push('#waba_id = :wabaId');
    expressionAttributeNames['#waba_id'] = 'waba_id';
    expressionAttributeValues[':wabaId'] = wabaId;
  }

  try {
    const queryResult = await docClient.send(
      new QueryCommand({
        TableName: STORE_CONFIG_TABLE,
        IndexName: STORE_CONFIG_PHONE_INDEX,
        KeyConditionExpression: keyExpressionParts.join(' AND '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: 1,
      })
    );

    return queryResult.Items?.[0] || null;
  } catch (error) {
    if (error.name === 'ValidationException') {
      storePhoneIndexUnavailable = true;
      logger.warn('Store phone lookup index unavailable, falling back to table scan', {
        indexName: STORE_CONFIG_PHONE_INDEX,
        error: error.message,
      });
    } else {
      logger.error('Failed to query store config by phone number', {
        phoneNumberId,
        wabaId,
        error: error.message,
      });
    }
    return null;
  }
}

async function scanStoreConfig(filterExpression, expressionNames, expressionValues) {
  let lastEvaluatedKey = undefined;

  do {
    const scanResult = await docClient.send(
      new ScanCommand({
        TableName: STORE_CONFIG_TABLE,
        FilterExpression: filterExpression,
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    if (scanResult.Items && scanResult.Items.length > 0) {
      return scanResult.Items[0];
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return null;
}

async function resolveStoreContext({ phoneNumberId, wabaId, displayPhoneNumber }) {
  const cacheKey = phoneNumberId || wabaId || displayPhoneNumber;
  if (cacheKey) {
    const candidateIds = new Set();
    if (phoneNumberId) {
      candidateIds.add(phoneNumberId);
      const normalized = phoneNumberId.toString().trim();
      if (normalized && !candidateIds.has(normalized)) {
        candidateIds.add(normalized);
      }
    }
    ['+', ''].forEach((prefix) => {
      if (phoneNumberId && phoneNumberId.startsWith(prefix + DEFAULT_COUNTRY_CODE)) {
        const trimmed = phoneNumberId.replace(prefix + DEFAULT_COUNTRY_CODE, '');
        if (trimmed) {
          candidateIds.add(trimmed);
        }
      }
    });
    for (const candidate of candidateIds) {
      if (phoneNumberStoreCache.has(candidate)) {
        return phoneNumberStoreCache.get(candidate);
      }
    }
    if (wabaId) {
      if (wabaStoreCache.has(wabaId)) {
        return wabaStoreCache.get(wabaId);
      }
      const trimmed = wabaId.trim();
      if (trimmed && trimmed !== wabaId && wabaStoreCache.has(trimmed)) {
        return wabaStoreCache.get(trimmed);
      }
    }
    if (displayPhoneNumber) {
      if (displayPhoneStoreCache.has(displayPhoneNumber)) {
        return displayPhoneStoreCache.get(displayPhoneNumber);
      }
      const normalizedDisplay = displayPhoneNumber.replace(/[^\d+]/g, '');
      if (normalizedDisplay && displayPhoneStoreCache.has(normalizedDisplay)) {
        return displayPhoneStoreCache.get(normalizedDisplay);
      }
      const digits = normalizePhoneWithDefaultCountry(displayPhoneNumber);
      if (digits) {
        if (displayPhoneStoreCache.has(digits)) {
          return displayPhoneStoreCache.get(digits);
        }
        const e164 = `+${digits}`;
        if (displayPhoneStoreCache.has(e164)) {
          return displayPhoneStoreCache.get(e164);
        }
      }
    }
  }

  const filters = [];
  const expressionNames = {};
  const expressionValues = {};

  if (phoneNumberId) {
    filters.push('#phone_number_id = :phoneNumberId');
    expressionNames['#phone_number_id'] = 'phone_number_id';
    expressionValues[':phoneNumberId'] = phoneNumberId;
  }

  if (displayPhoneNumber) {
    filters.push('#waba_display_phone = :displayPhoneNumber');
    expressionNames['#waba_display_phone'] = 'waba_mobile_number';
    expressionValues[':displayPhoneNumber'] = displayPhoneNumber;
  }

  if (wabaId) {
    filters.push('#waba_id = :wabaId');
    expressionNames['#waba_id'] = 'waba_id';
    expressionValues[':wabaId'] = wabaId;
  }

  if (filters.length === 0) {
    return null;
  }

  try {
    let item = await queryStoreByPhoneNumber(phoneNumberId, wabaId);

    if (!item) {
      const filterExpression =
        filters.length === 1 ? filters[0] : filters.map((expr) => `(${expr})`).join(' OR ');
      item = await scanStoreConfig(filterExpression, expressionNames, expressionValues);
    }

    const context = buildStoreContextFromItem(item);
    if (!context) {
      return null;
    }

    if (context.phoneNumberId) {
      phoneNumberStoreCache.set(context.phoneNumberId, context);
    }
    if (context.wabaId) {
      wabaStoreCache.set(context.wabaId, context);
    }
    if (displayPhoneNumber) {
      displayPhoneStoreCache.set(displayPhoneNumber, context);
    }

    return context;
  } catch (error) {
    logger.error('Failed to resolve store context', {
      phoneNumberId,
      wabaId,
      displayPhoneNumber,
      error: error.message,
    });
    return null;
  }
}

async function persistWhatsAppMessage({
  storeId,
  customerPhone,
  direction,
  messageType,
  timestamp,
  messageId = null,
  text = '',
  status = null,
  customerName = null,
  metadata = {},
  campaignName = null,
  campaignId = null,
  workflowId = null,
  templateName = null,
  mediaId = null,
  mediaMetadata = null,
  locationMetadata = null,
  orderMetadata = null,
}) {
  if (!storeId || !customerPhone || !timestamp) {
    return;
  }

  const normalizedPhone = normalizePhoneNumber(customerPhone);

  const item = {
    store_id: storeId,
    timestamp,
    customer_phone: customerPhone,
    normalized_customer_phone: normalizedPhone || null,
    direction,
    message_type: messageType,
    body: text,
    message_id: messageId,
    status,
    customer_name: customerName,
    status_history: status
      ? [
          {
            status,
            timestamp,
          },
        ]
      : [],
    phone_number_id: metadata.phoneNumberId || null,
    waba_id: metadata.wabaId || null,
    display_phone_number: metadata.displayPhoneNumber || null,
    raw_metadata: metadata.raw || null,
    campaign_name: campaignName || null,
    campaign_id: campaignId || null,
    workflow_id: workflowId || null,
    template_name: templateName || null,
    media_id: mediaId || null,
    media_metadata: mediaMetadata || null,
    location_metadata: locationMetadata || null,
    order_metadata: orderMetadata || null,
  };

  if (!item.body) {
    delete item.body;
  }
  if (!item.message_id) {
    delete item.message_id;
  }
  if (!item.status) {
    delete item.status;
  }
  if (!item.status_history || item.status_history.length === 0) {
    delete item.status_history;
  }
  if (!item.customer_name) {
    delete item.customer_name;
  }
  if (!item.phone_number_id) {
    delete item.phone_number_id;
  }
  if (!item.waba_id) {
    delete item.waba_id;
  }
  if (!item.display_phone_number) {
    delete item.display_phone_number;
  }
  if (!item.raw_metadata) {
    delete item.raw_metadata;
  }
  if (!item.normalized_customer_phone) {
    delete item.normalized_customer_phone;
  }
  if (!item.campaign_name) {
    delete item.campaign_name;
  }
  if (!item.campaign_id) {
    delete item.campaign_id;
  }
  if (!item.workflow_id) {
    delete item.workflow_id;
  }
  if (!item.template_name) {
    delete item.template_name;
  }
  if (!item.media_id) {
    delete item.media_id;
  }
  if (!item.media_metadata) {
    delete item.media_metadata;
  }
  if (!item.location_metadata) {
    delete item.location_metadata;
  }
  if (!item.order_metadata) {
    delete item.order_metadata;
  }

  try {
    await docClient.send(
      new PutCommand({
        TableName: WHATSAPP_MESSAGES_TABLE,
        Item: item,
      })
    );
  } catch (error) {
    logger.error('Failed to persist WhatsApp message', {
      storeId,
      customerPhone,
      direction,
      messageId,
      error: error.message,
    });
  }
}

async function appendMessageStatus({ storeId, customerPhone, messageId, status, statusTimestamp }) {
  if (!storeId || !customerPhone || !messageId) {
    return;
  }

  try {
    const queryResult = await docClient.send(
      new QueryCommand({
        TableName: WHATSAPP_MESSAGES_TABLE,
        IndexName: WHATSAPP_MESSAGES_CUSTOMER_INDEX,
        KeyConditionExpression: 'customer_phone = :phone',
        ExpressionAttributeValues: {
          ':phone': customerPhone,
          ':store': storeId,
          ':messageId': messageId,
        },
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
          '#message_id': 'message_id',
        },
        FilterExpression: '#store_id = :store AND #message_id = :messageId',
        Limit: 1,
      })
    );

    const target = queryResult.Items?.[0];

    if (!target) {
      logger.warn('No stored message found for status update', {
        storeId,
        customerPhone,
        messageId,
        status,
      });
      return;
    }

    await docClient.send(
      new UpdateCommand({
        TableName: WHATSAPP_MESSAGES_TABLE,
        Key: {
          store_id: target.store_id,
          timestamp: target.timestamp,
        },
        UpdateExpression:
          'SET #status = :status, #history = list_append(if_not_exists(#history, :empty), :entry)',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#history': 'status_history',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':entry': [
            {
              status,
              timestamp: statusTimestamp,
            },
          ],
          ':empty': [],
        },
      })
    );
  } catch (error) {
    logger.error('Failed to append message status', {
      storeId,
      customerPhone,
      messageId,
      status,
      error: error.message,
    });
  }
}

function extractInboundMessageDetails(message) {
  const baseType = typeof message?.type === 'string' ? message.type.toLowerCase() : 'text';
  let text =
    message?.text?.body ||
    message?.interactive?.list_reply?.title ||
    message?.interactive?.button_reply?.title ||
    '';
  const triggerCandidates = [
    message?.interactive?.button_reply?.id,
    message?.interactive?.button_reply?.title,
    message?.interactive?.list_reply?.id,
    message?.interactive?.list_reply?.title,
    message?.text?.body,
  ]
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  let mediaId = null;
  let mediaMetadata = null;
  let locationMetadata = null;
  let orderMetadata = null;

  switch (baseType) {
    case 'image': {
      mediaId = message.image?.id || null;
      mediaMetadata = {
        id: mediaId,
        mimeType: message.image?.mime_type || null,
        sha256: message.image?.sha256 || null,
        caption: message.image?.caption || null,
      };
      text = message.image?.caption || '[Photo]';
      break;
    }
    case 'video': {
      mediaId = message.video?.id || null;
      mediaMetadata = {
        id: mediaId,
        mimeType: message.video?.mime_type || null,
        sha256: message.video?.sha256 || null,
        caption: message.video?.caption || null,
        thumbnail: message.video?.thumbnail || null,
      };
      text = message.video?.caption || '[Video]';
      break;
    }
    case 'audio': {
      mediaId = message.audio?.id || null;
      mediaMetadata = {
        id: mediaId,
        mimeType: message.audio?.mime_type || null,
        sha256: message.audio?.sha256 || null,
        voice: message.audio?.voice ?? null,
      };
      text = '[Audio message]';
      break;
    }
    case 'document': {
      mediaId = message.document?.id || null;
      mediaMetadata = {
        id: mediaId,
        mimeType: message.document?.mime_type || null,
        sha256: message.document?.sha256 || null,
        fileName: message.document?.filename || null,
        caption: message.document?.caption || null,
      };
      text = message.document?.filename ? `Document: ${message.document.filename}` : '[Document]';
      break;
    }
    case 'sticker': {
      mediaId = message.sticker?.id || null;
      mediaMetadata = {
        id: mediaId,
        mimeType: message.sticker?.mime_type || null,
        sha256: message.sticker?.sha256 || null,
        animated: message.sticker?.animated ?? null,
      };
      text = '[Sticker]';
      break;
    }
    case 'location': {
      locationMetadata = {
        latitude:
          typeof message.location?.latitude === 'number'
            ? message.location.latitude
            : Number(message.location?.latitude) || null,
        longitude:
          typeof message.location?.longitude === 'number'
            ? message.location.longitude
            : Number(message.location?.longitude) || null,
        name: message.location?.name || null,
        address: message.location?.address || null,
        url: message.location?.url || null,
      };
      text = locationMetadata.name ? `Location: ${locationMetadata.name}` : 'Shared a location';
      break;
    }
    case 'order': {
      const order = message?.order || {};
      const items = Array.isArray(order.product_items) ? order.product_items : [];
      const orderText = typeof order.text === 'string' ? order.text.trim() : '';
      const lines = [];

      if (orderText) {
        lines.push(orderText);
      }

      const itemCount = items.length;
      lines.push(`Order received (${itemCount} item${itemCount === 1 ? '' : 's'})`);

      const total = items.reduce((sum, item) => {
        const quantity = Number(item?.quantity || 0) || 0;
        const price = Number(item?.item_price || 0) || 0;
        return sum + quantity * price;
      }, 0);
      const currency = items.find((item) => item?.currency)?.currency || '';
      if (total > 0) {
        lines.push(`Estimated total: ${currency ? `${currency} ` : ''}${total}`);
      }

      items.forEach((item) => {
        const quantity = Number(item?.quantity || 0) || 1;
        const label = item?.name || item?.product_retailer_id || item?.item_id || 'Item';
        const price = item?.item_price ? ` @ ${item.item_price}` : '';
        lines.push(`- ${quantity} x ${label}${price}`);
      });

      text = lines.join('\n');
      orderMetadata = {
        catalog_id: order.catalog_id || null,
        text: orderText || null,
        product_items: items,
      };
      break;
    }
    default: {
      if (!text) {
        text = '[Unsupported message type]';
      }
    }
  }

  return {
    type: baseType,
    text,
    triggerCandidates,
    mediaId,
    mediaMetadata,
    locationMetadata,
    orderMetadata,
  };
}

const buildOrderSummaryText = (orderText, items) => {
  const lines = [];
  if (orderText) {
    lines.push(orderText);
  }
  const itemCount = items.length;
  lines.push(`Order received (${itemCount} item${itemCount === 1 ? '' : 's'})`);
  const total = items.reduce((sum, item) => {
    const quantity = Number(item?.quantity || 0) || 0;
    const price = Number(item?.item_price || 0) || 0;
    return sum + quantity * price;
  }, 0);
  const currency = items.find((item) => item?.currency)?.currency || '';
  if (total > 0) {
    lines.push(`Estimated total: ${currency ? `${currency} ` : ''}${total}`);
  }
  items.forEach((item) => {
    const quantity = Number(item?.quantity || 0) || 1;
    const label = item?.name || item?.product_retailer_id || item?.item_id || 'Item';
    const price = item?.item_price ? ` @ ${item.item_price}` : '';
    lines.push(`- ${quantity} x ${label}${price}`);
  });
  return lines.join('\n');
};

const normalizeMatchText = (value) => (value || '').toString().toLowerCase().trim();

const buildPayloadFromTitle = (title) => {
  if (!title) {
    return '';
  }
  return title
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
};

const matchKeywordTrigger = (triggerConfig, inboundText) => {
  if (!triggerConfig || !Array.isArray(triggerConfig.keywords)) {
    return false;
  }
  const normalizedMessage = normalizeMatchText(inboundText);
  if (!normalizedMessage) {
    return false;
  }
  const requestedMatchType = String(triggerConfig.match || '').toLowerCase();
  const matchType =
    requestedMatchType === 'any'
      ? 'any'
      : requestedMatchType === 'contains'
        ? 'contains'
        : 'equals';
  const keywords = triggerConfig.keywords.map((item) => normalizeMatchText(item)).filter(Boolean);
  if (matchType === 'equals') {
    if (!keywords.length) {
      return false;
    }
    return keywords.some((keyword) => normalizedMessage === keyword);
  }
  if (matchType === 'any') {
    return true;
  }
  if (matchType === 'contains') {
    if (!keywords.length) {
      return false;
    }
    return keywords.some((keyword) => normalizedMessage.includes(keyword));
  }
  return false;
};

const findWorkflowMatch = (workflows, inboundText) => {
  if (!Array.isArray(workflows) || !workflows.length) {
    return null;
  }

  const exactMatches = [];
  const anyMatches = [];
  const containsMatches = [];

  for (const workflow of workflows) {
    if (!workflow || workflow.status !== 'live') {
      continue;
    }
    const spec = workflow.spec || {};
    const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
    const triggerNode = nodes.find((node) => node?.type === 'TRIGGER');
    const triggerConfig = triggerNode?.config || {};
    const triggerType = String(triggerConfig.trigger_type || '').toLowerCase();
    if (triggerType !== 'keyword') {
      continue;
    }
    if (!matchKeywordTrigger(triggerConfig, inboundText)) {
      continue;
    }
    const requestedMatchType = String(triggerConfig.match || '').toLowerCase();
    const matchType =
      requestedMatchType === 'any'
        ? 'any'
        : requestedMatchType === 'contains'
          ? 'contains'
          : 'equals';
    if (matchType === 'equals') {
      exactMatches.push(workflow);
    } else if (matchType === 'any') {
      anyMatches.push(workflow);
    } else {
      containsMatches.push(workflow);
    }
  }

  if (exactMatches.length) {
    return exactMatches[0];
  }
  if (containsMatches.length) {
    return containsMatches[0];
  }
  if (anyMatches.length) {
    return anyMatches[0];
  }

  return null;
};

const pickReplyMessageNode = (spec) => {
  const nodes = Array.isArray(spec?.nodes) ? spec.nodes : [];
  const messageNodes = nodes.filter((node) => node?.type === 'MESSAGE');
  if (!messageNodes.length) {
    return null;
  }
  return (
    messageNodes.find((node) => String(node?.name || '').includes('Matched')) ||
    messageNodes.find((node) => String(node?.name || '').includes('Auto reply')) ||
    messageNodes[0]
  );
};

const resolveVariableValue = (variable, context) => {
  if (!variable) {
    return '';
  }
  const fallback = typeof variable.fallback === 'string' ? variable.fallback : '';
  const valueType = typeof variable.value === 'string' ? variable.value : '';
  if (valueType === 'phone') {
    return context.customerPhone || fallback;
  }
  if (valueType === 'id') {
    return context.inboundMessageId || fallback;
  }
  if (valueType === 'user_id') {
    return context.customerPhone || fallback;
  }
  return fallback;
};

const applyVariablesToText = (text, variables, context) => {
  if (!text || !Array.isArray(variables) || variables.length === 0) {
    return text || '';
  }
  let nextText = text;
  variables.forEach((variable) => {
    const token = typeof variable.token === 'string' ? variable.token : '';
    if (!token) {
      return;
    }
    const value = resolveVariableValue(variable, context);
    nextText = nextText.split(token).join(value);
  });
  return nextText;
};

const resolveAutomationText = (messageConfig, variableContext) =>
  applyVariablesToText(
    messageConfig?.text || '',
    Array.isArray(messageConfig?.variables) ? messageConfig.variables : [],
    variableContext
  );

const parseDataUrl = (dataUrl) => {
  if (!dataUrl || typeof dataUrl !== 'string') {
    return null;
  }
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1],
    base64: match[2],
  };
};

const uploadAutomationAttachment = async ({ attachment, accessToken, phoneNumberId }) => {
  if (!attachment?.url || !accessToken || !phoneNumberId) {
    return null;
  }
  const parsed = parseDataUrl(attachment.url);
  if (!parsed?.base64) {
    return null;
  }
  const buffer = Buffer.from(parsed.base64, 'base64');
  const filename = attachment.name || 'attachment';
  const mimeType = attachment.mime_type || parsed.mimeType || 'application/octet-stream';
  const uploadUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`;
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', buffer, {
    filename,
    contentType: mimeType,
  });
  const uploadResponse = await axios.post(uploadUrl, formData, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...formData.getHeaders(),
    },
    maxBodyLength: Infinity,
  });
  return uploadResponse.data?.id || null;
};

const buildAutomationMessagePayload = (messageConfig, _inboundMessageId, variableContext) => {
  if (!messageConfig) {
    return null;
  }
  const messageType = String(messageConfig.message_type || 'plain').toLowerCase();
  const sanitizeButtonTitle = (title) => {
    const cleaned = String(title || '')
      .replace(/[↩↪→←]/g, '')
      .trim();
    return cleaned || 'Option';
  };
  const resolvedText = resolveAutomationText(messageConfig, variableContext);
  if (messageType === 'buttons') {
    const buttons = Array.isArray(messageConfig.buttons) ? messageConfig.buttons : [];
    const formattedButtons = buttons
      .map((button) => ({
        type: 'reply',
        reply: {
          id: button.payload || buildPayloadFromTitle(button.title),
          title: sanitizeButtonTitle(button.title),
        },
      }))
      .slice(0, 3);
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: resolvedText || 'Please choose an option.' },
        action: { buttons: formattedButtons },
      },
    };
  }
  if (messageType === 'list') {
    const sections = Array.isArray(messageConfig.sections) ? messageConfig.sections : [];
    return {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: resolvedText || 'Please choose an option.' },
        action: {
          button: messageConfig.button_text || 'View options',
          sections: sections.map((section) => ({
            title: section.title || 'Options',
            rows: (section.rows || []).map((row) => ({
              id: row.payload || buildPayloadFromTitle(row.title),
              title: row.title || 'Option',
              description: row.description || undefined,
            })),
          })),
        },
      },
    };
  }
  if (messageType === 'product_list') {
    const items = Array.isArray(messageConfig.product_items) ? messageConfig.product_items : [];
    const catalogId = messageConfig.catalog_id || messageConfig.catalogId || null;
    if (!catalogId || items.length === 0) {
      return null;
    }
    const productItems = items
      .map((item) => ({
        product_retailer_id: item.product_retailer_id || item.id || '',
      }))
      .filter((item) => item.product_retailer_id);
    if (productItems.length === 0) {
      return null;
    }
    const rawHeaderText =
      messageConfig.header_text ||
      messageConfig.headerText ||
      messageConfig.section_title ||
      'Products';
    const headerText = rawHeaderText.toString().trim().slice(0, 60) || 'Products';
    return {
      type: 'interactive',
      interactive: {
        type: 'product_list',
        header: {
          type: 'text',
          text: headerText,
        },
        body: { text: resolvedText || 'Browse products' },
        action: {
          catalog_id: catalogId,
          sections: [
            {
              title: messageConfig.section_title || 'All Products',
              product_items: productItems,
            },
          ],
        },
      },
    };
  }
  if (messageType === 'image') {
    return {
      type: 'image',
      image: {
        link: messageConfig.media_url,
        caption: resolvedText || undefined,
      },
    };
  }
  if (messageType === 'video') {
    return {
      type: 'video',
      video: {
        link: messageConfig.media_url,
        caption: resolvedText || undefined,
      },
    };
  }
  if (messageType === 'template') {
    const components = Array.isArray(messageConfig.components) ? messageConfig.components : null;
    const variableValues = messageConfig.variables
      ? Object.values(messageConfig.variables).map((value) => String(value ?? ''))
      : [];
    const resolvedComponents =
      components ||
      (variableValues.length
        ? [
            {
              type: 'body',
              parameters: variableValues.map((value) => ({
                type: 'text',
                text: value,
              })),
            },
          ]
        : undefined);
    return {
      type: 'template',
      template: {
        name: messageConfig.template_id || messageConfig.template_name,
        language: { code: messageConfig.language || 'en_US' },
        ...(resolvedComponents ? { components: resolvedComponents } : {}),
      },
    };
  }
  return {
    type: 'text',
    text: { body: resolvedText || '' },
  };
};

const buildWhatsAppApiUrl = (metadata = {}) => {
  if (metadata.whatsappApiUrl) {
    return metadata.whatsappApiUrl;
  }
  if (metadata.phoneNumberId) {
    return `https://graph.facebook.com/${GRAPH_API_VERSION}/${metadata.phoneNumberId}/messages`;
  }
  return null;
};

const sendWhatsAppMessageWithToken = async ({ to, payload, accessToken, apiUrl }) => {
  if (!accessToken || !apiUrl) {
    throw new Error('Missing WhatsApp access token or api url.');
  }
  const response = await axios.post(
    apiUrl,
    {
      messaging_product: 'whatsapp',
      to,
      ...payload,
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
  return response.data;
};

const matchAnyTrigger = (workflows, inboundTexts) => {
  if (!Array.isArray(inboundTexts) || inboundTexts.length === 0) {
    return null;
  }
  for (const candidate of inboundTexts) {
    const matched = findWorkflowMatch(workflows, candidate);
    if (matched) {
      return { matched, matchedText: candidate };
    }
  }
  return null;
};

async function handleAutomationReply({
  storeId,
  customerPhone,
  inboundTexts,
  inboundMessageId,
  metadata,
}) {
  if (!storeId || !Array.isArray(inboundTexts) || inboundTexts.length === 0) {
    if (!storeId) {
      logger.warn('Automation skipped: missing storeId', { customerPhone });
    }
    return false;
  }
  try {
    const workflows = await automationService.listWorkflows(storeId);
    if (!workflows.length) {
      logger.info('Automation skipped: no workflows found', { storeId, customerPhone });
      return false;
    }
    const liveWorkflows = workflows.filter((item) => item?.status === 'live');
    if (!liveWorkflows.length) {
      logger.info('Automation skipped: no live workflows', {
        storeId,
        customerPhone,
        totalWorkflows: workflows.length,
      });
      return false;
    }
    const matchResult = matchAnyTrigger(liveWorkflows, inboundTexts);
    if (!matchResult) {
      logger.info('Automation skipped: no live workflow match', {
        storeId,
        customerPhone,
        inboundText: inboundTexts[0],
      });
      return false;
    }
    const { matched, matchedText } = matchResult;
    logger.info('Automation workflow matched', {
      storeId,
      workflowId: matched.workflow_id,
      workflowName: matched.name,
      customerPhone,
      inboundText: matchedText,
    });
    const messageNode = pickReplyMessageNode(matched.spec || {});
    const messageConfig = messageNode?.config || null;
    if (!messageConfig) {
      return false;
    }
    const variableContext = { customerPhone, inboundMessageId };
    const messageType = String(messageConfig.message_type || 'plain').toLowerCase();

    let effectiveMetadata = metadata || {};
    let storeConfig = null;
    if (!effectiveMetadata?.accessToken || !effectiveMetadata?.phoneNumberId) {
      try {
        storeConfig = await getStoreConfigById(storeId);
        if (storeConfig) {
          effectiveMetadata = {
            ...effectiveMetadata,
            accessToken: effectiveMetadata?.accessToken || storeConfig.access_token || null,
            phoneNumberId: effectiveMetadata?.phoneNumberId || storeConfig.phone_number_id || null,
            whatsappApiUrl:
              effectiveMetadata?.whatsappApiUrl || storeConfig.whatsapp_api_url || null,
            wabaId: effectiveMetadata?.wabaId || storeConfig.waba_id || null,
            displayPhoneNumber:
              effectiveMetadata?.displayPhoneNumber || storeConfig.waba_mobile_number || null,
          };
        }
      } catch (error) {
        logger.warn('Failed to resolve store config for automation metadata', {
          storeId,
          workflowId: matched.workflow_id,
          error: error.message,
        });
      }
    }

    const apiUrl = buildWhatsAppApiUrl(effectiveMetadata || {});
    const sendAutomationPayload = async (payload) => {
      if (effectiveMetadata?.accessToken && apiUrl) {
        return sendWhatsAppMessageWithToken({
          to: customerPhone,
          payload,
          accessToken: effectiveMetadata.accessToken,
          apiUrl,
        });
      }
      logger.warn('Missing store access token or api url, using default token.', {
        storeId,
        customerPhone,
      });
      return whatsappService.sendMessage(customerPhone, payload);
    };

    if (messageType === 'product_list') {
      const items = Array.isArray(messageConfig.product_items) ? messageConfig.product_items : [];
      if (!storeConfig) {
        try {
          storeConfig = await getStoreConfigById(storeId);
        } catch (error) {
          logger.warn('Failed to resolve catalog id for automation product list', {
            storeId,
            workflowId: matched.workflow_id,
            error: error.message,
          });
        }
      }
      let effectiveCatalogId =
        storeConfig?.catalog_id || messageConfig.catalog_id || messageConfig.catalogId;
      if (!effectiveCatalogId || items.length === 0) {
        logger.warn('Automation product list skipped: missing catalog id or products', {
          storeId,
          workflowId: matched.workflow_id,
          hasCatalogId: Boolean(effectiveCatalogId),
          productCount: items.length,
        });
        return false;
      }
      effectiveCatalogId = effectiveCatalogId.toString().trim();
      let catalogRetailerIdSet = null;
      let catalogRetailerIds = null;
      if (effectiveMetadata?.accessToken) {
        try {
          const catalogItems = await fetchCatalogProducts({
            catalogId: effectiveCatalogId,
            accessToken: effectiveMetadata.accessToken,
            graphVersion: process.env.GRAPH_API_VERSION,
            limit: 200,
          });
          catalogRetailerIds = catalogItems
            .map((item) => item?.product_retailer_id || '')
            .filter(Boolean);
          catalogRetailerIdSet = new Set(catalogRetailerIds);
          logger.info('Catalog retailer ids fetched for automation', {
            storeId,
            workflowId: matched.workflow_id,
            catalogId: effectiveCatalogId,
            totalIds: catalogRetailerIds.length,
            sample: catalogRetailerIds.slice(0, 5),
          });
        } catch (error) {
          logger.warn('Failed to validate catalog product ids for automation', {
            storeId,
            workflowId: matched.workflow_id,
            error: error.message,
          });
        }
      } else {
        logger.warn('Automation product list validation skipped: missing access token', {
          storeId,
          workflowId: matched.workflow_id,
        });
      }

      const resolvedText = resolveAutomationText(messageConfig, variableContext).trim();
      const productListBody =
        (
          messageConfig.product_list_body ||
          messageConfig.productListBody ||
          messageConfig.list_body ||
          resolvedText ||
          ''
        )
          .toString()
          .trim() || 'See our products!';
      const productListConfig = {
        ...messageConfig,
        catalog_id: effectiveCatalogId,
        text: productListBody,
        product_items: catalogRetailerIdSet
          ? items.filter((item) =>
              catalogRetailerIdSet.has(item?.product_retailer_id || item?.id || '')
            )
          : items,
      };
      const payload = buildAutomationMessagePayload(
        productListConfig,
        inboundMessageId,
        variableContext
      );
      if (!payload) {
        logger.warn('Automation product list skipped: payload could not be built', {
          storeId,
          workflowId: matched.workflow_id,
        });
        return false;
      }
      if (catalogRetailerIdSet) {
        const requestedIds = items.map((item) => item?.product_retailer_id || '').filter(Boolean);
        const matchedIds = productListConfig.product_items
          .map((item) => item?.product_retailer_id || '')
          .filter(Boolean);
        const missingIds = requestedIds.filter((id) => !catalogRetailerIdSet.has(id));
        if (missingIds.length > 0) {
          logger.warn('Automation product list contains invalid retailer ids', {
            storeId,
            workflowId: matched.workflow_id,
            missingIds,
          });
        }
        if (matchedIds.length === 0 && catalogRetailerIds?.length) {
          logger.warn('Automation product list replaced with catalog items', {
            storeId,
            workflowId: matched.workflow_id,
            replacementCount: Math.min(30, catalogRetailerIds.length),
          });
          productListConfig.product_items = catalogRetailerIds
            .slice(0, 30)
            .map((id) => ({ product_retailer_id: id }));
        }
        if (productListConfig.product_items.length === 0) {
          logger.warn(
            'Automation product list skipped: no valid retailer ids after catalog check',
            {
              storeId,
              workflowId: matched.workflow_id,
            }
          );
          return false;
        }
      }

      const safePayload = JSON.parse(JSON.stringify(payload || {}));
      logger.info('Sending automation product list', {
        storeId,
        workflowId: matched.workflow_id,
        catalogId: effectiveCatalogId,
        productCount: items.length,
        phoneNumberId: effectiveMetadata?.phoneNumberId || null,
        payload: safePayload,
      });
      let response;
      try {
        response = await sendAutomationPayload(payload);
      } catch (error) {
        const status = error?.response?.status || null;
        const graphError = error?.response?.data?.error || null;
        const graphMessage =
          graphError?.error_user_msg || graphError?.message || error?.message || 'Unknown error';
        logger.error('Failed to send automation product list', {
          storeId,
          workflowId: matched.workflow_id,
          status,
          error: graphMessage,
          graphError,
        });
        return false;
      }

      const messageId = response?.messages?.[0]?.id || null;
      if (messageId && storeId) {
        await persistWhatsAppMessage({
          storeId,
          customerPhone,
          direction: 'outbound',
          messageType: payload.type || 'interactive',
          timestamp: new Date().toISOString(),
          messageId,
          text: productListBody,
          status: 'sent',
          workflowId: matched.workflow_id,
          metadata: {
            phoneNumberId: effectiveMetadata?.phoneNumberId || null,
            wabaId: effectiveMetadata?.wabaId || null,
            displayPhoneNumber: effectiveMetadata?.displayPhoneNumber || null,
          },
        });
      }

      return true;
    }
    let payload = null;

    if (
      messageConfig?.attachment?.url &&
      effectiveMetadata?.accessToken &&
      effectiveMetadata?.phoneNumberId
    ) {
      try {
        const mediaId = await uploadAutomationAttachment({
          attachment: messageConfig.attachment,
          accessToken: effectiveMetadata.accessToken,
          phoneNumberId: effectiveMetadata.phoneNumberId,
        });
        if (mediaId) {
          const resolvedText = resolveAutomationText(messageConfig, variableContext);
          const mimeType = messageConfig.attachment?.mime_type || '';
          const isImage = mimeType.startsWith('image/');
          if (isImage) {
            payload = {
              type: 'image',
              image: {
                id: mediaId,
                caption: resolvedText || undefined,
              },
            };
          } else {
            payload = {
              type: 'document',
              document: {
                id: mediaId,
                filename: messageConfig.attachment?.name || 'attachment',
              },
            };
          }
        }
      } catch (error) {
        logger.warn('Failed to upload automation attachment', {
          storeId,
          workflowId: matched.workflow_id,
          error: error.message,
        });
      }
    }

    if (!payload) {
      payload = buildAutomationMessagePayload(messageConfig, inboundMessageId, variableContext);
    }
    if (!payload) {
      return false;
    }
    const response = await sendAutomationPayload(payload);
    const messageId = response?.messages?.[0]?.id || null;
    const previewText = messageConfig.text || 'Auto reply';
    if (messageId && storeId) {
      await persistWhatsAppMessage({
        storeId,
        customerPhone,
        direction: 'outbound',
        messageType: payload.type || 'text',
        timestamp: new Date().toISOString(),
        messageId,
        text: previewText,
        status: 'sent',
        workflowId: matched.workflow_id,
        metadata: {
          phoneNumberId: effectiveMetadata?.phoneNumberId || null,
          wabaId: effectiveMetadata?.wabaId || null,
          displayPhoneNumber: effectiveMetadata?.displayPhoneNumber || null,
        },
      });
    }
    return true;
  } catch (error) {
    const status = error?.response?.status || null;
    const graphError = error?.response?.data?.error || null;
    const graphMessage =
      graphError?.error_user_msg || graphError?.message || error?.message || 'Unknown error';
    logger.error('Failed to send automation reply', {
      storeId,
      customerPhone,
      status,
      error: graphMessage,
      graphError,
    });
    return false;
  }
}

function getMessagePreviewText(item = {}) {
  if (item.body) {
    return item.body;
  }
  const type = typeof item.message_type === 'string' ? item.message_type.toLowerCase() : '';
  switch (type) {
    case 'image':
      return item.media_metadata?.caption || '📷 Photo';
    case 'video':
      return item.media_metadata?.caption || '📹 Video';
    case 'audio':
      return '🎵 Audio message';
    case 'document':
      return item.media_metadata?.fileName ? `📄 ${item.media_metadata.fileName}` : '📄 Document';
    case 'sticker':
      return '🩷 Sticker';
    case 'location':
      return item.location_metadata?.name
        ? `📍 ${item.location_metadata.name}`
        : '📍 Shared location';
    case 'order': {
      const items = Array.isArray(item.order_metadata?.product_items)
        ? item.order_metadata.product_items
        : [];
      if (items.length > 0) {
        return `🛒 Order received (${items.length} item${items.length === 1 ? '' : 's'})`;
      }
      return '🛒 Order received';
    }
    default:
      return 'New message';
  }
}

function captureOnboardingSnapshot({ entry, change, fullBody }) {
  const field = change?.field;
  const value = change?.value;

  if (!isOnboardingWebhookChange(field, value)) {
    return false;
  }

  const details = extractOnboardingDetails({
    entry,
    value,
    fallbackPhoneNumberId: undefined,
    fallbackWabaId: undefined,
    fallbackDisplayNumber: undefined,
  });

  latestOnboardingSnapshot = {
    ...details,
    capturedAt: new Date().toISOString(),
  };
  try {
    latestOnboardingRawPayload = JSON.parse(JSON.stringify(fullBody || {}));
  } catch (error) {
    latestOnboardingRawPayload = fullBody || {};
    logger.warn('Failed to serialize onboarding raw payload', { error: error.message });
  }

  logger.info('Onboarding payload captured', {
    field,
    details: latestOnboardingSnapshot,
    payload: value,
  });

  return true;
}

function isOnboardingWebhookChange(field, value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const normalizedField = typeof field === 'string' ? field.toLowerCase() : '';
  if (normalizedField === 'messages') {
    return false;
  }

  const onboardingEvents = new Set([
    'partner_added',
    'partner_app_installed',
    'onboarding_complete',
  ]);
  const onboardingFields = new Set([
    'account',
    'business_account',
    'app',
    'embedded_signup',
    'account_update',
  ]);

  if (value.event && onboardingEvents.has(String(value.event).toLowerCase())) {
    return true;
  }

  if (normalizedField && onboardingFields.has(normalizedField)) {
    return true;
  }

  const indicators = [
    value.app_id,
    value.partner_app_id,
    value.business_id,
    value.waba_id,
    value.phone_number_id,
    value.waba_info,
    value.embedded_signup,
    value.onboarding_complete,
    value.account_setup,
    value.token,
    value.access_token,
    value.webhook_verify_token,
  ];

  if (indicators.some(Boolean)) {
    return true;
  }

  if (value.messages || value.statuses) {
    return false;
  }

  return normalizedField === '' && Boolean(value.waba_id || value.business_id);
}

function extractOnboardingDetails({
  entry,
  value,
  fallbackPhoneNumberId,
  fallbackWabaId,
  fallbackDisplayNumber,
}) {
  const metadata = value?.metadata || {};
  const wabaInfo = value?.waba_info || {};
  const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
  const primaryContact = contacts[0] || null;
  const contactProfile = primaryContact?.profile || {};

  const wabaId = value?.waba_id || wabaInfo?.waba_id || fallbackWabaId || entry?.id || null;

  const phoneNumberId =
    value?.phone_number_id ||
    wabaInfo?.phone_number_id ||
    metadata?.phone_number_id ||
    fallbackPhoneNumberId ||
    null;

  const displayPhoneNumber =
    value?.business_phone ||
    metadata?.display_phone_number ||
    wabaInfo?.display_phone_number ||
    fallbackDisplayNumber ||
    null;

  const businessId = value?.business_id || wabaInfo?.owner_business_id || null;

  const appId = value?.app_id || value?.partner_app_id || null;

  const verifiedName = value?.verified_name || contactProfile?.name || null;

  const businessPhone =
    value?.business_phone || metadata?.display_phone_number || primaryContact?.wa_id || null;

  return {
    wabaId,
    phoneNumberId,
    businessId,
    appId,
    verifiedName,
    businessPhone,
    displayPhoneNumber,
    webhookVerifyToken: value?.webhook_verify_token || value?.token || null,
    eventType: value?.event || null,
    accessToken: value?.access_token || null,
  };
}

async function fetchWabaPhoneNumbers({ wabaId, accessToken, version }) {
  if (!wabaId) {
    throw new Error('wabaId is required to fetch phone numbers');
  }

  const tokenToUse = accessToken || STATIC_WABA_ACCESS_TOKEN;
  if (!tokenToUse) {
    throw new Error('No access token available to query WhatsApp phone numbers');
  }

  const graphVersion = version || GRAPH_API_VERSION || 'v22.0';
  const fields = [
    'id',
    'cc',
    'country_dial_code',
    'display_phone_number',
    'verified_name',
    'status',
    'quality_rating',
    'search_visibility',
    'platform_type',
    'code_verification_status',
  ].join(',');

  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/phone_numbers`;

  try {
    const response = await axios.get(url, {
      params: {
        fields,
        access_token: tokenToUse,
      },
      timeout: 10000,
    });

    const payload = response.data || {};
    logger.info('Fetched WABA phone numbers', {
      wabaId,
      count: Array.isArray(payload.data) ? payload.data.length : 0,
    });
    return payload;
  } catch (error) {
    logger.error('Failed to fetch WABA phone numbers', {
      wabaId,
      status: error.response?.status,
      message: error.response?.data?.error?.message || error.message,
    });
    throw error;
  }
}

const ONBOARDING_LINK = process.env.ONBOARDING_LINK || '';

function formatWebhookConfigResponse(config = {}) {
  return {
    webhookUrl: config.webhook_url || '',
    verifyTokenSet: Boolean(config.verify_token),
    appSecretSet: Boolean(config.app_secret),
    lastUpdatedAt: config.updated_at || null,
    lastValidatedAt: config.last_validated_at || null,
  };
}

async function verifyWebhookToken(token) {
  const envToken = process.env.WEBHOOK_VERIFY_TOKEN || '123456789';
  if (envToken && token === envToken) {
    return { valid: true, source: 'environment', storeId: null };
  }

  if (!token) {
    return { valid: false };
  }

  try {
    const command = new ScanCommand({
      TableName: STORE_CONFIG_TABLE,
      ProjectionExpression: 'store_id',
      FilterExpression: '#cfg.#verify_token = :token',
      ExpressionAttributeNames: {
        '#cfg': 'webhook_config',
        '#verify_token': 'verify_token',
      },
      ExpressionAttributeValues: {
        ':token': token,
      },
      Limit: 1,
    });

    const result = await docClient.send(command);
    if (result.Items && result.Items.length > 0) {
      return { valid: true, source: 'store', storeId: result.Items[0].store_id };
    }
  } catch (error) {
    logger.error('Error verifying webhook token', { error: error.message });
  }

  return { valid: false };
}

async function touchWebhookValidation(storeId) {
  if (!storeId) {
    return;
  }

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: 'SET #cfg.#last_validated_at = :ts',
        ExpressionAttributeNames: {
          '#cfg': 'webhook_config',
          '#last_validated_at': 'last_validated_at',
        },
        ExpressionAttributeValues: {
          ':ts': new Date().toISOString(),
        },
      })
    );
  } catch (error) {
    logger.error('Error updating webhook validation timestamp', { storeId, error: error.message });
  }
}

function coerceToArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.parameters)) {
      return value.parameters;
    }
    if (Array.isArray(value.values)) {
      return value.values;
    }
  }
  return [value];
}

function normalizeTemplateParameterList(source, defaultType = 'text') {
  return coerceToArray(source)
    .map((item) => {
      if (item === undefined || item === null) {
        return null;
      }

      if (typeof item === 'object') {
        const cloned = { ...item };

        if (typeof cloned.type === 'string') {
          if (cloned.type === 'text') {
            cloned.text = cloned.text != null ? String(cloned.text) : '';
          }
          return cloned;
        }

        if (cloned.payload !== undefined) {
          return {
            type: 'payload',
            payload: String(cloned.payload),
          };
        }

        if (
          cloned.image ||
          cloned.video ||
          cloned.document ||
          cloned.currency ||
          cloned.date_time ||
          cloned.mention ||
          cloned.location
        ) {
          return cloned;
        }

        if (typeof cloned.text === 'string') {
          return {
            type: defaultType,
            text: cloned.text,
          };
        }
      }

      return {
        type: defaultType,
        text: String(item),
      };
    })
    .filter(Boolean);
}

function normalizeButtonComponent(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const indices = [input.index, input.buttonIndex, input.button_index, input.id, input.position];
  const rawIndex = indices.find((value) => value !== undefined && value !== null);
  const parsedIndex = Number.parseInt(rawIndex, 10);
  const safeIndex = Number.isFinite(parsedIndex) ? parsedIndex : 0;

  const subType =
    [input.subType, input.sub_type, input.buttonSubType, input.button_sub_type].find(
      (value) => typeof value === 'string' && value.trim().length > 0
    ) || undefined;

  const component = {
    type: 'button',
    index: String(safeIndex),
  };

  if (subType) {
    component.sub_type = subType;
  }

  const buttonInputParameters = input.parameters ?? input.values ?? input.parameter ?? null;
  let parameters = null;

  if (typeof subType === 'string' && subType.toLowerCase() === 'copy_code') {
    const couponCodeCandidate = Array.isArray(buttonInputParameters)
      ? buttonInputParameters.find(
          (value) => value !== undefined && value !== null && String(value).trim().length > 0
        )
      : buttonInputParameters;
    const normalizedCouponCode =
      couponCodeCandidate !== undefined && couponCodeCandidate !== null
        ? String(couponCodeCandidate).trim()
        : '';

    if (!normalizedCouponCode) {
      return null;
    }

    parameters = [
      {
        type: 'coupon_code',
        coupon_code: normalizedCouponCode,
      },
    ];
  } else {
    parameters = normalizeTemplateParameterList(buttonInputParameters, 'text');
  }

  if ((!parameters || parameters.length === 0) && input.payload !== undefined) {
    parameters = [
      {
        type: 'payload',
        payload: String(input.payload),
      },
    ];
  }

  if ((!parameters || parameters.length === 0) && input.text !== undefined) {
    parameters = [
      {
        type: 'text',
        text: String(input.text),
      },
    ];
  }

  if (parameters && parameters.length > 0) {
    component.parameters = parameters;
  }

  return component;
}

function parseTemplateParameters(templateParams) {
  const result = {
    header: [],
    body: [],
    footer: [],
    buttons: [],
    components: [],
  };

  if (templateParams === undefined || templateParams === null) {
    return result;
  }

  if (Array.isArray(templateParams)) {
    result.body = normalizeTemplateParameterList(templateParams, 'text');
    return result;
  }

  if (typeof templateParams !== 'object') {
    result.body = normalizeTemplateParameterList([templateParams], 'text');
    return result;
  }

  const headerSource =
    templateParams.header ??
    templateParams.headers ??
    templateParams.headerParameters ??
    templateParams.header_params ??
    templateParams.headerValues;

  const bodySource =
    templateParams.body ??
    templateParams.bodyParameters ??
    templateParams.parameters ??
    templateParams.bodyParams ??
    templateParams.values;

  const footerSource =
    templateParams.footer ??
    templateParams.footerParameters ??
    templateParams.footer_params ??
    templateParams.footerValues;

  result.header = normalizeTemplateParameterList(headerSource, 'text');
  result.body = normalizeTemplateParameterList(bodySource, 'text');
  result.footer = normalizeTemplateParameterList(footerSource, 'text');

  if (Array.isArray(templateParams.buttons)) {
    result.buttons = templateParams.buttons.map(normalizeButtonComponent).filter(Boolean);
  }

  if (Array.isArray(templateParams.components)) {
    result.components = templateParams.components
      .filter((component) => component && typeof component === 'object')
      .map((component) => ({ ...component }));
  }

  return result;
}

// Official WhatsApp Cloud API send message function using templates
async function sendMessage(
  to,
  templateName,
  whatsappApiUrl,
  accessToken,
  templateParams = null,
  templateLanguage = 'en_US',
  options = {}
) {
  if (!accessToken || !whatsappApiUrl) {
    throw new Error('WhatsApp credentials not configured');
  }
  if (!templateName) {
    throw new Error('WhatsApp template name is required');
  }

  // Ensure phone number is properly formatted for WhatsApp API
  const formattedPhone = formatPhoneToE164(to);
  if (!formattedPhone) {
    throw new Error('Invalid phone number provided.');
  }

  // Default template configuration
  const defaultTemplate = {
    name: templateName,
    language: {
      code: templateLanguage || 'en_US',
    },
  };

  // Build component list dynamically so header/body/button combinations work
  const templateComponents = [];
  const parsedTemplateParams = parseTemplateParameters(templateParams);
  const headerParametersFromOptions = normalizeTemplateParameterList(
    options?.headerParameters,
    'text'
  );

  let headerComponentParameters = [];

  if (options?.headerImageId) {
    const headerImageId = options.headerImageId;
    const imagePayload =
      typeof headerImageId === 'string' && headerImageId.startsWith('http')
        ? { link: headerImageId }
        : { id: String(headerImageId) };
    headerComponentParameters = [
      {
        type: 'image',
        image: imagePayload,
      },
    ];
  } else {
    headerComponentParameters = [...headerParametersFromOptions, ...parsedTemplateParams.header];
  }

  if (headerComponentParameters.length > 0) {
    templateComponents.push({
      type: 'header',
      parameters: headerComponentParameters,
    });
  }

  if (parsedTemplateParams.body.length > 0) {
    templateComponents.push({
      type: 'body',
      parameters: parsedTemplateParams.body,
    });
  }

  if (parsedTemplateParams.buttons.length > 0) {
    templateComponents.push(...parsedTemplateParams.buttons);
  }

  if (parsedTemplateParams.components.length > 0) {
    templateComponents.push(...parsedTemplateParams.components);
  }

  if (Array.isArray(options?.additionalComponents) && options.additionalComponents.length > 0) {
    templateComponents.push(...options.additionalComponents);
  }

  if (templateComponents.length > 0) {
    defaultTemplate.components = templateComponents;
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: formattedPhone,
    type: 'template',
    template: defaultTemplate,
  };

  logger.info('Sending WhatsApp message', {
    to,
    formattedTo: formattedPhone,
    templateName,
    templateLanguage,
    payload: JSON.stringify(payload, null, 2),
  });

  try {
    const response = await axios({
      url: whatsappApiUrl,
      method: 'post',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
      data: payload,
    });
    return response.data;
  } catch (error) {
    logger.error('WhatsApp API error', {
      to,
      templateName,
      status: error.response?.status,
      statusText: error.response?.statusText,
      errorData: error.response?.data,
      payload: JSON.stringify(payload, null, 2),
    });
    throw error;
  }
}

function buildUserContextFromStoreConfig(storeConfig, fallback = {}) {
  if (!storeConfig) {
    return null;
  }
  return {
    store_id: storeConfig.store_id || fallback.store_id || null,
    template_name: storeConfig.template_name || fallback.template_name || null,
    template_language: storeConfig.template_language || fallback.template_language || 'en_US',
    whatsapp_api_url: storeConfig.whatsapp_api_url || fallback.whatsapp_api_url || null,
    access_token: storeConfig.access_token || fallback.access_token || null,
    phone_number_id: storeConfig.phone_number_id || fallback.phone_number_id || null,
    waba_id: storeConfig.waba_id || fallback.waba_id || null,
    waba_mobile_number: storeConfig.waba_mobile_number || fallback.waba_mobile_number || null,
  };
}

async function executeResendAttempt(attempt) {
  if (!attempt?.resend_attempt_id || !attempt?.campaign_id) {
    return;
  }

  const resendAttemptId = attempt.resend_attempt_id;
  const campaignId = attempt.campaign_id;

  try {
    await resendService.updateResendAttemptStatus({
      resendAttemptId,
      status: 'RUNNING',
      expectedStatus: 'SCHEDULED',
    });
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }

  try {
    const metadata = await analyticsService.getCampaignMetadataById(
      campaignId,
      attempt.store_id || null
    );
    const storeId = metadata?.store_id || attempt.store_id;
    if (!metadata || !storeId) {
      await resendService.updateResendAttemptStatus({
        resendAttemptId,
        status: 'FAILED',
        updates: { last_error: 'Campaign metadata not found.' },
      });
      return;
    }
    if (metadata.resend_stopped) {
      await resendService.updateResendAttemptStatus({
        resendAttemptId,
        status: 'CANCELLED',
        updates: { last_error: 'Stopped by user.' },
      });
      return;
    }

    const storeConfig = await getStoreConfigById(storeId);
    const userContext = buildUserContextFromStoreConfig(storeConfig, { store_id: storeId });
    if (
      !userContext?.whatsapp_api_url ||
      !userContext?.access_token ||
      !userContext?.phone_number_id
    ) {
      await resendService.updateResendAttemptStatus({
        resendAttemptId,
        status: 'FAILED',
        updates: { last_error: 'WhatsApp configuration missing for resend.' },
      });
      return;
    }

    const campaignDetails = await analyticsService.getCampaignRecipients(storeId, {
      campaignId,
    });
    const recipients = Array.isArray(campaignDetails?.recipients) ? campaignDetails.recipients : [];
    const latestRecipients = collapseRecipientsByPhone(recipients);
    const campaignStats = summarizeCampaignRecipients(latestRecipients);
    const attemptNumber = Number(attempt.attempt_number || 1);
    const maxAttempts = Number(attempt.max_attempts || RESEND_MAX_ATTEMPTS);
    const eligibleRecipients = latestRecipients.filter(isResendEligible);
    const dedupedRecipients = [];
    const seenPhones = new Set();
    eligibleRecipients.forEach((recipient) => {
      const phone = recipient.phone || recipient.customer_phone || '';
      if (!phone || seenPhones.has(phone)) {
        return;
      }
      seenPhones.add(phone);
      dedupedRecipients.push({
        phone,
        name: recipient.name || recipient.customer_name || null,
      });
    });

    if (dedupedRecipients.length === 0) {
      await resendService.updateResendAttemptStatus({
        resendAttemptId,
        status: 'COMPLETED',
        updates: {
          attempted_count: 0,
          success_count: 0,
          failed_count: 0,
          limited_by_meta_count: 0,
        },
      });
      const successRate = campaignStats.total > 0 ? campaignStats.success / campaignStats.total : 0;
      const shouldStop =
        attemptNumber >= maxAttempts ||
        successRate >= RESEND_SUCCESS_THRESHOLD ||
        (campaignStats.failed === 0 && campaignStats.pending === 0);
      if (!shouldStop) {
        const stopCheck = await analyticsService.getCampaignMetadataById(campaignId, storeId);
        if (stopCheck?.resend_stopped) {
          return;
        }
        const delaySeconds = resendService.delayOptionToSeconds(attempt.delay_option);
        if (delaySeconds) {
          const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
          const nextAttemptId = randomUUID();
          try {
            await resendService.createResendAttempt({
              resend_attempt_id: nextAttemptId,
              campaign_id: campaignId,
              store_id: storeId,
              scheduled_at: scheduledAt,
              created_at: new Date().toISOString(),
              delay_option: attempt.delay_option,
              attempt_number: attemptNumber + 1,
              max_attempts: maxAttempts,
              status: 'SCHEDULED',
              eligible_count: campaignStats.failed,
              created_by: attempt.created_by || null,
            });
          } catch (error) {
            logger.error('Failed to schedule follow-up resend attempt', {
              campaignId,
              resendAttemptId,
              error: error.message,
            });
          }
        }
      }
      return;
    }

    const templateName = metadata.template_name || campaignDetails.templateName;
    if (!templateName) {
      await resendService.updateResendAttemptStatus({
        resendAttemptId,
        status: 'FAILED',
        updates: { last_error: 'Template name missing for resend.' },
      });
      return;
    }

    const templateLanguage = metadata.template_language || userContext.template_language || 'en_US';
    const templateParameters = metadata.template_parameters || null;
    const campaignName = metadata.campaign_name || campaignDetails.campaignName || 'Campaign';
    const messageText = metadata.message || campaignName;

    let headerImageId = metadata.header_media_id || null;
    if (!headerImageId && metadata.header_image_s3_key) {
      headerImageId = await resendService.createPresignedGet(metadata.header_image_s3_key);
    }

    if (metadata.send_mode === 'image' && !headerImageId) {
      await resendService.updateResendAttemptStatus({
        resendAttemptId,
        status: 'FAILED',
        updates: { last_error: 'Image template requires a header image.' },
      });
      return;
    }

    let successCount = 0;
    let failureCount = 0;
    let limitedByMetaCount = 0;

    const sendRecipient = async (recipient) => {
      let attemptCount = 0;
      while (attemptCount <= CAMPAIGN_MAX_RETRIES) {
        try {
          await campaignRateLimiter.acquire();
          const sendResult = await sendMessage(
            recipient.phone,
            templateName,
            userContext.whatsapp_api_url,
            userContext.access_token,
            templateParameters,
            templateLanguage,
            headerImageId ? { headerImageId } : {}
          );

          const sentAt = new Date().toISOString();
          const messageId = sendResult.messages?.[0]?.id || null;

          await analyticsService.upsertCampaignDetail({
            store_id: storeId,
            sent_at: sentAt,
            campaign_name: campaignName,
            template_name: templateName,
            template_language: templateLanguage || null,
            template_parameters: templateParameters ?? null,
            message: messageText,
            send_mode: metadata.send_mode || null,
            header_image_s3_key: metadata.header_image_s3_key || null,
            resend_enabled: metadata.resend_enabled ?? null,
            resend_delay_option: metadata.resend_delay_option || null,
            customer_phone: recipient.phone,
            customer_name: recipient.name,
            status: 'sent',
            message_id: messageId,
            last_status_update: sentAt,
            campaign_id: campaignId,
          });

          await persistWhatsAppMessage({
            storeId: userContext.store_id || storeId,
            customerPhone: recipient.phone,
            direction: 'outbound',
            messageType: 'template',
            timestamp: sentAt,
            messageId,
            text: messageText,
            status: 'sent',
            customerName: recipient.name,
            metadata: {
              phoneNumberId: userContext.phone_number_id || null,
              wabaId: userContext.waba_id || null,
              displayPhoneNumber: userContext.waba_mobile_number || null,
            },
            campaignName,
            campaignId,
            templateName,
            mediaId: metadata.header_image_s3_key || null,
          });

          await resendService.updateResendRecipient({
            resendAttemptId,
            phone: recipient.phone,
            updates: {
              status: 'SENT',
              message_id: messageId,
              sent_at: sentAt,
            },
          });

          successCount += 1;
          return;
        } catch (error) {
          const shouldRetry = isRetryableError(error) && attemptCount < CAMPAIGN_MAX_RETRIES;
          if (shouldRetry) {
            attemptCount += 1;
            continue;
          }
          const sentAt = new Date().toISOString();
          const errorInfo = resolveErrorInfo(error);
          const limitedByMeta = isMetaLimitedRecipient({
            status: 'failed',
            error: errorInfo.message,
            errorCode: errorInfo.code,
          });

          await analyticsService.upsertCampaignDetail({
            store_id: storeId,
            sent_at: sentAt,
            campaign_name: campaignName,
            template_name: templateName,
            template_language: templateLanguage || null,
            template_parameters: templateParameters ?? null,
            message: messageText,
            send_mode: metadata.send_mode || null,
            header_image_s3_key: metadata.header_image_s3_key || null,
            resend_enabled: metadata.resend_enabled ?? null,
            resend_delay_option: metadata.resend_delay_option || null,
            customer_phone: recipient.phone,
            customer_name: recipient.name,
            status: 'failed',
            message_id: null,
            last_status_update: sentAt,
            campaign_id: campaignId,
            error_reason: errorInfo.message,
            error_code: errorInfo.code ?? null,
          });

          await resendService.updateResendRecipient({
            resendAttemptId,
            phone: recipient.phone,
            updates: {
              status: limitedByMeta ? 'LIMITED_BY_META' : 'FAILED',
              error_reason: errorInfo.message,
              error_code: errorInfo.code ?? null,
              sent_at: sentAt,
            },
          });

          failureCount += 1;
          if (limitedByMeta) {
            limitedByMetaCount += 1;
          }
          return;
        }
      }
    };

    await runWithConcurrency(dedupedRecipients, sendRecipient, CAMPAIGN_MAX_MPS);

    await resendService.updateResendAttemptStatus({
      resendAttemptId,
      status: 'COMPLETED',
      updates: {
        attempted_count: dedupedRecipients.length,
        success_count: successCount,
        failed_count: failureCount,
        limited_by_meta_count: limitedByMetaCount,
      },
    });

    const latestCampaignDetails = await analyticsService.getCampaignRecipients(storeId, {
      campaignId,
    });
    const latestRecipientsSnapshot = Array.isArray(latestCampaignDetails?.recipients)
      ? latestCampaignDetails.recipients
      : [];
    const latestUniqueRecipients = collapseRecipientsByPhone(latestRecipientsSnapshot);
    const latestFailedRecipients = latestUniqueRecipients.filter(isResendEligible);
    const latestFailureCount = latestFailedRecipients.length;
    const latestStats = summarizeCampaignRecipients(latestUniqueRecipients);
    const successRate = latestStats.total > 0 ? latestStats.success / latestStats.total : 0;
    const shouldStop =
      attemptNumber >= maxAttempts ||
      successRate >= RESEND_SUCCESS_THRESHOLD ||
      (latestFailureCount === 0 && latestStats.pending === 0);

    if (!shouldStop) {
      const stopCheck = await analyticsService.getCampaignMetadataById(campaignId, storeId);
      if (stopCheck?.resend_stopped) {
        return;
      }
      const delaySeconds = resendService.delayOptionToSeconds(attempt.delay_option);
      if (delaySeconds) {
        const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
        const nextAttemptId = randomUUID();
        try {
          await resendService.createResendAttempt({
            resend_attempt_id: nextAttemptId,
            campaign_id: campaignId,
            store_id: storeId,
            scheduled_at: scheduledAt,
            created_at: new Date().toISOString(),
            delay_option: attempt.delay_option,
            attempt_number: attemptNumber + 1,
            max_attempts: maxAttempts,
            status: 'SCHEDULED',
            eligible_count: latestFailureCount,
            created_by: attempt.created_by || null,
          });
        } catch (error) {
          logger.error('Failed to schedule follow-up resend attempt', {
            campaignId,
            resendAttemptId,
            error: error.message,
          });
        }
      }
    }
  } catch (error) {
    await resendService.updateResendAttemptStatus({
      resendAttemptId,
      status: 'FAILED',
      updates: { last_error: error.message || 'Resend failed.' },
    });
  }
}

// GET /templates - retrieve WhatsApp templates for the authenticated store
router.get('/templates', async (req, res) => {
  const {
    waba_id: wabaId,
    access_token: accessToken,
    store_id: storeId,
    phone_number_id: phoneNumberId,
  } = req.user || {};

  if (!wabaId || !accessToken) {
    logger.warn('Templates request missing WhatsApp credentials', { storeId });
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  const fields = req.query.fields || DEFAULT_TEMPLATE_FIELDS;
  const limitParam = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 250) : 50;
  const after = req.query.after;
  const before = req.query.before;
  const version = req.query.version || 'v22.0';

  const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;
  const params = {
    fields,
    limit,
    access_token: accessToken,
  };

  if (after) params.after = after;
  if (before) params.before = before;

  try {
    logger.info('Fetching WhatsApp templates', { storeId, wabaId, phoneNumberId, limit });
    const response = await axios.get(url, { params });
    const payload = response.data || {};
    res.json({
      templates: payload.data || [],
      paging: payload.paging || null,
      summary: payload.summary || null,
      waba_id: wabaId,
      phone_number_id: phoneNumberId || null,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const errorMessage =
      error.response?.data?.error?.message || error.message || 'Failed to retrieve templates';
    logger.error('Error fetching WhatsApp templates', {
      storeId,
      wabaId,
      status,
      error: errorMessage,
    });
    res.status(status).json({ error: errorMessage });
  }
});

const parseExampleList = (value) => {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return null;
};

// GET /webhook - Webhook verification
router.get('/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.info('Webhook verification attempt', { mode, token: token ? 'provided' : 'missing' });

  if (mode === 'subscribe') {
    const verification = await verifyWebhookToken(token);

    if (verification.valid) {
      logger.info('Webhook verified successfully', {
        challenge,
        source: verification.source,
        storeId: verification.storeId || 'env',
      });
      if (verification.storeId) {
        await touchWebhookValidation(verification.storeId);
      }
      return res.status(200).send(challenge);
    }
  }

  logger.warn('Webhook verification failed', {
    mode,
    token,
    expectedToken: process.env.WEBHOOK_VERIFY_TOKEN,
  });
  res.status(403).send('Forbidden');
});

// GET /config/webhook - Retrieve webhook configuration
router.get('/config/webhook', async (req, res) => {
  const storeId = req.user?.store_id;

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
    });

    const result = await docClient.send(command);
    const config = result.Item?.webhook_config || {};

    logger.info('Webhook configuration fetched', {
      storeId,
      hasConfig: Boolean(result.Item?.webhook_config),
    });
    res.json(formatWebhookConfigResponse(config));
  } catch (error) {
    logger.error('Error fetching webhook configuration', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to retrieve webhook configuration' });
  }
});

// POST /config/webhook - Update webhook configuration
router.post('/config/webhook', async (req, res) => {
  const storeId = req.user?.store_id;
  const { webhookUrl, verifyToken, appSecret } = req.body || {};

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return res.status(400).json({ error: 'webhookUrl is required' });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(webhookUrl.trim());
  } catch (error) {
    return res.status(400).json({ error: 'webhookUrl must be a valid URL' });
  }

  if (parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'webhookUrl must use https' });
  }

  const timestamp = new Date().toISOString();

  try {
    const existing = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
      })
    );

    const currentConfig = existing.Item?.webhook_config || {};
    const nextConfig = {
      ...currentConfig,
      webhook_url: parsedUrl.toString(),
      updated_at: timestamp,
    };

    if (typeof verifyToken === 'string') {
      const trimmed = verifyToken.trim();
      if (trimmed.length > 0) {
        nextConfig.verify_token = trimmed;
      }
    }

    if (typeof appSecret === 'string') {
      const trimmed = appSecret.trim();
      if (trimmed.length > 0) {
        nextConfig.app_secret = trimmed;
      }
    }

    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: 'SET webhook_config = :config',
        ExpressionAttributeValues: {
          ':config': nextConfig,
        },
      })
    );

    logger.info('Webhook configuration updated', { storeId });

    res.json({
      success: true,
      config: formatWebhookConfigResponse(nextConfig),
    });
  } catch (error) {
    logger.error('Error updating webhook configuration', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to update webhook configuration' });
  }
});

// GET /config/onboarding - Retrieve onboarding configuration
router.get('/config/onboarding', async (req, res) => {
  const storeId = req.user?.store_id;

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
    });

    const result = await docClient.send(command);
    const config = result.Item || {};

    logger.info('Onboarding configuration fetched', {
      storeId,
      hasConfig: Boolean(config.waba_id || config.phone_number_id || config.verified_name),
    });

    res.json({
      wabaId: config.waba_id || '',
      phoneNumberId: config.phone_number_id || '',
      businessPhone: config.waba_mobile_number || '',
      businessId: config.meta_business_id || '',
      appId: config.meta_app_id || '',
      verifiedName: config.verified_name || '',
      lastUpdatedAt: config.onboarding_updated_at || null,
      onboardingLink: ONBOARDING_LINK,
    });
  } catch (error) {
    logger.error('Error fetching onboarding configuration', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to load onboarding configuration' });
  }
});

// GET /onboarding/latest-webhook - Latest onboarding payload snapshot
router.get('/onboarding/latest-webhook', (req, res) => {
  res.json({
    latest: latestOnboardingSnapshot,
    raw: latestOnboardingRawPayload,
  });
});

router.get('/onboarding/phone-numbers', async (req, res) => {
  const storeId = req.user?.store_id;

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  const queryWabaId = typeof req.query.wabaId === 'string' ? req.query.wabaId.trim() : '';
  let wabaId = queryWabaId;

  if (!wabaId && latestOnboardingSnapshot?.wabaId) {
    wabaId = latestOnboardingSnapshot.wabaId;
  }

  if (!wabaId && req.user?.waba_id) {
    wabaId = req.user.waba_id;
  }

  if (!wabaId) {
    try {
      const config = await getStoreConfigById(storeId);
      wabaId = config?.waba_id || '';
    } catch (error) {
      logger.error('Failed to resolve store config while fetching phone numbers', {
        storeId,
        error: error.message,
      });
    }
  }

  if (!wabaId) {
    return res.status(400).json({ error: 'Unable to determine WABA ID for this store' });
  }

  const accessToken = req.user?.access_token || STATIC_WABA_ACCESS_TOKEN;
  if (!accessToken) {
    return res.status(400).json({ error: 'Access token not available to query phone numbers' });
  }

  try {
    const payload = await fetchWabaPhoneNumbers({
      wabaId,
      accessToken,
      version: GRAPH_API_VERSION,
    });

    const phoneNumbers = Array.isArray(payload?.data) ? payload.data : [];

    phoneNumbers.forEach((record) => {
      if (record?.id) {
        phoneNumberStoreCache.set(record.id, {
          storeId,
          wabaId,
          phoneNumberId: record.id,
          verifiedName: record?.verified_name || null,
        });
      }

      if (record?.display_phone_number) {
        displayPhoneStoreCache.set(record.display_phone_number, {
          storeId,
          wabaId,
          phoneNumberId: record?.id || null,
          verifiedName: record?.verified_name || null,
        });
      }
    });

    res.json({
      wabaId,
      phoneNumbers,
      paging: payload?.paging || null,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const message =
      error.response?.data?.error?.message || error.message || 'Failed to fetch phone numbers';
    res.status(status === 400 ? 400 : 502).json({ error: message });
  }
});

// POST /config/onboarding - Update onboarding configuration
router.post('/config/onboarding', async (req, res) => {
  const storeId = req.user?.store_id;
  const { wabaId, phoneNumberId, verifiedName, businessPhone, businessId, appId } = req.body || {};

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  if (typeof wabaId !== 'string' || typeof phoneNumberId !== 'string') {
    return res.status(400).json({ error: 'wabaId and phoneNumberId are required' });
  }

  const trimmedWabaId = wabaId.trim();
  const trimmedPhoneId = phoneNumberId.trim();
  const trimmedVerifiedName = typeof verifiedName === 'string' ? verifiedName.trim() : '';
  const trimmedBusinessPhone = typeof businessPhone === 'string' ? businessPhone.trim() : '';
  const trimmedBusinessId = typeof businessId === 'string' ? businessId.trim() : '';
  const trimmedAppId = typeof appId === 'string' ? appId.trim() : '';

  if (!trimmedWabaId || !trimmedPhoneId) {
    return res.status(400).json({ error: 'wabaId and phoneNumberId must be non-empty strings' });
  }

  const timestamp = new Date().toISOString();
  const graphVersion = GRAPH_API_VERSION || 'v19.0';
  const resolvedAccessToken = STATIC_WABA_ACCESS_TOKEN || null;
  const resolvedWhatsappApiUrl = `https://graph.facebook.com/${graphVersion}/${trimmedPhoneId}/messages`;

  try {
    const command = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression:
        'SET waba_id = :wabaId, phone_number_id = :phoneNumberId, verified_name = :verifiedName, onboarding_updated_at = :timestamp, waba_mobile_number = :businessPhone, meta_business_id = :businessId, meta_app_id = :appId, access_token = :accessToken, whatsapp_api_url = :whatsappApiUrl',
      ExpressionAttributeValues: {
        ':wabaId': trimmedWabaId,
        ':phoneNumberId': trimmedPhoneId,
        ':verifiedName': trimmedVerifiedName,
        ':timestamp': timestamp,
        ':businessPhone': trimmedBusinessPhone || null,
        ':businessId': trimmedBusinessId || null,
        ':appId': trimmedAppId || null,
        ':accessToken': resolvedAccessToken,
        ':whatsappApiUrl': resolvedWhatsappApiUrl,
      },
      ReturnValues: 'ALL_NEW',
    });

    const result = await docClient.send(command);
    const config = result.Attributes || {};

    logger.info('Onboarding configuration updated', {
      storeId,
      hasVerifiedName: Boolean(trimmedVerifiedName),
    });

    res.json({
      success: true,
      config: {
        wabaId: config.waba_id || trimmedWabaId,
        phoneNumberId: config.phone_number_id || trimmedPhoneId,
        businessPhone:
          typeof config.waba_mobile_number === 'string'
            ? config.waba_mobile_number
            : trimmedBusinessPhone,
        businessId:
          typeof config.meta_business_id === 'string' ? config.meta_business_id : trimmedBusinessId,
        appId: typeof config.meta_app_id === 'string' ? config.meta_app_id : trimmedAppId,
        verifiedName:
          typeof config.verified_name === 'string' ? config.verified_name : trimmedVerifiedName,
        lastUpdatedAt: config.onboarding_updated_at || timestamp,
        onboardingLink: ONBOARDING_LINK,
        accessToken: config.access_token || resolvedAccessToken,
        whatsappApiUrl: config.whatsapp_api_url || resolvedWhatsappApiUrl,
      },
    });
  } catch (error) {
    logger.error('Error updating onboarding configuration', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to save onboarding configuration' });
  }
});

router.post('/register-number', async (req, res) => {
  const storeId = req.user?.store_id;
  const accessToken = req.user?.access_token;
  const { phoneNumberId, pin } = req.body || {};

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  if (!accessToken) {
    return res.status(400).json({ error: 'WhatsApp access token not available for this store' });
  }

  if (typeof phoneNumberId !== 'string' || !phoneNumberId.trim()) {
    return res.status(400).json({ error: 'phoneNumberId is required' });
  }

  if (typeof pin !== 'string' || !/^[0-9]{6}$/.test(pin.trim())) {
    return res.status(400).json({ error: 'pin must be a 6-digit string' });
  }

  const trimmedPhoneId = phoneNumberId.trim();
  const trimmedPin = pin.trim();
  const registerUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${trimmedPhoneId}/register`;

  try {
    await axios.post(
      registerUrl,
      {
        messaging_product: 'whatsapp',
        pin: trimmedPin,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    logger.info('WhatsApp phone number registered', { storeId, phoneNumberId: trimmedPhoneId });

    res.json({ success: true });
  } catch (error) {
    const status = error.response?.status || 500;
    const errorMessage =
      error.response?.data?.error?.message || error.message || 'Failed to register number';

    logger.error('Error registering WhatsApp phone number', {
      storeId,
      phoneNumberId: trimmedPhoneId,
      status,
      error: errorMessage,
      details: error.response?.data,
    });

    res.status(status).json({ error: errorMessage });
  }
});

// POST /config/webhook/validate - Validate webhook token
router.post('/config/webhook/validate', async (req, res) => {
  const storeId = req.user?.store_id;
  const { verifyToken } = req.body || {};

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  try {
    const command = new GetCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
    });

    const result = await docClient.send(command);
    const config = result.Item?.webhook_config || {};
    const storedToken = config.verify_token;

    if (!storedToken) {
      return res.status(400).json({ error: 'No verify token stored for this store' });
    }

    const provided =
      typeof verifyToken === 'string' && verifyToken.trim().length > 0 ? verifyToken.trim() : null;
    const storedMatch = provided ? provided === storedToken : true;
    const envToken = process.env.WEBHOOK_VERIFY_TOKEN || '123456789';
    const matchesEnvironment = envToken && envToken.length > 0 ? storedToken === envToken : null;

    if (storedMatch) {
      const validatedAt = new Date().toISOString();
      const nextConfig = {
        ...config,
        last_validated_at: validatedAt,
      };

      await docClient.send(
        new UpdateCommand({
          TableName: STORE_CONFIG_TABLE,
          Key: { store_id: storeId },
          UpdateExpression: 'SET webhook_config = :config',
          ExpressionAttributeValues: {
            ':config': nextConfig,
          },
        })
      );

      logger.info('Webhook configuration validated', { storeId, matchesEnvironment });

      return res.json({
        valid: true,
        matchesEnvironment,
        config: formatWebhookConfigResponse(nextConfig),
      });
    }

    logger.warn('Webhook validation failed for store', { storeId });

    res.json({
      valid: false,
      matchesEnvironment,
      config: formatWebhookConfigResponse(config),
    });
  } catch (error) {
    logger.error('Error validating webhook configuration', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to validate webhook configuration' });
  }
});

// POST /webhook - Receive WhatsApp webhooks
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Respond quickly to avoid timeout
    res.status(200).send('OK');

    logger.info('Webhook received', {
      object: body.object,
      entries: body.entry?.length || 0,
    });

    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          await processWebhookChange(entry, change, body);
        }
      }
    }
  } catch (error) {
    logger.error('Error processing webhook', { error: error.message, stack: error.stack });
    // Still return 200 to avoid retries
    if (!res.headersSent) {
      res.status(200).send('OK');
    }
  }
});

async function processWebhookChange(entry, change, fullBody) {
  if (!change) {
    return;
  }

  const { field, value } = change;
  const normalizedField = typeof field === 'string' ? field.toLowerCase() : '';
  const metadata = value?.metadata || {};

  const phoneNumberId =
    value?.phone_number_id || metadata.phone_number_id || value?.waba_info?.phone_number_id || null;
  const wabaId = value?.waba_id || value?.waba_info?.waba_id || entry?.id || null;
  const displayPhoneNumber =
    metadata.display_phone_number ||
    value?.waba_info?.display_phone_number ||
    value?.business_phone ||
    null;

  const handledOnboarding = captureOnboardingSnapshot({
    entry,
    change,
    fullBody,
  });

  if (normalizedField !== 'messages') {
    if (!handledOnboarding) {
      logger.debug('Ignoring non-message webhook change', { field });
    }
    return;
  }

  const storeContext = await resolveStoreContext({ phoneNumberId, wabaId, displayPhoneNumber });
  const storeId = storeContext?.storeId || null;

  if (!storeId) {
    logger.warn('Unable to resolve store for webhook change', {
      phoneNumberId,
      wabaId,
      displayPhoneNumber,
    });

    // Try to find store by scanning all stores and logging what we find
    try {
      const allStores = await docClient.send(
        new ScanCommand({
          TableName: STORE_CONFIG_TABLE,
          ProjectionExpression: 'store_id, phone_number_id, waba_id, waba_mobile_number',
        })
      );

      logger.info('Available store configurations', {
        stores:
          allStores.Items?.map((item) => ({
            storeId: item.store_id,
            phoneNumberId: item.phone_number_id,
            wabaId: item.waba_id,
            mobileNumber: item.waba_mobile_number,
          })) || [],
      });
    } catch (error) {
      logger.error('Failed to scan store configurations', { error: error.message });
    }

    return; // Without a resolved store, skip processing to avoid cross-store contamination
  }

  // Process message statuses
  if (value.statuses) {
    for (const status of value.statuses) {
      const errorInfo =
        Array.isArray(status.errors) && status.errors.length > 0
          ? {
              code: status.errors[0]?.code ?? null,
              title: status.errors[0]?.title ?? null,
              details: status.errors[0]?.error_data?.details ?? null,
            }
          : null;
      const event = {
        id: status.id,
        type: 'status',
        status: status.status,
        timestamp: new Date(parseInt(status.timestamp) * 1000).toISOString(),
        recipient: status.recipient_id,
        error: errorInfo,
      };

      EventBuffer.addEvent(event);
      logger.info('Status update processed', {
        messageId: status.id,
        status: status.status,
        recipient: status.recipient_id,
        error: errorInfo,
      });

      await appendMessageStatus({
        storeId,
        customerPhone: status.recipient_id,
        messageId: status.id,
        status: status.status,
        statusTimestamp: event.timestamp,
      });

      try {
        await analyticsService.updateCampaignStatusByMessageId(
          status.id,
          status.status,
          new Date(parseInt(status.timestamp) * 1000).toISOString(),
          errorInfo
        );
      } catch (error) {
        logger.error('Failed to update campaign detail status', {
          messageId: status.id,
          status: status.status,
          error: error.message,
        });
      }

      try {
        await resendService.updateResendRecipientStatusByMessageId({
          messageId: status.id,
          status: status.status,
          error: errorInfo,
        });
      } catch (error) {
        logger.error('Failed to update resend recipient status', {
          messageId: status.id,
          status: status.status,
          error: error.message,
        });
      }
    }
  }

  // Process incoming messages
  if (value.messages) {
    for (const message of value.messages) {
      const details = extractInboundMessageDetails(message);
      if (details.type === 'order' && details.orderMetadata && storeId) {
        try {
          const storeConfig = await getStoreConfigById(storeId);
          const catalogId = details.orderMetadata.catalog_id || storeConfig?.catalog_id || null;
          const accessToken = storeContext?.accessToken || storeConfig?.access_token || null;
          if (catalogId && accessToken) {
            const catalogItems = await fetchCatalogProducts({
              catalogId,
              accessToken,
              graphVersion: process.env.GRAPH_API_VERSION,
              limit: 200,
            });
            const catalogMap = new Map(
              catalogItems
                .filter((item) => item?.product_retailer_id)
                .map((item) => [
                  item.product_retailer_id,
                  {
                    name: item.name,
                    price_value: item.price_value,
                    currency: item.currency,
                  },
                ])
            );
            const items = Array.isArray(details.orderMetadata.product_items)
              ? details.orderMetadata.product_items
              : [];
            const enriched = items.map((item) => {
              const retailerId = item?.product_retailer_id || null;
              const catalogInfo = retailerId ? catalogMap.get(retailerId) : null;
              return {
                ...item,
                name: item?.name || catalogInfo?.name || retailerId || item?.item_id || 'Item',
                item_price:
                  item?.item_price ?? catalogInfo?.price_value ?? item?.item_price ?? null,
                currency: item?.currency || catalogInfo?.currency || item?.currency || null,
              };
            });
            details.orderMetadata = {
              ...details.orderMetadata,
              catalog_id: catalogId,
              product_items: enriched,
            };
            details.text = buildOrderSummaryText(details.orderMetadata.text, enriched);
          }
        } catch (error) {
          logger.warn('Failed to enrich order metadata with catalog details', {
            storeId,
            messageId: message.id,
            error: error.message,
          });
        }
      }
      logger.info('Inbound WhatsApp message received', {
        storeId,
        messageId: message.id,
        customerPhone: message.from,
        messageType: details.type || message.type || 'text',
        text: details.text,
      });
      const event = {
        id: message.id,
        type: 'message',
        from: message.from,
        timestamp: new Date(parseInt(message.timestamp) * 1000).toISOString(),
        text: details.text,
      };

      EventBuffer.addEvent(event);

      if (storeId) {
        await persistWhatsAppMessage({
          storeId,
          customerPhone: message.from,
          direction: 'inbound',
          messageType: details.type || message.type || 'text',
          timestamp: event.timestamp,
          messageId: message.id,
          text: details.text,
          customerName: message.profile?.name || null,
          metadata: {
            phoneNumberId,
            wabaId,
            displayPhoneNumber,
            raw: metadata,
          },
          mediaId: details.mediaId,
          mediaMetadata: details.mediaMetadata,
          locationMetadata: details.locationMetadata,
          orderMetadata: details.orderMetadata,
        });
      } else {
        logger.warn('Skipping message persistence and automation: missing storeId', {
          messageId: message.id,
          customerPhone: message.from,
          phoneNumberId,
          wabaId,
        });
      }

      logger.info('Message persisted', {
        storeId,
        customerPhone: message.from,
        messageId: message.id,
        text: details.text,
      });

      // Process message and send appropriate response
      await handleIncomingMessage({
        message,
        storeId,
        inboundTexts: details.triggerCandidates?.length
          ? details.triggerCandidates
          : details.text
            ? [details.text]
            : [],
        inboundMessageId: message.id,
        metadata: {
          phoneNumberId: storeContext?.phoneNumberId || phoneNumberId,
          wabaId: storeContext?.wabaId || wabaId,
          displayPhoneNumber: storeContext?.displayPhoneNumber || displayPhoneNumber,
          accessToken: storeContext?.accessToken || null,
          whatsappApiUrl: storeContext?.whatsappApiUrl || null,
        },
      });
    }
  }
}

async function handleIncomingMessage({
  message,
  storeId,
  inboundTexts,
  inboundMessageId,
  metadata,
}) {
  const from = message.from;
  const messageId = message.id;

  try {
    const normalizedTexts = (Array.isArray(inboundTexts) ? inboundTexts : [])
      .map((value) => normalizeMatchText(value))
      .filter(Boolean);
    if (normalizedTexts.length > 0) {
      logger.info('Processing inbound message', {
        from,
        text: normalizedTexts[0],
        messageId,
        candidates: normalizedTexts.length,
      });
      const handled = await handleAutomationReply({
        storeId,
        customerPhone: from,
        inboundTexts: normalizedTexts,
        inboundMessageId,
        metadata,
      });
      if (handled) {
        return;
      }
    }

    if (message.type === 'order' && storeId) {
      try {
        const storeConfig = await getStoreConfigById(storeId);
        const notifyPhoneRaw =
          storeConfig?.contact_phone ||
          storeConfig?.franchise_owner_phone ||
          storeConfig?.vendor_phone ||
          null;
        const notifyPhone = notifyPhoneRaw ? formatPhoneToE164(notifyPhoneRaw) : null;
        if (notifyPhone) {
          const order = message.order || {};
          const items = Array.isArray(order.product_items) ? order.product_items : [];
          const orderLines = [
            `New order from ${formatPhoneToE164(from) || from}`,
            `Items: ${items.length}`,
          ];
          items.forEach((item) => {
            const qty = Number(item?.quantity || 0) || 1;
            const label = item?.name || item?.product_retailer_id || item?.item_id || 'Item';
            const price = item?.item_price ? ` @ ${item.item_price}` : '';
            orderLines.push(`- ${qty} x ${label}${price}`);
          });
          const summary = orderLines.join('\n');
          const accessToken = storeConfig?.access_token || metadata?.accessToken || null;
          const phoneNumberId = storeConfig?.phone_number_id || metadata?.phoneNumberId || null;
          const apiUrl =
            storeConfig?.whatsapp_api_url ||
            (phoneNumberId
              ? `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`
              : null);
          if (accessToken && apiUrl) {
            await sendWhatsAppMessageWithToken({
              to: notifyPhone.replace('+', ''),
              payload: { type: 'text', text: { body: summary } },
              accessToken,
              apiUrl,
            });
          } else {
            await whatsappService.sendMessage(notifyPhone, {
              type: 'text',
              text: { body: summary },
            });
          }
        } else {
          logger.warn('Order notification skipped: no contact phone configured', {
            storeId,
          });
        }
      } catch (error) {
        logger.warn('Failed to send order notification', {
          storeId,
          error: error.message,
        });
      }
    }

    // Handle text messages fallback
    if (message.type === 'text') {
      const primaryText = normalizedTexts[0] || '';
      if (primaryText === 'hello') {
        await whatsappService.replyToMessage(from, 'Hello. How are you?', messageId);
      } else if (primaryText === 'list') {
        await whatsappService.sendInteractiveList(from);
      } else if (primaryText === 'buttons') {
        await whatsappService.sendReplyButtons(from);
      }
    }

    // Handle interactive messages
    else if (message.type === 'interactive') {
      const interactive = message.interactive;

      if (interactive.type === 'list_reply') {
        const selectedId = interactive.list_reply.id;
        const selectedTitle = interactive.list_reply.title;

        logger.info('List reply received', { from, selectedId, selectedTitle });

        await whatsappService.sendTextMessage(
          from,
          `You selected: ${selectedTitle} (ID: ${selectedId})`
        );
      } else if (interactive.type === 'button_reply') {
        const selectedId = interactive.button_reply.id;
        const selectedTitle = interactive.button_reply.title;

        logger.info('Button reply received', { from, selectedId, selectedTitle });

        await whatsappService.sendTextMessage(
          from,
          `You clicked: ${selectedTitle} (ID: ${selectedId})`
        );
      }
    }
  } catch (error) {
    logger.error('Error handling incoming message', {
      from,
      messageId,
      error: error.message,
    });
  }
}

// GET /events - Get webhook events
router.get('/events', (req, res) => {
  const format = req.query.format || 'json';

  try {
    if (format === 'html') {
      const html = EventBuffer.getEventsAsHtml();
      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } else {
      const events = EventBuffer.getEvents();
      res.json(events);
    }
  } catch (error) {
    logger.error('Error fetching events', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// GET /logs - Get system logs
router.get('/logs', (req, res) => {
  const format = req.query.format || 'json';

  try {
    const logs = getLogBuffer();

    if (format === 'html') {
      const rows = logs
        .map(
          (log) => `
        <tr>
          <td>${log.timestamp}</td>
          <td><span class="level-${log.level.toLowerCase()}">${log.level}</span></td>
          <td>${log.message}</td>
        </tr>
      `
        )
        .join('');

      const html = `
        <html>
          <head>
            <title>WhatsApp Service Logs</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 20px; }
              table { border-collapse: collapse; width: 100%; }
              th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
              th { background-color: #f2f2f2; }
              tr:nth-child(even) { background-color: #f9f9f9; }
              .level-error { color: #d32f2f; font-weight: bold; }
              .level-warn { color: #f57c00; font-weight: bold; }
              .level-info { color: #1976d2; }
              .level-debug { color: #388e3c; }
            </style>
          </head>
          <body>
            <h1>WhatsApp Service Logs (${logs.length})</h1>
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Level</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </body>
        </html>
      `;

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } else {
      res.json(logs);
    }
  } catch (error) {
    logger.error('Error fetching logs', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

// GET /analytics - Get user analytics
router.get('/analytics', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  try {
    const items = [];
    let lastEvaluatedKey = undefined;
    const maxItems = 1000;

    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: WHATSAPP_MESSAGES_TABLE,
          KeyConditionExpression: 'store_id = :store',
          ExpressionAttributeValues: {
            ':store': storeId,
          },
          ScanIndexForward: false,
          Limit: 500,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      if (result.Items) {
        items.push(...result.Items);
      }

      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey && items.length < maxItems);

    const summaryMap = new Map();

    items.forEach((item) => {
      if (!item.customer_phone) {
        return;
      }

      const originalPhone = item.customer_phone;
      const normalizedPhone = normalizePhoneNumber(originalPhone);
      if (!normalizedPhone) {
        return;
      }

      let summary = summaryMap.get(normalizedPhone);
      if (!summary) {
        summary = {
          normalizedPhone,
          primaryPhone: originalPhone,
          phones: new Set([originalPhone]),
          user: originalPhone,
          name: item.customer_name || originalPhone,
          messages_received: 0,
          messages_sent: 0,
          last_message_text: '',
          last_message_time: '',
          last_message_timestamp: '',
          last_status: null,
          lastInboundTime: '',
          hasInbound: false,
          statuses: {
            sent: 0,
            delivered: 0,
            read: 0,
            failed: 0,
            other: 0,
          },
        };
        summaryMap.set(normalizedPhone, summary);
      } else {
        summary.phones.add(originalPhone);
        summary.primaryPhone = choosePreferredPhoneNumber(summary.primaryPhone, originalPhone);
      }

      if (!summary.primaryPhone) {
        summary.primaryPhone = originalPhone;
      }

      if (!summary.user) {
        summary.user = summary.primaryPhone;
      }

      if (
        item.customer_name &&
        (!summary.name ||
          summary.name === summary.primaryPhone ||
          summary.name.toLowerCase().startsWith('customer '))
      ) {
        summary.name = item.customer_name;
      }

      if (!summary.last_message_time || item.timestamp > summary.last_message_time) {
        summary.last_message_time = item.timestamp;
        summary.last_message_timestamp = item.timestamp;
        summary.last_message_text = getMessagePreviewText(item);
        if (item.direction === 'outbound' && item.status) {
          summary.last_status = item.status;
        }
      }

      if (item.direction === 'inbound') {
        summary.messages_received += 1;
        summary.lastInboundTime = item.timestamp;
        summary.hasInbound = true;
      } else if (item.direction === 'outbound') {
        summary.messages_sent += 1;
        if (item.status) {
          const statusKey = item.status.toLowerCase();
          if (
            statusKey === 'sent' ||
            statusKey === 'delivered' ||
            statusKey === 'read' ||
            statusKey === 'failed'
          ) {
            summary.statuses[statusKey] += 1;
          } else {
            summary.statuses.other += 1;
          }
          summary.last_status = item.status;
        }
      }
    });

    const analytics = Array.from(summaryMap.values())
      .map((summary) => {
        const phones = Array.from(summary.phones);
        if (!phones.includes(summary.primaryPhone)) {
          phones.unshift(summary.primaryPhone);
        }

        return {
          user: summary.primaryPhone,
          name: summary.name || summary.primaryPhone,
          messages_received: summary.messages_received,
          messages_sent: summary.messages_sent,
          last_message_text: summary.last_message_text,
          last_message_time: summary.last_message_time,
          last_message_timestamp: summary.last_message_timestamp,
          last_status: summary.last_status,
          last_inbound_time: summary.lastInboundTime || null,
          has_inbound: summary.hasInbound,
          statuses: summary.statuses,
          phones,
          primary_phone: summary.primaryPhone,
          normalized_phone: summary.normalizedPhone,
        };
      })
      .sort((a, b) => {
        if (!a.last_message_time) return 1;
        if (!b.last_message_time) return -1;
        return new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime();
      });

    res.json(analytics);
  } catch (error) {
    logger.error('Error fetching analytics', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

router.get('/contacts', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }
  if (!CUSTOMER_RECORDS_TABLE) {
    return res.status(500).json({ error: 'Customer records table is not configured.' });
  }

  try {
    const contacts = [];
    let lastEvaluatedKey;
    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: CUSTOMER_RECORDS_TABLE,
          KeyConditionExpression: 'store_id = :store',
          ExpressionAttributeValues: {
            ':store': storeId,
          },
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      if (result.Items) {
        contacts.push(...result.Items);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    const mapped = contacts
      .map((item) => {
        const rawPhone =
          item.customer_phone || item.phone || item.normalized_phone || item.display_phone || null;
        const normalized = formatPhoneWithCountryDigits(rawPhone);
        const rawName = item.customer_name ?? item.display_name ?? item.name ?? null;
        const trimmedName = typeof rawName === 'string' ? rawName.trim() : '';

        if (!trimmedName) {
          return null;
        }

        return {
          contact_id: item.contact_id || (normalized ? `${storeId}_${normalized}` : null),
          phone: formatPhoneToE164(rawPhone) || (normalized ? `+${normalized}` : rawPhone) || null,
          display_name: trimmedName,
          normalized_phone: normalized || null,
          tag: item.tag || item.customer_tag || null,
          created_at: item.created_at || null,
          updated_at: item.updated_at || null,
          source: item.source || null,
        };
      })
      .filter(Boolean);

    res.json({
      contacts: mapped,
    });
  } catch (error) {
    logger.error('Failed to load saved contacts', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to load saved contacts.' });
  }
});

router.post('/contacts', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }
  if (!CUSTOMER_RECORDS_TABLE) {
    return res.status(500).json({ error: 'Customer records table is not configured.' });
  }

  const { phone, name, tag } = req.body || {};
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  const normalizedDigits = normalizePhoneWithDefaultCountry(phone);
  if (!normalizedDigits) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedTag = typeof tag === 'string' ? tag.trim() : '';
  const contactId = randomUUID();
  const formattedPhone = formatPhoneToE164(phone) || `+${normalizedDigits}`;
  const now = new Date().toISOString();

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: CUSTOMER_RECORDS_TABLE,
        Key: { store_id: storeId, customer_phone: normalizedDigits },
        UpdateExpression:
          'SET #phone = :phone, #name = :name, #tag = :tag, #normalized = :normalized, #contact = if_not_exists(#contact, :contactId), #updated = :updated, #created = if_not_exists(#created, :created), #source = :source',
        ExpressionAttributeNames: {
          '#phone': 'phone',
          '#name': 'display_name',
          '#tag': 'tag',
          '#normalized': 'normalized_phone',
          '#contact': 'contact_id',
          '#updated': 'updated_at',
          '#created': 'created_at',
          '#source': 'source',
        },
        ExpressionAttributeValues: {
          ':phone': formattedPhone,
          ':name': trimmedName || null,
          ':tag': trimmedTag || null,
          ':normalized': normalizedDigits,
          ':contactId': contactId,
          ':updated': now,
          ':created': now,
          ':source': 'whatsapp',
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    res.json({
      contact: {
        contact_id: result.Attributes?.contact_id || contactId,
        phone: formattedPhone,
        display_name: trimmedName || null,
        tag: trimmedTag || null,
        normalized_phone: normalizedDigits,
        created_at: result.Attributes?.created_at || now,
        updated_at: result.Attributes?.updated_at || now,
        source: 'whatsapp',
      },
    });
  } catch (error) {
    logger.error('Failed to save WhatsApp contact', { store_id: storeId, error: error.message });
    res.status(500).json({ error: 'Unable to save contact details.' });
  }
});

router.delete('/contacts/:phone', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }
  if (!CUSTOMER_RECORDS_TABLE) {
    return res.status(500).json({ error: 'Customer records table is not configured.' });
  }

  const rawPhone = req.params?.phone || '';
  const normalizedDigits = normalizePhoneWithDefaultCountry(rawPhone);
  if (!normalizedDigits) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }

  try {
    const attempts = new Set([normalizedDigits]);
    if (normalizedDigits.length > 10) {
      attempts.add(normalizedDigits.slice(-10));
    }

    for (const key of attempts) {
      await docClient.send(
        new DeleteCommand({
          TableName: CUSTOMER_RECORDS_TABLE,
          Key: { store_id: storeId, customer_phone: key },
        })
      );
    }

    return res.json({ success: true, deleted: Array.from(attempts) });
  } catch (error) {
    logger.error('Failed to delete contact', { store_id: storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to delete contact.' });
  }
});

router.post('/contacts/import', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token.' });
  }
  if (!CUSTOMER_RECORDS_TABLE) {
    return res.status(500).json({ error: 'Customer records table is not configured.' });
  }

  const contacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  if (contacts.length === 0) {
    return res.status(400).json({ error: 'contacts array is required.' });
  }

  const now = new Date().toISOString();
  let imported = 0;
  let skipped = 0;
  const errors = [];

  const isInvalidName = (value) => {
    const name = (value || '').toString().trim().toLowerCase();
    return !name || name === 'nill' || name === 'nil';
  };

  // Process sequentially to keep DynamoDB throttling risk low.
  for (let index = 0; index < contacts.length; index += 1) {
    const row = contacts[index] || {};
    const rawPhone =
      row.customer_phone || row.phone || row.mobile_number || row.mobile || row.mobileNumber || '';
    const rawName = row.customer_name || row.name || row.customerName || '';

    const normalizedDigits = normalizePhoneWithDefaultCountry(rawPhone);
    if (!normalizedDigits) {
      skipped += 1;
      continue;
    }

    if (isInvalidName(rawName)) {
      skipped += 1;
      continue;
    }

    const trimmedName = rawName.toString().trim();
    const contactId = randomUUID();
    const formattedPhone = formatPhoneToE164(rawPhone) || `+${normalizedDigits}`;

    try {
      await docClient.send(
        new UpdateCommand({
          TableName: CUSTOMER_RECORDS_TABLE,
          Key: { store_id: storeId, customer_phone: normalizedDigits },
          UpdateExpression:
            'SET #phone = :phone, #displayName = :displayName, #customerName = :customerName, #normalized = :normalized, #contact = if_not_exists(#contact, :contactId), #updated = :updated, #created = if_not_exists(#created, :created), #source = :source',
          ExpressionAttributeNames: {
            '#phone': 'phone',
            '#displayName': 'display_name',
            '#customerName': 'customer_name',
            '#normalized': 'normalized_phone',
            '#contact': 'contact_id',
            '#updated': 'updated_at',
            '#created': 'created_at',
            '#source': 'source',
          },
          ExpressionAttributeValues: {
            ':phone': formattedPhone,
            ':displayName': trimmedName,
            ':customerName': trimmedName,
            ':normalized': normalizedDigits,
            ':contactId': contactId,
            ':updated': now,
            ':created': now,
            ':source': 'import',
          },
        })
      );
      imported += 1;
    } catch (error) {
      skipped += 1;
      errors.push({ index, error: error?.message || 'Unable to import contact' });
    }
  }

  return res.json({ success: true, imported, skipped, errors });
});
// Helper function to get campaign details for a customer
async function getCampaignDetailsForCustomer(storeId, customerPhone) {
  try {
    const analyticsService = require('../services/analyticsService');
    const campaigns = await analyticsService.getCampaignDetailsByCustomer(storeId, customerPhone);
    return campaigns || [];
  } catch (error) {
    logger.error('Error fetching campaign details for customer', {
      storeId,
      customerPhone,
      error: error.message,
    });
    return [];
  }
}

async function getCampaignDetailsForCustomers(storeId, customerPhones) {
  const uniquePhones = Array.from(
    new Set(
      (customerPhones || [])
        .map((phone) => (typeof phone === 'string' ? phone.trim() : ''))
        .filter(Boolean)
    )
  );

  if (!uniquePhones.length) {
    return [];
  }

  const results = await Promise.all(
    uniquePhones.map((phone) => getCampaignDetailsForCustomer(storeId, phone))
  );
  const merged = new Map();

  results.flat().forEach((campaign) => {
    if (!campaign) {
      return;
    }
    const campaignId =
      campaign.campaign_id || `${campaign.campaign_name || 'campaign'}-${campaign.sent_at}`;
    if (!merged.has(campaignId)) {
      merged.set(campaignId, campaign);
    }
  });

  return Array.from(merged.values());
}

// GET /chat/:userId - Get chat history for specific user
router.get('/chat/:userId', async (req, res) => {
  const { userId } = req.params;
  const storeId = req.user?.store_id;

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  try {
    const candidatePhones = new Set();
    collectPhoneVariants(candidatePhones, userId);

    const queryPhonesParam = req.query.phones;
    if (Array.isArray(queryPhonesParam)) {
      queryPhonesParam.forEach((phone) => collectPhoneVariants(candidatePhones, phone));
    } else if (typeof queryPhonesParam === 'string') {
      queryPhonesParam.split(',').forEach((phone) => collectPhoneVariants(candidatePhones, phone));
    }

    if (typeof req.query.normalized === 'string') {
      collectPhoneVariants(candidatePhones, req.query.normalized);
    }

    const phonesToQuery = Array.from(candidatePhones).filter(Boolean);
    if (!phonesToQuery.length) {
      phonesToQuery.push(userId);
    }

    const fetchedItems = [];
    const seenMessageIds = new Set();

    for (const phone of phonesToQuery) {
      try {
        const result = await docClient.send(
          new QueryCommand({
            TableName: WHATSAPP_MESSAGES_TABLE,
            IndexName: WHATSAPP_MESSAGES_CUSTOMER_INDEX,
            KeyConditionExpression: 'customer_phone = :phone',
            FilterExpression: '#store_id = :store',
            ExpressionAttributeValues: {
              ':phone': phone,
              ':store': storeId,
            },
            ExpressionAttributeNames: {
              '#store_id': 'store_id',
            },
            ScanIndexForward: true,
          })
        );

        if (result.Items) {
          result.Items.forEach((item) => {
            const key = item.message_id || `${item.timestamp}#${item.direction}`;
            if (!seenMessageIds.has(key)) {
              seenMessageIds.add(key);
              fetchedItems.push(item);
            }
          });
        }
      } catch (queryError) {
        logger.error('Error querying chat history variant', {
          storeId,
          phoneVariant: phone,
          error: queryError.message,
        });
      }
    }

    // Get campaign details for this customer across variants
    const campaignDetails = await getCampaignDetailsForCustomers(storeId, phonesToQuery);

    const chatHistory = await Promise.all(
      fetchedItems
        .filter((item) => item.direction === 'inbound' || item.direction === 'outbound')
        .map(async (item) => {
          const messageType = item.message_type || (item.direction === 'inbound' ? 'text' : 'text');
          const mediaMetadata = item.media_metadata || null;
          const locationMetadata = item.location_metadata || null;
          const mediaId = item.media_id || null;
          let mediaUrl = null;
          let derivedFileName = null;

          if (mediaId) {
            const isResendKey = resendService.isValidResendImageKey(mediaId);
            if (isResendKey) {
              try {
                mediaUrl = await resendService.createPresignedGet(mediaId);
                derivedFileName = mediaId.split('/').pop() || null;
              } catch (error) {
                logger.warn('Failed to create presigned URL for campaign media', {
                  storeId,
                  mediaId,
                  error: error.message,
                });
              }
            }
            if (!mediaUrl && !isResendKey) {
              mediaUrl = `/api/whatsapp/media/${encodeURIComponent(mediaId)}`;
            }
          }

          const media = mediaId
            ? {
                id: mediaId,
                url: mediaUrl,
                caption: mediaMetadata?.caption || null,
                mimeType: mediaMetadata?.mimeType || mediaMetadata?.mime_type || null,
                fileName:
                  mediaMetadata?.fileName || mediaMetadata?.filename || derivedFileName || null,
                sha256: mediaMetadata?.sha256 || null,
              }
            : null;

          return {
            id: item.message_id || `${item.timestamp}#${item.direction}`,
            type: item.direction === 'inbound' ? 'received' : 'sent',
            text: item.body || getMessagePreviewText(item) || '',
            timestamp: item.timestamp,
            from: item.direction === 'inbound' ? 'customer' : 'vendor',
            status: item.direction === 'outbound' ? item.status || 'sent' : null,
            statusHistory: item.status_history || [],
            campaignName: item.campaign_name || null,
            campaignId: item.campaign_id || null,
            isCampaign: Boolean(item.campaign_name),
            mediaId: item.media_id || null,
            templateName: item.template_name || null,
            messageType,
            media,
            location: locationMetadata || null,
          };
        })
    );

    chatHistory.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const existingCampaignIds = new Set(
      chatHistory.filter((message) => message.campaignId).map((message) => message.campaignId)
    );

    // Add campaign details as system messages when a stored message is not present
    const enrichedHistory = [];
    campaignDetails.forEach((campaign) => {
      const campaignId = campaign.campaign_id || `${campaign.campaign_name}-${campaign.sent_at}`;
      if (existingCampaignIds.has(campaignId)) {
        return;
      }
      enrichedHistory.push({
        id: `campaign-${campaignId}`,
        type: 'system',
        text: `📢 Campaign: ${campaign.campaign_name}`,
        timestamp: campaign.sent_at,
        from: 'system',
        status: campaign.status,
        campaignName: campaign.campaign_name,
        campaignId,
        isCampaign: true,
      });
    });

    // Merge and sort all messages
    const allMessages = [...chatHistory, ...enrichedHistory].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    logger.info('Chat history retrieved', {
      storeId,
      userId,
      phoneVariants: phonesToQuery,
      messageCount: allMessages.length,
      campaignCount: campaignDetails.length,
    });
    res.json(allMessages);
  } catch (error) {
    logger.error('Error fetching chat history', { storeId, userId, error: error.message });
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// DELETE /chat/:userId - Delete chat history for a specific customer
router.delete('/chat/:userId', async (req, res) => {
  const { userId } = req.params;
  const storeId = req.user?.store_id;

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  if (!WHATSAPP_MESSAGES_TABLE) {
    return res.status(500).json({ error: 'WhatsApp messages table is not configured.' });
  }

  try {
    const candidatePhones = new Set();
    collectPhoneVariants(candidatePhones, userId);

    const queryPhonesParam = req.query.phones;
    if (Array.isArray(queryPhonesParam)) {
      queryPhonesParam.forEach((phone) => collectPhoneVariants(candidatePhones, phone));
    } else if (typeof queryPhonesParam === 'string') {
      queryPhonesParam.split(',').forEach((phone) => collectPhoneVariants(candidatePhones, phone));
    }

    if (typeof req.query.normalized === 'string') {
      collectPhoneVariants(candidatePhones, req.query.normalized);
    }

    const phonesToQuery = Array.from(candidatePhones).filter(Boolean);
    if (!phonesToQuery.length) {
      phonesToQuery.push(userId);
    }

    const deleteKeys = new Map();

    for (const phone of phonesToQuery) {
      try {
        let lastEvaluatedKey;
        do {
          const result = await docClient.send(
            new QueryCommand({
              TableName: WHATSAPP_MESSAGES_TABLE,
              IndexName: WHATSAPP_MESSAGES_CUSTOMER_INDEX,
              KeyConditionExpression: 'customer_phone = :phone',
              FilterExpression: '#store_id = :store',
              ExpressionAttributeValues: {
                ':phone': phone,
                ':store': storeId,
              },
              ExpressionAttributeNames: {
                '#store_id': 'store_id',
              },
              ExclusiveStartKey: lastEvaluatedKey,
            })
          );

          (result.Items || []).forEach((item) => {
            if (!item?.timestamp) {
              return;
            }
            const key = `${storeId}#${item.timestamp}`;
            if (!deleteKeys.has(key)) {
              deleteKeys.set(key, { store_id: storeId, timestamp: item.timestamp });
            }
          });

          lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey);
      } catch (queryError) {
        logger.error('Error querying messages for deletion', {
          storeId,
          phoneVariant: phone,
          error: queryError.message,
        });
      }
    }

    const keys = Array.from(deleteKeys.values());
    if (keys.length === 0) {
      return res.json({ deleted: 0 });
    }

    let deleted = 0;
    for (let index = 0; index < keys.length; index += 25) {
      const chunk = keys.slice(index, index + 25);
      const response = await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [WHATSAPP_MESSAGES_TABLE]: chunk.map((key) => ({
              DeleteRequest: {
                Key: key,
              },
            })),
          },
        })
      );

      deleted += chunk.length;
      const unprocessed = response?.UnprocessedItems?.[WHATSAPP_MESSAGES_TABLE] || [];
      if (unprocessed.length > 0) {
        logger.warn('Unprocessed message deletions', {
          storeId,
          userId,
          unprocessed: unprocessed.length,
        });
      }
    }

    logger.info('Deleted chat history', {
      storeId,
      userId,
      deleted,
    });

    res.json({ deleted });
  } catch (error) {
    logger.error('Failed to delete chat history', { storeId, userId, error: error.message });
    res.status(500).json({ error: 'Failed to delete chat history' });
  }
});

// POST /chat/:userId/send - Send message to specific user
router.post('/chat/:userId/send', async (req, res) => {
  const { userId } = req.params;
  const { message, name } = req.body || {};

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message text is required' });
  }

  try {
    logger.info('Sending message to user', { userId, message });

    // Get WhatsApp config from request user context
    const whatsappApiUrl = req.user.whatsapp_api_url;
    const accessToken = req.user.access_token;

    if (!whatsappApiUrl || !accessToken) {
      return res.status(400).json({ error: 'WhatsApp configuration not found' });
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: userId,
      type: 'text',
      text: {
        preview_url: false,
        body: message.trim(),
      },
    };

    const response = await axios.post(whatsappApiUrl, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    const apiResponse = response.data || {};

    // Create event for sent message
    const event = {
      id: apiResponse.messages?.[0]?.id || `sent_${Date.now()}`,
      type: 'sent',
      text: message.trim(),
      timestamp: new Date().toISOString(),
      recipient: userId,
    };

    // Add to event buffer
    EventBuffer.addEvent(event);

    if (req.user?.store_id) {
      await persistWhatsAppMessage({
        storeId: req.user.store_id,
        customerPhone: userId,
        direction: 'outbound',
        messageType: 'text',
        timestamp: event.timestamp,
        messageId: event.id,
        text: message.trim(),
        status: 'sent',
        customerName: name || null,
        metadata: {
          phoneNumberId: req.user.phone_number_id || null,
          wabaId: req.user.waba_id || null,
          displayPhoneNumber: req.user.waba_mobile_number || null,
        },
      });
    }

    logger.info('Message sent successfully', { userId, messageId: event.id });
    res.json({
      success: true,
      messageId: event.id,
      timestamp: event.timestamp,
      status: 'sent',
      whatsappResponse: apiResponse,
    });
  } catch (error) {
    logger.error('Error sending message', { userId, message, error: error.message });
    res.status(500).json({
      error: 'Failed to send message',
      details: error.message,
    });
  }
});

// POST /chat/:userId/send-media - Send media message to specific user
router.post('/chat/:userId/send-media', upload.single('file'), async (req, res) => {
  const { userId } = req.params;
  const caption = req.body?.caption || '';
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Media file is required' });
  }

  const mediaType = resolveChatMediaType(file);
  if (!mediaType) {
    return res.status(400).json({ error: 'Unsupported media type' });
  }

  try {
    const whatsappApiUrl = req.user?.whatsapp_api_url;
    const accessToken = req.user?.access_token;
    const phoneNumberId = req.user?.phone_number_id;
    if (!whatsappApiUrl || !accessToken || !phoneNumberId) {
      return res.status(400).json({ error: 'WhatsApp configuration not found' });
    }

    const mediaId = await uploadChatMedia({
      file,
      phoneNumberId,
      accessToken,
      graphVersion: req.query.version || GRAPH_API_VERSION,
    });

    const payload =
      mediaType === 'IMAGE'
        ? {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: userId,
            type: 'image',
            image: {
              id: mediaId,
              caption: caption ? String(caption).trim() : undefined,
            },
          }
        : {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: userId,
            type: 'document',
            document: {
              id: mediaId,
              filename: file.originalname || undefined,
              caption: caption ? String(caption).trim() : undefined,
            },
          };

    const response = await axios.post(whatsappApiUrl, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const apiResponse = response.data || {};
    const eventId = apiResponse.messages?.[0]?.id || `sent_${Date.now()}`;
    const timestamp = new Date().toISOString();

    EventBuffer.addEvent({
      id: eventId,
      type: 'sent',
      text: caption ? String(caption).trim() : '',
      timestamp,
      recipient: userId,
    });

    if (req.user?.store_id) {
      await persistWhatsAppMessage({
        storeId: req.user.store_id,
        customerPhone: userId,
        direction: 'outbound',
        messageType: mediaType === 'IMAGE' ? 'image' : 'document',
        timestamp,
        messageId: eventId,
        text: caption ? String(caption).trim() : '',
        status: 'sent',
        customerName: req.body?.name || null,
        metadata: {
          phoneNumberId: req.user.phone_number_id || null,
          wabaId: req.user.waba_id || null,
          displayPhoneNumber: req.user.waba_mobile_number || null,
        },
        mediaId,
        mediaMetadata: {
          id: mediaId,
          caption: caption ? String(caption).trim() : null,
          mimeType: file.mimetype,
          fileName: file.originalname || null,
        },
      });
    }

    res.json({
      success: true,
      messageId: eventId,
      timestamp,
      status: 'sent',
      mediaId,
      messageType: mediaType.toLowerCase(),
    });
  } catch (error) {
    logger.error('Error sending media message', {
      userId,
      error: error.message,
    });
    res.status(500).json({
      error: 'Failed to send media message',
      details: error.message,
    });
  }
});

router.post('/media/upload', upload.single('file'), async (req, res) => {
  const {
    store_id: storeId,
    access_token: accessToken,
    phone_number_id: phoneNumberId,
  } = req.user || {};
  const mediaType = req.body?.media_type;
  const file = req.file;
  const fileUrl = typeof req.body?.file_url === 'string' ? req.body.file_url.trim() : '';

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  if (!accessToken || !phoneNumberId) {
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  if (!file && !fileUrl) {
    return res.status(400).json({ error: 'Media file is required' });
  }

  const allowedPrefixes = ['image/', 'video/', 'application/', 'text/'];

  let uploadBuffer = file ? file.buffer : null;
  let uploadMime = file ? file.mimetype : null;
  let uploadSize = file ? file.size : null;
  let uploadName = file ? file.originalname : null;

  if (!uploadBuffer && fileUrl) {
    try {
      const downloadResponse = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
      });

      uploadBuffer = Buffer.from(downloadResponse.data);
      uploadMime =
        downloadResponse.headers['content-type'] ||
        (mediaType === 'IMAGE'
          ? 'image/jpeg'
          : mediaType === 'VIDEO'
            ? 'video/mp4'
            : mediaType === 'DOCUMENT'
              ? 'application/pdf'
              : 'application/octet-stream');
      uploadSize = Number(downloadResponse.headers['content-length']) || uploadBuffer.length;
      const fromUrl = fileUrl.split('/').pop();
      uploadName = (fromUrl ? fromUrl.split('?')[0] : '') || `media_${Date.now()}`;
    } catch (error) {
      logger.error('Failed to download media from URL', {
        storeId,
        fileUrl,
        error: error.message,
      });
      return res.status(400).json({ error: 'Failed to download media from URL' });
    }
  }

  if (!uploadBuffer || !uploadMime) {
    return res.status(400).json({ error: 'Media file is required' });
  }

  if (!allowedPrefixes.some((prefix) => uploadMime.startsWith(prefix))) {
    return res.status(400).json({ error: `Unsupported media type: ${uploadMime}` });
  }

  try {
    logger.info('Uploading template media to WhatsApp', {
      storeId,
      phoneNumberId,
      mimetype: uploadMime,
      size: uploadSize,
      mediaType,
    });

    const version = req.query.version || GRAPH_API_VERSION;

    const sessionUrl = `https://graph.facebook.com/${version}/app/uploads`;
    const sessionResponse = await axios.post(
      sessionUrl,
      {
        file_length: uploadSize,
        file_type: uploadMime,
        file_name: uploadName,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const uploadId = sessionResponse.data?.id;
    if (!uploadId) {
      throw new Error('Failed to create upload session');
    }

    const uploadUrl = `https://graph.facebook.com/${version}/${uploadId}`;
    const uploadResponse = await axios.post(uploadUrl, uploadBuffer, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': uploadMime,
        file_offset: 0,
      },
      maxBodyLength: Infinity,
    });

    const mediaHandle = uploadResponse.data?.h || uploadResponse.data?.handle || null;
    if (!mediaHandle) {
      throw new Error('Upload response did not include media handle');
    }

    logger.info('WhatsApp media uploaded', {
      storeId,
      phoneNumberId,
      uploadId,
      mediaHandle,
    });

    res.json({
      success: true,
      mediaHandle,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const errorMessage =
      error.response?.data?.error?.message || error.message || 'Failed to upload media';

    logger.error('Error uploading template media', {
      storeId,
      phoneNumberId,
      status,
      error: errorMessage,
    });

    res.status(status).json({ error: errorMessage });
  }
});

router.post('/media/upload-message', upload.single('file'), async (req, res) => {
  const {
    store_id: storeId,
    access_token: accessToken,
    phone_number_id: phoneNumberId,
  } = req.user || {};
  const file = req.file;

  if (!storeId) {
    return res.status(400).json({ error: 'Store context missing from request' });
  }

  if (!accessToken || !phoneNumberId) {
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  if (!file) {
    return res.status(400).json({ error: 'Media file is required' });
  }

  const allowedPrefixes = ['image/', 'video/', 'application/'];
  if (!allowedPrefixes.some((prefix) => (file.mimetype || '').startsWith(prefix))) {
    return res.status(400).json({ error: `Unsupported media type: ${file.mimetype}` });
  }

  try {
    const mediaId = await uploadChatMedia({
      file,
      phoneNumberId,
      accessToken,
      graphVersion: req.query.version || GRAPH_API_VERSION,
    });

    logger.info('WhatsApp message media uploaded', {
      storeId,
      phoneNumberId,
      mediaId,
    });

    res.json({
      success: true,
      mediaId,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const errorMessage =
      error.response?.data?.error?.message || error.message || 'Failed to upload message media';

    logger.error('Error uploading message media', {
      storeId,
      phoneNumberId,
      status,
      error: errorMessage,
    });

    res.status(status).json({ error: errorMessage });
  }
});

router.get('/media/:mediaId', async (req, res) => {
  const { mediaId } = req.params;
  const accessToken = req.user?.access_token;

  if (!mediaId) {
    return res.status(400).json({ error: 'mediaId is required' });
  }

  if (!accessToken) {
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  try {
    const metadataResponse = await axios.get(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(mediaId)}`,
      {
        params: {
          access_token: accessToken,
        },
      }
    );

    const metadata = metadataResponse.data || {};
    const downloadUrl = metadata.url || metadata.href;
    if (!downloadUrl) {
      return res.status(404).json({ error: 'Media URL not available' });
    }

    const mediaResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const mimeType =
      metadata.mime_type || mediaResponse.headers['content-type'] || 'application/octet-stream';
    const fileName = metadata.file_name || `media_${mediaId}`;

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename=\"${fileName}\"`);
    res.send(Buffer.from(mediaResponse.data));
  } catch (error) {
    const status = error.response?.status || 500;
    const message =
      error.response?.data?.error?.message || error.message || 'Failed to fetch media';
    logger.error('Error fetching WhatsApp media', { mediaId, error: message });
    res.status(status).json({ error: message });
  }
});

const ALLOWED_TEMPLATE_CATEGORIES = new Set(['MARKETING', 'UTILITY', 'PROMOTIONAL']);

const normalizeGraphTemplateCategory = (value) => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (ALLOWED_TEMPLATE_CATEGORIES.has(normalized)) {
    return normalized;
  }
  return 'MARKETING';
};

router.post('/templates', async (req, res) => {
  const { waba_id: wabaId, access_token: accessToken, store_id: storeId } = req.user || {};

  if (!wabaId || !accessToken) {
    logger.warn('Template creation missing WhatsApp credentials', { storeId });
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  const {
    name,
    language = 'en_US',
    category = 'MARKETING',
    components: providedComponents,
    header,
    body,
    footer,
    example_header: exampleHeader,
    example_body: exampleBody,
    example_footer: exampleFooter,
    buttons,
  } = req.body || {};

  if (!name || (!body && !(Array.isArray(providedComponents) && providedComponents.length > 0))) {
    return res
      .status(400)
      .json({ error: 'Template name and components with body text are required' });
  }

  let components = [];
  const usingProvidedComponents =
    Array.isArray(providedComponents) && providedComponents.length > 0;

  if (usingProvidedComponents) {
    components = providedComponents;
  }

  if (components.length === 0 && header && header.trim()) {
    const headerComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: header.trim(),
    };
    const headerExample = parseExampleList(exampleHeader);
    if (headerExample && headerExample.length > 0) {
      headerComponent.example = {
        header_text: headerExample,
      };
    }
    components.push(headerComponent);
  }

  if (components.length === 0 && body && body.trim()) {
    const bodyComponent = {
      type: 'BODY',
      text: body.trim(),
    };
    const bodyExample = parseExampleList(exampleBody);
    if (bodyExample && bodyExample.length > 0) {
      bodyComponent.example = {
        body_text: [bodyExample],
      };
    }
    components.push(bodyComponent);
  }

  if (components.length === 0 && footer && footer.trim()) {
    const footerComponent = {
      type: 'FOOTER',
      text: footer.trim(),
    };
    const footerExample = parseExampleList(exampleFooter);
    if (footerExample && footerExample.length > 0) {
      footerComponent.example = {
        footer_text: footerExample,
      };
    }
    components.push(footerComponent);
  }

  if (!usingProvidedComponents && Array.isArray(buttons) && buttons.length > 0) {
    const parsedButtons = buttons
      .map((button) => ({
        type: button.type,
        text: button.text,
        url: button.url,
        phone_number: button.phone_number,
      }))
      .filter((button) => button.type && button.text);

    if (parsedButtons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: parsedButtons,
      });
    }
  }

  if (!components.length) {
    return res.status(400).json({ error: 'Template components are required' });
  }

  const version = req.query.version || GRAPH_API_VERSION;
  const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;

  let sanitizedName = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!sanitizedName) {
    sanitizedName = `template_${Date.now()}`;
  }

  const payload = {
    name: sanitizedName,
    language,
    category: normalizeGraphTemplateCategory(category),
    components,
  };

  try {
    logger.info('Creating WhatsApp template', {
      storeId,
      wabaId,
      template: payload.name,
      componentCount: payload.components?.length || 0,
      payload,
    });
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    res.status(201).json({
      success: true,
      template: response.data,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const graphError = error.response?.data?.error;
    const userMessage =
      (typeof graphError?.error_user_msg === 'string' && graphError.error_user_msg.trim()) ||
      (typeof graphError?.message === 'string' && graphError.message.trim()) ||
      error.message ||
      'Failed to create template';

    logger.error('Error creating WhatsApp template', {
      storeId,
      wabaId,
      status,
      error: userMessage,
      details: error.response?.data,
    });
    res.status(status).json({
      error: userMessage,
      details: error.response?.data || null,
    });
  }
});

router.put('/templates/:templateId', async (req, res) => {
  const { waba_id: wabaId, access_token: accessToken, store_id: storeId } = req.user || {};

  if (!wabaId || !accessToken) {
    logger.warn('Template update missing WhatsApp credentials', { storeId });
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  const templateId = (req.params.templateId || '').trim();
  if (!templateId) {
    return res.status(400).json({ error: 'Template ID is required to update template' });
  }

  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  if (
    !payload?.components ||
    !Array.isArray(payload.components) ||
    payload.components.length === 0
  ) {
    return res.status(400).json({ error: 'Template update requires valid components' });
  }

  if (payload.category) {
    payload.category = normalizeGraphTemplateCategory(payload.category);
  }

  const version = req.query.version || GRAPH_API_VERSION;
  const url = `https://graph.facebook.com/${version}/${templateId}`;

  try {
    logger.info('Updating WhatsApp template', {
      storeId,
      wabaId,
      templateId,
    });

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    res.json({
      success: true,
      data: response.data || null,
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const errorMessage =
      error.response?.data?.error?.message || error.message || 'Failed to update template';

    logger.error('Error updating WhatsApp template', {
      storeId,
      wabaId,
      templateId,
      status,
      error: errorMessage,
      details: error.response?.data,
    });

    res.status(status).json({
      error: errorMessage,
      details: error.response?.data || null,
    });
  }
});

router.delete('/templates/:identifier', async (req, res) => {
  const { waba_id: wabaId, access_token: accessToken, store_id: storeId } = req.user || {};

  if (!wabaId || !accessToken) {
    logger.warn('Template delete missing WhatsApp credentials', { storeId });
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  const paramIdentifier = req.params.identifier;
  const queryTemplateName = req.query.name;
  const templateName = (queryTemplateName || paramIdentifier || '').trim();

  if (!templateName) {
    return res.status(400).json({ error: 'Template name is required to delete template' });
  }

  const version = req.query.version || GRAPH_API_VERSION;
  const url = `https://graph.facebook.com/${version}/${wabaId}/message_templates`;

  try {
    logger.info('Deleting WhatsApp template', {
      storeId,
      wabaId,
      templateName,
    });

    await axios.delete(url, {
      params: {
        name: templateName,
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    res.json({
      success: true,
      message: 'Template deleted',
    });
  } catch (error) {
    const status = error.response?.status || 500;
    const errorMessage =
      error.response?.data?.error?.message || error.message || 'Failed to delete template';

    logger.error('Error deleting WhatsApp template', {
      storeId,
      wabaId,
      templateName,
      status,
      error: errorMessage,
      details: error.response?.data,
    });

    res.status(status).json({ error: errorMessage });
  }
});

// GET /customers - Get unique customers for a store from invoices
router.get('/customers', async (req, res) => {
  const { storeId } = req.query;

  if (!storeId) {
    return res.status(400).json({ error: 'storeId is required' });
  }

  try {
    logger.info('Fetching customers for store from invoices', { storeId });

    // Use analytics service to get invoices for the store
    const analyticsService = require('../services/analyticsService');
    const invoices = await analyticsService.getInvoices(storeId);

    // Extract unique customer phone numbers from invoices
    const customerPhones = new Set();

    invoices.forEach((invoice) => {
      if (invoice.customer_phone) {
        const normalized = formatPhoneWithCountryDigits(invoice.customer_phone);
        if (normalized) {
          customerPhones.add(normalized);
        }
      }
    });

    // Convert to array of customer objects
    const customers = Array.from(customerPhones).map((phone) => ({
      phone,
    }));

    logger.info('Customers retrieved from invoices', { storeId, count: customers.length });
    res.json(customers);
  } catch (error) {
    logger.error('Error fetching customers from invoices', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /campaigns - Get recent campaigns for a store (per customer rows)
router.get('/campaigns', async (req, res) => {
  const { storeId } = req.query;

  if (!storeId) {
    return res.status(400).json({ error: 'storeId is required' });
  }

  try {
    logger.info('Fetching campaigns for store', { storeId });

    // Get campaign events from event buffer
    const events = EventBuffer.getEvents();
    const campaignEvents = events.filter((event) => event.type === 'campaign');

    // Transform events into per-customer campaign rows
    const campaigns = campaignEvents.map((event) => ({
      campaignName: event.campaignName || 'Unknown Campaign',
      templateName: event.templateName || null,
      customerPhone: event.recipient,
      customerName: event.customerName || `Customer ${event.recipient}`,
      sentDate: event.timestamp,
      status: event.success !== false ? 'delivered' : 'failed',
    }));

    // Sort by most recent first
    campaigns.sort((a, b) => new Date(b.sentDate).getTime() - new Date(a.sentDate).getTime());

    logger.info('Campaigns retrieved', { storeId, count: campaigns.length });
    res.json(campaigns);
  } catch (error) {
    logger.error('Error fetching campaigns', { storeId, error: error.message });
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// POST /campaigns/quota-check - check franchise-level trial quota
router.post('/campaigns/quota-check', async (req, res) => {
  const storeId = req.user?.store_id;
  const requested = Number(req.body?.requested ?? 0);
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token' });
  }

  try {
    const storeConfig = await getStoreConfigById(storeId);
    const franchiseId = storeConfig?.franchise_id || null;
    let limit = 1000;
    if (franchiseId && FRANCHISES_TABLE) {
      try {
        const franchiseResult = await docClient.send(
          new GetCommand({
            TableName: FRANCHISES_TABLE,
            Key: { franchise_id: franchiseId },
          })
        );
        const configuredLimit = Number(franchiseResult?.Item?.campaign_free_messages);
        if (!Number.isNaN(configuredLimit) && configuredLimit > 0) {
          limit = configuredLimit;
        }
      } catch (error) {
        logger.warn('Failed to load franchise campaign limit', {
          storeId,
          franchiseId,
          error: error.message,
        });
      }
    }

    let storeIds = [storeId];
    if (franchiseId) {
      const franchiseStoreIds = await franchiseService.collectFranchiseStoreIds([franchiseId]);
      if (franchiseStoreIds.length > 0) {
        storeIds = franchiseStoreIds;
      }
    }

    let used = 0;
    for (const id of storeIds) {
      used += await franchiseService.getStoreCampaignSentCount(id);
    }

    const remaining = Math.max(limit - used, 0);
    const allowed = remaining >= requested ? requested : 0;

    return res.json({
      limit,
      used,
      remaining,
      requested,
      allowed,
      franchiseId,
    });
  } catch (error) {
    logger.error('Failed to check campaign quota', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to check campaign quota.' });
  }
});

// POST /campaigns/send - enqueue and process campaign in background
router.post('/campaigns/send', async (req, res) => {
  const {
    name,
    message,
    storeId,
    recipients,
    templateParameters,
    templateName: requestTemplateName,
    campaignId: requestedCampaignId,
    resendSettings: rawResendSettings,
  } = req.body;

  if (!name || !message || !storeId || !recipients || !Array.isArray(recipients)) {
    return res
      .status(400)
      .json({ error: 'name, message, storeId, and recipients array are required' });
  }

  if (
    templateParameters &&
    !Array.isArray(templateParameters) &&
    typeof templateParameters !== 'object'
  ) {
    return res
      .status(400)
      .json({ error: 'templateParameters must be an array or object if provided' });
  }

  try {
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients provided' });
    }

    const templateName = requestTemplateName || req.user.template_name;
    const templateLanguage = req.user.template_language || 'en_US';

    if (!templateName) {
      return res
        .status(400)
        .json({ error: 'WhatsApp template name not provided and not configured for this store' });
    }

    const whatsappApiUrl = req.user?.whatsapp_api_url;
    const accessToken = req.user?.access_token;
    if (!whatsappApiUrl || !accessToken) {
      return res.status(400).json({ error: 'WhatsApp configuration not found' });
    }

    const campaignId = requestedCampaignId || randomUUID();
    const userContext = {
      store_id: req.user?.store_id || storeId,
      template_name: req.user?.template_name || null,
      template_language: templateLanguage,
      whatsapp_api_url: whatsappApiUrl,
      access_token: accessToken,
      phone_number_id: req.user?.phone_number_id || null,
      waba_id: req.user?.waba_id || null,
      waba_mobile_number: req.user?.waba_mobile_number || null,
    };

    const resendSettings = normalizeResendSettingsInput(rawResendSettings);
    if (resendSettings.enabled && !resendService.delayOptionToSeconds(resendSettings.delayOption)) {
      return res
        .status(400)
        .json({ error: 'resendSettings.delayOption must be one of 2m, 5m, 1h, 2h, 1d, 2d' });
    }

    try {
      await resendService.putCampaignMetadata({
        campaign_id: campaignId,
        store_id: userContext.store_id || storeId,
        campaign_name: name,
        template_name: templateName,
        template_language: templateLanguage,
        message,
        template_parameters: templateParameters ?? null,
        send_mode: 'text',
        resend_enabled: resendSettings.enabled,
        resend_delay_option: resendSettings.delayOption || null,
        created_at: new Date().toISOString(),
      });
    } catch (metadataError) {
      logger.warn('Failed to persist campaign metadata', {
        campaignId,
        storeId,
        error: metadataError.message,
      });
    }

    let resendAttemptId = null;
    if (resendSettings.enabled) {
      const delaySeconds = resendService.delayOptionToSeconds(resendSettings.delayOption);
      const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      resendAttemptId = randomUUID();
      try {
        await resendService.createResendAttempt({
          resend_attempt_id: resendAttemptId,
          campaign_id: campaignId,
          store_id: userContext.store_id || storeId,
          scheduled_at: scheduledAt,
          created_at: new Date().toISOString(),
          delay_option: resendSettings.delayOption,
          attempt_number: 1,
          max_attempts: RESEND_MAX_ATTEMPTS,
          status: 'SCHEDULED',
          eligible_count: 0,
          created_by: req.user?.user_id || req.user?.email || null,
        });
      } catch (resendError) {
        logger.warn('Failed to create resend schedule for campaign', {
          campaignId,
          storeId,
          error: resendError.message,
        });
      }
    }

    initCampaignProgress({
      campaignId,
      storeId,
      campaignName: name,
      templateName,
      recipients,
    });

    logger.info('Queued campaign for sending', {
      name,
      storeId,
      recipientCount: recipients.length,
      campaignId,
    });

    setImmediate(() => {
      executeTextCampaignSend({
        campaignId,
        storeId,
        name,
        message,
        recipients,
        templateParameters,
        templateName,
        templateLanguage,
        userContext,
        resendSettings,
      }).catch((error) => {
        logger.error('Background campaign send failed', { campaignId, error: error.message });
      });
    });

    res.json({ success: true, campaignId, resendAttemptId });
  } catch (error) {
    logger.error('Error queuing campaign', { name, storeId, error: error.message });
    res.status(500).json({
      error: 'Failed to queue campaign',
      details: error.message,
    });
  }
});

router.get('/campaigns/active/progress', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token' });
  }

  const campaigns = getActiveCampaignsByStore(storeId);
  res.json({ success: true, campaigns });
});

router.get('/campaigns/:campaignId/progress', async (req, res) => {
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token' });
  }

  const progress = getCampaignProgress(req.params.campaignId);
  if (!progress || progress.storeId !== storeId) {
    return res.status(404).json({ error: 'Campaign progress not found' });
  }

  res.json({ success: true, progress });
});

router.post('/campaigns/send-image-template', upload.single('image'), async (req, res) => {
  const {
    name,
    message,
    storeId,
    templateName: requestTemplateName,
    templateLanguage: requestTemplateLanguage,
    recipients: rawRecipients,
    templateParameters: rawTemplateParameters,
    campaignId: requestedCampaignId,
    resendSettings: rawResendSettings,
    headerImageS3Key: requestHeaderImageS3Key,
    header_image_s3_key: requestHeaderImageS3KeyAlt,
  } = req.body || {};

  if (!name || !storeId) {
    return res.status(400).json({ error: 'name and storeId are required' });
  }

  let recipients;
  try {
    recipients = typeof rawRecipients === 'string' ? JSON.parse(rawRecipients) : rawRecipients;
  } catch (error) {
    return res.status(400).json({ error: 'recipients must be a JSON array' });
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'At least one recipient is required' });
  }

  let templateParameters = null;
  if (
    rawTemplateParameters !== undefined &&
    rawTemplateParameters !== null &&
    rawTemplateParameters !== ''
  ) {
    try {
      const parsed =
        typeof rawTemplateParameters === 'string'
          ? JSON.parse(rawTemplateParameters)
          : rawTemplateParameters;
      if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
        templateParameters = parsed;
      } else {
        return res
          .status(400)
          .json({ error: 'templateParameters must be an array or object when provided' });
      }
    } catch (error) {
      return res.status(400).json({ error: 'templateParameters must be valid JSON' });
    }
  }

  const file = req.file || null;
  const headerImageS3Key = requestHeaderImageS3Key || requestHeaderImageS3KeyAlt || null;

  const userContext = {
    whatsapp_api_url: req.user?.whatsapp_api_url,
    access_token: req.user?.access_token,
    phone_number_id: req.user?.phone_number_id,
    template_language: req.user?.template_language || 'en_US',
    store_id: req.user?.store_id || storeId,
    waba_id: req.user?.waba_id || null,
    waba_mobile_number: req.user?.waba_mobile_number || null,
  };

  if (!userContext.whatsapp_api_url || !userContext.access_token || !userContext.phone_number_id) {
    return res.status(400).json({ error: 'WhatsApp configuration not available for this store' });
  }

  const templateName = requestTemplateName || req.user?.template_name;
  if (!templateName) {
    return res.status(400).json({ error: 'Template name is required for image campaigns' });
  }

  const templateLanguage =
    (requestTemplateLanguage && requestTemplateLanguage.trim()) ||
    req.user?.template_language ||
    'en_US';

  let parsedResendSettings = rawResendSettings;
  if (typeof rawResendSettings === 'string' && rawResendSettings.trim()) {
    try {
      parsedResendSettings = JSON.parse(rawResendSettings);
    } catch (error) {
      return res.status(400).json({ error: 'resendSettings must be valid JSON when provided' });
    }
  }
  const resendSettings = normalizeResendSettingsInput(parsedResendSettings);
  if (resendSettings.enabled && !resendService.delayOptionToSeconds(resendSettings.delayOption)) {
    return res
      .status(400)
      .json({ error: 'resendSettings.delayOption must be one of 2m, 5m, 1h, 2h, 1d, 2d' });
  }

  if (!resendSettings.enabled && !file) {
    return res.status(400).json({ error: 'Image file is required' });
  }
  if (headerImageS3Key && !resendService.isValidResendImageKey(headerImageS3Key)) {
    return res.status(400).json({ error: 'Invalid header_image_s3_key provided' });
  }

  const campaignId = requestedCampaignId || randomUUID();
  initCampaignProgress({
    campaignId,
    storeId,
    campaignName: name,
    templateName,
    recipients,
  });

  try {
    await resendService.putCampaignMetadata({
      campaign_id: campaignId,
      store_id: userContext.store_id || storeId,
      campaign_name: name,
      template_name: templateName,
      template_language: templateLanguage,
      message,
      template_parameters: templateParameters ?? null,
      send_mode: 'image',
      header_image_s3_key: headerImageS3Key,
      resend_enabled: resendSettings.enabled,
      resend_delay_option: resendSettings.delayOption || null,
      created_at: new Date().toISOString(),
    });
  } catch (metadataError) {
    logger.warn('Failed to persist image campaign metadata', {
      campaignId,
      storeId,
      error: metadataError.message,
    });
  }

  const version = req.query.version || GRAPH_API_VERSION;
  const mediaPayload = file
    ? {
        buffer: Buffer.from(file.buffer),
        filename: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        graphVersion: version,
      }
    : null;

  let resendAttemptId = null;
  if (resendSettings.enabled) {
    const delaySeconds = resendService.delayOptionToSeconds(resendSettings.delayOption);
    const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    resendAttemptId = randomUUID();
    try {
      await resendService.createResendAttempt({
        resend_attempt_id: resendAttemptId,
        campaign_id: campaignId,
        store_id: userContext.store_id || storeId,
        scheduled_at: scheduledAt,
        created_at: new Date().toISOString(),
        delay_option: resendSettings.delayOption,
        attempt_number: 1,
        max_attempts: RESEND_MAX_ATTEMPTS,
        status: 'SCHEDULED',
        eligible_count: 0,
        created_by: req.user?.user_id || req.user?.email || null,
      });
    } catch (resendError) {
      logger.warn('Failed to create resend schedule for image campaign', {
        campaignId,
        storeId,
        error: resendError.message,
      });
    }
  }

  logger.info('Queued image template campaign', {
    name,
    storeId,
    recipientCount: recipients.length,
    campaignId,
  });

  setImmediate(() => {
    executeImageCampaignSend({
      campaignId,
      storeId,
      name,
      message,
      recipients,
      templateParameters,
      templateName,
      templateLanguage,
      userContext,
      headerImageS3Key,
      mediaPayload,
      resendSettings,
    }).catch((error) => {
      logger.error('Background image campaign send failed', {
        campaignId,
        error: error.message,
      });
    });
  });

  res.json({ success: true, campaignId, resendAttemptId });
});

router.get('/campaigns/:campaignId/resend', async (req, res) => {
  const campaignId = req.params.campaignId;
  const storeId = req.user?.store_id;

  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token' });
  }
  if (!campaignId) {
    return res.status(400).json({ error: 'campaignId is required' });
  }

  try {
    const metadata = await analyticsService.getCampaignMetadataById(campaignId, storeId);
    if (!metadata || (metadata.store_id && metadata.store_id !== storeId)) {
      return res.status(404).json({ error: 'Campaign metadata not found' });
    }

    if (!process.env.RESEND_ATTEMPTS_TABLE) {
      return res.json({ attempts: [] });
    }

    const attempts = await resendService.listResendAttemptsByCampaignId(campaignId);
    const normalized = await Promise.all(
      attempts.map(async (item) => {
        let sentCount = item.attempted_count ?? 0;
        let deliveredCount = item.success_count ?? 0;
        let failedCount = item.failed_count ?? 0;
        let limitedByMetaCount = item.limited_by_meta_count ?? 0;

        if (process.env.RESEND_RECIPIENTS_TABLE) {
          try {
            const recipients = await resendService.listResendRecipientsByAttempt(
              item.resend_attempt_id
            );
            if (recipients.length > 0) {
              const statuses = recipients.map((recipient) =>
                (recipient.status || '').toString().toUpperCase()
              );
              sentCount = statuses.filter((status) => status && status !== 'QUEUED').length;
              deliveredCount = statuses.filter((status) =>
                ['DELIVERED', 'READ', 'SEEN'].includes(status)
              ).length;
              limitedByMetaCount = statuses.filter((status) => status === 'LIMITED_BY_META').length;
              failedCount = statuses.filter((status) =>
                ['FAILED', 'LIMITED_BY_META'].includes(status)
              ).length;
            }
          } catch (countError) {
            logger.warn('Failed to compute resend recipient counts', {
              resendAttemptId: item.resend_attempt_id,
              error: countError.message,
            });
          }
        }

        return {
          resendAttemptId: item.resend_attempt_id,
          scheduledAt: item.scheduled_at || null,
          createdAt: item.created_at || null,
          delayOption: item.delay_option || null,
          status: item.status || null,
          eligibleCount: item.eligible_count ?? 0,
          attemptedCount: sentCount,
          sentCount,
          deliveredCount,
          successCount: deliveredCount,
          failedCount,
          limitedByMetaCount,
          lastError: item.last_error || null,
        };
      })
    );

    normalized.sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime();
      const bTime = new Date(b.createdAt || 0).getTime();
      return bTime - aTime;
    });

    return res.json({ attempts: normalized });
  } catch (error) {
    logger.error('Failed to fetch resend attempts', {
      campaignId,
      storeId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to fetch resend history.' });
  }
});

router.post('/campaigns/:campaignId/stop', async (req, res) => {
  const campaignId = req.params.campaignId;
  const storeId = req.user?.store_id;
  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token' });
  }
  if (!campaignId) {
    return res.status(400).json({ error: 'campaignId is required' });
  }

  try {
    const metadata = await analyticsService.getCampaignMetadataById(campaignId, storeId);
    if (!metadata || (metadata.store_id && metadata.store_id !== storeId)) {
      return res.status(404).json({ error: 'Campaign metadata not found' });
    }

    await resendService.updateCampaignMetadata(campaignId, {
      resend_enabled: false,
      resend_stopped: true,
      resend_stopped_at: new Date().toISOString(),
    });

    const attempts = await resendService.listResendAttemptsByCampaignId(campaignId).catch(() => []);
    const toCancel = attempts.filter(
      (attempt) => (attempt.status || '').toString().toUpperCase() === 'SCHEDULED'
    );
    await Promise.all(
      toCancel.map((attempt) =>
        resendService
          .updateResendAttemptStatus({
            resendAttemptId: attempt.resend_attempt_id,
            status: 'CANCELLED',
            updates: { last_error: 'Stopped by user.' },
          })
          .catch(() => null)
      )
    );

    return res.json({ success: true });
  } catch (error) {
    logger.error('Failed to stop campaign resend', {
      campaignId,
      storeId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to stop campaign.' });
  }
});

router.post('/campaigns/:campaignId/resend', async (req, res) => {
  const campaignId = req.params.campaignId;
  const storeId = req.user?.store_id;
  const { delayOption, clientRequestId } = req.body || {};

  if (!storeId) {
    return res.status(403).json({ error: 'Store context missing from token' });
  }
  if (!campaignId) {
    return res.status(400).json({ error: 'campaignId is required' });
  }

  const delaySeconds = resendService.delayOptionToSeconds(delayOption);
  if (!delaySeconds) {
    return res.status(400).json({ error: 'delayOption must be one of 2m, 5m, 1h, 2h, 1d, 2d' });
  }

  try {
    const metadata = await analyticsService.getCampaignMetadataById(campaignId, storeId);
    if (!metadata || (metadata.store_id && metadata.store_id !== storeId)) {
      return res.status(404).json({ error: 'Campaign metadata not found' });
    }
    if (metadata.resend_stopped) {
      return res.status(409).json({ error: 'Campaign resend has been stopped.' });
    }

    if (clientRequestId) {
      const existing = await resendService.findAttemptByClientRequest({
        campaignId,
        clientRequestId,
      });
      if (existing) {
        return res.json({
          resendAttemptId: existing.resend_attempt_id,
          scheduledAt: existing.scheduled_at,
          eligibleCount: existing.eligible_count ?? 0,
          status: existing.status,
        });
      }
    }

    const campaignRecipients = await analyticsService.getCampaignRecipients(storeId, {
      campaignId,
    });
    const recipients = Array.isArray(campaignRecipients?.recipients)
      ? campaignRecipients.recipients
      : [];
    const eligible = recipients.filter(isResendEligible);
    const deduped = [];
    const seenPhones = new Set();
    eligible.forEach((recipient) => {
      const phone = recipient.phone || recipient.customer_phone || '';
      if (!phone || seenPhones.has(phone)) {
        return;
      }
      seenPhones.add(phone);
      deduped.push({
        phone,
        name: recipient.name || recipient.customer_name || null,
        status: recipient.status || 'failed',
        error: recipient.error || recipient.error_reason || null,
        errorCode: recipient.errorCode ?? recipient.error_code ?? null,
      });
    });

    if (deduped.length === 0) {
      return res.status(400).json({ error: 'No failed recipients available for resend.' });
    }

    const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const resendAttemptId = randomUUID();
    const attemptItem = {
      resend_attempt_id: resendAttemptId,
      campaign_id: campaignId,
      store_id: storeId,
      created_at: new Date().toISOString(),
      scheduled_at: scheduledAt,
      delay_option: delayOption,
      attempt_number: 1,
      max_attempts: RESEND_MAX_ATTEMPTS,
      client_request_id: clientRequestId || null,
      status: 'SCHEDULED',
      eligible_count: deduped.length,
      attempted_count: 0,
      success_count: 0,
      failed_count: 0,
      limited_by_meta_count: 0,
      created_by: req.user?.user_id || req.user?.email || storeId || null,
    };

    await resendService.createResendAttempt(attemptItem);

    const recipientItems = deduped.map((recipient) => ({
      resend_attempt_id: resendAttemptId,
      phone: recipient.phone,
      name: recipient.name,
      status: 'QUEUED',
      original_status: recipient.status,
      error_reason: recipient.error || null,
      error_code: recipient.errorCode ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

    await resendService.batchWriteRecipients(recipientItems);

    return res.json({
      resendAttemptId,
      scheduledAt,
      eligibleCount: deduped.length,
    });
  } catch (error) {
    logger.error('Failed to schedule resend', {
      campaignId,
      storeId,
      error: error.message,
    });
    return res.status(500).json({ error: 'Unable to schedule resend.' });
  }
});

router.post('/invoices/send-ebill', async (req, res) => {
  const {
    storeId: requestStoreId,
    invoiceNo,
    invoiceId,
    phoneNumber,
    originalCustomerPhone,
  } = req.body || {};

  const storeId = (requestStoreId || req.user?.store_id || '').toString().trim();
  if (!storeId) {
    return res.status(400).json({ error: 'storeId is required' });
  }

  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return res.status(400).json({ error: 'A valid phoneNumber is required' });
  }

  if (!invoiceNo && !invoiceId) {
    return res.status(400).json({ error: 'invoiceNo or invoiceId is required' });
  }

  try {
    const identifiersToTry = [invoiceNo, invoiceId].filter(Boolean);
    let slugRecord = null;
    let attemptedKeys = [];

    for (const identifier of identifiersToTry) {
      const { item, attemptedKeys: attempts } = await getBillSlugRecord(storeId, identifier);
      if (attempts && attempts.length) {
        attemptedKeys.push(...attempts);
        attemptedKeys = Array.from(new Set(attemptedKeys));
      }
      if (item) {
        slugRecord = item;
        break;
      }
    }

    if (!slugRecord) {
      logger.warn('Bill slug not found for invoice', {
        storeId,
        invoiceNo,
        invoiceId,
        attemptedKeys,
      });
      return res.status(404).json({
        error: 'Invoice link not found',
        details: { attemptedKeys },
      });
    }

    const slug =
      slugRecord.slug ||
      slugRecord.Slug ||
      slugRecord.link_id ||
      slugRecord.linkId ||
      slugRecord.linkID;

    if (!slug) {
      logger.error('Bill slug record missing slug field', {
        storeId,
        invoiceNo,
        invoiceId,
        record: slugRecord,
      });
      return res.status(500).json({ error: 'Bill slug record is missing slug value' });
    }

    const ebillBase = process.env.E_BILL_URL || process.env.EBILL_BASE_URL || 'ebill.billbox.co.in';
    const ebillBaseWithProtocol = ebillBase.startsWith('http') ? ebillBase : `https://${ebillBase}`;
    const ebillUrl = `${ebillBaseWithProtocol.replace(/\/+$/, '')}/${slug}`;

    const storeConfig = await getStoreConfigById(storeId);
    const whatsappApiUrl =
      storeConfig?.whatsapp_api_url ||
      req.user?.whatsapp_api_url ||
      (storeConfig?.phone_number_id
        ? `https://graph.facebook.com/${GRAPH_API_VERSION}/${storeConfig.phone_number_id}/messages`
        : null);
    const accessToken = storeConfig?.access_token || req.user?.access_token;
    const templateName = storeConfig?.template_name || req.user?.template_name;
    const templateLanguage =
      storeConfig?.template_language || req.user?.template_language || 'en_US';

    if (!accessToken || !whatsappApiUrl || !templateName) {
      logger.warn('Missing WhatsApp configuration for e-bill send', {
        storeId,
        hasAccessToken: Boolean(accessToken),
        hasApiUrl: Boolean(whatsappApiUrl),
        templateName,
      });
      return res.status(400).json({
        error: 'WhatsApp configuration is incomplete for this store',
      });
    }

    try {
      await sendMessage(
        phoneNumber,
        templateName,
        whatsappApiUrl,
        accessToken,
        [ebillUrl],
        templateLanguage
      );
    } catch (error) {
      const status = error.response?.status || 500;
      const errorMessage =
        error.response?.data?.error?.error_user_msg ||
        error.response?.data?.error?.message ||
        error.message ||
        'Failed to send e-bill message';

      logger.error('Failed to send e-bill WhatsApp message', {
        storeId,
        phoneNumber,
        status,
        error: errorMessage,
      });

      return res.status(status).json({
        error: errorMessage,
      });
    }

    res.json({
      success: true,
      invoiceLink: ebillUrl,
      templateName,
    });

    setImmediate(() => {
      const billingSourceId = invoiceId || invoiceNo || slug;
      billingService
        .recordUsage({
          franchiseId: storeConfig?.franchise_id || storeConfig?.franchiseId || null,
          storeId,
          usageType: 'ebill_invoice',
          sourceId: billingSourceId,
          storeConfig,
        })
        .catch((error) => {
          logger.error('Failed to record e-bill usage charge', {
            storeId,
            invoiceId,
            invoiceNo,
            error: error.message,
          });
        });
    });

    if (
      originalCustomerPhone &&
      isZeroPlaceholderPhone(originalCustomerPhone) &&
      extractDigits(phoneNumber).length >= 10
    ) {
      setImmediate(async () => {
        const updated = await updateInvoiceCustomerPhoneRecord(
          storeId,
          invoiceNo,
          invoiceId,
          phoneNumber
        );

        if (!updated) {
          logger.warn('Unable to persist updated customer phone after e-bill send', {
            storeId,
            invoiceNo,
            invoiceId,
          });
        }
      });
    }
  } catch (error) {
    logger.error('Unexpected error sending e-bill', {
      storeId,
      invoiceNo,
      invoiceId,
      error: error.message,
    });
    res.status(500).json({
      error: 'Failed to send e-bill message',
      details: error.message,
    });
  }
});

const sanitizeOptionalString = (value, maxLength = 512) => {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.toString().trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, maxLength);
};

const sanitizeWebsiteList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => sanitizeOptionalString(item, 512))
    .filter(Boolean)
    .slice(0, 2);
};

const buildBusinessProfileInput = (payload) => ({
  address: sanitizeOptionalString(payload?.address, 256),
  description: sanitizeOptionalString(payload?.description, 512),
  vertical: sanitizeOptionalString(payload?.vertical, 64),
  about: sanitizeOptionalString(payload?.about, 139),
  email: sanitizeOptionalString(payload?.email, 320),
  websites: sanitizeWebsiteList(payload?.websites),
  profile_picture_handle: sanitizeOptionalString(payload?.profile_picture_handle, 512),
  legal_business_name: sanitizeOptionalString(payload?.legal_business_name, 180),
  business_type: sanitizeOptionalString(payload?.business_type, 120),
  is_registered:
    typeof payload?.is_registered === 'boolean'
      ? payload.is_registered
      : typeof payload?.is_registered === 'string'
        ? payload.is_registered.toLowerCase() === 'yes'
        : null,
  customer_care_email: sanitizeOptionalString(payload?.customer_care_email, 320),
  customer_care_phone: sanitizeOptionalString(payload?.customer_care_phone, 32),
  grievance_officer_name: sanitizeOptionalString(payload?.grievance_officer_name, 180),
  grievance_officer_phone: sanitizeOptionalString(payload?.grievance_officer_phone, 32),
  grievance_officer_alt_phone: sanitizeOptionalString(payload?.grievance_officer_alt_phone, 32),
  logo_handle: sanitizeOptionalString(payload?.logo_handle, 512),
});

const buildWhatsAppBusinessProfilePayload = (input) => {
  const payload = {
    messaging_product: 'whatsapp',
  };
  const assign = (key) => {
    const value = input[key];
    if (value === null || value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        payload[key] = value;
      }
      return;
    }
    if (typeof value === 'string' && value.trim().length === 0) {
      return;
    }
    payload[key] = value;
  };
  assign('address');
  assign('description');
  assign('vertical');
  assign('about');
  assign('email');
  assign('websites');
  assign('profile_picture_handle');
  return payload;
};

router.get('/business-profile', async (req, res) => {
  try {
    const storeId = req.user?.store_id;
    const phoneNumberId = req.user?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = req.user?.access_token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!storeId) {
      return res.status(400).json({ error: 'Store context is missing.' });
    }

    const storeConfig = await getStoreConfigById(storeId);
    const storedProfile = storeConfig?.business_profile || {};
    const storedCompliance = storeConfig?.business_compliance || {};

    let whatsappProfile = null;
    if (phoneNumberId && accessToken) {
      try {
        const graphVersion = process.env.GRAPH_API_VERSION || 'v18.0';
        const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/whatsapp_business_profile`;
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            fields: 'about,address,description,email,websites,vertical,profile_picture_url',
          },
          timeout: 10000,
        });
        const graphRecord = Array.isArray(response.data?.data)
          ? response.data.data[0] || null
          : response.data?.data || null;
        if (graphRecord) {
          whatsappProfile = {
            about: graphRecord.about || null,
            address: graphRecord.address || null,
            description: graphRecord.description || null,
            email: graphRecord.email || null,
            websites: Array.isArray(graphRecord.websites) ? graphRecord.websites : [],
            vertical: graphRecord.vertical || null,
            profile_picture_url: graphRecord.profile_picture_url || null,
          };
        }
      } catch (error) {
        logger.warn('Failed to fetch WhatsApp business profile from Graph API', {
          storeId,
          error: error.message,
        });
      }
    }

    return res.json({
      success: true,
      profile: {
        address: storedProfile.address || whatsappProfile?.address || null,
        description: storedProfile.description || whatsappProfile?.description || null,
        vertical: storedProfile.vertical || whatsappProfile?.vertical || null,
        about: storedProfile.about || whatsappProfile?.about || null,
        email: storedProfile.email || whatsappProfile?.email || null,
        websites:
          storedProfile.websites && Array.isArray(storedProfile.websites)
            ? storedProfile.websites
            : whatsappProfile?.websites || [],
        profile_picture_handle: storedProfile.profile_picture_handle || null,
        profile_picture_url: whatsappProfile?.profile_picture_url || null,
      },
      compliance: {
        legal_business_name: storedCompliance.legal_business_name || null,
        business_type: storedCompliance.business_type || null,
        is_registered:
          typeof storedCompliance.is_registered === 'boolean'
            ? storedCompliance.is_registered
            : null,
        customer_care_email: storedCompliance.customer_care_email || null,
        customer_care_phone: storedCompliance.customer_care_phone || null,
        grievance_officer_name: storedCompliance.grievance_officer_name || null,
        grievance_officer_phone: storedCompliance.grievance_officer_phone || null,
        grievance_officer_alt_phone: storedCompliance.grievance_officer_alt_phone || null,
        logo_handle: storedCompliance.logo_handle || storedProfile.profile_picture_handle || null,
      },
    });
  } catch (error) {
    logger.error('Failed to load business profile settings', {
      error: error.message,
    });
    return res.status(500).json({ error: 'Failed to load business profile.' });
  }
});

router.post('/business-profile', async (req, res) => {
  try {
    const storeId = req.user?.store_id;
    const phoneNumberId = req.user?.phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = req.user?.access_token || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!storeId) {
      return res.status(400).json({ error: 'Store context is missing.' });
    }
    if (!phoneNumberId || !accessToken) {
      return res.status(400).json({ error: 'WhatsApp credentials are missing.' });
    }

    const input = buildBusinessProfileInput(req.body || {});
    const payload = buildWhatsAppBusinessProfilePayload(input);

    const graphVersion = process.env.GRAPH_API_VERSION || 'v18.0';
    const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/whatsapp_business_profile`;

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    const currentStoreConfig = await getStoreConfigById(storeId);
    const existingBusinessProfile = currentStoreConfig?.business_profile || {};
    const existingBusinessCompliance = currentStoreConfig?.business_compliance || {};
    const now = new Date().toISOString();

    const mergedBusinessProfile = {
      ...existingBusinessProfile,
      address: input.address,
      description: input.description,
      vertical: input.vertical,
      about: input.about,
      email: input.email,
      websites: input.websites,
      profile_picture_handle: input.profile_picture_handle,
      updated_at: now,
    };

    const mergedBusinessCompliance = {
      ...existingBusinessCompliance,
      legal_business_name: input.legal_business_name,
      business_type: input.business_type,
      is_registered: input.is_registered,
      customer_care_email: input.customer_care_email,
      customer_care_phone: input.customer_care_phone,
      grievance_officer_name: input.grievance_officer_name,
      grievance_officer_phone: input.grievance_officer_phone,
      grievance_officer_alt_phone: input.grievance_officer_alt_phone,
      logo_handle: input.logo_handle || input.profile_picture_handle || null,
      updated_at: now,
    };

    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression:
          'SET business_profile = :businessProfile, business_compliance = :businessCompliance, onboarding_updated_at = :updatedAt, updated_at = :updatedAt',
        ExpressionAttributeValues: {
          ':businessProfile': mergedBusinessProfile,
          ':businessCompliance': mergedBusinessCompliance,
          ':updatedAt': now,
        },
      })
    );

    return res.json({
      success: true,
      data: response.data,
      profile: mergedBusinessProfile,
      compliance: mergedBusinessCompliance,
    });
  } catch (error) {
    logger.error('Failed to update WhatsApp business profile', {
      error: error.message,
      details: error.response?.data || null,
    });
    const status = error.response?.status || 500;
    const graphMessage =
      error.response?.data?.error?.error_user_msg ||
      error.response?.data?.error?.message ||
      error.message ||
      'Failed to update business profile.';
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: graphMessage });
  }
});

router.get('/catalog', async (req, res) => {
  try {
    const storeId = req.user?.store_id;
    if (!storeId) {
      return res.status(400).json({ error: 'Store ID is required.' });
    }
    const config = await getStoreConfigById(storeId);
    return res.json({ catalogId: config?.catalog_id || null });
  } catch (error) {
    logger.error('Failed to fetch catalog config', { error: error.message });
    return res.status(500).json({ error: 'Unable to fetch catalog configuration.' });
  }
});

router.post('/catalog', async (req, res) => {
  try {
    const storeId = req.user?.store_id;
    const catalogId = req.body?.catalogId || req.body?.catalog_id || '';
    if (!storeId) {
      return res.status(400).json({ error: 'Store ID is required.' });
    }
    if (!catalogId || !catalogId.toString().trim()) {
      return res.status(400).json({ error: 'Catalog ID is required.' });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: 'SET catalog_id = :catalogId',
        ExpressionAttributeValues: {
          ':catalogId': catalogId.toString().trim(),
        },
      })
    );

    return res.json({ success: true, catalogId: catalogId.toString().trim() });
  } catch (error) {
    logger.error('Failed to update catalog config', { error: error.message });
    return res.status(500).json({ error: 'Unable to update catalog configuration.' });
  }
});

router.delete('/catalog', async (req, res) => {
  try {
    const storeId = req.user?.store_id;
    if (!storeId) {
      return res.status(400).json({ error: 'Store ID is required.' });
    }

    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: 'REMOVE catalog_id',
      })
    );

    return res.json({ success: true });
  } catch (error) {
    logger.error('Failed to clear catalog config', { error: error.message });
    return res.status(500).json({ error: 'Unable to clear catalog configuration.' });
  }
});

router.get('/catalog/products', async (req, res) => {
  try {
    const storeId = req.user?.store_id;
    if (!storeId) {
      return res.status(400).json({ error: 'Store ID is required.' });
    }

    const catalogId = (req.query?.catalogId || req.query?.catalog_id || '').toString().trim();
    const collectionId = (
      req.query?.collectionId ||
      req.query?.collection_id ||
      req.query?.product_set_id ||
      ''
    )
      .toString()
      .trim();
    const config = await getStoreConfigById(storeId);
    const effectiveCatalogId = catalogId || config?.catalog_id || null;
    const accessToken = config?.access_token || req.user?.access_token || null;
    if (!effectiveCatalogId) {
      return res.status(400).json({ error: 'Catalog ID is not configured.' });
    }
    if (!accessToken) {
      return res.status(400).json({ error: 'WhatsApp access token is missing.' });
    }

    const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit || '50', 10)));
    const products = await fetchCatalogProducts({
      catalogId: effectiveCatalogId,
      accessToken,
      graphVersion: process.env.GRAPH_API_VERSION,
      limit,
      productSetId: collectionId || null,
    });

    return res.json({ catalogId: effectiveCatalogId, products });
  } catch (error) {
    const status = error?.response?.status || 500;
    const graphError = error?.response?.data?.error || null;
    const message =
      graphError?.error_user_msg ||
      graphError?.message ||
      error?.message ||
      'Unable to fetch catalog products.';
    logger.error('Failed to fetch catalog products', {
      status,
      error: message,
      graphError,
    });
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: message,
      details: graphError || null,
    });
  }
});

router.get('/catalog/collections', async (req, res) => {
  try {
    const storeId = req.user?.store_id;
    if (!storeId) {
      return res.status(400).json({ error: 'Store ID is required.' });
    }

    const catalogId = (req.query?.catalogId || req.query?.catalog_id || '').toString().trim();
    const config = await getStoreConfigById(storeId);
    const effectiveCatalogId = catalogId || config?.catalog_id || null;
    const accessToken = config?.access_token || req.user?.access_token || null;
    if (!effectiveCatalogId) {
      return res.status(400).json({ error: 'Catalog ID is not configured.' });
    }
    if (!accessToken) {
      return res.status(400).json({ error: 'WhatsApp access token is missing.' });
    }

    const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit || '50', 10)));
    const collections = await fetchCatalogCollections({
      catalogId: effectiveCatalogId,
      accessToken,
      graphVersion: process.env.GRAPH_API_VERSION,
      limit,
    });

    return res.json({ catalogId: effectiveCatalogId, collections });
  } catch (error) {
    const status = error?.response?.status || 500;
    const graphError = error?.response?.data?.error || null;
    const message =
      graphError?.error_user_msg ||
      graphError?.message ||
      error?.message ||
      'Unable to fetch catalog collections.';
    logger.error('Failed to fetch catalog collections', {
      status,
      error: message,
      graphError,
    });
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      error: message,
      details: graphError || null,
    });
  }
});

async function executeTextCampaignSend({
  campaignId,
  storeId,
  name,
  message,
  recipients,
  templateParameters,
  templateName,
  templateLanguage,
  userContext,
  resendSettings,
}) {
  try {
    const whatsappApiUrl = userContext.whatsapp_api_url;
    const accessToken = userContext.access_token;
    if (!whatsappApiUrl || !accessToken) {
      throw new Error('WhatsApp configuration missing for campaign execution');
    }

    const normalizedMessageText = message || `Campaign: ${name}`;
    const metadata = {
      phoneNumberId: userContext.phone_number_id || null,
      wabaId: userContext.waba_id || null,
      displayPhoneNumber: userContext.waba_mobile_number || null,
    };
    const franchiseId = await billingService.getFranchiseIdForStore(storeId);

    const recordSuccess = async (recipient, sentAt, messageId) => {
      await analyticsService.insertCampaignDetail({
        store_id: storeId,
        sent_at: sentAt,
        campaign_name: name,
        template_name: templateName || null,
        template_language: templateLanguage || null,
        template_parameters: templateParameters ?? null,
        message,
        send_mode: 'text',
        header_image_s3_key: null,
        resend_enabled: resendSettings?.enabled ?? null,
        resend_delay_option: resendSettings?.delayOption || null,
        customer_phone: recipient.phone,
        customer_name: recipient.name,
        status: 'sent',
        message_id: messageId,
        last_status_update: sentAt,
        campaign_id: campaignId,
      });

      await persistWhatsAppMessage({
        storeId: userContext.store_id || storeId,
        customerPhone: recipient.phone,
        direction: 'outbound',
        messageType: 'template',
        timestamp: sentAt,
        messageId,
        text: normalizedMessageText,
        status: 'sent',
        customerName: recipient.name,
        metadata,
        campaignName: name,
        campaignId,
        templateName,
      });

      const event = {
        id: messageId || `campaign_${Date.now()}_${recipient.phone}`,
        type: 'campaign',
        text: message,
        timestamp: sentAt,
        recipient: recipient.phone,
        campaignName: name,
        customerName: recipient.name,
        templateName,
        campaignId,
      };
      EventBuffer.addEvent(event);
      updateRecipientProgress(campaignId, {
        phone: recipient.phone,
        name: recipient.name,
        status: 'sent',
        messageId,
        error: null,
      });

      billingService
        .recordUsage({
          franchiseId,
          storeId,
          usageType: 'campaign_message',
          sourceId: messageId || campaignId,
          quantity: 1,
        })
        .catch((error) => {
          logger.error('Failed to record campaign message usage', {
            storeId,
            campaignId,
            error: error.message,
          });
        });
    };

    const recordFailure = async (recipient, sentAt, errorInfo = {}) => {
      try {
        await analyticsService.insertCampaignDetail({
          store_id: storeId,
          sent_at: sentAt,
          campaign_name: name,
          template_name: templateName || null,
          template_language: templateLanguage || null,
          template_parameters: templateParameters ?? null,
          message,
          send_mode: 'text',
          header_image_s3_key: null,
          resend_enabled: resendSettings?.enabled ?? null,
          resend_delay_option: resendSettings?.delayOption || null,
          customer_phone: recipient.phone,
          customer_name: recipient.name,
          status: 'failed',
          message_id: null,
          last_status_update: sentAt,
          campaign_id: campaignId,
          error_reason: errorInfo?.message || null,
          error_code: errorInfo?.code ?? null,
        });
      } catch (dbError) {
        logger.error('Failed to insert campaign detail to DB', {
          phone: recipient.phone,
          error: dbError.message,
        });
      }

      updateRecipientProgress(campaignId, {
        phone: recipient.phone,
        name: recipient.name,
        status: 'failed',
        messageId: null,
        error: errorInfo?.message || null,
      });
    };

    const sendSingleRecipient = async (recipient) => {
      const sendResult = await sendMessage(
        recipient.phone,
        templateName,
        whatsappApiUrl,
        accessToken,
        templateParameters ?? null,
        templateLanguage
      );

      const sentAt = new Date().toISOString();
      const messageId = sendResult.messages?.[0]?.id;
      await recordSuccess(recipient, sentAt, messageId);
      return {
        phone: recipient.phone,
        name: recipient.name,
        success: true,
        messageId,
        status: 'sent',
        sentDate: sentAt,
        error: null,
        errorCode: null,
      };
    };

    const handlePermanentFailure = async (recipient, error) => {
      const sentAt = new Date().toISOString();
      const errorInfo = resolveErrorInfo(error);
      logger.error('Failed to send message to customer', {
        phone: recipient.phone,
        error: errorInfo.message,
        errorCode: errorInfo.code,
      });
      await recordFailure(recipient, sentAt, errorInfo);
      return {
        phone: recipient.phone,
        name: recipient.name,
        success: false,
        status: 'failed',
        error: errorInfo.message,
        errorCode: errorInfo.code,
        sentDate: sentAt,
      };
    };

    const sendRecipientWithRetry = async (recipient) => {
      let attempt = 0;
      updateRecipientProgress(campaignId, {
        phone: recipient.phone,
        name: recipient.name,
        status: 'processing',
      });
      while (attempt <= CAMPAIGN_MAX_RETRIES) {
        try {
          await campaignRateLimiter.acquire();
          return await sendSingleRecipient(recipient);
        } catch (error) {
          const shouldRetry = isRetryableError(error) && attempt < CAMPAIGN_MAX_RETRIES;
          if (!shouldRetry) {
            return handlePermanentFailure(recipient, error);
          }
          logger.warn('Retrying WhatsApp campaign send', {
            phone: recipient.phone,
            attempt: attempt + 1,
            error: resolveErrorInfo(error).message,
          });
          const backoff = Math.min(CAMPAIGN_RETRY_BASE_DELAY_MS * Math.pow(2, attempt), 10000);
          const jitter = Math.floor(Math.random() * 250);
          await delay(backoff + jitter);
          attempt += 1;
        }
      }
      return handlePermanentFailure(recipient, new Error('Failed after retries'));
    };

    const effectiveConcurrency = Math.max(1, Math.min(CAMPAIGN_CONCURRENCY, recipients.length));
    const results = await runWithConcurrency(
      recipients,
      (recipient) => sendRecipientWithRetry(recipient),
      effectiveConcurrency
    );

    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    logger.info('Campaign sent', {
      name,
      storeId,
      totalRecipients: recipients.length,
      successCount,
      failureCount,
      campaignId,
    });

    finalizeCampaignProgress(campaignId);
  } catch (error) {
    failCampaignProgress(campaignId, error.message);
    throw error;
  }
}

async function executeImageCampaignSend({
  campaignId,
  storeId,
  name,
  message,
  recipients,
  templateParameters,
  templateName,
  templateLanguage,
  userContext,
  headerImageS3Key,
  mediaPayload,
  resendSettings,
}) {
  try {
    const whatsappApiUrl = userContext.whatsapp_api_url;
    const accessToken = userContext.access_token;
    const phoneNumberId = userContext.phone_number_id;
    if (!whatsappApiUrl || !accessToken || !phoneNumberId) {
      throw new Error('WhatsApp configuration not available for this store');
    }

    let headerImageId = null;
    let mediaId = null;

    if (headerImageS3Key) {
      headerImageId = await resendService.createPresignedGet(headerImageS3Key);
    }

    if (!headerImageId && mediaPayload) {
      const uploadUrl = `https://graph.facebook.com/${mediaPayload.graphVersion || GRAPH_API_VERSION}/${phoneNumberId}/media`;
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', mediaPayload.buffer, {
        filename: mediaPayload.filename,
        contentType: mediaPayload.mimetype,
      });

      logger.info('Uploading campaign media', {
        storeId,
        templateName,
        size: mediaPayload.size,
        mimetype: mediaPayload.mimetype,
        campaignId,
      });

      const uploadResponse = await axios.post(uploadUrl, formData, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...formData.getHeaders(),
        },
        maxBodyLength: Infinity,
      });
      mediaId = uploadResponse.data?.id || null;
      if (!mediaId) {
        throw new Error('Media upload succeeded but no media ID returned');
      }
      headerImageId = mediaId;
    }

    if (mediaId) {
      try {
        await resendService.updateCampaignMetadata(campaignId, {
          header_media_id: mediaId,
        });
      } catch (error) {
        logger.warn('Failed to persist campaign media id', {
          campaignId,
          storeId,
          error: error.message,
        });
      }
    }

    if (!headerImageId) {
      throw new Error('Image template requires a header image.');
    }

    const normalizedMessageText = message || `Campaign: ${name}`;
    const metadata = {
      phoneNumberId,
      wabaId: userContext.waba_id || null,
      displayPhoneNumber: userContext.waba_mobile_number || null,
    };
    const franchiseId = await billingService.getFranchiseIdForStore(storeId);

    for (const recipient of recipients) {
      try {
        updateRecipientProgress(campaignId, {
          phone: recipient.phone,
          name: recipient.name,
          status: 'processing',
        });

        const result = await sendMessage(
          recipient.phone,
          templateName,
          whatsappApiUrl,
          accessToken,
          templateParameters ?? null,
          templateLanguage,
          { headerImageId }
        );

        const sentAt = new Date().toISOString();
        const messageId = result.messages?.[0]?.id;

        await analyticsService.insertCampaignDetail({
          store_id: storeId,
          sent_at: sentAt,
          campaign_name: name,
          template_name: templateName || null,
          template_language: templateLanguage || null,
          template_parameters: templateParameters ?? null,
          message,
          send_mode: 'image',
          header_image_s3_key: headerImageS3Key || null,
          resend_enabled: resendSettings?.enabled ?? null,
          resend_delay_option: resendSettings?.delayOption || null,
          customer_phone: recipient.phone,
          customer_name: recipient.name,
          status: 'sent',
          message_id: messageId,
          last_status_update: sentAt,
          campaign_id: campaignId,
        });

        await persistWhatsAppMessage({
          storeId: userContext.store_id || storeId,
          customerPhone: recipient.phone,
          direction: 'outbound',
          messageType: 'template',
          timestamp: sentAt,
          messageId,
          text: normalizedMessageText,
          status: 'sent',
          customerName: recipient.name,
          metadata,
          campaignName: name,
          campaignId,
          templateName,
          mediaId: headerImageS3Key || mediaId || null,
        });

        EventBuffer.addEvent({
          id: messageId || `campaign_${Date.now()}_${recipient.phone}`,
          type: 'campaign',
          text: message || templateName,
          timestamp: sentAt,
          recipient: recipient.phone,
          campaignName: name,
          customerName: recipient.name,
          mediaId: headerImageS3Key || mediaId || null,
          templateName,
          campaignId,
        });

        updateRecipientProgress(campaignId, {
          phone: recipient.phone,
          name: recipient.name,
          status: 'sent',
          messageId,
          error: null,
        });

        billingService
          .recordUsage({
            franchiseId,
            storeId,
            usageType: 'campaign_message',
            sourceId: messageId || campaignId,
            quantity: 1,
          })
          .catch((error) => {
            logger.error('Failed to record image campaign usage', {
              storeId,
              campaignId,
              error: error.message,
            });
          });
      } catch (error) {
        const errorInfo = resolveErrorInfo(error);
        logger.error('Failed to send image template campaign message', {
          storeId,
          phone: recipient.phone,
          error: errorInfo.message,
          errorCode: errorInfo.code,
        });

        const sentAt = new Date().toISOString();

        try {
          await analyticsService.insertCampaignDetail({
            store_id: storeId,
            sent_at: sentAt,
            campaign_name: name,
            template_name: templateName || null,
            template_language: templateLanguage || null,
            template_parameters: templateParameters ?? null,
            message,
            send_mode: 'image',
            header_image_s3_key: headerImageS3Key || null,
            resend_enabled: resendSettings?.enabled ?? null,
            resend_delay_option: resendSettings?.delayOption || null,
            customer_phone: recipient.phone,
            customer_name: recipient.name,
            status: 'failed',
            message_id: null,
            last_status_update: sentAt,
            campaign_id: campaignId,
            error_reason: errorInfo.message,
            error_code: errorInfo.code,
          });
        } catch (dbError) {
          logger.error('Failed to insert failed campaign detail to DB', {
            storeId,
            phone: recipient.phone,
            error: dbError.message,
          });
        }

        updateRecipientProgress(campaignId, {
          phone: recipient.phone,
          name: recipient.name,
          status: 'failed',
          messageId: null,
          error: errorInfo.message,
        });
      }
    }

    finalizeCampaignProgress(campaignId);
    logger.info('Image template campaign complete', {
      name,
      storeId,
      campaignId,
    });
  } catch (error) {
    failCampaignProgress(campaignId, error.message);
    throw error;
  }
}

let resendSchedulerRunning = false;

async function processResendQueue() {
  if (resendSchedulerRunning) {
    return;
  }
  resendSchedulerRunning = true;
  try {
    const dueAttempts = await resendService.listDueAttempts();
    for (const attempt of dueAttempts) {
      await executeResendAttempt(attempt);
    }
  } catch (error) {
    logger.error('Resend scheduler failed', { error: error.message });
  } finally {
    resendSchedulerRunning = false;
  }
}

if (RESEND_SCHEDULER_ENABLED) {
  const interval = setInterval(() => {
    processResendQueue().catch((error) => {
      logger.error('Resend scheduler loop failed', { error: error.message });
    });
  }, RESEND_SCHEDULER_INTERVAL_MS);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }
}

module.exports = router;
