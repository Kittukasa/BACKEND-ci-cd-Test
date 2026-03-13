const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const { QueryCommand, ScanCommand, UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../config/dynamodb');
const { logger } = require('../config/logger');

dayjs.extend(customParseFormat);

const STORE_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;
const INVOICES_TABLE = process.env.DYNAMODB_TABLE;
const INVOICES_STORE_ID_INDEX =
  process.env.INVOICES_STORE_ID_INDEX || process.env.DYNAMODB_STORE_ID_INDEX || null;
const CAMPAIGN_TABLE_NAME = process.env.CAMPAIGN_TABLE_NAME;

const buildFranchiseCandidateIds = (ids = []) =>
  Array.from(
    new Set(
      ids
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .flatMap((value) => [value, value.toLowerCase()])
    )
  );

const normalizePhoneDigits = (value) => (typeof value === 'string' ? value.replace(/\D/g, '') : '');
const ANONYMOUS_PHONE = '0000000000';
const ANONYMOUS_KEY_PREFIX = 'anonymous:';
const isAnonymousPhone = (digits) => digits === ANONYMOUS_PHONE;
const DAILY_END_REPORT_CUSTOMER_NAME = '1234';

const buildAnonymousCustomerKey = (item) => {
  const identifier =
    item.invoice_id ??
    item.invoiceId ??
    item.invoice_no ??
    item.invoiceNo ??
    item.processed_timestamp_ist ??
    item.invoice_date ??
    item.invoice_timestamp ??
    item.created_at ??
    Math.random().toString(36).slice(2);
  return `${ANONYMOUS_KEY_PREFIX}${identifier}`;
};

const getInvoiceCustomerKey = (item) => {
  const phone = typeof item.customer_phone === 'string' ? item.customer_phone.trim() : '';
  if (!phone) {
    return null;
  }
  const digits = normalizePhoneDigits(phone);
  if (!digits) {
    return null;
  }
  if (isAnonymousPhone(digits)) {
    return buildAnonymousCustomerKey(item);
  }
  return digits;
};

const isDailyEndReportInvoice = (invoice) => {
  if (!invoice) {
    return false;
  }
  const rawName = invoice.customer_name ?? invoice.customerName ?? null;
  if (rawName === undefined || rawName === null) {
    return false;
  }
  return rawName.toString().trim() === DAILY_END_REPORT_CUSTOMER_NAME;
};

const buildInvoiceFingerprint = (invoice) => {
  if (!invoice) {
    return null;
  }
  const invoiceId = invoice.invoice_id ?? invoice.invoiceId ?? invoice.invoiceID ?? null;
  if (invoiceId) {
    return `id:${invoiceId}`;
  }
  const invoiceNo = invoice.invoice_no ?? invoice.invoiceNo ?? null;
  if (invoiceNo) {
    return `no:${invoiceNo}`;
  }
  const timestamp =
    invoice.processed_timestamp_ist ??
    invoice.processedTimestampIst ??
    invoice.invoice_date ??
    invoice.invoiceDate ??
    '';
  const phone = normalizePhoneDigits(invoice.customer_phone ?? invoice.customerPhone) || 'unknown';
  const amount = Number(invoice.total_amount ?? invoice.totalAmount ?? 0).toFixed(2);
  return `calc:${phone}|${timestamp}|${amount}`;
};

const getDailyEndInvoiceSet = async (storeId) => {
  if (!STORE_CONFIG_TABLE || !storeId) {
    return new Set();
  }
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId.toString() },
        ProjectionExpression: 'daily_end_invoices',
      })
    );
    const values = Array.isArray(result?.Item?.daily_end_invoices)
      ? result.Item.daily_end_invoices
      : [];
    return new Set(
      values
        .filter((value) => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())
    );
  } catch (error) {
    logger.error('Failed to load daily end report invoices', { storeId, error: error.message });
    return new Set();
  }
};

const aggregateInvoices = (stats, dailyEndSet = null) => {
  let totalRevenue = 0;
  let totalInvoices = 0;
  let anonymousCustomers = 0;
  const customerSet = new Set();
  stats.forEach((item) => {
    const fingerprint = buildInvoiceFingerprint(item);
    if (
      isDailyEndReportInvoice(item) ||
      (dailyEndSet && fingerprint && dailyEndSet.has(fingerprint))
    ) {
      return;
    }
    totalInvoices += 1;
    const amount = Number(item.total_amount ?? item.totalAmount ?? 0);
    if (Number.isFinite(amount)) {
      totalRevenue += amount;
    }
    const customerKey = getInvoiceCustomerKey(item);
    if (customerKey) {
      if (customerKey.startsWith(ANONYMOUS_KEY_PREFIX)) {
        anonymousCustomers += 1;
      } else {
        customerSet.add(customerKey);
      }
    }
  });
  return { totalRevenue, totalInvoices, customers: customerSet, anonymousCustomers };
};

const getStoreInvoiceStats = async (storeId) => {
  if (!INVOICES_TABLE || !storeId) {
    return { totalRevenue: 0, totalInvoices: 0, totalCustomers: 0 };
  }
  const normalizedStoreId = storeId.toString().trim();
  if (!normalizedStoreId) {
    return { totalRevenue: 0, totalInvoices: 0, totalCustomers: 0 };
  }

  const dailyEndSet = await getDailyEndInvoiceSet(normalizedStoreId);

  const aggregateFromPagedCommand = async (commandBuilder, CommandCtor, logLabel) => {
    let totalRevenue = 0;
    let totalInvoices = 0;
    const customerSet = new Set();
    let anonymousCount = 0;
    let lastEvaluatedKey = undefined;
    do {
      const params = commandBuilder(lastEvaluatedKey);
      try {
        const result = await docClient.send(new CommandCtor(params));
        if (result.Items && result.Items.length > 0) {
          const aggregates = aggregateInvoices(result.Items, dailyEndSet);
          totalRevenue += aggregates.totalRevenue;
          totalInvoices += aggregates.totalInvoices;
          aggregates.customers.forEach((value) => customerSet.add(value));
          anonymousCount += aggregates.anonymousCustomers;
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } catch (error) {
        logger.warn('Invoice aggregation failed', {
          storeId: normalizedStoreId,
          context: logLabel,
          error: error.message,
        });
        break;
      }
    } while (lastEvaluatedKey);
    return {
      totalRevenue,
      totalInvoices,
      totalCustomers: customerSet.size,
      totalAnonymousCustomers: anonymousCount,
    };
  };

  const projectionFields =
    'store_id, total_amount, totalAmount, customer_phone, customer_name, invoice_id, invoiceId, invoice_no, invoiceNo, processed_timestamp_ist, invoice_date, invoice_timestamp, created_at';

  const baseQueryBuilder = (lastEvaluatedKey) => {
    const params = {
      TableName: INVOICES_TABLE,
      KeyConditionExpression: '#store_id = :storeId',
      ExpressionAttributeNames: {
        '#store_id': 'store_id',
      },
      ExpressionAttributeValues: {
        ':storeId': normalizedStoreId,
      },
      ProjectionExpression: projectionFields,
      Limit: 100,
    };
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }
    return params;
  };

  let stats = await aggregateFromPagedCommand(baseQueryBuilder, QueryCommand, 'primary-query');

  if (stats.totalInvoices === 0 && INVOICES_STORE_ID_INDEX) {
    const indexQueryBuilder = (lastEvaluatedKey) => {
      const params = baseQueryBuilder(lastEvaluatedKey);
      params.IndexName = INVOICES_STORE_ID_INDEX;
      return params;
    };
    stats = await aggregateFromPagedCommand(indexQueryBuilder, QueryCommand, 'store-id-index');
  }

  if (stats.totalInvoices === 0) {
    const scanBuilder = (lastEvaluatedKey) => {
      const params = {
        TableName: INVOICES_TABLE,
        FilterExpression: '#store_id = :storeId',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
        ExpressionAttributeValues: {
          ':storeId': normalizedStoreId,
        },
        ProjectionExpression: projectionFields,
        Limit: 100,
      };
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }
      return params;
    };
    stats = await aggregateFromPagedCommand(scanBuilder, ScanCommand, 'fallback-scan');
  }

  return {
    totalRevenue: stats.totalRevenue,
    totalInvoices: stats.totalInvoices,
    totalCustomers: stats.totalCustomers,
    totalAnonymousCustomers: stats.totalAnonymousCustomers || 0,
  };
};

const resolveStorePhone = (store) => {
  if (!store) {
    return '';
  }
  const fields = [
    store.franchise_owner_phone,
    store.contact_phone,
    store.vendor_phone,
    store.phone,
    store.mobile_number,
  ];
  for (const value of fields) {
    const digits = normalizePhoneDigits(value);
    if (digits) {
      return digits;
    }
  }
  return '';
};

async function getFranchiseOwnerContact(franchiseId) {
  if (!franchiseId || !STORE_CONFIG_TABLE) {
    return null;
  }

  const candidateIds = buildFranchiseCandidateIds([franchiseId]);
  const stores = await collectFranchiseStores(candidateIds);
  if (!stores.length) {
    return null;
  }

  const ownerStore = stores.find((store) => normalizePhoneDigits(store.franchise_owner_phone));
  if (ownerStore) {
    return {
      phone: normalizePhoneDigits(ownerStore.franchise_owner_phone),
      storeId: ownerStore.store_id,
      franchiseId: ownerStore.franchise_id || franchiseId,
      verifiedAt: ownerStore.franchise_owner_verified_at || ownerStore.created_at || null,
    };
  }

  const sortedByCreated = stores.slice().sort((a, b) => {
    const aTime = new Date(a.created_at || a.updated_at || 0).getTime();
    const bTime = new Date(b.created_at || b.updated_at || 0).getTime();
    return aTime - bTime;
  });

  const firstWithPhone = sortedByCreated.find((store) => resolveStorePhone(store));
  if (!firstWithPhone) {
    return null;
  }

  const normalizedPhone = resolveStorePhone(firstWithPhone);
  if (!normalizedPhone) {
    return null;
  }

  const verifiedAt = new Date().toISOString();
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: firstWithPhone.store_id },
        UpdateExpression:
          'SET franchise_owner_phone = :phone, franchise_owner_verified_at = :verified',
        ExpressionAttributeValues: {
          ':phone': normalizedPhone,
          ':verified': verifiedAt,
        },
      })
    );
  } catch (error) {
    logger.warn('Failed to stamp franchise owner phone', {
      franchiseId,
      storeId: firstWithPhone.store_id,
      error: error.message,
    });
  }

  return {
    phone: normalizedPhone,
    storeId: firstWithPhone.store_id,
    franchiseId: firstWithPhone.franchise_id || franchiseId,
    verifiedAt,
  };
}

const getStoreCampaignStats = async (storeId) => {
  if (!CAMPAIGN_TABLE_NAME || !storeId) {
    return { totalCampaigns: 0, totalMessages: 0 };
  }
  const normalizedStoreId = storeId.toString().trim();
  if (!normalizedStoreId) {
    return { totalCampaigns: 0, totalMessages: 0 };
  }

  const aggregateForKey = async (storeKeyValue) => {
    const campaignIds = new Set();
    let totalMessages = 0;
    let lastEvaluatedKey;
    let found = false;

    do {
      const params = {
        TableName: CAMPAIGN_TABLE_NAME,
        KeyConditionExpression: '#store_id = :storeId',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
        ExpressionAttributeValues: {
          ':storeId': storeKeyValue,
        },
        ProjectionExpression: 'campaign_id, campaign_name, sent_at',
        Limit: 200,
      };
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }
      try {
        const result = await docClient.send(new QueryCommand(params));
        if (result.Items && result.Items.length > 0) {
          found = true;
          totalMessages += result.Items.length;
          result.Items.forEach((item) => {
            if (item.campaign_id) {
              campaignIds.add(item.campaign_id);
            }
          });
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } catch (error) {
        logger.warn('Campaign stats query failed', {
          storeId: storeKeyValue,
          error: error.message,
        });
        break;
      }
    } while (lastEvaluatedKey);

    return {
      found,
      totalCampaigns: campaignIds.size,
      totalMessages,
    };
  };

  const stats = await aggregateForKey(normalizedStoreId);

  return {
    totalCampaigns: stats.totalCampaigns,
    totalMessages: stats.totalMessages,
  };
};

const getStoreCampaignSentCount = async (storeId) => {
  if (!CAMPAIGN_TABLE_NAME || !storeId) {
    return 0;
  }
  const normalizedStoreId = storeId.toString().trim();
  if (!normalizedStoreId) {
    return 0;
  }

  const aggregateForKey = async (storeKeyValue) => {
    let totalMessages = 0;
    let lastEvaluatedKey;
    let found = false;

    do {
      const params = {
        TableName: CAMPAIGN_TABLE_NAME,
        KeyConditionExpression: '#store_id = :storeId',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
        ExpressionAttributeValues: {
          ':storeId': storeKeyValue,
        },
        ProjectionExpression: 'sent_at',
        Limit: 200,
      };
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }
      try {
        const result = await docClient.send(new QueryCommand(params));
        if (result.Items && result.Items.length > 0) {
          found = true;
          totalMessages += result.Items.length;
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } catch (error) {
        logger.warn('Campaign sent count query failed', {
          storeId: storeKeyValue,
          error: error.message,
        });
        return { found, totalMessages };
      }
    } while (lastEvaluatedKey);

    return { found, totalMessages };
  };

  const stats = await aggregateForKey(normalizedStoreId);

  return stats.totalMessages;
};

const collectFranchiseStores = async (ids = []) => {
  if (!STORE_CONFIG_TABLE) {
    return [];
  }
  const candidates = buildFranchiseCandidateIds(ids);
  for (const candidate of candidates) {
    let lastEvaluatedKey = undefined;
    const stores = [];
    do {
      const params = {
        TableName: STORE_CONFIG_TABLE,
        FilterExpression: 'franchise_id = :franchiseId',
        ExpressionAttributeValues: {
          ':franchiseId': candidate,
        },
        ProjectionExpression:
          'store_id, franchise_id, brand_name, business_type, store_name, contact_phone, contact_email, onboarding_status, created_at, updated_at, franchise_password, franchise_access, franchise_owner_phone, franchise_owner_verified_at, trial_started, trial_period',
        Limit: 50,
      };
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }
      const existingFranchise = await docClient.send(new ScanCommand(params));
      if (existingFranchise.Items && existingFranchise.Items.length > 0) {
        stores.push(...existingFranchise.Items);
      }
      lastEvaluatedKey = existingFranchise.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (stores.length > 0) {
      const enriched = await Promise.all(
        stores.map(async (store) => {
          const [stats, campaignStats] = await Promise.all([
            getStoreInvoiceStats(store.store_id),
            getStoreCampaignStats(store.store_id),
          ]);
          return {
            ...store,
            total_revenue: stats.totalRevenue,
            total_invoices: stats.totalInvoices,
            total_customers: stats.totalCustomers,
            total_ebill_customers: stats.totalCustomers,
            total_anonymous_customers: stats.totalAnonymousCustomers,
            total_campaigns: campaignStats.totalCampaigns,
            total_campaign_messages: campaignStats.totalMessages,
            franchise_access: store.franchise_access,
          };
        })
      );
      return enriched;
    }
  }
  return [];
};

const collectFranchiseStoreIds = async (ids = []) => {
  if (!STORE_CONFIG_TABLE) {
    return [];
  }
  const candidates = buildFranchiseCandidateIds(ids);
  for (const candidate of candidates) {
    let lastEvaluatedKey = undefined;
    const storeIds = [];
    do {
      const params = {
        TableName: STORE_CONFIG_TABLE,
        FilterExpression: 'franchise_id = :franchiseId',
        ExpressionAttributeValues: {
          ':franchiseId': candidate,
        },
        ProjectionExpression: 'store_id',
        Limit: 50,
      };
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }
      const result = await docClient.send(new ScanCommand(params));
      if (result.Items && result.Items.length > 0) {
        result.Items.forEach((item) => {
          if (item.store_id) {
            storeIds.push(item.store_id);
          }
        });
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    if (storeIds.length > 0) {
      return storeIds;
    }
  }
  return [];
};

const findFranchiseByIds = async (ids = []) => {
  const stores = await collectFranchiseStores(ids);
  if (stores.length > 0) {
    const { franchise_id, brand_name, business_type } = stores[0];
    return { franchise_id, brand_name, business_type };
  }
  return null;
};

const getStoreDailyStats = async (storeId) => {
  if (!storeId || !INVOICES_TABLE) {
    return [];
  }
  const normalizedStoreId = storeId.toString().trim();
  if (!normalizedStoreId) {
    return [];
  }

  const dailyEndSet = await getDailyEndInvoiceSet(normalizedStoreId);
  const dateMap = new Map();

  const aggregateByDate = (items) => {
    items.forEach((item) => {
      const fingerprint = buildInvoiceFingerprint(item);
      if (
        isDailyEndReportInvoice(item) ||
        (dailyEndSet && fingerprint && dailyEndSet.has(fingerprint))
      ) {
        return;
      }
      const amount = Number(item.total_amount ?? item.totalAmount ?? 0);
      const rawDate =
        item.processed_timestamp_ist ||
        item.invoice_date ||
        item.invoice_timestamp ||
        item.created_at;
      const parsed = parseInvoiceTimestamp(rawDate);
      const dayKey = parsed ? parsed.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD');
      if (!dateMap.has(dayKey)) {
        dateMap.set(dayKey, {
          date: dayKey,
          invoices: 0,
          revenue: 0,
          customers: new Set(),
          ebill: 0,
          anonymous: 0,
        });
      }
      const entry = dateMap.get(dayKey);
      entry.invoices += 1;
      if (Number.isFinite(amount)) {
        entry.revenue += amount;
      }
      const customerKey = getInvoiceCustomerKey(item);
      const isAnonymousCustomer = !customerKey || customerKey.startsWith(ANONYMOUS_KEY_PREFIX);
      if (!isAnonymousCustomer && customerKey) {
        entry.customers.add(customerKey);
        entry.ebill += 1;
      } else {
        entry.anonymous += 1;
      }
    });
  };

  const projection =
    'store_id, total_amount, totalAmount, customer_phone, customer_name, invoice_date, processed_timestamp_ist, invoice_timestamp, created_at';

  const runQuery = async (indexName) => {
    let lastEvaluatedKey;
    let found = false;
    do {
      const params = {
        TableName: INVOICES_TABLE,
        KeyConditionExpression: '#store_id = :storeId',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
        ExpressionAttributeValues: {
          ':storeId': normalizedStoreId,
        },
        ProjectionExpression: projection,
        Limit: 200,
      };
      if (indexName) {
        params.IndexName = indexName;
      }
      if (lastEvaluatedKey) {
        params.ExclusiveStartKey = lastEvaluatedKey;
      }
      try {
        const result = await docClient.send(new QueryCommand(params));
        if (result.Items && result.Items.length > 0) {
          aggregateByDate(result.Items);
          found = true;
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } catch (error) {
        logger.warn('Daily stats query failed', {
          storeId: normalizedStoreId,
          indexName,
          error: error.message,
        });
        return false;
      }
    } while (lastEvaluatedKey);
    return found;
  };

  let hasData = await runQuery();
  if (!hasData && INVOICES_STORE_ID_INDEX) {
    hasData = await runQuery(INVOICES_STORE_ID_INDEX);
  }

  if (!hasData) {
    let scanKey = undefined;
    do {
      const scanParams = {
        TableName: INVOICES_TABLE,
        FilterExpression: '#store_id = :storeId',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
        ExpressionAttributeValues: {
          ':storeId': normalizedStoreId,
        },
        ProjectionExpression: projection,
        Limit: 200,
      };
      if (scanKey) {
        scanParams.ExclusiveStartKey = scanKey;
      }
      const result = await docClient.send(new ScanCommand(scanParams));
      if (result.Items && result.Items.length > 0) {
        aggregateByDate(result.Items);
        hasData = true;
      }
      scanKey = result.LastEvaluatedKey;
    } while (scanKey);

    if (!hasData) {
      logger.warn('No invoice activity found for store daily stats', {
        storeId: normalizedStoreId,
      });
    }
  }

  return Array.from(dateMap.values())
    .map((entry) => ({
      date: entry.date,
      invoices: entry.invoices,
      revenue: entry.revenue,
      customers: entry.customers.size,
      customer_keys: Array.from(entry.customers),
      ebill_invoices: entry.ebill,
      ebill_customers: entry.customers.size,
      anonymous_customers: entry.anonymous,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
};

module.exports = {
  buildFranchiseCandidateIds,
  collectFranchiseStores,
  collectFranchiseStoreIds,
  getStoreInvoiceStats,
  getStoreDailyStats,
  findFranchiseByIds,
  getFranchiseOwnerContact,
  getStoreCampaignSentCount,
};
const INVOICE_TIMESTAMP_FORMATS = [
  'DD-MM-YYYY HH:mm:ss',
  'DD/MM/YYYY HH:mm:ss',
  'DD-MM-YYYY',
  'DD/MM/YYYY',
  'YYYY-MM-DD HH:mm:ss',
  'YYYY/MM/DD HH:mm:ss',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'DD MMM YYYY',
  'DD MMM YYYY HH:mm:ss',
  'YYYY-MM-DDTHH:mm:ss.SSSZ',
  'YYYY-MM-DDTHH:mm:ssZ',
  'ddd MMM DD YYYY HH:mm:ss [GMT]ZZ',
  'ddd MMM DD YYYY HH:mm:ss [GMT]ZZ (z)',
];

const parseInvoiceTimestamp = (value) => {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = typeof value === 'string' ? value.trim() : String(value).trim();
  if (!normalized) {
    return null;
  }
  for (const format of INVOICE_TIMESTAMP_FORMATS) {
    const parsed = dayjs(normalized, format, true);
    if (parsed.isValid()) {
      return parsed;
    }
  }
  const fallback = dayjs(normalized);
  return fallback.isValid() ? fallback : null;
};
