# RetailPilot — AI Sales Intelligence Agent

RetailPilot lets retail managers ask sales questions in plain English and get answers computed from real transaction data. It works on the **UCI Online Retail II** dataset. For each question the agent:

1. decides whether the question is analytical, ambiguous, or out of scope;
2. has an LLM generate one DuckDB `SELECT`, plus an explanation and a chart suggestion, as structured JSON;
3. **validates the SQL with SQLGlot** (read-only, single statement, table/column allowlist, no file/system functions);
4. runs it on a **read-only** DuckDB connection, with a timeout and a row limit;
5. if the SQL fails, regenerates it **at most once** and re-validates the new SQL;
6. returns the summary, the exact SQL it ran, the rows, a chart, and the business rules it applied.

A built-in **reliability benchmark** contains 15 trap questions. Their expected answers come from independent hand-written SQL, and the benchmark scores the agent against them on the live data.

```
frontend/  React + TypeScript + Vite + MUI + Recharts + MUI X DataGrid
backend/   FastAPI + Pydantic + DuckDB + pandas + SQLGlot + Anthropic SDK + pytest
  app/api/         HTTP routes, dashboard/explorer queries, error handling
  app/agent/       workflow, prompts, LLM provider adapters, ambiguity guard, chart choice
  app/security/    SQL AST validator
  app/database/    read-only connection, schema allowlist, business rules (single source of truth)
  app/benchmarks/  trap questions, reference SQL, comparison, runner
  scripts/         prepare_data.py, init_db.py, run_benchmark.py
  tests/           pytest suite
docs/      API.md, DEMO_QUESTIONS.md
```

---

## 1. Setup (local development)

Prerequisites: **Python 3.11+**, **Node.js 20+**.

### 1.1 Get the dataset
Download **Online Retail II** from the UCI Machine Learning Repository:
<https://archive.ics.uci.edu/dataset/502/online+retail+ii> (CC BY 4.0). Unzip it to get `online_retail_II.xlsx`, which contains two worksheets: *Year 2009-2010* and *Year 2010-2011*.

The default location is `online+retail+ii/online_retail_II.xlsx` at the repository root. You can also pass `--excel` to point at another location.

### 1.2 Backend
```bash
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                  # then set ANTHROPIC_API_KEY
python -m scripts.prepare_data                        # or: --excel /path/to/online_retail_II.xlsx  (~1 min)
python -m scripts.init_db                             # verifies the database and schema
uvicorn app.main:app --reload --port 8000
```

### 1.3 Frontend
```bash
cd frontend
npm install
npm run dev            # http://localhost:5173  (proxies /api to :8000)
```

### 1.4 Tests and benchmark
```bash
cd backend
python -m pytest -q                 # 75 tests; they always use the offline provider (no API cost)
python -m scripts.run_benchmark     # runs the 15 trap questions with the configured provider
```

### LLM configuration
| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | `anthropic`, or `offline` for the deterministic rule-based demo planner |
| `ANTHROPIC_API_KEY` | – | read **only** by the backend; never sent to the browser or stored in history |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | any Messages-API model id |
| `ANTHROPIC_EFFORT` | `low` | `low` / `medium` / `high` |

If `LLM_PROVIDER=anthropic` and no key is set, the app falls back to the **offline planner** and labels it everywhere: the header chip, the Settings page, a benchmark banner, and the history entries. The offline planner is **not an LLM**. It maps a fixed set of question patterns to SQL templates so the app can be demoed and tested without an API key, and its SQL goes through the same validator and executor as LLM SQL.

**Switching provider:** implement `LLMProvider.plan()` in `backend/app/agent/providers.py` (it returns the `AgentPlan` Pydantic model), then register it in `get_provider()`. Nothing else changes.

The Anthropic adapter uses structured outputs (`messages.parse` with the `AgentPlan` schema). It also enables the server-side refusal fallback (`fallbacks: "default"`), so a declined request is retried on a fallback model within the same call.

---

## 2. Data rules

All rules live in `backend/app/database/business_rules.py`. The data preparation step, the LLM prompt, the dashboard, the benchmark and the UI all use these definitions; the **Data Explorer** and **Settings** pages display them.

| Topic | Rule |
|---|---|
| **Currency** | GBP (£). `line_amount = quantity × unit_price`. |
| **Period** | 2009-12-01 → 2011-12-09. December 2011 is a partial month. |
| **Worksheet overlap** | Both worksheets contain **2010-12-01 → 2010-12-09** (22,523 identical rows, 1,088 invoices). Loading both would double-count that week. After verifying the copies are an exact multiset match, the script removes the second copy. This is the only removal: 1,067,371 source rows → **1,044,848 loaded**. It is recorded in `dataset_metadata` and shown in the UI. |
| **Line types** | Every row gets exactly one: `SALE` (qty > 0, price > 0), `CANCELLATION` (invoice starts with **C**), `STOCK_ADJUSTMENT` (qty ≤ 0 on a non-C invoice, e.g. damaged or lost stock), `ZERO_PRICE` (qty > 0, price ≤ 0), `BAD_DEBT_ADJUSTMENT` (invoice starts with **A**). |
| **Negative quantities** | They come from cancellations (19,164 lines) **and** stock adjustments (3,393 lines). Only cancellations count as returns. Stock write-offs are never treated as customer returns. |
| **Cancellations / returns** | The dataset does not separate order cancellations from returns, so they are reported together. They are **deducted** in net revenue and reported separately everywhere else, with the cancelled value shown as a positive amount. |
| **Returned units vs return transactions** | Returned units = −Σ quantity on CANCELLATION product lines. Return transactions = count of distinct C invoices. The two are never mixed. |
| **Gross revenue** | Σ `line_amount` of SALE lines for PRODUCT items. |
| **Net revenue** (the default meaning of "revenue"/"sales") | Σ `line_amount` of SALE + CANCELLATION lines for PRODUCT items. |
| **Orders** | Distinct invoices with at least one SALE line. |
| **Non-product codes** | `POST`, `DOT`, `C2` → POSTAGE; `BANK CHARGES`, `AMAZONFEE`, `CRUK` → FEE; `M`, `ADJUST`, `ADJUST2`, `B` → MANUAL_ADJUSTMENT; `D` → DISCOUNT; `S` → SAMPLE; `TEST001/2` → TEST; `gift_0001_*` → GIFT_VOUCHER. These are excluded from product revenue and rankings, and can be reported on their own. |
| **Missing customer IDs** | 235,287 lines (22.5%). Kept in revenue, product and country totals, and excluded from customer rankings. Answers say so, and the dashboard shows the unattributed net revenue (£2.57m). |
| **Duplicates** | 11,812 exact duplicate rows within a worksheet are **retained** (they cannot be proven to be errors) and counted in the Data Explorer. |
| **Ambiguity** | "Best/top customers" or "best-selling products" without a metric always triggers a clarifying question (deterministic guard plus the LLM's own judgement). |

---

## 3. Security model
- **Read-only database:** one shared DuckDB instance opened with `read_only=True` and `enable_external_access=false`, with `lock_configuration` set. A test proves that even SQL which bypasses the validator cannot write, read files, or change settings.
- **SQL AST validation** (`app/security/sql_validator.py`): exactly one statement; the root must be SELECT or a set operation; no DML, DDL, PRAGMA, SET, COPY, ATTACH or similar nodes; the only allowed table is `transactions`; all columns must be allowlisted or defined in the query; file, system and settings functions (`read_*`, `glob`, `getenv`, `duckdb_*`, …) are blocked. The **validated AST is re-rendered, and that text is what runs and what the UI displays.**
- **Limits:** 10 s statement timeout (a watchdog calls `interrupt()`), 1,000-row result cap, 500-character question limit.
- **Untrusted LLM output:** the LLM only returns JSON. It never executes code, shell commands or file operations, and prompt instructions are not relied on for safety.
- **Errors:** responses use `{"error": {"code", "message"}}` and never include stack traces. Empty results, execution errors, rejected SQL and unsupported questions each get a distinct status.
- **Secrets:** the API key is read from the backend environment only. `/api/health` and `/api/settings` report provider and model, never the key.

---

## 4. Reliability benchmark
`backend/app/benchmarks/cases.py` defines 15 cases: top products, monthly aggregation, country comparison, cancelled value, cancellation count, returned units, missing customer IDs, postage (non-product lines), orders, top customers, two ambiguous questions, one empty-result question, one unsupported question (profit margin) and one unsafe request (delete).

- **Reference SQL is independent.** It works from raw columns (invoice prefix, quantity, price, stock-code lists) rather than the derived `line_type`/`item_type` columns the agent uses, so a pass also cross-checks the data preparation.
- **Comparison:** grouped results are matched by key and are order-insensitive. Top-N cases compare the set of top keys. Numbers are compared with a 0.5% relative / £0.51 absolute tolerance. Dates are normalised to `YYYY-MM`.
- **Reported separately:** exact result-match rate, SQL execution success rate (*execution success is not correctness*), clarification success, and unsupported/empty handling. Failed cases show a reason.
- If the dataset is missing, the benchmark refuses to run.

**Current measured results:** the **offline rule-based planner** passes 15/15. Treat that as a check of the pipeline and the reference SQL, not as evidence of LLM accuracy: its templates were written for these question types. While it was being built, the benchmark caught two real planner bugs (the postage question routed to cancellations, and clarification text that leaked a keyword), and both were fixed in the planner, not the tests. **The LLM path has not been benchmarked in this environment because no API key was available.** Set `ANTHROPIC_API_KEY` and press *Run benchmark* (or run `python -m scripts.run_benchmark`) to measure it.

---

## 5. Deployment

**Single process:** run `npm run build` in `frontend/`; FastAPI then serves `frontend/dist` and the API on one port:
```bash
cd backend && uvicorn app.main:app --host 0.0.0.0 --port 8000
```

**Docker** (FastAPI + built frontend in one image; the data stays outside the image):
```bash
cd backend && python -m scripts.prepare_data            # creates backend/data/retail.duckdb
cd .. && docker build -t retailpilot .
docker run -p 8000:8000 -e ANTHROPIC_API_KEY=... -v "$PWD/backend/data:/app/backend/data" retailpilot
```
On Render or Hugging Face Spaces, use the Dockerfile, set `ANTHROPIC_API_KEY` as a secret, and provide `retail.duckdb` (about 20 MB) through a persistent disk, or run `prepare_data` at build time with the workbook available. Restart the server after rebuilding the database.

---

## 6. Design
The UI follows the uploaded **Vision UI Dashboard** reference image: deep-navy canvas, translucent navy cards, blue (#0075FF) and purple accents, a collapsible sidebar with an icon rail, and Plus Jakarta Sans. The reference is fully dark, so content areas are dark too, rather than the light content background mentioned in the brief. The Figma file itself was not inspected; the layout reproduces the visual language of the screenshot, not exact frames. Chart colours were checked for colour-vision-deficiency separation and ≥3:1 contrast on the card surface. Pages were checked at 390 px, 768 px and 1440 px for horizontal overflow and console errors.

## 7. Known limitations
- The LLM path has been verified end-to-end against a mocked Messages API, not the live API, because no key was available here.
- The offline planner only understands the documented question families; anything else is reported as unsupported.
- Conversation context uses the last 4 turns. History stores up to 200 rows per result, and reopening a long result says so.
- The Dockerfile was written but not built in this environment.
