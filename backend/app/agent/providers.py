"""LLM provider adapters.

Every provider implements `plan(system, user, context) -> AgentPlan`. To add a provider (e.g.
another hosted LLM), implement `LLMProvider` and register it in `get_provider`. Credentials are
read only from backend environment variables and never returned by the API.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from functools import lru_cache

from app.agent.models import AgentPlan, ConversationTurn
from app.config import get_settings

log = logging.getLogger(__name__)


class LLMError(RuntimeError):
    """Provider failure with a message that is safe to show to users."""


@dataclass
class PlanContext:
    question: str
    history: list[ConversationTurn] = field(default_factory=list)
    clarification: str | None = None
    error_feedback: str | None = None
    previous_sql: str | None = None


class LLMProvider(ABC):
    name: str = "base"
    model: str = ""
    is_llm: bool = True

    @abstractmethod
    def plan(self, system: str, user: str, context: PlanContext) -> AgentPlan: ...

    def status(self) -> dict:
        return {"provider": self.name, "model": self.model, "is_llm": self.is_llm, "configured": True}


class AnthropicProvider(LLMProvider):
    name = "anthropic"
    is_llm = True

    def __init__(self, api_key: str, model: str, effort: str, timeout: float) -> None:
        import anthropic

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=2)
        self.model = model
        self.effort = effort

    def plan(self, system: str, user: str, context: PlanContext) -> AgentPlan:
        a = self._anthropic
        try:
            response = self._client.beta.messages.parse(
                model=self.model,
                max_tokens=16000,
                system=system,
                messages=[{"role": "user", "content": user}],
                output_format=AgentPlan,
                output_config={"effort": self.effort},
                # Server-side refusal fallback: if the model declines, the API retries on a
                # fallback model inside the same call.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except a.AuthenticationError as exc:
            raise LLMError("The LLM provider rejected the configured credentials.") from exc
        except a.RateLimitError as exc:
            raise LLMError("The LLM provider is rate limiting requests. Please retry shortly.") from exc
        except a.BadRequestError as exc:
            log.warning("LLM bad request: %s", exc)
            raise LLMError("The LLM provider rejected the request.") from exc
        except a.APIStatusError as exc:
            raise LLMError(f"The LLM provider returned an error (HTTP {exc.status_code}).") from exc
        except a.APIConnectionError as exc:
            raise LLMError("Could not reach the LLM provider.") from exc

        if response.stop_reason == "refusal":
            raise LLMError("The model declined to answer this question.")
        if response.stop_reason == "max_tokens":
            raise LLMError("The model response was truncated.")
        plan = response.parsed_output
        if plan is None:
            raise LLMError("The model did not return a valid structured plan.")
        return plan

    def status(self) -> dict:
        return {"provider": self.name, "model": self.model, "is_llm": True, "configured": True}


@lru_cache
def get_provider() -> LLMProvider:
    settings = get_settings()
    choice = settings.llm_provider.lower().strip()
    if choice == "anthropic" and settings.anthropic_api_key:
        return AnthropicProvider(
            settings.anthropic_api_key, settings.anthropic_model, settings.anthropic_effort,
            settings.llm_timeout_seconds,
        )
    from app.agent.offline_provider import OfflineRuleProvider

    provider = OfflineRuleProvider()
    if choice == "anthropic":
        provider.fallback_reason = "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set"
    return provider
