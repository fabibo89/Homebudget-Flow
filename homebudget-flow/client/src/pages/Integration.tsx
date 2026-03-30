import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiErrorMessage,
  backfillTransactionsAccount,
  backfillTransactionsAll,
  fetchSyncOverview,
  recheckTransferPairsAll,
  submitSyncTransactionTan,
} from '../api/client';
import { formatDate, formatDateTime } from '../lib/transactionUi';

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (Number.isNaN(n)) return `${amount} ${currency}`;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(n);
}

function formatSalaryDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return formatDate(iso);
  }
  return formatDateTime(iso);
}

export default function Integration() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['sync-overview'],
    queryFn: fetchSyncOverview,
  });

  const rows = q.data ?? [];
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [tanOpen, setTanOpen] = useState(false);
  const [tanValue, setTanValue] = useState('');
  const [tanBusy, setTanBusy] = useState(false);
  const [tanCtx, setTanCtx] = useState<{
    jobId: string;
    accountId?: number;
    mime: string;
    b64: string;
    hint: string | null;
  } | null>(null);

  const backfillAllMut = useMutation({
    mutationFn: backfillTransactionsAll,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
    },
  });

  const recheckTransfersMut = useMutation({
    mutationFn: recheckTransferPairsAll,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['transfers'] });
    },
  });

  async function handleBackfillOne(accountId: number) {
    setBackfillError(null);
    try {
      const r = await backfillTransactionsAccount(accountId);
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
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
    } catch (e) {
      setBackfillError(apiErrorMessage(e));
    }
  }

  async function handleSubmitTransactionTan() {
    if (!tanCtx) return;
    const tan = tanValue.trim();
    if (!tan) return;
    setTanBusy(true);
    setBackfillError(null);
    try {
      await submitSyncTransactionTan(tanCtx.jobId, tan);
      setTanOpen(false);
      setTanCtx(null);
      setTanValue('');
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
    } catch (e) {
      setBackfillError(apiErrorMessage(e));
    } finally {
      setTanBusy(false);
    }
  }

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Integration &amp; Sync-Status
        </Typography>
        <Typography color="text.secondary" variant="body2" paragraph>
          Übersicht der Synchronisation pro Bankkonto (gleiche Datenbasis wie für die Home-Assistant-Sensoren, hier
          mit deinem Login).
        </Typography>
        <Typography variant="body2" color="text.secondary" paragraph>
          <strong>Home Assistant:</strong> Endpunkt <code>/api/ha/snapshot</code> nutzt dasselbe JWT wie nach{' '}
          <code>/api/auth/login</code> (App-Zugang). Die Custom Component liegt unter{' '}
          <code>integrations/home-assistant/</code> – siehe README dort.
        </Typography>
      </Box>

      {q.isError ? <Alert severity="error">{apiErrorMessage(q.error)}</Alert> : null}
      {backfillError ? <Alert severity="error">{backfillError}</Alert> : null}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          variant="contained"
          onClick={() => backfillAllMut.mutate()}
          disabled={backfillAllMut.isPending || q.isLoading}
        >
          {backfillAllMut.isPending ? <CircularProgress size={20} /> : 'Backfill: alle Konten'}
        </Button>
        <Button
          variant="outlined"
          onClick={() => recheckTransfersMut.mutate()}
          disabled={recheckTransfersMut.isPending || q.isLoading}
        >
          {recheckTransfersMut.isPending ? <CircularProgress size={20} /> : 'Umbuchungen prüfen (alle)'}
        </Button>
        <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
          Temporär: füllt fehlende FinTS-Felder bei bestehenden Buchungen nach.
        </Typography>
      </Stack>

      {q.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Paper} elevation={0} sx={{ border: 1, borderColor: 'divider' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Konto</TableCell>
                <TableCell>IBAN</TableCell>
                <TableCell align="right">Saldo</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Saldo-Abruf</TableCell>
                <TableCell>Saldo OK</TableCell>
                <TableCell>Umsätze-Abruf</TableCell>
                <TableCell>Umsätze OK</TableCell>
                <TableCell>Gehalt (Datum)</TableCell>
                <TableCell align="right">Gehalt (Betrag)</TableCell>
                <TableCell align="right">Aktionen</TableCell>
                <TableCell>Fehler</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={12}>
                    <Typography color="text.secondary" sx={{ py: 2 }}>
                      Keine Konten – zuerst unter „Einrichtung“ anlegen.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.bank_account_id} hover>
                    <TableCell>{r.name}</TableCell>
                    <TableCell>{r.iban ?? '—'}</TableCell>
                    <TableCell align="right">{formatMoney(r.balance, r.currency)}</TableCell>
                    <TableCell>{r.sync_status}</TableCell>
                    <TableCell>{formatDateTime(r.balance_attempt_at)}</TableCell>
                    <TableCell>{formatDateTime(r.balance_success_at)}</TableCell>
                    <TableCell>{formatDateTime(r.transactions_attempt_at)}</TableCell>
                    <TableCell>{formatDateTime(r.transactions_success_at)}</TableCell>
                    <TableCell>{formatSalaryDate(r.last_salary_booking_date)}</TableCell>
                    <TableCell align="right">
                      {r.last_salary_amount != null && r.last_salary_amount !== ''
                        ? formatMoney(r.last_salary_amount, r.currency)
                        : '—'}
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => void handleBackfillOne(r.bank_account_id)}>
                        Backfill
                      </Button>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 280 }} title={r.last_error ?? ''}>
                      {r.last_error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={tanOpen}
        onClose={() => (!tanBusy ? setTanOpen(false) : undefined)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>TAN erforderlich</DialogTitle>
        <DialogContent>
          {tanCtx?.hint ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              {tanCtx.hint}
            </Alert>
          ) : null}
          {tanCtx?.b64 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
              <img
                alt="TAN Challenge"
                style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)' }}
                src={`data:${tanCtx.mime};base64,${tanCtx.b64}`}
              />
            </Box>
          ) : null}
          <TextField
            fullWidth
            label="TAN"
            value={tanValue}
            onChange={(e) => setTanValue(e.target.value)}
            sx={{ mt: 2 }}
            disabled={tanBusy}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTanOpen(false)} disabled={tanBusy}>
            Abbrechen
          </Button>
          <Button
            variant="contained"
            onClick={() => void handleSubmitTransactionTan()}
            disabled={!tanValue.trim() || tanBusy}
          >
            {tanBusy ? <CircularProgress size={20} /> : 'Absenden'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
