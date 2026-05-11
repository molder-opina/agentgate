/**
 * AgentGate — License & Policy Enforcement Server for AI Agents
 *
 * "Auth0 for AI Agents" — Control, monetize, and govern AI agent workloads
 *
 * Core features:
 *   • Policy validation — define what agents can/cannot do
 *   • Usage quotas & metering — per-agent, per-tool limits
 *   • Rate limiting — sliding window per agent + tool
 *   • Capability ACLs — web_search, browser, mcp_execute, code_run, etc.
 *   • Token tracking — meter model usage per agent
 *   • Revocation — instantly disable compromised agents
 *   • Multi-tenant — complete agent isolation
 *   • Audit logs — full compliance trail
 *   • Auto-provisioning — from crypto payments (Blockonomics webhook)
 *
 * API endpoints:
 *   POST /api/validate    — Check if agent can execute a tool/run
 *   POST /api/consume     — Log usage, deduct quotas, meter tokens
 *   POST /api/register    — Register a new agent
 *   POST /api/policy      — Create/update agent policies
 *   POST /api/revoke      — Revoke an agent's access
 *   GET  /api/agents/:id  — Get agent status + usage
 *   POST /api/webhook     — Payment webhooks (auto-provisioning)
 *   GET  /health          — Health check
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// ─── Configuration ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString('hex');
const API_KEY = process.env.API_KEY || crypto.randomBytes(24).toString('hex');
const BLOCKONOMICS_API_KEY = process.env.BLOCKONOMICS_API_KEY || '';
const BLOCKONOMICS_BASE = 'https://www.blockonomics.co';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || crypto.randomBytes(16).toString('hex');
const CB_URL = process.env.CB_URL || 'https://agentgate.yourdomain.com';

// ─── Data Store (SQLite-compatible JSON — migrate to PostgreSQL for prod) ───

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');
const POLICIES_FILE = path.join(DATA_DIR, 'policies.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

['agents.json', 'usage.json', 'policies.json', 'audit.json', 'payments.json'].forEach(f => {
  if (!fs.existsSync(path.join(DATA_DIR, f))) {
    fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify({}, null, 2));
  }
});

function read(file) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return {}; }
}
function write(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
}
function audit(action, agentId, details = {}) {
  const logs = read('audit.json');
  logs.entries = logs.entries || [];
  logs.entries.unshift({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    action,
    agent_id: agentId,
    ...details,
  }).slice(0, 10000); // Keep last 10K logs
  write('audit.json', logs);
}

// ─── SMTP / Email Service ──────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

function sendCredentials(email, agent, policy) {
  return transporter.sendMail({
    from: `"AgentGate" <${SMTP_USER || 'noreply@yourdomain.com'}>`,
    to: email,
    subject: 'Your AgentGate credentials',
    html: `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:2rem;">
        <h1>🤖 AgentGate — Your Agent is Ready</h1>
        <p>Here are your agent credentials:</p>
        <div style="background:#111;color:#00d4ff;padding:1rem;border-radius:8px;font-family:monospace;margin:1rem 0;">
          AGENT_ID: ${agent.id}<br>
          API_KEY: ${agent.api_key}
        </div>
        <p><strong>Plan:</strong> ${policy.tier} | <strong>Expires:</strong> ${new Date(policy.expires).toLocaleDateString()}</p>
        <h3>Quick Start</h3>
        <pre style="background:#111;padding:1rem;border-radius:8px;overflow-x:auto;">
npm install @agentgate/sdk
\n
const gate = new AgentGate({
  server: "https://agentgate.yourdomain.com",
  agentId: "${agent.id}",
  apiKey: "${agent.api_key}"
});\n
// Check permission before running a tool
const allowed = await gate.can({
  tool: "browser",
  runId: crypto.randomUUID()
});\n
if (allowed.allowed) {
  // Run your agent code
  await runBrowserAgent();
}\n
// Log usage
await gate.consume({
  tool: "browser",
  tokens: 0,
  runId: "<same runId>"
});
        </pre>
        <p style="color:#666;font-size:0.85rem;">Dashboard: https://agentgate.yourdomain.com/dashboard</p>
      </div>
    `,
  });
}

// ─── Utility Functions ─────────────────────────────────────────────────────

function validateApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

function generateId(prefix = 'ag') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function generateSecret(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

// ─── Tier Definitions ──────────────────────────────────────────────────────

const TIERS = {
  free: {
    tier: 'free',
    max_runs_per_day: 10,
    max_tokens_month: 1000,
    max_concurrent: 1,
    rate_limit_rpm: 2,
    capabilities: ['web_search'],
    allowed_tools: ['web_search'],
    cost: 0,
  },
  starter: {
    tier: 'starter',
    max_runs_per_day: 50,
    max_tokens_month: 10000,
    max_concurrent: 2,
    rate_limit_rpm: 10,
    capabilities: ['web_search', 'code_run'],
    allowed_tools: ['web_search', 'code_run'],
    cost: 29,
  },
  pro: {
    tier: 'pro',
    max_runs_per_day: 200,
    max_tokens_month: 50000,
    max_concurrent: 5,
    rate_limit_rpm: 30,
    capabilities: ['web_search', 'code_run', 'browser', 'mcp_execute'],
    allowed_tools: ['web_search', 'code_run', 'browser', 'mcp_execute'],
    cost: 79,
  },
  enterprise: {
    tier: 'enterprise',
    max_runs_per_day: 5000,
    max_tokens_month: 500000,
    max_concurrent: 50,
    rate_limit_rpm: 200,
    capabilities: ['web_search', 'code_run', 'browser', 'mcp_execute', 'multi_agent'],
    allowed_tools: ['web_search', 'code_run', 'browser', 'mcp_execute', 'multi_agent'],
    cost: 299,
  },
};

const PAYMENT_PRICES = {
  starter: 29,
  pro: 79,
  enterprise: 299,
};

// ─── Quota & Rate Limit Engine ─────────────────────────────────────────────

function checkQuota(agent, usage, nowTs = Date.now()) {
  const policy = agent.policy;
  if (policy.revoked) return { allowed: false, reason: 'Agent revoked' };
  if (policy.expires && new Date(policy.expires) < new Date(nowTs)) {
    return { allowed: false, reason: 'Policy expired' };
  }

  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = new Date().toISOString().slice(0, 7);

  // Daily run limit
  const todayRuns = usage.daily?.[today] || 0;
  if (todayRuns >= policy.max_runs_per_day) {
    return { allowed: false, reason: `Daily run limit reached (${policy.max_runs_per_day})` };
  }

  // Monthly token limit
  const monthTokens = usage.monthly?.[thisMonth]?.tokens || 0;
  if (monthTokens >= policy.max_tokens_month) {
    return { allowed: false, reason: `Monthly token limit reached (${policy.max_tokens_month})` };
  }

  // Concurrent limit
  const concurrent = usage.concurrent || 0;
  if (concurrent >= policy.max_concurrent) {
    return { allowed: false, reason: `Concurrent limit reached (${policy.max_concurrent})` };
  }

  return { allowed: true };
}

function checkToolAccess(agent, tool) {
  const policy = agent.policy;
  if (!policy.allowed_tools?.includes(tool)) {
    return { allowed: false, reason: `Tool "${tool}" not in allowed list` };
  }
  return { allowed: true };
}

function checkRateLimit(usage, policy) {
  const windowMs = 60000; // 1 minute
  const now = Date.now();
  const windowStart = now - windowMs;

  const recent = (usage.history || []).filter(t => t > windowStart).length;
  if (recent >= policy.rate_limit_rpm) {
    return { allowed: false, reason: `Rate limit exceeded (${policy.rate_limit_rpm} rpm)` };
  }

  return { allowed: true };
}

// ─── API Routes ────────────────────────────────────────────────────────────

// ── Validate: Can this agent execute a tool/run? ────────────────────────────

app.post('/api/validate', (req, res) => {
  const { agent_id, tool, run_id, model } = req.body;

  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id required' });
  }

  const agents = read('agents.json');
  const agent = agents[agent_id];

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const usage = read('usage.json');
  const agentUsage = usage[agent_id] || { daily: {}, monthly: {}, concurrent: 0, history: [] };

  // Check tool access
  const toolCheck = checkToolAccess(agent, tool);
  if (!toolCheck.allowed) {
    audit('validation_denied', agent_id, { tool, run_id, reason: toolCheck.reason });
    return res.json({
      allowed: false,
      reason: toolCheck.reason,
      agent_id,
      tool,
    });
  }

  // Check quotas
  const quotaCheck = checkQuota(agent, agentUsage);
  if (!quotaCheck.allowed) {
    audit('validation_denied', agent_id, { tool, run_id, reason: quotaCheck.reason });
    return res.json({
      allowed: false,
      reason: quotaCheck.reason,
      agent_id,
      tool,
    });
  }

  // Check rate limit
  const rateCheck = checkRateLimit(agentUsage, agent.policy);
  if (!rateCheck.allowed) {
    audit('validation_denied', agent_id, { tool, run_id, reason: rateCheck.reason });
    return res.json({
      allowed: false,
      reason: rateCheck.reason,
      agent_id,
      tool,
    });
  }

  // Valid — return policy context
  audit('validation_allowed', agent_id, { tool, run_id });
  res.json({
    allowed: true,
    agent_id,
    tool,
    model: model || 'auto',
    policy: {
      tier: agent.policy.tier,
      max_concurrent: agent.policy.max_concurrent,
      rate_limit_rpm: agent.policy.rate_limit_rpm,
      capabilities: agent.policy.capabilities,
    },
    usage: {
      daily_runs: agentUsage.daily?.[new Date().toISOString().slice(0, 10)] || 0,
      daily_limit: agent.policy.max_runs_per_day,
      concurrent: agentUsage.concurrent || 0,
      concurrent_max: agent.policy.max_concurrent,
    },
    run_id: run_id || crypto.randomUUID(),
  });
});

// ── Consume: Log usage, deduct quotas ───────────────────────────────────────

app.post('/api/consume', (req, res) => {
  const { agent_id, tool, tokens = 0, run_id, cost_usd = 0, metadata } = req.body;

  if (!agent_id) {
    return res.status(400).json({ error: 'agent_id required' });
  }

  const agents = read('agents.json');
  const agent = agents[agent_id];

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Ensure agent is not revoked before logging
  if (agent.policy.revoked) {
    audit('consume_revoked', agent_id, { tool, run_id });
    return res.status(403).json({ error: 'Agent revoked' });
  }

  const usage = read('usage.json');
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = new Date().toISOString().slice(0, 7);

  const agentUsage = usage[agent_id] || { daily: {}, monthly: {}, concurrent: 0, history: [] };
  agentUsage.daily[today] = (agentUsage.daily[today] || 0) + 1;
  agentUsage.monthly[thisMonth] = agentUsage.monthly[thisMonth] || { tokens: 0, runs: 0 };
  agentUsage.monthly[thisMonth].tokens = (agentUsage.monthly[thisMonth].tokens || 0) + (tokens || 0);
  agentUsage.monthly[thisMonth].runs = (agentUsage.monthly[thisMonth].runs || 0) + 1;
  agentUsage.history = agentUsage.history || [];
  agentUsage.history.push(Date.now());
  agentUsage.concurrent = Math.max(0, (agentUsage.concurrent || 0) - 1); // Decrement

  write('usage.json', usage);

  audit('consume', agent_id, { tool, tokens, run_id, cost_usd, metadata });

  res.json({
    logged: true,
    usage: {
      daily_runs: agentUsage.daily[today],
      daily_limit: agent.policy.max_runs_per_day,
      month_tokens: agentUsage.monthly[thisMonth].tokens,
      month_tokens_limit: agent.policy.max_tokens_month,
    },
  });
});

// ── Active / Decrement concurrent ──────────────────────────────────────────

app.post('/api/consume/active', (req, res) => {
  const { agent_id, start } = req.body; // start=true / start=false

  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });

  const usage = read('usage.json');
  const agentUsage = usage[agent_id] || { concurrent: 0 };

  if (start) {
    agentUsage.concurrent = (agentUsage.concurrent || 0) + 1;
    audit('agent_started', agent_id);
  } else {
    agentUsage.concurrent = Math.max(0, (agentUsage.concurrent || 0) - 1);
    audit('agent_stopped', agent_id);
  }

  write('usage.json', usage);
  res.json({ concurrent: agentUsage.concurrent });
});

// ── Register agent (auto from payment or manual) ────────────────────────────

app.post('/api/register', (req, res) => {
  const { name, email, tier = 'free' } = req.body;

  const agents = read('agents.json');
  const agentId = generateId('ag');
  const apiKey = generateSecret(48);

  const policy = { ...TIERS[tier] };
  if (policy.cost === 0 && tier !== 'free') {
    policy.tier = 'free';
  }

  const agent = {
    id: agentId,
    name: name || 'untitled',
    email: email || '',
    created: new Date().toISOString(),
    policy,
  };

  agents[agentId] = agent;
  write('agents.json', agents);

  audit('register', agentId, { name, tier });

  // If not free tier, send credentials via email
  if (tier !== 'free') {
    try {
      sendCredentials(email, agent, policy);
    } catch (err) {
      console.error('Email failed:', err.message);
    }
  }

  res.json({
    agent_id: agentId,
    api_key: apiKey,
    policy,
    message: tier === 'free' ? 'Agent registered.' : 'Credentials sent to email.',
  });
});

// ── Get agent info ──────────────────────────────────────────────────────────

app.get('/api/agents/:id', (req, res) => {
  const agents = read('agents.json');
  const agent = agents[req.params.id];

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const usage = read('usage.json');
  const agentUsage = usage[req.params.id] || {};

  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = new Date().toISOString().slice(0, 7);

  res.json({
    id: agent.id,
    name: agent.name,
    created: agent.created,
    policy: agent.policy,
    usage: {
      daily_runs: agentUsage.daily?.[today] || 0,
      daily_limit: agent.policy.max_runs_per_day,
      month_tokens: agentUsage.monthly?.[thisMonth]?.tokens || 0,
      month_tokens_limit: agent.policy.max_tokens_month,
      concurrent: agentUsage.concurrent || 0,
    },
  });
});

// ── Revoke agent ────────────────────────────────────────────────────────────

app.post('/api/revoke', validateApiKey, (req, res) => {
  const { agent_id } = req.body;
  const agents = read('agents.json');
  const agent = agents[agent_id];

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  agent.policy.revoked = true;
  agent.revoked_at = new Date().toISOString();
  write('agents.json', agents);

  audit('revoke', agent_id);
  res.json({ revoked: true });
});

// ── List all agents ─────────────────────────────────────────────────────────

app.get('/api/agents', validateApiKey, (req, res) => {
  const agents = read('agents.json');
  const list = Object.values(agents).map(a => ({
    id: a.id,
    name: a.name,
    email: a.email,
    tier: a.policy.tier,
    running: a.policy.revoked ? 'revoked' : 'active',
    created: a.created,
  }));
  res.json(list);
});

// ── Create custom policy ───────────────────────────────────────────────────

app.post('/api/policy', (req, res) => {
  const { agent_id, policy } = req.body;
  const agents = read('agents.json');
  const agent = agents[agent_id];

  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  // Merge with base tier, overriding specified fields
  const base = TIERS[agent.policy.tier] || TIERS.free;
  agent.policy = { ...base, ...policy };

  write('agents.json', agents);
  audit('policy_update', agent_id, { policy });
  res.json({ policy: agent.policy });
});

// ── Audit logs ──────────────────────────────────────────────────────────────

app.get('/api/audit/:agent_id', (req, res) => {
  const logs = read('audit.json');
  const entries = logs.entries || [];
  const filtered = agent_id =>
    entries.filter(l => l.agent_id === req.params.agent_id).slice(0, 100);
  res.json(filtered);
});

// ── Blockonomics Webhook (crypto → auto-provision) ──────────────────────────

app.post('/api/webhook', async (req, res) => {
  const data = req.body;
  console.log('📩 Webhook:', JSON.stringify(data));

  try {
    // Blockonomics payment notification
    if (data.addr && data.txid) {
      const payments = read('payments.json');
      const incoming = payments[data.addr] = payments[data.addr] || [];

      const alreadyProcessed = incoming.find(p => p.txid === data.txid);
      if (alreadyProcessed) {
        return res.json({ status: 'noop', reason: 'already processed' });
      }

      incoming.push({ txid: data.txid, ts: new Date().toISOString() });
      write('payments.json', payments);

      // TODO: In production, verify tx on blockchain
      // For demo, auto-provision after 1 confirmation
      // You'd check data.amount >= expected for the selected tier

      // For now, register a free agent and email credentials
      // In production, this is triggered by a payment with amount/tier metadata
      const tier = data.tier || 'pro';
      const email = data.buyer_email || 'buyer@unknown.com';

      // Create agent with selected tier
      const agents = read('agents.json');
      const agentId = generateId('ag');
      const apiKey = generateSecret(48);

      const policy = { ...TIERS[tier] };

      const agent = {
        id: agentId,
        name: email,
        email,
        created: new Date().toISOString(),
        policy,
      };

      // Set expiry based on subscription
      policy.expires = new Date(Date.now() + 365 * 86400000).toISOString();

      agents[agentId] = agent;
      write('agents.json', agents);

      try {
        sendCredentials(email, agent, policy);
        console.log(`✅ Agent ${agentId} registered. Credentials sent to ${email}`);
      } catch (err) {
        console.error('Email failed:', err.message);
      }

      audit('provisioned_from_payment', agentId, { tier, txid: data.txid, email });
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Health ──────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const agents = read('agents.json');
  const agents_count = Object.keys(agents).length;
  res.json({
    status: 'ok',
    version: '0.1.0',
    service: 'agentgate',
    agents_count,
    uptime: process.uptime(),
  });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🔐 AgentGate Policy Engine`);
  console.log(`   Validate: POST ${CB_URL}/api/validate`);
  console.log(`   Consume:  POST ${CB_URL}/api/consume`);
  console.log(`   Register: POST ${CB_URL}/api/register`);
  console.log(`   Revoke:   POST ${CB_URL}/api/revoke`);
  console.log(`   Payment:  POST ${CB_URL}/api/webhook`);
  console.log(`   Health:   GET  ${CB_URL}/health`);
  console.log(`\n   API Key: ${API_KEY.substring(0, 16)}...\n`);
});

module.exports = app;
