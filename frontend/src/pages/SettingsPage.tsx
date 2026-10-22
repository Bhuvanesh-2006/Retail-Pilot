import { Box, Button, Chip, Grid2 as Grid, Link, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { SectionCard } from '../components/Cards';
import { CardSkeleton, ErrorState } from '../components/Feedback';
import { useAsync } from '../hooks/useAsync';
import { api } from '../services/api';
import { formatNumber } from '../services/format';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={{ xs: 0.25, sm: 2 }} sx={{ py: 0.75 }}>
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>{label}</Typography>
      <Typography variant="body2" fontWeight={600} component="div" sx={{ textAlign: { sm: 'right' }, wordBreak: 'break-word' }}>{children}</Typography>
    </Stack>
  );
}

export default function SettingsPage() {
  const { data, error, loading, reload } = useAsync(() => api.settings(), []);
  const health = useAsync(() => api.health(), []);
  const navigate = useNavigate();
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <CardSkeleton height={400} />;
  const db = health.data?.database;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5">Settings & data rules</Typography>
        <Typography variant="body2" color="text.secondary">Configuration is read from backend environment variables. Credentials are never sent to the browser.</Typography>
      </Box>
      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title="Dataset & source">
            <Row label="Dataset">{data.dataset.name}</Row>
            <Row label="Source"><Link href={data.dataset.source_page} target="_blank" rel="noreferrer">{data.dataset.source}</Link></Row>
            <Row label="License">{data.dataset.license}</Row>
            <Row label="Workbook file">{data.dataset.excel_path_configured}</Row>
            <Row label="Currency">GBP (£)</Row>
            <Row label="Description">{data.dataset.description}</Row>
          </SectionCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title="Connections">
            <Row label="Database">
              <Chip size="small" variant="outlined" color={db?.loaded ? 'success' : 'warning'} label={db?.loaded ? 'Connected' : 'Not loaded'} />
            </Row>
            <Row label="Engine">{data.database.engine} · {data.dataset.database_file}</Row>
            <Row label="Access mode">{data.database.mode}</Row>
            {db?.row_count !== undefined && <Row label="Rows">{formatNumber(db.row_count)}</Row>}
            <Row label="LLM provider">
              <Chip size="small" variant="outlined" color={data.llm.is_llm ? 'primary' : 'warning'} label={data.llm.is_llm ? `${data.llm.provider} · connected config` : 'Offline rule-based (no LLM)'} />
            </Row>
            <Row label="Model">{data.llm.model}</Row>
            {data.llm.note && <Row label="Note">{data.llm.note}</Row>}
            <Row label="API key">{data.llm.is_llm ? 'Configured on server (hidden)' : 'Not configured'}</Row>
          </SectionCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title="Query safety limits">
            <Row label="Max execution time">{data.query_limits.timeout_seconds} s</Row>
            <Row label="Max result rows">{formatNumber(data.query_limits.max_result_rows)}</Row>
            <Row label="Max question length">{data.query_limits.max_question_length} characters</Row>
            <Row label="SQL regeneration attempts">{data.query_limits.max_regenerations}</Row>
            <Row label="Validation">SQLGlot AST: single SELECT, table & column allowlist, no file/system functions</Row>
          </SectionCard>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title="Benchmark settings" action={<Button size="small" onClick={() => navigate('/benchmark')}>Open</Button>}>
            <Row label="Test cases">{data.benchmark.case_count}</Row>
            <Row label="Relative tolerance">{data.benchmark.numeric_relative_tolerance * 100}%</Row>
            <Row label="Absolute tolerance">£{data.benchmark.numeric_absolute_tolerance}</Row>
            <Row label="Comparison">{data.benchmark.comparison}</Row>
          </SectionCard>
        </Grid>
        <Grid size={12}>
          <SectionCard title="Demo configuration">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{data.demo.how_to_enable}</Typography>
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
              {data.demo.sample_questions.map((q) => (
                <Chip key={q} label={q} variant="outlined" clickable onClick={() => navigate('/analyst')} />
              ))}
            </Stack>
          </SectionCard>
        </Grid>
        <Grid size={12}>
          <SectionCard title="Current business definitions">
            <Grid container spacing={2}>
              {data.business_rules.map((r) => (
                <Grid key={r.id} size={{ xs: 12, md: 6 }}>
                  <Box sx={{ p: 2, borderRadius: 3, border: 1, borderColor: 'divider', height: '100%' }}>
                    <Typography variant="subtitle2">{r.name} <Typography component="span" variant="caption" color="text.secondary">({r.id})</Typography></Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{r.definition}</Typography>
                  </Box>
                </Grid>
              ))}
            </Grid>
          </SectionCard>
        </Grid>
      </Grid>
    </Stack>
  );
}
