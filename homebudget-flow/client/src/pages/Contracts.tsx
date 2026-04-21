import {
  Alert,
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import { DeleteOutline as DeleteOutlineIcon, EditOutlined as EditOutlinedIcon, ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { describeCategoryRuleCondition, formatDateTime } from '../lib/transactionUi';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';

import {
  apiErrorMessage,
  applyContract,
  createContract,
  createContractRule,
  deleteContract,
  deleteContractRule,
  fetchAccounts,
  fetchCategoryRules,
  fetchContracts,
  fetchContractSuggestions,
  fetchIgnoredContractSuggestions,
  fetchHouseholds,
  fetchTransactions,
  ignoreContractSuggestion,
  resetContractAssignments,
  updateContract,
  unignoreContractSuggestion,
  type BankAccount,
  type CategoryRuleCondition,
  type CategoryRuleOut,
  type ContractOut,
  type ContractSuggestionIgnoreOut,
  type ContractSuggestionOut,
} from '../api/client';

function usableCategoryRules(rules: CategoryRuleOut[]): CategoryRuleOut[] {
  return rules.filter((r) => !r.category_missing && r.category_id != null);
}

function rulesForBankAccount(
  bankAccountId: number,
  accounts: BankAccount[],
  byHh: Record<number, CategoryRuleOut[]>,
): CategoryRuleOut[] {
  const acc = accounts.find((a) => a.id === bankAccountId);
  if (!acc) return [];
  return usableCategoryRules(byHh[acc.household_id] ?? []);
}

export default function Contracts() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const qc = useQueryClient();

  const householdsQ = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });
  const householdNameById = useMemo(() => {
    const m: Record<number, string> = {};
    for (const h of householdsQ.data ?? []) m[h.id] = h.name;
    return m;
  }, [householdsQ.data]);
  const multihh = (householdsQ.data?.length ?? 0) > 1;

  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: () => fetchAccounts() });
  const accounts: BankAccount[] = accountsQ.data ?? [];

  const accountsSorted = useMemo(() => {
    return [...accounts].sort((a, b) => {
      if (multihh) {
        const ha = householdNameById[a.household_id] ?? '';
        const hb = householdNameById[b.household_id] ?? '';
        const c = ha.localeCompare(hb, 'de', { sensitivity: 'base' });
        if (c !== 0) return c;
      }
      return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
    });
  }, [accounts, multihh, householdNameById]);

  const householdIds = useMemo(
    () => [...new Set(accountsSorted.map((a) => a.household_id))].sort((a, b) => a - b),
    [accountsSorted],
  );

  const categoryRulesQueries = useQueries({
    queries: householdIds.map((hid) => ({
      queryKey: ['category-rules', hid],
      queryFn: () => fetchCategoryRules(hid),
      enabled: householdIds.length > 0,
    })),
  });

  const categoryRulesByHousehold = useMemo(() => {
    const m: Record<number, CategoryRuleOut[]> = {};
    householdIds.forEach((hid, i) => {
      m[hid] = categoryRulesQueries[i]?.data?.rules ?? [];
    });
    return m;
  }, [householdIds, categoryRulesQueries]);

  const [accountFilter, setAccountFilter] = useState<number | 'all' | null>(null);
  useEffect(() => {
    if (accountsSorted.length === 0) {
      setAccountFilter(null);
      return;
    }
    setAccountFilter((prev) => {
      if (prev === 'all') return 'all';
      if (typeof prev === 'number' && accountsSorted.some((a) => a.id === prev)) return prev;
      return 'all';
    });
  }, [accountsSorted]);

  const contractsQ = useQuery({
    queryKey: ['contracts', accountFilter],
    queryFn: () => fetchContracts(accountFilter!),
    enabled: accountFilter != null,
  });

  const selectedBankAccountId = typeof accountFilter === 'number' ? accountFilter : null;
  const suggestionsQ = useQuery({
    queryKey: ['contractSuggestions', selectedBankAccountId],
    queryFn: () => fetchContractSuggestions(selectedBankAccountId!),
    enabled: selectedBankAccountId != null,
  });

  const ignoredSuggestionsQ = useQuery({
    queryKey: ['ignoredContractSuggestions', selectedBankAccountId],
    queryFn: () => fetchIgnoredContractSuggestions(selectedBankAccountId!),
    enabled: selectedBankAccountId != null,
  });

  const ignoreSuggestionMut = useMutation({
    mutationFn: async (args: { bankAccountId: number; fingerprint: string }) => {
      await ignoreContractSuggestion(args.bankAccountId, args.fingerprint);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contractSuggestions'] });
      await qc.invalidateQueries({ queryKey: ['ignoredContractSuggestions'] });
    },
  });

  const unignoreSuggestionMut = useMutation({
    mutationFn: async (args: { bankAccountId: number; fingerprint: string }) => {
      await unignoreContractSuggestion(args.bankAccountId, args.fingerprint);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contractSuggestions'] });
      await qc.invalidateQueries({ queryKey: ['ignoredContractSuggestions'] });
    },
  });
  const [suggestionTargetByFp, setSuggestionTargetByFp] = useState<Record<string, number | ''>>({});
  const [suggestionCategoryRuleByFp, setSuggestionCategoryRuleByFp] = useState<Record<string, number | ''>>({});
  const [suggestionErr, setSuggestionErr] = useState<string | null>(null);

  const suggestions: ContractSuggestionOut[] = suggestionsQ.data ?? [];
  const ignored: ContractSuggestionIgnoreOut[] = ignoredSuggestionsQ.data ?? [];
  useEffect(() => {
    setSuggestionCategoryRuleByFp((prev) => {
      const next = { ...prev };
      for (const s of suggestions) {
        const cur = next[s.fingerprint];
        if (cur !== undefined && cur !== '') continue;
        if (s.similar_category_rules?.length === 1) {
          next[s.fingerprint] = s.similar_category_rules[0].id;
        }
      }
      return next;
    });
  }, [suggestions]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createLabel, setCreateLabel] = useState('');
  const [createAccountId, setCreateAccountId] = useState<number | ''>('');
  const [createFirstCategoryRuleId, setCreateFirstCategoryRuleId] = useState<number | ''>('');
  const [createErr, setCreateErr] = useState<string | null>(null);

  useEffect(() => {
    if (!createOpen) return;
    setCreateErr(null);
    setCreateFirstCategoryRuleId('');
  }, [createOpen]);

  const createContractMut = useMutation({
    mutationFn: async () => {
      setCreateErr(null);
      const bankAccountId =
        typeof accountFilter === 'number' ? accountFilter : typeof createAccountId === 'number' ? createAccountId : null;
      if (!bankAccountId) throw new Error('Bitte ein Konto auswählen.');
      const label = createLabel.trim();
      if (!label) throw new Error('Bitte einen Namen eingeben.');
      const c = await createContract({ bank_account_id: bankAccountId, label });
      if (createFirstCategoryRuleId !== '' && typeof createFirstCategoryRuleId === 'number') {
        await createContractRule(c.id, { category_rule_id: createFirstCategoryRuleId });
      }
      return c;
    },
    onSuccess: async () => {
      setCreateOpen(false);
      setCreateLabel('');
      setCreateAccountId('');
      setCreateFirstCategoryRuleId('');
      await qc.invalidateQueries({ queryKey: ['contracts'] });
    },
    onError: (e) => setCreateErr(apiErrorMessage(e)),
  });

  const applyMut = useMutation({
    mutationFn: async (contractId: number) => await applyContract(contractId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });

  const resetAssignmentsMut = useMutation({
    mutationFn: async (bankAccountId: number) => await resetContractAssignments(bankAccountId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
      await qc.invalidateQueries({ queryKey: ['transactions'] });
      await qc.invalidateQueries({ queryKey: ['contractSuggestions'] });
    },
  });

  const deleteContractMut = useMutation({
    mutationFn: async (contractId: number) => {
      await deleteContract(contractId);
      return contractId;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
      await qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const updateContractMut = useMutation({
    mutationFn: async (args: { contractId: number; label: string }) => {
      const label = args.label.trim();
      if (!label) throw new Error('Bitte einen Namen eingeben.');
      return await updateContract(args.contractId, { label });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });

  const createRuleMut = useMutation({
    mutationFn: async (args: { contractId: number; categoryRuleId: number }) => {
      return await createContractRule(args.contractId, { category_rule_id: args.categoryRuleId });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });

  const deleteRuleMut = useMutation({
    mutationFn: async (ruleId: number) => {
      await deleteContractRule(ruleId);
      return ruleId;
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['contracts'] });
    },
  });

  const [newRuleOpenByContractId, setNewRuleOpenByContractId] = useState<Record<number, boolean>>({});
  const [newRuleCategoryRuleIdByContractId, setNewRuleCategoryRuleIdByContractId] = useState<
    Record<number, number | ''>
  >({});
  const [newRuleErrByContractId, setNewRuleErrByContractId] = useState<Record<number, string | null>>({});

  const [tab, setTab] = useState<'confirmed' | 'suggested' | 'ignored'>('confirmed');
  const [expandedConfirmedId, setExpandedConfirmedId] = useState<number | null>(null);
  const [expandedSuggestionFp, setExpandedSuggestionFp] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameContractId, setRenameContractId] = useState<number | null>(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [renameErr, setRenameErr] = useState<string | null>(null);

  const confirmedTxQ = useQuery({
    queryKey: ['contractTransactions', expandedConfirmedId],
    queryFn: async () => {
      const id = expandedConfirmedId;
      if (!id) return [];
      const c = (contractsQ.data ?? []).find((x) => x.id === id);
      if (!c) return [];
      return await fetchTransactions({
        bank_account_id: c.bank_account_id,
        contract_id: c.id,
        limit: 50,
        offset: 0,
      });
    },
    enabled: expandedConfirmedId != null && expandedConfirmedId > 0,
  });

  const suggestionSeedTxQ = useQuery({
    queryKey: ['suggestionSeedTransactions', selectedBankAccountId, expandedSuggestionFp],
    queryFn: async () => {
      const fp = expandedSuggestionFp;
      const bankAccountId = selectedBankAccountId;
      if (!fp || !bankAccountId) return [];
      const s = (suggestionsQ.data ?? []).find((x) => x.fingerprint === fp);
      if (!s) return [];
      const ids = (s.transactions_preview ?? []).map((t) => t.id).filter((x) => typeof x === 'number');
      if (ids.length === 0) return [];
      return await fetchTransactions({
        ids,
        bank_account_id: bankAccountId,
        limit: 2000,
        offset: 0,
      });
    },
    enabled: selectedBankAccountId != null && expandedSuggestionFp != null,
  });

  if (householdsQ.isLoading || accountsQ.isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const rows: ContractOut[] = contractsQ.data ?? [];

  const createDialogBankId =
    typeof accountFilter === 'number' ? accountFilter : typeof createAccountId === 'number' ? createAccountId : null;
  const createDialogRules =
    createDialogBankId != null ? rulesForBankAccount(createDialogBankId, accountsSorted, categoryRulesByHousehold) : [];

  return (
    <Stack spacing={2} sx={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
      <Stack spacing={0.75}>
        <Typography variant={isMobile ? 'h6' : 'h5'} fontWeight={700} component="h1">
          Verträge
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.45 }}>
          Jeder Vertrag verknüpft eine oder mehrere <strong>Kategorie-Zuordnungsregeln</strong> (gleiche Logik wie unter
          Kategorien). Eine Buchung wird dem Vertrag zugeordnet, wenn mindestens eine verknüpfte Regel passt (OR). Die
          Regeln selbst legst und bearbeitest du unter Einstellungen → Kategorien.
        </Typography>
      </Stack>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        flexWrap="wrap"
      >
        <FormControl fullWidth sx={{ minWidth: { sm: 220 }, maxWidth: { sm: 480 } }}>
          <InputLabel id="contracts-acc">Konto</InputLabel>
          <Select
            labelId="contracts-acc"
            label="Konto"
            value={accountFilter == null ? '' : accountFilter === 'all' ? 'all' : accountFilter}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'all') setAccountFilter('all');
              else setAccountFilter(Number(v));
            }}
            disabled={accountsSorted.length === 0}
          >
            <MenuItem value="all">Alle Konten</MenuItem>
            {accountsSorted.map((a) => (
              <MenuItem key={a.id} value={a.id}>
                {multihh && householdNameById[a.household_id] ? `${householdNameById[a.household_id]} · ${a.name}` : a.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        <Button
          variant="contained"
          onClick={() => {
            setCreateErr(null);
            setCreateOpen(true);
          }}
          disabled={accountsSorted.length === 0 || accountFilter == null}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Vertrag anlegen
        </Button>

        <Button
          variant="outlined"
          color="warning"
          disabled={selectedBankAccountId == null || resetAssignmentsMut.isPending}
          onClick={() => {
            if (!selectedBankAccountId) return;
            if (
              !window.confirm(
                'Alle Vertrags-Zuordnungen (contract_id) für dieses Konto wirklich löschen?\n\nDanach erscheinen ggf. wieder Vorschläge und du musst bei Bedarf neu „Apply“ ausführen.',
              )
            )
              return;
            resetAssignmentsMut.mutate(selectedBankAccountId);
          }}
          sx={{ whiteSpace: 'nowrap' }}
        >
          Contract-IDs löschen
        </Button>
      </Stack>

      {accountsQ.isSuccess && accountsSorted.length === 0 ? (
        <Alert severity="info">Kein Bankkonto vorhanden — Verträge sind erst nach einem verbundenen Konto sichtbar.</Alert>
      ) : null}

      {contractsQ.isError ? <Alert severity="error">{apiErrorMessage(contractsQ.error)}</Alert> : null}

      <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          allowScrollButtonsMobile
          sx={{ borderBottom: 1, borderColor: 'divider', mb: 1 }}
        >
          <Tab value="confirmed" label={`Bestätigt (${rows.length})`} />
          <Tab value="suggested" label={`Vorgeschlagen (${selectedBankAccountId != null ? suggestions.length : 0})`} />
          <Tab value="ignored" label={`Ignoriert (${selectedBankAccountId != null ? ignored.length : 0})`} />
        </Tabs>

        {tab === 'suggested' ? (
          <>
            {selectedBankAccountId == null ? (
              <Alert severity="info">Für Vorschläge bitte ein konkretes Konto auswählen (nicht „Alle Konten“).</Alert>
            ) : suggestionsQ.isError ? (
              <Alert severity="error">{apiErrorMessage(suggestionsQ.error)}</Alert>
            ) : null}

            {selectedBankAccountId != null && (suggestionsQ.isLoading || suggestionsQ.isFetching) ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
                <CircularProgress size={24} />
              </Box>
            ) : null}

            {selectedBankAccountId != null && suggestions.length > 0 ? (
              <Stack spacing={1}>
                <Typography fontWeight={700}>Vorschläge</Typography>
                <Typography variant="body2" color="text.secondary">
                  Wiederkehrende unkontrakt. Ausgaben. Für einen Vertrag wählst du eine <strong>Kategorie-Regel</strong> aus dem
                  Haushalt. Bereits ähnliche Regeln werden oben genannt.
                </Typography>
                {suggestionErr ? <Alert severity="error">{suggestionErr}</Alert> : null}
                <Stack spacing={1}>
                  {suggestions.map((s) => {
                    const avail =
                      selectedBankAccountId != null
                        ? rulesForBankAccount(selectedBankAccountId, accountsSorted, categoryRulesByHousehold)
                        : [];
                    return (
                      <Paper key={s.fingerprint} variant="outlined" sx={{ p: 1.25 }}>
                        <Stack
                          direction={{ xs: 'column', sm: 'row' }}
                          spacing={1}
                          alignItems={{ sm: 'baseline' }}
                          justifyContent="space-between"
                        >
                          <Typography fontWeight={700} sx={{ wordBreak: 'break-word' }}>
                            {s.label}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            Rhythmus: {s.recurrence_label || '—'}
                            {s.recurrence_median_days != null ? ` · Median ${s.recurrence_median_days}d` : ''}
                          </Typography>
                        </Stack>
                        {s.similar_category_rules?.length ? (
                          <Alert severity="info" sx={{ mt: 1 }}>
                            Ähnliche Kategorie-Regel(n):{' '}
                            {s.similar_category_rules
                              .map((x) => x.display_name + (x.category_name ? ` (${x.category_name})` : ''))
                              .join(' · ')}
                          </Alert>
                        ) : (
                          <Alert severity="warning" sx={{ mt: 1 }}>
                            Keine sehr ähnliche Kategorie-Regel gefunden — lege ggf. zuerst unter Kategorien eine Regel an.
                          </Alert>
                        )}
                        <Box sx={{ mt: 1 }}>
                          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                            Heuristik (nur Orientierung — es gilt die gewählte Kategorie-Regel):
                          </Typography>
                          <Box component="ul" sx={{ m: 0, pl: 2 }}>
                            {(s.conditions as CategoryRuleCondition[]).map((cond, i) => (
                              <li key={i}>
                                <Typography variant="body2" component="span">
                                  {describeCategoryRuleCondition(cond)}
                                </Typography>
                              </li>
                            ))}
                          </Box>
                        </Box>
                        <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                          <InputLabel id={`sugg-cr-${s.fingerprint}`}>Kategorie-Regel</InputLabel>
                          <Select
                            labelId={`sugg-cr-${s.fingerprint}`}
                            label="Kategorie-Regel"
                            value={suggestionCategoryRuleByFp[s.fingerprint] ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setSuggestionCategoryRuleByFp((prev) => ({
                                ...prev,
                                [s.fingerprint]: v === '' ? '' : Number(v),
                              }));
                            }}
                          >
                            {avail.map((r) => (
                              <MenuItem key={r.id} value={r.id}>
                                {r.display_name}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
                          <Button
                            size="small"
                            variant="contained"
                            onClick={async () => {
                              try {
                                setSuggestionErr(null);
                                if (!selectedBankAccountId) return;
                                const crId = suggestionCategoryRuleByFp[s.fingerprint];
                                if (!crId || typeof crId !== 'number') throw new Error('Bitte eine Kategorie-Regel wählen.');
                                const c = await createContract({ bank_account_id: selectedBankAccountId, label: s.label });
                                await createContractRule(c.id, { category_rule_id: crId });
                                await applyContract(c.id);
                                await ignoreContractSuggestion(selectedBankAccountId, s.fingerprint);
                                await qc.invalidateQueries({ queryKey: ['contracts'] });
                                await qc.invalidateQueries({ queryKey: ['contractSuggestions'] });
                                await qc.invalidateQueries({ queryKey: ['ignoredContractSuggestions'] });
                              } catch (e) {
                                setSuggestionErr(apiErrorMessage(e));
                              }
                            }}
                          >
                            Bestätigen → Neuer Vertrag
                          </Button>
                          <FormControl size="small" sx={{ minWidth: { sm: 260 } }}>
                            <InputLabel id={`sugg-target-${s.fingerprint}`}>Zu Vertrag</InputLabel>
                            <Select
                              labelId={`sugg-target-${s.fingerprint}`}
                              label="Zu Vertrag"
                              value={suggestionTargetByFp[s.fingerprint] ?? ''}
                              onChange={(e) =>
                                setSuggestionTargetByFp((prev) => ({ ...prev, [s.fingerprint]: Number(e.target.value) }))
                              }
                              disabled={rows.length === 0}
                            >
                              {rows.map((c) => (
                                <MenuItem key={c.id} value={c.id}>
                                  {c.label}
                                </MenuItem>
                              ))}
                            </Select>
                          </FormControl>
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={async () => {
                              try {
                                setSuggestionErr(null);
                                const targetId = suggestionTargetByFp[s.fingerprint];
                                if (!selectedBankAccountId) return;
                                if (!targetId || typeof targetId !== 'number') throw new Error('Bitte Ziel-Vertrag auswählen.');
                                const crId = suggestionCategoryRuleByFp[s.fingerprint];
                                if (!crId || typeof crId !== 'number') throw new Error('Bitte eine Kategorie-Regel wählen.');
                                await createContractRule(targetId, { category_rule_id: crId });
                                await applyContract(targetId);
                                await ignoreContractSuggestion(selectedBankAccountId, s.fingerprint);
                                await qc.invalidateQueries({ queryKey: ['contracts'] });
                                await qc.invalidateQueries({ queryKey: ['contractSuggestions'] });
                                await qc.invalidateQueries({ queryKey: ['ignoredContractSuggestions'] });
                              } catch (e) {
                                setSuggestionErr(apiErrorMessage(e));
                              }
                            }}
                            disabled={rows.length === 0}
                            sx={{ whiteSpace: 'nowrap' }}
                          >
                            Als Regel hinzufügen
                          </Button>
                          <Button
                            size="small"
                            color="error"
                            variant="outlined"
                            onClick={() =>
                              ignoreSuggestionMut.mutate({
                                bankAccountId: selectedBankAccountId!,
                                fingerprint: s.fingerprint,
                              })
                            }
                            disabled={ignoreSuggestionMut.isPending}
                          >
                            Ignorieren
                          </Button>
                        </Stack>

                        <Accordion
                          expanded={expandedSuggestionFp === s.fingerprint}
                          onChange={(_, open) => setExpandedSuggestionFp(open ? s.fingerprint : null)}
                          variant="outlined"
                          disableGutters
                          sx={{ mt: 1, '&:before': { display: 'none' } }}
                        >
                          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Typography fontWeight={700}>Buchungen</Typography>
                          </AccordionSummary>
                          <AccordionDetails>
                            <TransactionBookingsTable
                              rows={suggestionSeedTxQ.data ?? []}
                              accounts={accountsSorted}
                              isLoading={suggestionSeedTxQ.isLoading || suggestionSeedTxQ.isFetching}
                              error={suggestionSeedTxQ.isError ? suggestionSeedTxQ.error : undefined}
                              title="Buchungen (die zum Vorschlag geführt haben)"
                              hideInlineHint
                              embedded
                              emptyMessage="Keine."
                            />
                          </AccordionDetails>
                        </Accordion>
                      </Paper>
                    );
                  })}
                </Stack>
              </Stack>
            ) : selectedBankAccountId != null && suggestionsQ.isSuccess ? (
              <Typography color="text.secondary">Keine Vorschläge.</Typography>
            ) : null}
          </>
        ) : null}

        {tab === 'ignored' ? (
          <>
            {selectedBankAccountId == null ? (
              <Alert severity="info">Für ignorierte Vorschläge bitte ein konkretes Konto auswählen (nicht „Alle Konten“).</Alert>
            ) : ignoredSuggestionsQ.isError ? (
              <Alert severity="error">{apiErrorMessage(ignoredSuggestionsQ.error)}</Alert>
            ) : null}

            {selectedBankAccountId != null && (ignoredSuggestionsQ.isLoading || ignoredSuggestionsQ.isFetching) ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
                <CircularProgress size={24} />
              </Box>
            ) : null}

            {selectedBankAccountId != null && ignored.length > 0 ? (
              <Stack spacing={1}>
                {ignored.map((x) => (
                  <Paper key={x.fingerprint} variant="outlined" sx={{ p: 1.25 }}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="space-between" alignItems="baseline">
                      <Typography fontWeight={700} sx={{ wordBreak: 'break-word' }}>
                        {x.fingerprint}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {new Date(x.created_at).toLocaleString('de-DE')}
                      </Typography>
                    </Stack>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() =>
                        unignoreSuggestionMut.mutate({ bankAccountId: selectedBankAccountId!, fingerprint: x.fingerprint })
                      }
                      disabled={unignoreSuggestionMut.isPending}
                      sx={{ mt: 1 }}
                    >
                      Wieder anzeigen
                    </Button>
                  </Paper>
                ))}
              </Stack>
            ) : selectedBankAccountId != null && ignoredSuggestionsQ.isSuccess ? (
              <Typography color="text.secondary">Keine ignorierten Vorschläge.</Typography>
            ) : null}
          </>
        ) : null}

        {tab === 'confirmed' ? (
          <>
            {contractsQ.isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                <CircularProgress size={32} />
              </Box>
            ) : rows.length === 0 ? (
              <Typography color="text.secondary">Keine Verträge.</Typography>
            ) : (
              <Stack spacing={1}>
                {rows.map((c) => {
                  const acc = accountsSorted.find((a) => a.id === c.bank_account_id);
                  const hhRules = acc ? usableCategoryRules(categoryRulesByHousehold[acc.household_id] ?? []) : [];
                  const usedIds = new Set((c.rules ?? []).map((r) => r.category_rule_id));
                  const addable = hhRules.filter((r) => !usedIds.has(r.id));
                  return (
                    <Paper key={c.id} variant="outlined" sx={{ p: 1.25 }}>
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1}
                        alignItems={{ sm: 'baseline' }}
                        justifyContent="space-between"
                      >
                        <Stack
                          direction="row"
                          spacing={1}
                          alignItems="baseline"
                          sx={{ minWidth: 0, flex: 1 }}
                        >
                          <Typography fontWeight={700} sx={{ wordBreak: 'break-word', minWidth: 0, flex: 1 }}>
                            {c.label}
                          </Typography>
                          <Tooltip title="Umbenennen">
                            <span>
                              <IconButton
                                size="small"
                                onClick={() => {
                                  setRenameErr(null);
                                  setRenameContractId(c.id);
                                  setRenameLabel(c.label);
                                  setRenameOpen(true);
                                }}
                                disabled={deleteContractMut.isPending}
                                aria-label="Vertrag umbenennen"
                              >
                                <EditOutlinedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Vertrag löschen">
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                onClick={() => {
                                  if (!window.confirm(`Vertrag wirklich löschen?\n\n${c.label}`)) return;
                                  deleteContractMut.mutate(c.id);
                                }}
                                disabled={deleteContractMut.isPending}
                                aria-label="Vertrag löschen"
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: { xs: 0.25, sm: 0 } }}>
                          {c.bank_account_name} · {c.rules?.length ?? 0} Regel(n) · {c.transaction_count ?? 0} Buchung(en) ·
                          Rhythmus: {c.recurrence_label || '—'}
                          {c.recurrence_median_days != null ? ` · Median ${c.recurrence_median_days}d` : ''}
                        </Typography>
                      </Stack>
                      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1 }}>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => {
                            setNewRuleErrByContractId((prev) => ({ ...prev, [c.id]: null }));
                            setNewRuleOpenByContractId((prev) => ({ ...prev, [c.id]: true }));
                            setNewRuleCategoryRuleIdByContractId((prev) => ({ ...prev, [c.id]: '' }));
                          }}
                        >
                          Regel hinzufügen
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => applyMut.mutate(c.id)}
                          disabled={applyMut.isPending}
                        >
                          Apply (Buchungen zuordnen)
                        </Button>
                      </Stack>
                      <Accordion
                        expanded={expandedConfirmedId === c.id}
                        onChange={(_, open) => setExpandedConfirmedId(open ? c.id : null)}
                        variant="outlined"
                        disableGutters
                        sx={{ mt: 1, '&:before': { display: 'none' } }}
                      >
                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                          <Typography fontWeight={700}>Buchungen ({c.transaction_count ?? 0})</Typography>
                        </AccordionSummary>
                        <AccordionDetails>
                          <TransactionBookingsTable
                            rows={confirmedTxQ.data ?? []}
                            accounts={accountsSorted}
                            isLoading={confirmedTxQ.isLoading || confirmedTxQ.isFetching}
                            error={confirmedTxQ.isError ? confirmedTxQ.error : undefined}
                            title="Vertrags-Buchungen (contract_id)"
                            hideInlineHint
                            embedded
                            emptyMessage="Keine."
                          />
                        </AccordionDetails>
                      </Accordion>

                      {applyMut.isSuccess && applyMut.variables === c.id ? (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                          Zuordnung aktualisiert: {applyMut.data.transactions_updated} Buchung(en).
                        </Typography>
                      ) : null}

                      <Stack spacing={1} sx={{ mt: 1 }}>
                        {newRuleOpenByContractId[c.id] ? (
                          <Paper variant="outlined" sx={{ p: 1 }}>
                            <Stack spacing={1}>
                              <Typography variant="body2" fontWeight={700}>
                                Kategorie-Regel verknüpfen
                              </Typography>
                              <FormControl fullWidth size="small">
                                <InputLabel id={`new-cr-${c.id}`}>Kategorie-Regel</InputLabel>
                                <Select
                                  labelId={`new-cr-${c.id}`}
                                  label="Kategorie-Regel"
                                  value={newRuleCategoryRuleIdByContractId[c.id] ?? ''}
                                  onChange={(e) => {
                                    const v = e.target.value;
                                    setNewRuleCategoryRuleIdByContractId((prev) => ({
                                      ...prev,
                                      [c.id]: v === '' ? '' : Number(v),
                                    }));
                                  }}
                                >
                                  {addable.length === 0 ? (
                                    <MenuItem value="" disabled>
                                      Keine weiteren Regeln verfügbar
                                    </MenuItem>
                                  ) : null}
                                  {addable.map((r) => (
                                    <MenuItem key={r.id} value={r.id}>
                                      {r.display_name}
                                    </MenuItem>
                                  ))}
                                </Select>
                              </FormControl>
                              {newRuleErrByContractId[c.id] ? (
                                <Alert severity="error">{newRuleErrByContractId[c.id]}</Alert>
                              ) : null}
                              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                                <Button
                                  size="small"
                                  variant="contained"
                                  onClick={() => {
                                    setNewRuleErrByContractId((prev) => ({ ...prev, [c.id]: null }));
                                    const rid = newRuleCategoryRuleIdByContractId[c.id];
                                    if (!rid || typeof rid !== 'number') {
                                      setNewRuleErrByContractId((prev) => ({
                                        ...prev,
                                        [c.id]: 'Bitte eine Kategorie-Regel wählen.',
                                      }));
                                      return;
                                    }
                                    createRuleMut.mutate(
                                      { contractId: c.id, categoryRuleId: rid },
                                      {
                                        onError: (e) =>
                                          setNewRuleErrByContractId((prev) => ({ ...prev, [c.id]: apiErrorMessage(e) })),
                                        onSuccess: () => {
                                          setNewRuleOpenByContractId((prev) => ({ ...prev, [c.id]: false }));
                                          setNewRuleCategoryRuleIdByContractId((prev) => ({ ...prev, [c.id]: '' }));
                                        },
                                      },
                                    );
                                  }}
                                  disabled={createRuleMut.isPending}
                                >
                                  Speichern
                                </Button>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  onClick={() => {
                                    setNewRuleOpenByContractId((prev) => ({ ...prev, [c.id]: false }));
                                    setNewRuleCategoryRuleIdByContractId((prev) => ({ ...prev, [c.id]: '' }));
                                    setNewRuleErrByContractId((prev) => ({ ...prev, [c.id]: null }));
                                  }}
                                >
                                  Abbrechen
                                </Button>
                              </Stack>
                            </Stack>
                          </Paper>
                        ) : null}

                        {(c.rules ?? []).map((r) => {
                        return null;
                      })}

                      {(c.rules ?? []).length === 0 ? null : (
                        <TableContainer component={Paper} variant="outlined" sx={{ width: '100%', overflowX: 'auto' }}>
                          <Table size="small" sx={{ minWidth: 760 }}>
                            <TableHead>
                              <TableRow>
                                <TableCell sx={{ minWidth: 180 }}>Anzeigename</TableCell>
                                <TableCell sx={{ minWidth: 160 }}>Kategorie</TableCell>
                                <TableCell>Bedingungen (alle müssen zutreffen)</TableCell>
                                <TableCell sx={{ width: 160, whiteSpace: 'nowrap' }}>Angelegt</TableCell>
                                <TableCell align="right" sx={{ width: 56 }} />
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {(c.rules ?? []).map((r) => (
                                <TableRow key={r.id} hover>
                                  <TableCell sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
                                    {r.category_rule_display_name || `Kategorie-Regel #${r.category_rule_id}`}
                                  </TableCell>
                                  <TableCell sx={{ wordBreak: 'break-word' }}>
                                    {r.category_name || `#${r.category_rule_id}`}
                                  </TableCell>
                                  <TableCell sx={{ maxWidth: 520 }}>
                                    {(r.conditions as CategoryRuleCondition[]).length ? (
                                      <Stack spacing={0.5}>
                                        {(r.conditions as CategoryRuleCondition[]).map((cond, i) => (
                                          <Typography key={i} variant="body2">
                                            {describeCategoryRuleCondition(cond)}
                                          </Typography>
                                        ))}
                                      </Stack>
                                    ) : (
                                      <Typography variant="body2" color="text.secondary">
                                        —
                                      </Typography>
                                    )}
                                  </TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.created_at)}</TableCell>
                                  <TableCell align="right">
                                    <Tooltip title="Verknüpfung löschen">
                                      <span>
                                        <IconButton
                                          size="small"
                                          color="error"
                                          onClick={() => deleteRuleMut.mutate(r.id)}
                                          disabled={deleteRuleMut.isPending}
                                          aria-label="Verknüpfung löschen"
                                        >
                                          <DeleteOutlineIcon fontSize="small" />
                                        </IconButton>
                                      </span>
                                    </Tooltip>
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      )}
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            )}
          </>
        ) : null}
      </Paper>

      <Dialog
        open={createOpen}
        onClose={() => {
          if (createContractMut.isPending) return;
          setCreateOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Vertrag anlegen</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {typeof accountFilter !== 'number' ? (
              <FormControl fullWidth>
                <InputLabel id="create-contract-acc">Konto</InputLabel>
                <Select
                  labelId="create-contract-acc"
                  label="Konto"
                  value={createAccountId === '' ? '' : createAccountId}
                  onChange={(e) => setCreateAccountId(Number(e.target.value))}
                >
                  {accountsSorted.map((a) => (
                    <MenuItem key={a.id} value={a.id}>
                      {multihh && householdNameById[a.household_id] ? `${householdNameById[a.household_id]} · ${a.name}` : a.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            ) : (
              <Alert severity="info">Konto: {accountsSorted.find((a) => a.id === accountFilter)?.name ?? String(accountFilter)}</Alert>
            )}

            <TextField
              label="Name"
              value={createLabel}
              onChange={(e) => setCreateLabel(e.target.value)}
              autoFocus
              fullWidth
              inputProps={{ maxLength: 512 }}
            />

            <Alert severity="info">
              Optional: direkt eine Kategorie-Regel verknüpfen. Weitere Verknüpfungen fügst du am Vertrag hinzu.
            </Alert>

            <FormControl fullWidth size="small">
              <InputLabel id="create-first-cr">Kategorie-Regel (optional)</InputLabel>
              <Select
                labelId="create-first-cr"
                label="Kategorie-Regel (optional)"
                value={createFirstCategoryRuleId === '' ? '' : createFirstCategoryRuleId}
                onChange={(e) => {
                  const v = e.target.value;
                  setCreateFirstCategoryRuleId(v === '' ? '' : Number(v));
                }}
              >
                <MenuItem value="">— keine —</MenuItem>
                {createDialogRules.map((r) => (
                  <MenuItem key={r.id} value={r.id}>
                    {r.display_name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {createErr ? <Alert severity="error">{createErr}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              if (createContractMut.isPending) return;
              setCreateOpen(false);
            }}
          >
            Abbrechen
          </Button>
          <Button variant="contained" onClick={() => createContractMut.mutate()} disabled={createContractMut.isPending}>
            Anlegen
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={renameOpen}
        onClose={() => {
          if (updateContractMut.isPending) return;
          setRenameOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Vertrag umbenennen</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label="Name"
              value={renameLabel}
              onChange={(e) => setRenameLabel(e.target.value)}
              autoFocus
              fullWidth
              inputProps={{ maxLength: 512 }}
            />
            {renameErr ? <Alert severity="error">{renameErr}</Alert> : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              if (updateContractMut.isPending) return;
              setRenameOpen(false);
            }}
          >
            Abbrechen
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setRenameErr(null);
              if (!renameContractId) return;
              updateContractMut.mutate(
                { contractId: renameContractId, label: renameLabel },
                {
                  onSuccess: () => setRenameOpen(false),
                  onError: (e) => setRenameErr(apiErrorMessage(e)),
                },
              );
            }}
            disabled={updateContractMut.isPending || !renameLabel.trim()}
          >
            Speichern
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
