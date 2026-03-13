const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { logger } = require('../config/logger');

const REGION = process.env.AWS_REGION;
const ADMIN_AUTH_TABLE = process.env.ADMIN_AUTH_TABLE;

const client = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(client);

const PROFILE_SORT_KEY = 'PROFILE';

const assertTableConfigured = () => {
  if (!ADMIN_AUTH_TABLE) {
    throw new Error('ADMIN_AUTH_TABLE is not configured');
  }
};

const getAdminProfile = async (adminName) => {
  assertTableConfigured();

  const normalizedName = typeof adminName === 'string' ? adminName.trim() : '';
  if (!normalizedName) {
    return null;
  }

  const command = new GetCommand({
    TableName: ADMIN_AUTH_TABLE,
    Key: {
      Admin_name: normalizedName,
      last_login: PROFILE_SORT_KEY,
    },
  });

  const result = await docClient.send(command);
  return result?.Item || null;
};

const markAdminLogin = async (adminName) => {
  assertTableConfigured();

  const normalizedName = typeof adminName === 'string' ? adminName.trim() : '';
  if (!normalizedName) {
    return;
  }

  const command = new UpdateCommand({
    TableName: ADMIN_AUTH_TABLE,
    Key: {
      Admin_name: normalizedName,
      last_login: PROFILE_SORT_KEY,
    },
    UpdateExpression: 'SET last_login_at = :timestamp',
    ExpressionAttributeValues: {
      ':timestamp': new Date().toISOString(),
    },
  });

  try {
    await docClient.send(command);
  } catch (error) {
    logger.warn('Failed to mark admin login time', {
      adminName: normalizedName,
      error: error.message,
    });
  }
};

module.exports = {
  getAdminProfile,
  markAdminLogin,
};
