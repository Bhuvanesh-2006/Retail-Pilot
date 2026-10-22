import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, CardContent, Chip, Grid2 as Grid, LinearProgress,
  Stack, Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { SectionCard } from '../components/Cards';
import { CardSkeleton, ErrorState, SetupState, StatusChip } from '../components/Feedback';
import { ResultGrid } from '../components/ResultGrid';
import { SqlViewer } from '../components/SqlViewer';
import { useToast } from '../components/Toast';
import { useAsync } from '../hooks/useAsync';
import { api } from '../services/api';
import { formatDateTime, formatDuration } from '../services/format';
import { tokens } from '../theme/theme';
import type { BenchmarkResult, BenchmarkRun, Rate } from '../types/api';

const EXPECT_LABEL: Record<string, string> = {
  answer: 'Exact result',
  clarification: 'Must clarify',
  unsupported: 'Must decline',
  empty: 'Must report no data',
};

export default function BenchmarkPage() {
  const { data, error, loading, reload } = useAsync(() => api.benchmarks(), []);
  const [starting, setStarting] = useState(false);
  const notify = useToast();
  const running = data?.current?.status === 'running';

  // Poll while a run is in progress.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 1500);
    return () => clearInterval(t);
  }, [running, reload]);

  const start = async () => {
    setStarting(true);
    try {
      await api.runBenchmarks();
      notify('Benchmark run started', 'info');
      reload();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <CardSkeleton height={400} />;
  if (!data) return null;
  if (!data.dataset_loaded) return <SetupState message="The benchmark cannot run because the dataset is not loaded." />;

  const run: BenchmarkRun | null = running ? data.current : (data.current?.status === 'completed' ? data.current : data.last_completed);
  const resultsById = new Map((run?.results ?? []).map((r) => [r.id, r]));

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5">Reliability benchmark</Typography>
          <Typography variant="body2" color="text.secondary">
            {data.cases.length} trap questions. Expected answers come from independent hand-written SQL run on the loaded data; the agent's answers are compared by key with numeric tolerance.
          </Typography>
        </Box>
        <Button variant="contained" size="large" startIcon={<PlayArrowRoundedIcon />} onClick={start} disabled={running || starting}>
          {running ? 'Running…' : 'Run benchmark'}
        </Button>
      </Stack>

      {!data.llm.is_llm && (
        <Alert severity="warning">
          No LLM is configured: the agent under test is the <b>offline rule-based planner</b>, not a language model. Configure <code>ANTHROPIC_API_KEY</code> to benchmark the LLM.
        </Alert>
      )}

      {running && data.current && (
        <Card><CardContent>
          <Typography variant="body2" sx={{ mb: 1 }}>Running {data.current.progress.current ?? ''} · {data.current.progress.done}/{data.current.progress.total}</Typography>
          <LinearProgress variant="determinate" value={(100 * data.current.progress.done) / data.current.progress.total} sx={{ height: 8, borderRadius: 4 }} />
        </CardContent></Card>
      )}

      {run?.summary ? (
        <Grid container spacing={2.5}>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}><RateCard title="Overall pass rate" rate={run.summary.overall} hint="All cases" /></Grid>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}><RateCard title="Exact result match" rate={run.summary.result_match} hint="Semantic correctness of analytical answers" /></Grid>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}><RateCard title="SQL execution success" rate={run.summary.sql_execution} hint="Ran without error — not proof of correctness" /></Grid>
          <Grid size={{ xs: 12, sm: 6, lg: 3 }}><RateCard title="Clarification success" rate={run.summary.clarification} hint="Ambiguous questions where the agent asked back" /></Grid>
        </Grid>
      ) : !running && (
        <Card><CardContent>
          <Typography color="text.secondary">No completed run yet. Press <b>Run benchmark</b> to execute all cases against the live agent.</Typography>
        </CardContent></Card>
      )}

      {run && (
        <Typography variant="caption" color="text.secondary">
          Run {run.run_id.slice(0, 8)} · started {formatDateTime(run.started_at)} · agent: {run.is_llm ? `${run.provider} / ${run.model}` : 'offline rule-based planner (no LLM)'}
        </Typography>
      )}

      <SectionCard title="Test cases" subtitle="Expand a case to compare the reference SQL with the SQL the agent generated">
        <Stack spacing={1}>
          {data.cases.map((c) => {
            const r = resultsById.get(c.id);
            return (
              <Accordion key={c.id} disableGutters sx={{ border: 1, borderColor: 'divider', borderRadius: '12px !important' }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={{ xs: 0.75, md: 2 }} alignItems={{ md: 'center' }} sx={{ width: '100%', pr: 1, minWidth: 0 }}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: { md: 150 } }}>
                      {r ? (r.passed ? <CheckCircleOutlineIcon color="success" /> : <CancelOutlinedIcon color="error" />) : <Box sx={{ width: 24 }} />}
                      <Typography fontWeight={700} sx={{ fontFamily: 'JetBrains Mono, monospace' }}>{c.id}</Typography>
                      <Chip size="small" label={c.category} variant="outlined" />
                    </Stack>
                    <Typography variant="body2" sx={{ flex: 1, fontWeight: 600, minWidth: 0 }}>{c.question}</Typography>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Chip size="small" label={EXPECT_LABEL[c.expect]} />
                      {r && <StatusChip status={r.passed ? 'passed' : 'failed'} />}
                    </Stack>
                  </Stack>
                </AccordionSummary>
                <AccordionDetails>
                  <CaseDetail description={c.description} referenceSql={c.reference_sql} result={r} />
                </AccordionDetails>
              </Accordion>
            );
          })}
        </Stack>
      </SectionCard>
    </Stack>
  );
}

function RateCard({ title, rate, hint }: { title: string; rate: Rate; hint: string }) {
  const pct = rate.rate === null ? null : Math.round(rate.rate * 1000) / 10;
  const color = pct === null ? tokens.textMuted : pct >= 90 ? tokens.success : pct >= 60 ? tokens.warning : '#ff5b5b';
  return (
    <Card sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="caption" color="text.secondary" fontWeight={600}>{title}</Typography>
        <Stack direction="row" alignItems="baseline" spacing={1}>
          <Typography variant="h4" sx={{ color }}>{pct === null ? '—' : `${pct}%`}</Typography>
          <Typography variant="body2" color="text.secondary">{rate.passed}/{rate.total}</Typography>
        </Stack>
        <LinearProgress variant="determinate" value={pct ?? 0} sx={{ mt: 1, height: 6, borderRadius: 3, '& .MuiLinearProgress-bar': { bgcolor: color } }} />
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>{hint}</Typography>
      </CardContent>
    </Card>
  );
}

function CaseDetail({ description, referenceSql, result }: { description: string; referenceSql: string | null; result?: BenchmarkResult }) {
  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">{description}</Typography>
      {result && (
        <Alert severity={result.passed ? 'success' : 'error'} icon={false}>
          <b>{result.passed ? 'Pass' : 'Fail'}:</b> {result.reason}
          <Box component="span" sx={{ display: 'block', mt: 0.5, opacity: 0.85, fontSize: 12 }}>
            Agent status: {result.agent_status} · SQL executed: {result.executed ? 'yes' : 'no'} · validated: {result.sql_validated ? 'yes' : 'no'} · attempts: {result.attempts ?? '—'} · {formatDuration(result.duration_ms)}
          </Box>
        </Alert>
      )}
      {result?.expected_display && (
        <Box>
          <Typography variant="overline" color="text.secondary">Expected</Typography>
          <Typography variant="body2">{result.expected_display}</Typography>
        </Box>
      )}
      <Grid container spacing={2}>
        {referenceSql && (
          <Grid size={{ xs: 12, lg: 6 }}>
            <Typography variant="overline" color="text.secondary">Reference SQL (trusted, hand-written)</Typography>
            <SqlViewer sql={referenceSql} maxHeight={260} />
          </Grid>
        )}
        {result?.agent_sql && (
          <Grid size={{ xs: 12, lg: referenceSql ? 6 : 12 }}>
            <Typography variant="overline" color="text.secondary">Agent SQL</Typography>
            <SqlViewer sql={result.agent_sql} maxHeight={260} />
          </Grid>
        )}
      </Grid>
      {result?.agent_answer && (
        <Box>
          <Typography variant="overline" color="text.secondary">Agent answer</Typography>
          <Typography variant="body2">{result.agent_answer}</Typography>
        </Box>
      )}
      {result?.agent_columns && result.agent_columns.length > 0 && result.agent_rows && result.agent_rows.length > 0 && (
        <ResultGrid columns={result.agent_columns.map((c) => ({ name: c }))} rows={result.agent_rows} height={300} />
      )}
    </Stack>
  );
}
