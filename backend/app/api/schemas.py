"""Request models (responses are plain JSON dicts documented in docs/API.md)."""
from __future__ import annotations

from pydantic import BaseModel, Field


class AgentQueryRequest(BaseModel):
    question: str = Field(default="", max_length=2000, description="Natural-language question")
    conversation_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]*$")
    clarification_response: str | None = Field(default=None, max_length=200,
                                                description="Answer to the agent's clarifying question")
