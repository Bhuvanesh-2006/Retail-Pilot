"""The question -> SQL -> validated execution workflow.

1. Validate input, load conversation context.
2. Deterministic ambiguity guard (designated ambiguous phrasings always ask back).
3. Ask the provider for a structured plan (intent, SQL, explanation, chart, rules).
4. Validate SQL with SQLGlot (read-only, single statement, table/column allowlists).
5. Execute on a read-only connection with timeout and row limit.
6. On a correctable validation/execution error, allow at most ONE regeneration, re-validated.
7. Build the response from the rows actually returned.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from app.agent.ambiguity import check_ambiguity
from app.agent.models import AgentPlan
from app.agent.presentation import choose_chart, summarize
from app.agent.prompts import system_prompt, user_prompt
from app.agent.providers import LLMError, PlanContext, get_provider
from app.config import get_settings
from app.database import connection
from app.database.business_rules import BUSINESS_RULES
from app import history
from app.security.sql_validator import SQLValidationError, validate_sql

log = logging.getLogger(__name__)
RULES_BY_ID = {r["id"]: r for r in BUSINESS_RULES}
MAX_REGENERATIONS = 1


class InputError(ValueError):
    pass


def _rules(ids: list[str]) -> list[dict[str, str]]:
    seen, out = set(), []
    for rid in [*ids, "currency"]:
        if rid in RULES_BY_ID and rid not in seen:
            seen.add(rid)
            r = RULES_BY_ID[rid]
            out.append({"id": r["id"], "name": r["name"], "definition": r["definition"]})
    return out


def _base(conversation_id: str, question: str, provider) -> dict[str, Any]:
    return {
        "query_id": uuid.uuid4().hex,
        "conversation_id": conversation_id,
        "created_at": history.now_iso(),
        "question": question,
        "status": "error",
        "answer": "",
        "explanation": None,
        "sql": None,
        "columns": [],
        "rows": [],
        "row_count": 0,
        "truncated": False,
        "chart": None,
        "clarification": None,
        "business_rules": [],
        "error": None,
        "execution": {
            "provider": provider.name, "model": provider.model, "is_llm": provider.is_llm,
            "attempts": 0, "validated": False, "db_ms": None, "total_ms": None,
            "regenerated": False, "max_rows": get_settings().max_result_rows,
            "timeout_s": get_settings().query_timeout_seconds,
        },
    }


def answer_question(question: str, conversation_id: str | None = None, clarification: str | None = None,
                    record: bool = True) -> dict[str, Any]:
    settings = get_settings()
    question = (question or "").strip()
    clarification = (clarification or "").strip() or None
    if not question:
        raise InputError("Please enter a question.")
    if len(question) > settings.max_question_length:
        raise InputError(f"Questions are limited to {settings.max_question_length} characters.")
    if clarification and len(clarification) > 200:
        raise InputError("Clarification is too long.")

    started = time.perf_counter()
    provider = get_provider()
    conversation_id = conversation_id or uuid.uuid4().hex
    hist = history.conversation_history(conversation_id) if record else []
    resp = _base(conversation_id, question, provider)
    if clarification:
        resp["clarification_response"] = clarification

    def finish() -> dict[str, Any]:
        resp["execution"]["total_ms"] = round((time.perf_counter() - started) * 1000, 1)
        if record:
            try:
                history.save(resp, question, clarification)
            except Exception:  # history must never break answering
                log.exception("failed to save history")
        return resp

    if not connection.dataset_available():
        resp.update(status="error", answer="The dataset is not loaded yet.",
                    error={"code": "dataset_unavailable", "message": "Run the data preparation script first.", "retryable": False})
        return finish()

    if not clarification:
        amb = check_ambiguity(question)
        if amb:
            resp.update(status="clarification", answer=amb.question,
                        clarification={"question": amb.question, "options": amb.options, "source": "ambiguity_rules"})
            return finish()

    ctx = PlanContext(question=question, history=hist, clarification=clarification)
    system = system_prompt()
    plan: AgentPlan | None = None
    feedback: str | None = None
    validated = None
    result = None

    for attempt in range(MAX_REGENERATIONS + 1):
        resp["execution"]["attempts"] = attempt + 1
        resp["execution"]["regenerated"] = attempt > 0
        ctx.error_feedback = feedback
        try:
            plan = provider.plan(system, user_prompt(question, hist, clarification, feedback), ctx)
        except LLMError as exc:
            resp.update(status="error", answer="The language model could not produce a plan.",
                        error={"code": "llm_error", "message": str(exc), "retryable": True})
            return finish()

        resp["explanation"] = plan.explanation
        resp["business_rules"] = _rules(plan.business_rules)

        if plan.intent == "clarification":
            options = [o for o in plan.clarification_options if o][:4]
            q = plan.clarification_question or "Could you clarify what you mean?"
            resp.update(status="clarification", answer=q,
                        clarification={"question": q, "options": options, "source": "model"})
            return finish()
        if plan.intent == "unsupported" or not plan.sql:
            reason = plan.unsupported_reason or "This question cannot be answered from the transaction data."
            resp.update(status="unsupported", answer=reason)
            return finish()

        resp["sql"] = plan.sql
        try:
            validated = validate_sql(plan.sql)
        except SQLValidationError as exc:
            resp["execution"]["validated"] = False
            if attempt < MAX_REGENERATIONS:
                feedback = f"SQL:\n{plan.sql}\nVALIDATION ERROR: {exc}"
                continue
            resp.update(status="rejected", answer="The generated SQL was rejected by the safety validator and was not executed.",
                        error={"code": "sql_rejected", "message": str(exc), "retryable": True})
            return finish()

        resp["sql"] = validated.sql
        resp["execution"]["validated"] = True
        try:
            result = connection.run_query(validated.sql)
            break
        except connection.QueryTimeoutError as exc:
            resp.update(status="error", answer="The query took too long and was stopped.",
                        error={"code": "timeout", "message": str(exc), "retryable": True})
            return finish()
        except connection.QueryExecutionError as exc:
            if attempt < MAX_REGENERATIONS:
                feedback = f"SQL:\n{validated.sql}\nDATABASE ERROR: {exc}"
                continue
            resp.update(status="error", answer="The query failed to execute.",
                        error={"code": "execution_error", "message": str(exc), "retryable": True})
            return finish()
        except connection.DatasetUnavailableError as exc:
            resp.update(status="error", answer="The dataset is not loaded yet.",
                        error={"code": "dataset_unavailable", "message": str(exc), "retryable": False})
            return finish()

    assert result is not None and plan is not None
    resp["columns"] = [{"name": n, "type": t} for n, t in zip(result.columns, result.column_types)]
    resp["rows"] = result.rows
    resp["row_count"] = result.row_count
    resp["truncated"] = result.truncated
    resp["execution"]["db_ms"] = result.duration_ms
    all_null = bool(result.rows) and all(v is None for row in result.rows for v in row)
    resp["status"] = "success" if result.rows and not all_null else "empty"
    resp["answer"] = summarize(result.columns, result.column_types, result.rows, result.truncated)
    if all_null:
        resp["answer"] = ("The query ran successfully but found no matching transactions (all values are empty). "
                          "The dataset covers 2009-12-01 to 2011-12-09.")
    resp["chart"] = choose_chart(plan.chart, result.columns, result.column_types, result.rows)
    return finish()
