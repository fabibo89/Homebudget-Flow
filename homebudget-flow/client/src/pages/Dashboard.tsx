import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  ButtonGroup,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tab,
  Tabs,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  ExpandMore as ExpandMoreIcon,
  Sync as SyncIcon,
  CloudSync as CloudSyncIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiErrorMessage,
  fetchAccounts,
  fetchBalanceSnapshots,
  fetchTransactions,
  updateBalanceSnapshot,
  deleteBalanceSnapshot,
  submitSyncTransactionTan,
  syncAccount,
  syncAll,
  type BalanceSnapshotOut,
  type BankAccount,
  type Transaction,
} from '../api/client';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';
import { useAccountGroupLabelMap } from '../hooks/useAccountGroupLabelMap';
import { sortBankAccountsForDisplay } from '../lib/sortBankAccounts';
import { todayIsoInAppTimezone } from '../lib/appTimeZone';
import { addMonthsToIsoDate, formatDate, formatDateTime, formatMoney } from '../lib/transactionUi';

/** Eine Zeile für Konto-Dropdown: Buchungsdatum + Betrag der letzten Gehalt-Buchung (Cache). */
function lastSalaryDropdownSecondary(a: BankAccount): string | undefined {
  const d = a.last_salary_booking_date?.trim();
  const amt = a.last_salary_amount?.trim();
  if (!d && !amt) return undefined;
  const parts: string[] = [];
  if (d) parts.push(`Gehalt zuletzt: ${formatDate(d)}`);
  if (amt) parts.push(formatMoney(amt, a.currency));
  return parts.join(' · ');
}

/** Letzter Zeitpunkt, zu dem Saldo und Umsätze beide erfolgreich waren (Ende des vollständigen Syncs). */
function lastFullSyncLabel(a: BankAccount): { line: string; hint?: string } {
  const b = a.balance_success_at;
  const t = a.transactions_success_at;
  if (b && t) {
    const ms = Math.max(new Date(b).getTime(), new Date(t).getTime());
    return {
      line: formatDateTime(new Date(ms).toISOString()),
    };
  }
  if (b && !t) {
    return {
      line: formatDateTime(b),
      hint: 'nur Saldo · Umsätze noch nicht / fehlgeschlagen',
    };
  }
  if (a.balance_at) {
    return {
      line: `Stand ${formatDate(String(a.balance_at).slice(0, 10))}`,
      hint: 'kein Sync-Zeitstempel',
    };
  }
  return { line: '—' };
}

export default function Dashboard() {
  const qc = useQueryClient();
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));
  const [accountFilter, setAccountFilter] = useState<number | 'all'>('all');
  const today = useMemo(() => todayIsoInAppTimezone(), []);
  // Default: unbegrenzt (leer) – erleichtert die Suche nach älteren Buchungen.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(today);
  const [searchDescription, setSearchDescription] = useState('');
  const [searchCounterparty, setSearchCounterparty] = useState('');
  const [searchWholeWords, setSearchWholeWords] = useState(false);
  const [pageSize, setPageSize] = useState(isXs ? 50 : 200);
  const [offset, setOffset] = useState(0);
  const [syncBusyAccountId, setSyncBusyAccountId] = useState<number | null>(null);
  const [accountSyncError, setAccountSyncError] = useState<string | null>(null);
  const [tanOpen, setTanOpen] = useState(false);
  const [tanValue, setTanValue] = useState('');
  const [tanCtx, setTanCtx] = useState<{
    jobId: string;
    accountId?: number;
    mime: string;
    b64: string;
    hint: string | null;
  } | null>(null);
  const [tanBusy, setTanBusy] = useState(false);
  const [overviewTab, setOverviewTab] = useState<'buchungen' | 'saldo'>('buchungen');
  const [saldoEditOpen, setSaldoEditOpen] = useState(false);
  const [saldoEditError, setSaldoEditError] = useState('');
  const [saldoEditing, setSaldoEditing] = useState<BalanceSnapshotOut | null>(null);
  const [saldoEditBalance, setSaldoEditBalance] = useState('');
  const [saldoEditCurrency, setSaldoEditCurrency] = useState('EUR');
  const [saldoEditRecordedAt, setSaldoEditRecordedAt] = useState('');
  /** Ein Klappzustand für alle Konto-Karten („Zuletzt Saldo & Umsätze“). */
  const [accountSyncDetailsExpanded, setAccountSyncDetailsExpanded] = useState(false);

  useEffect(() => {
    setPageSize((cur) => (cur === 50 || cur === 200 ? (isXs ? 50 : 200) : cur));
  }, [isXs]);

  useEffect(() => {
    setOffset(0);
  }, [from, to, accountFilter, pageSize, searchDescription, searchCounterparty, searchWholeWords]);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const { groupLabelById } = useAccountGroupLabelMap();

  const txQuery = useQuery({
    queryKey: [
      'transactions',
      from,
      to,
      accountFilter,
      pageSize,
      offset,
      searchDescription,
      searchCounterparty,
      searchWholeWords,
    ],
    queryFn: () =>
      fetchTransactions({
        from: from || undefined,
        to: to || undefined,
        bank_account_id: accountFilter === 'all' ? undefined : accountFilter,
        description_contains: searchDescription.trim() || undefined,
        counterparty_contains: searchCounterparty.trim() || undefined,
        whole_words: searchWholeWords || undefined,
        limit: pageSize,
        offset,
      }),
    enabled: overviewTab === 'buchungen',
  });

  async function handleSyncOneAccount(accountId: number) {
    setAccountSyncError(null);
    setSyncBusyAccountId(accountId);
    try {
      const r = await syncAccount(accountId);
      if (r.status === 'needs_transaction_tan') {
        setTanCtx({
          jobId: r.job_id,
          accountId: r.bank_account_id != null ? r.bank_account_id : undefined,
          mime: r.challenge_mime || 'image/png',
          b64: r.challenge_image_base64,
          hint: r.challenge_hint,
        });
        setTanValue('');
        setTanOpen(true);
        return;
      }
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['balance-snapshots'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
    } catch (e) {
      setAccountSyncError(apiErrorMessage(e));
    } finally {
      setSyncBusyAccountId(null);
    }
  }

  async function handleSubmitTransactionTan() {
    if (!tanCtx) return;
    const tan = tanValue.trim();
    if (!tan) return;
    setAccountSyncError(null);
    if (tanCtx.accountId != null) setSyncBusyAccountId(tanCtx.accountId);
    setTanBusy(true);
    try {
      await submitSyncTransactionTan(tanCtx.jobId, tan);
      setTanOpen(false);
      setTanCtx(null);
      setTanValue('');
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['balance-snapshots'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
    } catch (e) {
      setAccountSyncError(apiErrorMessage(e));
    } finally {
      setTanBusy(false);
      setSyncBusyAccountId(null);
    }
  }

  const syncAllMut = useMutation({
    mutationFn: syncAll,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['balance-snapshots'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
    },
  });

  const accounts = useMemo(
    () => sortBankAccountsForDisplay(accountsQuery.data ?? [], groupLabelById),
    [accountsQuery.data, groupLabelById],
  );

  const accountNameById = useMemo(() => {
    const m = new Map<number, string>();
    accounts.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [accounts]);

  const rows: Transaction[] = txQuery.data ?? [];
  const canNext = rows.length === pageSize;
  const canPrev = offset > 0;

  function shiftBuchungenRangeByMonths(deltaMonths: number) {
    setFrom((f) => (f ? addMonthsToIsoDate(f, deltaMonths) : f));
    setTo((t) => (t ? addMonthsToIsoDate(t, deltaMonths) : t));
  }

  const saldoQueries = useQueries({
    queries:
      accounts.length === 0
        ? []
        : accountFilter === 'all'
          ? accounts.map((a) => ({
              queryKey: ['balance-snapshots', a.id] as const,
              queryFn: () => fetchBalanceSnapshots(a.id, 200),
              enabled: overviewTab === 'saldo',
            }))
          : [
              {
                queryKey: ['balance-snapshots', accountFilter] as const,
                queryFn: () => fetchBalanceSnapshots(accountFilter as number, 500),
                enabled: overviewTab === 'saldo',
              },
            ],
  });

  const saldoRows: BalanceSnapshotOut[] = useMemo(() => {
    if (overviewTab !== 'saldo') return [];
    const merged: BalanceSnapshotOut[] = [];
    for (const q of saldoQueries) {
      if (q.data?.length) merged.push(...q.data);
    }
    merged.sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime());
    return merged.slice(0, 500);
  }, [overviewTab, saldoQueries]);

  const saldoLoading = overviewTab === 'saldo' && saldoQueries.some((q) => q.isLoading);
  const saldoError = saldoQueries.find((q) => q.isError)?.error;

  function moneyIsNegative(amount: string): boolean {
    const n = Number(amount);
    return !Number.isNaN(n) && n < 0;
  }

  function openEditSaldoSnapshot(s: BalanceSnapshotOut) {
    setSaldoEditing(s);
    setSaldoEditBalance(String(s.balance ?? ''));
    setSaldoEditCurrency(String(s.currency ?? 'EUR'));
    setSaldoEditRecordedAt(String(s.recorded_at ?? '').slice(0, 19));
    setSaldoEditError('');
    setSaldoEditOpen(true);
  }

  async function saveSaldoSnapshotEdit() {
    if (!saldoEditing) return;
    setSaldoEditError('');
    const bal = saldoEditBalance.trim();
    const cur = saldoEditCurrency.trim().toUpperCase() || 'EUR';
    const rec = saldoEditRecordedAt.trim();
    if (!bal) {
      setSaldoEditError('Bitte einen Saldo-Betrag angeben.');
      return;
    }
    try {
      await updateBalanceSnapshot(saldoEditing.bank_account_id, saldoEditing.id, {
        balance: bal,
        currency: cur,
        recorded_at: rec ? new Date(rec).toISOString() : undefined,
      });
      setSaldoEditOpen(false);
      setSaldoEditing(null);
      void qc.invalidateQueries({ queryKey: ['balance-snapshots'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      setSaldoEditError(apiErrorMessage(e));
    }
  }

  async function removeSaldoSnapshot(s: BalanceSnapshotOut) {
    if (!window.confirm(`Saldo-Snapshot vom ${formatDateTime(s.recorded_at)} löschen?`)) return;
    try {
      await deleteBalanceSnapshot(s.bank_account_id, s.id);
      void qc.invalidateQueries({ queryKey: ['balance-snapshots'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      setSaldoEditError(apiErrorMessage(e));
      setSaldoEditOpen(true);
    }
  }

  const dateInputSx = {
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    boxSizing: 'border-box' as const,
  };

  return (
    <Stack spacing={3} sx={{ minWidth: 0, width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Konten
        </Typography>
        <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
          Salden nach letztem Sync. Einzelnes Konto oder alle Banken synchronisieren.
        </Typography>

        {accountsQuery.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : accountsQuery.isError ? (
          <Alert severity="error">{apiErrorMessage(accountsQuery.error)}</Alert>
        ) : accounts.length === 0 ? (
          <Alert severity="info">Noch keine Konten verknüpft – Backend &amp; Bankanbindung wie in der API-Doku.</Alert>
        ) : (
          <>
            {accountSyncError ? (
              <Alert severity="error" sx={{ mb: 2 }} onClose={() => setAccountSyncError(null)}>
                {accountSyncError}
              </Alert>
            ) : null}
            <Dialog
              open={tanOpen}
              onClose={() => (tanBusy || syncBusyAccountId !== null ? undefined : setTanOpen(false))}
              maxWidth="sm"
              fullWidth
              fullScreen={isXs}
            >
              <DialogTitle>PhotoTAN (Umsätze)</DialogTitle>
              <DialogContent>
                <Stack spacing={2} sx={{ pt: 1 }}>
                  {tanCtx?.hint ? (
                    <Typography variant="body2" color="text.secondary">
                      {tanCtx.hint}
                    </Typography>
                  ) : null}
                  {tanCtx?.b64 ? (
                    <Box
                      component="img"
                      src={`data:${tanCtx.mime};base64,${tanCtx.b64}`}
                      alt="PhotoTAN"
                      sx={{ maxWidth: '100%', height: 'auto', borderRadius: 1 }}
                    />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Kein Bild von der Bank — TAN laut App eingeben.
                    </Typography>
                  )}
                  <TextField
                    label="TAN"
                    value={tanValue}
                    onChange={(e) => setTanValue(e.target.value)}
                    autoFocus
                    fullWidth
                    autoComplete="one-time-code"
                  />
                </Stack>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setTanOpen(false)} disabled={tanBusy}>
                  Abbrechen
                </Button>
                <Button variant="contained" onClick={() => void handleSubmitTransactionTan()} disabled={!tanValue.trim() || tanBusy}>
                  {tanBusy ? <CircularProgress size={20} /> : 'Absenden'}
                </Button>
              </DialogActions>
            </Dialog>
            <Dialog open={saldoEditOpen} onClose={() => setSaldoEditOpen(false)} maxWidth="sm" fullWidth fullScreen={isXs}>
              <DialogTitle>Saldo-Snapshot bearbeiten</DialogTitle>
              <DialogContent>
                <Stack spacing={2} sx={{ pt: 1 }}>
                  {saldoEditError ? <Alert severity="error">{saldoEditError}</Alert> : null}
                  {saldoEditing ? (
                    <Typography variant="caption" color="text.secondary">
                      Konto: {accountNameById.get(saldoEditing.bank_account_id) ?? `#${saldoEditing.bank_account_id}`} ·{' '}
                      Zeitpunkt: {formatDateTime(saldoEditing.recorded_at)}
                    </Typography>
                  ) : null}
                  <TextField
                    label="Saldo (z. B. -104.81)"
                    value={saldoEditBalance}
                    onChange={(e) => setSaldoEditBalance(e.target.value)}
                    fullWidth
                  />
                  <TextField
                    label="Währung"
                    value={saldoEditCurrency}
                    onChange={(e) => setSaldoEditCurrency(e.target.value)}
                    fullWidth
                  />
                  <TextField
                    label="Zeitpunkt (optional)"
                    helperText="ISO/Datum-Zeit; leer lassen, um den Zeitpunkt beizubehalten."
                    value={saldoEditRecordedAt}
                    onChange={(e) => setSaldoEditRecordedAt(e.target.value)}
                    fullWidth
                  />
                </Stack>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setSaldoEditOpen(false)}>Abbrechen</Button>
                <Button variant="contained" onClick={() => void saveSaldoSnapshotEdit()} disabled={!saldoEditing}>
                  Speichern
                </Button>
              </DialogActions>
            </Dialog>
            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' },
              }}
            >
              {accounts.map((a: BankAccount) => (
                <Card key={a.id} elevation={0} sx={{ height: '100%', border: 1, borderColor: 'divider' }}>
                  <CardContent>
                    <Typography variant="subtitle2" color="text.secondary">
                      {a.provider}
                    </Typography>
                    <Typography variant="h6" fontWeight={700} sx={{ mt: 0.5 }} noWrap title={a.name}>
                      {a.name}
                    </Typography>
                    {a.iban ? (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                        {a.iban}
                      </Typography>
                    ) : null}
                    <Typography
                      variant="h5"
                      fontWeight={700}
                      color={moneyIsNegative(a.balance) ? 'error.main' : 'primary.main'}
                      sx={{ my: 1 }}
                    >
                      {formatMoney(a.balance, a.currency)}
                    </Typography>
                    {(() => {
                      const summary = lastFullSyncLabel(a);
                      return (
                        <Accordion
                          expanded={accountSyncDetailsExpanded}
                          onChange={(_, expanded) => setAccountSyncDetailsExpanded(expanded)}
                          disableGutters
                          elevation={0}
                          sx={{
                            mt: 0.5,
                            bgcolor: 'transparent',
                            '&:before': { display: 'none' },
                            '& .MuiAccordionSummary-root': { px: 0, minHeight: 0 },
                            '& .MuiAccordionSummary-content': { my: 0.5, margin: 0 },
                          }}
                        >
                          <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: '1.1rem' }} />}>
                            <Box>
                              <Typography variant="caption" color="text.secondary" display="block">
                                Zuletzt Saldo &amp; Umsätze
                              </Typography>
                              <Typography variant="body2" color="text.primary" fontWeight={600}>
                                {summary.line}
                              </Typography>
                              {summary.hint ? (
                                <Typography variant="caption" color="warning.main" display="block">
                                  {summary.hint}
                                </Typography>
                              ) : null}
                            </Box>
                          </AccordionSummary>
                          <AccordionDetails sx={{ px: 0, pt: 0 }}>
                            <Stack spacing={0.35}>
                              <Typography variant="caption" color="text.secondary" display="block">
                                Saldo (Versuch): {formatDateTime(a.balance_attempt_at)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" display="block">
                                Saldo (OK):{' '}
                                {a.balance_success_at
                                  ? formatDateTime(a.balance_success_at)
                                  : a.balance_at
                                    ? `Stand ${formatDate(String(a.balance_at).slice(0, 10))}`
                                    : '—'}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" display="block">
                                Umsätze (Versuch): {formatDateTime(a.transactions_attempt_at)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" display="block">
                                Umsätze (OK): {formatDateTime(a.transactions_success_at)}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                                Gehalt zuletzt (Datum):{' '}
                                {a.last_salary_booking_date?.trim()
                                  ? formatDate(a.last_salary_booking_date.trim())
                                  : '—'}
                              </Typography>
                              <Typography variant="caption" color="text.secondary" display="block">
                                Gehalt zuletzt (Betrag):{' '}
                                {a.last_salary_amount != null && String(a.last_salary_amount).trim() !== ''
                                  ? formatMoney(String(a.last_salary_amount), a.currency)
                                  : '—'}
                              </Typography>
                            </Stack>
                          </AccordionDetails>
                        </Accordion>
                      );
                    })()}
                    <Box sx={{ mt: 2 }}>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={
                          syncBusyAccountId === a.id ? <CircularProgress size={16} /> : <SyncIcon />
                        }
                        disabled={syncBusyAccountId !== null || tanOpen}
                        onClick={() => void handleSyncOneAccount(a.id)}
                      >
                        Sync
                      </Button>
                    </Box>
                  </CardContent>
                </Card>
              ))}
            </Box>
            <Box sx={{ mt: 2, width: '100%', maxWidth: '100%' }}>
              <Button
                variant="contained"
                color="secondary"
                fullWidth={isXs}
                startIcon={
                  syncAllMut.isPending ? <CircularProgress size={18} color="inherit" /> : <CloudSyncIcon />
                }
                disabled={syncAllMut.isPending || tanOpen || syncBusyAccountId !== null}
                onClick={() => syncAllMut.mutate()}
              >
                Alle Konten synchronisieren
              </Button>
              {syncAllMut.isError ? (
                <Alert sx={{ mt: 2 }} severity="error">
                  {apiErrorMessage(syncAllMut.error)}
                </Alert>
              ) : null}
            </Box>
          </>
        )}
      </Box>

      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Übersicht
        </Typography>
        <Tabs
          value={overviewTab}
          onChange={(_, v) => setOverviewTab(v)}
          sx={{ borderBottom: 1, borderColor: 'divider', mb: 2, minWidth: 0, maxWidth: '100%' }}
          variant={isXs ? 'scrollable' : 'standard'}
          scrollButtons="auto"
          allowScrollButtonsMobile
        >
          <Tab value="buchungen" label="Buchungen" />
          <Tab value="saldo" label="Saldo" />
        </Tabs>

        {overviewTab === 'buchungen' ? (
          <>
        <Typography
          color="text.secondary"
          variant="body2"
          sx={{ mb: 1, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
        >
          Zeile anklicken für Buchungsdetails. Kategorie-Spalte: Linksklick Regel oder Änderung, Rechtsklick öffnet
          sofort die Auswahlliste (Tooltips an der Spaltenüberschrift).
        </Typography>
        <Paper
          elevation={0}
          sx={{
            p: 2,
            border: 1,
            borderColor: 'divider',
            mb: 2,
            maxWidth: '100%',
            overflow: 'hidden',
            boxSizing: 'border-box',
          }}
        >
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ xs: 'stretch', sm: 'center' }}
            flexWrap="wrap"
            sx={{ minWidth: 0 }}
          >
            <Typography variant="body2" color="text.secondary" sx={{ minWidth: { sm: 120 }, flexShrink: 0 }}>
              Zeitraum
            </Typography>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ xs: 'stretch', sm: 'center' }}
              flexWrap="wrap"
              useFlexGap
              sx={{ minWidth: 0, width: { xs: '100%', sm: 'auto' } }}
            >
              <Box sx={{ width: { xs: '100%', sm: 'auto' }, minWidth: 0, maxWidth: '100%' }}>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  placeholder="von (leer = unbegrenzt)"
                  style={dateInputSx}
                />
              </Box>
              {from ? (
                <Button size="small" variant="text" onClick={() => setFrom('')} sx={{ alignSelf: { xs: 'flex-start', sm: 'center' } }}>
                  Von löschen
                </Button>
              ) : null}
              <Box
                component="span"
                sx={{ display: { xs: 'none', sm: 'inline' }, alignSelf: 'center' }}
                aria-hidden
              >
                –
              </Box>
              <Box sx={{ width: { xs: '100%', sm: 'auto' }, minWidth: 0, maxWidth: '100%' }}>
                <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={dateInputSx} />
              </Box>
              <ButtonGroup size="small" variant="outlined" fullWidth={isXs} sx={{ alignSelf: { sm: 'center' } }}>
                <Button onClick={() => shiftBuchungenRangeByMonths(-1)}>−1 Monat</Button>
                <Button onClick={() => shiftBuchungenRangeByMonths(1)}>+1 Monat</Button>
              </ButtonGroup>
            </Stack>
            <FormControl size="small" sx={{ minWidth: { xs: 0, sm: 220 }, width: { xs: '100%', sm: 'auto' }, maxWidth: '100%' }}>
              <InputLabel id="acc-filter">Konto</InputLabel>
              <Select
                labelId="acc-filter"
                label="Konto"
                value={accountFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  setAccountFilter(v === 'all' ? 'all' : Number(v));
                }}
                renderValue={(selected) => {
                  if (selected === 'all') return 'Alle Konten';
                  const a = accounts.find((x) => x.id === selected);
                  return a?.name ?? '';
                }}
              >
                <MenuItem value="all">Alle Konten</MenuItem>
                {accounts.map((a) => {
                  const sal = lastSalaryDropdownSecondary(a);
                  return (
                    <MenuItem key={a.id} value={a.id}>
                      {sal ? (
                        <ListItemText
                          primary={a.name}
                          secondary={sal}
                          secondaryTypographyProps={{ variant: 'caption', sx: { whiteSpace: 'normal' } }}
                        />
                      ) : (
                        a.name
                      )}
                    </MenuItem>
                  );
                })}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: { xs: 0, sm: 120 }, width: { xs: '100%', sm: 'auto' }, maxWidth: '100%' }}>
              <InputLabel id="page-size">Einträge</InputLabel>
              <Select
                labelId="page-size"
                label="Einträge"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
              >
                <MenuItem value={100}>100</MenuItem>
                <MenuItem value={200}>200</MenuItem>
                <MenuItem value={500}>500</MenuItem>
                <MenuItem value={1000}>1000</MenuItem>
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              onClick={() => void txQuery.refetch()}
              disabled={txQuery.isFetching}
              sx={{ alignSelf: { xs: 'stretch', sm: 'center' } }}
            >
              {txQuery.isFetching ? 'Laden…' : 'Aktualisieren'}
            </Button>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" sx={{ minWidth: 0, width: { xs: '100%', sm: 'auto' } }}>
              <Button
                size="small"
                variant="outlined"
                disabled={!canPrev || txQuery.isFetching}
                onClick={() => setOffset((o) => Math.max(0, o - pageSize))}
              >
                Zurück
              </Button>
              <Typography variant="body2" color="text.secondary">
                Offset {offset}
              </Typography>
              <Button
                size="small"
                variant="outlined"
                disabled={!canNext || txQuery.isFetching}
                onClick={() => setOffset((o) => o + pageSize)}
              >
                Weiter
              </Button>
            </Stack>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 2 }} alignItems={{ sm: 'flex-start' }}>
            <TextField
              size="small"
              label="Verwendungszweck enthält"
              value={searchDescription}
              onChange={(e) => setSearchDescription(e.target.value)}
              placeholder={
                searchWholeWords
                  ? 'Wörter (Leerzeichen trennt); jedes als ganzes Wort'
                  : 'Teilstring, Groß-/Kleinschreibung egal'
              }
              fullWidth
              inputProps={{ maxLength: 500 }}
            />
            <TextField
              size="small"
              label="Gegenpartei enthält"
              value={searchCounterparty}
              onChange={(e) => setSearchCounterparty(e.target.value)}
              placeholder={
                searchWholeWords
                  ? 'Wörter (Leerzeichen trennt); jedes als ganzes Wort'
                  : 'Teilstring, Groß-/Kleinschreibung egal'
              }
              fullWidth
              inputProps={{ maxLength: 500 }}
            />
            <FormControlLabel
              sx={{ alignSelf: { xs: 'flex-start', sm: 'center' }, ml: { xs: 0, sm: 0 }, mr: 0 }}
              control={
                <Checkbox
                  checked={searchWholeWords}
                  onChange={(_, c) => setSearchWholeWords(c)}
                  size="small"
                />
              }
              label="Nur ganze Wörter"
            />
          </Stack>
        </Paper>

        {txQuery.isError ? (
          <Alert severity="error">{apiErrorMessage(txQuery.error)}</Alert>
        ) : txQuery.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : (
          <TransactionBookingsTable
            rows={rows}
            accounts={accounts}
            emptyMessage="Keine Buchungen im Zeitraum."
            hideInlineHint
          />
        )}
        </>
        ) : (
          <>
            <Typography
              color="text.secondary"
              variant="body2"
              sx={{ mb: 1, overflowWrap: 'anywhere', wordBreak: 'break-word' }}
            >
              Gespeicherte Salden nach jedem erfolgreichen Sync (neueste oben). „Alle Konten“: bis zu 200 Snapshots
              pro Konto, zusammen max. 500 Zeilen.
            </Typography>
            <Paper
              elevation={0}
              sx={{ p: 2, border: 1, borderColor: 'divider', mb: 2, maxWidth: '100%', overflow: 'hidden', boxSizing: 'border-box' }}
            >
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} flexWrap="wrap" sx={{ minWidth: 0 }}>
                <FormControl size="small" sx={{ minWidth: { xs: 0, sm: 220 }, width: { xs: '100%', sm: 'auto' }, maxWidth: '100%' }}>
                  <InputLabel id="acc-filter-saldo">Konto</InputLabel>
                  <Select
                    labelId="acc-filter-saldo"
                    label="Konto"
                    value={accountFilter}
                    onChange={(e) => {
                      const v = e.target.value;
                      setAccountFilter(v === 'all' ? 'all' : Number(v));
                    }}
                    renderValue={(selected) => {
                      if (selected === 'all') return 'Alle Konten';
                      const a = accounts.find((x) => x.id === selected);
                      return a?.name ?? '';
                    }}
                  >
                    <MenuItem value="all">Alle Konten</MenuItem>
                    {accounts.map((a) => {
                      const sal = lastSalaryDropdownSecondary(a);
                      return (
                        <MenuItem key={a.id} value={a.id}>
                          {sal ? (
                            <ListItemText
                              primary={a.name}
                              secondary={sal}
                              secondaryTypographyProps={{ variant: 'caption', sx: { whiteSpace: 'normal' } }}
                            />
                          ) : (
                            a.name
                          )}
                        </MenuItem>
                      );
                    })}
                  </Select>
                </FormControl>
                <Button
                  variant="outlined"
                  onClick={() => void qc.invalidateQueries({ queryKey: ['balance-snapshots'] })}
                  disabled={saldoLoading || accounts.length === 0}
                  sx={{ alignSelf: { xs: 'stretch', sm: 'center' } }}
                >
                  {saldoLoading ? 'Laden…' : 'Aktualisieren'}
                </Button>
              </Stack>
            </Paper>
            {accounts.length === 0 ? (
              <Alert severity="info">Keine Konten — zuerst Konten anlegen und synchronisieren.</Alert>
            ) : saldoError ? (
              <Alert severity="error">{apiErrorMessage(saldoError)}</Alert>
            ) : saldoLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
                <CircularProgress />
              </Box>
            ) : (
              <TableContainer
                component={Paper}
                elevation={0}
                sx={{ border: 1, borderColor: 'divider', overflowX: 'auto', maxWidth: '100%', boxSizing: 'border-box' }}
              >
                <Table size="small" sx={{ minWidth: 620 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>Zeitpunkt (Sync)</TableCell>
                      <TableCell>Konto</TableCell>
                      <TableCell align="right">Saldo</TableCell>
                      <TableCell align="right">Aktion</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {saldoRows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4}>
                          <Typography color="text.secondary" sx={{ py: 2 }}>
                            Noch keine Saldo-Snapshots — nach dem nächsten erfolgreichen Sync erscheinen Einträge.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      saldoRows.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(s.recorded_at)}</TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={accountNameById.get(s.bank_account_id) ?? `#${s.bank_account_id}`}
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell
                            align="right"
                            sx={{
                              fontVariantNumeric: 'tabular-nums',
                              fontWeight: 600,
                              color: moneyIsNegative(s.balance) ? 'error.main' : 'text.primary',
                            }}
                          >
                            {formatMoney(s.balance, s.currency)}
                          </TableCell>
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            <Button
                              size="small"
                              variant="text"
                              startIcon={<EditIcon fontSize="small" />}
                              onClick={() => openEditSaldoSnapshot(s)}
                            >
                              Bearbeiten
                            </Button>
                            <Button
                              size="small"
                              variant="text"
                              color="error"
                              startIcon={<DeleteIcon fontSize="small" />}
                              onClick={() => void removeSaldoSnapshot(s)}
                            >
                              Löschen
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}
      </Box>
    </Stack>
  );
}
