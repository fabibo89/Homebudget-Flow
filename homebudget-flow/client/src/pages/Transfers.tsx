import { Fragment, useMemo, useState } from 'react';
import GroupsIcon from '@mui/icons-material/Groups';
import PersonIcon from '@mui/icons-material/Person';
import SyncAltIcon from '@mui/icons-material/SyncAlt';
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
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { apiErrorMessage, fetchAccounts, fetchTransferPairs, type TransferPair } from '../api/client';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';
import { amountSxColorFromTransaction, formatDate, formatMoney } from '../lib/transactionUi';

function kindLabel(k: TransferPair['out_transaction']['transfer_kind']): string {
  if (k === 'own_internal') return 'Eigene Umbuchung';
  if (k === 'own_to_shared') return 'Eigen → Gemeinsames Konto';
  if (k === 'own_to_other_user') return 'Eigen → Konto einer anderen Person';
  return 'Umbuchung';
}

function kindIcon(k: TransferPair['out_transaction']['transfer_kind']) {
  if (k === 'own_internal') return { Icon: SyncAltIcon, label: 'Eigene Umbuchung' };
  if (k === 'own_to_shared') return { Icon: GroupsIcon, label: 'Eigen → Gemeinsames Konto' };
  if (k === 'own_to_other_user') return { Icon: PersonIcon, label: 'Eigen → Konto einer anderen Person' };
  return null;
}

export default function Transfers() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const accountsQ = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const q = useQuery({
    queryKey: ['transfers', from, to],
    queryFn: () =>
      fetchTransferPairs({
        from: from || undefined,
        to: to || undefined,
        limit: 500,
      }),
  });

  const rows = useMemo(() => {
    const base = (q.data ?? []).slice();
    base.sort((a, b) => {
      const ad = a.out_transaction.booking_date || '';
      const bd = b.out_transaction.booking_date || '';
      if (ad !== bd) return bd.localeCompare(ad); // ISO date -> lexicographic works
      return (b.out_transaction.id ?? 0) - (a.out_transaction.id ?? 0);
    });
    return base;
  }, [q.data]);
  const accountNameById = useMemo(() => {
    const m = new Map<number, string>();
    (accountsQ.data ?? []).forEach((a) => m.set(a.id, a.name));
    return m;
  }, [accountsQ.data]);

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Umbuchungen
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Je Zeile eine interne Umbuchung (Von → Nach). In kontobezogenen Auswertungen (z. B. Tag Null) erscheint nur
          die Buchung auf dem jeweiligen Konto — hier die Zuordnung beider Konten in einer Zeile.
        </Typography>
      </Box>

      <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
          <TextField
            size="small"
            label="Von"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            label="Bis"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            InputLabelProps={{ shrink: true }}
          />
        </Stack>
      </Paper>

      {q.isLoading ? (
        <Stack direction="row" spacing={1.5} alignItems="center">
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            Lade Umbuchungen…
          </Typography>
        </Stack>
      ) : null}
      {q.isError ? <Alert severity="error">{apiErrorMessage(q.error)}</Alert> : null}

      <TableContainer component={Paper} elevation={0} sx={{ border: 1, borderColor: 'divider' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Datum</TableCell>
              <TableCell>Typ</TableCell>
              <TableCell>Konto</TableCell>
              <TableCell align="right">Betrag</TableCell>
              <TableCell>Details</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!rows.length ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography variant="body2" color="text.secondary">
                    Keine Umbuchungen im Zeitraum.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
            {rows.map((p) => {
              const outTx = p.out_transaction;
              const inTx = p.in_transaction;
              const kind = outTx.transfer_kind ?? 'none';
              const ki = kindIcon(kind);
              const fromName = accountNameById.get(outTx.bank_account_id) ?? `#${outTx.bank_account_id}`;
              const toName = accountNameById.get(inTx.bank_account_id) ?? `#${inTx.bank_account_id}`;
              const transferAmount = Math.abs(Number(outTx.amount || '0')).toFixed(2);
              return (
                <Fragment key={p.id}>
                  <TableRow hover>
                    <TableCell>{formatDate(outTx.booking_date)}</TableCell>
                    <TableCell>
                      <Stack direction="row" alignItems="center" spacing={0.75}>
                        {ki ? (
                          <Tooltip title={ki.label} enterDelay={400}>
                            <span>
                              <ki.Icon fontSize="small" color="action" />
                            </span>
                          </Tooltip>
                        ) : null}
                        <span>{kindLabel(kind)}</span>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {fromName} → {toName}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" alignItems="center" spacing={0.75} justifyContent="flex-end">
                        {ki ? (
                          <Tooltip title={ki.label} enterDelay={400}>
                            <span>
                              <ki.Icon fontSize="small" color="action" />
                            </span>
                          </Tooltip>
                        ) : null}
                        <Typography
                          component="span"
                          sx={{
                            fontVariantNumeric: 'tabular-nums',
                            fontWeight: 600,
                            color: amountSxColorFromTransaction(outTx),
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {formatMoney(transferAmount, outTx.currency)}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">
                        Paar #{p.id}
                      </Typography>
                    </TableCell>
                  </TableRow>
                  <TableRow
                    sx={{
                      '& > td': {
                        borderTop: 0,
                        bgcolor: 'action.hover',
                        py: { xs: 1, sm: 1.25 },
                        px: { xs: 0.5, sm: 1 },
                        verticalAlign: 'top',
                      },
                    }}
                  >
                    <TableCell colSpan={5}>
                      <TransactionBookingsTable
                        rows={[outTx, inTx]}
                        accounts={accountsQ.data ?? []}
                        hideInlineHint
                        embedded
                        emptyMessage="Keine Buchungen."
                      />
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

