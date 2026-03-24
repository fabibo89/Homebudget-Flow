import { Chip, Typography } from '@mui/material';
import type { BookingFlow as ApiBookingFlow } from '../../api/client';
import { bookingFlowFromTransaction, bookingFlowLabel } from '../../lib/transactionUi';

/** Chip „Einnahme“ / „Ausgabe“ bzw. „—“ bei neutralem Betrag (`booking_flow` von der API oder aus `amount`). */
export default function BookingFlowTag({
  amount,
  booking_flow,
}: {
  amount: string;
  booking_flow?: ApiBookingFlow | null;
}) {
  const flow = bookingFlowFromTransaction({ amount, booking_flow: booking_flow ?? undefined });
  if (flow === 'neutral') {
    return (
      <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'inline-block', minWidth: 24 }}>
        —
      </Typography>
    );
  }
  return (
    <Chip
      size="small"
      label={bookingFlowLabel(flow)}
      color={flow === 'einnahme' ? 'success' : 'error'}
      variant="outlined"
      sx={{
        height: 22,
        maxWidth: '100%',
        '& .MuiChip-label': { px: 1, py: 0, lineHeight: 1.25, fontSize: '0.7rem' },
      }}
    />
  );
}
