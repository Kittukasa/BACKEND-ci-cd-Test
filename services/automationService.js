const { docClient } = require('../config/dynamodb');
const {
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

const WORKFLOWS_TABLE =
  process.env.WORKFLOW_TABLE || process.env.AUTOMATION_WORKFLOWS_TABLE || 'AutomationWorkflows';

const toIsoString = () => new Date().toISOString();

const normalizeStatus = (value = 'draft') => {
  const normalized = String(value || 'draft').toLowerCase();
  if (['draft', 'live', 'paused'].includes(normalized)) {
    return normalized;
  }
  return 'draft';
};

const ensureTable = () => {
  if (!WORKFLOWS_TABLE) {
    throw new Error('Automation workflows table is not configured');
  }
};

const buildWorkflowItem = (storeId, payload = {}) => {
  const now = toIsoString();
  const workflowId = payload.workflow_id || payload.workflowId || uuidv4();
  return {
    store_id: storeId,
    workflow_id: workflowId,
    name: payload.name || 'Untitled workflow',
    description: payload.description || '',
    status: normalizeStatus(payload.status || 'draft'),
    spec: payload.spec || {},
    input_text: payload.input_text || '',
    input_variations: Array.isArray(payload.input_variations) ? payload.input_variations : [],
    message_text: payload.message_text || '',
    buttons: Array.isArray(payload.buttons) ? payload.buttons : [],
    variables: Array.isArray(payload.variables) ? payload.variables : [],
    created_at: now,
    updated_at: now,
    published_at: null,
  };
};

const listWorkflows = async (storeId) => {
  ensureTable();
  const result = await docClient.send(
    new QueryCommand({
      TableName: WORKFLOWS_TABLE,
      KeyConditionExpression: 'store_id = :storeId',
      ExpressionAttributeValues: {
        ':storeId': storeId,
      },
      ScanIndexForward: false,
    })
  );
  return result.Items || [];
};

const getWorkflow = async (storeId, workflowId) => {
  ensureTable();
  const result = await docClient.send(
    new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: {
        store_id: storeId,
        workflow_id: workflowId,
      },
    })
  );
  return result.Item || null;
};

const createWorkflow = async (storeId, payload = {}) => {
  ensureTable();
  const item = buildWorkflowItem(storeId, payload);
  await docClient.send(
    new PutCommand({
      TableName: WORKFLOWS_TABLE,
      Item: item,
      ConditionExpression: 'attribute_not_exists(workflow_id)',
    })
  );
  return item;
};

const updateWorkflow = async (storeId, workflowId, updates = {}) => {
  ensureTable();
  const expressionParts = [];
  const expressionAttributeNames = {};
  const expressionAttributeValues = {
    ':updatedAt': toIsoString(),
  };

  const applyUpdate = (field, value) => {
    const nameKey = `#${field}`;
    const valueKey = `:${field}`;
    expressionAttributeNames[nameKey] = field;
    expressionAttributeValues[valueKey] = value;
    expressionParts.push(`${nameKey} = ${valueKey}`);
  };

  if (typeof updates.name === 'string') {
    applyUpdate('name', updates.name);
  }
  if (typeof updates.description === 'string') {
    applyUpdate('description', updates.description);
  }
  if (updates.spec && typeof updates.spec === 'object') {
    applyUpdate('spec', updates.spec);
  }
  if (typeof updates.input_text === 'string') {
    applyUpdate('input_text', updates.input_text);
  }
  if (Array.isArray(updates.input_variations)) {
    applyUpdate('input_variations', updates.input_variations);
  }
  if (typeof updates.message_text === 'string') {
    applyUpdate('message_text', updates.message_text);
  }
  if (Array.isArray(updates.buttons)) {
    applyUpdate('buttons', updates.buttons);
  }
  if (Array.isArray(updates.variables)) {
    applyUpdate('variables', updates.variables);
  }
  if (updates.status) {
    applyUpdate('status', normalizeStatus(updates.status));
  }

  expressionAttributeNames['#updated_at'] = 'updated_at';
  expressionParts.push('#updated_at = :updatedAt');

  if (expressionParts.length === 1) {
    return getWorkflow(storeId, workflowId);
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: {
        store_id: storeId,
        workflow_id: workflowId,
      },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes || null;
};

const setWorkflowStatus = async (storeId, workflowId, status) => {
  ensureTable();
  const normalizedStatus = normalizeStatus(status);
  const expressionAttributeNames = {
    '#status': 'status',
    '#updated_at': 'updated_at',
  };
  const expressionAttributeValues = {
    ':status': normalizedStatus,
    ':updatedAt': toIsoString(),
  };
  const expressionParts = ['#status = :status', '#updated_at = :updatedAt'];

  if (normalizedStatus === 'live') {
    expressionAttributeNames['#published_at'] = 'published_at';
    expressionAttributeValues[':publishedAt'] = toIsoString();
    expressionParts.push('#published_at = :publishedAt');
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: WORKFLOWS_TABLE,
      Key: {
        store_id: storeId,
        workflow_id: workflowId,
      },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes || null;
};

const deleteWorkflow = async (storeId, workflowId) => {
  ensureTable();
  await docClient.send(
    new DeleteCommand({
      TableName: WORKFLOWS_TABLE,
      Key: {
        store_id: storeId,
        workflow_id: workflowId,
      },
    })
  );
};

module.exports = {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  setWorkflowStatus,
  deleteWorkflow,
};
