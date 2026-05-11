/**
 * AgentGate SDK — License & Policy Enforcement for AI Agents
 *
 * Install: npm install @agentgate/sdk
 *
 * Usage:
 *   const gate = new AgentGate({
 *     server: "https://agentgate.yourdomain.com",
 *     agentId: "ag-xxx",
 *     apiKey: "xxx"
 *   });
 *
 *   // Before running any tool/agent action
 *   const result = await gate.can({ tool: "browser", runId: "x1" });
 *   if (result.allowed) {
 *     await runYourAgentCode();
 *     await gate.consume({ tool: "browser", tokens: 1500, runId: "x1" });
 *   } else {
 *     throw new Error(`Access denied: ${result.reason}`);
 *   }
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

class AgentGate {
  constructor(options = {}) {
    this.server = options.server || 'https://agentgate.yourdomain.com';
    this.agentId = options.agentId || '';
    this.apiKey = options.apiKey || '';
    this.timeout = options.timeout || 5000;
    this.cache = new Map();
    this.cacheTtl = options.cacheTtl || 60000; // 1 min
  }

  /**
   * Make an HTTP(S) request
   */
  async request(path, method = 'GET', body = null) {
    const url = new URL(path, this.server);
    const mod = url.protocol === 'https:' ? https : http;

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': this.agentId,
        'X-API-Key': this.apiKey,
      },
      timeout: this.timeout,
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(JSON.stringify(body));
    }

    return new Promise((resolve, reject) => {
      const req = mod.request(url.toString(), options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Validate if an agent can execute a tool/run.
   *
   * @param {Object} params
   * @param {string} params.tool - Tool identifier (web_search, browser, code_run, mcp_execute, etc.)
   * @param {string} [params.runId] - Unique run identifier for tracking
   * @param {string} [params.model] - Model identifier (optional)
   * @returns {Promise<{allowed: boolean, reason?: string, policy?: Object, usage?: Object, run_id: string}>}
   */
  async can(params = {}) {
    const { tool, runId, model } = params;

    if (!tool) {
      throw new Error('Tool identifier required. Example: { tool: "browser" }');
    }

    const cacheKey = `${this.agentId}:${tool}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtl) {
      return cached.data;
    }

    const result = await this.request('/api/validate', 'POST', {
      agent_id: this.agentId,
      tool,
      run_id: runId || crypto.randomUUID(),
      model,
    });

    if (result.status === 404) {
      throw new Error(`Agent not found: ${this.agentId}`);
    }

    if (result.status === 403) {
      throw new Error(`Agent access denied: ${result.body.reason}`);
    }

    const data = result.body;
    this.cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }

  /**
   * Log usage — deducts quotas, meters tokens, records in audit log.
   *
   * @param {Object} params
   * @param {string} params.tool - Tool identifier
   * @param {number} [params.tokens] - Token count for model usage (0 if not applicable)
   * @param {string} params.runId - Same runId from can() call
   * @param {number} [params.cost_usd] - Cost in USD (for billing)
   * @param {Object} [params.metadata] - Additional context
   * @returns {Promise<{logged: boolean, usage: Object}>}
   */
  async consume(params = {}) {
    const { tool, tokens = 0, runId, cost_usd = 0, metadata } = params;

    if (!tool || !runId) {
      throw new Error('tool and runId required for consume()');
    }

    const result = await this.request('/api/consume', 'POST', {
      agent_id: this.agentId,
      tool,
      tokens,
      run_id: runId,
      cost_usd,
      metadata,
    });

    return result.body;
  }

  /**
   * Signal agent start/stop for concurrent execution tracking.
   *
   * @param {boolean} start - true to increment, false to decrement
   * @returns {Promise<{concurrent: number}>}
   */
  async setRunning(start) {
    const result = await this.request('/api/consume/active', 'POST', {
      agent_id: this.agentId,
      start: !!start,
    });
    return result.body;
  }

  /**
   * Get current agent status and usage.
   *
   * @returns {Promise<{id: string, name: string, policy: Object, usage: Object}>}
   */
  async status() {
    const result = await this.request(`/api/agents/${this.agentId}`);
    if (result.status === 404) {
      throw new Error(`Agent not found: ${this.agentId}`);
    }
    return result.body;
  }

  /**
   * Check if agent has a specific capability.
   *
   * @param {string} capability - e.g., "browser", "mcp_execute", "code_run"
   * @returns {Promise<boolean>}
   */
  async hasCapability(capability) {
    const status = await this.status();
    return (status.policy.capabilities || []).includes(capability);
  }

  /**
   * Create a wrapped tool executor that auto-validates and meters.
   *
   * @param {string} tool - Tool identifier
   * @param {Function} fn - Async function to execute
   * @returns {Function} Wrapped function
   */
  withPolicy(tool, fn) {
    return async (...args) => {
      const runId = crypto.randomUUID();
      const result = await this.can({ tool, runId });

      if (!result.allowed) {
        throw new Error(`AgentGate: ${result.reason}`);
      }

      try {
        const output = await fn(...args);

        // Auto-consume with 0 tokens (override if you know token count)
        await this.consume({ tool, runId, tokens: 0 });

        return output;
      } catch (err) {
        // Still log the run even if it failed
        await this.consume({ tool, runId, tokens: 0 }).catch(() => {});
        throw err;
      }
    };
  }

  /**
   * Generate a policy enforcement decorator for class methods.
   *
   * Usage:
   *   class MyAgent {
   *     @gate.policy('browser')
   *     async scrape(url) { ... }
   *
   *     @gate.policy('code_run')
   *     async execute(code) { ... }
   *   }
   */
  static policy(tool) {
    return function(target, name, descriptor) {
      const original = descriptor.value;
      descriptor.value = async function(...args) {
        const gate = this.gate;
        if (!gate) {
          throw new Error('No AgentGate instance. Set this.gate = new AgentGate({...})');
        }
        return gate.withPolicy(tool, original).call(this, ...args);
      };
      return descriptor;
    };
  }
}

// Make crypto.randomUUID available for Node < 19
const crypto = require('crypto');
if (!crypto.randomUUID) {
  crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.randomBytes(1)[0] % 16;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = AgentGate;
