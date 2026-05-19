import { Alert, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, patchTransactionMeltdownFlags, type Transaction } from '../../api/client';

function isPositiveAmount(amount: string): boolean {
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}

type Props = {
  tx: Transaction;
  onUpdated?: (tx: Transaction) => void;
};

export default function TransactionMeltdownFlagsSection({ tx, onUpdated }: Props) {
  const qc = useQueryClient();

  const meltdownMut = useMutation({
    mutationFn: (exclude: boolean) =>
      patchTransactionMeltdownFlags(tx.id, { meltdown_exclude_from_start: exclude }),
    onSuccess: (updated) => {
      onUpdated?.(updated);
      void qc.invalidateQueries({ queryKey: ['dayzero-meltdown'] });
      void qc.invalidateQueries({ queryKey: ['dayzero-booking-detail'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['analyses-transactions'] });
    },
  });

  if (!isPositiveAmount(tx.amount)) return null;

  return (
    <Stack spacing={0.75} sx={{ mt: 0.5 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={Boolean(tx.meltdown_exclude_from_start)}
              disabled={meltdownMut.isPending}
              onChange={(e) => meltdownMut.mutate(e.target.checked)}
            />
          }
          label="Nicht in Meltdown-Start (Einnahmen-Summe), aber im Meltdown-Verlauf"
        />
        <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.45 }}>
          Standard: positive Buchungen erhöhen die Summe der Geldeingänge und damit den Meltdown-Start. Mit dieser
          Option zählen sie nur am Buchungstag in der Meltdown-Restlinie mit, nicht in der Start-Summe.
        </Typography>
        {meltdownMut.isError ? <Alert severity="error">{apiErrorMessage(meltdownMut.error)}</Alert> : null}
    </Stack>
  );
}
