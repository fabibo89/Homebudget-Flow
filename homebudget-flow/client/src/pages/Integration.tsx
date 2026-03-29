import {
  Alert,
  Box,
  CircularProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiErrorMessage, fetchSyncOverview } from '../api/client';
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
  const q = useQuery({
    queryKey: ['sync-overview'],
    queryFn: fetchSyncOverview,
  });

  const rows = q.data ?? [];

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
                <TableCell>Fehler</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11}>
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
    </Stack>
  );
}
