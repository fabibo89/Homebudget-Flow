import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { RuleOutlined as RuleOutlinedIcon } from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiErrorMessage,
  createCategoryRule,
  updateCategoryRule,
  reverseCategoryRule,
  fetchCategories,
  type CategoryRuleCondition,
  type CategoryRuleCreatedOut,
  type CategoryRuleOut,
  type CategoryRuleSuggestion,
  type CategoryRuleType,
  type Transaction,
} from '../api/client';
import { CategorySymbolDisplay } from './CategorySymbol';
import BookingFlowTag from './transactions/BookingFlowTag';
import {
  amountSxColorFromTransaction,
  categoryRuleApiType,
  categoryRuleConditionsToFormState,
  defaultRulePatternFromTx,
  describeCategoryRuleCondition,
  flattenSubcategoryPickOptionsWithMeta,
  formatMoney,
  type CategoryFlatOptionWithMeta,
  RuleMatchMode,
  RuleTargetField,
} from '../lib/transactionUi';

type CreateRuleBody = {
  conditions: CategoryRuleCondition[];
  category_id: number;
  applies_to_household: boolean;
  apply_to_uncategorized: boolean;
  also_assign_transaction_id?: number | null;
};

type UpdateRuleBody = {
  conditions: CategoryRuleCondition[];
  category_id: number;
  applies_to_household: boolean;
  apply_to_uncategorized: boolean;
};

function normalizeAmountInput(raw: string): string | null {
  const t = raw.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return t;
}

function buildConditionsForSubmit(args: {
  direction: 'all' | 'credit' | 'debit';
  textType: CategoryRuleType;
  pattern: string;
  amountMin: string;
  amountMax: string;
}): CategoryRuleCondition[] {
  const out: CategoryRuleCondition[] = [];
  if (args.direction !== 'all') {
    out.push({ type: 'direction', value: args.direction });
  }
  const p = args.pattern.trim();
  if (p) {
    const tt = args.textType;
    if (tt === 'description_contains') out.push({ type: 'description_contains', pattern: p });
    else if (tt === 'description_equals') out.push({ type: 'description_equals', pattern: p });
    else if (tt === 'counterparty_contains') out.push({ type: 'counterparty_contains', pattern: p });
    else if (tt === 'counterparty_equals') out.push({ type: 'counterparty_equals', pattern: p });
  }
  const minA = normalizeAmountInput(args.amountMin);
  const maxA = normalizeAmountInput(args.amountMax);
  if (minA != null || maxA != null) {
    out.push({
      type: 'amount_between',
      min_amount: minA,
      max_amount: maxA,
    });
  }
  return out;
}

function ruleFormHasSubmitPayload(pattern: string, amountMin: string, amountMax: string): boolean {
  if (pattern.trim().length > 0) return true;
  return normalizeAmountInput(amountMin) != null || normalizeAmountInput(amountMax) != null;
}

function ruleTypeToFieldMode(rt: CategoryRuleType): { field: RuleTargetField; mode: RuleMatchMode } {
  switch (rt) {
    case 'description_contains':
      return { field: 'description', mode: 'contains' };
    case 'description_equals':
      return { field: 'description', mode: 'equals' };
    case 'counterparty_contains':
      return { field: 'counterparty', mode: 'contains' };
    case 'counterparty_equals':
      return { field: 'counterparty', mode: 'equals' };
    default:
      return { field: 'description', mode: 'contains' };
  }
}

export type CreateCategoryRuleDialogProps = {
  open: boolean;
  onClose: () => void;
  householdId: number | null;
  /** Buchung aus der Übersicht: Regel inkl. Zuordnung dieser Zeile */
  transaction?: Transaction | null;
  /** Vorschlag aus Einstellungen → Kategorien: gleiches Formular, ohne Buchung */
  suggestionPreset?: CategoryRuleSuggestion | null;
  /** Bestehende Regel bearbeiten (Einstellungen → Zuordnungsregeln) */
  editingRule?: CategoryRuleOut | null;
  onCreated?: (data: CategoryRuleCreatedOut) => void;
  /** Nach „Regel anwenden“: Regel-Dialog bleibt offen (z. B. Overwrite-Dialog darüber) */
  onRuleApplied?: (data: CategoryRuleCreatedOut) => void;
};

export default function CreateCategoryRuleDialog({
  open,
  onClose,
  householdId,
  transaction,
  suggestionPreset,
  editingRule,
  onCreated,
  onRuleApplied,
}: CreateCategoryRuleDialogProps) {
  const qc = useQueryClient();
  const [pickCategoryId, setPickCategoryId] = useState<number | null>(null);
  const [ruleField, setRuleField] = useState<RuleTargetField>('description');
  const [ruleMode, setRuleMode] = useState<RuleMatchMode>('contains');
  const [rulePattern, setRulePattern] = useState('');
  const [ruleDirection, setRuleDirection] = useState<'all' | 'credit' | 'debit'>('all');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [applyRulesToUncategorized, setApplyRulesToUncategorized] = useState(true);
  const [appliesToHousehold, setAppliesToHousehold] = useState(true);

  const fromSuggestion = Boolean(suggestionPreset && !transaction && !editingRule);
  const isEditing = Boolean(editingRule);

  const categoriesQuery = useQuery({
    queryKey: ['categories', householdId],
    queryFn: () => fetchCategories(householdId!),
    enabled: open && householdId != null,
  });

  useEffect(() => {
    if (!open) return;
    if (editingRule) {
      const st = categoryRuleConditionsToFormState(editingRule.conditions ?? []);
      setRuleDirection(st.direction);
      setRuleField(st.field);
      setRuleMode(st.mode);
      setRulePattern(st.pattern);
      setAmountMin(st.amountMin);
      setAmountMax(st.amountMax);
      setPickCategoryId(editingRule.category_id);
      setApplyRulesToUncategorized(true);
      setAppliesToHousehold(editingRule.applies_to_household !== false);
      return;
    }
    if (transaction) {
      setRuleField('description');
      setRuleMode('contains');
      setRulePattern(defaultRulePatternFromTx(transaction, 'description'));
      const n = Number(transaction.amount);
      setRuleDirection(!Number.isNaN(n) && n > 0 ? 'credit' : n < 0 ? 'debit' : 'all');
      setAmountMin('');
      setAmountMax('');
      setPickCategoryId(null);
      setApplyRulesToUncategorized(true);
      setAppliesToHousehold(true);
    } else if (suggestionPreset) {
      const fm = ruleTypeToFieldMode(suggestionPreset.rule_type);
      setRuleField(fm.field);
      setRuleMode(fm.mode);
      setRulePattern(suggestionPreset.pattern);
      setRuleDirection('all');
      setAmountMin('');
      setAmountMax('');
      setPickCategoryId(null);
      setApplyRulesToUncategorized(true);
      setAppliesToHousehold(true);
    } else {
      setRuleField('description');
      setRuleMode('contains');
      setRulePattern('');
      setRuleDirection('debit');
      setAmountMin('');
      setAmountMax('');
      setPickCategoryId(null);
      setApplyRulesToUncategorized(true);
      setAppliesToHousehold(true);
    }
  }, [open, editingRule?.id, transaction?.id, suggestionPreset?.rule_type, suggestionPreset?.pattern]);

  const categoryRulePickOptions: CategoryFlatOptionWithMeta[] = useMemo(() => {
    const roots = categoriesQuery.data ?? [];
    return flattenSubcategoryPickOptionsWithMeta(roots);
  }, [categoriesQuery.data]);

  const categoryRulePickValue: CategoryFlatOptionWithMeta | null = useMemo(() => {
    if (pickCategoryId == null) return null;
    return categoryRulePickOptions.find((o) => o.id === pickCategoryId) ?? null;
  }, [categoryRulePickOptions, pickCategoryId]);

  const invalidateAfterRuleChange = (hid: number) => {
    void qc.invalidateQueries({ queryKey: ['category-rules', hid] });
    void qc.invalidateQueries({ queryKey: ['category-rule-suggestions', hid] });
    void qc.invalidateQueries({ queryKey: ['transactions'] });
    void qc.invalidateQueries({ queryKey: ['analyses-transactions'] });
  };

  const createRuleMut = useMutation({
    mutationFn: (args: { householdId: number; body: CreateRuleBody }) =>
      createCategoryRule(args.householdId, args.body),
    onSuccess: (data, variables) => {
      invalidateAfterRuleChange(variables.householdId);
      onCreated?.(data);
      onClose();
    },
  });

  const updateRuleMut = useMutation({
    mutationFn: (args: { householdId: number; ruleId: number; body: UpdateRuleBody }) =>
      updateCategoryRule(args.householdId, args.ruleId, args.body),
    onSuccess: (data, variables) => {
      invalidateAfterRuleChange(variables.householdId);
      onCreated?.(data);
      onClose();
    },
  });

  const applyRuleMut = useMutation({
    mutationFn: (args: { householdId: number; ruleId: number; body: UpdateRuleBody }) =>
      updateCategoryRule(args.householdId, args.ruleId, args.body),
    onSuccess: (data, variables) => {
      invalidateAfterRuleChange(variables.householdId);
      onRuleApplied?.(data);
    },
  });

  const reverseRuleMut = useMutation({
    mutationFn: (args: { householdId: number; ruleId: number }) =>
      reverseCategoryRule(args.householdId, args.ruleId),
    onSuccess: (data, variables) => {
      invalidateAfterRuleChange(variables.householdId);
      onRuleApplied?.(data);
    },
  });

  const busy =
    createRuleMut.isPending || updateRuleMut.isPending || applyRuleMut.isPending || reverseRuleMut.isPending;

  const previewConditions = useMemo(() => {
    if (!ruleFormHasSubmitPayload(rulePattern, amountMin, amountMax)) return [];
    return buildConditionsForSubmit({
      direction: ruleDirection,
      textType: categoryRuleApiType(ruleField, ruleMode),
      pattern: rulePattern,
      amountMin,
      amountMax,
    });
  }, [ruleDirection, ruleField, ruleMode, rulePattern, amountMin, amountMax]);

  function handleClose() {
    if (busy) return;
    createRuleMut.reset();
    updateRuleMut.reset();
    applyRuleMut.reset();
    reverseRuleMut.reset();
    onClose();
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth scroll="paper">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <RuleOutlinedIcon color="primary" fontSize="medium" aria-hidden />
        {isEditing ? 'Zuordnungsregel bearbeiten' : 'Kategorie-Regel anlegen'}
      </DialogTitle>
      <DialogContent>
        {householdId == null ? (
          <Alert severity="warning" sx={{ mt: 1 }}>
            Kein Haushalt — Kategorien sind pro Haushalt verwaltet.
          </Alert>
        ) : categoriesQuery.isError ? (
          <Alert severity="error" sx={{ mt: 1 }}>
            {apiErrorMessage(categoriesQuery.error)}
          </Alert>
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            {categoriesQuery.isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size={32} />
              </Box>
            ) : (
              <>
                {isEditing ? (
                  <Stack spacing={0.75}>
                    <Typography variant="body2" color="text.secondary">
                      Bedingungen und Zielkategorie anpassen. Gespeichert wird die Regel mit unveränderter Priorität
                      (Reihenfolge nach Anlagedatum).
                    </Typography>
                    {editingRule?.created_by_display?.trim() ? (
                      <Typography variant="caption" color="text.secondary">
                        Angelegt von {editingRule.created_by_display.trim()}
                      </Typography>
                    ) : null}
                  </Stack>
                ) : fromSuggestion ? (
                  <Typography variant="body2" color="text.secondary">
                    Vorschlag aus den Kategorie-Einstellungen — gleiche Regel-Optionen wie in der Buchungsübersicht
                    (Feld, Vergleich, Muster, Kategorie).
                  </Typography>
                ) : transaction ? (
                  <>
                    <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'action.hover' }}>
                      <Stack spacing={1.5}>
                        <Box>
                          <Typography variant="caption" color="text.secondary" component="div">
                            Verwendungszweck
                          </Typography>
                          <Typography variant="body2" sx={{ mt: 0.25, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {transaction.description || '—'}
                          </Typography>
                        </Box>
                        <Box>
                          <Typography variant="caption" color="text.secondary" component="div">
                            Gegenpartei
                          </Typography>
                          <Typography variant="body2" sx={{ mt: 0.25 }}>
                            {transaction.counterparty ?? '—'}
                          </Typography>
                        </Box>
                        <Box>
                          <Typography variant="caption" color="text.secondary" component="div">
                            Wert
                          </Typography>
                          <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.25 }} flexWrap="wrap" useFlexGap>
                            <BookingFlowTag amount={transaction.amount} booking_flow={transaction.booking_flow} />
                            <Typography
                              variant="body2"
                              sx={{
                                fontVariantNumeric: 'tabular-nums',
                                fontWeight: 600,
                                color: amountSxColorFromTransaction(transaction),
                              }}
                            >
                              {formatMoney(transaction.amount, transaction.currency)}
                            </Typography>
                          </Stack>
                        </Box>
                      </Stack>
                    </Paper>
                    <Typography variant="body2" color="text.secondary">
                      Diese Buchung hat noch keine Kategorie. Legen Sie eine Zuordnungsregel an — passende künftige
                      und bestehende unkategorisierte Buchungen können automatisch erkannt werden.
                    </Typography>
                  </>
                ) : null}

                <Box>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.75 }}>
                    Geltungsbereich der Regel
                  </Typography>
                  <Tooltip
                    title={
                      appliesToHousehold
                        ? 'Die Regel kann auf Buchungen aller Konten in diesem Haushalt zutreffen (wie bisher).'
                        : 'Die Regel gilt nur für Konten aus Gruppen, in denen Sie Mitglied sind — nicht für rein geteilte Konten anderer Personen.'
                    }
                    enterDelay={400}
                  >
                    <ToggleButtonGroup
                      exclusive
                      fullWidth
                      size="small"
                      value={appliesToHousehold ? 'household' : 'mine'}
                      disabled={busy}
                      onChange={(_, v) => {
                        if (v === 'household') setAppliesToHousehold(true);
                        else if (v === 'mine') setAppliesToHousehold(false);
                      }}
                      aria-label="Geltungsbereich der Zuordnungsregel"
                    >
                      <ToggleButton value="mine">Regel nur für meine Konten</ToggleButton>
                      <ToggleButton value="household">Regel für meinen Haushalt</ToggleButton>
                    </ToggleButtonGroup>
                  </Tooltip>
                </Box>
                <FormControl fullWidth size="small">
                  <InputLabel id="cr-rule-direction-label">Buchungsrichtung</InputLabel>
                  <Select
                    labelId="cr-rule-direction-label"
                    label="Buchungsrichtung"
                    value={ruleDirection}
                    onChange={(e) => setRuleDirection(e.target.value as 'all' | 'credit' | 'debit')}
                  >
                    <MenuItem value="all">Alle (Einnahmen und Ausgaben)</MenuItem>
                    <MenuItem value="credit">Nur Gutschriften (Betrag &gt; 0)</MenuItem>
                    <MenuItem value="debit">Nur Lastschriften (Betrag &lt; 0)</MenuItem>
                  </Select>
                </FormControl>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <FormControl fullWidth size="small">
                    <InputLabel id="cr-rule-field-label">Feld</InputLabel>
                    <Select
                      labelId="cr-rule-field-label"
                      label="Feld"
                      value={ruleField}
                      onChange={(e) => {
                        const v = e.target.value as RuleTargetField;
                        setRuleField(v);
                        if (transaction) {
                          setRulePattern(defaultRulePatternFromTx(transaction, v));
                        } else if (suggestionPreset) {
                          const { field: origField } = ruleTypeToFieldMode(suggestionPreset.rule_type);
                          if (v === origField) setRulePattern(suggestionPreset.pattern);
                          else setRulePattern('');
                        }
                      }}
                    >
                      <MenuItem value="description">Verwendungszweck</MenuItem>
                      <MenuItem value="counterparty">Gegenpartei</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl fullWidth size="small">
                    <InputLabel id="cr-rule-mode-label">Vergleich</InputLabel>
                    <Select
                      labelId="cr-rule-mode-label"
                      label="Vergleich"
                      value={ruleMode}
                      onChange={(e) => setRuleMode(e.target.value as RuleMatchMode)}
                    >
                      <MenuItem value="contains">enthält</MenuItem>
                      <MenuItem value="equals">ist (exakt)</MenuItem>
                    </Select>
                  </FormControl>
                </Stack>
                <TextField
                  label="Text"
                  value={rulePattern}
                  onChange={(e) => setRulePattern(e.target.value.slice(0, 512))}
                  fullWidth
                  helperText={
                    ruleMode === 'contains'
                      ? 'Groß-/Kleinschreibung wird ignoriert; es wird ein Teilstring gesucht.'
                      : 'Groß-/Kleinschreibung wird ignoriert; der gesamte Text muss exakt übereinstimmen (nach Trimmen).'
                  }
                />
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <TextField
                    label="Betrag min (optional)"
                    value={amountMin}
                    onChange={(e) => setAmountMin(e.target.value)}
                    size="small"
                    fullWidth
                    placeholder="z. B. 3000"
                    helperText="Untere Grenze inklusive; leer = keine Untergrenze"
                  />
                  <TextField
                    label="Betrag max (optional)"
                    value={amountMax}
                    onChange={(e) => setAmountMax(e.target.value)}
                    size="small"
                    fullWidth
                    placeholder="z. B. 5000"
                    helperText="Obere Grenze inklusive; leer = keine Obergrenze"
                  />
                </Stack>
                <Typography variant="caption" color="text.secondary" component="div">
                  Vorschau (alle Bedingungen müssen zutreffen):
                  {previewConditions.length ? (
                    <Box component="ul" sx={{ m: 0.5, pl: 2 }}>
                      {previewConditions.map((c, i) => (
                        <li key={i}>
                          <Typography variant="caption" component="span">
                            {describeCategoryRuleCondition(c)}
                          </Typography>
                        </li>
                      ))}
                    </Box>
                  ) : (
                    <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
                      Text-Muster und/oder Betragsgrenzen angeben …
                    </Typography>
                  )}
                </Typography>
                <FormControlLabel
                  control={
                    <Checkbox
                      checked={applyRulesToUncategorized}
                      onChange={(e) => setApplyRulesToUncategorized(e.target.checked)}
                    />
                  }
                  label="Alle noch unkategorisierten Buchungen des Haushalts jetzt anhand der Regeln zuordnen"
                />
                {categoryRulePickOptions.length === 0 ? (
                  <Alert severity="info">
                    Es gibt noch keine Unterkategorien — Buchungen und Regeln werden nur Unterkategorien zugeordnet.
                    Legen Sie unter{' '}
                    <Link component={RouterLink} to="/settings/categories">
                      Einstellungen → Kategorien
                    </Link>{' '}
                    eine Hauptkategorie an (dort wird automatisch „Sonstiges“ angelegt) oder eine eigene Unterkategorie.
                  </Alert>
                ) : (
                  <Autocomplete<CategoryFlatOptionWithMeta, false, false, false>
                    options={categoryRulePickOptions}
                    getOptionLabel={(o) => o.label}
                    isOptionEqualToValue={(a, b) => a.id === b.id}
                    value={categoryRulePickValue}
                    onChange={(_, v) => setPickCategoryId(v?.id ?? null)}
                    slotProps={{
                      popper: {
                        placement: 'bottom-start',
                        sx: { zIndex: (theme) => theme.zIndex.modal + 2 },
                      },
                    }}
                    renderOption={(props, option) => {
                      const { key, ...liProps } = props;
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
                        label="Kategorie für diese Regel"
                        InputProps={{
                          ...params.InputProps,
                          startAdornment: (
                            <Fragment>
                              {categoryRulePickValue ? (
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
                                      bgcolor: categoryRulePickValue.effective_color_hex,
                                      flexShrink: 0,
                                      border: 1,
                                      borderColor: 'divider',
                                    }}
                                  />
                                  <CategorySymbolDisplay value={categoryRulePickValue.icon_emoji} fontSize="1.1rem" />
                                </Stack>
                              ) : null}
                              {params.InputProps.startAdornment}
                            </Fragment>
                          ),
                        }}
                      />
                    )}
                  />
                )}
                {createRuleMut.isError ? (
                  <Alert severity="error">{apiErrorMessage(createRuleMut.error)}</Alert>
                ) : null}
                {updateRuleMut.isError ? (
                  <Alert severity="error">{apiErrorMessage(updateRuleMut.error)}</Alert>
                ) : null}
                {applyRuleMut.isError ? (
                  <Alert severity="error">{apiErrorMessage(applyRuleMut.error)}</Alert>
                ) : null}
                {reverseRuleMut.isError ? (
                  <Alert severity="error">{apiErrorMessage(reverseRuleMut.error)}</Alert>
                ) : null}
              </>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={handleClose} disabled={busy}>
          Abbrechen
        </Button>
        {isEditing ? (
          <Button
            variant="outlined"
            disabled={
              busy ||
              householdId == null ||
              categoriesQuery.isLoading ||
              categoriesQuery.isError ||
              !ruleFormHasSubmitPayload(rulePattern, amountMin, amountMax) ||
              pickCategoryId == null ||
              categoryRulePickOptions.length === 0 ||
              (amountMin.trim() !== '' && normalizeAmountInput(amountMin) === null) ||
              (amountMax.trim() !== '' && normalizeAmountInput(amountMax) === null)
            }
            onClick={() => {
              if (householdId == null || pickCategoryId == null || !editingRule) return;
              const conditions = buildConditionsForSubmit({
                direction: ruleDirection,
                textType: categoryRuleApiType(ruleField, ruleMode),
                pattern: rulePattern,
                amountMin,
                amountMax,
              });
              applyRuleMut.mutate({
                householdId,
                ruleId: editingRule.id,
                body: {
                  conditions,
                  category_id: pickCategoryId,
                  applies_to_household: appliesToHousehold,
                  apply_to_uncategorized: true,
                },
              });
            }}
          >
            {applyRuleMut.isPending ? 'Wird angewendet…' : 'Regel anwenden'}
          </Button>
        ) : null}
        {isEditing ? (
          <Button
            variant="outlined"
            color="warning"
            disabled={busy || householdId == null || !editingRule}
            onClick={() => {
              if (householdId == null || !editingRule) return;
              if (
                !window.confirm(
                  'Alle Buchungen, die aktuell in diese Regel fallen, werden auf „keine Kategorie“ zurückgesetzt. Die Regel bleibt bestehen. Fortfahren?',
                )
              )
                return;
              reverseRuleMut.mutate({ householdId, ruleId: editingRule.id });
            }}
          >
            {reverseRuleMut.isPending ? 'Wird zurückgesetzt…' : 'Buchungen zurücksetzen (Kategorie entfernen)'}
          </Button>
        ) : null}
        <Button
          variant="contained"
          disabled={
            busy ||
            householdId == null ||
            categoriesQuery.isLoading ||
            categoriesQuery.isError ||
            !ruleFormHasSubmitPayload(rulePattern, amountMin, amountMax) ||
            pickCategoryId == null ||
            categoryRulePickOptions.length === 0 ||
            (amountMin.trim() !== '' && normalizeAmountInput(amountMin) === null) ||
            (amountMax.trim() !== '' && normalizeAmountInput(amountMax) === null)
          }
          onClick={() => {
            if (householdId == null || pickCategoryId == null) return;
            const conditions = buildConditionsForSubmit({
              direction: ruleDirection,
              textType: categoryRuleApiType(ruleField, ruleMode),
              pattern: rulePattern,
              amountMin,
              amountMax,
            });
            if (editingRule) {
              updateRuleMut.mutate({
                householdId,
                ruleId: editingRule.id,
                body: {
                  conditions,
                  category_id: pickCategoryId,
                  applies_to_household: appliesToHousehold,
                  apply_to_uncategorized: applyRulesToUncategorized,
                },
              });
              return;
            }
            createRuleMut.mutate({
              householdId,
              body: {
                conditions,
                category_id: pickCategoryId,
                applies_to_household: appliesToHousehold,
                apply_to_uncategorized: applyRulesToUncategorized,
                also_assign_transaction_id: transaction?.id,
              },
            });
          }}
        >
          {createRuleMut.isPending || updateRuleMut.isPending
            ? 'Speichern…'
            : isEditing
              ? 'Änderungen speichern'
              : 'Regel speichern'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
