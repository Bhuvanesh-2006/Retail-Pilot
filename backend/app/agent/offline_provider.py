"""Deterministic, rule-based planner used when no LLM is configured.

This is NOT an LLM. It maps a fixed set of question patterns to SQL templates so the app can be
demonstrated and tested offline. The UI and benchmark label results produced by it as
"offline rule-based". Its SQL goes through exactly the same validation and execution path.
"""
from __future__ import annotations

import re
from functools import lru_cache

from app.agent.models import AgentPlan, ChartSpec
from app.agent.providers import LLMProvider, PlanContext

WRITE_WORDS = re.compile(r"\b(delete|drop|truncate|insert into|alter table|grant|attach|remove all|overwrite)\b", re.I)
UNSUPPORTED_TOPICS = re.compile(
    r"\b(profit|margin|cost of goods|costs?|cogs|forecast|predict|next (month|year|quarter)|stock levels?|"
    r"inventory|warehouse|employee|staff|salar(y|ies)|marketing|campaign|ad spend|website traffic|"
    r"weather|competitor|tax(es)?|vat)\b",
    re.I,
)
FOLLOW_UP = re.compile(r"^\s*(now|only|just|what about|how about|and|same)\b", re.I)

COUNTRY_ALIASES = {
    "uk": "United Kingdom", "u.k.": "United Kingdom", "britain": "United Kingdom",
    "england": "United Kingdom", "ireland": "EIRE", "usa": "USA",
    "united states": "USA", "holland": "Netherlands",
}


@lru_cache
def _countries() -> list[str]:
    from app.database.connection import run_query

    try:
        res = run_query("SELECT DISTINCT country FROM transactions WHERE country IS NOT NULL")
        return sorted((r[0] for r in res.rows), key=len, reverse=True)
    except Exception:
        return []


def _sql_str(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class OfflineRuleProvider(LLMProvider):
    name = "offline"
    model = "rule-based templates (no LLM)"
    is_llm = False
    fallback_reason: str | None = None

    def status(self) -> dict:
        return {
            "provider": self.name, "model": self.model, "is_llm": False, "configured": True,
            "note": self.fallback_reason or "Offline demo mode selected",
        }

    # ------------------------------------------------------------------ parsing helpers
    @staticmethod
    def _top_n(q: str, default: int = 10) -> int:
        m = re.search(r"\b(?:top|best|first|largest|biggest)\s+(\d{1,3})\b", q) or re.search(
            r"\b(\d{1,3})\s+(?:products?|items?|customers?|countries|markets?)\b", q
        )
        return max(1, min(int(m.group(1)), 100)) if m else default

    @staticmethod
    def _year(q: str) -> int | None:
        m = re.search(r"\b(19\d\d|20\d\d)\b", q)
        return int(m.group(1)) if m else None

    @staticmethod
    def _country(q: str) -> str | None:
        low = q.lower()
        for c in _countries():
            if re.search(r"\b" + re.escape(c.lower()) + r"\b", low):
                return c
        for alias, country in COUNTRY_ALIASES.items():
            if re.search(r"(?<![\w.])" + re.escape(alias) + r"(?![\w])", low):
                return country
        return None

    @staticmethod
    def _metric(q: str) -> str:
        if re.search(r"\b(invoices?|orders?|order count|purchases|transactions)\b", q) and not re.search(r"\b(revenue|sales value|spend)\b", q):
            return "invoices"
        if re.search(r"\b(units?|quantity|volume|pieces)\b", q):
            return "units"
        if re.search(r"\bgross\b", q):
            return "gross"
        return "net"

    # ------------------------------------------------------------------ main entry
    def plan(self, system: str, user: str, context: PlanContext) -> AgentPlan:
        q = context.question.strip()
        if context.clarification:
            # Option labels carry explanations in parentheses; only the metric name matters here.
            q = f"{q} by {re.sub(r'\(.*?\)', '', context.clarification).strip()}"
        if FOLLOW_UP.match(q) and context.history:
            previous = next((t for t in reversed(context.history) if t.sql), None)
            if previous:
                q = f"{previous.question} {q}"
        ql = q.lower()

        if WRITE_WORDS.search(ql):
            return AgentPlan(intent="unsupported", explanation="Request asks to modify data.",
                             unsupported_reason="RetailPilot has read-only access and cannot modify, delete or create data.")
        if UNSUPPORTED_TOPICS.search(ql):
            return AgentPlan(
                intent="unsupported", explanation="The dataset has no field that can answer this.",
                unsupported_reason="The dataset contains invoices (quantities, prices, customers, countries) only. "
                "It has no cost, margin, inventory, marketing or forecast data.",
            )

        filters: list[str] = []
        year = self._year(ql)
        if year:
            filters.append(f"invoice_year = {year}")
        country = self._country(ql)
        if country:
            filters.append(f"country = {_sql_str(country)}")
        n = self._top_n(ql)
        metric = self._metric(ql)
        scope = []
        if year:
            scope.append(str(year))
        if country:
            scope.append(country)
        scope_txt = f" ({', '.join(scope)})" if scope else ""

        def where(*extra: str) -> str:
            parts = list(extra) + filters
            return ("WHERE " + " AND ".join(parts)) if parts else ""

        net = "ROUND(SUM(line_amount) FILTER (WHERE line_type IN ('SALE','CANCELLATION')), 2)"
        gross = "ROUND(SUM(line_amount) FILTER (WHERE line_type = 'SALE'), 2)"

        if re.search(r"\b(hours?|hourly|weekdays?|day of (the )?week|weekends?|quarters?|quarterly|seasons?)\b", ql):
            return AgentPlan(
                intent="unsupported", explanation="Grouping not available offline.",
                unsupported_reason="Offline mode cannot group by hour, weekday or quarter. Configure an LLM provider "
                "for this question, or ask by day, month or year.",
            )

        # Day-level questions: "On which date ... maximum revenue?"
        if re.search(r"\b(date|dates|day|days|daily|when)\b", ql):
            code = re.search(r"\b(\d{5}[a-z]{0,2})\b", ql)
            day_net = "ROUND(SUM(line_amount) FILTER (WHERE line_type IN ('SALE','CANCELLATION')), 2)"
            if code or re.search(r"each of the top|best day for each|per product|for each product", ql):
                product_filter = [f"upper(stock_code) = {_sql_str(code.group(1).upper())}"] if code else []
                limit_products = "" if code else f"\n  ORDER BY total_net DESC\n  LIMIT {n}"
                sql = f"""WITH totals AS (
  SELECT stock_code, SUM(line_amount) FILTER (WHERE line_type IN ('SALE','CANCELLATION')) AS total_net
  FROM transactions
  {where("item_type = 'PRODUCT'", *product_filter)}
  GROUP BY stock_code{limit_products}
),
daily AS (
  SELECT stock_code, ANY_VALUE(description) AS description, CAST(invoice_date AS DATE) AS invoice_day,
         {day_net} AS day_net_revenue_gbp
  FROM transactions
  {where("item_type = 'PRODUCT'", "stock_code IN (SELECT stock_code FROM totals)")}
  GROUP BY stock_code, invoice_day
)
SELECT d.stock_code, d.description, d.invoice_day AS best_day, d.day_net_revenue_gbp AS best_day_net_revenue_gbp,
       ROUND(t.total_net, 2) AS total_net_revenue_gbp
FROM daily AS d JOIN totals AS t ON d.stock_code = t.stock_code
QUALIFY ROW_NUMBER() OVER (PARTITION BY d.stock_code ORDER BY d.day_net_revenue_gbp DESC) = 1
ORDER BY total_net_revenue_gbp DESC"""
                who = f"product {code.group(1).upper()}" if code else f"each of the top {n} products by net revenue"
                return AgentPlan(intent="analytical", sql=sql,
                                 explanation=f"Best invoice day for {who}{scope_txt}, by net revenue that day "
                                 "(sales minus cancellations dated the same day).",
                                 business_rules=["net_revenue", "cancellations", "non_product"],
                                 chart=ChartSpec(type="bar", x="description", y=["best_day_net_revenue_gbp"]))
            if re.search(r"\b(products?|items?)\b", ql) and not re.search(r"across all products", ql):
                sql = f"""SELECT stock_code, ANY_VALUE(description) AS description, CAST(invoice_date AS DATE) AS invoice_day,
       {day_net} AS net_revenue_gbp
FROM transactions
{where("item_type = 'PRODUCT'")}
GROUP BY stock_code, invoice_day
ORDER BY net_revenue_gbp DESC
LIMIT {n}"""
                return AgentPlan(intent="analytical", sql=sql,
                                 explanation=f"Top {n} product-and-day combinations{scope_txt} by net revenue. Net is used "
                                 "because some large orders were invoiced and cancelled on the same day.",
                                 business_rules=["net_revenue", "cancellations", "non_product"],
                                 chart=ChartSpec(type="bar", x="description", y=["net_revenue_gbp"]))
            sql = f"""SELECT CAST(invoice_date AS DATE) AS invoice_day,
       {day_net} AS net_revenue_gbp,
       COUNT(DISTINCT invoice) FILTER (WHERE line_type = 'SALE') AS orders
FROM transactions
{where("item_type = 'PRODUCT'")}
GROUP BY invoice_day
ORDER BY net_revenue_gbp DESC
LIMIT {n}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Top {n} invoice days{scope_txt} by net product revenue across all products.",
                             business_rules=["net_revenue", "orders"],
                             chart=ChartSpec(type="bar", x="invoice_day", y=["net_revenue_gbp"]))

        if re.search(r"\b(postage|shipping|fees?|non[- ]product|adjustments?|manual|discounts?|carriage)\b", ql):
            sql = f"""SELECT item_type,
       COUNT(*) AS lines,
       ROUND(SUM(line_amount), 2) AS amount_gbp
FROM transactions
{where("item_type <> 'PRODUCT'")}
GROUP BY item_type
ORDER BY amount_gbp DESC"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Totals of non-product lines{scope_txt} by category (all line types, signed amounts).",
                             business_rules=["non_product", "currency"],
                             chart=ChartSpec(type="bar", x="item_type", y=["amount_gbp"]))

        # Returns / returned units by product
        if re.search(r"\breturn(s|ed)?\b", ql) and re.search(r"\b(product|item|stock)", ql):
            sql = f"""SELECT stock_code, ANY_VALUE(description) AS description,
       -SUM(quantity) AS returned_units,
       COUNT(DISTINCT invoice) AS return_invoices
FROM transactions
{where("line_type = 'CANCELLATION'", "item_type = 'PRODUCT'")}
GROUP BY stock_code
ORDER BY returned_units DESC
LIMIT {n}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Top {n} products by returned units{scope_txt}: units on cancellation ('C') invoices of product lines. Stock write-offs are not counted as returns.",
                             business_rules=["returned_units", "cancellations", "negative_quantities", "non_product"],
                             chart=ChartSpec(type="bar", x="description", y=["returned_units"]))

        if re.search(r"\b(cancel\w*|returns?|refund\w*)\b", ql):
            if re.search(r"\b(how many|number of|count)\b", ql):
                sql = f"""SELECT COUNT(DISTINCT invoice) AS cancellation_invoices,
       COUNT(*) AS cancellation_lines,
       -SUM(quantity) AS cancelled_units
FROM transactions
{where("line_type = 'CANCELLATION'")}"""
                expl = f"Counts cancellation invoices (invoice starting with 'C'){scope_txt}; each invoice is one return/cancellation transaction."
            else:
                sql = f"""SELECT ROUND(-SUM(line_amount), 2) AS cancelled_value_gbp,
       COUNT(DISTINCT invoice) AS cancellation_invoices,
       -SUM(quantity) AS cancelled_units
FROM transactions
{where("line_type = 'CANCELLATION'")}"""
                expl = f"Value of all cancellation ('C') invoice lines{scope_txt} as a positive GBP amount, including non-product lines."
            return AgentPlan(intent="analytical", sql=sql, explanation=expl,
                             business_rules=["cancellations", "returned_units", "currency"],
                             chart=ChartSpec(type="none"))

        if re.search(r"\b(missing|unknown|without (a )?customer|no customer|anonymous|guest)\b", ql):
            sql = f"""SELECT CASE WHEN has_customer THEN 'Known customer' ELSE 'Missing customer ID' END AS customer_status,
       COUNT(*) AS lines,
       {net} AS net_revenue_gbp
FROM transactions
{where("item_type = 'PRODUCT'")}
GROUP BY customer_status
ORDER BY customer_status"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Net product revenue{scope_txt} split by whether the line has a customer ID.",
                             business_rules=["missing_customers", "net_revenue"],
                             chart=ChartSpec(type="pie", x="customer_status", y=["net_revenue_gbp"]))

        if re.search(r"\b(month|monthly|trend|over time|per month|by month)\b", ql):
            sql = f"""SELECT strftime(invoice_month, '%Y-%m') AS month,
       {net} AS net_revenue_gbp,
       COUNT(DISTINCT invoice) FILTER (WHERE line_type = 'SALE') AS orders
FROM transactions
{where("item_type = 'PRODUCT'")}
GROUP BY month
ORDER BY month"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Monthly net product revenue{scope_txt} (sales minus cancellations) and order count.",
                             business_rules=["net_revenue", "orders", "period"],
                             chart=ChartSpec(type="line", x="month", y=["net_revenue_gbp"]))

        metric_sql = {
            "net": (net, "net_revenue_gbp", "net revenue"),
            "gross": (gross, "gross_revenue_gbp", "gross revenue"),
            "units": ("SUM(quantity) FILTER (WHERE line_type = 'SALE')", "units_sold", "units sold"),
            "invoices": ("COUNT(DISTINCT invoice) FILTER (WHERE line_type = 'SALE')", "invoices", "number of invoices"),
        }[metric]
        rule_for_metric = {"net": "net_revenue", "gross": "gross_revenue", "units": "units_sold", "invoices": "orders"}[metric]

        if re.search(r"\b(countr(y|ies)|markets?|regions?|nations?)\b", ql):
            sql = f"""SELECT country,
       {metric_sql[0]} AS {metric_sql[1]}
FROM transactions
{where("item_type = 'PRODUCT'")}
GROUP BY country
ORDER BY {metric_sql[1]} DESC
LIMIT {n}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Top {n} countries by {metric_sql[2]}{scope_txt} over product lines.",
                             business_rules=[rule_for_metric, "non_product"],
                             chart=ChartSpec(type="bar", x="country", y=[metric_sql[1]]))

        if re.search(r"\bcustomers?\b", ql):
            sql = f"""SELECT customer_id,
       ANY_VALUE(country) AS country,
       {metric_sql[0]} AS {metric_sql[1]}
FROM transactions
{where("item_type = 'PRODUCT'", "has_customer")}
GROUP BY customer_id
ORDER BY {metric_sql[1]} DESC
LIMIT {n}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Top {n} customers by {metric_sql[2]}{scope_txt}. Lines without a customer ID are excluded from this ranking.",
                             business_rules=[rule_for_metric, "missing_customers"],
                             chart=ChartSpec(type="bar", x="customer_id", y=[metric_sql[1]]))

        if re.search(r"\b(products?|items?|sku|stock codes?|sellers?|selling)\b", ql):
            sql = f"""SELECT stock_code,
       ANY_VALUE(description) AS description,
       {metric_sql[0]} AS {metric_sql[1]}
FROM transactions
{where("item_type = 'PRODUCT'")}
GROUP BY stock_code
ORDER BY {metric_sql[1]} DESC
LIMIT {n}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Top {n} products by {metric_sql[2]}{scope_txt}. Postage, fees and adjustments are excluded.",
                             business_rules=[rule_for_metric, "non_product"],
                             chart=ChartSpec(type="bar", x="description", y=[metric_sql[1]]))

        if re.search(r"\b(average order|aov|order value|basket)\b", ql):
            sql = f"""SELECT ROUND(SUM(line_amount) / COUNT(DISTINCT invoice), 2) AS avg_order_value_gbp,
       COUNT(DISTINCT invoice) AS orders
FROM transactions
{where("line_type = 'SALE'", "item_type = 'PRODUCT'")}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Average gross product value per order{scope_txt} (cancellations not deducted).",
                             business_rules=["gross_revenue", "orders"], chart=ChartSpec(type="none"))

        if re.search(r"\b(how many|number of|count)\b.*\b(orders?|invoices?)\b", ql):
            sql = f"""SELECT COUNT(DISTINCT invoice) AS orders
FROM transactions
{where("line_type = 'SALE'")}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Distinct invoices with at least one sale line{scope_txt}; cancellation invoices are not orders.",
                             business_rules=["orders"], chart=ChartSpec(type="none"))

        if re.search(r"\b(units?|quantity)\b", ql):
            sql = f"""SELECT SUM(quantity) AS units_sold
FROM transactions
{where("line_type = 'SALE'", "item_type = 'PRODUCT'")}"""
            return AgentPlan(intent="analytical", sql=sql, explanation=f"Product units on sale lines{scope_txt}.",
                             business_rules=["units_sold"], chart=ChartSpec(type="none"))

        if re.search(r"\b(revenue|sales|turnover|income|takings|sold)\b", ql):
            sql = f"""SELECT {gross} AS gross_revenue_gbp,
       ROUND(-SUM(line_amount) FILTER (WHERE line_type = 'CANCELLATION'), 2) AS cancelled_value_gbp,
       {net} AS net_revenue_gbp
FROM transactions
{where("item_type = 'PRODUCT'")}"""
            return AgentPlan(intent="analytical", sql=sql,
                             explanation=f"Total product revenue{scope_txt}: gross, cancellations and net (GBP).",
                             business_rules=["gross_revenue", "net_revenue", "cancellations"],
                             chart=ChartSpec(type="none"))

        return AgentPlan(
            intent="unsupported", explanation="Question not recognised.",
            unsupported_reason="Offline mode understands a fixed set of question types (revenue, products, "
            "customers, countries, monthly trends, cancellations, returns, missing customers, non-product "
            "lines). Configure an LLM provider for open-ended questions.",
        )
