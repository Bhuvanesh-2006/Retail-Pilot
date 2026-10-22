import AssignmentReturnOutlinedIcon from '@mui/icons-material/AssignmentReturnOutlined';
import CurrencyPoundIcon from '@mui/icons-material/CurrencyPound';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import {
  Box, Button, Divider, Grid2 as Grid, List, ListItemButton, ListItemText, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { KpiCard, SectionCard } from '../components/Cards';
import { CardSkeleton, EmptyState, ErrorState, StatusChip } from '../components/Feedback';
import { ResultChart } from '../components/ResultChart';
import { useAsync } from '../hooks/useAsync';
import { api } from '../services/api';
import { formatDateTime, formatGBP, formatNumber } from '../services/format';
import { tokens } from '../theme/theme';

export default function OverviewPage() {
  const [params, setParams] = useSearchParams();
  const year = params.get('year') ? Number(params.get('year')) : null;
  const country = params.get('country');
  const navigate = useNavigate();
  const { data, error, loading, reload } = useAsync(() => api.dashboard(year, country), [year, country]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  const k = data?.kpis;
  const scope = [year ?? 'All years', country ?? 'All countries'].join(' · ');

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5">Sales overview</Typography>
          <Typography variant="body2" color="text.secondary">
            All figures computed live from the loaded dataset · GBP · {scope}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5} sx={{ width: { xs: '100%', sm: 'auto' } }}>
          <TextField select size="small" label="Year" value={year ?? ''} onChange={(e) => setFilter('year', e.target.value)} sx={{ minWidth: 120, flex: { xs: 1, sm: 'none' } }}>
            <MenuItem value="">All years</MenuItem>
            {(data?.filter_options.years ?? []).map((y) => <MenuItem key={y} value={y}>{y}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Country" value={country ?? ''} onChange={(e) => setFilter('country', e.target.value)} sx={{ minWidth: 170, flex: { xs: 1, sm: 'none' } }}>
            <MenuItem value="">All countries</MenuItem>
            {(data?.filter_options.countries ?? []).map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </TextField>
        </Stack>
      </Stack>

      <Grid container spacing={2.5}>
        {loading || !k ? (
          [0, 1, 2, 3].map((i) => <Grid key={i} size={{ xs: 12, sm: 6, lg: 3 }}><CardSkeleton height={110} /></Grid>)
        ) : (
          <>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <KpiCard label="Net revenue" value={formatGBP(k.net_revenue)} icon={<CurrencyPoundIcon />}
                caption={`Gross ${formatGBP(k.gross_revenue, true)} − cancellations`} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <KpiCard label="Valid orders (invoices)" value={formatNumber(k.orders)} icon={<ReceiptLongOutlinedIcon />}
                caption={`${formatNumber(k.customers)} identified customers`} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <KpiCard label="Units sold" value={formatNumber(k.units_sold)} icon={<Inventory2OutlinedIcon />}
                caption="Product sale lines, before returns" />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
              <KpiCard label="Cancellations & returns" value={formatGBP(k.cancelled_value)} icon={<AssignmentReturnOutlinedIcon />} accent={tokens.purple}
                caption={`${formatNumber(k.cancellation_invoices)} invoices · ${formatNumber(k.returned_units)} units`} />
            </Grid>
          </>
        )}
      </Grid>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 8 }}>
          {loading || !data ? <CardSkeleton height={380} /> : (
            <SectionCard title="Revenue trend" subtitle="Monthly gross vs net product revenue (net = gross − cancellations). Dec 2011 is partial (data ends 9 Dec).">
              {data.revenue_trend.length ? (
                <ResultChart config={{ type: 'line', x: 'month', y: ['net_revenue', 'gross_revenue'] }}
                  columns={['month', 'net_revenue', 'gross_revenue']}
                  rows={data.revenue_trend.map((r) => [r.month, r.net_revenue, r.gross_revenue])} height={300} />
              ) : <EmptyState title="No transactions for these filters" />}
            </SectionCard>
          )}
        </Grid>
        <Grid size={{ xs: 12, lg: 4 }}>
          {loading || !data ? <CardSkeleton height={380} /> : (
            <SectionCard title="Returns summary" subtitle="Cancellation ('C') invoices, reported separately">
              <Stack spacing={1.5} divider={<Divider flexItem />}>
                <Metric label="Cancelled value" value={formatGBP(data.kpis.cancelled_value)} />
                <Metric label="Return transactions (invoices)" value={formatNumber(data.kpis.cancellation_invoices)} />
                <Metric label="Returned product units" value={formatNumber(data.kpis.returned_units)} />
                <Metric label="Net revenue without customer ID" value={formatGBP(data.kpis.unattributed_net_revenue)} />
                <Metric label="Transaction lines in scope" value={formatNumber(data.kpis.lines)} />
              </Stack>
            </SectionCard>
          )}
        </Grid>
      </Grid>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 7 }}>
          {loading || !data ? <CardSkeleton height={380} /> : (
            <SectionCard title="Top products by net revenue" subtitle="Product stock codes only (postage, fees and adjustments excluded)">
              {data.top_products.length ? (
                <ResultChart config={{ type: 'bar', x: 'description', y: ['net_revenue'] }} columns={['description', 'net_revenue']}
                  rows={data.top_products.map((p) => [p.description ?? p.stock_code, p.net_revenue])} height={300} />
              ) : <EmptyState title="No product sales for these filters" />}
            </SectionCard>
          )}
        </Grid>
        <Grid size={{ xs: 12, lg: 5 }}>
          {loading || !data ? <CardSkeleton height={380} /> : (
            <SectionCard title="Sales by country" subtitle="Top 10 by net revenue">
              {data.sales_by_country.length ? (
                <ResultChart config={{ type: 'bar', x: 'country', y: ['net_revenue'] }} columns={['country', 'net_revenue']}
                  rows={data.sales_by_country.map((c) => [c.country, c.net_revenue])} height={300} />
              ) : <EmptyState title="No sales for these filters" />}
            </SectionCard>
          )}
        </Grid>
      </Grid>

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, md: 7 }}>
          {loading || !data ? <CardSkeleton height={300} /> : (
            <SectionCard title="Recent analytical queries" action={<Button size="small" onClick={() => navigate('/history')}>View all</Button>}>
              {data.recent_queries.length ? (
                <List disablePadding>
                  {data.recent_queries.map((q) => (
                    <ListItemButton key={q.id} onClick={() => navigate(`/analyst?query=${q.id}`)} sx={{ borderRadius: 2, px: 1 }}>
                      <ListItemText
                        primary={q.question + (q.clarification ? ` → ${q.clarification}` : '')}
                        secondary={`${formatDateTime(q.created_at)}${q.summary ? ' · ' + q.summary : ''}`}
                        primaryTypographyProps={{ noWrap: true, fontWeight: 600, fontSize: 14 }}
                        secondaryTypographyProps={{ noWrap: true, fontSize: 12 }}
                      />
                      <Box sx={{ ml: 1, flexShrink: 0 }}><StatusChip status={q.status} /></Box>
                    </ListItemButton>
                  ))}
                </List>
              ) : (
                <EmptyState title="No questions asked yet" description="Ask the AI Sales Analyst a question to see it here."
                  action={<Button variant="contained" onClick={() => navigate('/analyst')}>Ask a question</Button>} />
              )}
            </SectionCard>
          )}
        </Grid>
        <Grid size={{ xs: 12, md: 5 }}>
          {loading || !data ? <CardSkeleton height={300} /> : (
            <SectionCard title="Dataset & freshness">
              <Stack spacing={1.25}>
                <Metric label="Dataset" value={`${data.dataset.name} (${data.dataset.source})`} />
                <Metric label="Reporting period" value={`${data.dataset.min_invoice_date?.slice(0, 10)} → ${data.dataset.max_invoice_date?.slice(0, 10)}`} />
                <Metric label="Rows loaded" value={formatNumber(data.dataset.row_count)} />
                <Metric label="Worksheet-overlap rows removed" value={formatNumber(data.dataset.overlap_rows_removed)} />
                <Metric label="Prepared" value={formatDateTime(data.dataset.prepared_at)} />
                <Metric label="Currency" value="GBP (£)" />
                <Typography variant="caption" color="text.secondary">
                  Historical dataset: figures are static until the preparation script is re-run.
                </Typography>
              </Stack>
            </SectionCard>
          )}
        </Grid>
      </Grid>
    </Stack>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={700} textAlign="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    </Stack>
  );
}
