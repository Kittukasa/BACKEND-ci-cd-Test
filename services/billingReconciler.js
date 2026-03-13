const { QueryCommand, ScanCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('../config/dynamodb');
const { logger } = require('../config/logger');
const analyticsService = require('./analyticsService');
const billingService = require('./billingService');

const INVOICES_TABLE = process.env.DYNAMODB_TABLE;
const CAMPAIGN_TABLE_NAME = process.env.CAMPAIGN_TABLE_NAME;
const WALLET_TABLE = process.env.FRANCHISE_WALLET_TABLE || 'Test-Franchise_Wallets';
const WALLET_EVENTS_TABLE = process.env.WALLET_EVENTS_TABLE || 'Test-Wallet_Events';
const DEFAULT_STORE_SCOPE = 'ALL';
const BILLING_LOOKBACK_DAYS = Math.max(
  1,
  parseInt(process.env.BILLING_RECONCILE_LOOKBACK_DAYS || '7', 10)
);
const BILLING_DEBUG = process.env.BILLING_DEBUG === 'true';

const ANONYMOUS_PHONE = '0000000000';
const normalizePhoneDigits = (value) => (value || '').toString().replace(/\D/g, '');
const isEbillInvoice = (invoice) => {
  const digits = normalizePhoneDigits(invoice?.customer_phone);
  return digits !== ANONYMOUS_PHONE;
};

const toIso = (value) => (value instanceof Date ? value.toISOString() : value || null);

const scanAll = async (params) => {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await docClient.send(
      new ScanCommand({
        ...params,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );
    if (result.Items) {
      items.push(...result.Items);
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return items;
};

const queryEventsBySource = async (franchiseId, sourceId, usageType) => {
  if (!WALLET_EVENTS_TABLE || !franchiseId || !sourceId) {
    return false;
  }
  let lastEvaluatedKey;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: WALLET_EVENTS_TABLE,
        KeyConditionExpression: 'franchise_id = :fid',
        ExpressionAttributeValues: {
          ':fid': franchiseId,
          ':sourceId': sourceId,
          ':usageType': usageType,
        },
        ExpressionAttributeNames: {
          '#source_id': 'source_id',
          '#usage_type': 'usage_type',
        },
        FilterExpression: '#source_id = :sourceId AND #usage_type = :usageType',
        ExclusiveStartKey: lastEvaluatedKey,
        Limit: 100,
      })
    );
    if (Array.isArray(result.Items) && result.Items.length > 0) {
      return true;
    }
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return false;
};

const loadFranchiseWallets = async () => {
  const items = await scanAll({
    TableName: WALLET_TABLE,
    FilterExpression: 'store_id = :storeScope',
    ExpressionAttributeValues: {
      ':storeScope': DEFAULT_STORE_SCOPE,
    },
    ProjectionExpression:
      'franchise_id, store_id, last_ebill_reconcile_at, last_campaign_reconcile_at',
  });
  return items.map((item) => ({
    franchiseId: item.franchise_id,
    lastEbillReconcileAt: item.last_ebill_reconcile_at || null,
    lastCampaignReconcileAt: item.last_campaign_reconcile_at || null,
  }));
};

const loadStoreFranchiseMap = async () => {
  const metadata = await analyticsService.getStoreMetadata();
  const map = new Map();
  Object.entries(metadata).forEach(([storeId, info]) => {
    const franchiseId = info?.franchise_id || null;
    if (storeId && franchiseId) {
      map.set(String(storeId), {
        franchiseId: String(franchiseId),
        smartEbill:
          info?.smart_ebill === true || info?.smart_ebill === 'true' || info?.smart_ebill === 1,
      });
    }
  });
  return map;
};

const resolveStartTime = (lastCheckpoint) => {
  if (lastCheckpoint) {
    const parsed = new Date(lastCheckpoint);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  const now = new Date();
  now.setDate(now.getDate() - BILLING_LOOKBACK_DAYS);
  return now;
};

const updateWalletCheckpoint = async (franchiseId, fields) => {
  const expressionParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':updated': new Date().toISOString(),
  };

  Object.entries(fields).forEach(([key, value], index) => {
    const nameKey = `#field${index}`;
    const valueKey = `:value${index}`;
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = value;
    expressionParts.push(`${nameKey} = ${valueKey}`);
  });

  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionParts.push('#updated_at = :updated');

  await docClient.send(
    new UpdateCommand({
      TableName: WALLET_TABLE,
      Key: {
        franchise_id: franchiseId,
        store_id: DEFAULT_STORE_SCOPE,
      },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
};

const reconcileEbillInvoices = async (franchiseId, storeMap, checkpoint) => {
  if (!INVOICES_TABLE) {
    return { processed: 0 };
  }
  const startTime = resolveStartTime(checkpoint);
  const items = await scanAll({
    TableName: INVOICES_TABLE,
    ProjectionExpression:
      'store_id, invoice_id, invoice_no, invoice_date, processed_timestamp_ist, processed_iso_ist, customer_phone, created_at',
  });

  let processed = 0;
  let latestTimestamp = startTime;

  for (const invoice of items) {
    const storeId = invoice.store_id;
    if (!storeId) {
      continue;
    }
    const mapping = storeMap.get(String(storeId));
    const mappedFranchiseId = mapping?.franchiseId || null;
    if (mappedFranchiseId !== franchiseId) {
      continue;
    }

    const timestamp = analyticsService.getInvoiceTimestampIst(invoice);
    if (!timestamp) {
      continue;
    }
    if (timestamp <= startTime) {
      continue;
    }

    if (!isEbillInvoice(invoice)) {
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
      }
      continue;
    }

    const sourceId =
      invoice.invoice_id || invoice.invoice_no || `calc:${storeId}-${toIso(timestamp)}`;

    const usageType = mapping?.smartEbill ? 'smart_ebill_invoice' : 'ebill_invoice';
    const alreadyBilled =
      (await queryEventsBySource(franchiseId, sourceId, 'ebill_invoice')) ||
      (await queryEventsBySource(franchiseId, sourceId, 'smart_ebill_invoice'));
    if (alreadyBilled) {
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
      }
      continue;
    }

    await billingService.recordUsage({
      franchiseId,
      storeId,
      usageType,
      sourceId,
      quantity: 1,
    });
    processed += 1;
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }

  return { processed, latestTimestamp };
};

const reconcileDeliveredCampaigns = async (franchiseId, storeMap, checkpoint) => {
  if (!CAMPAIGN_TABLE_NAME) {
    return { processed: 0 };
  }
  const startTime = resolveStartTime(checkpoint);
  const items = await scanAll({
    TableName: CAMPAIGN_TABLE_NAME,
    ProjectionExpression: 'store_id, sent_at, message_id, #status, last_status_update',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
  });

  let processed = 0;
  let latestTimestamp = startTime;

  for (const item of items) {
    const storeId = item.store_id;
    if (!storeId) {
      continue;
    }
    const mappedFranchiseId = storeMap.get(String(storeId));
    if (mappedFranchiseId !== franchiseId) {
      continue;
    }

    const status = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    if (status !== 'delivered') {
      continue;
    }

    const statusTimestampRaw = item.last_status_update || item.sent_at;
    const statusTimestamp = analyticsService.parseGenericTimestamp(statusTimestampRaw);
    if (!statusTimestamp) {
      continue;
    }
    if (statusTimestamp <= startTime) {
      continue;
    }

    const sourceId = item.message_id || `${storeId}-${statusTimestamp.toISOString()}`;
    const alreadyBilled = await queryEventsBySource(franchiseId, sourceId, 'campaign_message');
    if (alreadyBilled) {
      if (statusTimestamp > latestTimestamp) {
        latestTimestamp = statusTimestamp;
      }
      continue;
    }

    await billingService.recordUsage({
      franchiseId,
      storeId,
      usageType: 'campaign_message',
      sourceId,
      quantity: 1,
    });
    processed += 1;
    if (statusTimestamp > latestTimestamp) {
      latestTimestamp = statusTimestamp;
    }
  }

  return { processed, latestTimestamp };
};

const reconcileAll = async () => {
  try {
    const wallets = await loadFranchiseWallets();
    if (!wallets.length) {
      return;
    }
    const storeMap = await loadStoreFranchiseMap();

    for (const wallet of wallets) {
      const franchiseId = wallet.franchiseId;
      if (!franchiseId) {
        continue;
      }

      const invoiceResult = await reconcileEbillInvoices(
        franchiseId,
        storeMap,
        wallet.lastEbillReconcileAt
      );
      const campaignResult = await reconcileDeliveredCampaigns(
        franchiseId,
        storeMap,
        wallet.lastCampaignReconcileAt
      );

      await updateWalletCheckpoint(franchiseId, {
        last_ebill_reconcile_at: toIso(invoiceResult.latestTimestamp) || toIso(new Date()),
        last_campaign_reconcile_at: toIso(campaignResult.latestTimestamp) || toIso(new Date()),
      });

      if (BILLING_DEBUG) {
        logger.info('Billing reconciliation completed', {
          franchiseId,
          ebillProcessed: invoiceResult.processed,
          campaignProcessed: campaignResult.processed,
        });
      }
    }
  } catch (error) {
    logger.error('Billing reconciliation failed', { error: error.message });
  }
};

module.exports = {
  reconcileAll,
};
