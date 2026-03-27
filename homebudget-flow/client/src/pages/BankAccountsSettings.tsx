import { useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  Link,
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
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { Edit as EditIcon } from '@mui/icons-material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccountGroupLabelMap } from '../hooks/useAccountGroupLabelMap';
import { sortBankAccountsForDisplay } from '../lib/sortBankAccounts';
import {
  apiErrorMessage,
  fetchAccounts,
  fetchBankCredentials,
  updateBankAccount,
  type BankAccount,
} from '../api/client';

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (Number.isNaN(n)) return `${amount} ${currency}`;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(n);
}

function moneyIsNegative(amount: string): boolean {
  const n = Number(amount);
  return !Number.isNaN(n) && n < 0;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    const s = String(iso).slice(0, 10);
    return new Intl.DateTimeFormat('de-DE').format(new Date(s + 'T12:00:00'));
  } catch {
    return iso;
  }
}

export default function BankAccountsSettings() {
  const qc = useQueryClient();
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));
  const { groupLabelById, loading: groupsLoading } = useAccountGroupLabelMap();

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [form, setForm] = useState({
    name: '',
    iban: '',
    currency: 'EUR',
    provider: 'comdirect',
    credential_id: '' as '' | number,
  });
  const [formError, setFormError] = useState('');

  const credsQuery = useQuery({
    queryKey: ['bank-credentials'],
    queryFn: () => fetchBankCredentials(),
    enabled: editOpen && editing != null,
  });
  const creds = credsQuery.data ?? [];

  const updateMut = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('Kein Konto');
      if (form.credential_id === '') throw new Error('FinTS-Zugang ist erforderlich.');
      return updateBankAccount(editing.id, {
        name: form.name.trim(),
        iban: form.iban.replace(/\s/g, '').trim(),
        currency: form.currency.trim().toUpperCase(),
        provider: form.provider.trim(),
        credential_id: form.credential_id,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      setEditOpen(false);
      setEditing(null);
      setFormError('');
    },
    onError: (e) => setFormError(apiErrorMessage(e)),
  });

  function openEdit(a: BankAccount) {
    setEditing(a);
    setForm({
      name: a.name,
      iban: a.iban,
      currency: a.currency,
      provider: a.provider,
      credential_id: a.credential_id,
    });
    setFormError('');
    setEditOpen(true);
  }

  const loading = groupsLoading || accountsQuery.isLoading;
  const rows = useMemo(
    () => sortBankAccountsForDisplay(accountsQuery.data ?? [], groupLabelById),
    [accountsQuery.data, groupLabelById],
  );

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Bankkonten
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Alle Konten, die in der Übersicht und beim Sync verwendet werden. Neue Konten entstehen u. a. über FinTS
          (Bankzugang) oder unter{' '}
          <Link component={RouterLink} to="/settings/setup" underline="hover">
            Einrichtung
          </Link>
          .
        </Typography>
      </Box>

      {accountsQuery.isError ? <Alert severity="error">{apiErrorMessage(accountsQuery.error)}</Alert> : null}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : rows.length === 0 ? (
        <Alert severity="info">Noch keine Bankkonten – zuerst FinTS-Zugang speichern oder unter Einrichtung anlegen.</Alert>
      ) : (
        <TableContainer component={Paper} elevation={0} sx={{ border: 1, borderColor: 'divider', overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 760 }}>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Kontogruppe</TableCell>
                <TableCell>Provider</TableCell>
                <TableCell>IBAN</TableCell>
                <TableCell align="right">Saldo</TableCell>
                <TableCell align="right">Aktion</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id} hover>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {groupLabelById.get(a.account_group_id) ?? `Gruppe #${a.account_group_id}`}
                    </Typography>
                  </TableCell>
                  <TableCell>{a.provider}</TableCell>
                  <TableCell sx={{ maxWidth: 220 }} title={a.iban}>
                    <Typography variant="body2" noWrap component="span">
                      {a.iban}
                    </Typography>
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ fontVariantNumeric: 'tabular-nums', color: moneyIsNegative(a.balance) ? 'error.main' : 'text.primary' }}
                  >
                    {formatMoney(a.balance, a.currency)}
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => openEdit(a)}>
                      Bearbeiten
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={editOpen}
        onClose={() => !updateMut.isPending && setEditOpen(false)}
        fullWidth
        maxWidth="sm"
        fullScreen={isXs}
      >
        <DialogTitle>Bankkonto bearbeiten</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {formError ? <Alert severity="error">{formError}</Alert> : null}
            {editing ? (
              <Typography variant="body2" color="text.secondary">
                Kontogruppe:{' '}
                {groupLabelById.get(editing.account_group_id) ?? `#${editing.account_group_id}`} · Saldo-Stand:{' '}
                {formatDate(editing.balance_at)}
              </Typography>
            ) : null}
            <TextField
              label="Anzeigename"
              fullWidth
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
            <TextField
              label="IBAN"
              fullWidth
              required
              helperText="Ohne Leerzeichen; eindeutig pro Provider."
              value={form.iban}
              onChange={(e) => setForm((f) => ({ ...f, iban: e.target.value }))}
            />
            <TextField
              label="Währung"
              fullWidth
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
            <TextField
              label="Provider"
              fullWidth
              value={form.provider}
              onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
            />
            <FormControl fullWidth required>
              <InputLabel id="cred-edit">FinTS-Zugang</InputLabel>
              <Select
                labelId="cred-edit"
                label="FinTS-Zugang"
                value={form.credential_id === '' ? '' : form.credential_id}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({ ...f, credential_id: v === '' ? '' : Number(v) }));
                }}
              >
                {creds.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.provider} · BLZ {c.fints_blz}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {credsQuery.isError ? (
              <Alert severity="warning">FinTS-Zugänge konnten nicht geladen werden.</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={updateMut.isPending}>
            Abbrechen
          </Button>
          <Button
            variant="contained"
            disabled={
              updateMut.isPending ||
              !form.name.trim() ||
              !form.iban.trim() ||
              form.credential_id === '' ||
              creds.length === 0
            }
            onClick={() => {
              setFormError('');
              updateMut.mutate();
            }}
          >
            {updateMut.isPending ? 'Speichern…' : 'Speichern'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
