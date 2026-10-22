import type {
  AgentResponse,
  AppSettings,
  BenchmarkState,
  DashboardSummary,
  DatasetPreview,
  DatasetSchema,
  Health,
  HistoryItem,
} from '../types/api';

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the RetailPilot API. Is the backend running?');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: () => request<Health>('/api/health'),
  dashboard: (year?: number | null, country?: string | null) =>
    request<DashboardSummary>(`/api/dashboard/summary${qs({ year, country })}`),
  schema: () => request<DatasetSchema>('/api/dataset/schema'),
  preview: (p: { limit: number; offset: number; line_type?: string; item_type?: string; country?: string; search?: string }) =>
    request<DatasetPreview>(`/api/dataset/preview${qs(p)}`),
  ask: (body: { question: string; conversation_id?: string | null; clarification_response?: string | null }) =>
    request<AgentResponse>('/api/agent/query', { method: 'POST', body: JSON.stringify(body) }),
  history: (p: { limit?: number; offset?: number; status?: string; search?: string }) =>
    request<{ items: HistoryItem[]; total: number }>(`/api/history${qs(p)}`),
  historyItem: (id: string) => request<AgentResponse>(`/api/history/${encodeURIComponent(id)}`),
  clearHistory: () => request<{ deleted: number }>('/api/history', { method: 'DELETE' }),
  benchmarks: () => request<BenchmarkState>('/api/benchmarks'),
  runBenchmarks: () => request<{ run_id: string; status: string }>('/api/benchmarks/run', { method: 'POST' }),
  settings: () => request<AppSettings>('/api/settings'),
};
