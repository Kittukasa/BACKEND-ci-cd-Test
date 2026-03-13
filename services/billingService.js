const { GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('crypto');
const { docClient } = require('../config/dynamodb');
const { logger } = require('../config/logger');

const WALLET_TABLE = process.env.FRANCHISE_WALLET_TABLE || 'Test-Franchise_Wallets';
const WALLET_EVENTS_TABLE = process.env.WALLET_EVENTS_TABLE || 'Test-Wallet_Events';
const WALLET_EVENTS_SORT_KEY = process.env.WALLET_EVENTS_SORT_KEY || 'timestamp#event_id';
const BILLING_DEBUG = process.env.BILLING_DEBUG === 'true';
const STORE_CONFIG_TABLE = process.env.STORE_WHATSAPP_CONFIG_TABLE;

const DEFAULT_CURRENCY = 'INR';
const DEFAULT_STORE_SCOPE = 'ALL';

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeId = (value) => (value === null || value === undefined ? '' : value.toString().trim());

const buildWalletDefaults = () => ({
  balance: 0,
  currency: DEFAULT_CURRENCY,
  min_balance: 0,
  low_balance_threshold: 0,
  pricing_ebill_invoice: 0,
  pricing_smart_ebill: 0,
  pricing_campaign_message: 0,
  updated_at: new Date().toISOString()
});

async function getWalletItem(franchiseId, storeId) {
  if (!WALLET_TABLE || !franchiseId || !storeId) {
    return null;
  }
  try {
    const response = await docClient.send(
      new GetCommand({
        TableName: WALLET_TABLE,
        Key: {
          franchise_id: franchiseId,
          store_id: storeId
        }
      })
    );
    return response.Item || null;
  } catch (error) {
    logger.error('Failed to load wallet config', {
      franchiseId,
      storeId,
      error: error.message
    });
    return null;
  }
}

async function putWalletItem(franchiseId, storeId, overrides = {}) {
  if (!WALLET_TABLE || !franchiseId || !storeId) {
    return null;
  }
  const now = new Date().toISOString();
  const item = {
    franchise_id: franchiseId,
    store_id: storeId,
    ...buildWalletDefaults(),
    ...overrides,
    updated_at: now
  };
  Object.keys(item).forEach((key) => {
    if (item[key] === undefined) {
      delete item[key];
    }
  });
  try {
    await docClient.send(
      new PutCommand({
        TableName: WALLET_TABLE,
        Item: item
      })
    );
    return item;
  } catch (error) {
    logger.error('Failed to create wallet config', {
      franchiseId,
      storeId,
      error: error.message
    });
    return null;
  }
}

async function ensureFranchiseWallet(franchiseId) {
  const normalizedFranchiseId = normalizeId(franchiseId);
  if (!normalizedFranchiseId) {
    return null;
  }
  const existing = await getWalletItem(normalizedFranchiseId, DEFAULT_STORE_SCOPE);
  if (existing) {
    return existing;
  }
  return await putWalletItem(normalizedFranchiseId, DEFAULT_STORE_SCOPE);
}

async function resolvePricing(franchiseId, storeId) {
  const normalizedFranchiseId = normalizeId(franchiseId);
  const normalizedStoreId = normalizeId(storeId);
  if (!normalizedFranchiseId) {
    return null;
  }
  let config = null;
  if (normalizedStoreId) {
    config = await getWalletItem(normalizedFranchiseId, normalizedStoreId);
  }
  if (config) {
    return config;
  }
  return await ensureFranchiseWallet(normalizedFranchiseId);
}

async function getStoreConfigById(storeId) {
  if (!STORE_CONFIG_TABLE || !storeId) {
    return null;
  }
  try {
    const response = await docClient.send(
      new GetCommand({
        TableName: STORE_CONFIG_TABLE,
        Key: { store_id: storeId }
      })
    );
    return response.Item || null;
  } catch (error) {
    logger.error('Failed to load store config for billing', {
      storeId,
      error: error.message
    });
    return null;
  }
}

const resolveFranchiseIdFromConfig = (config) => {
  if (!config) {
    return null;
  }
  return normalizeId(config.franchise_id || config.franchiseId || '');
};

async function getFranchiseIdForStore(storeId) {
  const normalizedStoreId = normalizeId(storeId);
  if (!normalizedStoreId) {
    return null;
  }
  const config = await getStoreConfigById(normalizedStoreId);
  const franchiseId = resolveFranchiseIdFromConfig(config);
  return franchiseId || null;
}

function pickUnitPrice(config, usageType) {
  if (!config) {
    return 0;
  }
  if (usageType === 'ebill_invoice') {
    return toNumber(config.pricing_ebill_invoice);
  }
  if (usageType === 'smart_ebill_invoice') {
    return toNumber(config.pricing_smart_ebill);
  }
  if (usageType === 'campaign_message') {
    return toNumber(config.pricing_campaign_message);
  }
  return 0;
}

async function updateWalletBalance(franchiseId, balance) {
  if (!WALLET_TABLE || !franchiseId) {
    return;
  }
  const now = new Date().toISOString();
  await docClient.send(
    new UpdateCommand({
      TableName: WALLET_TABLE,
      Key: {
        franchise_id: franchiseId,
        store_id: DEFAULT_STORE_SCOPE
      },
      UpdateExpression: 'SET #balance = :balance, #updated_at = :updated_at',
      ExpressionAttributeNames: {
        '#balance': 'balance',
        '#updated_at': 'updated_at'
      },
      ExpressionAttributeValues: {
        ':balance': balance,
        ':updated_at': now
      }
    })
  );
}

async function addWalletBalance(franchiseId, amount) {
  if (!WALLET_TABLE || !franchiseId || amount === 0) {
    return null;
  }
  const now = new Date().toISOString();
  const response = await docClient.send(
    new UpdateCommand({
      TableName: WALLET_TABLE,
      Key: {
        franchise_id: franchiseId,
        store_id: DEFAULT_STORE_SCOPE
      },
      UpdateExpression:
        'SET #balance = if_not_exists(#balance, :zero) + :amount, #updated_at = :updated_at',
      ExpressionAttributeNames: {
        '#balance': 'balance',
        '#updated_at': 'updated_at'
      },
      ExpressionAttributeValues: {
        ':amount': amount,
        ':zero': 0,
        ':updated_at': now
      },
      ReturnValues: 'UPDATED_NEW'
    })
  );
  return toNumber(response?.Attributes?.balance);
}

async function logWalletEvent(franchiseId, payload) {
  if (!WALLET_EVENTS_TABLE || !franchiseId) {
    if (BILLING_DEBUG) {
      logger.warn('Wallet events table not configured', {
        franchiseId,
        tableName: WALLET_EVENTS_TABLE || null
      });
    }
    return;
  }
  const now = new Date().toISOString();
  const eventId = randomUUID();
  const item = {
    franchise_id: franchiseId,
    event_id: eventId,
    timestamp: payload.timestamp || now,
    ...payload
  };
  item[WALLET_EVENTS_SORT_KEY] = `${item.timestamp}#${eventId}`;
  await docClient.send(
    new PutCommand({
      TableName: WALLET_EVENTS_TABLE,
      Item: {
        franchise_id: item.franchise_id,
        [WALLET_EVENTS_SORT_KEY]: item[WALLET_EVENTS_SORT_KEY],
        ...item
      }
    })
  );
}

async function recordUsage({
  franchiseId,
  storeId,
  usageType,
  quantity = 1,
  sourceId = null,
  storeConfig = null
}) {
  const normalizedStoreId = normalizeId(storeId);
  let normalizedFranchiseId = normalizeId(franchiseId);

  if (!normalizedFranchiseId && storeConfig) {
    normalizedFranchiseId = resolveFranchiseIdFromConfig(storeConfig);
  }

  if (!normalizedFranchiseId && normalizedStoreId) {
    normalizedFranchiseId = await getFranchiseIdForStore(normalizedStoreId);
  }

  if (!normalizedFranchiseId) {
    logger.warn('Skipping billing; franchise_id missing', { storeId, usageType });
    return { skipped: true, reason: 'missing_franchise' };
  }

  const pricingConfig = await resolvePricing(normalizedFranchiseId, normalizedStoreId);
  const unitPrice = pickUnitPrice(pricingConfig, usageType);
  const amount = unitPrice * toNumber(quantity);

  const wallet = await ensureFranchiseWallet(normalizedFranchiseId);
  const currentBalance = toNumber(wallet?.balance);
  const newBalance = amount > 0 ? currentBalance - amount : currentBalance;
  const now = new Date().toISOString();
  const currency = pricingConfig?.currency || wallet?.currency || DEFAULT_CURRENCY;

  try {
    if (amount <= 0) {
      if (BILLING_DEBUG) {
        logger.info('Skipping wallet debit (zero amount)', {
          franchiseId: normalizedFranchiseId,
          storeId: normalizedStoreId,
          usageType,
          unitPrice,
          quantity: toNumber(quantity)
        });
      }
      return { skipped: true, reason: 'zero_amount' };
    }
    if (amount > 0) {
      await updateWalletBalance(normalizedFranchiseId, newBalance);
    }
    await logWalletEvent(normalizedFranchiseId, {
      type: 'debit',
      usage_type: usageType,
      amount,
      unit_price: unitPrice,
      quantity: toNumber(quantity),
      balance_after: newBalance,
      store_id: normalizedStoreId || null,
      source_id: sourceId,
      currency,
      timestamp: now
    });
    if (BILLING_DEBUG) {
      logger.info('Wallet usage recorded', {
        franchiseId: normalizedFranchiseId,
        storeId: normalizedStoreId,
        usageType,
        amount,
        unitPrice,
        balanceAfter: newBalance,
        walletTable: WALLET_TABLE,
        eventsTable: WALLET_EVENTS_TABLE,
        eventsSortKey: WALLET_EVENTS_SORT_KEY
      });
    }
  } catch (error) {
    logger.error('Failed to record wallet debit', {
      franchiseId: normalizedFranchiseId,
      storeId: normalizedStoreId,
      usageType,
      error: error.message
    });
    return { skipped: false, error: error.message };
  }

  const minBalance = toNumber(wallet?.min_balance);
  const lowThreshold = toNumber(wallet?.low_balance_threshold);
  const threshold = lowThreshold > 0 ? lowThreshold : minBalance;
  if (threshold > 0 && newBalance <= threshold) {
    logger.warn('Low wallet balance threshold reached', {
      franchiseId: normalizedFranchiseId,
      storeId: normalizedStoreId || null,
      usageType,
      balance: newBalance,
      threshold
    });
  }

  return { skipped: false, balance: newBalance, amount };
}

async function creditWallet({ franchiseId, amount, sourceId, reason = 'wallet_topup', metadata = {} }) {
  const normalizedFranchiseId = normalizeId(franchiseId);
  const topupAmount = toNumber(amount);
  if (!normalizedFranchiseId) {
    logger.warn('Skipping wallet credit; franchise_id missing', { franchiseId });
    return { skipped: true, reason: 'missing_franchise' };
  }
  if (topupAmount <= 0) {
    if (BILLING_DEBUG) {
      logger.info('Skipping wallet credit (zero amount)', {
        franchiseId: normalizedFranchiseId,
        amount: topupAmount
      });
    }
    return { skipped: true, reason: 'zero_amount' };
  }

  const wallet = await ensureFranchiseWallet(normalizedFranchiseId);
  const currency = wallet?.currency || DEFAULT_CURRENCY;
  const now = new Date().toISOString();

  try {
    const newBalance = await addWalletBalance(normalizedFranchiseId, topupAmount);
    await logWalletEvent(normalizedFranchiseId, {
      type: 'credit',
      usage_type: reason,
      amount: topupAmount,
      unit_price: topupAmount,
      quantity: 1,
      balance_after: newBalance,
      store_id: DEFAULT_STORE_SCOPE,
      source_id: sourceId || null,
      currency,
      timestamp: now,
      ...metadata
    });
    if (BILLING_DEBUG) {
      logger.info('Wallet credit recorded', {
        franchiseId: normalizedFranchiseId,
        amount: topupAmount,
        balanceAfter: newBalance
      });
    }
    return { skipped: false, balance: newBalance, amount: topupAmount };
  } catch (error) {
    logger.error('Failed to record wallet credit', {
      franchiseId: normalizedFranchiseId,
      amount: topupAmount,
      error: error.message
    });
    return { skipped: false, error: error.message };
  }
}

module.exports = {
  recordUsage,
  getFranchiseIdForStore,
  creditWallet
};
