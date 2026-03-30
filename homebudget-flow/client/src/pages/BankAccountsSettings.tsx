import { useCallback, useEffect, useMemo, useState } from 'react';
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
import CategoryRuleConditionsEditor, {
  type CategoryRuleConditionsPayload,
} from '../components/CategoryRuleConditionsEditor';
import { useAccountGroupLabelMap } from '../hooks/useAccountGroupLabelMap';
import { sortBankAccountsForDisplay } from '../lib/sortBankAccounts';
import {
  apiErrorMessage,
  fetchAccounts,
  fetchCategoryRules,
  fetchBankCredentials,
  fetchTagZeroRule,
  upsertTagZeroRule,
  updateBankAccount,
  type CategoryRuleOut,
  type BankAccount,
} from '../api/client';
import { formatDate } from '../lib/transactionUi';

function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (Number.isNaN(n)) return `${amount} ${currency}`;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(n);
}

function moneyIsNegative(amount: string): boolean {
  const n = Number(amount);
  return !Number.isNaN(n) && n < 0;
}

export default function BankAccountsSettings() {
  const qc = useQueryClient();
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));
  const { groupLabelById, loading: groupsLoading, householdWithGroups } = useAccountGroupLabelMap();

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [form, setForm] = useState({
    account_group_id: 0,
    name: '',
    iban: '',
    currency: 'EUR',
    provider: 'comdirect',
    credential_id: '' as '' | number,
  });
  const [formError, setFormError] = useState('');
  const [tagZeroError, setTagZeroError] = useState('');
  const [tagZeroSource, setTagZeroSource] = useState<'none' | 'category_rule' | 'custom'>('none');
  const [tagZeroCategoryRuleId, setTagZeroCategoryRuleId] = useState<number | ''>('');
  const [tagZeroCustomPayload, setTagZeroCustomPayload] = useState<CategoryRuleConditionsPayload | null>(null);

  const credsQuery = useQuery({
    queryKey: ['bank-credentials'],
    queryFn: () => fetchBankCredentials(),
    enabled: editOpen && editing != null,
  });
  const creds = credsQuery.data ?? [];

  const tagZeroQuery = useQuery({
    queryKey: ['tag-zero-rule', editing?.id],
    queryFn: () => fetchTagZeroRule(editing!.id),
    enabled: editOpen && editing != null,
  });

  const categoryRulesQuery = useQuery({
    queryKey: ['category-rules', editing?.household_id],
    queryFn: () => fetchCategoryRules(editing!.household_id),
    enabled: editOpen && editing != null,
    staleTime: 60_000,
  });

  const categoryRules: CategoryRuleOut[] = categoryRulesQuery.data?.rules ?? [];

  const updateMut = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('Kein Konto');
      if (form.credential_id === '') throw new Error('FinTS-Zugang ist erforderlich.');
      return updateBankAccount(editing.id, {
        account_group_id: form.account_group_id,
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

  const saveTagZeroMut = useMutation({
    mutationFn: async () => {
      if (!editing) throw new Error('Kein Konto');
      setTagZeroError('');
      if (tagZeroSource === 'none') {
        return upsertTagZeroRule(editing.id, { source: 'none' });
      }
      if (tagZeroSource === 'category_rule') {
        if (tagZeroCategoryRuleId === '') throw new Error('Bitte eine Regel auswählen.');
        return upsertTagZeroRule(editing.id, { source: 'category_rule', category_rule_id: tagZeroCategoryRuleId });
      }
      if (!tagZeroCustomPayload?.conditions?.length) {
        throw new Error('Bitte mindestens eine gültige Bedingung angeben (Text und/oder Betragsgrenzen).');
      }
      return upsertTagZeroRule(editing.id, {
        source: 'custom',
        conditions: tagZeroCustomPayload.conditions,
        display_name_override: tagZeroCustomPayload.display_name_override ?? undefined,
        normalize_dot_space: tagZeroCustomPayload.normalize_dot_space,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tag-zero-rule'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (e) => setTagZeroError(apiErrorMessage(e)),
  });

  function openEdit(a: BankAccount) {
    setEditing(a);
    setForm({
      account_group_id: a.account_group_id,
      name: a.name,
      iban: a.iban,
      currency: a.currency,
      provider: a.provider,
      credential_id: a.credential_id,
    });
    setFormError('');
    setTagZeroError('');
    // defaults; actual values loaded via query
    setTagZeroSource('none');
    setTagZeroCategoryRuleId('');
    setTagZeroCustomPayload(null);
    setEditOpen(true);
  }

  // Hydrate Tag-Null config when loaded
  const tz = tagZeroQuery.data;
  useEffect(() => {
    if (!editOpen || !editing || !tz) return;
    setTagZeroSource(tz.source);
    setTagZeroCategoryRuleId(tz.category_rule_id ? Number(tz.category_rule_id) : '');
  }, [editOpen, editing?.id, tz]);

  const tagZeroHydrateKey = `${editing?.id ?? 0}-${tagZeroSource}-${tagZeroQuery.dataUpdatedAt ?? 0}`;

  const tagZeroEditorInitial = useMemo((): CategoryRuleConditionsPayload => {
    if (!editing || tagZeroSource !== 'custom') {
      return { conditions: [], display_name_override: null, normalize_dot_space: false };
    }
    if (tz?.source === 'custom') {
      return {
        conditions: tz.conditions ?? [],
        display_name_override: tz.display_name_override ?? null,
        normalize_dot_space: Boolean(tz.normalize_dot_space),
      };
    }
    return { conditions: [], display_name_override: null, normalize_dot_space: false };
  }, [editing?.id, tagZeroSource, tz?.source, tz?.conditions, tz?.display_name_override, tz?.normalize_dot_space]);

  const onTagZeroCustomChange = useCallback((p: CategoryRuleConditionsPayload | null) => {
    setTagZeroCustomPayload(p);
  }, []);

  const groupOptionsForEdit = useMemo(() => {
    if (!editing) return [];
    const hwg = householdWithGroups.find((x) => x.household.id === editing.household_id);
    return hwg?.groups ?? [];
  }, [editing, householdWithGroups]);

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
        maxWidth="md"
        fullScreen={isXs}
      >
        <DialogTitle>Bankkonto bearbeiten</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {formError ? <Alert severity="error">{formError}</Alert> : null}
            {editing ? (
              <Typography variant="body2" color="text.secondary">
                Saldo-Stand: {editing.balance_at ? formatDate(editing.balance_at) : '—'}
              </Typography>
            ) : null}
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle2" fontWeight={700}>
                  Tag Null Regel
                </Typography>
                {tagZeroError ? <Alert severity="error">{tagZeroError}</Alert> : null}
                <FormControl fullWidth size="small">
                  <InputLabel id="tz-source">Quelle</InputLabel>
                  <Select
                    labelId="tz-source"
                    label="Quelle"
                    value={tagZeroSource}
                    onChange={(e) => {
                      const v = String(e.target.value) as 'none' | 'category_rule' | 'custom';
                      setTagZeroSource(v);
                      setTagZeroError('');
                    }}
                  >
                    <MenuItem value="none">Keine</MenuItem>
                    <MenuItem value="category_rule">Bestehende Kategorie-Regel wählen</MenuItem>
                    <MenuItem value="custom">Eigene Regel (wie Kategorie-Regeln)</MenuItem>
                  </Select>
                </FormControl>

                {tagZeroSource === 'category_rule' ? (
                  <FormControl fullWidth size="small" disabled={categoryRulesQuery.isLoading || categoryRulesQuery.isError}>
                    <InputLabel id="tz-cat-rule">Kategorie-Regel</InputLabel>
                    <Select
                      labelId="tz-cat-rule"
                      label="Kategorie-Regel"
                      value={tagZeroCategoryRuleId === '' ? '' : tagZeroCategoryRuleId}
                      onChange={(e) => setTagZeroCategoryRuleId(e.target.value === '' ? '' : Number(e.target.value))}
                    >
                      <MenuItem value="">—</MenuItem>
                      {categoryRules.map((r) => (
                        <MenuItem key={r.id} value={r.id}>
                          {r.display_name}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                ) : null}

                {tagZeroSource === 'custom' ? (
                  <CategoryRuleConditionsEditor
                    hydrateKey={tagZeroHydrateKey}
                    initial={tagZeroEditorInitial}
                    onPayloadChange={onTagZeroCustomChange}
                    disabled={saveTagZeroMut.isPending || tagZeroQuery.isLoading}
                  />
                ) : null}

                <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    disabled={saveTagZeroMut.isPending || tagZeroQuery.isLoading}
                    onClick={() => saveTagZeroMut.mutate()}
                  >
                    {saveTagZeroMut.isPending ? 'Speichern…' : 'Regel speichern'}
                  </Button>
                </Box>
              </Stack>
            </Paper>
            {editing && groupOptionsForEdit.length > 0 ? (
              <FormControl fullWidth>
                <InputLabel id="bank-acc-group">Kontogruppe</InputLabel>
                <Select
                  labelId="bank-acc-group"
                  label="Kontogruppe"
                  value={form.account_group_id}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, account_group_id: Number(e.target.value) }))
                  }
                >
                  {groupOptionsForEdit.map((g) => (
                    <MenuItem key={g.id} value={g.id}>
                      {groupLabelById.get(g.id) ?? g.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : editing ? (
              <Alert severity="info">
                Keine weitere Kontogruppe im gleichen Haushalt – Zuordnung kann nicht geändert werden.
              </Alert>
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
