import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
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
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiErrorMessage,
  fetchCategories,
  patchTransactionCategory,
  type BankAccount,
  type CategoryRuleOverwriteCandidate,
  type Transaction,
} from '../../api/client';
import CategoryRuleOverwriteDialog from '../CategoryRuleOverwriteDialog';
import CreateCategoryRuleDialog from '../CreateCategoryRuleDialog';
import { CategorySymbolDisplay } from '../CategorySymbol';
import {
  CategoryPickOption,
  amountSxColorFromTransaction,
  flattenSubcategoryPickOptionsWithMeta,
  formatDate,
  formatMoney,
} from '../../lib/transactionUi';
import TransactionDetailFields from './TransactionDetailFields';
import GroupsIcon from '@mui/icons-material/Groups';
import PersonIcon from '@mui/icons-material/Person';
import SyncAltIcon from '@mui/icons-material/SyncAlt';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';

const CATEGORY_COLUMN_HINT =
  'Linksklick: Kategorie ändern oder Regel anlegen (wenn noch keine Kategorie). Rechtsklick: Kategorieliste öffnet sich sofort zur manuellen Auswahl (ohne Regel).';

function _hexLooksValid(hex: string | null | undefined): hex is string {
  if (!hex?.trim()) return false;
  return /^#[0-9A-Fa-f]{6}$/.test(hex.trim());
}

/** Kategoriename mit Farbpunkt (wenn Farbe bekannt), sonst „—“. */
function TransactionCategoryCellInner({ t }: { t: Transaction }) {
  if (t.category_name?.trim()) {
    const hex = _hexLooksValid(t.category_color_hex) ? t.category_color_hex!.trim() : null;
    return (
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minWidth: 0 }}>
        {hex ? (
          <Box
            aria-hidden
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              bgcolor: hex,
              boxShadow: (theme) => `inset 0 0 0 1px ${theme.palette.divider}`,
            }}
          />
        ) : null}
        <Typography variant="body2" noWrap component="span">
          {t.category_name}
        </Typography>
      </Stack>
    );
  }
  return (
    <Typography variant="body2" noWrap component="span">
      —
    </Typography>
  );
}

function transferIcon(kind: Transaction['transfer_kind'] | undefined) {
  if (kind === 'own_internal') return { Icon: SyncAltIcon, label: 'Umbuchung (eigene)' };
  if (kind === 'own_to_shared') return { Icon: GroupsIcon, label: 'Umbuchung (eigen → gemeinsam)' };
  if (kind === 'own_to_other_user') return { Icon: PersonIcon, label: 'Umbuchung (eigen → andere Person)' };
  return null;
}

function clipText(s: string, max = 64): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** Eine Zeile pro externer Position (Tooltip = voller Text). */
const ENRICHMENT_LINE_CLIP_MOBILE = 120;
const ENRICHMENT_LINE_CLIP_DESKTOP = 100;

function counterpartyMetaLines(t: Transaction): string[] {
  const out: string[] = [];
  if (t.counterparty_iban) out.push(`IBAN: ${clipText(t.counterparty_iban, 34)}`);
  if (t.counterparty_bic) out.push(`BIC: ${clipText(t.counterparty_bic, 20)}`);
  if (t.counterparty_partner_name) out.push(`Partner: ${clipText(t.counterparty_partner_name, 34)}`);
  // Falls weder IBAN noch BIC existieren, zeigen wir ggf. den strukturierten Namen.
  if (out.length === 0 && t.counterparty_name && t.counterparty_name !== t.counterparty) {
    out.push(`Name: ${clipText(t.counterparty_name, 34)}`);
  }
  return out;
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
  /** true: kein äußerer Rahmen — z. B. eingebettet in eine andere Tabelle (Umbuchungen). */
  embedded?: boolean;
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
  embedded = false,
}: Props) {
  const qc = useQueryClient();
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));
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
    const subs = flattenSubcategoryPickOptionsWithMeta(roots);
    if (subs.length === 0) return [clear];
    return [
      clear,
      ...subs.map((x) => ({
        id: x.id,
        label: x.label,
        effective_color_hex: x.effective_color_hex,
        icon_emoji: x.icon_emoji,
      })),
    ];
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
    void qc.invalidateQueries({ queryKey: ['contracts'] });
    void qc.invalidateQueries({ queryKey: ['transfers'] });
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
        fullScreen={isXs}
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
        fullScreen={isXs}
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
                    renderOption={(props, option) => {
                      const { key, ...liProps } = props;
                      if (option.id === null) {
                        return (
                          <li key={key ?? 'none'} {...liProps}>
                            <Typography variant="body2">{option.label}</Typography>
                          </li>
                        );
                      }
                      return (
                        <li key={key ?? option.id} {...liProps}>
                          <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', py: 0.25 }}>
                            <Box
                              sx={{
                                width: 10,
                                height: 10,
                                borderRadius: '50%',
                                bgcolor: option.effective_color_hex,
                                flexShrink: 0,
                                border: 1,
                                borderColor: 'divider',
                              }}
                            />
                            <CategorySymbolDisplay value={option.icon_emoji} fontSize="1.15rem" />
                            <Typography variant="body2">{option.label}</Typography>
                          </Stack>
                        </li>
                      );
                    }}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Kategorie"
                        autoFocus
                        InputProps={{
                          ...params.InputProps,
                          startAdornment: (
                            <Fragment>
                              {categoryPickValue != null && categoryPickValue.id != null ? (
                                <Stack
                                  direction="row"
                                  alignItems="center"
                                  spacing={0.75}
                                  sx={{ mr: 0.5, flexShrink: 0 }}
                                >
                                  <Box
                                    sx={{
                                      width: 10,
                                      height: 10,
                                      borderRadius: '50%',
                                      bgcolor: categoryPickValue.effective_color_hex,
                                      flexShrink: 0,
                                      border: 1,
                                      borderColor: 'divider',
                                    }}
                                  />
                                  <CategorySymbolDisplay value={categoryPickValue.icon_emoji} fontSize="1.1rem" />
                                </Stack>
                              ) : null}
                              {params.InputProps.startAdornment}
                            </Fragment>
                          ),
                        }}
                      />
                    )}
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
      {isXs ? (
        rows.length === 0 ? (
          <Paper
            variant="outlined"
            sx={{
              p: 2,
              ...(embedded ? { border: 'none', bgcolor: 'transparent', boxShadow: 'none' } : {}),
            }}
          >
            <Typography color="text.secondary">{emptyMessage}</Typography>
          </Paper>
        ) : (
          <Stack spacing={1.25} sx={embedded ? { width: '100%', minWidth: 0 } : undefined}>
            {rows.map((t) => (
              <Card
                key={t.id}
                variant="outlined"
                onClick={() => setTxDetail(t)}
                sx={{ cursor: 'pointer' }}
              >
                <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Stack direction="row" alignItems="baseline" justifyContent="space-between" spacing={1}>
                    <Stack direction="row" alignItems="center" spacing={0.75}>
                      {t.contract_id != null && t.contract_label ? (
                        <Tooltip title={`Vertrag: ${t.contract_label}`}>
                          <EventRepeatIcon fontSize="small" color="primary" />
                        </Tooltip>
                      ) : null}
                    <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                      {formatDate(t.booking_date)}
                    </Typography>
                    </Stack>
                    <Typography
                      sx={{
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 700,
                        color: amountSxColorFromTransaction(t),
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {(() => {
                        const ti = transferIcon(t.transfer_kind);
                        return (
                          <Stack direction="row" alignItems="center" spacing={0.75} justifyContent="flex-end">
                            {ti ? (
                              <Tooltip title={ti.label} enterDelay={400}>
                                <span>
                                  <ti.Icon fontSize="small" color="action" />
                                </span>
                              </Tooltip>
                            ) : null}
                            <span>{formatMoney(t.amount, t.currency)}</span>
                          </Stack>
                        );
                      })()}
                    </Typography>
                  </Stack>

                  <Stack
                    direction="row"
                    spacing={1}
                    alignItems="center"
                    flexWrap="wrap"
                    useFlexGap
                    sx={{ mt: 1 }}
                  >
                    <Chip
                      size="small"
                      label={accountNameById.get(t.bank_account_id) ?? `#${t.bank_account_id}`}
                      variant="outlined"
                    />
                    <Chip
                      size="small"
                      label={t.category_name?.trim() ? t.category_name : '—'}
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
                      variant="outlined"
                      sx={{
                        cursor: 'pointer',
                        maxWidth: '100%',
                        '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                        '&:hover': { borderColor: 'primary.main' },
                        ...(_hexLooksValid(t.category_color_hex) && t.category_name?.trim()
                          ? {
                              borderLeftWidth: 3,
                              borderLeftStyle: 'solid',
                              borderLeftColor: t.category_color_hex!.trim(),
                              pl: 0.5,
                            }
                          : {}),
                      }}
                    />
                  </Stack>

                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {clipText(t.description, 140)}
                  </Typography>
                  {(t.enrichment_preview_lines?.length ?? 0) > 0 ? (
                    <Stack spacing={0.25} sx={{ mt: 0.75 }}>
                      {(t.enrichment_preview_lines ?? []).map((line, i) => (
                        <Typography
                          key={i}
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block' }}
                          noWrap
                          title={line}
                        >
                          {clipText(line, ENRICHMENT_LINE_CLIP_MOBILE)}
                        </Typography>
                      ))}
                    </Stack>
                  ) : null}
                  <Stack spacing={0.25}>
                  <Typography variant="caption" color="text.secondary">
                    {t.counterparty ? clipText(t.counterparty, 80) : '—'}
                  </Typography>
                    {counterpartyMetaLines(t).length > 0 ? (
                      <Stack spacing={0.25}>
                        {counterpartyMetaLines(t).map((line, i) => (
                          <Typography key={i} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                            {line}
                          </Typography>
                        ))}
                      </Stack>
                    ) : null}
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        )
      ) : (
        <TableContainer
          component={Paper}
          elevation={0}
          sx={
            embedded
              ? { border: 'none', boxShadow: 'none', bgcolor: 'transparent', backgroundImage: 'none' }
              : { border: 1, borderColor: 'divider' }
          }
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={40} align="center">
                  <Tooltip title="Wiederkehrende Zahlung (bestätigter Vertrag)" enterDelay={400}>
                    <span />
                  </Tooltip>
                </TableCell>
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
                  <TableCell colSpan={7}>
                    <Typography color="text.secondary" sx={{ py: 2 }}>
                      {emptyMessage}
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((t) => (
                  <TableRow key={t.id} hover onClick={() => setTxDetail(t)} sx={{ cursor: 'pointer' }}>
                    <TableCell align="center" sx={{ py: 0.5 }}>
                      {t.contract_id != null && t.contract_label ? (
                        <Tooltip title={`Vertrag: ${t.contract_label}`} enterDelay={300}>
                          <span>
                            <EventRepeatIcon fontSize="small" color="primary" />
                          </span>
                        </Tooltip>
                      ) : (
                        <span />
                      )}
                    </TableCell>
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
                      {(() => {
                        const ti = transferIcon(t.transfer_kind);
                        return (
                          <Stack direction="row" alignItems="center" spacing={0.75} justifyContent="flex-end">
                            {ti ? (
                              <Tooltip title={ti.label} enterDelay={400}>
                                <span>
                                  <ti.Icon fontSize="small" color="action" />
                                </span>
                              </Tooltip>
                            ) : null}
                            <span>{formatMoney(t.amount, t.currency)}</span>
                          </Stack>
                        );
                      })()}
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
                          <Box component="span" sx={{ display: 'block', minWidth: 0 }}>
                            <TransactionCategoryCellInner t={t} />
                          </Box>
                        </Tooltip>
                      ) : (
                        <Box sx={{ minWidth: 0 }}>
                          <TransactionCategoryCellInner t={t} />
                        </Box>
                      )}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 360 }}>
                      <Typography variant="body2">{t.description}</Typography>
                      {(t.enrichment_preview_lines?.length ?? 0) > 0 ? (
                        <Stack spacing={0.25} sx={{ mt: 0.75 }}>
                          {(t.enrichment_preview_lines ?? []).map((line, i) => (
                            <Typography
                              key={i}
                              variant="caption"
                              color="text.secondary"
                              sx={{ display: 'block', maxWidth: '100%' }}
                              noWrap
                              title={line}
                            >
                              {clipText(line, ENRICHMENT_LINE_CLIP_DESKTOP)}
                            </Typography>
                          ))}
                        </Stack>
                      ) : null}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 360 }}>
                      <Stack spacing={0.25}>
                        <Typography variant="body2" noWrap>
                          {t.counterparty ?? '—'}
                        </Typography>
                        {counterpartyMetaLines(t).length > 0 ? (
                          <Stack spacing={0.25}>
                            {counterpartyMetaLines(t).map((line, i) => (
                              <Typography key={i} variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>
                                {line}
                              </Typography>
                            ))}
                          </Stack>
                        ) : null}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  );
}
