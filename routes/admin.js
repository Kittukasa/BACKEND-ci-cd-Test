const express = require('express');
const jwt = require('jsonwebtoken');
const analyticsService = require('../services/analyticsService');
const { getAdminProfile, markAdminLogin } = require('../services/adminAuthService');
const { logger } = require('../config/logger');
const { docClient } = require('../config/dynamodb');
const { GetCommand, UpdateCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const router = express.Router();
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;
const ADMIN_TOKEN_TTL = process.env.ADMIN_TOKEN_TTL || '4h';
const STORE_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;
const FRANCHISES_TABLE = process.env.FRANCHISES_TABLE;
const WALLET_TABLE = process.env.FRANCHISE_WALLET_TABLE || null;
const WALLET_EVENTS_TABLE = process.env.WALLET_EVENTS_TABLE || null;
const WALLET_EVENTS_SORT_KEY = process.env.WALLET_EVENTS_SORT_KEY || 'timestamp#event_id';
const DEFAULT_WALLET_STORE_ID = 'ALL';
const DEFAULT_WALLET_CURRENCY = 'INR';
const WALLET_FIELDS = [
  'balance',
  'currency',
  'min_balance',
  'low_balance_threshold',
  'pricing_ebill_invoice',
  'pricing_smart_ebill',
  'pricing_campaign_message'
];
const LEAD_SIGNUPS_TABLE = process.env.LEAD_SIGNUPS_TABLE || process.env.LEAD_SIGNUPS;

const ADMIN_STORE_FIELDS = [
  'smartE-bill',
  'trial_period',
  'trial_started',
  'template_name',
  'template_language',
  'brand_name',
  'campaign_messages_count'
];

const ADMIN_STORE_FIELD_ALIASES = {
  smart_ebill: 'smartE-bill',
  trail_started: 'trial_started'
};

const ADMIN_STORE_DISPLAY_FIELDS = [
  'store_id',
  'email',
  'franchise_id',
  'mobile_number',
  'vendor_name',
  'store_name',
  'updated_at',
  'smart_address_text',
  'smart_bottom_banner',
  'smart_footer_text',
  'smart_header_images',
  'smart_header_text',
  'verified_name',
  'waba_id',
  'waba_mobile_number',
  'whatsapp_api_url',
  'onboarding_updated_at',
  'phone_number_id',
  'smartE-bill',
  'trial_period',
  'trial_started',
  'template_name',
  'template_language',
  'brand_name',
  'campaign_messages_count'
];

const ADMIN_FRANCHISE_FIELDS = [
  'utility_charges',
  'marketing_charges',
  'balance_credits',
  'last_recharge_amount',
  'last_recharge_date',
  'recharge_history',
  'usage_history',
  'campaign_free_messages',
  'minimum_charge',
  'reserved_credits',
  'recharge_alert_credits',
  'wallet_enabled',
  'trial_start',
  'trial_end',
  'trial_start_date',
  'trial_end_date',
  'plan_start_date',
  'plan_end_date',
  'global_smart_ebill_enabled'
];

const extractRangeInputs = (query = {}) => {
  const rangeParam = typeof query.range === 'string' ? query.range : 'today';
  const customStart = typeof query.start === 'string' ? query.start : null;
  const customEnd = typeof query.end === 'string' ? query.end : null;
  return { rangeParam, customStart, customEnd };
};

const deriveHealthStatus = (metrics = {}) => {
  if ((metrics.revenue || 0) > 0 && (metrics.invoices || 0) > 0) {
    return 'healthy';
  }
  if ((metrics.invoices || 0) > 0) {
    return 'watch';
  }
  return 'risk';
};

const normalizeAdminFieldKey = (key) => ADMIN_STORE_FIELD_ALIASES[key] || key;

const resolveStoreEmail = (item = {}) =>
  item.contact_email || item.email || null;

const resolveStoreMobile = (item = {}) =>
  item.mobile_number || item.contact_phone || item.vendor_phone || null;

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildWalletDefaults = () => ({
  balance: 0,
  currency: DEFAULT_WALLET_CURRENCY,
  min_balance: 0,
  low_balance_threshold: 0,
  pricing_ebill_invoice: 0,
  pricing_smart_ebill: 0,
  pricing_campaign_message: 0
});

const buildWalletPayload = (item = {}, franchiseId, storeId) => {
  const defaults = buildWalletDefaults();
  const payload = {
    franchise_id: franchiseId,
    store_id: storeId,
    ...defaults
  };
  WALLET_FIELDS.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(item, field)) {
      return;
    }
    if (field === 'currency') {
      const value = typeof item[field] === 'string' ? item[field].trim() : '';
      payload[field] = value || DEFAULT_WALLET_CURRENCY;
      return;
    }
    payload[field] = toNumber(item[field]);
  });
  payload.updated_at = item.updated_at || null;
  return payload;
};

const scanAll = async (params) => {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await docClient.send(
      new ScanCommand({
        ...params,
        ExclusiveStartKey: lastEvaluatedKey
      })
    );
    if (result.Items) {
      items.push(...result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
};

const buildAdminStorePayload = (item = {}, storeId) => {
  const payload = {};
  ADMIN_STORE_DISPLAY_FIELDS.forEach((field) => {
    if (field === 'store_id') {
      payload[field] = storeId;
      return;
    }
    if (field === 'email') {
      payload[field] = resolveStoreEmail(item);
      return;
    }
    if (field === 'mobile_number') {
      payload[field] = resolveStoreMobile(item);
      return;
    }
    if (field === 'smartE-bill') {
      payload[field] =
        Object.prototype.hasOwnProperty.call(item, field) ? item[field] : item.smart_ebill ?? null;
      return;
    }
    payload[field] = Object.prototype.hasOwnProperty.call(item, field) ? item[field] : null;
  });
  if (!Array.isArray(payload.smart_header_images)) {
    payload.smart_header_images = [];
  }
  return payload;
};

const buildFranchiseUpdateExpression = (payload = {}) => {
  const names = {};
  const values = {};
  const updates = [];

  ADMIN_FRANCHISE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      const nameKey = `#${field}`;
      const valueKey = `:${field}`;
      names[nameKey] = field;
      values[valueKey] = payload[field];
      updates.push(`${nameKey} = ${valueKey}`);
    }
  });

  if (updates.length === 0) {
    return null;
  }

  return {
    UpdateExpression: `SET ${updates.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values
  };
};

const updateFranchiseStoresSmartEbill = async (franchiseId, enabled) => {
  if (!STORE_CONFIG_TABLE || !franchiseId) {
    return 0;
  }

  const stores = await scanAll({
    TableName: STORE_CONFIG_TABLE,
    FilterExpression: 'franchise_id = :franchiseId',
    ExpressionAttributeValues: {
      ':franchiseId': franchiseId
    },
    ProjectionExpression: 'store_id'
  });

  const storeIds = stores
    .map(item => item?.store_id)
    .filter(value => typeof value === 'string' && value.trim().length > 0);

  if (!storeIds.length) {
    return 0;
  }

  const updatedAt = new Date().toISOString();
  const nextValue = enabled ? 'yes' : 'no';
  await Promise.all(
    storeIds.map(storeId =>
      docClient.send(
        new UpdateCommand({
          TableName: STORE_CONFIG_TABLE,
          Key: { store_id: storeId },
          UpdateExpression: 'SET #smart_dash = :enabled, #updated_at = :updated',
          ExpressionAttributeNames: {
            '#smart_dash': 'smartE-bill',
            '#updated_at': 'updated_at'
          },
          ExpressionAttributeValues: {
            ':enabled': nextValue,
            ':updated': updatedAt
          }
        })
      )
    )
  );

  return storeIds.length;
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
        ':fid': franchiseId
      },
      ScanIndexForward: false,
      ExclusiveStartKey: lastEvaluatedKey
    };
    if (start && end) {
      params.KeyConditionExpression = 'franchise_id = :fid AND #event_key BETWEEN :start AND :end';
      params.ExpressionAttributeNames = {
        '#event_key': WALLET_EVENTS_SORT_KEY
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

router.post('/login', async (req, res) => {
  const adminName = typeof req.body?.adminName === 'string' ? req.body.adminName.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!adminName || !password) {
    return res.status(400).json({ error: 'Admin name and password are required' });
  }

  try {
    const profile = await getAdminProfile(adminName);
    if (!profile) {
      logger.warn('Admin login failed: unknown admin', { adminName });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const storedPassword = profile.Password || profile.password;
    if (storedPassword !== password) {
      logger.warn('Admin login failed: invalid password', { adminName });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const payload = { type: 'admin', adminName };
    const token = jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: ADMIN_TOKEN_TTL });

    await markAdminLogin(adminName);

    logger.info('Admin login successful', { adminName });
    return res.json({
      token,
      admin: {
        adminName,
        displayName: profile.display_name || profile.DisplayName || profile.Admin_name || adminName,
        lastLoginAt: profile.last_login_at || null,
      },
    });
  } catch (error) {
    logger.error('Admin login failed', { adminName, error: error.message });
    return res.status(500).json({ error: 'Unable to authenticate admin' });
  }
});

router.get('/stores-analytics', async (req, res) => {
  const { rangeParam, customStart, customEnd } = extractRangeInputs(req.query);

  try {
    const storeMetadata = await analyticsService.getStoreMetadata();
    const storeIds = Object.keys(storeMetadata || {});
    const [
      { dateRange, metricsByStore, invoices, allInvoices },
      campaignStats
    ] = await Promise.all([
      analyticsService.computeInvoiceMetricsOptimized(rangeParam, customStart, customEnd, storeIds),
      analyticsService.computeCampaignStatsByStore(rangeParam, customStart, customEnd)
    ]);
    const { campaignCounts, messageCounts } = campaignStats || {
      campaignCounts: {},
      messageCounts: {}
    };

    const sourceInvoices = Array.isArray(allInvoices) && allInvoices.length ? allInvoices : invoices;
    const lastActiveMap = {};
    sourceInvoices.forEach((invoice) => {
      if (!invoice) {
        return;
      }
      const storeId = invoice.store_id;
      if (!storeId || storeId === 'UNKNOWN') {
        return;
      }
      const timestampDate = analyticsService.getInvoiceTimestampIst(invoice);
      if (!timestampDate) {
        return;
      }
      const value = timestampDate.getTime();
      if (!lastActiveMap[storeId] || value > lastActiveMap[storeId]) {
        lastActiveMap[storeId] = value;
      }
    });

    const storeIdSet = new Set();
    const distinctStoresAllTime = new Set();
    const storeAllTimeCounts = {};
    const distinctStoresFiltered = new Set();

    const trackStoreId = (storeId, trackerSet, countsMap) => {
      if (!storeId || storeId === 'UNKNOWN') {
        return;
      }
      storeIdSet.add(storeId);
      trackerSet?.add(storeId);
      if (countsMap) {
        countsMap[storeId] = (countsMap[storeId] || 0) + 1;
      }
    };

    sourceInvoices.forEach((invoice) => {
      trackStoreId(invoice?.store_id, distinctStoresAllTime, storeAllTimeCounts);
    });

    invoices.forEach((invoice) => {
      trackStoreId(invoice?.store_id, distinctStoresFiltered);
    });

    Object.keys(metricsByStore || {}).forEach((storeId) => trackStoreId(storeId));
    Object.keys(storeMetadata || {}).forEach((storeId) => trackStoreId(storeId));
    Object.keys(campaignCounts || {}).forEach((storeId) => trackStoreId(storeId));

    const stores = Array.from(storeIdSet).map((storeId) => {
      const metrics = metricsByStore[storeId] || {};
      const meta = (storeMetadata || {})[storeId] || {};
      const totalCustomers = (metrics.eBillCustomers || 0) + (metrics.anonymousCustomers || 0);
      const vendorStyleInvoiceCount = storeAllTimeCounts[storeId] || 0;

      return {
        storeId,
        name: meta.store_name || `Store ${storeId}`,
        city: meta.city || null,
        franchiseId: meta.franchise_id || null,
        franchiseName: meta.franchise_name || meta.brand_name || null,
        trialPeriod: meta.trial_period ?? null,
        trialStarted: meta.trial_started ?? null,
        revenue: metrics.revenue || 0,
        invoices: metrics.invoices || 0,
        totalCustomers,
        anonymousCustomers: metrics.anonymousCustomers || 0,
        ebillInvoices: metrics.ebillInvoices || 0,
        eBillCustomers: metrics.eBillCustomers || 0,
        campaignsSent: campaignCounts[storeId] || 0,
        messagesSent: messageCounts[storeId] || 0,
        lastActiveAt: lastActiveMap[storeId] ? new Date(lastActiveMap[storeId]).toISOString() : null,
        healthStatus: deriveHealthStatus(metrics),
        debug: {
          vendorAllTimeInvoices: vendorStyleInvoiceCount,
          adminFilteredInvoices: metrics.invoices || 0,
        },
      };
    });

    stores.sort((a, b) => (b.revenue || 0) - (a.revenue || 0));

    const storeMetricSummary = stores.map((store) => ({
      storeId: store.storeId,
      vendorAllTimeInvoices: store.debug?.vendorAllTimeInvoices || 0,
      adminFilteredInvoices: store.debug?.adminFilteredInvoices || 0,
      lastActiveAt: store.lastActiveAt,
      revenue: store.revenue,
    }));

    let todayTimestampSamples;
    if (dateRange?.type === 'today') {
      const startBoundary = dateRange?.start ? dateRange.start.getTime() : null;
      const endBoundary = dateRange?.end ? dateRange.end.getTime() : null;
      todayTimestampSamples = invoices.slice(0, 10).map((invoice) => {
        const parsedDate = analyticsService.getInvoiceTimestampIst(invoice);
        const parsedIso = parsedDate ? parsedDate.toISOString() : null;
        const included =
          parsedDate &&
          (startBoundary === null || parsedDate.getTime() >= startBoundary) &&
          (endBoundary === null || parsedDate.getTime() <= endBoundary);
        return {
          storeId: invoice.store_id,
          processed_timestamp_ist: invoice.processed_timestamp_ist,
          processed_iso_ist: invoice.processed_iso_ist || null,
          parsedIso,
          included,
        };
      });
    }

    logger.info('Admin stores analytics fetched', {
      requestedRange: rangeParam,
      computedRange: {
        startIso: dateRange?.start ? new Date(dateRange.start).toISOString() : null,
        endIso: dateRange?.end ? new Date(dateRange.end).toISOString() : null,
        label: dateRange?.label,
      },
      totalInvoicesAllTime: sourceInvoices.length,
      totalInvoicesFiltered: invoices.length,
      distinctStoreIdsAllTime: distinctStoresAllTime.size,
      distinctStoreIdsFiltered: distinctStoresFiltered.size,
      distinctStoresReturned: stores.length,
      storeMetricSummary,
      todayTimestampSamples,
    });

    res.json({
      range: dateRange.type,
      rangeLabel: dateRange.label,
      stores,
      debug: {
        vendorAllTimeStoreInvoiceCounts: storeAllTimeCounts,
        adminFilteredStoreCounts: distinctStoresFiltered.size,
        distinctStoresAllTime: distinctStoresAllTime.size,
      },
    });
  } catch (error) {
    logger.error('Failed to load admin store analytics', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Unable to load stores analytics' });
  }
});

router.get('/franchises/:franchiseId', async (req, res) => {
  const franchiseId = req.params.franchiseId;
  if (!franchiseId) {
    return res.status(400).json({ error: 'franchiseId is required' });
  }
  if (!FRANCHISES_TABLE) {
    return res.status(500).json({ error: 'Franchise table is not configured' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId }
      })
    );
    const item = result.Item || { franchise_id: franchiseId };
    return res.json({ franchise: item });
  } catch (error) {
    logger.error('Failed to fetch franchise details', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load franchise details' });
  }
});

router.patch('/franchises/:franchiseId', async (req, res) => {
  const franchiseId = req.params.franchiseId;
  if (!franchiseId) {
    return res.status(400).json({ error: 'franchiseId is required' });
  }
  if (!FRANCHISES_TABLE) {
    return res.status(500).json({ error: 'Franchise table is not configured' });
  }

  const updatePayload = {};
  ADMIN_FRANCHISE_FIELDS.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      updatePayload[field] = req.body[field];
    }
  });

  const expression = buildFranchiseUpdateExpression(updatePayload);
  if (!expression) {
    return res.status(400).json({ error: 'No valid fields provided for update' });
  }

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: FRANCHISES_TABLE,
        Key: { franchise_id: franchiseId },
        ...expression,
        ReturnValues: 'ALL_NEW'
      })
    );

    let updatedStoreCount = 0;
    if (Object.prototype.hasOwnProperty.call(updatePayload, 'global_smart_ebill_enabled')) {
      updatedStoreCount = await updateFranchiseStoresSmartEbill(
        franchiseId,
        Boolean(updatePayload.global_smart_ebill_enabled)
      );
    }

    return res.json({
      franchise: result.Attributes || { franchise_id: franchiseId },
      updated_store_count: updatedStoreCount
    });
  } catch (error) {
    logger.error('Failed to update franchise details', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to update franchise details' });
  }
});

router.get('/stores/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  if (!storeId) {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store config table is not configured' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId }
      })
    );

    if (!result.Item) {
      return res.json({
        success: true,
        store: buildAdminStorePayload({}, storeId)
      });
    }

    return res.json({
      success: true,
      store: buildAdminStorePayload(result.Item, storeId)
    });
  } catch (error) {
    logger.error('Failed to load admin store details', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to load store details' });
  }
});

router.get('/store', async (req, res) => {
  const storeId = req.query?.storeId || req.query?.store_id || null;
  if (!storeId) {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store config table is not configured' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: String(storeId) }
      })
    );

    if (!result.Item) {
      return res.json({
        success: true,
        store: buildAdminStorePayload({}, String(storeId))
      });
    }

    return res.json({
      success: true,
      store: buildAdminStorePayload(result.Item, String(storeId))
    });
  } catch (error) {
    logger.error('Failed to load admin store details', {
      storeId: String(storeId),
      error: error.message
    });
    return res.status(500).json({ error: 'Unable to load store details' });
  }
});

router.patch('/stores/:storeId', async (req, res) => {
  const storeId = req.params.storeId;
  if (!storeId) {
    return res.status(400).json({ error: 'storeId is required' });
  }
  if (!STORE_CONFIG_TABLE) {
    return res.status(500).json({ error: 'Store config table is not configured' });
  }

  const updates = {};
  Object.entries(req.body || {}).forEach(([rawKey, value]) => {
    const key = normalizeAdminFieldKey(rawKey);
    if (!ADMIN_STORE_FIELDS.includes(key)) {
      return;
    }
    if (key === 'trial_period') {
      const parsed = Number(value);
      updates[key] = Number.isFinite(parsed) ? parsed : null;
      return;
    }
    if (typeof value === 'string') {
      updates[key] = value.trim();
      return;
    }
    updates[key] = value ?? null;
  });

  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) {
    return res.status(400).json({ error: 'No editable fields provided.' });
  }

  const expressionParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':updated': new Date().toISOString()
  };

  updateKeys.forEach((key, index) => {
    const nameKey = `#field${index}`;
    const valueKey = `:value${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = updates[key];
    expressionParts.push(`${nameKey} = ${valueKey}`);
  });

  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionParts.push('#updated_at = :updated');

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId }
      })
    );

    const updated = await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    const merged = updated.Attributes || result.Item || {};
    return res.json({
      success: true,
      store: buildAdminStorePayload(merged, storeId)
    });
  } catch (error) {
    logger.error('Failed to update admin store details', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to update store details' });
  }
});

router.get('/wallets', async (req, res) => {
  const franchiseId = typeof req.query?.franchiseId === 'string' ? req.query.franchiseId.trim() : '';
  const storeId = typeof req.query?.storeId === 'string' && req.query.storeId.trim()
    ? req.query.storeId.trim()
    : DEFAULT_WALLET_STORE_ID;

  if (!franchiseId) {
    return res.status(400).json({ error: 'franchiseId is required' });
  }
  if (!WALLET_TABLE) {
    return res.status(500).json({ error: 'Wallet table is not configured' });
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: WALLET_TABLE,
        Key: {
          franchise_id: franchiseId,
          store_id: storeId
        }
      })
    );

    const wallet = buildWalletPayload(result.Item || {}, franchiseId, storeId);
    return res.json({ success: true, wallet });
  } catch (error) {
    logger.error('Failed to load wallet config', { franchiseId, storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet config' });
  }
});

router.get('/wallets/summary', async (req, res) => {
  if (!WALLET_TABLE) {
    return res.status(500).json({ error: 'Wallet table is not configured' });
  }

  try {
    const storeMetadata = await analyticsService.getStoreMetadata();
    const franchiseNameMap = new Map();
    Object.values(storeMetadata || {}).forEach((meta) => {
      if (!meta?.franchise_id) {
        return;
      }
      const id = String(meta.franchise_id);
      const name = meta.franchise_name || meta.brand_name || null;
      if (!franchiseNameMap.has(id) && name) {
        franchiseNameMap.set(id, name);
      }
    });

    const walletItems = await scanAll({
      TableName: WALLET_TABLE,
      FilterExpression: 'store_id = :storeScope',
      ExpressionAttributeValues: {
        ':storeScope': DEFAULT_WALLET_STORE_ID
      }
    });

    const walletMap = new Map();
    walletItems.forEach((item) => {
      if (!item?.franchise_id) {
        return;
      }
      const franchiseId = String(item.franchise_id);
      walletMap.set(franchiseId, buildWalletPayload(item, franchiseId, DEFAULT_WALLET_STORE_ID));
    });

    const franchiseIds = new Set([
      ...Array.from(franchiseNameMap.keys()),
      ...Array.from(walletMap.keys())
    ]);

    const summaries = Array.from(franchiseIds).map((franchiseId) => {
      const wallet = walletMap.get(franchiseId) || buildWalletPayload({}, franchiseId, DEFAULT_WALLET_STORE_ID);
      return {
        franchise_id: franchiseId,
        franchise_name: franchiseNameMap.get(franchiseId) || null,
        balance: wallet.balance,
        currency: wallet.currency,
        low_balance_threshold: wallet.low_balance_threshold,
        pricing_ebill_invoice: wallet.pricing_ebill_invoice,
        pricing_smart_ebill: wallet.pricing_smart_ebill,
        pricing_campaign_message: wallet.pricing_campaign_message
      };
    });

    summaries.sort((a, b) => {
      const nameA = (a.franchise_name || a.franchise_id || '').toLowerCase();
      const nameB = (b.franchise_name || b.franchise_id || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return res.json({ success: true, franchises: summaries });
  } catch (error) {
    logger.error('Failed to load wallet summary', { error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet summary' });
  }
});

router.patch('/wallets', async (req, res) => {
  const franchiseId = typeof req.body?.franchiseId === 'string' ? req.body.franchiseId.trim() : '';
  const storeId = typeof req.body?.storeId === 'string' && req.body.storeId.trim()
    ? req.body.storeId.trim()
    : DEFAULT_WALLET_STORE_ID;

  if (!franchiseId) {
    return res.status(400).json({ error: 'franchiseId is required' });
  }
  if (!WALLET_TABLE) {
    return res.status(500).json({ error: 'Wallet table is not configured' });
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'currency')) {
    const value = typeof req.body.currency === 'string' ? req.body.currency.trim() : '';
    updates.currency = value || DEFAULT_WALLET_CURRENCY;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'balance')) {
    updates.balance = toNumber(req.body.balance);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'min_balance')) {
    updates.min_balance = toNumber(req.body.min_balance);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'low_balance_threshold')) {
    updates.low_balance_threshold = toNumber(req.body.low_balance_threshold);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pricing_ebill_invoice')) {
    updates.pricing_ebill_invoice = toNumber(req.body.pricing_ebill_invoice);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pricing_smart_ebill')) {
    updates.pricing_smart_ebill = toNumber(req.body.pricing_smart_ebill);
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'pricing_campaign_message')) {
    updates.pricing_campaign_message = toNumber(req.body.pricing_campaign_message);
  }

  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) {
    return res.status(400).json({ error: 'No wallet fields provided.' });
  }

  const expressionParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':updated': new Date().toISOString()
  };

  updateKeys.forEach((key, index) => {
    const nameKey = `#field${index}`;
    const valueKey = `:value${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = updates[key];
    expressionParts.push(`${nameKey} = ${valueKey}`);
  });

  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionParts.push('#updated_at = :updated');

  try {
    const result = await docClient.send(
      new UpdateCommand({
        TableName: WALLET_TABLE,
        Key: {
          franchise_id: franchiseId,
          store_id: storeId
        },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );

    const wallet = buildWalletPayload(result.Attributes || {}, franchiseId, storeId);
    return res.json({ success: true, wallet });
  } catch (error) {
    logger.error('Failed to update wallet config', { franchiseId, storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to update wallet config' });
  }
});

router.get('/wallet-events', async (req, res) => {
  const franchiseId = typeof req.query?.franchiseId === 'string' ? req.query.franchiseId.trim() : '';
  const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50', 10)));

  if (!franchiseId) {
    return res.status(400).json({ error: 'franchiseId is required' });
  }
  if (!WALLET_EVENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet events table is not configured' });
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: WALLET_EVENTS_TABLE,
        KeyConditionExpression: 'franchise_id = :fid',
        ExpressionAttributeValues: {
          ':fid': franchiseId
        },
        ScanIndexForward: false,
        Limit: limit
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
      threshold: item.threshold ?? null
    }));

    return res.json({ success: true, events });
  } catch (error) {
    logger.error('Failed to load wallet events', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet events' });
  }
});

router.get('/wallet-events/summary', async (req, res) => {
  const franchiseId = typeof req.query?.franchiseId === 'string' ? req.query.franchiseId.trim() : '';
  const range = typeof req.query?.range === 'string' ? req.query.range.trim() : 'this_month';

  if (!franchiseId) {
    return res.status(400).json({ error: 'franchiseId is required' });
  }
  if (!WALLET_EVENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet events table is not configured' });
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
      campaignSpend
    });
  } catch (error) {
    logger.error('Failed to load wallet event summary', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet event summary' });
  }
});

router.get('/wallet-events/by-store', async (req, res) => {
  const franchiseId = typeof req.query?.franchiseId === 'string' ? req.query.franchiseId.trim() : '';
  const range = typeof req.query?.range === 'string' ? req.query.range.trim() : 'this_month';

  if (!franchiseId) {
    return res.status(400).json({ error: 'franchiseId is required' });
  }
  if (!WALLET_EVENTS_TABLE) {
    return res.status(500).json({ error: 'Wallet events table is not configured' });
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
          totalSpend: 0
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
      stores: Array.from(storeMap.values())
    });
  } catch (error) {
    logger.error('Failed to load wallet usage by store', { franchiseId, error: error.message });
    return res.status(500).json({ error: 'Unable to load wallet usage by store' });
  }
});

router.get('/leads', async (req, res) => {
  if (!LEAD_SIGNUPS_TABLE) {
    return res.status(500).json({ error: 'Lead signup table is not configured' });
  }
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: LEAD_SIGNUPS_TABLE
      })
    );
    const items = Array.isArray(result.Items) ? result.Items : [];
    items.sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bTime - aTime;
    });
    return res.json({
      success: true,
      leads: items
    });
  } catch (error) {
    logger.error('Failed to load leads', { error: error.message });
    return res.status(500).json({ error: 'Unable to load leads' });
  }
});

router.patch('/leads/:leadId', async (req, res) => {
  const leadId = req.params.leadId;
  const createdAt = req.body?.created_at;
  if (!leadId) {
    return res.status(400).json({ error: 'leadId is required' });
  }
  if (!createdAt) {
    return res.status(400).json({ error: 'created_at is required' });
  }
  if (!LEAD_SIGNUPS_TABLE) {
    return res.status(500).json({ error: 'Lead signup table is not configured' });
  }

  const allowedFields = new Set(['status', 'notes', 'assigned_to']);
  const updates = {};
  Object.entries(req.body || {}).forEach(([key, value]) => {
    if (!allowedFields.has(key)) {
      return;
    }
    if (typeof value === 'string') {
      updates[key] = value.trim();
      return;
    }
    updates[key] = value ?? null;
  });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No editable fields provided.' });
  }

  const expressionParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':updated': new Date().toISOString()
  };

  Object.keys(updates).forEach((key, index) => {
    const nameKey = `#field${index}`;
    const valueKey = `:value${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = updates[key];
    expressionParts.push(`${nameKey} = ${valueKey}`);
  });
  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionParts.push('#updated_at = :updated');

  try {
    const updated = await docClient.send(
      new UpdateCommand({
        TableName: LEAD_SIGNUPS_TABLE,
        Key: {
          lead_id: leadId,
          created_at: createdAt
        },
        UpdateExpression: `SET ${expressionParts.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW'
      })
    );
    return res.json({
      success: true,
      lead: updated.Attributes || null
    });
  } catch (error) {
    logger.error('Failed to update lead', { leadId, error: error.message });
    return res.status(500).json({ error: 'Unable to update lead' });
  }
});

module.exports = router;
