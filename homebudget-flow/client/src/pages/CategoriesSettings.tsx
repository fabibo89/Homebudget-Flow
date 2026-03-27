import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  DeleteOutline as DeleteOutlineIcon,
  EditOutlined as EditOutlinedIcon,
  ExpandMore as ExpandMoreIcon,
} from '@mui/icons-material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiErrorMessage,
  createCategory,
  deleteCategory,
  deleteCategoryRule,
  fetchCategories,
  fetchCategoryRules,
  dismissCategoryRuleSuggestion,
  fetchCategoryRuleSuggestions,
  fetchCategoryRuleSuggestionPreview,
  fetchHouseholds,
  restoreCategoryRuleSuggestion,
  updateCategory,
  type CategoryOut,
  type CategoryRuleOut,
  type CategoryRuleOverwriteCandidate,
  type CategoryRuleSuggestion,
  type CategoryRuleSuggestionPreviewOut,
  type CategoryRuleType,
} from '../api/client';
import CategoryRuleOverwriteDialog from '../components/CategoryRuleOverwriteDialog';
import CreateCategoryRuleDialog from '../components/CreateCategoryRuleDialog';
import { CategorySymbolDisplay, CategorySymbolPicker } from '../components/CategorySymbol';
import {
  categoryRuleBookingsTab,
  describeCategoryRuleCondition,
  formatDate,
  formatDateTime,
  formatMoney,
  type CategoryRulesBookingsTab,
} from '../lib/transactionUi';

function categoryRuleTypeDescription(t: CategoryRuleType | string): string {
  switch (t) {
    case 'description_contains':
      return 'Verwendungszweck enthält';
    case 'description_equals':
      return 'Verwendungszweck ist (exakt)';
    case 'counterparty_contains':
      return 'Gegenpartei enthält';
    case 'counterparty_equals':
      return 'Gegenpartei ist (exakt)';
    case 'conditions':
      return 'Mehrere Bedingungen';
    default:
      return String(t);
  }
}

function categoryCreatorLine(row: CategoryOut): string | null {
  const d = row.created_by_display?.trim();
  return d ? `Angelegt von ${d}` : null;
}

function categoryNameByIdMap(roots: CategoryOut[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const r of roots) {
    m.set(r.id, r.name);
    for (const c of r.children) {
      m.set(c.id, `${r.name} → ${c.name}`);
    }
  }
  return m;
}

type EditMode =
  | { kind: 'new_root' }
  | { kind: 'new_child'; parentId: number; parentColor: string }
  | { kind: 'edit'; row: CategoryOut };

const defaultRootColor = '#6366f1';

export default function CategoriesSettings() {
  const qc = useQueryClient();
  const [householdId, setHouseholdId] = useState<number | ''>('');
  const [edit, setEdit] = useState<EditMode | null>(null);
  const [formName, setFormName] = useState('');
  const [formColor, setFormColor] = useState(defaultRootColor);
  const [formSubAutoColor, setFormSubAutoColor] = useState(true);
  const [formEmoji, setFormEmoji] = useState('');
  const [suggestionDialog, setSuggestionDialog] = useState<CategoryRuleSuggestion | null>(null);
  const [suggestionPreviewDialog, setSuggestionPreviewDialog] = useState<CategoryRuleSuggestion | null>(null);
  const [ruleEditDialog, setRuleEditDialog] = useState<CategoryRuleOut | null>(null);
  const [newRuleDialogOpen, setNewRuleDialogOpen] = useState(false);
  const [ruleSavedSnack, setRuleSavedSnack] = useState<string | null>(null);
  const [ruleOverwriteDialog, setRuleOverwriteDialog] = useState<{
    candidates: CategoryRuleOverwriteCandidate[];
    truncated: boolean;
  } | null>(null);
  const [rulesBookingsTab, setRulesBookingsTab] = useState<CategoryRulesBookingsTab>('ausgabe');
  const [settingsMainTab, setSettingsMainTab] = useState<'kategorien' | 'regeln'>('kategorien');

  const hhQuery = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });
  const catQuery = useQuery({
    queryKey: ['categories', householdId],
    queryFn: () => fetchCategories(Number(householdId)),
    enabled: householdId !== '',
  });

  const rulesQuery = useQuery({
    queryKey: ['category-rules', householdId],
    queryFn: () => fetchCategoryRules(Number(householdId)),
    enabled: householdId !== '',
  });

  const suggestionsQuery = useQuery({
    queryKey: ['category-rule-suggestions', householdId],
    queryFn: () => fetchCategoryRuleSuggestions(Number(householdId)),
    enabled: householdId !== '',
  });

  const suggestionPreviewQuery = useQuery({
    queryKey: [
      'category-rule-suggestion-preview',
      householdId,
      suggestionPreviewDialog?.rule_type,
      suggestionPreviewDialog?.pattern,
    ],
    queryFn: (): Promise<CategoryRuleSuggestionPreviewOut> => {
      if (suggestionPreviewDialog == null) throw new Error('no suggestion');
      return fetchCategoryRuleSuggestionPreview({
        householdId: Number(householdId),
        rule_type: suggestionPreviewDialog.rule_type,
        pattern: suggestionPreviewDialog.pattern,
        sample_labels: suggestionPreviewDialog.sample_labels,
        limit_per_label: 25,
        limit_total: 200,
      });
    },
    enabled: householdId !== '' && suggestionPreviewDialog != null,
  });

  const households = hhQuery.data ?? [];

  useEffect(() => {
    if (householdId === '' && households.length > 0) {
      setHouseholdId(households[0].id);
    }
  }, [households, householdId]);

  useEffect(() => {
    setRulesBookingsTab('ausgabe');
  }, [householdId]);

  const createMut = useMutation({
    mutationFn: (body: Parameters<typeof createCategory>[1]) =>
      createCategory(Number(householdId), body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories', householdId] });
      setEdit(null);
    },
  });

  const updateMut = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number;
      body: Parameters<typeof updateCategory>[2];
    }) => updateCategory(Number(householdId), id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['categories', householdId] });
      setEdit(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => deleteCategory(Number(householdId), id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['categories', householdId] }),
  });

  const dismissSuggestionMut = useMutation({
    mutationFn: (s: CategoryRuleSuggestion) => dismissCategoryRuleSuggestion(Number(householdId), s),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['category-rule-suggestions', householdId] }),
  });

  const restoreSuggestionMut = useMutation({
    mutationFn: (s: CategoryRuleSuggestion) =>
      restoreCategoryRuleSuggestion(Number(householdId), { rule_type: s.rule_type, pattern: s.pattern }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['category-rule-suggestions', householdId] }),
  });

  const deleteRuleMut = useMutation({
    mutationFn: (ruleId: number) => deleteCategoryRule(Number(householdId), ruleId),
    onSuccess: () => {
      setRuleEditDialog(null);
      void qc.invalidateQueries({ queryKey: ['category-rules', householdId] });
      void qc.invalidateQueries({ queryKey: ['category-rule-suggestions', householdId] });
      setRuleSavedSnack('Regel gelöscht.');
    },
  });

  function openNewRoot() {
    setFormName('');
    setFormColor(defaultRootColor);
    setFormEmoji('');
    setEdit({ kind: 'new_root' });
  }

  function openNewChild(parent: CategoryOut) {
    setFormName('');
    setFormColor(parent.effective_color_hex);
    setFormSubAutoColor(true);
    setFormEmoji('');
    setEdit({ kind: 'new_child', parentId: parent.id, parentColor: parent.color_hex || parent.effective_color_hex });
  }

  function openEdit(row: CategoryOut) {
    setFormName(row.name);
    setFormColor(row.color_hex || row.effective_color_hex);
    setFormSubAutoColor(!row.color_hex && row.parent_id != null);
    setFormEmoji(row.icon_emoji ?? '');
    setEdit({ kind: 'edit', row });
  }

  function submitForm() {
    const name = formName.trim();
    if (!name) return;
    const icon = formEmoji.trim() || null;

    if (edit?.kind === 'new_root') {
      createMut.mutate({
        name,
        parent_id: null,
        color_hex: formColor,
        icon_emoji: icon,
      });
      return;
    }
    if (edit?.kind === 'new_child') {
      createMut.mutate({
        name,
        parent_id: edit.parentId,
        color_hex: formSubAutoColor ? null : formColor,
        icon_emoji: icon,
      });
      return;
    }
    if (edit?.kind === 'edit') {
      const body: Parameters<typeof updateCategory>[2] = {
        name,
        icon_emoji: icon,
      };
      if (edit.row.parent_id == null) {
        body.color_hex = formColor;
      } else {
        body.color_hex = formSubAutoColor ? null : formColor;
      }
      updateMut.mutate({ id: edit.row.id, body });
    }
  }

  const roots = catQuery.data ?? [];
  const rulesBundle = rulesQuery.data;
  const rulesList = rulesBundle?.rules ?? [];
  const ruleWarnings = rulesBundle?.warnings ?? [];
  const rulesListFiltered = useMemo(() => {
    if (rulesBookingsTab === 'vorschlaege') return [];
    return rulesList
      .map((rule, idx) => ({ rule, globalPriority: idx + 1 }))
      .filter(({ rule }) => categoryRuleBookingsTab(rule) === rulesBookingsTab);
  }, [rulesList, rulesBookingsTab]);
  const categoryLabels = useMemo(() => categoryNameByIdMap(roots), [roots]);
  const suggestionActiveList = suggestionsQuery.data?.active ?? [];
  const suggestionIgnoredList = suggestionsQuery.data?.ignored ?? [];
  const busy = createMut.isPending || updateMut.isPending;
  const suggestionMutating = dismissSuggestionMut.isPending || restoreSuggestionMut.isPending;
  const categoryEditCreatorNote = edit?.kind === 'edit' ? categoryCreatorLine(edit.row) : null;

  return (
    <Stack spacing={3}>
      {hhQuery.isError ? <Alert severity="error">{apiErrorMessage(hhQuery.error)}</Alert> : null}

      <FormControl sx={{ maxWidth: 360 }} size="small">
        <InputLabel id="hh-cat">Haushalt</InputLabel>
        <Select
          labelId="hh-cat"
          label="Haushalt"
          value={householdId === '' ? '' : householdId}
          onChange={(e) => setHouseholdId(e.target.value === '' ? '' : Number(e.target.value))}
        >
          {households.map((h) => (
            <MenuItem key={h.id} value={h.id}>
              {h.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <Tabs
        value={settingsMainTab}
        onChange={(_, v: 'kategorien' | 'regeln') => setSettingsMainTab(v)}
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 0 }}
        aria-label="Kategorien oder Regeln bearbeiten"
      >
        <Tab value="kategorien" label="Kategorien" />
        <Tab value="regeln" label="Regeln" />
      </Tabs>

      {settingsMainTab === 'kategorien' ? (
        <Stack spacing={3}>
          <Box>
            <Typography variant="h5" fontWeight={700} gutterBottom>
              Kategorien
            </Typography>
            <Typography color="text.secondary" variant="body2" paragraph sx={{ mb: 0 }}>
              Hauptkategorien mit eigener Farbe dienen der Gruppierung; bei neuer Hauptkategorie wird automatisch die
              Unterkategorie „Sonstiges“ angelegt. Buchungen und Regeln werden nur Unterkategorien zugeordnet — nicht
              der Hauptkategorie selbst. Unterkategorien ohne eigene Farbe erhalten automatisch unterschiedliche
              Aufhellungsstufen derselben Basis. Optional kann jede Unterkategorie eine feste Eigfarbe bekommen. Pro
              Kategorie optional ein Material-Symbol (einfarbig).
            </Typography>
          </Box>

      {householdId === '' ? (
        <Alert severity="info">Bitte zuerst unter Einrichtung einen Haushalt anlegen.</Alert>
      ) : catQuery.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : catQuery.isError ? (
        <Alert severity="error">{apiErrorMessage(catQuery.error)}</Alert>
      ) : (
        <>
          <Box>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openNewRoot}>
              Hauptkategorie
            </Button>
          </Box>

          <Stack spacing={2}>
            {roots.map((root) => (
              <Card
                key={root.id}
                elevation={0}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderLeft: 4,
                  borderLeftColor: root.effective_color_hex,
                  bgcolor: (t) =>
                    t.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : `${root.effective_color_hex}14`,
                }}
              >
                <CardContent>
                  <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
                    {root.icon_emoji ? (
                      <Box sx={{ display: 'flex', alignItems: 'center' }}>
                        <CategorySymbolDisplay value={root.icon_emoji} fontSize="1.75rem" />
                      </Box>
                    ) : null}
                    <Typography variant="h6" fontWeight={700}>
                      {root.name}
                    </Typography>
                    <Box
                      sx={{
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        bgcolor: root.effective_color_hex,
                        border: 1,
                        borderColor: 'divider',
                      }}
                    />
                    <Box sx={{ flexGrow: 1 }} />
                    <Tooltip title="Unterkategorie">
                      <IconButton size="small" color="primary" onClick={() => openNewChild(root)}>
                        <AddIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Bearbeiten">
                      <IconButton size="small" onClick={() => openEdit(root)}>
                        <EditOutlinedIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Löschen (inkl. Unterkategorien)">
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => {
                          if (window.confirm(`„${root.name}“ und alle Unterkategorien löschen?`)) {
                            deleteMut.mutate(root.id);
                          }
                        }}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>

                  {root.children.length > 0 ? (
                    <Stack spacing={1} sx={{ mt: 2, pl: 2, borderLeft: 2, borderColor: 'divider' }}>
                      {root.children.map((sub) => (
                        <Stack key={sub.id} spacing={0.25} sx={{ width: '100%' }}>
                          <Stack
                            direction="row"
                            alignItems="center"
                            spacing={1}
                            flexWrap="wrap"
                            useFlexGap
                          >
                            {sub.icon_emoji ? (
                              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                                <CategorySymbolDisplay value={sub.icon_emoji} fontSize="1.35rem" />
                              </Box>
                            ) : null}
                            <Typography variant="body1" fontWeight={600}>
                              {sub.name}
                            </Typography>
                            <Box
                              sx={{
                                width: 18,
                                height: 18,
                                borderRadius: '50%',
                                bgcolor: sub.effective_color_hex,
                                border: 1,
                                borderColor: 'divider',
                              }}
                            />
                            <Box sx={{ flexGrow: 1 }} />
                            <IconButton size="small" onClick={() => openEdit(sub)}>
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => {
                                if (window.confirm(`„${sub.name}“ löschen?`)) deleteMut.mutate(sub.id);
                              }}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        </Stack>
                      ))}
                    </Stack>
                  ) : null}
                </CardContent>
              </Card>
            ))}
            {roots.length === 0 ? (
              <Typography color="text.secondary" variant="body2">
                Noch keine Kategorien — „Hauptkategorie“ anlegen.
              </Typography>
            ) : null}
          </Stack>
        </>
      )}
        </Stack>
      ) : (
        <Stack spacing={5}>
          {householdId === '' ? (
            <Alert severity="info">Bitte zuerst einen Haushalt wählen — Regeln und Vorschläge sind pro Haushalt.</Alert>
          ) : (
            <>
            <Box>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="h5" fontWeight={700} gutterBottom>
                    Zuordnungsregeln
                  </Typography>
                  <Typography color="text.secondary" variant="body2">
                    Automatische Kategorie-Zuordnung aus der Buchungsübersicht. <strong>Neuere Regeln</strong> (höhere
                    Priorität) stehen oben und werden zuerst geprüft. Mehrere Bedingungen pro Regel sind per UND
                    verknüpft (z. B. Gutschrift und Betragsbereich für Gehalt). Unter <strong>Ausgaben</strong>,{' '}
                    <strong>Einnahmen</strong> und <strong>Alle</strong> filtern Sie die Regelliste; Muster-Vorschläge
                    aus unkategorisierten Buchungen finden Sie im Register <strong>Vorschläge</strong>.
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Button
                    variant="contained"
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={() => {
                      setSuggestionDialog(null);
                      setRuleEditDialog(null);
                      setNewRuleDialogOpen(true);
                    }}
                  >
                    Neue Regel
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      if (rulesBookingsTab === 'vorschlaege') void suggestionsQuery.refetch();
                      else void rulesQuery.refetch();
                    }}
                    disabled={
                      rulesBookingsTab === 'vorschlaege'
                        ? suggestionsQuery.isFetching || catQuery.isLoading
                        : rulesQuery.isFetching
                    }
                  >
                    {rulesBookingsTab === 'vorschlaege'
                      ? suggestionsQuery.isFetching
                        ? 'Laden…'
                        : 'Aktualisieren'
                      : rulesQuery.isFetching
                        ? 'Laden…'
                        : 'Aktualisieren'}
                  </Button>
                </Stack>
              </Stack>
              <Tabs
                value={rulesBookingsTab}
                onChange={(_, v: CategoryRulesBookingsTab) => setRulesBookingsTab(v)}
                sx={{ borderBottom: 1, borderColor: 'divider', mb: 2, minHeight: 0 }}
                aria-label="Regeln und Vorschläge"
              >
                <Tab value="ausgabe" label="Ausgaben" />
                <Tab value="einnahme" label="Einnahmen" />
                <Tab value="alle" label="Alle" />
                <Tab value="vorschlaege" label="Vorschläge" />
              </Tabs>
              {rulesBookingsTab === 'vorschlaege' ? (
            <Box>
              <Box sx={{ mb: 2 }}>
                <Typography variant="h6" fontWeight={700} gutterBottom>
                  Vorschläge für Regeln
                </Typography>
                <Typography color="text.secondary" variant="body2" paragraph sx={{ mb: 0 }}>
                  Unkategorisierte Buchungen, die nach Gegenpartei oder Verwendungszweck zusammenpassen — z. B. gemeinsame
                  Wörter wie „edeka“ bei verschiedenen Filialen. Es werden nur Treffer gezeigt, die noch von keiner
                  bestehenden Regel abgedeckt sind (bis zu 20.000 jüngste offene Buchungen). Listenaktualisierung: oben
                  „Aktualisieren“.
                </Typography>
              </Box>
              {suggestionsQuery.isError ? (
                <Alert severity="error">{apiErrorMessage(suggestionsQuery.error)}</Alert>
              ) : suggestionsQuery.isLoading || catQuery.isLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                  <CircularProgress size={28} />
                </Box>
              ) : roots.length === 0 ? (
                <Typography color="text.secondary" variant="body2">
                  Zuerst Kategorien anlegen, dann können Sie Vorschläge als Regeln übernehmen.
                </Typography>
              ) : (
                <Stack spacing={3}>
                  {dismissSuggestionMut.isError ? (
                    <Alert severity="error">{apiErrorMessage(dismissSuggestionMut.error)}</Alert>
                  ) : null}
                  {restoreSuggestionMut.isError ? (
                    <Alert severity="error">{apiErrorMessage(restoreSuggestionMut.error)}</Alert>
                  ) : null}
                  {suggestionActiveList.length === 0 && suggestionIgnoredList.length === 0 ? (
                    <Typography color="text.secondary" variant="body2">
                      Keine Vorschläge — keine passenden Gruppen unkategorisierter Buchungen, alle durch Regeln abgedeckt
                      oder ausgeblendet.
                    </Typography>
                  ) : null}
                  {suggestionActiveList.length === 0 && suggestionIgnoredList.length > 0 ? (
                    <Typography color="text.secondary" variant="body2">
                      Keine aktiven Vorschläge — alle passenden Treffer sind unten unter „Ignoriert“ gelistet oder es gibt
                      aktuell keine neuen Muster.
                    </Typography>
                  ) : null}
                  {suggestionActiveList.length > 0 ? (
                    <TableContainer component={Paper} variant="outlined" sx={{ maxWidth: 1100 }}>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>Bedingung</TableCell>
                            <TableCell>Muster</TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                              Buchungen
                            </TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                              Verschiedene Texte
                            </TableCell>
                            <TableCell>Beispiele</TableCell>
                            <TableCell align="right" sx={{ width: 220, whiteSpace: 'nowrap' }}>
                              Aktionen
                            </TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {suggestionActiveList.map((s) => (
                            <TableRow
                              key={`active:${s.rule_type}:${s.pattern}`}
                              hover
                              sx={{ cursor: 'pointer' }}
                              onClick={() => setSuggestionPreviewDialog(s)}
                            >
                              <TableCell>{categoryRuleTypeDescription(s.rule_type)}</TableCell>
                              <TableCell>
                                <Typography
                                  component="span"
                                  variant="body2"
                                  sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}
                                >
                                  „{s.pattern}“
                                </Typography>
                              </TableCell>
                              <TableCell align="right">{s.transaction_count}</TableCell>
                              <TableCell align="right">{s.distinct_label_count}</TableCell>
                              <TableCell>
                                <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
                                  {s.sample_labels.map((lab, li) => (
                                    <Chip
                                      key={`${li}-${lab}`}
                                      size="small"
                                      variant="outlined"
                                      label={lab.length > 48 ? `${lab.slice(0, 45)}…` : lab}
                                      title={lab}
                                    />
                                  ))}
                                </Stack>
                              </TableCell>
                              <TableCell align="right">
                                <Stack direction="row" spacing={0.5} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                                  <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setRuleEditDialog(null);
                                      setNewRuleDialogOpen(false);
                                      setSuggestionDialog(s);
                                    }}
                                    disabled={suggestionMutating}
                                  >
                                    Regel anlegen
                                  </Button>
                                  <Button
                                    size="small"
                                    color="inherit"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      dismissSuggestionMut.mutate(s);
                                    }}
                                    disabled={suggestionMutating}
                                  >
                                    Ignorieren
                                  </Button>
                                </Stack>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : null}

                  <Box>
                    <Typography variant="h6" fontWeight={700} gutterBottom>
                      Ignorierte Vorschläge
                    </Typography>
                    <Typography color="text.secondary" variant="body2" paragraph sx={{ mb: 2 }}>
                      Aus der Hauptliste ausgeblendet. Zahlen und Beispiele sind der Stand beim Ignorieren — mit
                      „Wiederherstellen“ erscheint der Vorschlag wieder oben, sofern die Daten noch passen.
                    </Typography>
                    {suggestionIgnoredList.length === 0 ? (
                      <Typography color="text.secondary" variant="body2">
                        Keine ignorierten Vorschläge.
                      </Typography>
                    ) : (
                      <TableContainer component={Paper} variant="outlined" sx={{ maxWidth: 1100 }}>
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              <TableCell>Bedingung</TableCell>
                              <TableCell>Muster</TableCell>
                              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                Buchungen (Snapshot)
                              </TableCell>
                              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                Verschiedene Texte
                              </TableCell>
                              <TableCell>Beispiele</TableCell>
                              <TableCell align="right" sx={{ width: 220, whiteSpace: 'nowrap' }}>
                                Aktionen
                              </TableCell>
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {suggestionIgnoredList.map((s) => (
                              <TableRow
                                key={`ignored:${s.rule_type}:${s.pattern}`}
                                hover
                                sx={{ cursor: 'pointer' }}
                                onClick={() => setSuggestionPreviewDialog(s)}
                              >
                                <TableCell>{categoryRuleTypeDescription(s.rule_type)}</TableCell>
                                <TableCell>
                                  <Typography
                                    component="span"
                                    variant="body2"
                                    sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}
                                  >
                                    „{s.pattern}“
                                  </Typography>
                                </TableCell>
                                <TableCell align="right">{s.transaction_count}</TableCell>
                                <TableCell align="right">{s.distinct_label_count}</TableCell>
                                <TableCell>
                                  <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
                                    {s.sample_labels.map((lab, li) => (
                                      <Chip
                                        key={`${li}-${lab}`}
                                        size="small"
                                        variant="outlined"
                                        label={lab.length > 48 ? `${lab.slice(0, 45)}…` : lab}
                                        title={lab}
                                      />
                                    ))}
                                  </Stack>
                                </TableCell>
                                <TableCell align="right">
                                  <Stack direction="row" spacing={0.5} justifyContent="flex-end" flexWrap="wrap" useFlexGap>
                                    <Button
                                      size="small"
                                      variant="outlined"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        restoreSuggestionMut.mutate(s);
                                      }}
                                      disabled={suggestionMutating}
                                    >
                                      Wiederherstellen
                                    </Button>
                                    <Button
                                      size="small"
                                      variant="outlined"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setRuleEditDialog(null);
                                        setNewRuleDialogOpen(false);
                                        setSuggestionDialog(s);
                                      }}
                                      disabled={suggestionMutating}
                                    >
                                      Regel anlegen
                                    </Button>
                                  </Stack>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    )}
                  </Box>
                </Stack>
              )}
            </Box>
              ) : (
                <>
                  {ruleWarnings.map((w, wi) => (
                    <Alert key={wi} severity="warning" sx={{ mb: 2 }}>
                      {w}
                    </Alert>
                  ))}
                  {rulesQuery.isError ? (
                    <Alert severity="error">{apiErrorMessage(rulesQuery.error)}</Alert>
                  ) : rulesQuery.isLoading ? (
                    <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                      <CircularProgress size={32} />
                    </Box>
                  ) : rulesList.length === 0 ? (
                    <Typography color="text.secondary" variant="body2">
                      Noch keine Regeln — oben „Neue Regel“ nutzen oder in der Buchungsübersicht bei einer
                      unkategorisierten Buchung per Linksklick auf die Kategorie eine Regel anlegen.
                    </Typography>
                  ) : rulesListFiltered.length === 0 ? (
                    <Typography color="text.secondary" variant="body2">
                      Keine Regeln in dieser Ansicht — anderes Register wählen (z. B. „Alle“) oder eine Regel mit
                      passender Buchungsrichtung anlegen.
                    </Typography>
                  ) : (
                    <TableContainer component={Paper} variant="outlined" sx={{ maxWidth: 1100 }}>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell width={72}>Priorität</TableCell>
                            <TableCell>Kategorie</TableCell>
                            <TableCell width={140}>Geltung</TableCell>
                            <TableCell>Bedingungen (alle müssen zutreffen)</TableCell>
                            <TableCell width={160}>Angelegt</TableCell>
                            <TableCell align="right" width={56} />
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {rulesListFiltered.map(({ rule, globalPriority }) => (
                            <TableRow key={rule.id} hover>
                              <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{globalPriority}</TableCell>
                              <TableCell>
                                {categoryLabels.get(rule.category_id) ?? `Kategorie #${rule.category_id}`}
                              </TableCell>
                              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                <Typography variant="body2">
                                  {rule.applies_to_household !== false ? 'Haushalt' : 'Meine Konten'}
                                </Typography>
                              </TableCell>
                              <TableCell sx={{ maxWidth: 520 }}>
                                {(rule.conditions?.length ?? 0) > 0 ? (
                                  <Stack spacing={0.5}>
                                    {rule.conditions.map((c, i) => (
                                      <Typography key={i} variant="body2">
                                        {describeCategoryRuleCondition(c)}
                                      </Typography>
                                    ))}
                                  </Stack>
                                ) : (
                                  <Stack spacing={0.5}>
                                    <Typography variant="body2">
                                      {categoryRuleTypeDescription(rule.rule_type)}
                                    </Typography>
                                    <Typography
                                      variant="body2"
                                      sx={{ fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}
                                    >
                                      „{rule.pattern}“
                                    </Typography>
                                  </Stack>
                                )}
                              </TableCell>
                              <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateTime(rule.created_at)}</TableCell>
                              <TableCell align="right">
                                <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                                  <Tooltip title="Regel bearbeiten">
                                    <IconButton
                                      size="small"
                                      aria-label="Regel bearbeiten"
                                      onClick={() => {
                                        setSuggestionDialog(null);
                                        setNewRuleDialogOpen(false);
                                        setRuleEditDialog(rule);
                                      }}
                                    >
                                      <EditOutlinedIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                  <Tooltip title="Regel löschen">
                                    <IconButton
                                      size="small"
                                      color="error"
                                      aria-label="Regel löschen"
                                      disabled={deleteRuleMut.isPending}
                                      onClick={() => {
                                        if (
                                          !window.confirm(
                                            `Regel wirklich löschen?\n\n${categoryRuleTypeDescription(rule.rule_type)}: "${rule.pattern}"`,
                                          )
                                        )
                                          return;
                                        deleteRuleMut.mutate(rule.id);
                                      }}
                                    >
                                      <DeleteOutlineIcon fontSize="small" />
                                    </IconButton>
                                  </Tooltip>
                                </Stack>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </>
              )}
            </Box>
            </>
          )}
        </Stack>
      )}

      <Dialog open={edit !== null} onClose={() => !busy && setEdit(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {edit?.kind === 'new_root'
            ? 'Hauptkategorie'
            : edit?.kind === 'new_child'
              ? 'Unterkategorie'
              : 'Kategorie bearbeiten'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {categoryEditCreatorNote ? (
              <Typography variant="caption" color="text.secondary">
                {categoryEditCreatorNote}
              </Typography>
            ) : null}
            <TextField label="Name" value={formName} onChange={(e) => setFormName(e.target.value)} fullWidth autoFocus />
            {edit?.kind === 'new_child' || (edit?.kind === 'edit' && edit.row.parent_id != null) ? (
              <FormControlLabel
                control={
                  <Switch
                    checked={formSubAutoColor}
                    onChange={(_, c) => setFormSubAutoColor(c)}
                    disabled={edit.kind === 'edit' && edit.row.parent_id == null}
                  />
                }
                label="Farbe automatisch (hellere Variante der Hauptkategorie)"
              />
            ) : null}
            {(edit?.kind === 'new_root' ||
              (edit?.kind === 'edit' && edit.row.parent_id == null) ||
              ((edit?.kind === 'new_child' || (edit?.kind === 'edit' && edit.row.parent_id != null)) &&
                !formSubAutoColor)) && (
              <Stack direction="row" spacing={2} alignItems="center">
                <Typography variant="body2" sx={{ minWidth: 80 }}>
                  Farbe
                </Typography>
                <input
                  type="color"
                  value={formColor.startsWith('#') ? formColor : `#${formColor}`}
                  onChange={(e) => setFormColor(e.target.value)}
                  style={{ width: 48, height: 36, border: 'none', cursor: 'pointer', background: 'transparent' }}
                />
                <TextField
                  size="small"
                  value={formColor}
                  onChange={(e) => setFormColor(e.target.value)}
                  placeholder="#6366f1"
                  sx={{ flex: 1 }}
                />
              </Stack>
            )}
            <CategorySymbolPicker value={formEmoji} onChange={setFormEmoji} />
            {(createMut.error || updateMut.error) && (
              <Alert severity="error">
                {apiErrorMessage(createMut.error ?? updateMut.error)}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEdit(null)} disabled={busy}>
            Abbrechen
          </Button>
          <Button variant="contained" onClick={submitForm} disabled={busy || !formName.trim()}>
            {busy ? <CircularProgress size={22} /> : 'Speichern'}
          </Button>
        </DialogActions>
      </Dialog>

      <CreateCategoryRuleDialog
        open={suggestionDialog != null || ruleEditDialog != null || newRuleDialogOpen}
        onClose={() => {
          setSuggestionDialog(null);
          setRuleEditDialog(null);
          setNewRuleDialogOpen(false);
        }}
        householdId={householdId === '' ? null : Number(householdId)}
        suggestionPreset={suggestionDialog}
        editingRule={ruleEditDialog}
        onRuleApplied={(data) => {
          setSettingsMainTab('regeln');
          const parts: string[] = [];
          if (data.transactions_updated > 0) {
            parts.push(`${data.transactions_updated} unkategorisierte Buchung(en) zugeordnet.`);
          }
          if (data.category_overwrite_candidates.length > 0) {
            setRuleOverwriteDialog({
              candidates: data.category_overwrite_candidates,
              truncated: data.category_overwrite_truncated,
            });
            parts.push('Bereits kategorisierte Buchungen: siehe Dialog zur Übernahme.');
          }
          setRuleSavedSnack(
            parts.length > 0 ? parts.join(' ') : 'Zuordnung ausgeführt — keine weiteren Änderungen nötig.',
          );
        }}
        onCreated={(data) => {
          setSettingsMainTab('regeln');
          if (suggestionDialog != null) {
            setRulesBookingsTab('vorschlaege');
          }
          const parts = [ruleEditDialog != null ? `Regel aktualisiert.` : `Regel gespeichert.`];
          if (data.transactions_updated > 0) {
            parts.push(`${data.transactions_updated} unkategorisierte Buchung(en) zugeordnet.`);
          }
          if (data.category_overwrite_candidates.length > 0) {
            setRuleOverwriteDialog({
              candidates: data.category_overwrite_candidates,
              truncated: data.category_overwrite_truncated,
            });
            parts.push('Bereits kategorisierte Buchungen: siehe Dialog zur Übernahme.');
          }
          setRuleSavedSnack(parts.join(' '));
        }}
      />

      <Dialog
        open={suggestionPreviewDialog != null}
        onClose={() => setSuggestionPreviewDialog(null)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          Vorschlag:{' '}
          {suggestionPreviewDialog ? categoryRuleTypeDescription(suggestionPreviewDialog.rule_type) : ''}
        </DialogTitle>
        <DialogContent dividers>
          {suggestionPreviewDialog ? (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'ui-monospace, monospace' }}>
                „{suggestionPreviewDialog.pattern}“
              </Typography>

              {suggestionPreviewQuery.isError ? (
                <Alert severity="error">{apiErrorMessage(suggestionPreviewQuery.error)}</Alert>
              ) : suggestionPreviewQuery.isLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                  <CircularProgress size={32} />
                </Box>
              ) : (
                <>
                  {suggestionPreviewQuery.data?.truncated ? (
                    <Alert severity="info">
                      Trefferliste gekürzt (max. 25 pro Gruppe, max. 200 insgesamt). Bitte Regel anlegen und ggf. weiter
                      einschränken.
                    </Alert>
                  ) : null}

                  {(suggestionPreviewQuery.data?.groups ?? []).length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      Keine passenden unkategorisierten Buchungen gefunden (oder bereits durch andere Regeln abgedeckt).
                    </Typography>
                  ) : (
                    <Stack spacing={2.5}>
                      {(suggestionPreviewQuery.data?.groups ?? []).map((g) => (
                        <Accordion
                          key={g.label}
                          variant="outlined"
                          defaultExpanded
                          disableGutters
                          sx={{ '&:before': { display: 'none' } }}
                        >
                          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                              <Chip size="small" label={g.label} />
                              <Typography variant="caption" color="text.secondary">
                                {g.transactions.length} Buchungen
                              </Typography>
                            </Stack>
                          </AccordionSummary>
                          <AccordionDetails>
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell sx={{ width: 120 }}>Datum</TableCell>
                                  <TableCell sx={{ width: 140 }}>Betrag</TableCell>
                                  <TableCell>Text</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {g.transactions.map((t) => (
                                  <TableRow key={t.id} hover>
                                    <TableCell>{formatDate(t.booking_date)}</TableCell>
                                    <TableCell sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                      {formatMoney(t.amount, t.currency)}
                                    </TableCell>
                                    <TableCell sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                      {(t.counterparty ?? '').trim() ? (
                                        <>
                                          <strong>{t.counterparty}</strong>
                                          {' — '}
                                        </>
                                      ) : null}
                                      {t.description || '—'}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </AccordionDetails>
                        </Accordion>
                      ))}
                    </Stack>
                  )}
                </>
              )}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSuggestionPreviewDialog(null)}>Schließen</Button>
          {suggestionPreviewDialog ? (
            <Button
              variant="contained"
              onClick={() => {
                setRuleEditDialog(null);
                setNewRuleDialogOpen(false);
                setSuggestionDialog(suggestionPreviewDialog);
              }}
            >
              Regel anlegen
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>

      <CategoryRuleOverwriteDialog
        open={ruleOverwriteDialog != null}
        onClose={() => setRuleOverwriteDialog(null)}
        candidates={ruleOverwriteDialog?.candidates ?? []}
        truncated={ruleOverwriteDialog?.truncated ?? false}
        onNotify={(msg) => setRuleSavedSnack((s) => `${s ?? ''}${s ? ' ' : ''}${msg}`)}
      />

      <Snackbar
        open={ruleSavedSnack != null}
        autoHideDuration={8000}
        onClose={() => setRuleSavedSnack(null)}
        message={ruleSavedSnack ?? ''}
      />
    </Stack>
  );
}
