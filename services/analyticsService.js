const { docClient } = require('../config/dynamodb');
const {
  ScanCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  DEFAULT_CUSTOMER_TYPE_CONFIG,
  sanitizeCustomerTypeConfig,
  determineCustomerType,
} = require('../utils/customerTypes');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const customParseFormat = require('dayjs/plugin/customParseFormat');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TABLE_NAME = process.env.DYNAMODB_TABLE;
const CAMPAIGN_TABLE_NAME = process.env.CAMPAIGN_TABLE_NAME;
const CAMPAIGN_METADATA_TABLE = process.env.CAMPAIGN_METADATA_TABLE;
const STORE_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;
const FRANCHISES_TABLE = process.env.FRANCHISES_TABLE;
const CAMPAIGN_ID_SENT_AT_INDEX =
  process.env.CAMPAIGN_ID_SENT_AT_INDEX || 'campaign_id-sent_at-index';
const INVOICES_STORE_PROCESSED_INDEX =
  process.env.INVOICES_STORE_PROCESSED_INDEX || 'store_id-processed_iso_ist-index';

const IST_TIMEZONE = 'Asia/Kolkata';
const RANGE_LABELS = {
  today: 'Today',
  thisWeek: 'This Week',
  last7d: 'Last 7 Days',
  thisMonth: 'This Month',
  thisYear: 'This Year',
  all: 'All Time',
  alltime: 'All Time',
  custom: 'Custom Range',
};
const ANONYMOUS_PHONE = '0000000000';
const ANONYMOUS_KEY_PREFIX = 'anonymous:';
const DAILY_END_REPORT_CUSTOMER_NAME = '1234';
const STORE_ID_IGNORE = new Set(['ALL', 'ALL_STORES']);
const TIMESTAMP_FORMATS = [
  'YYYY-MM-DDTHH:mm:ss.SSSZ',
  'YYYY-MM-DDTHH:mm:ssZ',
  'YYYY-MM-DDTHH:mm:ss',
  'YYYY-MM-DD HH:mm:ss',
  'DD-MM-YYYY HH:mm:ss',
  'DD/MM/YYYY HH:mm:ss',
  'YYYY/MM/DD HH:mm:ss',
  'DD-MM-YYYY',
  'DD/MM/YYYY',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
];
const OFFSET_SUFFIX_REGEX = /([Zz]|[+\-]\d{2}:?\d{2})$/;

const normalizeStoreIdValue = (value) => {
  if (value === null || value === undefined) {
    return null;
  }
  const stringValue = value.toString().trim();
  if (!stringValue) {
    return null;
  }
  const upper = stringValue.toUpperCase();
  if (STORE_ID_IGNORE.has(upper)) {
    return null;
  }
  return upper;
};

const parseRawIstTimestamp = (rawValue) => {
  if (!rawValue) {
    return null;
  }
  const value = rawValue.toString().trim();
  if (!value) {
    return null;
  }

  const hasOffset = OFFSET_SUFFIX_REGEX.test(value);
  let parsed = null;
  if (hasOffset) {
    parsed = dayjs(value);
  } else {
    for (const format of TIMESTAMP_FORMATS) {
      const candidate = dayjs.tz(value, format, IST_TIMEZONE, true);
      if (candidate.isValid()) {
        parsed = candidate;
        break;
      }
    }
    if (!parsed || !parsed.isValid()) {
      parsed = dayjs.tz ? dayjs.tz(value, IST_TIMEZONE) : dayjs(value);
    }
  }

  return parsed && parsed.isValid() ? parsed.tz(IST_TIMEZONE) : null;
};

const formatRangeBoundaryForIndex = (value) => {
  if (!value) {
    return null;
  }
  const parsed = dayjs(value).tz(IST_TIMEZONE);
  if (!parsed.isValid()) {
    return null;
  }
  // Keep IST-local ISO without offset to match stored processed_iso_ist format.
  return parsed.format('YYYY-MM-DDTHH:mm:ss.SSS');
};

async function scanAll(params) {
  const items = [];
  let lastEvaluatedKey;

  do {
    const commandParams = { ...params };
    if (lastEvaluatedKey) {
      commandParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await docClient.send(new ScanCommand(commandParams));
    if (result.Items) {
      items.push(...result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
}

async function queryAll(params) {
  const items = [];
  let lastEvaluatedKey;

  do {
    const commandParams = { ...params };
    if (lastEvaluatedKey) {
      commandParams.ExclusiveStartKey = lastEvaluatedKey;
    }

    const result = await docClient.send(new QueryCommand(commandParams));
    if (result.Items) {
      items.push(...result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
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

const normalizePhoneDigits = (value) => (value || '').toString().replace(/\D/g, '');

const isAnonymousPhoneDigits = (digits) => digits === ANONYMOUS_PHONE;

const isDailyEndReportInvoice = (invoice = {}) => {
  if (!invoice) {
    return false;
  }
  const rawName = invoice.customer_name ?? invoice.customerName ?? null;
  if (rawName === undefined || rawName === null) {
    return false;
  }
  return rawName.toString().trim() === DAILY_END_REPORT_CUSTOMER_NAME;
};

const toDayjsInput = (value) => {
  if (!value) {
    return null;
  }
  if (value instanceof Date || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  if (typeof value?.toDate === 'function') {
    return value.toDate();
  }
  return null;
};

const formatDateForLabel = (input) => {
  const value = toDayjsInput(input);
  if (!value) {
    return '';
  }
  const instance = dayjs(value).tz(IST_TIMEZONE);
  return instance.isValid() ? instance.format('DD MMM YYYY') : '';
};

const parseCustomBoundary = (rawValue) => {
  if (!rawValue) {
    return null;
  }
  const normalized = rawValue.trim();
  if (!normalized) {
    return null;
  }
  const strict = dayjs.tz(normalized, 'YYYY-MM-DD', IST_TIMEZONE, true);
  if (strict.isValid()) {
    return strict;
  }
  const fallback = dayjs(normalized);
  if (!fallback.isValid()) {
    return null;
  }
  return fallback.tz ? fallback.tz(IST_TIMEZONE) : fallback;
};

const getInvoiceTimestampIstInternal = (invoice = {}) => {
  if (!invoice) {
    return null;
  }
  const candidate =
    invoice.processed_iso_ist ||
    invoice.processedIsoIst ||
    invoice.processed_timestamp_ist ||
    invoice.processedTimestampIst ||
    invoice.invoice_timestamp_ist ||
    null;
  const parsed = parseRawIstTimestamp(candidate);
  return parsed?.isValid() ? parsed : null;
};

const buildDateRangeInternal = (rangeParam = 'today', customStart, customEnd) => {
  const normalizedRange = RANGE_LABELS[rangeParam] ? rangeParam : 'today';
  const nowIst = dayjs().tz(IST_TIMEZONE);
  let start = null;
  let end = null;

  switch (normalizedRange) {
    case 'last7d': {
      end = nowIst.endOf('day');
      start = end.subtract(6, 'day').startOf('day');
      break;
    }
    case 'thisWeek': {
      const weekday = nowIst.day(); // 0 Sunday - 6 Saturday
      const diff = weekday === 0 ? 6 : weekday - 1; // Monday start
      start = nowIst.subtract(diff, 'day').startOf('day');
      end = start.add(6, 'day').endOf('day');
      break;
    }
    case 'thisMonth': {
      start = nowIst.startOf('month');
      end = nowIst.endOf('month');
      break;
    }
    case 'thisYear': {
      start = nowIst.startOf('year');
      end = nowIst.endOf('year');
      break;
    }
    case 'alltime':
    case 'all': {
      start = null;
      end = null;
      break;
    }
    case 'custom': {
      const parsedStart = parseCustomBoundary(customStart);
      const parsedEnd = parseCustomBoundary(customEnd);
      if (parsedStart?.isValid() && parsedEnd?.isValid()) {
        start = parsedStart.startOf('day');
        end = parsedEnd.endOf('day');
      }
      break;
    }
    case 'today':
    default: {
      start = nowIst.startOf('day');
      end = nowIst.endOf('day');
      break;
    }
  }

  let label = RANGE_LABELS[normalizedRange] || RANGE_LABELS.today;
  if (normalizedRange === 'custom' && start && end) {
    label = `Custom (${formatDateForLabel(start)} - ${formatDateForLabel(end)})`;
  }

  return {
    type: normalizedRange,
    start: start ? start.toDate() : null,
    end: end ? end.toDate() : null,
    label,
  };
};

const filterInvoicesByRangeInternal = (invoices, dateRange) => {
  const hasStart = Boolean(dateRange?.start);
  const hasEnd = Boolean(dateRange?.end);
  if (!hasStart && !hasEnd) {
    return Array.isArray(invoices) ? [...invoices] : [];
  }
  const startTime = hasStart ? dayjs(dateRange.start).valueOf() : null;
  const endTime = hasEnd ? dayjs(dateRange.end).valueOf() : null;
  return invoices.filter((invoice) => {
    const timestamp = getInvoiceTimestampIstInternal(invoice);
    if (!timestamp) {
      return false;
    }
    const timeValue = timestamp.valueOf();
    if (startTime !== null && timeValue < startTime) {
      return false;
    }
    if (endTime !== null && timeValue > endTime) {
      return false;
    }
    return true;
  });
};

const buildAnonymousCustomerKey = (invoice) => {
  const identifier =
    invoice.invoice_id ||
    invoice.invoice_no ||
    invoice.processed_timestamp_ist ||
    invoice.invoice_date ||
    `${invoice.store_id}-${Date.now()}`;
  return `${ANONYMOUS_KEY_PREFIX}${identifier}`;
};

const getInvoiceCustomerKey = (invoice) => {
  const phone = typeof invoice.customer_phone === 'string' ? invoice.customer_phone.trim() : '';
  if (!phone) {
    return null;
  }
  const digits = phone.replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  if (digits === ANONYMOUS_PHONE) {
    return buildAnonymousCustomerKey(invoice);
  }
  return digits;
};

const aggregateInvoicesByStoreInternal = (invoices) => {
  const metrics = {};
  invoices.forEach((invoice) => {
    const storeId = invoice.store_id || 'UNKNOWN';
    if (!metrics[storeId]) {
      metrics[storeId] = {
        revenue: 0,
        invoices: 0,
        ebillInvoices: 0,
        eBillCustomers: 0,
        anonymousCustomers: 0,
        customerKeys: new Set(),
        avgItemsAccumulator: { totalItems: 0, orders: 0 },
        discountAccumulator: { totalDiscount: 0, orders: 0 },
      };
    }
    const entry = metrics[storeId];
    entry.revenue += Number(invoice.total_amount) || 0;
    entry.invoices += 1;
    const phoneDigits = normalizePhoneDigits(invoice.customer_phone);
    if (!isAnonymousPhoneDigits(phoneDigits)) {
      entry.ebillInvoices += 1;
    }
    const customerKey = getInvoiceCustomerKey(invoice);
    if (customerKey && !entry.customerKeys.has(customerKey)) {
      entry.customerKeys.add(customerKey);
      if (customerKey.startsWith(ANONYMOUS_KEY_PREFIX)) {
        entry.anonymousCustomers += 1;
      } else {
        entry.eBillCustomers += 1;
      }
    }
    if (Number.isFinite(invoice.total_items)) {
      entry.avgItemsAccumulator.totalItems += Number(invoice.total_items);
      entry.avgItemsAccumulator.orders += 1;
    }
    if (Number.isFinite(invoice.discount_amount)) {
      entry.discountAccumulator.totalDiscount += Number(invoice.discount_amount);
      entry.discountAccumulator.orders += 1;
    }
  });

  const normalized = {};
  Object.entries(metrics).forEach(([storeId, metric]) => {
    normalized[storeId] = {
      revenue: metric.revenue,
      invoices: metric.invoices,
      ebillInvoices: metric.ebillInvoices,
      eBillCustomers: metric.eBillCustomers,
      anonymousCustomers: metric.anonymousCustomers,
      avgItemsPerOrder:
        metric.avgItemsAccumulator.orders > 0
          ? metric.avgItemsAccumulator.totalItems / metric.avgItemsAccumulator.orders
          : null,
      discountRate:
        metric.discountAccumulator.orders > 0
          ? metric.discountAccumulator.totalDiscount / metric.discountAccumulator.orders
          : null,
    };
  });
  return normalized;
};

const parseGenericTimestamp = (value) => {
  const parsed = parseRawIstTimestamp(value);
  return parsed ? parsed.toDate() : null;
};

class AnalyticsService {
  buildInvoiceFingerprint(invoice = {}) {
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
    const phone =
      normalizePhoneNumber(invoice.customer_phone ?? invoice.customerPhone) || 'unknown';
    const amount = Number(invoice.total_amount ?? invoice.totalAmount ?? 0).toFixed(2);
    return `calc:${phone}|${timestamp}|${amount}`;
  }

  async getExcludedInvoiceSet(storeId) {
    if (!STORE_CONFIG_TABLE || !storeId) {
      return new Set();
    }
    try {
      const command = new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId },
        ProjectionExpression: 'excluded_invoices',
      });
      const result = await docClient.send(command);
      const values = Array.isArray(result?.Item?.excluded_invoices)
        ? result.Item.excluded_invoices
        : [];
      return new Set(
        values
          .filter((value) => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim())
      );
    } catch (error) {
      console.error('Failed to load excluded invoices', { storeId, error: error.message });
      return new Set();
    }
  }

  async updateExcludedInvoices(storeId, updater) {
    if (!STORE_CONFIG_TABLE || !storeId) {
      return;
    }
    const currentValues = await this.getExcludedInvoiceSet(storeId);
    const next = Array.from(
      new Set(updater ? updater(Array.from(currentValues)) : Array.from(currentValues))
    ).filter(Boolean);
    const updateCommand = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression: 'SET excluded_invoices = :values, updated_at = :updated',
      ExpressionAttributeValues: {
        ':values': next,
        ':updated': new Date().toISOString(),
      },
    });
    await docClient.send(updateCommand);
  }

  async excludeInvoice(storeId, fingerprint) {
    if (!fingerprint) {
      return;
    }
    await this.updateExcludedInvoices(storeId, (current) => {
      if (current.includes(fingerprint)) {
        return current;
      }
      return [...current, fingerprint];
    });
  }

  async includeInvoice(storeId, fingerprint, invoicePayload = null, options = {}) {
    if (!fingerprint) {
      return;
    }
    await this.updateExcludedInvoices(storeId, (current) =>
      current.filter((value) => value !== fingerprint)
    );
    await this.updateDailyEndInvoices(storeId, (current) =>
      current.filter((value) => value !== fingerprint)
    );
    const restoringFromDaily =
      Boolean(options?.restoreFromDaily) || Boolean(invoicePayload?.is_daily_end_report);
    if (restoringFromDaily && invoicePayload) {
      await this.markInvoiceCustomerName(storeId, invoicePayload, null);
    }
  }

  async getDailyEndInvoiceSet(storeId) {
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
      console.error('Failed to load daily end invoices', { storeId, error: error.message });
      return new Set();
    }
  }

  async updateDailyEndInvoices(storeId, updater) {
    if (!STORE_CONFIG_TABLE || !storeId) {
      return;
    }
    const currentValues = await this.getDailyEndInvoiceSet(storeId);
    const next = Array.from(
      new Set(updater ? updater(Array.from(currentValues)) : Array.from(currentValues))
    ).filter(Boolean);
    const updateCommand = new UpdateCommand({
      TableName: STORE_CONFIG_TABLE,
      Key: { store_id: storeId },
      UpdateExpression: 'SET daily_end_invoices = :values, updated_at = :updated',
      ExpressionAttributeValues: {
        ':values': next,
        ':updated': new Date().toISOString(),
      },
    });
    await docClient.send(updateCommand);
  }

  async addInvoiceToDailyEndReport(storeId, fingerprint, invoicePayload = null) {
    if (!fingerprint) {
      return;
    }
    await this.updateDailyEndInvoices(storeId, (current) => {
      if (current.includes(fingerprint)) {
        return current;
      }
      return [...current, fingerprint];
    });
    if (invoicePayload) {
      await this.markInvoiceCustomerName(storeId, invoicePayload, DAILY_END_REPORT_CUSTOMER_NAME);
    }
  }

  async markInvoiceCustomerName(storeId, invoiceData, customerName) {
    if (!TABLE_NAME || !storeId) {
      return;
    }
    const normalizedStoreId = storeId.toString();
    const invoiceId =
      invoiceData?.invoice_id ?? invoiceData?.invoiceId ?? invoiceData?.invoiceID ?? null;
    if (!invoiceId) {
      console.warn('Unable to mark invoice without invoice_id', { storeId });
      return;
    }
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { store_id: normalizedStoreId, invoice_id: invoiceId },
          UpdateExpression: 'SET customer_name = :customerName',
          ExpressionAttributeValues: {
            ':customerName': customerName ?? null,
          },
        })
      );
    } catch (error) {
      console.error('Failed to update invoice customer name', {
        storeId,
        invoiceId,
        error: error.message,
      });
    }
  }

  async getStoreCustomerTypeConfig(storeId) {
    if (!STORE_CONFIG_TABLE || !storeId) {
      return DEFAULT_CUSTOMER_TYPE_CONFIG;
    }
    try {
      const result = await docClient.send(
        new GetCommand({
          TableName: STORE_CONFIG_TABLE,
          Key: { store_id: storeId.toString() },
        })
      );
      if (result.Item?.customer_type_config) {
        return sanitizeCustomerTypeConfig(result.Item.customer_type_config);
      }
    } catch (error) {
      console.error('Error fetching customer type config for store:', error);
    }
    return DEFAULT_CUSTOMER_TYPE_CONFIG;
  }

  // Get all unique stores from DynamoDB
  async getStores() {
    try {
      const items = await scanAll({
        TableName: TABLE_NAME,
        ProjectionExpression: 'store_id',
      });

      const uniqueStores = [...new Set(items.map((item) => item.store_id))];

      return uniqueStores.map((storeId) => ({
        store_id: storeId,
        name: `Store ${storeId}`,
      }));
    } catch (error) {
      console.error('Error fetching stores:', error);
      throw error;
    }
  }

  // Get invoices for a specific store
  async getInvoices(storeId, options = {}) {
    try {
      const includeExcluded = Object.prototype.hasOwnProperty.call(options, 'includeExcluded')
        ? Boolean(options.includeExcluded)
        : true;
      const includeDailyEndReports = Object.prototype.hasOwnProperty.call(
        options,
        'includeDailyEndReports'
      )
        ? Boolean(options.includeDailyEndReports)
        : false;
      const onlyDailyEndReports = Boolean(options.onlyDailyEndReports);
      const exclusionSet =
        storeId && storeId !== 'ALL' ? await this.getExcludedInvoiceSet(storeId) : null;
      const dailyEndSet =
        storeId && storeId !== 'ALL' ? await this.getDailyEndInvoiceSet(storeId) : null;
      const scanParams =
        storeId === 'ALL'
          ? {
              TableName: TABLE_NAME,
              ProjectionExpression:
                'customer_phone, customer_name, invoice_id, invoice_no, invoice_date, processed_timestamp_ist, total_amount',
            }
          : {
              TableName: TABLE_NAME,
              FilterExpression: 'store_id = :storeId',
              ExpressionAttributeValues: {
                ':storeId': storeId,
              },
              ProjectionExpression:
                'customer_phone, customer_name, invoice_id, invoice_no, invoice_date, processed_timestamp_ist, total_amount',
            };

      const items = await scanAll(scanParams);

      const invoices = items.map((item) => {
        const fingerprint = this.buildInvoiceFingerprint(item);
        const isExcluded = exclusionSet ? exclusionSet.has(fingerprint) : false;
        const isDailyEndReport =
          isDailyEndReportInvoice(item) || (dailyEndSet ? dailyEndSet.has(fingerprint) : false);
        return {
          customer_phone: item.customer_phone || 'N/A',
          customer_name: item.customer_name || null,
          invoice_no: item.invoice_no || item.invoice_id || null,
          invoice_id: item.invoice_id || null,
          invoice_date: item.invoice_date,
          processed_timestamp_ist: item.processed_timestamp_ist || item.invoice_date || null,
          total_amount: parseFloat(item.total_amount) || 0,
          fingerprint,
          is_excluded: isExcluded,
          is_daily_end_report: isDailyEndReport,
        };
      });

      let workingInvoices = invoices;
      if (onlyDailyEndReports) {
        workingInvoices = invoices.filter((invoice) => invoice.is_daily_end_report);
      } else if (!includeDailyEndReports) {
        workingInvoices = invoices.filter((invoice) => !invoice.is_daily_end_report);
      }

      return includeExcluded
        ? workingInvoices
        : workingInvoices.filter((invoice) => !invoice.is_excluded);
    } catch (error) {
      console.error('Error fetching invoices:', error);
      throw error;
    }
  }

  async getDailyEndReportInvoices(storeId, options = {}) {
    return this.getInvoices(storeId, {
      ...options,
      includeDailyEndReports: true,
      onlyDailyEndReports: true,
    });
  }

  async getAllInvoicesNormalized() {
    try {
      const items = await scanAll({
        TableName: TABLE_NAME,
        ProjectionExpression:
          '#store_id, customer_phone, invoice_id, invoice_no, invoice_date, processed_timestamp_ist, processed_iso_ist, total_amount, total_items, discount_amount',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
      });

      return items.map((item) => {
        const normalizedStoreId = normalizeStoreIdValue(item.store_id);
        return {
          store_id: normalizedStoreId || 'UNKNOWN',
          raw_store_id: item.store_id || null,
          customer_phone: item.customer_phone || null,
          invoice_no: item.invoice_no || item.invoice_id || null,
          invoice_id: item.invoice_id || null,
          invoice_date: item.invoice_date || null,
          processed_timestamp_ist: item.processed_timestamp_ist || null,
          processed_iso_ist: item.processed_iso_ist || null,
          total_amount: parseFloat(item.total_amount) || 0,
          total_items: Number(item.total_items) || 0,
          discount_amount: Number(item.discount_amount) || 0,
        };
      });
    } catch (error) {
      console.error('Error fetching normalized invoices:', error);
      throw error;
    }
  }

  async getInvoicesByStoreRange(storeId, startIso, endIso) {
    if (!storeId || !TABLE_NAME) {
      return [];
    }
    const normalizedStoreId = normalizeStoreIdValue(storeId);
    if (!normalizedStoreId) {
      return [];
    }
    const startValue = startIso || null;
    const endValue = endIso || null;
    if (!startValue || !endValue) {
      return [];
    }

    const items = await queryAll({
      TableName: TABLE_NAME,
      IndexName: INVOICES_STORE_PROCESSED_INDEX,
      KeyConditionExpression: '#store_id = :storeId AND #processed_iso_ist BETWEEN :start AND :end',
      ExpressionAttributeNames: {
        '#store_id': 'store_id',
        '#processed_iso_ist': 'processed_iso_ist',
      },
      ExpressionAttributeValues: {
        ':storeId': normalizedStoreId,
        ':start': startValue,
        ':end': endValue,
      },
      ProjectionExpression:
        '#store_id, customer_phone, customer_name, invoice_id, invoice_no, invoice_date, processed_timestamp_ist, processed_iso_ist, total_amount',
    });

    return items.map((item) => {
      const fingerprint = this.buildInvoiceFingerprint(item);
      return {
        store_id: normalizeStoreIdValue(item.store_id) || 'UNKNOWN',
        raw_store_id: item.store_id || null,
        customer_phone: item.customer_phone || null,
        customer_name: item.customer_name || null,
        invoice_no: item.invoice_no || item.invoice_id || null,
        invoice_id: item.invoice_id || null,
        invoice_date: item.invoice_date,
        processed_timestamp_ist: item.processed_timestamp_ist || item.invoice_date || null,
        processed_iso_ist: item.processed_iso_ist || null,
        total_amount: parseFloat(item.total_amount) || 0,
        fingerprint,
      };
    });
  }

  // Get KPI metrics for a specific store
  async getKPIs(storeId, fromDate, toDate) {
    try {
      const scanParams =
        storeId === 'ALL'
          ? {
              TableName: TABLE_NAME,
              ProjectionExpression: 'customer_phone, customer_name, invoice_date, total_amount',
            }
          : {
              TableName: TABLE_NAME,
              FilterExpression: 'store_id = :storeId',
              ExpressionAttributeValues: {
                ':storeId': storeId,
              },
              ProjectionExpression: 'customer_phone, customer_name, invoice_date, total_amount',
            };

      const items = await scanAll(scanParams);
      const dailyEndSet =
        storeId && storeId !== 'ALL' ? await this.getDailyEndInvoiceSet(storeId) : null;
      const visibleItems = items.filter((item) => {
        if (isDailyEndReportInvoice(item)) {
          return false;
        }
        if (!dailyEndSet) {
          return true;
        }
        const fingerprint = this.buildInvoiceFingerprint(item);
        return !dailyEndSet.has(fingerprint);
      });
      const exclusionSet =
        storeId && storeId !== 'ALL' ? await this.getExcludedInvoiceSet(storeId) : null;
      const mappedInvoices = visibleItems.map((item) => ({
        customer_phone: item.customer_phone || 'N/A',
        invoice_date: item.invoice_date,
        total_amount: parseFloat(item.total_amount) || 0,
        _fingerprint: this.buildInvoiceFingerprint(item),
      }));
      const invoices = exclusionSet
        ? mappedInvoices
            .filter((inv) => !exclusionSet.has(inv._fingerprint))
            .map((inv) => ({
              customer_phone: inv.customer_phone,
              invoice_date: inv.invoice_date,
              total_amount: inv.total_amount,
            }))
        : mappedInvoices.map((inv) => ({
            customer_phone: inv.customer_phone,
            invoice_date: inv.invoice_date,
            total_amount: inv.total_amount,
          }));

      // Filter by date range if provided
      let filteredInvoices = invoices;
      if (fromDate || toDate) {
        filteredInvoices = invoices.filter((invoice) => {
          const invoiceDate = new Date(invoice.invoice_date);
          if (fromDate && invoiceDate < new Date(fromDate)) return false;
          if (toDate && invoiceDate > new Date(toDate)) return false;
          return true;
        });
      }

      // Calculate KPIs
      const totalCustomers = new Set(filteredInvoices.map((inv) => inv.customer_phone)).size;

      // Calculate repeat customer rate
      const customerCounts = {};
      filteredInvoices.forEach((inv) => {
        customerCounts[inv.customer_phone] = (customerCounts[inv.customer_phone] || 0) + 1;
      });
      const repeatCustomers = Object.values(customerCounts).filter((count) => count > 1).length;
      const repeatCustomerRate = totalCustomers > 0 ? (repeatCustomers / totalCustomers) * 100 : 0;

      // Calculate average transaction value
      const totalRevenue = filteredInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
      const avgTransactionValue =
        filteredInvoices.length > 0 ? totalRevenue / filteredInvoices.length : 0;

      // Calculate new customers this month
      const currentMonth = new Date();
      const startOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
      const thisMonthInvoices = filteredInvoices.filter(
        (inv) => new Date(inv.invoice_date) >= startOfMonth
      );
      const thisMonthCustomers = new Set(thisMonthInvoices.map((inv) => inv.customer_phone));

      // Find customers who had no invoices before this month
      const beforeThisMonth = filteredInvoices.filter(
        (inv) => new Date(inv.invoice_date) < startOfMonth
      );
      const existingCustomers = new Set(beforeThisMonth.map((inv) => inv.customer_phone));
      const newCustomersThisMonth = Array.from(thisMonthCustomers).filter(
        (customer) => !existingCustomers.has(customer)
      ).length;

      return {
        totalCustomers,
        repeatCustomerRate: Math.round(repeatCustomerRate * 100) / 100,
        avgTransactionValue: Math.round(avgTransactionValue * 100) / 100,
        newCustomersThisMonth,
      };
    } catch (error) {
      console.error('Error fetching KPIs:', error);
      throw error;
    }
  }

  // Insert campaign details into campaignDetailsStore table
  async insertCampaignDetail(campaignDetail) {
    try {
      const normalizedCustomerPhone =
        normalizePhoneNumber(campaignDetail.customer_phone) ||
        campaignDetail.normalized_customer_phone ||
        null;

      const item = {
        store_id: campaignDetail.store_id,
        sent_at: campaignDetail.sent_at,
        campaign_name: campaignDetail.campaign_name,
        template_name: campaignDetail.template_name || null,
        template_language: campaignDetail.template_language || null,
        template_parameters: campaignDetail.template_parameters || null,
        message: campaignDetail.message || null,
        send_mode: campaignDetail.send_mode || null,
        header_image_s3_key: campaignDetail.header_image_s3_key || null,
        resend_enabled: campaignDetail.resend_enabled ?? null,
        resend_delay_option: campaignDetail.resend_delay_option || null,
        customer_phone: campaignDetail.customer_phone,
        normalized_customer_phone: normalizedCustomerPhone,
        customer_name: campaignDetail.customer_name,
        status: campaignDetail.status,
        message_id: campaignDetail.message_id || null,
        last_status_update: campaignDetail.last_status_update || campaignDetail.sent_at,
        campaign_id: campaignDetail.campaign_id || campaignDetail.campaignId || null,
        error_reason: campaignDetail.error_reason || null,
        error_code: campaignDetail.error_code === undefined ? null : campaignDetail.error_code,
      };

      if (!item.template_name) {
        delete item.template_name;
      }
      if (!item.template_language) {
        delete item.template_language;
      }
      if (!item.template_parameters) {
        delete item.template_parameters;
      }
      if (!item.message) {
        delete item.message;
      }
      if (!item.send_mode) {
        delete item.send_mode;
      }
      if (!item.header_image_s3_key) {
        delete item.header_image_s3_key;
      }
      if (item.resend_enabled === null || item.resend_enabled === undefined) {
        delete item.resend_enabled;
      }
      if (!item.resend_delay_option) {
        delete item.resend_delay_option;
      }
      if (!item.normalized_customer_phone) {
        delete item.normalized_customer_phone;
      }
      if (!item.customer_name) {
        delete item.customer_name;
      }
      if (!item.message_id) {
        delete item.message_id;
      }
      if (!item.campaign_id) {
        delete item.campaign_id;
      }
      if (!item.error_reason) {
        delete item.error_reason;
      }
      if (item.error_code === undefined || item.error_code === null) {
        delete item.error_code;
      }

      const command = new PutCommand({
        TableName: CAMPAIGN_TABLE_NAME,
        Item: item,
      });

      await docClient.send(command);
      return { success: true };
    } catch (error) {
      console.error('Error inserting campaign detail:', error);
      throw error;
    }
  }

  async upsertCampaignDetail(campaignDetail) {
    const storeId = campaignDetail?.store_id;
    const campaignId = campaignDetail?.campaign_id || campaignDetail?.campaignId || null;
    const customerPhone = campaignDetail?.customer_phone || null;

    if (storeId && campaignId && customerPhone) {
      try {
        const result = await docClient.send(
          new QueryCommand({
            TableName: CAMPAIGN_TABLE_NAME,
            IndexName: CAMPAIGN_ID_SENT_AT_INDEX,
            KeyConditionExpression: '#campaign_id = :campaignId',
            ExpressionAttributeNames: {
              '#campaign_id': 'campaign_id',
              '#store_id': 'store_id',
              '#customer_phone': 'customer_phone',
            },
            ExpressionAttributeValues: {
              ':campaignId': campaignId,
              ':storeId': storeId,
              ':customerPhone': customerPhone,
            },
            FilterExpression: '#store_id = :storeId AND #customer_phone = :customerPhone',
            ScanIndexForward: false,
            Limit: 1,
          })
        );

        if (result.Items && result.Items.length > 0) {
          const existing = result.Items[0];
          const updateFields = {
            status: campaignDetail.status || existing.status || null,
            error_reason: campaignDetail.error_reason || campaignDetail.errorReason || null,
            error_code:
              campaignDetail.error_code === undefined
                ? (campaignDetail.errorCode ?? null)
                : campaignDetail.error_code,
            message_id: campaignDetail.message_id || null,
            last_status_update: campaignDetail.last_status_update || campaignDetail.sent_at || null,
            updated_at: new Date().toISOString(),
          };

          await docClient.send(
            new UpdateCommand({
              TableName: CAMPAIGN_TABLE_NAME,
              Key: {
                store_id: existing.store_id,
                sent_at: existing.sent_at,
              },
              UpdateExpression:
                'SET #status = :status, #error_reason = :errorReason, #error_code = :errorCode, #message_id = :messageId, #last_status_update = :lastStatusUpdate, #updated_at = :updatedAt',
              ExpressionAttributeNames: {
                '#status': 'status',
                '#error_reason': 'error_reason',
                '#error_code': 'error_code',
                '#message_id': 'message_id',
                '#last_status_update': 'last_status_update',
                '#updated_at': 'updated_at',
              },
              ExpressionAttributeValues: {
                ':status': updateFields.status,
                ':errorReason': updateFields.error_reason,
                ':errorCode': updateFields.error_code,
                ':messageId': updateFields.message_id,
                ':lastStatusUpdate': updateFields.last_status_update,
                ':updatedAt': updateFields.updated_at,
              },
            })
          );

          return { success: true, updated: true };
        }
      } catch (error) {
        console.error('Error updating campaign detail:', error);
      }
    }

    if (storeId && campaignId && customerPhone) {
      try {
        const scanItems = await scanAll({
          TableName: CAMPAIGN_TABLE_NAME,
          FilterExpression:
            '#campaign_id = :campaignId AND #store_id = :storeId AND #customer_phone = :customerPhone',
          ExpressionAttributeNames: {
            '#campaign_id': 'campaign_id',
            '#store_id': 'store_id',
            '#customer_phone': 'customer_phone',
          },
          ExpressionAttributeValues: {
            ':campaignId': campaignId,
            ':storeId': storeId,
            ':customerPhone': customerPhone,
          },
        });

        if (scanItems.length > 0) {
          const existing = scanItems.reduce((latest, item) => {
            const latestTime = new Date(latest.sent_at || 0).getTime();
            const itemTime = new Date(item.sent_at || 0).getTime();
            return itemTime >= latestTime ? item : latest;
          }, scanItems[0]);

          const updateFields = {
            status: campaignDetail.status || existing.status || null,
            error_reason: campaignDetail.error_reason || campaignDetail.errorReason || null,
            error_code:
              campaignDetail.error_code === undefined
                ? (campaignDetail.errorCode ?? null)
                : campaignDetail.error_code,
            message_id: campaignDetail.message_id || null,
            last_status_update: campaignDetail.last_status_update || campaignDetail.sent_at || null,
            updated_at: new Date().toISOString(),
          };

          await docClient.send(
            new UpdateCommand({
              TableName: CAMPAIGN_TABLE_NAME,
              Key: {
                store_id: existing.store_id,
                sent_at: existing.sent_at,
              },
              UpdateExpression:
                'SET #status = :status, #error_reason = :errorReason, #error_code = :errorCode, #message_id = :messageId, #last_status_update = :lastStatusUpdate, #updated_at = :updatedAt',
              ExpressionAttributeNames: {
                '#status': 'status',
                '#error_reason': 'error_reason',
                '#error_code': 'error_code',
                '#message_id': 'message_id',
                '#last_status_update': 'last_status_update',
                '#updated_at': 'updated_at',
              },
              ExpressionAttributeValues: {
                ':status': updateFields.status,
                ':errorReason': updateFields.error_reason,
                ':errorCode': updateFields.error_code,
                ':messageId': updateFields.message_id,
                ':lastStatusUpdate': updateFields.last_status_update,
                ':updatedAt': updateFields.updated_at,
              },
            })
          );

          return { success: true, updated: true };
        }
      } catch (error) {
        console.error('Error scanning campaign detail:', error);
      }
    }

    return this.insertCampaignDetail(campaignDetail);
  }

  // Get campaign history for a specific store
  async getCampaignHistory(storeId) {
    try {
      const command = new QueryCommand({
        TableName: CAMPAIGN_TABLE_NAME,
        KeyConditionExpression: 'store_id = :storeId',
        ExpressionAttributeValues: {
          ':storeId': storeId,
        },
        ScanIndexForward: false, // Sort by sent_at in descending order (newest first)
      });

      const result = await docClient.send(command);

      return result.Items.map((item) => ({
        campaignName: item.campaign_name,
        templateName: item.template_name || null,
        templateLanguage: item.template_language || null,
        message: item.message || null,
        customerPhone: item.customer_phone,
        customerName: item.customer_name,
        sentDate: item.sent_at,
        status: item.status,
        messageId: item.message_id || null,
        lastStatusUpdate: item.last_status_update || item.sent_at,
        campaignId: item.campaign_id || null,
        campaign_id: item.campaign_id || null,
        header_image_s3_key: item.header_image_s3_key || null,
        resend_enabled: item.resend_enabled ?? null,
        resend_delay_option: item.resend_delay_option || null,
        errorReason: item.error_reason || null,
        errorCode: item.error_code ?? null,
      }));
    } catch (error) {
      console.error('Error fetching campaign history:', error);
      throw error;
    }
  }

  async getCampaignMetadataById(campaignId, storeId = null) {
    if (!campaignId) {
      return null;
    }

    if (CAMPAIGN_METADATA_TABLE) {
      try {
        const result = await docClient.send(
          new GetCommand({
            TableName: CAMPAIGN_METADATA_TABLE,
            Key: { campaign_id: campaignId },
          })
        );
        const item = result.Item || null;
        if (item && (!storeId || item.store_id === storeId)) {
          return {
            campaign_id: item.campaign_id || null,
            store_id: item.store_id || null,
            campaign_name: item.campaign_name || null,
            template_name: item.template_name || null,
            template_language: item.template_language || null,
            template_parameters: item.template_parameters || null,
            message: item.message || null,
            send_mode: item.send_mode || null,
            header_image_s3_key: item.header_image_s3_key || null,
            header_media_id: item.header_media_id || null,
            resend_enabled: item.resend_enabled ?? null,
            resend_delay_option: item.resend_delay_option || null,
          };
        }
      } catch (error) {
        console.error('Error loading campaign metadata table:', error);
      }
    }

    if (!CAMPAIGN_TABLE_NAME) {
      return null;
    }

    const expressionAttributeNames = {
      '#campaign_id': 'campaign_id',
    };
    const expressionAttributeValues = {
      ':campaignId': campaignId,
    };
    const queryBase = {
      TableName: CAMPAIGN_TABLE_NAME,
      IndexName: CAMPAIGN_ID_SENT_AT_INDEX,
      KeyConditionExpression: '#campaign_id = :campaignId',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ScanIndexForward: true,
    };

    if (storeId) {
      expressionAttributeNames['#store_id'] = 'store_id';
      expressionAttributeValues[':storeId'] = storeId;
      queryBase.FilterExpression = '#store_id = :storeId';
    }

    let lastEvaluatedKey = undefined;
    do {
      const result = await docClient.send(
        new QueryCommand({
          ...queryBase,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      const items = Array.isArray(result.Items) ? result.Items : [];
      const match = storeId ? items.find((item) => item.store_id === storeId) : items[0];
      if (match) {
        return {
          campaign_id: match.campaign_id || null,
          store_id: match.store_id || null,
          campaign_name: match.campaign_name || null,
          template_name: match.template_name || null,
          template_language: match.template_language || null,
          template_parameters: match.template_parameters || null,
          message: match.message || null,
          send_mode: match.send_mode || null,
          header_image_s3_key: match.header_image_s3_key || null,
          resend_enabled: match.resend_enabled ?? null,
          resend_delay_option: match.resend_delay_option || null,
        };
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return null;
  }

  async updateCampaignStatusByMessageId(
    messageId,
    status,
    timestamp = new Date().toISOString(),
    errorInfo = null
  ) {
    if (!messageId || !status) return;

    try {
      const items = await scanAll({
        TableName: CAMPAIGN_TABLE_NAME,
        FilterExpression: 'message_id = :messageId',
        ExpressionAttributeValues: {
          ':messageId': messageId,
        },
        ProjectionExpression: 'store_id, sent_at',
      });
      if (!items.length) {
        return;
      }

      await Promise.all(
        items.map((item) => {
          const updateExpressionParts = ['#status = :status', '#updated = :updated'];
          const expressionAttributeNames = {
            '#status': 'status',
            '#updated': 'last_status_update',
          };
          const expressionAttributeValues = {
            ':status': status,
            ':updated': timestamp,
          };

          expressionAttributeNames['#error_reason'] = 'error_reason';
          expressionAttributeNames['#error_code'] = 'error_code';
          updateExpressionParts.push('#error_reason = :errorReason', '#error_code = :errorCode');
          expressionAttributeValues[':errorReason'] =
            errorInfo?.details || errorInfo?.title || null;
          expressionAttributeValues[':errorCode'] = errorInfo?.code ?? null;

          return docClient.send(
            new UpdateCommand({
              TableName: CAMPAIGN_TABLE_NAME,
              Key: {
                store_id: item.store_id,
                sent_at: item.sent_at,
              },
              UpdateExpression: `SET ${updateExpressionParts.join(', ')}`,
              ExpressionAttributeNames: expressionAttributeNames,
              ExpressionAttributeValues: expressionAttributeValues,
            })
          );
        })
      );
    } catch (error) {
      console.error('Error updating campaign status by message ID:', error);
    }
  }

  // Get customer KPIs for a specific store
  async getCustomerKPIs(storeId, timeFilter = 'monthly') {
    try {
      const invoices = await this.getInvoices(storeId, { includeExcluded: false });

      // Parse dates and filter by time period
      const parseInvoiceDate = (dateString) => {
        if (!dateString) return null;

        // Try DD-MM-YYYY HH:mm:ss format first
        let match = dateString.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
        if (match) {
          const [, day, month, year, hour, minute, second] = match;
          return new Date(year, month - 1, day, hour, minute, second);
        }

        // Try other formats...
        match = dateString.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
        if (match) {
          const [, day, month, year] = match;
          return new Date(year, month - 1, day);
        }

        match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
        if (match) {
          const [, day, month, year, hour, minute, second] = match;
          return new Date(year, month - 1, day, hour, minute, second);
        }

        match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (match) {
          const [, day, month, year] = match;
          return new Date(year, month - 1, day);
        }

        match = dateString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
        if (match) {
          const [, day, month, year] = match;
          const fullYear = parseInt(year) + 2000;
          return new Date(fullYear, month - 1, day);
        }

        return null;
      };

      // Filter invoices by time period
      const now = new Date();
      let startDate;

      switch (timeFilter) {
        case 'daily':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'weekly':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'monthly':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'quarterly':
          const quarter = Math.floor(now.getMonth() / 3);
          startDate = new Date(now.getFullYear(), quarter * 3, 1);
          break;
        case 'annually':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      }

      const filteredInvoices = invoices.filter((invoice) => {
        const date = parseInvoiceDate(invoice.invoice_date);
        return date && date >= startDate;
      });

      // Calculate KPIs
      const totalBills = filteredInvoices.length;
      const uniqueCustomers = new Set(filteredInvoices.map((inv) => inv.customer_phone));
      const totalCustomers = uniqueCustomers.size;
      const totalSales = filteredInvoices.reduce((sum, inv) => sum + inv.total_amount, 0);
      const avgBillSpent = totalBills > 0 ? totalSales / totalBills : 0;

      // Calculate new vs returning customers
      const customerCounts = {};
      filteredInvoices.forEach((inv) => {
        customerCounts[inv.customer_phone] = (customerCounts[inv.customer_phone] || 0) + 1;
      });

      const newCustomers = Object.values(customerCounts).filter((count) => count === 1).length;
      const returningCustomers = Object.values(customerCounts).filter((count) => count > 1).length;

      return {
        totalBills,
        totalCustomers,
        totalSales: Math.round(totalSales),
        avgBillSpent: Math.round(avgBillSpent),
        newCustomers,
        returningCustomers,
      };
    } catch (error) {
      console.error('Error fetching customer KPIs:', error);
      throw error;
    }
  }

  // Get customer spend analysis
  async getCustomerSpend(storeId, timeFilter = 'monthly') {
    try {
      const invoices = await this.getInvoices(storeId, { includeExcluded: false });

      // Group by customer and calculate spend
      const customerSpends = {};
      invoices.forEach((invoice) => {
        if (!customerSpends[invoice.customer_phone]) {
          customerSpends[invoice.customer_phone] = {
            totalSpent: 0,
            transactionCount: 0,
          };
        }
        customerSpends[invoice.customer_phone].totalSpent += invoice.total_amount;
        customerSpends[invoice.customer_phone].transactionCount += 1;
      });

      let newCustomerSpend = 0;
      let repeatCustomerSpend = 0;

      Object.values(customerSpends).forEach((customer) => {
        if (customer.transactionCount === 1) {
          newCustomerSpend += customer.totalSpent;
        } else {
          repeatCustomerSpend += customer.totalSpent;
        }
      });

      return {
        newCustomerSpend: Math.round(newCustomerSpend),
        repeatCustomerSpend: Math.round(repeatCustomerSpend),
      };
    } catch (error) {
      console.error('Error fetching customer spend:', error);
      throw error;
    }
  }

  // Get campaign details for a specific customer
  async getCampaignDetailsByCustomer(storeId, customerPhone) {
    try {
      const command = new QueryCommand({
        TableName: CAMPAIGN_TABLE_NAME,
        KeyConditionExpression: 'store_id = :storeId',
        FilterExpression:
          'customer_phone = :customerPhone OR normalized_customer_phone = :customerPhone',
        ExpressionAttributeValues: {
          ':storeId': storeId,
          ':customerPhone': customerPhone,
        },
        ScanIndexForward: false, // Sort by sent_at in descending order (newest first)
      });

      const result = await docClient.send(command);

      return result.Items.map((item) => ({
        campaign_id: item.message_id || `${item.store_id}-${item.sent_at}`,
        campaign_name: item.campaign_name,
        customer_phone: item.customer_phone,
        customer_name: item.customer_name,
        sent_at: item.sent_at,
        status: item.status,
        message_id: item.message_id || null,
        last_status_update: item.last_status_update || item.sent_at,
      }));
    } catch (error) {
      console.error('Error fetching campaign details for customer:', error);
      throw error;
    }
  }

  // Get detailed customer information
  async getCustomerDetails(storeId, customerTypeConfig) {
    try {
      const invoices = await this.getInvoices(storeId, { includeExcluded: false });

      // Group by customer
      const customerMap = new Map();

      invoices.forEach((invoice) => {
        const phone = invoice.customer_phone;
        if (!customerMap.has(phone)) {
          customerMap.set(phone, {
            phone,
            name: invoice.customer_name || `Customer ${phone}`,
            totalSpent: 0,
            transactionCount: 0,
            lastPurchase: invoice.invoice_date,
          });
        }

        const customer = customerMap.get(phone);
        customer.totalSpent += invoice.total_amount;
        customer.transactionCount += 1;

        // Update last purchase if this invoice is more recent
        if (new Date(invoice.invoice_date) > new Date(customer.lastPurchase)) {
          customer.lastPurchase = invoice.invoice_date;
        }
      });

      const resolvedConfig =
        customerTypeConfig ||
        (await this.getStoreCustomerTypeConfig(storeId)) ||
        DEFAULT_CUSTOMER_TYPE_CONFIG;
      // Convert to array and add customer type classification
      const customers = Array.from(customerMap.values()).map((customer) => ({
        phone: customer.phone,
        name: customer.name,
        totalSpent: Math.round(customer.totalSpent),
        customerType: determineCustomerType(customer.totalSpent, resolvedConfig),
        lastPurchase: customer.lastPurchase,
      }));

      // Sort by total spent (descending)
      return customers.sort((a, b) => b.totalSpent - a.totalSpent);
    } catch (error) {
      console.error('Error fetching customer details:', error);
      throw error;
    }
  }

  async getCampaignRecipients(storeId, criteria = {}) {
    const { campaignId, campaignName, templateName, start, end } = criteria || {};

    try {
      const buildResponse = (items = []) => {
        if (!items.length) {
          return {
            campaignName: campaignName || null,
            templateName: templateName || null,
            sentDate: null,
            campaignId: campaignId || null,
            recipients: [],
          };
        }

        const sortedItems = items.sort((a, b) => {
          const aTime = new Date(a.sent_at || 0).getTime();
          const bTime = new Date(b.sent_at || 0).getTime();
          return aTime - bTime;
        });

        const recipients = sortedItems.map((item) => ({
          phone: item.customer_phone || '',
          name: item.customer_name || null,
          status: item.status || 'sent',
          sentDate: item.sent_at || null,
          messageId: item.message_id || null,
          lastStatusUpdate: item.last_status_update || item.sent_at || null,
          error: item.error_reason || null,
          errorCode: item.error_code ?? null,
        }));

        const reference = sortedItems[0] || {};

        return {
          campaignName: reference.campaign_name || campaignName || null,
          templateName: reference.template_name || templateName || null,
          sentDate: reference.sent_at || start || null,
          campaignId: reference.campaign_id || campaignId || null,
          recipients,
        };
      };

      if (campaignId) {
        const expressionAttributeNames = {
          '#campaign_id': 'campaign_id',
          '#store_id': 'store_id',
        };
        const expressionAttributeValues = {
          ':campaignId': campaignId,
          ':storeId': storeId,
        };

        let keyConditionExpression = '#campaign_id = :campaignId';
        if (start && end) {
          keyConditionExpression += ' AND sent_at BETWEEN :start AND :end';
          expressionAttributeValues[':start'] = start;
          expressionAttributeValues[':end'] = end;
        } else if (start) {
          keyConditionExpression += ' AND sent_at >= :start';
          expressionAttributeValues[':start'] = start;
        } else if (end) {
          keyConditionExpression += ' AND sent_at <= :end';
          expressionAttributeValues[':end'] = end;
        }

        const gsiQuery = new QueryCommand({
          TableName: CAMPAIGN_TABLE_NAME,
          IndexName: CAMPAIGN_ID_SENT_AT_INDEX,
          KeyConditionExpression: keyConditionExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          FilterExpression: '#store_id = :storeId',
          ScanIndexForward: true,
        });

        const gsiResult = await docClient.send(gsiQuery);
        if (gsiResult.Items && gsiResult.Items.length > 0) {
          return buildResponse(gsiResult.Items);
        }
        // Fall through to legacy scan if no items found (older campaigns without campaign_id)
      }

      const expressionAttributeValues = {
        ':storeId': storeId,
      };
      let keyConditionExpression = 'store_id = :storeId';

      if (start && end) {
        keyConditionExpression = 'store_id = :storeId AND sent_at BETWEEN :start AND :end';
        expressionAttributeValues[':start'] = start;
        expressionAttributeValues[':end'] = end;
      } else if (start) {
        keyConditionExpression = 'store_id = :storeId AND sent_at >= :start';
        expressionAttributeValues[':start'] = start;
      } else if (end) {
        keyConditionExpression = 'store_id = :storeId AND sent_at <= :end';
        expressionAttributeValues[':end'] = end;
      }

      const expressionAttributeNames = {};
      const filterExpressions = [];

      if (campaignName) {
        expressionAttributeNames['#campaign_name'] = 'campaign_name';
        expressionAttributeValues[':campaignName'] = campaignName;
        filterExpressions.push('#campaign_name = :campaignName');
      }

      if (templateName) {
        expressionAttributeNames['#template_name'] = 'template_name';
        expressionAttributeValues[':templateName'] = templateName;
        filterExpressions.push('#template_name = :templateName');
      }

      if (campaignId) {
        expressionAttributeNames['#campaign_id'] = 'campaign_id';
        expressionAttributeValues[':campaignId'] = campaignId;
        filterExpressions.push('#campaign_id = :campaignId');
      }

      const queryBase = {
        TableName: CAMPAIGN_TABLE_NAME,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        ScanIndexForward: true,
      };

      if (filterExpressions.length > 0) {
        queryBase.FilterExpression = filterExpressions.join(' AND ');
        queryBase.ExpressionAttributeNames = expressionAttributeNames;
      }

      const items = [];
      let lastEvaluatedKey = undefined;

      do {
        const command = new QueryCommand({
          ...queryBase,
          ExclusiveStartKey: lastEvaluatedKey,
        });
        const result = await docClient.send(command);
        if (result.Items) {
          items.push(...result.Items);
        }
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      return buildResponse(items);
    } catch (error) {
      console.error('Error fetching campaign recipients:', error);
      throw error;
    }
  }

  async getStoreMetadata() {
    if (!STORE_CONFIG_TABLE) {
      return {};
    }
    try {
      let franchiseTrialMap = {};
      if (FRANCHISES_TABLE) {
        try {
          const franchiseItems = await scanAll({
            TableName: FRANCHISES_TABLE,
            ProjectionExpression: '#franchise_id, trial_start, trial_end',
            ExpressionAttributeNames: {
              '#franchise_id': 'franchise_id',
            },
          });
          franchiseItems.forEach((item) => {
            const franchiseId = item.franchise_id ? String(item.franchise_id).trim() : null;
            if (!franchiseId) {
              return;
            }
            franchiseTrialMap[franchiseId] = {
              trial_start: item.trial_start || null,
              trial_end: item.trial_end || null,
            };
          });
        } catch (error) {
          console.error('Error loading franchise trial metadata:', error);
        }
      }

      const items = await scanAll({
        TableName: STORE_CONFIG_TABLE,
        ProjectionExpression:
          '#store_id, store_name, brand_name, franchise_name, franchise_id, city, store_city, location_city, trial_period, trial_started, smart_ebill',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
      });
      const map = {};
      items.forEach((item) => {
        const storeId = normalizeStoreIdValue(item.store_id);
        if (!storeId) {
          return;
        }
        const franchiseId = item.franchise_id || null;
        const franchiseTrial = franchiseId ? franchiseTrialMap[franchiseId] : null;
        let trialStarted = item.trial_started ?? null;
        let trialPeriod = item.trial_period ?? null;
        if (franchiseTrial?.trial_start && franchiseTrial?.trial_end) {
          const start = dayjs(franchiseTrial.trial_start);
          const end = dayjs(franchiseTrial.trial_end);
          if (start.isValid() && end.isValid()) {
            const diffDays = end.diff(start, 'day');
            trialStarted = franchiseTrial.trial_start;
            trialPeriod = diffDays >= 0 ? diffDays : null;
          }
        }
        map[storeId] = {
          store_name: item.store_name || item.brand_name || null,
          brand_name: item.brand_name || null,
          franchise_id: franchiseId,
          franchise_name: item.franchise_name || item.brand_name || null,
          city: item.city || item.store_city || item.location_city || null,
          smart_ebill: item.smart_ebill ?? null,
          trial_period: trialPeriod,
          trial_started: trialStarted,
        };
      });
      return map;
    } catch (error) {
      console.error('Error loading store metadata:', error);
      return {};
    }
  }

  async countCampaignsByStore(rangeParam = 'today', customStart, customEnd) {
    if (!CAMPAIGN_TABLE_NAME) {
      return {};
    }
    try {
      const dateRange = this.buildDateRange(rangeParam, customStart, customEnd);
      const startTime = dateRange?.start ? dateRange.start.getTime() : null;
      const endTime = dateRange?.end ? dateRange.end.getTime() : null;
      const items = await scanAll({
        TableName: CAMPAIGN_TABLE_NAME,
        ProjectionExpression: '#store_id, sent_at, campaign_id, campaign_name',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
      });
      const counts = {};
      const campaignKeysByStore = new Map();
      items.forEach((item) => {
        const timestamp = this.parseGenericTimestamp(item.sent_at);
        if (!timestamp) {
          return;
        }
        const value = timestamp.getTime();
        if (startTime !== null && value < startTime) {
          return;
        }
        if (endTime !== null && value > endTime) {
          return;
        }
        const storeId = normalizeStoreIdValue(item.store_id);
        if (!storeId) {
          return;
        }
        const campaignId = item.campaign_id || item.campaignId || null;
        const campaignName = item.campaign_name || item.campaignName || 'Untitled Campaign';
        const sentAtRaw = item.sent_at || timestamp.toISOString();
        const campaignKey = campaignId ? String(campaignId) : `${campaignName}-${sentAtRaw}`;

        if (!campaignKeysByStore.has(storeId)) {
          campaignKeysByStore.set(storeId, new Set());
        }
        campaignKeysByStore.get(storeId).add(campaignKey);
      });
      campaignKeysByStore.forEach((keys, storeId) => {
        counts[storeId] = keys.size;
      });
      return counts;
    } catch (error) {
      console.error('Error counting campaigns by store:', error);
      return {};
    }
  }

  async countMessagesByStore(rangeParam = 'today', customStart, customEnd) {
    if (!CAMPAIGN_TABLE_NAME) {
      return {};
    }
    try {
      const dateRange = this.buildDateRange(rangeParam, customStart, customEnd);
      const startTime = dateRange?.start ? dateRange.start.getTime() : null;
      const endTime = dateRange?.end ? dateRange.end.getTime() : null;
      const items = await scanAll({
        TableName: CAMPAIGN_TABLE_NAME,
        ProjectionExpression: '#store_id, sent_at',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
      });
      const counts = {};
      items.forEach((item) => {
        const timestamp = this.parseGenericTimestamp(item.sent_at);
        if (!timestamp) {
          return;
        }
        const value = timestamp.getTime();
        if (startTime !== null && value < startTime) {
          return;
        }
        if (endTime !== null && value > endTime) {
          return;
        }
        const storeId = normalizeStoreIdValue(item.store_id);
        if (!storeId) {
          return;
        }
        counts[storeId] = (counts[storeId] || 0) + 1;
      });
      return counts;
    } catch (error) {
      console.error('Error counting messages by store:', error);
      return {};
    }
  }

  async computeCampaignStatsByStore(rangeParam = 'today', customStart, customEnd) {
    if (!CAMPAIGN_TABLE_NAME) {
      return { campaignCounts: {}, messageCounts: {} };
    }
    try {
      const dateRange = this.buildDateRange(rangeParam, customStart, customEnd);
      const startTime = dateRange?.start ? dateRange.start.getTime() : null;
      const endTime = dateRange?.end ? dateRange.end.getTime() : null;
      const items = await scanAll({
        TableName: CAMPAIGN_TABLE_NAME,
        ProjectionExpression: '#store_id, sent_at, campaign_id, campaign_name',
        ExpressionAttributeNames: {
          '#store_id': 'store_id',
        },
      });

      const campaignCounts = {};
      const messageCounts = {};
      const campaignKeysByStore = new Map();

      items.forEach((item) => {
        const timestamp = this.parseGenericTimestamp(item.sent_at);
        if (!timestamp) {
          return;
        }
        const value = timestamp.getTime();
        if (startTime !== null && value < startTime) {
          return;
        }
        if (endTime !== null && value > endTime) {
          return;
        }
        const storeId = normalizeStoreIdValue(item.store_id);
        if (!storeId) {
          return;
        }

        messageCounts[storeId] = (messageCounts[storeId] || 0) + 1;

        const campaignId = item.campaign_id || item.campaignId || null;
        const campaignName = item.campaign_name || item.campaignName || 'Untitled Campaign';
        const sentAtRaw = item.sent_at || timestamp.toISOString();
        const campaignKey = campaignId ? String(campaignId) : `${campaignName}-${sentAtRaw}`;

        if (!campaignKeysByStore.has(storeId)) {
          campaignKeysByStore.set(storeId, new Set());
        }
        campaignKeysByStore.get(storeId).add(campaignKey);
      });

      campaignKeysByStore.forEach((keys, storeId) => {
        campaignCounts[storeId] = keys.size;
      });

      return { campaignCounts, messageCounts };
    } catch (error) {
      console.error('Error computing campaign stats by store:', error);
      return { campaignCounts: {}, messageCounts: {} };
    }
  }

  buildDateRange(rangeParam = 'today', customStart, customEnd) {
    return buildDateRangeInternal(rangeParam, customStart, customEnd);
  }

  filterInvoicesByRange(invoices, dateRange) {
    return filterInvoicesByRangeInternal(invoices, dateRange);
  }

  aggregateInvoicesByStore(invoices) {
    return aggregateInvoicesByStoreInternal(invoices);
  }

  parseGenericTimestamp(value) {
    return parseGenericTimestamp(value);
  }

  async computeInvoiceMetrics(rangeParam = 'today', customStart, customEnd) {
    const dateRange = this.buildDateRange(rangeParam, customStart, customEnd);
    const allInvoices = await this.getAllInvoicesNormalized();
    const filtered = this.filterInvoicesByRange(allInvoices, dateRange);
    const metricsByStore = this.aggregateInvoicesByStore(filtered);
    return { dateRange, metricsByStore, invoices: filtered, allInvoices };
  }

  async computeInvoiceMetricsOptimized(
    rangeParam = 'today',
    customStart,
    customEnd,
    storeIds = []
  ) {
    const dateRange = this.buildDateRange(rangeParam, customStart, customEnd);
    if (rangeParam === 'all' || !dateRange?.start || !dateRange?.end || storeIds.length === 0) {
      return this.computeInvoiceMetrics(rangeParam, customStart, customEnd);
    }

    const startIso = formatRangeBoundaryForIndex(dateRange.start);
    const endIso = formatRangeBoundaryForIndex(dateRange.end);
    if (!startIso || !endIso) {
      return this.computeInvoiceMetrics(rangeParam, customStart, customEnd);
    }

    const chunkSize = 10;
    const batches = [];
    for (let i = 0; i < storeIds.length; i += chunkSize) {
      batches.push(storeIds.slice(i, i + chunkSize));
    }

    const invoices = [];
    for (const batch of batches) {
      const results = await Promise.all(
        batch.map((storeId) => this.getInvoicesByStoreRange(storeId, startIso, endIso))
      );
      results.forEach((items) => invoices.push(...items));
    }

    const metricsByStore = this.aggregateInvoicesByStore(invoices);
    return { dateRange, metricsByStore, invoices, allInvoices: [] };
  }

  async computeStoreInvoiceMetrics(storeId, rangeParam = 'today', customStart, customEnd) {
    const { dateRange, metricsByStore } = await this.computeInvoiceMetrics(
      rangeParam,
      customStart,
      customEnd
    );
    const storeMetrics = metricsByStore[storeId] || {
      revenue: 0,
      invoices: 0,
      eBillCustomers: 0,
      anonymousCustomers: 0,
      avgItemsPerOrder: null,
      discountRate: null,
    };
    return {
      dateRange,
      totalInvoices: storeMetrics.invoices,
      revenue: storeMetrics.revenue,
      eBillCustomers: storeMetrics.eBillCustomers,
      anonymousCustomers: storeMetrics.anonymousCustomers,
    };
  }

  getInvoiceCustomerKey(invoice) {
    return getInvoiceCustomerKey(invoice);
  }

  normalizeStoreId(value) {
    return normalizeStoreIdValue(value);
  }

  getInvoiceTimestampIst(invoice) {
    const parsed = getInvoiceTimestampIstInternal(invoice);
    return parsed ? parsed.toDate() : null;
  }
}

module.exports = new AnalyticsService();
