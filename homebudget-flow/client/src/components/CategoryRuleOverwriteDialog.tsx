import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, bulkPatchTransactionCategories, type CategoryRuleOverwriteCandidate } from '../api/client';
import { amountSxColorFromBookingArt, formatDate, formatMoney } from '../lib/transactionUi';

function clipText(s: string, max = 64): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export type CategoryRuleOverwriteDialogProps = {
  open: boolean;
  onClose: () => void;
  candidates: CategoryRuleOverwriteCandidate[];
  truncated: boolean;
  /** Nach erfolgreichem Bulk-Update (optional, z. B. Snackbar) */
  onNotify?: (message: string) => void;
};

export default function CategoryRuleOverwriteDialog({
  open,
  onClose,
  candidates,
  truncated,
  onNotify,
}: CategoryRuleOverwriteDialogProps) {
  const qc = useQueryClient();
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));
  const [localCandidates, setLocalCandidates] = useState<CategoryRuleOverwriteCandidate[]>(candidates);

  useEffect(() => {
    if (open) setLocalCandidates(candidates);
  }, [open, candidates]);

  function invalidateAfterTxMutation() {
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['analyses-transactions'] });
  }

  const bulkRuleOverwriteMut = useMutation({
    mutationFn: (items: { transaction_id: number; category_id: number }[]) =>
      bulkPatchTransactionCategories({ items }),
    onSuccess: (res, variables) => {
      invalidateAfterTxMutation();
      const applied = new Set(variables.map((v) => v.transaction_id));
      onNotify?.(`${res.updated} Kategorie(n) nach Regel übernommen.`);
      setLocalCandidates((prev) => {
        const remaining = prev.filter((c) => !applied.has(c.transaction_id));
        if (remaining.length === 0) onClose();
        return remaining;
      });
    },
  });

  function skipOne(txId: number) {
    setLocalCandidates((prev) => {
      const remaining = prev.filter((c) => c.transaction_id !== txId);
      if (remaining.length === 0) onClose();
      return remaining;
    });
  }

  function applyOne(c: CategoryRuleOverwriteCandidate) {
    bulkRuleOverwriteMut.mutate([
      { transaction_id: c.transaction_id, category_id: c.suggested_category_id },
    ]);
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (bulkRuleOverwriteMut.isPending) return;
        bulkRuleOverwriteMut.reset();
        onClose();
      }}
      fullScreen={isXs}
      maxWidth="md"
      fullWidth
      scroll="paper"
    >
      <DialogTitle>Kategorie würde sich ändern</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Unkategorisierte Buchungen wurden bereits zugeordnet. Die folgenden Buchungen hatten schon eine Kategorie; die
            aktuelle Regelliste würde eine andere vorschlagen. Sie können pro Zeile die Regel-Kategorie übernehmen oder die
            bisherige Zuordnung behalten.
          </Typography>
          {truncated ? (
            <Alert severity="warning">
              Es gibt mehr als {localCandidates.length} solcher Buchungen; die Liste ist begrenzt. Nach der Bearbeitung
              können Sie die Regel erneut anwenden oder Einzelbuchungen anpassen.
            </Alert>
          ) : null}
          {bulkRuleOverwriteMut.isError ? (
            <Alert severity="error">{apiErrorMessage(bulkRuleOverwriteMut.error)}</Alert>
          ) : null}
          {isXs ? (
            <Stack spacing={1.25}>
              {localCandidates.map((c) => (
                <Card key={c.transaction_id} variant="outlined">
                  <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Stack direction="row" alignItems="baseline" justifyContent="space-between" spacing={1}>
                      <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                        {formatDate(c.booking_date)}
                      </Typography>
                      <Typography
                        sx={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 700,
                          color: amountSxColorFromBookingArt(c.amount),
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatMoney(c.amount, c.currency)}
                      </Typography>
                    </Stack>
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      {clipText(c.description, 120) || '—'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
                      Bisher: {c.current_category_name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      Regel: {c.suggested_category_name}
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                      <Button
                        size="small"
                        variant="contained"
                        disabled={bulkRuleOverwriteMut.isPending}
                        onClick={() => applyOne(c)}
                      >
                        Überschreiben
                      </Button>
                      <Button
                        size="small"
                        disabled={bulkRuleOverwriteMut.isPending}
                        onClick={() => skipOne(c.transaction_id)}
                      >
                        Überspringen
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
              ))}
            </Stack>
          ) : (
            <TableContainer sx={{ maxHeight: 360 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>Datum</TableCell>
                    <TableCell align="right">Betrag</TableCell>
                    <TableCell>Verwendungszweck</TableCell>
                    <TableCell>Bisher</TableCell>
                    <TableCell>Regel</TableCell>
                    <TableCell align="right">Aktion</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {localCandidates.map((c) => (
                    <TableRow key={c.transaction_id}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(c.booking_date)}</TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 600,
                          color: amountSxColorFromBookingArt(c.amount),
                        }}
                      >
                        {formatMoney(c.amount, c.currency)}
                      </TableCell>
                      <TableCell sx={{ maxWidth: 200 }}>
                        <Typography variant="body2" noWrap title={c.description}>
                          {clipText(c.description, 56) || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 140 }}>
                        <Typography variant="body2" noWrap title={c.current_category_name}>
                          {c.current_category_name}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 140 }}>
                        <Typography variant="body2" noWrap title={c.suggested_category_name}>
                          {c.suggested_category_name}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                          <Button
                            size="small"
                            variant="contained"
                            disabled={bulkRuleOverwriteMut.isPending}
                            onClick={() => applyOne(c)}
                          >
                            Überschreiben
                          </Button>
                          <Button
                            size="small"
                            disabled={bulkRuleOverwriteMut.isPending}
                            onClick={() => skipOne(c.transaction_id)}
                          >
                            Überspringen
                          </Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            bulkRuleOverwriteMut.reset();
            onClose();
          }}
          disabled={bulkRuleOverwriteMut.isPending}
        >
          Schließen (rest behalten)
        </Button>
        <Button
          variant="contained"
          disabled={bulkRuleOverwriteMut.isPending || !localCandidates.length}
          onClick={() => {
            if (!localCandidates.length) return;
            bulkRuleOverwriteMut.mutate(
              localCandidates.map((c) => ({
                transaction_id: c.transaction_id,
                category_id: c.suggested_category_id,
              })),
            );
          }}
        >
          {bulkRuleOverwriteMut.isPending ? 'Speichern…' : 'Alle überschreiben'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
