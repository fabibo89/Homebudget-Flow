import { Fragment } from 'react';
import { Box, Divider, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import type { Transaction } from '../../api/client';
import { apiErrorMessage, fetchTransactionEnrichments } from '../../api/client';
import { amountSxColorFromTransaction, formatMoney } from '../../lib/transactionUi';
import BookingFlowTag from './BookingFlowTag';
import TransactionMeltdownFlagsSection from './TransactionMeltdownFlagsSection';
import { transactionFieldDisplayValue, TX_DETAIL_FIELDS } from './transactionDetailModel';

export default function TransactionDetailFields({
  tx,
  accountNameById,
  onTxUpdated,
}: {
  tx: Transaction;
  accountNameById: Map<number, string>;
  onTxUpdated?: (tx: Transaction) => void;
}) {
  const enrichmentsQuery = useQuery({
    queryKey: ['transaction-enrichments', tx.id],
    queryFn: () => fetchTransactionEnrichments(tx.id),
  });

  return (
    <Stack spacing={2}>
      {TX_DETAIL_FIELDS.map(({ key, label, mono }) => {
        const value = transactionFieldDisplayValue(tx, key, accountNameById);

        if (key === 'raw_json') {
          return (
            <Fragment key={key}>
              <Divider />
              <Box>
                <Typography variant="caption" color="text.secondary" component="div">
                  {label}{' '}
                  <Typography component="span" variant="caption" sx={{ opacity: 0.75 }}>
                    ({key})
                  </Typography>
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    mt: 0.25,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'monospace',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {value}
                </Typography>
              </Box>
            </Fragment>
          );
        }

        if (key === 'amount') {
          return (
            <Fragment key={key}>
              <Box>
                <Typography variant="caption" color="text.secondary" component="div">
                  {label}{' '}
                  <Typography component="span" variant="caption" sx={{ opacity: 0.75 }}>
                    ({key})
                  </Typography>
                </Typography>
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
                    {formatMoney(tx.amount, tx.currency || 'EUR')}
                  </Typography>
                </Stack>
                <TransactionMeltdownFlagsSection tx={tx} onUpdated={onTxUpdated} />
              </Box>
            </Fragment>
          );
        }

        return (
          <Box key={key}>
            <Typography variant="caption" color="text.secondary" component="div">
              {label}{' '}
              <Typography component="span" variant="caption" sx={{ opacity: 0.75 }}>
                ({key})
              </Typography>
            </Typography>
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
          </Box>
        );
      })}
      <Box>
        <Typography variant="caption" color="text.secondary" component="div">
          Externe Details (PayPal/Amazon)
        </Typography>
        {enrichmentsQuery.isLoading ? (
          <Typography variant="body2" sx={{ mt: 0.25 }} color="text.secondary">
            Lade Zusatzinformationen...
          </Typography>
        ) : enrichmentsQuery.isError ? (
          <Typography variant="body2" sx={{ mt: 0.25 }} color="error.main">
            {apiErrorMessage(enrichmentsQuery.error)}
          </Typography>
        ) : (enrichmentsQuery.data ?? []).length === 0 ? (
          <Typography variant="body2" sx={{ mt: 0.25 }} color="text.secondary">
            Keine externe Anreicherung vorhanden.
          </Typography>
        ) : (
          <Stack spacing={1} sx={{ mt: 0.5 }}>
            {(enrichmentsQuery.data ?? []).map((e) => (
              <Box key={e.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {String(e.source).toUpperCase()} {e.vendor ? `- ${e.vendor}` : ''}
                </Typography>
                <Typography variant="caption" color="text.secondary" component="div">
                  Ref: {e.external_ref || '-'}
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.25 }}>
                  {e.description || '-'}
                </Typography>
                {e.counterparty ? (
                  <Typography variant="caption" color="text.secondary" component="div">
                    Gegenpartei: {e.counterparty}
                  </Typography>
                ) : null}
              </Box>
            ))}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
