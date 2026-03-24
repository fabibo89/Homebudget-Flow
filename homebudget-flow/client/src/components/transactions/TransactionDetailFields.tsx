import { Box, Stack, Typography } from '@mui/material';
import type { Transaction } from '../../api/client';
import { amountSxColorFromTransaction } from '../../lib/transactionUi';
import BookingFlowTag from './BookingFlowTag';
import { transactionFieldDisplayValue, TX_DETAIL_FIELDS } from './transactionDetailModel';

export default function TransactionDetailFields({
  tx,
  accountNameById,
}: {
  tx: Transaction;
  accountNameById: Map<number, string>;
}) {
  return (
    <Stack spacing={2}>
      {TX_DETAIL_FIELDS.map(({ key, label, mono }) => {
        const value = transactionFieldDisplayValue(tx, key, accountNameById);
        return (
          <Box key={key}>
            <Typography variant="caption" color="text.secondary" component="div">
              {label}{' '}
              <Typography component="span" variant="caption" sx={{ opacity: 0.75 }}>
                ({key})
              </Typography>
            </Typography>
            {key === 'amount' ? (
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.25 }} flexWrap="wrap" useFlexGap>
                <BookingFlowTag amount={tx.amount} booking_flow={tx.booking_flow} />
                <Typography
                  variant="body2"
                  sx={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontVariantNumeric: 'tabular-nums',
                    color: amountSxColorFromTransaction(tx),
                    fontWeight: 600,
                  }}
                >
                  {value}
                </Typography>
              </Stack>
            ) : (
              <Typography
                variant="body2"
                sx={{
                  mt: 0.25,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: mono ? 'monospace' : 'inherit',
                  fontVariantNumeric: mono ? 'tabular-nums' : undefined,
                }}
              >
                {value}
              </Typography>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
