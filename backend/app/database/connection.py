"""Read-only DuckDB access with statement timeout and result-size limit."""
from __future__ import annotations

import datetime as dt
import decimal
import json
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import duckdb

from app.config import get_settings


class DatasetUnavailableError(RuntimeError):
    pass


class QueryTimeoutError(RuntimeError):
    pass


class QueryExecutionError(RuntimeError):
    pass


@dataclass
class QueryResult:
    columns: list[str]
    column_types: list[str]
    rows: list[list[Any]]
    row_count: int
    truncated: bool
    duration_ms: float
    extra: dict[str, Any] = field(default_factory=dict)


def dataset_available() -> bool:
    return get_settings().duckdb_path.exists()


_base_lock = threading.Lock()
_base: duckdb.DuckDBPyConnection | None = None


def _connect() -> duckdb.DuckDBPyConnection:
    """Return a cursor on one shared, locked-down, read-only database instance.

    DuckDB shares a database instance between connections to the same file inside a process,
    so the instance is configured exactly once: read-only, external (file/network) access
    disabled, configuration locked. Each query gets its own cursor (thread-safe).
    """
    global _base
    path = get_settings().duckdb_path
    if not path.exists():
        raise DatasetUnavailableError(
            "Dataset not loaded. Run `python -m scripts.prepare_data` in backend/ first."
        )
    with _base_lock:
        if _base is None:
            con = duckdb.connect(
                str(path),
                read_only=True,
                config={"enable_external_access": False, "threads": 4},
            )
            # Prevent any later SET from re-enabling external access (file / network reads).
            con.execute("SET lock_configuration = true")
            _base = con
        return _base.cursor()


def reset_connection() -> None:
    """Drop the shared instance (e.g. after the database file was rebuilt)."""
    global _base
    with _base_lock:
        if _base is not None:
            _base.close()
            _base = None


def to_jsonable(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, decimal.Decimal):
        return float(value)
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, (int, str, bool)):
        return value
    try:
        json.dumps(value)
        return value
    except TypeError:
        return str(value)


def run_query(sql: str, params: list[Any] | None = None, *, max_rows: int | None = None,
              timeout_s: float | None = None) -> QueryResult:
    """Execute a (pre-validated) read-only query.

    The connection is opened read-only with external access disabled, so even a query that
    slipped past validation cannot write data or read files. A watchdog interrupts the query
    when it exceeds the timeout.
    """
    settings = get_settings()
    max_rows = max_rows or settings.max_result_rows
    timeout_s = timeout_s or settings.query_timeout_seconds
    con = _connect()
    timed_out = threading.Event()

    def _interrupt() -> None:
        timed_out.set()
        try:
            con.interrupt()
        except Exception:  # pragma: no cover - best effort
            pass

    timer = threading.Timer(timeout_s, _interrupt)
    start = time.perf_counter()
    timer.start()
    try:
        cur = con.execute(sql, params or [])
        columns = [d[0] for d in cur.description] if cur.description else []
        types = [str(d[1]) for d in cur.description] if cur.description else []
        fetched = cur.fetchmany(max_rows + 1)
    except duckdb.InterruptException as exc:
        raise QueryTimeoutError(f"Query exceeded the {timeout_s:.0f}s time limit") from exc
    except duckdb.Error as exc:
        if timed_out.is_set():
            raise QueryTimeoutError(f"Query exceeded the {timeout_s:.0f}s time limit") from exc
        raise QueryExecutionError(_clean_error(str(exc))) from exc
    finally:
        timer.cancel()
        con.close()
    duration_ms = (time.perf_counter() - start) * 1000
    truncated = len(fetched) > max_rows
    rows = [[to_jsonable(v) for v in r] for r in fetched[:max_rows]]
    return QueryResult(columns, types, rows, len(rows), truncated, round(duration_ms, 1))


def _clean_error(message: str) -> str:
    """Keep the DuckDB error message useful but short (no internal paths / stack)."""
    first = message.strip().splitlines()[0] if message.strip() else "Query failed"
    return first[:400]


def fetch_metadata() -> dict[str, Any]:
    result = run_query("SELECT key, value FROM dataset_metadata")
    return {k: json.loads(v) for k, v in result.rows}
