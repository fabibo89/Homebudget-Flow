import { useMemo } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { BankAccount, Transaction } from '../../api/client';
import TransactionDetailFields from './TransactionDetailFields';

type Props = {
  open: boolean;
  tx: Transaction | null;
  accounts: BankAccount[];
  onClose: () => void;
  loading?: boolean;
  onTxUpdated?: (tx: Transaction) => void;
};

export default function TransactionDetailDialog({
  open,
  tx,
  accounts,
  onClose,
  loading = false,
  onTxUpdated,
}: Props) {
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));

  const accountNameById = useMemo(() => {
    const m = new Map<number, string>();
    accounts.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [accounts]);

  return (
    <Dialog open={open} onClose={onClose} fullScreen={isXs} maxWidth="sm" fullWidth scroll="paper">
      <DialogTitle>Buchungsdetails</DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : tx ? (
          <TransactionDetailFields tx={tx} accountNameById={accountNameById} onTxUpdated={onTxUpdated} />
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Schließen</Button>
      </DialogActions>
    </Dialog>
  );
}
