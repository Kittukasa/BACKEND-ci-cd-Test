const express = require('express');
const { logger } = require('../config/logger');
const automationService = require('../services/automationService');

const router = express.Router();

const normalizeMatchText = value => (value || '').toString().toLowerCase().trim();

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
  const keywords = triggerConfig.keywords
    .map(item => normalizeMatchText(item))
    .filter(Boolean);
  if (matchType === 'equals') {
    if (!keywords.length) {
      return false;
    }
    return keywords.some(keyword => normalizedMessage === keyword);
  }
  if (matchType === 'any') {
    return true;
  }
  if (matchType === 'contains') {
    if (!keywords.length) {
      return false;
    }
    return keywords.some(keyword => normalizedMessage.includes(keyword));
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
    const triggerNode = nodes.find(node => node?.type === 'TRIGGER');
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

const resolveStoreId = (req) => {
  const provided =
    typeof req.query?.storeId === 'string'
      ? req.query.storeId.trim()
      : typeof req.body?.storeId === 'string'
      ? req.body.storeId.trim()
      : null;
  const tokenStoreId = req.user?.store_id ? req.user.store_id.toString() : null;
  return { provided, tokenStoreId, storeId: provided || tokenStoreId };
};

const ensureAuthorizedStore = (tokenStoreId, storeId, res) => {
  if (!storeId) {
    res.status(400).json({ error: 'storeId is required.' });
    return false;
  }
  if (tokenStoreId && tokenStoreId !== storeId) {
    res.status(403).json({ error: 'You can only manage workflows for your store.' });
    return false;
  }
  return true;
};

const parseSpec = (spec) => {
  if (spec && typeof spec === 'object') {
    return spec;
  }
  if (typeof spec === 'string' && spec.trim()) {
    try {
      return JSON.parse(spec);
    } catch {
      return null;
    }
  }
  return null;
};

router.get('/workflows', async (req, res) => {
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  try {
    const items = await automationService.listWorkflows(storeId);
    return res.json({ success: true, data: items });
  } catch (error) {
    logger.error('Failed to list workflows', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to list workflows.' });
  }
});

router.get('/workflows/:workflowId', async (req, res) => {
  const { workflowId } = req.params;
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required.' });
  }
  try {
    const item = await automationService.getWorkflow(storeId, workflowId);
    if (!item) {
      return res.status(404).json({ error: 'Workflow not found.' });
    }
    return res.json({ success: true, data: item });
  } catch (error) {
    logger.error('Failed to fetch workflow', { storeId, workflowId, error: error.message });
    return res.status(500).json({ error: 'Unable to fetch workflow.' });
  }
});

router.post('/workflows/test-match', async (req, res) => {
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  const inputText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!inputText) {
    return res.status(400).json({ error: 'text is required.' });
  }
  try {
    const workflows = await automationService.listWorkflows(storeId);
    const matched = findWorkflowMatch(workflows, inputText);
    if (!matched) {
      return res.json({ success: true, matched: false });
    }
    const triggerDetails = extractTriggerDetails(matched);
    return res.json({
      success: true,
      matched: true,
      workflow: {
        workflow_id: matched.workflow_id,
        name: matched.name,
        status: matched.status
      },
      trigger: triggerDetails
    });
  } catch (error) {
    logger.error('Failed to test workflow match', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to test workflow match.' });
  }
});

router.post('/workflows', async (req, res) => {
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  const { name, description, status, input_text, input_variations, message_text, buttons, variables } = req.body || {};
  const spec = parseSpec(req.body?.spec);
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Workflow name is required.' });
  }
  if (!spec) {
    return res.status(400).json({ error: 'Workflow spec is required.' });
  }
  try {
    const created = await automationService.createWorkflow(storeId, {
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      status,
      spec,
      input_text: typeof input_text === 'string' ? input_text.trim() : '',
      input_variations: Array.isArray(input_variations) ? input_variations : [],
      message_text: typeof message_text === 'string' ? message_text : '',
      buttons: Array.isArray(buttons) ? buttons : [],
      variables: Array.isArray(variables) ? variables : []
    });
    return res.status(201).json({ success: true, data: created });
  } catch (error) {
    logger.error('Failed to create workflow', { storeId, error: error.message });
    return res.status(500).json({ error: 'Unable to create workflow.' });
  }
});

router.put('/workflows/:workflowId', async (req, res) => {
  const { workflowId } = req.params;
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required.' });
  }
  const updates = {
    name: typeof req.body?.name === 'string' ? req.body.name.trim() : undefined,
    description:
      typeof req.body?.description === 'string' ? req.body.description.trim() : undefined,
    status: req.body?.status,
    spec: parseSpec(req.body?.spec) || undefined,
    input_text: typeof req.body?.input_text === 'string' ? req.body.input_text.trim() : undefined,
    input_variations: Array.isArray(req.body?.input_variations)
      ? req.body.input_variations
      : undefined,
    message_text: typeof req.body?.message_text === 'string' ? req.body.message_text : undefined,
    buttons: Array.isArray(req.body?.buttons) ? req.body.buttons : undefined,
    variables: Array.isArray(req.body?.variables) ? req.body.variables : undefined
  };
  try {
    const updated = await automationService.updateWorkflow(storeId, workflowId, updates);
    if (!updated) {
      return res.status(404).json({ error: 'Workflow not found.' });
    }
    return res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Failed to update workflow', { storeId, workflowId, error: error.message });
    return res.status(500).json({ error: 'Unable to update workflow.' });
  }
});

router.delete('/workflows/:workflowId', async (req, res) => {
  const { workflowId } = req.params;
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required.' });
  }
  try {
    await automationService.deleteWorkflow(storeId, workflowId);
    return res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete workflow', { storeId, workflowId, error: error.message });
    return res.status(500).json({ error: 'Unable to delete workflow.' });
  }
});

router.post('/workflows/:workflowId/publish', async (req, res) => {
  const { workflowId } = req.params;
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required.' });
  }
  try {
    const updated = await automationService.setWorkflowStatus(storeId, workflowId, 'live');
    return res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Failed to publish workflow', { storeId, workflowId, error: error.message });
    return res.status(500).json({ error: 'Unable to publish workflow.' });
  }
});

router.post('/workflows/:workflowId/pause', async (req, res) => {
  const { workflowId } = req.params;
  const { storeId, tokenStoreId } = resolveStoreId(req);
  if (!ensureAuthorizedStore(tokenStoreId, storeId, res)) {
    return;
  }
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required.' });
  }
  try {
    const updated = await automationService.setWorkflowStatus(storeId, workflowId, 'paused');
    return res.json({ success: true, data: updated });
  } catch (error) {
    logger.error('Failed to pause workflow', { storeId, workflowId, error: error.message });
    return res.status(500).json({ error: 'Unable to pause workflow.' });
  }
});

module.exports = router;
const extractTriggerDetails = (workflow) => {
  const spec = workflow?.spec || {};
  const nodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  const triggerNode = nodes.find(node => node?.type === 'TRIGGER');
  const triggerConfig = triggerNode?.config || {};
  return {
    trigger_type: triggerConfig.trigger_type || null,
    match: triggerConfig.match || null,
    keywords: Array.isArray(triggerConfig.keywords) ? triggerConfig.keywords : []
  };
};
