import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Snackbar,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, fetchCategories, patchTransactionCategory, type BankAccount, type Transaction } from '../../api/client';
import CategoryRuleOverwriteDialog from '../CategoryRuleOverwriteDialog';
import CreateCategoryRuleDialog from '../CreateCategoryRuleDialog';
import {
  CategoryPickOption,
  amountSxColorFromTransaction,
  flattenSubcategoryPickOptions,
  formatDate,
  formatMoney,
} from '../../lib/transactionUi';
import TransactionDetailFields from './TransactionDetailFields';

const CATEGORY_COLUMN_HINT =
  'Linksklick: Kategorie ändern oder Regel anlegen (wenn noch keine Kategorie). Rechtsklick: Kategorieliste öffnet sich sofort zur manuellen Auswahl (ohne Regel).';

function clipText(s: string, max = 64): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

type Props = {
  rows: Transaction[];
  accounts: BankAccount[];
  isLoading?: boolean;
  error?: unknown;
  emptyMessage?: string;
  /** Optional: Überschrift über der Tabelle */
  title?: string;
  /** Wenn true: kein Hinweistext unter der Überschrift (z. B. wenn die Seite schon erklärt). */
  hideInlineHint?: boolean;
  /** Linksklick/Rechtsklick auf Kategorie wie in der Übersicht (Tooltips, manuelle Zuordnung). */
  categoryColumnAdvanced?: boolean;
};

export default function TransactionBookingsTable({
  rows,
  accounts,
  isLoading = false,
  error,
  emptyMessage = 'Keine Buchungen.',
  title,
  hideInlineHint = false,
  categoryColumnAdvanced = true,
}: Props) {
  const qc = useQueryClient();
  const [txDetail, setTxDetail] = useState<Transaction | null>(null);
  const [categoryDialogMode, setCategoryDialogMode] = useState<'default' | 'manual'>('default');
  const [categoryDialogTx, setCategoryDialogTx] = useState<Transaction | null>(null);
  const [pickCategoryId, setPickCategoryId] = useState<number | null>(null);
  const [categoryRuleSavedSnack, setCategoryRuleSavedSnack] = useState<string | null>(null);
  const [ruleOverwriteDialog, setRuleOverwriteDialog] = useState<{
    candidates: CategoryRuleOverwriteCandidate[];
    truncated: boolean;
  } | null>(null);
  /** Rechtsklick: Dropdown der Kategorie-Auswahl sofort geöffnet halten. */
  const [manualCategoryListOpen, setManualCategoryListOpen] = useState(false);

  const accountNameById = useMemo(() => {
    const m = new Map<number, string>();
    accounts.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [accounts]);

  const categoryDialogHouseholdId = useMemo(() => {
    if (!categoryDialogTx) return null;
    const acc = accounts.find((a) => a.id === categoryDialogTx.bank_account_id);
    return acc?.household_id ?? null;
  }, [categoryDialogTx, accounts]);

  const categoriesDialogQuery = useQuery({
    queryKey: ['categories', categoryDialogHouseholdId],
    queryFn: () => fetchCategories(categoryDialogHouseholdId!),
    enabled: Boolean(categoryDialogTx && categoryDialogHouseholdId != null),
  });

  useEffect(() => {
    if (categoryDialogMode !== 'manual' || categoryDialogTx == null) {
      setManualCategoryListOpen(false);
      return;
    }
    if (categoriesDialogQuery.isLoading || categoriesDialogQuery.isError) {
      setManualCategoryListOpen(false);
      return;
    }
    const id = requestAnimationFrame(() => setManualCategoryListOpen(true));
    return () => cancelAnimationFrame(id);
  }, [
    categoryDialogMode,
    categoryDialogTx?.id,
    categoriesDialogQuery.isLoading,
    categoriesDialogQuery.isError,
    categoriesDialogQuery.dataUpdatedAt,
  ]);

  const categoryPickOptions: CategoryPickOption[] = useMemo(() => {
    const clear: CategoryPickOption = { id: null, label: 'Keine Kategorie' };
    const roots = categoriesDialogQuery.data ?? [];
    const subs = flattenSubcategoryPickOptions(roots);
    if (subs.length === 0) return [clear];
    return [clear, ...subs.map((x) => ({ id: x.id, label: x.label }))];
  }, [categoriesDialogQuery.data]);

  const categoryPickValue: CategoryPickOption | null = useMemo(() => {
    const match = categoryPickOptions.find((o) => o.id === pickCategoryId);
    if (match) return match;
    if (pickCategoryId == null) return categoryPickOptions[0] ?? null;
    return null;
  }, [categoryPickOptions, pickCategoryId]);

  function invalidateAfterTxMutation() {
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['analyses-transactions'] });
  }

  const patchCategoryMut = useMutation({
    mutationFn: ({ txId, categoryId }: { txId: number; categoryId: number | null }) =>
      patchTransactionCategory(txId, { category_id: categoryId }),
    onSuccess: () => {
      invalidateAfterTxMutation();
      setCategoryDialogTx(null);
    },
  });

  const categoryDialogUseRuleFlow =
    categoryDialogMode === 'default' &&
    categoryDialogTx != null &&
    categoryDialogTx.category_id == null;

  let categoryDialogTitle = '';
  if (categoryDialogTx) {
    if (categoryDialogMode === 'manual') {
      categoryDialogTitle =
        categoryDialogTx.category_id != null ? 'Kategorie ändern' : 'Kategorie zuweisen';
    } else {
      categoryDialogTitle =
        categoryDialogTx.category_id != null ? 'Kategorie ändern' : 'Kategorie-Regel anlegen';
    }
  }

  function openCategoryDialog(t: Transaction, mode: 'default' | 'manual') {
    patchCategoryMut.reset();
    setManualCategoryListOpen(false);
    setCategoryDialogMode(mode);
    setCategoryDialogTx(t);
    setPickCategoryId(t.category_id ?? null);
  }

  if (error) {
    return <Alert severity="error">{apiErrorMessage(error)}</Alert>;
  }

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <>
      <Snackbar
        open={categoryRuleSavedSnack != null}
        autoHideDuration={6000}
        onClose={() => setCategoryRuleSavedSnack(null)}
        message={categoryRuleSavedSnack ?? ''}
      />
      {title ? (
        <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
          {title}
        </Typography>
      ) : null}
      {!hideInlineHint ? (
        <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>
          Zeile anklicken für Buchungsdetails.
          {categoryColumnAdvanced
            ? ' Kategorie: Linksklick Regel oder Änderung, Rechtsklick öffnet sofort die Auswahlliste (ohne Regel).'
            : ' Kategorie-Spalte für Zuordnung oder Regel.'}
        </Typography>
      ) : null}
      <Dialog
        open={txDetail !== null}
        onClose={() => setTxDetail(null)}
        maxWidth="sm"
        fullWidth
        scroll="paper"
      >
        <DialogTitle>Buchungsdetails</DialogTitle>
        <DialogContent dividers>
          {txDetail ? <TransactionDetailFields tx={txDetail} accountNameById={accountNameById} /> : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTxDetail(null)}>Schließen</Button>
        </DialogActions>
      </Dialog>
      <CreateCategoryRuleDialog
        open={Boolean(categoryDialogTx) && categoryDialogUseRuleFlow}
        onClose={() => setCategoryDialogTx(null)}
        householdId={categoryDialogHouseholdId}
        transaction={categoryDialogTx}
        onCreated={(data) => {
          const extra =
            data.transactions_updated > 0
              ? ` Zusätzlich ${data.transactions_updated} unkategorisierte Buchung(en) zugeordnet.`
              : '';
          setCategoryRuleSavedSnack(`Regel gespeichert.${extra}`);
          if (data.category_overwrite_candidates.length > 0) {
            setRuleOverwriteDialog({
              candidates: data.category_overwrite_candidates,
              truncated: data.category_overwrite_truncated,
            });
          }
        }}
      />
      <Dialog
        open={Boolean(categoryDialogTx) && !categoryDialogUseRuleFlow}
        onClose={() => {
          if (patchCategoryMut.isPending) return;
          patchCategoryMut.reset();
          setCategoryDialogTx(null);
        }}
        maxWidth="sm"
        fullWidth
        scroll="paper"
      >
        <DialogTitle>{categoryDialogTitle}</DialogTitle>
        <DialogContent>
          {categoryDialogHouseholdId == null ? (
            <Alert severity="warning" sx={{ mt: 1 }}>
              Für dieses Konto konnte kein Haushalt ermittelt werden. Kategorien sind pro Haushalt verwaltet.
            </Alert>
          ) : categoriesDialogQuery.isError ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {apiErrorMessage(categoriesDialogQuery.error)}
            </Alert>
          ) : (
            <Stack spacing={2} sx={{ pt: 1 }}>
              {categoriesDialogQuery.isLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                  <CircularProgress size={32} />
                </Box>
              ) : categoryDialogTx != null ? (
                <>
                  <Autocomplete<CategoryPickOption, false, false, false>
                    open={manualCategoryListOpen}
                    onOpen={() => setManualCategoryListOpen(true)}
                    onClose={() => setManualCategoryListOpen(false)}
                    slotProps={{
                      popper: {
                        placement: 'bottom-start',
                        sx: { zIndex: (theme) => theme.zIndex.modal + 2 },
                      },
                    }}
                    options={categoryPickOptions}
                    getOptionLabel={(o) => o.label}
                    isOptionEqualToValue={(a, b) => a.id === b.id}
                    value={categoryPickValue}
                    onChange={(_, v) => setPickCategoryId(v?.id ?? null)}
                    renderInput={(params) => <TextField {...params} label="Kategorie" autoFocus />}
                  />
                  {pickCategoryId != null && categoryPickValue == null ? (
                    <Typography variant="caption" color="text.secondary">
                      Die bisherige Kategorie fehlt in der Liste — bitte neu zuweisen oder entfernen.
                    </Typography>
                  ) : null}
                  {patchCategoryMut.isError ? (
                    <Alert severity="error">{apiErrorMessage(patchCategoryMut.error)}</Alert>
                  ) : null}
                </>
              ) : null}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              patchCategoryMut.reset();
              setCategoryDialogTx(null);
            }}
            disabled={patchCategoryMut.isPending}
          >
            Abbrechen
          </Button>
          <Button
            variant="contained"
            disabled={
              patchCategoryMut.isPending ||
              categoryDialogTx == null ||
              categoryDialogHouseholdId == null ||
              categoriesDialogQuery.isLoading ||
              categoriesDialogQuery.isError ||
              pickCategoryId === (categoryDialogTx?.category_id ?? null)
            }
            onClick={() => {
              if (!categoryDialogTx) return;
              patchCategoryMut.mutate({
                txId: categoryDialogTx.id,
                categoryId: pickCategoryId,
              });
            }}
          >
            {patchCategoryMut.isPending ? 'Speichern…' : 'Speichern'}
          </Button>
        </DialogActions>
      </Dialog>
      <CategoryRuleOverwriteDialog
        open={ruleOverwriteDialog != null}
        onClose={() => setRuleOverwriteDialog(null)}
        candidates={ruleOverwriteDialog?.candidates ?? []}
        truncated={ruleOverwriteDialog?.truncated ?? false}
        onNotify={(msg) =>
          setCategoryRuleSavedSnack((s) => `${s ?? ''}${s ? ' ' : ''}${msg}`)
        }
      />
      <TableContainer component={Paper} elevation={0} sx={{ border: 1, borderColor: 'divider' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Datum</TableCell>
              <TableCell>Konto</TableCell>
              <TableCell align="right">Betrag</TableCell>
              <TableCell>
                {categoryColumnAdvanced ? (
                  <Tooltip title={CATEGORY_COLUMN_HINT} enterDelay={400}>
                    <span>Kategorie</span>
                  </Tooltip>
                ) : (
                  'Kategorie'
                )}
              </TableCell>
              <TableCell>Verwendungszweck</TableCell>
              <TableCell>Gegenpartei</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography color="text.secondary" sx={{ py: 2 }}>
                    {emptyMessage}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((t) => (
                <TableRow key={t.id} hover onClick={() => setTxDetail(t)} sx={{ cursor: 'pointer' }}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(t.booking_date)}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={accountNameById.get(t.bank_account_id) ?? `#${t.bank_account_id}`}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{
                      fontVariantNumeric: 'tabular-nums',
                      fontWeight: 600,
                            color: amountSxColorFromTransaction(t),
                    }}
                  >
                    {formatMoney(t.amount, t.currency)}
                  </TableCell>
                  <TableCell
                    sx={{
                      maxWidth: 200,
                      cursor: 'pointer',
                      '&:hover': { color: 'primary.main' },
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      openCategoryDialog(t, 'default');
                    }}
                    onContextMenu={
                      categoryColumnAdvanced
                        ? (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openCategoryDialog(t, 'manual');
                          }
                        : undefined
                    }
                  >
                    {categoryColumnAdvanced ? (
                      <Tooltip title={CATEGORY_COLUMN_HINT} enterDelay={500}>
                        <Typography variant="body2" noWrap component="span">
                          {t.category_name ?? '—'}
                        </Typography>
                      </Tooltip>
                    ) : (
                      <Typography variant="body2" noWrap title={t.category_name ?? undefined}>
                        {t.category_name ?? '—'}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{t.description}</TableCell>
                  <TableCell>{t.counterparty ?? '—'}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}
