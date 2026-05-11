"""
AgentGate SDK — License & Policy Enforcement for AI Agents (Python)

Install: pip install agentgate
Usage:
    from agentgate import AgentGate

    gate = AgentGate(
        server="https://agentgate.yourdomain.com",
        agent_id="ag-xxx",
        api_key="secret"
    )

    # Validate before running a tool
    result = await gate.can(tool="browser", run_id="x1")
    if result.allowed:
        await run_browser_agent()
        await gate.consume(tool="browser", tokens=1500, run_id="x1")

    # Or use decorator pattern
    class ResearchAgent:
        @gate.policy("browser")
        async def scrape(self, url):
            return await fetch(url)
"""

import asyncio
import json
import hashlib
import uuid
import time
from typing import Optional, Dict, Any, Callable, Awaitable
from dataclasses import dataclass, field


@dataclass
class ValidationResult:
    allowed: bool
    reason: Optional[str] = None
    policy: Optional[Dict[str, Any]] = None
    usage: Optional[Dict[str, Any]] = None
    run_id: str = ""
    agent_id: str = ""
    tool: str = ""


@dataclass
class ConsumeResult:
    logged: bool
    usage: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentStatus:
    id: str
    name: str
    created: str
    policy: Dict[str, Any]
    usage: Dict[str, Any]


class AgentGate:
    """
    AgentGate SDK for policy enforcement in AI agent systems.

    Provides license validation, usage quotas, rate limiting,
    capability ACLs, token metering, and revocation.

    Compatible with: CrewAI, LangChain, MCP, AutoGen, Claude tools,
    browser agents, coding agents, research agents.
    """

    def __init__(
        self,
        server: str = "https://agentgate.yourdomain.com",
        agent_id: str = "",
        api_key: str = "",
        timeout: int = 5000,
        cache_ttl: int = 60000,
    ):
        self.server = server.rstrip("/")
        self.agent_id = agent_id
        self.api_key = api_key
        self.timeout = timeout
        self.cache_ttl = cache_ttl
        self._cache: Dict[str, tuple] = {}

    # ─── HTTP Client ─────────────────────────────────────────────────────

    async def _request(
        self,
        path: str,
        method: str = "GET",
        body: Optional[Dict] = None,
    ) -> tuple[int, Dict]:
        """Make HTTP(S) request to the policy engine."""
        import httpx

        url = f"{self.server}{path}"
        headers = {
            "Content-Type": "application/json",
            "X-Agent-Id": self.agent_id,
            "X-API-Key": self.api_key,
        }

        async with httpx.AsyncClient(timeout=self.timeout / 1000) as client:
            if method == "GET":
                resp = await client.get(url, headers=headers)
            elif method == "POST":
                resp = await client.post(url, headers=headers, json=body or {})
            else:
                raise ValueError(f"Unsupported method: {method}")

            return resp.status_code, resp.json() if resp.content else {}

    # ─── Core Methods ────────────────────────────────────────────────────

    async def can(
        self,
        tool: str,
        run_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> ValidationResult:
        """
        Validate if an agent can execute a tool/run.

        Performs 5 layers of policy enforcement:
        1. Tool ACL — is this tool in the allowed list?
        2. Daily quota — are there runs left today?
        3. Monthly quota — are there tokens left this month?
        4. Concurrent limit — is there capacity?
        5. Rate limit — has the agent exceeded RPM?

        Args:
            tool: Tool identifier (web_search, browser, code_run, mcp_execute, etc.)
            run_id: Unique run identifier for tracking
            model: Model identifier (optional)

        Returns:
            ValidationResult with allowed/denied status and reason

        Raises:
            ValueError: If agent not found or access denied
        """
        if not tool:
            raise ValueError("Tool identifier required. Example: { tool: 'browser' }")

        cache_key = f"{self.agent_id}:{tool}"
        cached = self._cache.get(cache_key)
        if cached and (time.time() - cached[1]) * 1000 < self.cache_ttl:
            return cached[0]

        result_data, _ = await self._request(
            "/api/validate",
            "POST",
            {
                "agent_id": self.agent_id,
                "tool": tool,
                "run_id": run_id or self._uuid(),
                "model": model,
            },
        )

        result = ValidationResult(**result_data)
        self._cache[cache_key] = (result, time.time())
        return result

    async def consume(
        self,
        tool: str,
        tokens: int = 0,
        run_id: Optional[str] = None,
        cost_usd: float = 0.0,
        metadata: Optional[Dict] = None,
    ) -> ConsumeResult:
        """
        Log usage — deducts quotas, meters tokens, records in audit log.

        Args:
            tool: Tool identifier
            tokens: Token count for model usage (0 if not applicable)
            run_id: Same run_id from can() call
            cost_usd: Cost in USD (for billing)
            metadata: Additional context

        Returns:
            ConsumeResult with logged status and usage metrics
        """
        if not tool or not run_id:
            raise ValueError("tool and run_id required for consume()")

        status, result_data = await self._request(
            "/api/consume",
            "POST",
            {
                "agent_id": self.agent_id,
                "tool": tool,
                "tokens": tokens,
                "run_id": run_id,
                "cost_usd": cost_usd,
                "metadata": metadata,
            },
        )

        if status == 404:
            raise ValueError(f"Agent not found: {self.agent_id}")
        if status == 403:
            raise PermissionError(f"Agent access denied")

        return ConsumeResult(logged=True, usage=result_data.get("usage", {}))

    async def set_running(self, start: bool) -> Dict[str, int]:
        """
        Signal agent start/stop for concurrent execution tracking.

        Args:
            start: True to increment concurrent count, False to decrement

        Returns:
            Current concurrent count
        """
        _, result_data = await self._request(
            "/api/consume/active",
            "POST",
            {"agent_id": self.agent_id, "start": start},
        )
        return result_data

    async def status(self) -> AgentStatus:
        """
        Get current agent status and usage.

        Returns:
            AgentStatus with policy and usage data
        """
        status, result_data = await self._request(
            f"/api/agents/{self.agent_id}",
        )

        if status == 404:
            raise ValueError(f"Agent not found: {self.agent_id}")

        return AgentStatus(**result_data)

    async def has_capability(self, capability: str) -> bool:
        """
        Check if agent has a specific capability.

        Args:
            capability: e.g., "browser", "mcp_execute", "code_run"

        Returns:
            True if the agent has this capability
        """
        agent_status = await self.status()
        return capability in (agent_status.policy.get("capabilities") or [])

    # ─── Policy Wrappers ─────────────────────────────────────────────────

    def with_policy(
        self,
        tool: str,
    ) -> Callable:
        """
        Create a policy-wrapped async function.

        Usage:
            async def scrape(url):
                return await fetch(url)

            wrapped = gate.with_policy("browser")(scrape)
            await wrapped("https://example.com")  # Auto-validates + auto-consumes
        """
        def decorator(fn: Callable) -> Callable:
            async def wrapper(*args, **kwargs):
                run_id = self._uuid()
                result = await self.can(tool=tool, run_id=run_id)

                if not result.allowed:
                    raise PermissionError(f"AgentGate: {result.reason}")

                try:
                    output = await fn(*args, **kwargs)
                    await self.consume(tool=tool, run_id=run_id, tokens=0)
                    return output
                except Exception as e:
                    await self.consume(tool=tool, run_id=run_id, tokens=0).catch(lambda _: None)
                    raise
            return wrapper
        return decorator

    # ─── Utility ─────────────────────────────────────────────────────────

    def _uuid(self) -> str:
        return str(uuid.uuid4())


# ─── Decorator Factory ─────────────────────────────────────────────────────

def policy(tool: str):
    """
    Decorator for class methods that auto-enforces AgentGate policy.

    Usage:
        class MyAgent:
            def __init__(self, gate):
                self.gate = gate

            @policy("browser")
            async def scrape(self, url):
                return await fetch(url)
    """
    def decorator(fn: Callable) -> Callable:
        async def wrapper(self, *args, **kwargs):
            gate = getattr(self, "gate", None)
            if not gate:
                raise RuntimeError("No AgentGate instance. Set self.gate = AgentGate(...)")

            run_id = gate._uuid()
            result = await gate.can(tool=tool, run_id=run_id)

            if not result.allowed:
                raise PermissionError(f"AgentGate: {result.reason}")

            try:
                output = await fn(self, *args, **kwargs)
                await gate.consume(tool=tool, run_id=run_id, tokens=0)
                return output
            except Exception:
                try:
                    await gate.consume(tool=tool, run_id=run_id, tokens=0)
                except Exception:
                    pass
                raise
        return wrapper
    return decorator


# ─── MCP Integration ───────────────────────────────────────────────────────

def mcp_tool_wrapper(gate: AgentGate, tool_name: str):
    """
    Wrapper for MCP (Model Context Protocol) tools.

    Usage:
        @mcp_tool_wrapper(gate, "web_search")
        async def search(query: str) -> str:
            return await search_engine(query)
    """
    def decorator(fn: Callable) -> Callable:
        async def wrapper(*args, **kwargs):
            run_id = gate._uuid()
            result = await gate.can(tool=tool_name, run_id=run_id)

            if not result.allowed:
                raise PermissionError(f"AgentGate: {result.reason}")

            try:
                output = await fn(*args, **kwargs)
                await gate.consume(tool=tool_name, run_id=run_id, tokens=0)
                return output
            except Exception:
                try:
                    await gate.consume(tool=tool_name, run_id=run_id, tokens=0)
                except Exception:
                    pass
                raise
        return wrapper
    return decorator


# ─── CrewAI Integration ────────────────────────────────────────────────────

class AgentGateTask:
    """
    CrewAI task wrapper with policy enforcement.

    Usage:
        gate = AgentGate(...)

        task = AgentGateTask(
            gate=gate,
            tool="browser",
            description="Scrape competitor pricing",
            agent=my_crewai_agent,
        )
        result = await task.execute()
    """

    def __init__(
        self,
        gate: AgentGate,
        tool: str,
        description: str,
        agent: Any = None,
    ):
        self.gate = gate
        self.tool = tool
        self.description = description
        self.agent = agent

    async def execute(self, fn: Callable) -> Any:
        result = await self.gate.can(tool=self.tool)
        if not result.allowed:
            raise PermissionError(f"AgentGate: {result.reason}")

        try:
            output = await fn()
            await self.gate.consume(tool=self.tool, tokens=0)
            return output
        except Exception:
            try:
                await self.gate.consume(tool=self.tool, tokens=0)
            except Exception:
                pass
            raise
