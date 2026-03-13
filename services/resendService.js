const { docClient } = require('../config/dynamodb');
const { PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const AWS_REGION = process.env.AWS_REGION || 'ap-south-2';
const RESEND_ATTEMPTS_TABLE = process.env.RESEND_ATTEMPTS_TABLE;
const RESEND_RECIPIENTS_TABLE = process.env.RESEND_RECIPIENTS_TABLE;
const CAMPAIGN_METADATA_TABLE = process.env.CAMPAIGN_METADATA_TABLE;
const RESEND_ATTEMPTS_CAMPAIGN_INDEX =
  process.env.RESEND_ATTEMPTS_CAMPAIGN_INDEX || 'campaign_id-created_at-index';
const RESEND_ATTEMPTS_CLIENT_INDEX =
  process.env.RESEND_ATTEMPTS_CLIENT_INDEX || 'client_request_id-index';

const RESEND_IMAGE_BUCKET = process.env.RESEND_CAMPAIGN_BUCKET || 'billbox-frontend';
const RESEND_IMAGE_PREFIX = (() => {
  const raw = process.env.RESEND_CAMPAIGN_PREFIX || 'Re-send_campaign_images/';
  return raw.endsWith('/') ? raw : `${raw}/`;
})();

const RESEND_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const RESEND_IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const s3Client = new S3Client({
  region: AWS_REGION
});

const buildTimestampKey = (date = new Date()) => {
  const pad = value => value.toString().padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

const sanitizeFilename = (filename = 'upload') => {
  const normalized = filename.toString().trim().replace(/\s+/g, '_');
  const sanitized = normalized.replace(/[^A-Za-z0-9._-]/g, '');
  return sanitized || 'upload';
};

const isValidResendImageKey = key =>
  typeof key === 'string' &&
  key.startsWith(RESEND_IMAGE_PREFIX) &&
  !key.includes('..');

const ensureTable = (tableName, label) => {
  if (!tableName) {
    throw new Error(`${label} table is not configured`);
  }
};

const delayOptionToSeconds = delayOption => {
  switch (delayOption) {
    case '2m':
      return 2 * 60;
    case '5m':
      return 5 * 60;
    case '1h':
      return 60 * 60;
    case '2h':
      return 2 * 60 * 60;
    case '1d':
      return 24 * 60 * 60;
    case '2d':
      return 48 * 60 * 60;
    default:
      return null;
  }
};

const validateResendImage = ({ contentType, contentLength }) => {
  if (contentType && !RESEND_IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error('Only JPG, PNG, or WEBP images are allowed.');
  }
  if (contentLength && contentLength > RESEND_IMAGE_MAX_BYTES) {
    throw new Error('Image file must be 5MB or less.');
  }
};

const buildResendImageKey = (campaignId, filename) => {
  const safeName = sanitizeFilename(filename);
  const timestamp = buildTimestampKey();
  return `${RESEND_IMAGE_PREFIX}${campaignId}/${timestamp}_${safeName}`;
};

const createPresignedUpload = async ({ campaignId, filename, contentType, contentLength }) => {
  if (!campaignId) {
    throw new Error('campaignId is required');
  }
  validateResendImage({ contentType, contentLength });
  const key = buildResendImageKey(campaignId, filename);
  const command = new PutObjectCommand({
    Bucket: RESEND_IMAGE_BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream'
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  return { uploadUrl, s3Key: key, contentType };
};

const createPresignedGet = async key => {
  if (!key) {
    return null;
  }
  const command = new GetObjectCommand({
    Bucket: RESEND_IMAGE_BUCKET,
    Key: key
  });
  return getSignedUrl(s3Client, command, { expiresIn: 900 });
};

const putCampaignMetadata = async metadata => {
  ensureTable(CAMPAIGN_METADATA_TABLE, 'Campaign metadata');
  if (!metadata?.campaign_id) {
    throw new Error('campaign_id is required');
  }
  const item = {
    ...metadata,
    updated_at: new Date().toISOString()
  };
  await docClient.send(
    new PutCommand({
      TableName: CAMPAIGN_METADATA_TABLE,
      Item: item
    })
  );
};

const updateCampaignMetadata = async (campaignId, updates = {}) => {
  ensureTable(CAMPAIGN_METADATA_TABLE, 'Campaign metadata');
  const updateKeys = Object.keys(updates);
  if (!campaignId || updateKeys.length === 0) {
    return;
  }
  const expressionParts = [];
  const expressionAttributeValues = {
    ':updatedAt': new Date().toISOString()
  };
  const expressionAttributeNames = {};
  updateKeys.forEach((key, index) => {
    const name = `#field${index}`;
    const value = `:value${index}`;
    expressionAttributeNames[name] = key;
    expressionAttributeValues[value] = updates[key];
    expressionParts.push(`${name} = ${value}`);
  });
  expressionParts.push('#updated_at = :updatedAt');
  expressionAttributeNames['#updated_at'] = 'updated_at';

  await docClient.send(
    new UpdateCommand({
      TableName: CAMPAIGN_METADATA_TABLE,
      Key: { campaign_id: campaignId },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    })
  );
};

const getCampaignMetadata = async campaignId => {
  ensureTable(CAMPAIGN_METADATA_TABLE, 'Campaign metadata');
  if (!campaignId) {
    return null;
  }
  const result = await docClient.send(
    new GetCommand({
      TableName: CAMPAIGN_METADATA_TABLE,
      Key: { campaign_id: campaignId }
    })
  );
  return result.Item || null;
};

const listResendAttemptsByCampaignId = async campaignId => {
  ensureTable(RESEND_ATTEMPTS_TABLE, 'Resend attempts');
  if (!campaignId) {
    return [];
  }
  if (RESEND_ATTEMPTS_CAMPAIGN_INDEX) {
    try {
      const result = await docClient.send(
        new QueryCommand({
          TableName: RESEND_ATTEMPTS_TABLE,
          IndexName: RESEND_ATTEMPTS_CAMPAIGN_INDEX,
          KeyConditionExpression: '#campaign_id = :campaignId',
          ExpressionAttributeNames: { '#campaign_id': 'campaign_id' },
          ExpressionAttributeValues: { ':campaignId': campaignId },
          ScanIndexForward: false
        })
      );
      return result.Items || [];
    } catch (error) {
      if (error?.name !== 'ValidationException') {
        throw error;
      }
    }
  }

  const scanResult = await docClient.send(
    new ScanCommand({
      TableName: RESEND_ATTEMPTS_TABLE,
      FilterExpression: '#campaign_id = :campaignId',
      ExpressionAttributeNames: { '#campaign_id': 'campaign_id' },
      ExpressionAttributeValues: { ':campaignId': campaignId }
    })
  );
  return scanResult.Items || [];
};

const findAttemptByClientRequest = async ({ campaignId, clientRequestId }) => {
  ensureTable(RESEND_ATTEMPTS_TABLE, 'Resend attempts');
  if (!clientRequestId) {
    return null;
  }
  if (RESEND_ATTEMPTS_CLIENT_INDEX) {
    try {
      const result = await docClient.send(
        new QueryCommand({
          TableName: RESEND_ATTEMPTS_TABLE,
          IndexName: RESEND_ATTEMPTS_CLIENT_INDEX,
          KeyConditionExpression: '#client_request_id = :requestId',
          ExpressionAttributeNames: { '#client_request_id': 'client_request_id' },
          ExpressionAttributeValues: { ':requestId': clientRequestId }
        })
      );
      const matched = Array.isArray(result.Items) ? result.Items : [];
      return matched.find(item => !campaignId || item.campaign_id === campaignId) || null;
    } catch (error) {
      if (error?.name !== 'ValidationException') {
        throw error;
      }
    }
  }
  const scanResult = await docClient.send(
    new ScanCommand({
      TableName: RESEND_ATTEMPTS_TABLE,
      FilterExpression: '#client_request_id = :requestId',
      ExpressionAttributeNames: { '#client_request_id': 'client_request_id' },
      ExpressionAttributeValues: { ':requestId': clientRequestId }
    })
  );
  const items = scanResult.Items || [];
  return items.find(item => !campaignId || item.campaign_id === campaignId) || null;
};

const createResendAttempt = async attempt => {
  ensureTable(RESEND_ATTEMPTS_TABLE, 'Resend attempts');
  await docClient.send(
    new PutCommand({
      TableName: RESEND_ATTEMPTS_TABLE,
      Item: attempt,
      ConditionExpression: 'attribute_not_exists(resend_attempt_id)'
    })
  );
};

const updateResendAttemptStatus = async ({
  resendAttemptId,
  status,
  updates = {},
  expectedStatus = null
}) => {
  ensureTable(RESEND_ATTEMPTS_TABLE, 'Resend attempts');
  if (!resendAttemptId || !status) {
    return;
  }
  const expressionParts = ['#status = :status', '#updated_at = :updated'];
  const expressionAttributeNames = {
    '#status': 'status',
    '#updated_at': 'updated_at'
  };
  const expressionAttributeValues = {
    ':status': status,
    ':updated': new Date().toISOString()
  };

  Object.entries(updates).forEach(([key, value], index) => {
    const fieldName = `#field_${index}`;
    const fieldValue = `:value_${index}`;
    expressionAttributeNames[fieldName] = key;
    expressionAttributeValues[fieldValue] = value;
    expressionParts.push(`${fieldName} = ${fieldValue}`);
  });

  const params = {
    TableName: RESEND_ATTEMPTS_TABLE,
    Key: { resend_attempt_id: resendAttemptId },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues
  };

  if (expectedStatus) {
    params.ConditionExpression = '#status = :expectedStatus';
    expressionAttributeValues[':expectedStatus'] = expectedStatus;
  }

  await docClient.send(new UpdateCommand(params));
};

const batchWriteRecipients = async recipients => {
  if (!RESEND_RECIPIENTS_TABLE || recipients.length === 0) {
    return;
  }
  const chunks = [];
  for (let i = 0; i < recipients.length; i += 25) {
    chunks.push(recipients.slice(i, i + 25));
  }

  for (const chunk of chunks) {
    const requestItems = {
      [RESEND_RECIPIENTS_TABLE]: chunk.map(item => ({
        PutRequest: { Item: item }
      }))
    };
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: requestItems
      })
    );
  }
};

const updateResendRecipient = async ({ resendAttemptId, phone, updates = {} }) => {
  if (!RESEND_RECIPIENTS_TABLE || !resendAttemptId || !phone) {
    return;
  }
  const updateKeys = Object.keys(updates);
  if (updateKeys.length === 0) {
    return;
  }
  const expressionParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {};
  updateKeys.forEach((key, index) => {
    const name = `#field_${index}`;
    const value = `:value_${index}`;
    expressionAttributeNames[name] = key;
    expressionAttributeValues[value] = updates[key];
    expressionParts.push(`${name} = ${value}`);
  });
  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionAttributeValues[':updated_at'] = new Date().toISOString();
  expressionParts.push('#updated_at = :updated_at');

  await docClient.send(
    new UpdateCommand({
      TableName: RESEND_RECIPIENTS_TABLE,
      Key: {
        resend_attempt_id: resendAttemptId,
        phone
      },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    })
  );
};

const listResendRecipientsByAttempt = async resendAttemptId => {
  if (!RESEND_RECIPIENTS_TABLE || !resendAttemptId) {
    return [];
  }
  const result = await docClient.send(
    new QueryCommand({
      TableName: RESEND_RECIPIENTS_TABLE,
      KeyConditionExpression: '#resend_attempt_id = :resendAttemptId',
      ExpressionAttributeNames: {
        '#resend_attempt_id': 'resend_attempt_id'
      },
      ExpressionAttributeValues: {
        ':resendAttemptId': resendAttemptId
      }
    })
  );
  return result.Items || [];
};

const findResendRecipientByMessageId = async messageId => {
  if (!RESEND_RECIPIENTS_TABLE || !messageId) {
    return null;
  }
  const result = await docClient.send(
    new ScanCommand({
      TableName: RESEND_RECIPIENTS_TABLE,
      FilterExpression: '#message_id = :messageId',
      ExpressionAttributeNames: {
        '#message_id': 'message_id'
      },
      ExpressionAttributeValues: {
        ':messageId': messageId
      },
      Limit: 1
    })
  );
  return result.Items && result.Items.length > 0 ? result.Items[0] : null;
};

const updateResendRecipientStatusByMessageId = async ({ messageId, status, error }) => {
  if (!messageId || !status) {
    return false;
  }
  const recipient = await findResendRecipientByMessageId(messageId);
  if (!recipient?.resend_attempt_id || !recipient?.phone) {
    return false;
  }
  const normalizedStatus = status.toString().toUpperCase();
  await updateResendRecipient({
    resendAttemptId: recipient.resend_attempt_id,
    phone: recipient.phone,
    updates: {
      status: normalizedStatus,
      error_reason: error?.details || error?.title || null,
      error_code: error?.code ?? null,
      last_status_update: new Date().toISOString()
    }
  });
  return true;
};

const listDueAttempts = async nowIso => {
  ensureTable(RESEND_ATTEMPTS_TABLE, 'Resend attempts');
  const now = nowIso || new Date().toISOString();
  const result = await docClient.send(
    new ScanCommand({
      TableName: RESEND_ATTEMPTS_TABLE,
      FilterExpression: '#status = :scheduled AND #scheduled_at <= :now',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#scheduled_at': 'scheduled_at'
      },
      ExpressionAttributeValues: {
        ':scheduled': 'SCHEDULED',
        ':now': now
      }
    })
  );
  return result.Items || [];
};

module.exports = {
  RESEND_IMAGE_MAX_BYTES,
  RESEND_IMAGE_CONTENT_TYPES,
  isValidResendImageKey,
  delayOptionToSeconds,
  createPresignedUpload,
  createPresignedGet,
  buildResendImageKey,
  putCampaignMetadata,
  updateCampaignMetadata,
  getCampaignMetadata,
  listResendAttemptsByCampaignId,
  findAttemptByClientRequest,
  createResendAttempt,
  updateResendAttemptStatus,
  batchWriteRecipients,
  updateResendRecipient,
  listResendRecipientsByAttempt,
  findResendRecipientByMessageId,
  updateResendRecipientStatusByMessageId,
  listDueAttempts
};
