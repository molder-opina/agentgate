# AgentGate — License & Policy Enforcement for AI Agents

> "Auth0 for AI Agents" — Control, monetize, and govern AI agent workloads

## 🚀 What is AgentGate?

AgentGate is a **policy enforcement server + SDK** for AI agent systems. It provides:

- **License validation** — before running any agent tool/capability
- **Usage quotas** — daily runs, monthly tokens, concurrent limits
- **Rate limiting** — per-agent, per-tool RPM
- **Capability ACLs** — web_search, browser, mcp_execute, code_run, multi_agent
- **Token metering** — track model usage per agent
- **Revocation** — instantly disable compromised agents
- **Audit logs** — full compliance trail
- **Auto-provisioning** — from crypto payments (Blockonomics webhooks)

## 🎯 Use Cases

| Use Case | Problem Solved |
|----------|---------------|
| MCP Tools | Control who accesses your tools |
| AI Wrappers | No more hardcoded `.env` keys |
| Multi-Agent Systems | Tenant isolation + governance |
| Selling Agent Access | Built-in billing + quotas |
| Research Agents | Meter searches + premium access |
| Coding Agents | Control tokens/requests |
| Browser Agents | Limit concurrent sessions |

## 📦 Installation

```bash
npm install @agentgate/sdk
```

## ⚡ Quick Start

### 1. Deploy the Policy Engine

```bash
# Clone and deploy on your VPS
git clone https://github.com/youruser/agentgate.git
cd agentgate/server
npm install
node server.js
```

### 2. Initialize in your Agent

```javascript
import AgentGate from '@agentgate/sdk';

const gate = new AgentGate({
  server: 'https://agentgate.yourdomain.com',
  agentId: 'ag-123abc',
  apiKey: 'your-agent-secret-key',
});

// Before any tool execution
const result = await gate.can({ tool: 'browser', runId: 'session-1' });

if (result.allowed) {
  // Execute your agent code
  await runBrowserAgent();

  // Log usage
  await gate.consume({ tool: 'browser', tokens: 2500, runId: 'session-1' });
} else {
  throw new Error(`Access denied: ${result.reason}`);
}
```

### 3. Policy Decorator Pattern

```javascript
class ResearchAgent {
  constructor(gate) {
    this.gate = gate;
  }

  @AgentGate.policy('browser')
  async scrape(url) {
    // gate.can() called automatically before execution
    // gate.consume() called automatically after
    return await fetch(url);
  }

  @AgentGate.policy('code_run')
  async execute(code) {
    return await runCode(code);
  }

  @AgentGate.policy('web_search')
  async search(query) {
    return await searchEngine(query);
  }
}

const agent = new ResearchAgent(gate);
await agent.scrape('https://example.com'); // Policy enforced
```

## 🔑 API Reference

### AgentGate SDK

| Method | Description |
|--------|-------------|
| `can({ tool, runId })` | Validate if agent can execute a tool |
| `consume({ tool, tokens, runId })` | Log usage, deduct quotas |
| `setRunning(bool)` | Track concurrent agent sessions |
| `status()` | Get current agent status + usage |
| `hasCapability(capability)` | Check if agent has a capability |
| `withPolicy(tool, fn)` | Wrap function with policy enforcement |
| `@gate.policy(tool)` | Decorator for class methods |

### Policy Engine Server

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/validate` | POST | Validate agent + tool |
| `/api/consume` | POST | Log usage metrics |
| `/api/consume/active` | POST | Track concurrent sessions |
| `/api/register` | POST | Register new agent |
| `/api/revoke` | POST | Revoke agent access |
| `/api/policy` | POST | Update agent policy |
| `/api/agents/:id` | GET | Get agent status |
| `/api/audit/:id` | GET | Get audit logs |
| `/api/webhook` | POST | Payment webhook |
| `/health` | GET | Health check |

## 📐 Policy Model

```json
{
  "agent_id": "ag-8f3a...",
  "tier": "pro",
  "capabilities": ["web_search", "browser", "mcp_execute", "code_run"],
  "allowed_tools": ["web_search", "browser", "mcp_execute", "code_run"],
  "quotas": {
    "max_runs_per_day": 200,
    "max_tokens_month": 50000,
    "max_concurrent": 5
  },
  "rate_limit": {
    "window_ms": 60000,
    "max_requests": 30
  },
  "expires": "2027-01-01T00:00:00Z",
  "revoked": false
}
```

## 💰 Pricing Tiers

| Tier | Runs/Day | Tokens/Mo | Concurrent | Tools | Price |
|------|----------|-----------|------------|-------|-------|
| Free | 10 | 1,000 | 1 | web_search | $0 |
| Starter | 50 | 10,000 | 2 | + code_run | $29/mo |
| Pro | 200 | 50,000 | 5 | + browser, mcp | $79/mo |
| Enterprise | 5,000 | 500,000 | 50 | + multi_agent | $299/mo |

## 🔐 Self-Hosted

```bash
# Environment variables
export SECRET_KEY=your-secret
export API_KEY=your-admin-key
export BLOCKONOMICS_API_KEY=your-btc-api
export SMTP_HOST=smtp.gmail.com
export SMTP_USER=your@email.com
export SMTP_PASS=your-app-password
export CB_URL=https://yourdomain.com

# Deploy
node server/server.js
```

## 🧪 Testing

```bash
# Health check
curl https://yourdomain.com/health

# Register test agent
curl -X POST https://yourdomain.com/api/register \
  -H "Content-Type: application/json" \
  -d '{"name": "test-agent", "tier": "pro"}'

# Validate agent
curl -X POST https://yourdomain.com/api/validate \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "ag-xxx", "tool": "browser", "run_id": "test-1"}'

# Consume usage
curl -X POST https://yourdomain.com/api/consume \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "ag-xxx", "tool": "browser", "tokens": 1000, "run_id": "test-1"}'
```

## 🔮 Roadmap

- [ ] PostgreSQL adapter (migrate from JSON file)
- [ ] Python SDK
- [ ] Grafana dashboards
- [ ] OAuth2 / JWT auth for agent sessions
- [ ] Usage analytics API
- [ ] Stripe / fiat payment integration
- [ ] Terraform / Docker images
- [ ] Agent-to-Agent policy delegation

## ⚠️ Production Readiness

- ✅ Policy validation engine
- ✅ Usage quotas & metering
- ✅ Rate limiting
- ✅ Audit logs
- ✅ Revocation system
- ✅ Crypto payment auto-provisioning
- ⚠️ JSON file storage (upgrade to PostgreSQL)
- ⚠️ Email delivery (configure SMTP)

## 📄 License

MIT

## 🤝 Built With

- Node.js + Express
- Blockonomics (crypto payments)
- Nodemailer (email notifications)

---

**"The first open-source policy engine for AI agent governance."**
