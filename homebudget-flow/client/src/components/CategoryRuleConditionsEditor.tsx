import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { CategoryRuleCondition } from '../api/client';
import {
  buildCategoryRuleConditionsForSubmit,
  categoryRuleApiType,
  categoryRuleConditionsToFormState,
  categoryRuleFormHasSubmitPayload,
  defaultCategoryRuleDisplayName,
  describeCategoryRuleCondition,
  type RuleMatchMode,
  type RuleTargetField,
} from '../lib/transactionUi';

export type CategoryRuleConditionsPayload = {
  conditions: CategoryRuleCondition[];
  display_name_override: string | null;
  normalize_dot_space: boolean;
};

type Props = {
  disabled?: boolean;
  /** Steuert Hilfetexte (z. B. Tag-Null vs. Vertragsregeln). */
  context?: 'tag_zero' | 'contract';
  /** Bei Änderung (Laden, Dialog) Formular neu aus initial füllen */
  hydrateKey: string | number;
  initial: CategoryRuleConditionsPayload | null;
  onPayloadChange: (payload: CategoryRuleConditionsPayload | null) => void;
};

export default function CategoryRuleConditionsEditor({
  disabled = false,
  context = 'tag_zero',
  hydrateKey,
  initial,
  onPayloadChange,
}: Props) {
  const onPayloadChangeRef = useRef(onPayloadChange);
  onPayloadChangeRef.current = onPayloadChange;

  const [ruleDirection, setRuleDirection] = useState<'all' | 'credit' | 'debit'>('all');
  const [ruleField, setRuleField] = useState<RuleTargetField>('description');
  const [ruleMode, setRuleMode] = useState<RuleMatchMode>('contains');
  const [rulePattern, setRulePattern] = useState('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [ruleDisplayNameOverride, setRuleDisplayNameOverride] = useState('');
  const [ruleNormalizeDotSpace, setRuleNormalizeDotSpace] = useState(false);

  useEffect(() => {
    const conds = initial?.conditions ?? [];
    const st =
      conds.length > 0
        ? categoryRuleConditionsToFormState(conds)
        : {
            direction: 'all' as const,
            field: 'description' as RuleTargetField,
            mode: 'contains' as RuleMatchMode,
            pattern: '',
            amountMin: '',
            amountMax: '',
          };
    setRuleDirection(st.direction);
    setRuleField(st.field);
    setRuleMode(st.mode);
    setRulePattern(st.pattern);
    setAmountMin(st.amountMin);
    setAmountMax(st.amountMax);
    setRuleDisplayNameOverride((initial?.display_name_override ?? '').slice(0, 512));
    setRuleNormalizeDotSpace(Boolean(initial?.normalize_dot_space));
  }, [hydrateKey, initial]);

  const defaultDisplayNamePreview = useMemo(() => defaultCategoryRuleDisplayName(rulePattern), [rulePattern]);

  const previewConditions = useMemo(() => {
    if (!categoryRuleFormHasSubmitPayload(rulePattern, amountMin, amountMax)) return [];
    return buildCategoryRuleConditionsForSubmit({
      direction: ruleDirection,
      textType: categoryRuleApiType(ruleField, ruleMode),
      pattern: rulePattern,
      amountMin,
      amountMax,
    });
  }, [ruleDirection, ruleField, ruleMode, rulePattern, amountMin, amountMax]);

  useEffect(() => {
    if (!categoryRuleFormHasSubmitPayload(rulePattern, amountMin, amountMax)) {
      onPayloadChangeRef.current(null);
      return;
    }
    const conditions = buildCategoryRuleConditionsForSubmit({
      direction: ruleDirection,
      textType: categoryRuleApiType(ruleField, ruleMode),
      pattern: rulePattern,
      amountMin,
      amountMax,
    });
    const o = ruleDisplayNameOverride.trim();
    onPayloadChangeRef.current({
      conditions,
      display_name_override: o ? o.slice(0, 512) : null,
      normalize_dot_space: ruleNormalizeDotSpace,
    });
  }, [
    ruleDirection,
    ruleField,
    ruleMode,
    rulePattern,
    amountMin,
    amountMax,
    ruleDisplayNameOverride,
    ruleNormalizeDotSpace,
  ]);

  return (
    <Stack spacing={2}>
      <Typography variant="body2" color="text.secondary">
        Gleicher Aufbau wie bei Zuordnungsregeln: Richtung, Textfeld, optional Betragsgrenzen — alle Bedingungen
        müssen zutreffen (UND).
      </Typography>
      <FormControl fullWidth size="small">
        <InputLabel id="crc-dir">Buchungsrichtung</InputLabel>
        <Select
          labelId="crc-dir"
          label="Buchungsrichtung"
          value={ruleDirection}
          disabled={disabled}
          onChange={(e) => setRuleDirection(e.target.value as 'all' | 'credit' | 'debit')}
        >
          <MenuItem value="all">Alle (Einnahmen und Ausgaben)</MenuItem>
          <MenuItem value="credit">Nur Gutschriften (Betrag &gt; 0)</MenuItem>
          <MenuItem value="debit">Nur Lastschriften (Betrag &lt; 0)</MenuItem>
        </Select>
      </FormControl>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <FormControl fullWidth size="small">
          <InputLabel id="crc-field">Feld</InputLabel>
          <Select
            labelId="crc-field"
            label="Feld"
            value={ruleField}
            disabled={disabled}
            onChange={(e) => setRuleField(e.target.value as RuleTargetField)}
          >
            <MenuItem value="description">Verwendungszweck</MenuItem>
            <MenuItem value="counterparty">Gegenpartei</MenuItem>
          </Select>
        </FormControl>
        <FormControl fullWidth size="small">
          <InputLabel id="crc-mode">Vergleich</InputLabel>
          <Select
            labelId="crc-mode"
            label="Vergleich"
            value={ruleMode}
            disabled={disabled}
            onChange={(e) => setRuleMode(e.target.value as RuleMatchMode)}
          >
            <MenuItem value="contains">enthält (Teilstring)</MenuItem>
            <MenuItem value="whole_word">enthält (ganzes Wort)</MenuItem>
            <MenuItem value="equals">ist (exakt)</MenuItem>
          </Select>
        </FormControl>
      </Stack>
      <TextField
        label="Text"
        value={rulePattern}
        disabled={disabled}
        onChange={(e) => setRulePattern(e.target.value.slice(0, 512))}
        fullWidth
        helperText={
          ruleMode === 'contains'
            ? 'Groß-/Kleinschreibung wird ignoriert; es wird ein Teilstring gesucht.'
            : ruleMode === 'whole_word'
              ? 'Groß-/Kleinschreibung wird ignoriert; jedes durch Leerzeichen getrennte Wort muss als eigenes Wort vorkommen.'
              : 'Groß-/Kleinschreibung wird ignoriert; der gesamte Text muss exakt übereinstimmen (nach Trimmen).'
        }
      />
      <TextField
        label="Anzeigename (optional)"
        value={ruleDisplayNameOverride}
        disabled={disabled}
        onChange={(e) => setRuleDisplayNameOverride(e.target.value.slice(0, 512))}
        fullWidth
        size="small"
        helperText={
          ruleDisplayNameOverride.trim()
            ? context === 'contract'
              ? 'Optionaler Anzeigename für diese Vertragsregel.'
              : 'Nur für die Anzeige dieser Tag-Null-Konfiguration (keine Kategorie-Regel).'
            : `Vorgabe: ${defaultDisplayNamePreview || '—'} (Mustertext in Großbuchstaben)`
        }
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={ruleNormalizeDotSpace}
            disabled={disabled}
            onChange={(e) => setRuleNormalizeDotSpace(e.target.checked)}
            size="small"
          />
        }
        label="Punkt/Leerzeichen gleich behandeln"
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField
          label="Betrag min (optional)"
          value={amountMin}
          disabled={disabled}
          onChange={(e) => setAmountMin(e.target.value)}
          size="small"
          fullWidth
          placeholder="z. B. 3000"
          helperText="Untere Grenze inklusive; leer = keine Untergrenze"
        />
        <TextField
          label="Betrag max (optional)"
          value={amountMax}
          disabled={disabled}
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
    </Stack>
  );
}
