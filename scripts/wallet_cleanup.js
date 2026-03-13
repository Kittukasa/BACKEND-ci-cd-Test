const { config } = require('dotenv');
const { docClient } = require('../config/dynamodb');
const { ScanCommand, QueryCommand, BatchWriteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

config();

const WALLET_TABLE = process.env.FRANCHISE_WALLET_TABLE || 'Test-Franchise_Wallets';
const WALLET_EVENTS_TABLE = process.env.WALLET_EVENTS_TABLE || 'Test-Wallet_Events';
const WALLET_EVENTS_SORT_KEY = process.env.WALLET_EVENTS_SORT_KEY || 'timestamp#event_id';
const DEFAULT_STORE_SCOPE = 'ALL';

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    mode: 'both',
    apply: false,
    franchiseId: null,
    removeZeroAmount: false
  };

  args.forEach((arg) => {
    if (arg === '--apply') {
      options.apply = true;
      return;
    }
    if (arg === '--dry-run') {
      options.apply = false;
      return;
    }
    if (arg === '--remove-zero') {
      options.removeZeroAmount = true;
      return;
    }
    if (arg.startsWith('--mode=')) {
      options.mode = arg.split('=')[1] || 'both';
      return;
    }
    if (arg.startsWith('--franchise=')) {
      options.franchiseId = arg.split('=')[1] || null;
    }
  });

  return options;
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

const queryAll = async (params) => {
  const items = [];
  let lastEvaluatedKey;
  do {
    const result = await docClient.send(
      new QueryCommand({
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

const getFranchiseWallets = async (franchiseId) => {
  const params = {
    TableName: WALLET_TABLE,
    FilterExpression: 'store_id = :storeScope',
    ExpressionAttributeValues: {
      ':storeScope': DEFAULT_STORE_SCOPE
    }
  };
  if (franchiseId) {
    params.FilterExpression = 'store_id = :storeScope AND franchise_id = :fid';
    params.ExpressionAttributeValues[':fid'] = franchiseId;
  }
  return await scanAll(params);
};

const getFranchiseEvents = async (franchiseId) => {
  return await queryAll({
    TableName: WALLET_EVENTS_TABLE,
    KeyConditionExpression: 'franchise_id = :fid',
    ExpressionAttributeValues: {
      ':fid': franchiseId
    }
  });
};

const chunk = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const dedupeEvents = (events, removeZeroAmount) => {
  const seen = new Map();
  const duplicates = [];
  const zeroAmount = [];

  events.forEach((event) => {
    const usageType = event.usage_type || '';
    const sourceId = event.source_id || '';
    const storeId = event.store_id || '';
    const type = event.type || '';
    const key = `${usageType}||${sourceId}||${storeId}`;

    if (!sourceId) {
      return;
    }

    if (type === 'debit' && removeZeroAmount && Number(event.amount || 0) <= 0) {
      zeroAmount.push(event);
      return;
    }

    if (seen.has(key)) {
      duplicates.push(event);
      return;
    }
    seen.set(key, event);
  });

  return { duplicates, zeroAmount, kept: Array.from(seen.values()) };
};

const deleteEvents = async (franchiseId, events, apply) => {
  if (!events.length) {
    return 0;
  }
  if (!apply) {
    return events.length;
  }
  const batches = chunk(events, 25);
  let deleted = 0;
  for (const batch of batches) {
    const deleteRequests = batch.map((event) => ({
      DeleteRequest: {
        Key: {
          franchise_id: franchiseId,
          [WALLET_EVENTS_SORT_KEY]: event[WALLET_EVENTS_SORT_KEY]
        }
      }
    }));
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [WALLET_EVENTS_TABLE]: deleteRequests
        }
      })
    );
    deleted += batch.length;
  }
  return deleted;
};

const updateWalletBalance = async (franchiseId, balance, apply) => {
  if (!apply) {
    return;
  }
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
        ':updated_at': new Date().toISOString()
      }
    })
  );
};

const pickLatestBalance = (events) => {
  const eventsWithBalance = events.filter((event) => typeof event.balance_after === 'number');
  if (!eventsWithBalance.length) {
    return null;
  }
  const sorted = eventsWithBalance.sort((a, b) => {
    const aTime = new Date(a.timestamp || 0).getTime();
    const bTime = new Date(b.timestamp || 0).getTime();
    if (aTime === bTime) {
      return (a[WALLET_EVENTS_SORT_KEY] || '').localeCompare(b[WALLET_EVENTS_SORT_KEY] || '');
    }
    return bTime - aTime;
  });
  return sorted[0].balance_after;
};

const run = async () => {
  const options = parseArgs();
  const wallets = await getFranchiseWallets(options.franchiseId);
  if (!wallets.length) {
    console.log('No franchise wallets found for cleanup.');
    return;
  }

  let totalDuplicates = 0;
  let totalZeroAmount = 0;
  let totalDeleted = 0;
  let totalZeroDeleted = 0;

  for (const wallet of wallets) {
    const franchiseId = wallet.franchise_id;
    if (!franchiseId) {
      continue;
    }

    const events = await getFranchiseEvents(franchiseId);
    if (!events.length) {
      continue;
    }

    const { duplicates, zeroAmount, kept } = dedupeEvents(events, options.removeZeroAmount);
    totalDuplicates += duplicates.length;
    totalZeroAmount += zeroAmount.length;

    if (options.mode === 'dedupe' || options.mode === 'both') {
      const removed = await deleteEvents(franchiseId, duplicates, options.apply);
      totalDeleted += removed;
    }

    if (options.removeZeroAmount) {
      const removedZero = await deleteEvents(franchiseId, zeroAmount, options.apply);
      totalZeroDeleted += removedZero;
    }

    if (options.mode === 'recalc' || options.mode === 'both') {
      const latestBalance = pickLatestBalance(kept);
      if (latestBalance !== null) {
        await updateWalletBalance(franchiseId, latestBalance, options.apply);
      }
    }

    console.log(
      `[${franchiseId}] events=${events.length} duplicates=${duplicates.length} zeroAmount=${zeroAmount.length} ` +
        `apply=${options.apply ? 'yes' : 'no'}`
    );
  }

  console.log('Summary:', {
    totalDuplicates,
    totalZeroAmount,
    totalDeleted: options.apply ? totalDeleted : 0,
    totalZeroDeleted: options.apply ? totalZeroDeleted : 0,
    mode: options.mode,
    apply: options.apply,
    removeZeroAmount: options.removeZeroAmount
  });
};

run().catch((error) => {
  console.error('Wallet cleanup failed:', error.message);
  process.exit(1);
});
