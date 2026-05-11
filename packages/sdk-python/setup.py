from setuptools import setup, find_packages

setup(
    name="agentgate",
    version="0.1.0",
    description="License & Policy Enforcement SDK for AI Agents",
    py_modules=["agentgate"],
    python_requires=">=3.9",
    install_requires=["httpx>=0.25.0"],
    keywords=["agent", "ai", "governance", "policy", "quota", "rate-limit", "mcp", "langchain", "crewai"],
    author="AgentGate",
    license="MIT",
)
