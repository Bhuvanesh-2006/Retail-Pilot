export type QueryStatus = 'success' | 'empty' | 'clarification' | 'unsupported' | 'rejected' | 'error';

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface ChartConfig {
  type: 'bar' | 'line' | 'pie';
  x: string;
  y: string[];
  title?: string | null;
}

export interface BusinessRule {
  id: string;
  name: string;
  definition: string;
  sql?: string;
}

export interface LlmStatus {
  provider: string;
  model: string;
  is_llm: boolean;
  configured: boolean;
  note?: string;
}

export interface AgentResponse {
  query_id: string;
  conversation_id: string;
  created_at: string;
  question: string;
  clarification_response?: string;
  status: QueryStatus;
  answer: string;
  explanation: string | null;
  sql: string | null;
  columns: ColumnInfo[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  stored_rows_truncated?: boolean;
  chart: ChartConfig | null;
  clarification: { question: string; options: string[]; source: string } | null;
  business_rules: BusinessRule[];
  error: { code: string; message: string; retryable: boolean } | null;
  execution: {
    provider: string;
    model: string;
    is_llm: boolean;
    attempts: number;
    validated: boolean;
    db_ms: number | null;
    total_ms: number | null;
    regenerated: boolean;
    max_rows: number;
    timeout_s: number;
  };
}

export interface HistoryItem {
  id: string;
  conversation_id: string;
  created_at: string;
  question: string;
  clarification: string | null;
  status: QueryStatus;
  duration_ms: number | null;
  sql: string | null;
  summary: string | null;
  row_count: number | null;
  provider: string | null;
}

export interface Health {
  status: string;
  version: string;
  database: { loaded: boolean; read_only: boolean; status: string; row_count?: number; prepared_at?: string };
  llm: LlmStatus;
}

export interface Kpis {
  gross_revenue: number | null;
  net_revenue: number | null;
  cancelled_value: number | null;
  orders: number;
  units_sold: number | null;
  cancellation_invoices: number;
  returned_units: number | null;
  customers: number;
  unattributed_net_revenue: number | null;
  lines: number;
}

export interface DatasetMetadata {
  name: string;
  source: string;
  source_page: string;
  license: string;
  description: string;
  currency: string;
  source_file?: string;
  prepared_at?: string;
  row_count?: number;
  min_invoice_date?: string;
  max_invoice_date?: string;
  overlap_rows_removed?: number;
  overlap_window_start?: string;
  overlap_window_end?: string;
  source_rows_total?: number;
  exact_duplicate_rows_retained?: number;
}

export interface DashboardSummary {
  filters: { year: number | null; country: string | null };
  kpis: Kpis;
  revenue_trend: { month: string; gross_revenue: number; net_revenue: number; cancelled_value: number | null; orders: number }[];
  top_products: { stock_code: string; description: string; net_revenue: number; units_sold: number }[];
  sales_by_country: { country: string; net_revenue: number; orders: number }[];
  line_types: { line_type: string; lines: number; amount: number }[];
  currency: string;
  dataset: DatasetMetadata;
  recent_queries: HistoryItem[];
  filter_options: { years: number[]; countries: string[] };
}

export interface SchemaColumn {
  name: string;
  type: string;
  description: string;
  missing: number;
  missing_pct: number;
  approx_distinct: number;
}

export interface DatasetSchema {
  metadata: DatasetMetadata;
  dataset: DatasetMetadata;
  row_count: number;
  columns: SchemaColumn[];
  line_types: { line_type: string; lines: number; invoices: number; quantity: number; amount: number }[];
  item_types: { item_type: string; lines: number; amount: number; codes: string | null }[];
  quality: Record<string, number>;
  business_rules: BusinessRule[];
  line_type_definitions: Record<string, string>;
  item_type_definitions: Record<string, string>;
  table: string;
}

export interface DatasetPreview {
  columns: string[];
  rows: unknown[][];
  total: number;
  limit: number;
  offset: number;
}

export interface BenchmarkCase {
  id: string;
  question: string;
  category: string;
  expect: 'answer' | 'clarification' | 'unsupported' | 'empty';
  description: string;
  reference_sql: string | null;
}

export interface BenchmarkResult extends BenchmarkCase {
  passed: boolean;
  executed: boolean;
  reason: string;
  expected_display?: string;
  agent_status?: QueryStatus | 'not_run';
  agent_sql?: string | null;
  agent_answer?: string;
  agent_columns?: string[];
  agent_rows?: unknown[][];
  agent_row_count?: number;
  sql_validated?: boolean;
  attempts?: number;
  duration_ms?: number;
}

export interface Rate {
  passed: number;
  total: number;
  rate: number | null;
}

export interface BenchmarkRun {
  run_id: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at: string | null;
  provider: string;
  model: string;
  is_llm: boolean;
  progress: { done: number; total: number; current: string | null };
  results: BenchmarkResult[];
  summary: {
    overall: Rate;
    result_match: Rate;
    sql_execution: Rate;
    clarification: Rate;
    unsupported_and_empty: Rate;
  } | null;
  error?: string;
}

export interface BenchmarkState {
  cases: BenchmarkCase[];
  dataset_loaded: boolean;
  llm: LlmStatus;
  current: BenchmarkRun | null;
  last_completed: BenchmarkRun | null;
}

export interface AppSettings {
  dataset: DatasetMetadata & { excel_path_configured: string; database_file: string; loaded: boolean };
  database: { engine: string; mode: string };
  llm: LlmStatus;
  query_limits: { timeout_seconds: number; max_result_rows: number; max_question_length: number; max_regenerations: number };
  benchmark: { case_count: number; numeric_relative_tolerance: number; numeric_absolute_tolerance: number; comparison: string };
  business_rules: BusinessRule[];
  demo: { offline_provider_available: boolean; how_to_enable: string; sample_questions: string[] };
}
