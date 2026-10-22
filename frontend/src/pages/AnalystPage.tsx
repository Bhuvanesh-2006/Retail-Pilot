import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import {
  Alert, Avatar, Box, Button, Card, Chip, CircularProgress, IconButton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnswerCard } from '../components/AnswerCard';
import { useToast } from '../components/Toast';
import { api, ApiError } from '../services/api';
import { tokens } from '../theme/theme';
import type { AgentResponse } from '../types/api';

const EXAMPLES = [
  'Which products generated the highest revenue?',
  'Which products had the most returned units?',
  'Which countries generated the highest revenue?',
  'What were the monthly revenue trends?',
  'Which customers contributed the most revenue?',
  'How much revenue was associated with cancelled invoices?',
  'Who are our best customers?',
];

interface Message {
  id: string;
  role: 'user' | 'agent';
  text?: string;
  response?: AgentResponse;
  pending?: boolean;
  failure?: string;
  request?: Payload;
}

interface Payload {
  question: string;
  conversation_id?: string | null;
  clarification_response?: string | null;
}

let seq = 0;
const nextId = () => `m${++seq}`;

export default function AnalystPage() {
  const [params, setParams] = useSearchParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const notify = useToast();

  const lastAgent = [...messages].reverse().find((m) => m.role === 'agent' && m.response);
  const awaitingClarification = lastAgent?.response?.status === 'clarification';

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  // Reopen a query from history: /analyst?query=<id>
  useEffect(() => {
    const qid = params.get('query');
    if (!qid) return;
    api.historyItem(qid)
      .then((r) => {
        setConversationId(r.conversation_id);
        setMessages([
          { id: nextId(), role: 'user', text: r.question + (r.clarification_response ? ` → ${r.clarification_response}` : '') },
          { id: nextId(), role: 'agent', response: r },
        ]);
      })
      .catch((e: Error) => notify(e.message, 'error'))
      .finally(() => setParams({}, { replace: true }));
  }, [params, setParams, notify]);

  const send = useCallback(async (payload: Payload, userText: string) => {
    const pendingId = nextId();
    setMessages((m) => [...m, { id: nextId(), role: 'user', text: userText }, { id: pendingId, role: 'agent', pending: true, request: payload }]);
    setBusy(true);
    try {
      const r = await api.ask(payload);
      setConversationId(r.conversation_id);
      setMessages((m) => m.map((x) => (x.id === pendingId ? { ...x, pending: false, response: r } : x)));
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Unexpected error';
      setMessages((m) => m.map((x) => (x.id === pendingId ? { ...x, pending: false, failure: msg } : x)));
    } finally {
      setBusy(false);
    }
  }, []);

  const ask = (text?: string) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput('');
    if (awaitingClarification && !text) {
      send({ question: '', conversation_id: conversationId, clarification_response: q }, q);
    } else {
      send({ question: q, conversation_id: conversationId }, q);
    }
  };

  const clarify = (option: string) => send({ question: '', conversation_id: conversationId, clarification_response: option }, option);

  const retry = (payload: Payload | undefined, response?: AgentResponse) => {
    const p = payload ?? (response ? { question: response.question, conversation_id: conversationId, clarification_response: response.clarification_response } : null);
    if (!p) return;
    send(p, p.clarification_response ?? p.question);
  };

  const newConversation = () => {
    setMessages([]);
    setConversationId(null);
    setInput('');
  };

  return (
    <Stack sx={{ minHeight: { xs: 'calc(100vh - 96px)', sm: 'calc(100vh - 112px)' } }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5">AI Sales Analyst</Typography>
          <Typography variant="body2" color="text.secondary">Ask in plain English. Every answer shows the validated SQL it ran and the rules it applied.</Typography>
        </Box>
        <Tooltip title="Start a new conversation">
          <span>
            <Button variant="outlined" startIcon={<AddCommentOutlinedIcon />} onClick={newConversation} disabled={busy || messages.length === 0}
              sx={{ display: { xs: 'none', sm: 'inline-flex' } }}>New chat</Button>
            <IconButton aria-label="New conversation" onClick={newConversation} disabled={busy || messages.length === 0} sx={{ display: { xs: 'inline-flex', sm: 'none' } }}>
              <AddCommentOutlinedIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Stack spacing={2} sx={{ flex: 1, pb: 2 }}>
        {messages.length === 0 && (
          <Card sx={{ p: { xs: 2.5, sm: 4 } }}>
            <Stack spacing={2} alignItems="flex-start">
              <Avatar sx={{ bgcolor: tokens.primary, width: 48, height: 48 }}><AutoAwesomeIcon /></Avatar>
              <Typography variant="h6">What would you like to know about your sales?</Typography>
              <Typography variant="body2" color="text.secondary">
                Revenue means <b>net revenue</b> (sales minus cancellations, product lines only) unless you say otherwise. Money is in GBP.
                Ambiguous questions get a clarifying question instead of a guess.
              </Typography>
              <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1}>
                {EXAMPLES.map((q) => (
                  <Chip key={q} label={q} onClick={() => ask(q)} clickable variant="outlined" color="primary"
                    sx={{ height: 'auto', py: 0.75, '& .MuiChip-label': { whiteSpace: 'normal' } }} />
                ))}
              </Stack>
            </Stack>
          </Card>
        )}

        {messages.map((m) =>
          m.role === 'user' ? (
            <Box key={m.id} sx={{ alignSelf: 'flex-end', maxWidth: { xs: '92%', md: '70%' } }}>
              <Box sx={{ bgcolor: tokens.primary, color: '#fff', px: 2, py: 1.25, borderRadius: '18px 18px 4px 18px' }}>
                <Typography variant="body2" sx={{ fontWeight: 500, wordBreak: 'break-word' }}>{m.text}</Typography>
              </Box>
            </Box>
          ) : (
            <Stack key={m.id} direction="row" spacing={1.5} alignItems="flex-start" sx={{ width: '100%' }}>
              <Avatar sx={{ bgcolor: '#1a1f37', color: tokens.primary, width: 36, height: 36, display: { xs: 'none', sm: 'flex' } }}>
                <AutoAwesomeIcon fontSize="small" />
              </Avatar>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                {m.pending && (
                  <Card sx={{ p: 2 }}>
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <CircularProgress size={18} />
                      <Typography variant="body2" color="text.secondary">Planning query, validating SQL and running it on the dataset…</Typography>
                    </Stack>
                  </Card>
                )}
                {m.failure && (
                  <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => retry(m.request)}>Retry</Button>}>
                    {m.failure}
                  </Alert>
                )}
                {m.response && (
                  <AnswerCard response={m.response} onClarify={clarify} clarifyDisabled={busy || m !== lastAgent}
                    onRetry={() => retry(m.request, m.response)} />
                )}
              </Box>
            </Stack>
          ),
        )}
        <div ref={bottomRef} />
      </Stack>

      <Box sx={{ position: 'sticky', bottom: 0, pt: 1, pb: { xs: 1.5, sm: 2 }, background: `linear-gradient(180deg, transparent, ${tokens.bg} 30%)`, zIndex: 2 }}>
        <Card sx={{ p: 1 }}>
          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              fullWidth multiline maxRows={4} value={input}
              onChange={(e) => setInput(e.target.value.slice(0, 500))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  ask();
                }
              }}
              placeholder={awaitingClarification ? 'Pick an option above or type your own answer…' : 'Ask about revenue, products, customers, countries, returns…'}
              variant="standard"
              InputProps={{ disableUnderline: true, sx: { px: 1.5, py: 1, fontSize: 15 } }}
              inputProps={{ 'aria-label': 'Question' }}
            />
            <IconButton aria-label="Send question" color="primary" onClick={() => ask()} disabled={busy || !input.trim()}
              sx={{ bgcolor: tokens.primary, color: '#fff', width: 44, height: 44, '&:hover': { bgcolor: '#0062d6' }, '&.Mui-disabled': { bgcolor: 'rgba(0,117,255,0.25)' } }}>
              {busy ? <CircularProgress size={20} color="inherit" /> : <SendRoundedIcon />}
            </IconButton>
          </Stack>
        </Card>
        {messages.length > 0 && conversationId && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, px: 1 }}>
            Follow-ups use this conversation's context, e.g. “now only for Germany”.
          </Typography>
        )}
      </Box>
    </Stack>
  );
}
