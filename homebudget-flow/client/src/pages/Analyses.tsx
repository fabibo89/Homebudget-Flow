import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HTMLAttributes } from 'react';
import {
  Alert,
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Autocomplete,
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Popover,
  Select,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import type { Theme } from '@mui/material/styles';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { ApexOptions } from 'apexcharts';
import Chart from 'react-apexcharts';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  apiErrorMessage,
  fetchAccounts,
  fetchAllTransactions,
  fetchBalanceSnapshots,
  fetchCategories,
  fetchCategoryRules,
  type BalanceSnapshotOut,
  type CategoryOut,
  type CategoryRuleOut,
  type Transaction,
} from '../api/client';
import ExpenseRuleSunburstChart, {
  type ExpenseSunburstDatum,
  type ExpenseSunburstPathFilter,
} from '../components/analyses/ExpenseRuleSunburstChart';
import { buildCategoryNodeByIdMap, resolveCategoryRootAndSub } from '../lib/categoryHierarchy';
import { displayNameClusterForTransaction } from '../lib/categoryRuleMatching';
import { CategorySymbolDisplay } from '../components/CategorySymbol';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';
import { useAccountGroupLabelMap } from '../hooks/useAccountGroupLabelMap';
import { getAppTimeZone, isoDateInAppTimezone, todayIsoInAppTimezone } from '../lib/appTimeZone';
import { sortBankAccountsForDisplay } from '../lib/sortBankAccounts';
import MoneyFlow from './MoneyFlow';
import {
  ANALYSIS_TRANSFER_KIND_KEYS,
  DEFAULT_TRANSFER_KIND_INCLUSION,
  passesAnalysisTransferFilter,
  transferKindLabel,
  type AnalysisTransferKindKey,
} from '../lib/analysisTransferFilter';
import {
  addMonthsToIsoDate,
  collectDescendantCategoryIds,
  findCategoryById,
  flattenCategoriesWithMeta,
  flattenSubcategoryPickOptionsWithMeta,
  formatDate,
  type CategoryFlatOptionWithMeta,
} from '../lib/transactionUi';

function parseIsoDate(s: string): Date {
  return new Date(s.length === 10 ? `${s}T12:00:00` : s);
}

function formatMoneyShort(n: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency || 'EUR',
    maximumFractionDigits: 0,
  }).format(n);
}

function formatMoneyFull(n: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(n);
}

/** Stabiler Key für React-Query / useEffect (Reihenfolge der IDs egal). */
function analysesIncludedAccountsKey(ids: number[] | null): string {
  if (ids === null) return 'all';
  if (ids.length === 0) return 'none';
  return [...ids].sort((a, b) => a - b).join(',');
}

/** `null` = alle Konten mit Zugriff (API ohne bank_account_id); `[]` = nichts gewählt. */
function normalizeIncludedAccountIds(next: Set<number>, allIdsSorted: number[]): number[] | null {
  if (next.size === 0) return [];
  if (next.size === allIdsSorted.length && allIdsSorted.every((id) => next.has(id))) return null;
  return [...next].sort((a, b) => a - b);
}

/** Alle Kalendertage im Intervall [from, to] (inkl.), in App-Zeitzone. */
function enumerateIsoDays(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const start = parseIsoDate(fromIso);
  const end = parseIsoDate(toIso);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(isoDateInAppTimezone(d));
  }
  return out;
}

/** Pro Kalendertag im Intervall [from, to]: Summe der Beträge (fehlende Tage = 0). */
function dailyNetSums(transactions: Transaction[], from: string, to: string): { day: string; sum: number }[] {
  const byDay = new Map<string, number>();
  for (const t of transactions) {
    const day = t.booking_date.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + Number(t.amount));
  }
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  const out: { day: string; sum: number }[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = isoDateInAppTimezone(d);
    out.push({ day: key, sum: byDay.get(key) ?? 0 });
  }
  return out;
}

/** Laufende Summe der Tagesnettos (Index = gleicher Tag wie daily). */
function cumulativeFromDaily(daily: { sum: number }[]): number[] {
  const out: number[] = [];
  let run = 0;
  for (const row of daily) {
    run += row.sum;
    out.push(run);
  }
  return out;
}

function addDays(iso: string, delta: number): string {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + delta);
  return isoDateInAppTimezone(d);
}

/** Buchungs-Historie für Saldorekonstruktion vor „Von“ (Lücke Snapshot → Filterstart). */
const SALDO_TX_LOOKBACK_DAYS = 400;

type CategoryAggregate = {
  key: string;
  categoryId: number | null;
  label: string;
  sum: number;
  count: number;
  /** Erste bekannte effektive Kategoriefarbe aus den Buchungen (API: category_color_hex). */
  colorHex: string | null;
  transactions: Transaction[];
};

/** Buchungen nach Kategorie gruppieren (Summe & Liste). */
function aggregateByCategory(transactions: Transaction[]): CategoryAggregate[] {
  const map = new Map<
    string,
    {
      categoryId: number | null;
      label: string;
      sum: number;
      colorHex: string | null;
      transactions: Transaction[];
    }
  >();

  for (const t of transactions) {
    const id = t.category_id;
    const key = id == null ? '__none__' : `c${id}`;
    const nameFromTx = t.category_name?.trim();
    const txColor = t.category_color_hex?.trim() || null;
    if (!map.has(key)) {
      map.set(key, {
        categoryId: id,
        label:
          id == null ? 'Ohne Kategorie' : nameFromTx || `Kategorie #${id}`,
        sum: 0,
        colorHex: txColor,
        transactions: [],
      });
    }
    const row = map.get(key)!;
    if (id != null && nameFromTx && row.label.startsWith('Kategorie #')) {
      row.label = nameFromTx;
    }
    if (!row.colorHex && txColor) {
      row.colorHex = txColor;
    }
    row.sum += Number(t.amount);
    row.transactions.push(t);
  }

  const out: CategoryAggregate[] = Array.from(map.entries()).map(([key, v]) => ({
    key,
    categoryId: v.categoryId,
    label: v.label,
    sum: v.sum,
    count: v.transactions.length,
    colorHex: v.colorHex,
    transactions: v.transactions,
  }));

  out.sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));
  return out;
}

type DailyExpenseMatrix = {
  days: string[];
  /** Kategorie-Schlüssel (__none__ oder c{id}) → Betrag pro Tag (Länge wie days) */
  byKey: Map<string, number[]>;
};

/** Pro Tag im Intervall: Ausgaben (Absolutbetrag) je Kategorie. */
function buildDailyExpenseMatrix(transactions: Transaction[], from: string, to: string): DailyExpenseMatrix {
  const expenses = transactions.filter((t) => Number(t.amount) < 0);
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  const days: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(isoDateInAppTimezone(d));
  }
  const byKey = new Map<string, number[]>();
  const ensure = (key: string) => {
    if (!byKey.has(key)) {
      byKey.set(key, new Array(days.length).fill(0));
    }
    return byKey.get(key)!;
  };
  for (const t of expenses) {
    const dayStr = t.booking_date.slice(0, 10);
    const di = days.indexOf(dayStr);
    if (di < 0) continue;
    const id = t.category_id;
    const key = id == null ? '__none__' : `c${id}`;
    ensure(key)[di] += Math.abs(Number(t.amount));
  }
  return { days, byKey };
}

/** Ausgaben nach beliebigem Schlüssel (z. B. Anzeigename-Cluster) pro Kalendertag aggregieren. */
function buildDailyExpenseMatrixClustered(
  transactions: Transaction[],
  from: string,
  to: string,
  clusterKeyFor: (t: Transaction) => string | null,
): DailyExpenseMatrix {
  const expenses = transactions.filter((t) => Number(t.amount) < 0);
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  const days: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(isoDateInAppTimezone(d));
  }
  const byKey = new Map<string, number[]>();
  const ensure = (key: string) => {
    if (!byKey.has(key)) {
      byKey.set(key, new Array(days.length).fill(0));
    }
    return byKey.get(key)!;
  };
  for (const t of expenses) {
    const ck = clusterKeyFor(t);
    if (ck == null) continue;
    const dayStr = t.booking_date.slice(0, 10);
    const di = days.indexOf(dayStr);
    if (di < 0) continue;
    ensure(ck)[di] += Math.abs(Number(t.amount));
  }
  return { days, byKey };
}

function regelClusterLabelForKey(clusterKey: string): string {
  if (clusterKey === '__no_rule__') return 'Ohne passende Regel';
  if (clusterKey === '__none__') return 'Ohne Kategorie';
  if (clusterKey.startsWith('dn:')) return clusterKey.slice(3);
  return clusterKey;
}

function RegelClusterSubcategoryRow({ o }: { o: CategoryFlatOptionWithMeta }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0, py: 0.25 }}>
      <Box
        sx={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          bgcolor: o.effective_color_hex,
          flexShrink: 0,
          border: 1,
          borderColor: 'divider',
        }}
      />
      <CategorySymbolDisplay value={o.icon_emoji} fontSize="1.1rem" />
      <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>
        {o.label}
      </Typography>
    </Stack>
  );
}

type VerlaufBucket = 'day' | 'week' | 'month';

type VerlaufPeriodMatrix = {
  periodLabels: string[];
  byKey: Map<string, number[]>;
  /** Kalendertage (ISO) pro Periode, die im Filter zur Aggregation zählen */
  periodDays: string[][];
};

/** Montag der ISO-Woche, die den Kalendertag enthält (lokales Datum). */
function mondayOfIsoWeek(isoDay: string): string {
  const d = parseIsoDate(isoDay);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return isoDateInAppTimezone(d);
}

function formatWeekRangeLabel(weekMondayIso: string): string {
  const start = parseIsoDate(weekMondayIso);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const tz = getAppTimeZone();
  const short = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', timeZone: tz });
  const endLong = new Intl.DateTimeFormat('de-DE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: tz,
  });
  return `${short.format(start)}–${endLong.format(end)}`;
}

function formatMonthBucketLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  return new Intl.DateTimeFormat('de-DE', {
    month: 'long',
    year: 'numeric',
    timeZone: getAppTimeZone(),
  }).format(new Date(`${y}-${String(m).padStart(2, '0')}-01T12:00:00Z`));
}

/** Tageswerte zu Wochen- oder Monatssummen zusammenfassen (Reihenfolge = erster Vorkommenstag im Filter). */
function rollupVerlaufFromDaily(daily: DailyExpenseMatrix, bucket: VerlaufBucket): VerlaufPeriodMatrix {
  const { days, byKey } = daily;
  if (bucket === 'day' || days.length === 0) {
    const tz = getAppTimeZone();
    const periodLabels = days.map((d) =>
      new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', timeZone: tz }).format(
        parseIsoDate(d),
      ),
    );
    const periodDays = days.map((d) => [d]);
    return {
      periodLabels,
      byKey: new Map([...byKey].map(([k, arr]) => [k, [...arr]])),
      periodDays,
    };
  }

  const periodIds: string[] = [];
  const periodIdToIndex = new Map<string, number>();
  const dayToPeriodIndex: number[] = [];

  for (const dayIso of days) {
    const pid =
      bucket === 'week' ? `w:${mondayOfIsoWeek(dayIso)}` : `m:${dayIso.slice(0, 7)}`;
    let idx = periodIdToIndex.get(pid);
    if (idx === undefined) {
      idx = periodIds.length;
      periodIdToIndex.set(pid, idx);
      periodIds.push(pid);
    }
    dayToPeriodIndex.push(idx);
  }

  const periodLabels = periodIds.map((pid) => {
    if (pid.startsWith('w:')) return formatWeekRangeLabel(pid.slice(2));
    return formatMonthBucketLabel(pid.slice(2));
  });

  const periodDays: string[][] = periodIds.map(() => []);
  for (let i = 0; i < days.length; i++) {
    periodDays[dayToPeriodIndex[i]].push(days[i]);
  }

  const newByKey = new Map<string, number[]>();
  for (const [catKey, dayValues] of byKey) {
    const agg = new Array(periodIds.length).fill(0);
    for (let i = 0; i < dayValues.length; i++) {
      agg[dayToPeriodIndex[i]] += dayValues[i];
    }
    newByKey.set(catKey, agg);
  }

  return { periodLabels, byKey: newByKey, periodDays };
}

function totalSpendForKey(matrix: DailyExpenseMatrix, key: string): number {
  const arr = matrix.byKey.get(key);
  if (!arr) return 0;
  return arr.reduce((a, b) => a + b, 0);
}

function verlaufLabelForKey(
  key: string,
  options: { key: string; label: string }[],
  expenseAggs: CategoryAggregate[],
): string {
  const opt = options.find((o) => o.key === key);
  if (opt) return opt.label;
  const agg = expenseAggs.find((a) => a.key === key);
  if (agg) return agg.label;
  if (key === '__none__') return 'Ohne Kategorie';
  return key;
}

type VerlaufCategoryOption = {
  key: string;
  label: string;
  colorHex: string;
  iconEmoji: string | null;
};

function resolveVerlaufColorHex(
  key: string,
  expenseAggs: CategoryAggregate[],
  uncategorizedColor: string,
  piePalette: string[],
  si: number,
): string {
  if (key === '__none__') return uncategorizedColor;
  const m = /^c(\d+)$/.exec(key);
  if (m) {
    const id = Number(m[1]);
    const agg = expenseAggs.find((a) => a.categoryId === id);
    if (agg?.colorHex) return agg.colorHex;
  }
  return piePalette[si % piePalette.length];
}

function resolveVerlaufOption(
  key: string,
  baseOptions: VerlaufCategoryOption[],
  expenseAggs: CategoryAggregate[],
  uncategorizedColor: string,
  piePalette: string[],
  fallbackIndex: number,
): VerlaufCategoryOption {
  const hit = baseOptions.find((o) => o.key === key);
  if (hit) return hit;
  return {
    key,
    label: verlaufLabelForKey(key, baseOptions, expenseAggs),
    colorHex: resolveVerlaufColorHex(key, expenseAggs, uncategorizedColor, piePalette, fallbackIndex),
    iconEmoji: null,
  };
}

/** Alle Kategorie-Schlüssel im Teilbaum (Wurzel inkl.). */
function collectSubtreeKeys(node: CategoryOut): string[] {
  const keys = [`c${node.id}`];
  for (const ch of node.children ?? []) keys.push(...collectSubtreeKeys(ch));
  return keys;
}

type VerlaufPickOption =
  | { rowKind: 'none'; option: VerlaufCategoryOption }
  | { rowKind: 'parent'; option: VerlaufCategoryOption; subtreeKeys: string[] }
  | { rowKind: 'leaf'; option: VerlaufCategoryOption };

function verlaufPickRowListKey(row: VerlaufPickOption): string {
  if (row.rowKind === 'none') return '__none__';
  if (row.rowKind === 'parent') return `__parent__:${row.option.key}`;
  return row.option.key;
}

function walkCategoryPickChildren(rows: VerlaufPickOption[], node: CategoryOut, pathPrefix: string) {
  const label = pathPrefix ? `${pathPrefix} › ${node.name}` : node.name;
  const children = node.children ?? [];
  if (children.length === 0) {
    rows.push({
      rowKind: 'leaf',
      option: {
        key: `c${node.id}`,
        label,
        colorHex: node.effective_color_hex,
        iconEmoji: node.icon_emoji,
      },
    });
    return;
  }
  rows.push({
    rowKind: 'parent',
    option: {
      key: `c${node.id}`,
      label,
      colorHex: node.effective_color_hex,
      iconEmoji: node.icon_emoji,
    },
    subtreeKeys: collectSubtreeKeys(node),
  });
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  for (const ch of sorted) {
    walkCategoryPickChildren(rows, ch, label);
  }
}

function buildVerlaufPickOptions(roots: CategoryOut[], noneOption: VerlaufCategoryOption): VerlaufPickOption[] {
  const rows: VerlaufPickOption[] = [{ rowKind: 'none', option: noneOption }];
  const sortedRoots = [...roots].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  for (const root of sortedRoots) {
    const children = root.children ?? [];
    if (children.length === 0) {
      rows.push({
        rowKind: 'leaf',
        option: {
          key: `c${root.id}`,
          label: root.name,
          colorHex: root.effective_color_hex,
          iconEmoji: root.icon_emoji,
        },
      });
      continue;
    }
    rows.push({
      rowKind: 'parent',
      option: {
        key: `c${root.id}`,
        label: root.name,
        colorHex: root.effective_color_hex,
        iconEmoji: root.icon_emoji,
      },
      subtreeKeys: collectSubtreeKeys(root),
    });
    const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const ch of sorted) {
      walkCategoryPickChildren(rows, ch, root.name);
    }
  }
  return rows;
}

function sumSunburstDatumSubtree(node: ExpenseSunburstDatum): number {
  if (typeof node.value === 'number' && Number.isFinite(node.value)) return node.value;
  const ch = node.children;
  if (!ch?.length) return 0;
  return ch.reduce((s, c) => s + sumSunburstDatumSubtree(c), 0);
}

/** Daten für ECharts-Sunburst: Wurzel „Ausgaben“ → Hauptkategorie → Unterkategorie → Regel-Anzeigename. */
function buildExpenseRuleSunburstSeries(
  expenseTxs: Transaction[],
  nodeById: Map<number, CategoryOut>,
  rulesSorted: CategoryRuleOut[],
  rootColorByName: Map<string, string>,
  piePalette: string[],
): ExpenseSunburstDatum[] {
  type L3 = Map<string, number>;
  type L2 = Map<string, L3>;
  const l1 = new Map<string, L2>();

  for (const t of expenseTxs) {
    const amt = Number(t.amount);
    if (!Number.isFinite(amt) || amt >= 0) continue;
    const abs = Math.abs(amt);
    const { root, sub } = resolveCategoryRootAndSub(t.category_id, nodeById);
    const { label: ruleLabel } = displayNameClusterForTransaction(t, rulesSorted);
    if (!l1.has(root)) l1.set(root, new Map());
    const l2 = l1.get(root)!;
    if (!l2.has(sub)) l2.set(sub, new Map());
    const l3 = l2.get(sub)!;
    l3.set(ruleLabel, (l3.get(ruleLabel) ?? 0) + abs);
  }

  let rootIdx = 0;
  const roots: ExpenseSunburstDatum[] = [];
  for (const [rootName, l2] of l1) {
    const color = rootColorByName.get(rootName) ?? piePalette[rootIdx % piePalette.length];
    rootIdx += 1;
    const subs: ExpenseSunburstDatum[] = [];
    for (const [subName, l3] of l2) {
      const leaves: ExpenseSunburstDatum[] = [];
      for (const [ruleName, value] of l3) {
        leaves.push({
          name: ruleName,
          value,
          pathFilter: { depth: 3, root: rootName, sub: subName, rule: ruleName },
        });
      }
      leaves.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
      subs.push({
        name: subName,
        pathFilter: { depth: 2, root: rootName, sub: subName },
        children: leaves,
      });
    }
    subs.sort((a, b) => sumSunburstDatumSubtree(b) - sumSunburstDatumSubtree(a));
    roots.push({
      name: rootName,
      pathFilter: { depth: 1, root: rootName },
      itemStyle: { color },
      children: subs,
    });
  }
  roots.sort((a, b) => sumSunburstDatumSubtree(b) - sumSunburstDatumSubtree(a));

  return [
    {
      name: 'Ausgaben',
      children: roots,
    },
  ];
}

type AnalysisTab =
  | 'tagesbilanz'
  | 'kategorien'
  | 'kategorieverlauf'
  | 'regelcluster'
  | 'ausgaben_sunburst'
  | 'geldfluss';

type CategorySliceSelection = { flow: 'income' | 'expense'; categoryKey: string };

function createCategoryDonutConfig(
  aggs: CategoryAggregate[],
  flow: 'income' | 'expense',
  theme: Theme,
  defaultCurrency: string,
  piePalette: string[],
  onSelectKey: (key: string) => void,
): { options: ApexOptions; series: number[] } {
  const labels = aggs.map((a) => a.label);
  const series = aggs.map((a) => {
    const v = flow === 'income' ? a.sum : Math.abs(a.sum);
    return v < 1e-9 && a.count > 0 ? 1e-6 : Math.max(v, 1e-9);
  });

  const sumTotal = aggs.reduce((s, a) => s + a.sum, 0);
  const uncategorizedSliceColor =
    theme.palette.mode === 'dark' ? theme.palette.grey[600] : theme.palette.grey[500];

  const options: ApexOptions = {
    chart: {
      type: 'donut',
      foreColor: theme.palette.text.secondary,
      background: 'transparent',
      fontFamily: theme.typography.fontFamily,
      events: {
        dataPointSelection: (_e, _chart, opts) => {
          const i = opts?.dataPointIndex;
          if (typeof i !== 'number' || i < 0) return;
          const agg = aggs[i];
          if (agg) onSelectKey(agg.key);
        },
        click: (_e, _chart, opts) => {
          const i = opts?.dataPointIndex;
          if (typeof i !== 'number' || i < 0) return;
          const agg = aggs[i];
          if (agg) onSelectKey(agg.key);
        },
      },
    },
    labels,
    colors: aggs.map((a, i) => {
      if (a.colorHex) return a.colorHex;
      if (a.categoryId == null) return uncategorizedSliceColor;
      return piePalette[i % piePalette.length];
    }),
    plotOptions: {
      pie: {
        donut: {
          size: '58%',
          labels: {
            show: true,
            name: { show: true },
            value: {
              show: true,
              formatter: (val: string | number) => formatMoneyShort(Number(val), defaultCurrency),
            },
            total: {
              show: true,
              label: flow === 'income' ? 'Summe Einnahmen' : 'Summe Ausgaben',
              formatter: () => formatMoneyShort(sumTotal, defaultCurrency),
            },
          },
        },
      },
    },
    stroke: {
      width: 1,
      colors: [theme.palette.divider],
    },
    dataLabels: {
      enabled: true,
      formatter: (_val, opts) => {
        const i = opts?.seriesIndex;
        if (typeof i !== 'number') return '';
        const a = aggs[i];
        if (!a) return '';
        return formatMoneyShort(a.sum, defaultCurrency);
      },
      style: { fontSize: '11px' },
    },
    legend: {
      position: 'bottom',
      fontSize: '12px',
      formatter: (legendName, opts) => {
        const i = opts?.seriesIndex;
        if (typeof i !== 'number') return legendName;
        const a = aggs[i];
        if (!a) return legendName;
        return `${legendName} (${formatMoneyFull(a.sum, defaultCurrency)})`;
      },
    },
    tooltip: {
      theme: theme.palette.mode,
      y: {
        formatter: (_val, opts) => {
          const i = opts?.seriesIndex;
          if (typeof i !== 'number') return '';
          const a = aggs[i];
          if (!a) return '';
          return `${formatMoneyFull(a.sum, defaultCurrency)} · ${a.count} Buchung(en)`;
        },
      },
    },
  };

  return { options, series };
}

export default function Analyses() {
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));
  const [tab, setTab] = useState<AnalysisTab>('tagesbilanz');
  const today = useMemo(() => todayIsoInAppTimezone(), []);
  const defaultFrom = useMemo(() => addDays(today, -30), [today]);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  /** `null` = alle Konten mit Zugriff; sonst explizite Mehrfachauswahl (Reihenfolge egal). */
  const [includedAccountIds, setIncludedAccountIds] = useState<number[] | null>(null);
  const [accountFilterAnchor, setAccountFilterAnchor] = useState<HTMLElement | null>(null);
  const [transferFilterAnchor, setTransferFilterAnchor] = useState<HTMLElement | null>(null);
  const [transferKindInclusion, setTransferKindInclusion] = useState<
    Record<AnalysisTransferKindKey, boolean>
  >(() => ({ ...DEFAULT_TRANSFER_KIND_INCLUSION }));
  const [selectedBarDay, setSelectedBarDay] = useState<string | null>(null);
  const [selectedCategorySlice, setSelectedCategorySlice] = useState<CategorySliceSelection | null>(null);
  const [verlaufSelectedKeys, setVerlaufSelectedKeys] = useState<string[]>([]);
  /** Tortendiagramme „Kategorien“: gleiche Schlüssel wie Kategorieverlauf (`__none__`, `c{id}`). */
  const [kategorienSelectedKeys, setKategorienSelectedKeys] = useState<string[]>([]);
  const [verlaufBucket, setVerlaufBucket] = useState<VerlaufBucket>('week');
  const [verlaufSelectedPeriodIndex, setVerlaufSelectedPeriodIndex] = useState<number | null>(null);
  const [regelClusterSubcategoryId, setRegelClusterSubcategoryId] = useState<number | null>(null);
  const [regelClusterBucket, setRegelClusterBucket] = useState<VerlaufBucket>('week');
  const [regelClusterPeriodIndex, setRegelClusterPeriodIndex] = useState<number | null>(null);
  /** Klick auf Balkendiagramm: Cluster-Schlüssel (`dn:…` / `__no_rule__` …) für Buchungsliste. */
  const [regelClusterBarClusterKey, setRegelClusterBarClusterKey] = useState<string | null>(null);
  /** Sunburst Ausgaben: gewähltes Segment (Kategorie / Unterkategorie / Regel). */
  const [expenseSunburstSelection, setExpenseSunburstSelection] = useState<ExpenseSunburstPathFilter | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const { groupLabelById, householdWithGroups } = useAccountGroupLabelMap();

  const rangeOk = from <= to;
  const includedAccountsQueryKey = analysesIncludedAccountsKey(includedAccountIds);
  const singleAccountForApi =
    includedAccountIds !== null && includedAccountIds.length === 1 ? includedAccountIds[0] : undefined;
  /** Nur Tagesbilanz: früheres „from“ für API, damit virtuelle Salden Buchungen vor dem Filter-Zeitraum einrechnen. */
  const saldoTxFrom = useMemo(
    () => (tab === 'tagesbilanz' ? addDays(from, -SALDO_TX_LOOKBACK_DAYS) : from),
    [tab, from],
  );
  const txQuery = useQuery({
    queryKey: ['analyses-transactions', saldoTxFrom, to, includedAccountsQueryKey, tab],
    queryFn: () =>
      fetchAllTransactions({
        from: saldoTxFrom || undefined,
        to: to || undefined,
        bank_account_id: singleAccountForApi,
      }),
    enabled:
      rangeOk &&
      (tab === 'tagesbilanz' ||
        tab === 'kategorien' ||
        tab === 'kategorieverlauf' ||
        tab === 'regelcluster' ||
        tab === 'ausgaben_sunburst') &&
      (includedAccountIds === null || includedAccountIds.length > 0),
  });

  useEffect(() => {
    setSelectedBarDay(null);
    setSelectedCategorySlice(null);
    setVerlaufSelectedPeriodIndex(null);
    setRegelClusterPeriodIndex(null);
    setRegelClusterBarClusterKey(null);
    setExpenseSunburstSelection(null);
  }, [from, to, includedAccountsQueryKey, verlaufBucket, regelClusterBucket]);

  useEffect(() => {
    setRegelClusterBarClusterKey(null);
    setRegelClusterPeriodIndex(null);
  }, [regelClusterSubcategoryId]);

  function handleTabChange(_: unknown, v: AnalysisTab) {
    setTab(v);
    setSelectedBarDay(null);
    setSelectedCategorySlice(null);
    setVerlaufSelectedPeriodIndex(null);
    setRegelClusterPeriodIndex(null);
    setRegelClusterBarClusterKey(null);
    setExpenseSunburstSelection(null);
  }

  const accounts = useMemo(
    () => sortBankAccountsForDisplay(accountsQuery.data ?? [], groupLabelById),
    [accountsQuery.data, groupLabelById],
  );

  const allAccountIdsSorted = useMemo(
    () => accounts.map((a) => a.id).sort((a, b) => a - b),
    [accounts],
  );

  /** Konten für Saldo-DB-Verlauf (wie Transaktionsfilter: alle / explizite Auswahl). */
  const saldoSnapshotAccountIds = useMemo(() => {
    if (includedAccountIds !== null && includedAccountIds.length === 0) return [];
    if (includedAccountIds === null) return allAccountIdsSorted;
    return [...includedAccountIds].sort((a, b) => a - b);
  }, [includedAccountIds, allAccountIdsSorted]);

  const saldoSnapshotQueries = useQueries({
    queries: saldoSnapshotAccountIds.map((id) => ({
      queryKey: ['balance-snapshots', 'analyses', id, includedAccountsQueryKey] as const,
      queryFn: () => fetchBalanceSnapshots(id, 500),
      enabled:
        tab === 'tagesbilanz' &&
        rangeOk &&
        saldoSnapshotAccountIds.length > 0 &&
        (includedAccountIds === null || includedAccountIds.length > 0),
    })),
  });

  const includedSet = useMemo(() => {
    if (includedAccountIds === null) return new Set(allAccountIdsSorted);
    return new Set(includedAccountIds);
  }, [includedAccountIds, allAccountIdsSorted]);

  const scopedTransactions = useMemo(() => {
    if (includedAccountIds !== null && includedAccountIds.length === 0) return [];
    const raw = txQuery.data ?? [];
    let rows = includedAccountIds === null ? raw : raw.filter((t) => includedSet.has(t.bank_account_id));
    rows = rows.filter((t) => {
      const d = t.booking_date.slice(0, 10);
      return d >= from && d <= to;
    });
    return rows;
  }, [txQuery.data, includedAccountIds, includedSet, from, to]);

  /** Wie API-Antwort, nur Kontenfilter — für Saldo-Tageswalk inkl. Lookback vor „Von“. */
  const transactionsForSaldoWalk = useMemo(() => {
    if (includedAccountIds !== null && includedAccountIds.length === 0) return [];
    const raw = txQuery.data ?? [];
    if (includedAccountIds === null) return raw;
    return raw.filter((t) => includedSet.has(t.bank_account_id));
  }, [txQuery.data, includedAccountIds, includedSet]);

  /** Buchungen für Diagramme/Listen: Konten + Zeitraum + optional Umbuchungsarten ausgeschlossen. */
  const analysisTransactions = useMemo(
    () => scopedTransactions.filter((t) => passesAnalysisTransferFilter(t, transferKindInclusion)),
    [scopedTransactions, transferKindInclusion],
  );

  const transferFilterSummary = useMemo(() => {
    const off = ANALYSIS_TRANSFER_KIND_KEYS.filter((k) => !transferKindInclusion[k]);
    if (off.length === 0) return 'Umbuchungen (alle)';
    return `Umbuchungen (${off.length} ausgeschlossen)`;
  }, [transferKindInclusion]);

  const applyIncludedSet = useCallback(
    (next: Set<number>) => {
      setIncludedAccountIds(normalizeIncludedAccountIds(next, allAccountIdsSorted));
    },
    [allAccountIdsSorted],
  );

  const accountFilterSummary = useMemo(() => {
    if (!accounts.length) return 'Konten';
    if (includedAccountIds === null) return 'Alle meine Konten';
    if (includedAccountIds.length === 0) return 'Kein Konto';
    if (includedAccountIds.length === 1) {
      const a = accounts.find((x) => x.id === includedAccountIds[0]);
      return a?.name ?? '1 Konto';
    }
    return `${includedAccountIds.length} Konten`;
  }, [accounts, includedAccountIds]);

  const defaultCurrency = accounts[0]?.currency ?? 'EUR';

  const daily = useMemo(
    () => dailyNetSums(analysisTransactions, from, to),
    [analysisTransactions, from, to],
  );

  const cumulative = useMemo(() => cumulativeFromDaily(daily), [daily]);

  /** Gemeinsame X-Achse für Tagesbilanz-Balken und Saldoverlauf (ein Slot pro Kalendertag im Filter [von, bis]). */
  const tagesbilanzAxisLabels = useMemo(() => {
    const tz = getAppTimeZone();
    return daily.map((row) =>
      new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', timeZone: tz }).format(
        parseIsoDate(row.day),
      ),
    );
  }, [daily]);

  const tagesbilanzXAxisShared = useMemo(() => {
    const n = tagesbilanzAxisLabels.length;
    return {
      type: 'category' as const,
      categories: tagesbilanzAxisLabels,
      tickAmount: Math.min(12, Math.max(4, Math.floor(n / 14))),
      labels: {
        rotate: -45,
        rotateAlways: n > 14,
        style: { fontSize: '11px' },
      },
      title: { text: 'Buchungstag' },
    };
  }, [tagesbilanzAxisLabels]);

  const categoryAggsIncome = useMemo(() => {
    if (!analysisTransactions.length) return [];
    return aggregateByCategory(analysisTransactions.filter((t) => Number(t.amount) > 0));
  }, [analysisTransactions]);

  const categoryAggsExpense = useMemo(() => {
    if (!analysisTransactions.length) return [];
    return aggregateByCategory(analysisTransactions.filter((t) => Number(t.amount) < 0));
  }, [analysisTransactions]);

  const allPieCategoryKeysSorted = useMemo(() => {
    const s = new Set<string>();
    for (const a of categoryAggsIncome) s.add(a.key);
    for (const a of categoryAggsExpense) s.add(a.key);
    return [...s].sort();
  }, [categoryAggsIncome, categoryAggsExpense]);

  const pieCategoryKeysSignature = allPieCategoryKeysSorted.join('\n');

  useEffect(() => {
    if (tab !== 'kategorien') return;
    setKategorienSelectedKeys(pieCategoryKeysSignature ? pieCategoryKeysSignature.split('\n') : []);
  }, [tab, from, to, includedAccountsQueryKey, pieCategoryKeysSignature]);

  const categoryAggsIncomeFiltered = useMemo(() => {
    if (kategorienSelectedKeys.length === 0) return [];
    const set = new Set(kategorienSelectedKeys);
    return categoryAggsIncome.filter((a) => set.has(a.key));
  }, [categoryAggsIncome, kategorienSelectedKeys]);

  const categoryAggsExpenseFiltered = useMemo(() => {
    if (kategorienSelectedKeys.length === 0) return [];
    const set = new Set(kategorienSelectedKeys);
    return categoryAggsExpense.filter((a) => set.has(a.key));
  }, [categoryAggsExpense, kategorienSelectedKeys]);

  const dailyExpenseMatrix = useMemo(
    () =>
      analysisTransactions.length
        ? buildDailyExpenseMatrix(analysisTransactions, from, to)
        : { days: [] as string[], byKey: new Map<string, number[]>() },
    [analysisTransactions, from, to],
  );

  const keysWithSpendInVerlauf = useMemo(() => {
    const keys: string[] = [];
    for (const [k, arr] of dailyExpenseMatrix.byKey) {
      if (arr.some((v) => v > 0)) keys.push(k);
    }
    keys.sort();
    return keys;
  }, [dailyExpenseMatrix]);

  const verlaufPeriodMatrix = useMemo(
    () => rollupVerlaufFromDaily(dailyExpenseMatrix, verlaufBucket),
    [dailyExpenseMatrix, verlaufBucket],
  );

  const keysWithSpendSignature = keysWithSpendInVerlauf.join('\n');

  useEffect(() => {
    setVerlaufSelectedKeys(
      keysWithSpendSignature ? keysWithSpendSignature.split('\n') : [],
    );
  }, [from, to, includedAccountsQueryKey, keysWithSpendSignature]);

  const householdIdsForCategories = useMemo(() => {
    const s = new Set<number>();
    for (const a of accounts) s.add(a.household_id);
    return [...s].sort((a, b) => a - b);
  }, [accounts]);

  const categoryQueries = useQueries({
    queries: householdIdsForCategories.map((hid) => ({
      queryKey: ['categories', hid],
      queryFn: () => fetchCategories(hid),
      enabled:
        rangeOk &&
        (tab === 'kategorien' ||
          tab === 'kategorieverlauf' ||
          tab === 'regelcluster' ||
          tab === 'ausgaben_sunburst') &&
        householdIdsForCategories.length > 0,
    })),
  });

  const rulesQueries = useQueries({
    queries: householdIdsForCategories.map((hid) => ({
      queryKey: ['category-rules', hid],
      queryFn: () => fetchCategoryRules(hid),
      enabled:
        rangeOk &&
        (tab === 'regelcluster' || tab === 'ausgaben_sunburst') &&
        householdIdsForCategories.length > 0,
    })),
  });

  const verlaufSortedSelectedKeys = useMemo(() => {
    const keys = [...verlaufSelectedKeys];
    keys.sort(
      (a, b) => totalSpendForKey(dailyExpenseMatrix, b) - totalSpendForKey(dailyExpenseMatrix, a),
    );
    return keys;
  }, [verlaufSelectedKeys, dailyExpenseMatrix]);

  const verlaufXAxisTitle =
    verlaufBucket === 'day' ? 'Tag' : verlaufBucket === 'week' ? 'Kalenderwoche (Mo–So im Filter)' : 'Monat';

  const transactionsForSelectedVerlaufPeriod = useMemo(() => {
    const all = analysisTransactions;
    if (verlaufSelectedPeriodIndex == null) return [];
    const daysIn = verlaufPeriodMatrix.periodDays[verlaufSelectedPeriodIndex];
    if (!daysIn?.length) return [];
    const daySet = new Set(daysIn);
    return all
      .filter((t) => Number(t.amount) < 0 && daySet.has(t.booking_date.slice(0, 10)))
      .slice()
      .sort((a, b) => b.id - a.id);
  }, [analysisTransactions, verlaufSelectedPeriodIndex, verlaufPeriodMatrix.periodDays]);

  const verlaufSelectedPeriodTitle = useMemo(() => {
    if (verlaufSelectedPeriodIndex == null) return '';
    const label = verlaufPeriodMatrix.periodLabels[verlaufSelectedPeriodIndex] ?? '';
    const raster =
      verlaufBucket === 'day' ? 'Tag' : verlaufBucket === 'week' ? 'Woche' : 'Monat';
    return `${raster} · ${label}`;
  }, [verlaufSelectedPeriodIndex, verlaufPeriodMatrix.periodLabels, verlaufBucket]);

  const transactionsForSelectedDay = useMemo(() => {
    const all = analysisTransactions;
    if (!all || !selectedBarDay) return [];
    return all
      .filter((t) => t.booking_date.slice(0, 10) === selectedBarDay)
      .slice()
      .sort((a, b) => b.id - a.id);
  }, [analysisTransactions, selectedBarDay]);

  const transactionsForSelectedCategory = useMemo(() => {
    if (!selectedCategorySlice) return [];
    const aggs = selectedCategorySlice.flow === 'income' ? categoryAggsIncome : categoryAggsExpense;
    const agg = aggs.find((a) => a.key === selectedCategorySlice.categoryKey);
    if (!agg) return [];
    return agg.transactions.slice().sort((a, b) => b.id - a.id);
  }, [categoryAggsIncome, categoryAggsExpense, selectedCategorySlice]);

  const selectedCategoryTitle = useMemo(() => {
    if (!selectedCategorySlice) return '';
    const aggs = selectedCategorySlice.flow === 'income' ? categoryAggsIncome : categoryAggsExpense;
    const label = aggs.find((a) => a.key === selectedCategorySlice.categoryKey)?.label ?? '';
    const kind = selectedCategorySlice.flow === 'income' ? 'Einnahmen' : 'Ausgaben';
    return `${kind} · ${label}`;
  }, [categoryAggsIncome, categoryAggsExpense, selectedCategorySlice]);

  const posColor = theme.palette.success.main;
  const negColor = theme.palette.error.main;

  const { chartOptions, series } = useMemo(() => {
    const rangeData = daily.map((_, i) => {
      const prev = i === 0 ? 0 : cumulative[i - 1];
      const curr = cumulative[i];
      const low = Math.min(prev, curr);
      const high = Math.max(prev, curr);
      return {
        x: tagesbilanzAxisLabels[i],
        y: [low, high] as [number, number],
      };
    });

    const barColors = daily.map((d) => (d.sum >= 0 ? posColor : negColor));

    const options: ApexOptions = {
      chart: {
        type: 'rangeBar',
        toolbar: { show: true },
        zoom: { enabled: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
        events: {
          click: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0) return;
            const row = daily[i];
            if (row) setSelectedBarDay(row.day);
          },
          dataPointSelection: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0) return;
            const row = daily[i];
            if (row) setSelectedBarDay(row.day);
          },
        },
      },
      plotOptions: {
        bar: {
          horizontal: false,
          distributed: true,
          borderRadius: 2,
          columnWidth: '75%',
          dataLabels: { position: 'top' },
        },
      },
      colors: barColors,
      dataLabels: {
        enabled: false,
      },
      stroke: { width: 1, colors: [theme.palette.divider] },
      grid: {
        borderColor: theme.palette.divider,
        strokeDashArray: 4,
      },
      xaxis: {
        ...tagesbilanzXAxisShared,
      },
      yaxis: {
        title: { text: 'Kumulierte Tagesbilanz' },
        labels: {
          formatter: (val) => formatMoneyShort(Number(val), defaultCurrency),
        },
      },
      tooltip: {
        theme: theme.palette.mode,
        custom: ({ dataPointIndex }) => {
          const row = daily[dataPointIndex];
          if (!row) return '';
          const prev = dataPointIndex === 0 ? 0 : cumulative[dataPointIndex - 1];
          const curr = cumulative[dataPointIndex];
          const dateStr = new Intl.DateTimeFormat('de-DE', {
            weekday: 'short',
            day: '2-digit',
            month: 'long',
            year: 'numeric',
            timeZone: getAppTimeZone(),
          }).format(parseIsoDate(row.day));
          const deltaStr = formatMoneyFull(row.sum, defaultCurrency);
          const prevStr = formatMoneyFull(prev, defaultCurrency);
          const currStr = formatMoneyFull(curr, defaultCurrency);
          const deltaLabel = row.sum >= 0 ? 'Tagesplus' : 'Tagesminus';
          const bg = theme.palette.mode === 'dark' ? '#1e1e1e' : '#fff';
          const fg = theme.palette.text.primary;
          const sub = theme.palette.text.secondary;
          return (
            '<div style="padding:10px 12px;font-family:inherit;background:' +
            bg +
            ';color:' +
            fg +
            ';max-width:280px">' +
            '<div style="font-weight:600;margin-bottom:6px">' +
            dateStr +
            '</div>' +
            '<div style="font-size:12px;color:' +
            sub +
            '">Stand vorher → nachher</div>' +
            '<div style="margin:4px 0">' +
            prevStr +
            ' → <strong>' +
            currStr +
            '</strong></div>' +
            '<div style="font-size:12px;color:' +
            sub +
            ';margin-top:6px">' +
            deltaLabel +
            ': ' +
            deltaStr +
            '</div>' +
            '</div>'
          );
        },
      },
      legend: { show: false },
    };

    return {
      chartOptions: options,
      series: [{ name: 'Kumuliert', data: rangeData }],
    };
  }, [daily, cumulative, theme, defaultCurrency, posColor, negColor, tagesbilanzAxisLabels, tagesbilanzXAxisShared]);

  /** Pro Kalendertag: End-of-Day-Summe; `db` = mind. ein Saldo-Snapshot an dem Tag, sonst aus Buchungen fortgeführt. */
  const saldoVerlaufDaily = useMemo(() => {
    const merged: BalanceSnapshotOut[] = [];
    for (const q of saldoSnapshotQueries) {
      if (q.data?.length) merged.push(...q.data);
    }
    merged.sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());

    const balances = new Map<number, number>();
    for (const s of merged) {
      const day = isoDateInAppTimezone(new Date(s.recorded_at));
      if (day >= saldoTxFrom) break;
      if (!saldoSnapshotAccountIds.includes(s.bank_account_id)) continue;
      balances.set(s.bank_account_id, Number(s.balance));
    }

    const txsByDay = new Map<string, Transaction[]>();
    for (const t of transactionsForSaldoWalk) {
      if (!saldoSnapshotAccountIds.includes(t.bank_account_id)) continue;
      const d = t.booking_date.slice(0, 10);
      if (!txsByDay.has(d)) txsByDay.set(d, []);
      txsByDay.get(d)!.push(t);
    }

    const snapsByDay = new Map<string, BalanceSnapshotOut[]>();
    for (const s of merged) {
      if (!saldoSnapshotAccountIds.includes(s.bank_account_id)) continue;
      const day = isoDateInAppTimezone(new Date(s.recorded_at));
      if (day < saldoTxFrom || day > to) continue;
      if (!snapsByDay.has(day)) snapsByDay.set(day, []);
      snapsByDay.get(day)!.push(s);
    }
    for (const arr of snapsByDay.values()) {
      arr.sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime());
    }

    const walkDays = enumerateIsoDays(saldoTxFrom, to);
    const points: { day: string; x: number; y: number; source: 'db' | 'computed' }[] = [];
    for (const dayStr of walkDays) {
      for (const t of txsByDay.get(dayStr) ?? []) {
        const id = t.bank_account_id;
        balances.set(id, (balances.get(id) ?? 0) + Number(t.amount));
      }
      const snaps = snapsByDay.get(dayStr) ?? [];
      for (const s of snaps) {
        balances.set(s.bank_account_id, Number(s.balance));
      }
      if (dayStr < from || dayStr > to) continue;
      const hasDb = snaps.length > 0;
      let total = 0;
      for (const id of saldoSnapshotAccountIds) {
        total += balances.get(id) ?? 0;
      }
      points.push({
        day: dayStr,
        x: parseIsoDate(dayStr).getTime(),
        y: total,
        source: hasDb ? 'db' : 'computed',
      });
    }
    return points;
  }, [
    saldoSnapshotQueries,
    transactionsForSaldoWalk,
    saldoSnapshotAccountIds,
    saldoTxFrom,
    from,
    to,
  ]);

  /** Gleiche Tagesreihenfolge wie `daily` / Balkendiagramm (für identische X-Achse). */
  const saldoVerlaufAligned = useMemo(() => {
    const byDay = new Map(saldoVerlaufDaily.map((p) => [p.day, p]));
    return daily.map((row) => {
      const p = byDay.get(row.day);
      if (p) return p;
      return {
        day: row.day,
        x: parseIsoDate(row.day).getTime(),
        y: 0,
        source: 'computed' as const,
      };
    });
  }, [daily, saldoVerlaufDaily]);

  const { saldoVerlaufOptions, saldoVerlaufSeries } = useMemo(() => {
    const lineColor = theme.palette.primary.main;
    const measuredColor = theme.palette.success.main;
    const derivedColor = theme.palette.warning.main;
    const lineData = saldoVerlaufAligned.map((p) => p.y);
    const dbData = saldoVerlaufAligned.map((p) => (p.source === 'db' ? p.y : null));
    const computedData = saldoVerlaufAligned.map((p) => (p.source === 'computed' ? p.y : null));

    const options: ApexOptions = {
      chart: {
        type: 'line',
        stacked: false,
        toolbar: { show: true },
        zoom: { enabled: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
        events: {
          click: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0) return;
            const day = saldoVerlaufAligned[i]?.day;
            if (day) setSelectedBarDay(day);
          },
          markerClick: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0) return;
            const day = saldoVerlaufAligned[i]?.day;
            if (day) setSelectedBarDay(day);
          },
        },
      },
      stroke: {
        curve: 'smooth',
        width: [2, 0, 0],
        colors: [lineColor, measuredColor, derivedColor],
      },
      colors: [lineColor, measuredColor, derivedColor],
      markers: {
        size: [0, 6, 6],
        strokeWidth: [0, 2, 2],
        strokeColors: [lineColor, measuredColor, derivedColor],
        colors: [lineColor, theme.palette.background.paper, theme.palette.background.paper],
        shape: ['circle', 'circle', 'triangle'],
        hover: { sizeOffset: 2 },
      },
      grid: {
        borderColor: theme.palette.divider,
        strokeDashArray: 4,
      },
      xaxis: {
        ...tagesbilanzXAxisShared,
      },
      yaxis: {
        title: { text: 'Saldo (Summe Konten)' },
        labels: {
          formatter: (val) => formatMoneyShort(Number(val), defaultCurrency),
        },
      },
      tooltip: {
        theme: theme.palette.mode,
        shared: true,
        intersect: false,
        y: {
          formatter: (val, opts) => {
            const si = opts.seriesIndex;
            const label =
              si === 1 ? ' (gemessen)' : si === 2 ? ' (abgeleitet)' : '';
            return formatMoneyFull(Number(val), defaultCurrency) + label;
          },
        },
      },
      legend: {
        show: true,
        position: 'top',
        horizontalAlign: 'right',
        fontSize: '12px',
      },
    };
    return {
      saldoVerlaufOptions: options,
      saldoVerlaufSeries: [
        { name: 'Verlauf', type: 'line', data: lineData },
        { name: 'Gemessen (Saldo-DB)', type: 'scatter', data: dbData },
        { name: 'Abgeleitet (Buchungen)', type: 'scatter', data: computedData },
      ],
    };
  }, [saldoVerlaufAligned, tagesbilanzXAxisShared, theme, defaultCurrency]);

  const piePalette = useMemo(
    () => [
      theme.palette.primary.main,
      theme.palette.secondary.main,
      '#5c6bc0',
      '#26a69a',
      '#ffa726',
      '#ab47bc',
      '#42a5f5',
      '#ef5350',
      '#8d6e63',
      '#78909c',
    ],
    [theme.palette.primary.main, theme.palette.secondary.main],
  );

  const incomeDonut = useMemo(
    () =>
      createCategoryDonutConfig(
        categoryAggsIncomeFiltered,
        'income',
        theme,
        defaultCurrency,
        piePalette,
        (key) => setSelectedCategorySlice({ flow: 'income', categoryKey: key }),
      ),
    [categoryAggsIncomeFiltered, theme, defaultCurrency, piePalette],
  );

  const expenseDonut = useMemo(
    () =>
      createCategoryDonutConfig(
        categoryAggsExpenseFiltered,
        'expense',
        theme,
        defaultCurrency,
        piePalette,
        (key) => setSelectedCategorySlice({ flow: 'expense', categoryKey: key }),
      ),
    [categoryAggsExpenseFiltered, theme, defaultCurrency, piePalette],
  );

  const categoryQueriesTick = categoryQueries.map((q) => q.dataUpdatedAt).join('|');

  const verlaufUncategorizedColor =
    theme.palette.mode === 'dark' ? theme.palette.grey[600] : theme.palette.grey[500];

  const verlaufCategoryOptions = useMemo(() => {
    const roots = categoryQueries.flatMap((q) => q.data ?? []);
    const opts: VerlaufCategoryOption[] = [
      {
        key: '__none__',
        label: 'Ohne Kategorie',
        colorHex: verlaufUncategorizedColor,
        iconEmoji: null,
      },
    ];
    for (const f of flattenCategoriesWithMeta(roots)) {
      opts.push({
        key: `c${f.id}`,
        label: f.label,
        colorHex: f.effective_color_hex,
        iconEmoji: f.icon_emoji,
      });
    }
    opts.sort((a, b) => {
      if (a.key === '__none__') return -1;
      if (b.key === '__none__') return 1;
      return a.label.localeCompare(b.label, 'de');
    });
    return opts;
  }, [categoryQueries, categoryQueriesTick, verlaufUncategorizedColor]);

  const verlaufPickOptions = useMemo(() => {
    const noneOpt = verlaufCategoryOptions.find((o) => o.key === '__none__');
    if (!noneOpt) {
      return [
        {
          rowKind: 'none' as const,
          option: {
            key: '__none__',
            label: 'Ohne Kategorie',
            colorHex: verlaufUncategorizedColor,
            iconEmoji: null,
          },
        },
      ];
    }
    const roots = categoryQueries.flatMap((q) => q.data ?? []);
    return buildVerlaufPickOptions(roots, noneOpt);
  }, [categoryQueries, categoryQueriesTick, verlaufCategoryOptions, verlaufUncategorizedColor]);

  // --- Kategorien: zeitlicher Verlauf (Income/Expense), nutzt dieselben Farben/Labels wie Kategorieverlauf ---

  const kategorienIncomeDailyMatrix = useMemo(() => {
    if (!analysisTransactions.length) return { days: [] as string[], byKey: new Map<string, number[]>() };
    const start = parseIsoDate(from);
    const end = parseIsoDate(to);
    const days: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(isoDateInAppTimezone(d));
    const byKey = new Map<string, number[]>();
    const ensure = (key: string) => {
      if (!byKey.has(key)) byKey.set(key, new Array(days.length).fill(0));
      return byKey.get(key)!;
    };
    const allowed = kategorienSelectedKeys.length ? new Set(kategorienSelectedKeys) : null;
    for (const t of analysisTransactions) {
      const amt = Number(t.amount);
      if (!Number.isFinite(amt) || amt <= 0) continue;
      const dayStr = t.booking_date.slice(0, 10);
      const di = days.indexOf(dayStr);
      if (di < 0) continue;
      const key = t.category_id == null ? '__none__' : `c${t.category_id}`;
      if (allowed && !allowed.has(key)) continue;
      ensure(key)[di] += Math.abs(amt);
    }
    return { days, byKey };
  }, [analysisTransactions, from, to, kategorienSelectedKeys]);

  const kategorienExpenseDailyMatrix = useMemo(() => {
    if (!analysisTransactions.length) return { days: [] as string[], byKey: new Map<string, number[]>() };
    const start = parseIsoDate(from);
    const end = parseIsoDate(to);
    const days: string[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) days.push(isoDateInAppTimezone(d));
    const byKey = new Map<string, number[]>();
    const ensure = (key: string) => {
      if (!byKey.has(key)) byKey.set(key, new Array(days.length).fill(0));
      return byKey.get(key)!;
    };
    const allowed = kategorienSelectedKeys.length ? new Set(kategorienSelectedKeys) : null;
    for (const t of analysisTransactions) {
      const amt = Number(t.amount);
      if (!Number.isFinite(amt) || amt >= 0) continue;
      const dayStr = t.booking_date.slice(0, 10);
      const di = days.indexOf(dayStr);
      if (di < 0) continue;
      const key = t.category_id == null ? '__none__' : `c${t.category_id}`;
      if (allowed && !allowed.has(key)) continue;
      ensure(key)[di] += Math.abs(amt);
    }
    return { days, byKey };
  }, [analysisTransactions, from, to, kategorienSelectedKeys]);

  const kategorienIncomePeriodMatrix = useMemo(
    () => rollupVerlaufFromDaily(kategorienIncomeDailyMatrix, verlaufBucket),
    [kategorienIncomeDailyMatrix, verlaufBucket],
  );

  const kategorienExpensePeriodMatrix = useMemo(
    () => rollupVerlaufFromDaily(kategorienExpenseDailyMatrix, verlaufBucket),
    [kategorienExpenseDailyMatrix, verlaufBucket],
  );

  const kategorienIncomeTimeChart = useMemo(() => {
    const { periodLabels, byKey } = kategorienIncomePeriodMatrix;
    const n = periodLabels.length;
    const keys = [...byKey.keys()];
    keys.sort(
      (a, b) =>
        totalSpendForKey(kategorienIncomeDailyMatrix, b) - totalSpendForKey(kategorienIncomeDailyMatrix, a),
    );
    const series = keys.map((key) => {
      const opt = resolveVerlaufOption(
        key,
        verlaufCategoryOptions,
        categoryAggsIncome,
        verlaufUncategorizedColor,
        piePalette,
        0,
      );
      return {
        name: opt.label,
        data: Array.from({ length: n }, (_, i) => byKey.get(key)?.[i] ?? 0),
      };
    });
    const colors = keys.map((key, si) =>
      resolveVerlaufOption(
        key,
        verlaufCategoryOptions,
        categoryAggsIncome,
        verlaufUncategorizedColor,
        piePalette,
        si,
      ).colorHex,
    );
    const options: ApexOptions = {
      chart: {
        type: 'area',
        stacked: true,
        toolbar: { show: true },
        zoom: { enabled: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
      },
      colors,
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'solid', opacity: 0.55 },
      xaxis: {
        categories: periodLabels,
        labels: {
          rotate: n > 14 ? -45 : 0,
          rotateAlways: n > 14,
          style: { fontSize: '11px' },
        },
      },
      yaxis: { labels: { formatter: (val) => formatMoneyShort(Number(val), defaultCurrency) } },
      dataLabels: { enabled: false },
      legend: { position: 'bottom', fontSize: '12px', markers: { size: 12 } },
      tooltip: {
        theme: theme.palette.mode,
        shared: true,
        intersect: false,
        y: { formatter: (val) => formatMoneyFull(Number(val), defaultCurrency) },
      },
      grid: { borderColor: theme.palette.divider, strokeDashArray: 4 },
    };
    return { options, series };
  }, [
    kategorienIncomePeriodMatrix,
    kategorienIncomeDailyMatrix,
    verlaufCategoryOptions,
    categoryAggsIncome,
    verlaufUncategorizedColor,
    theme,
    defaultCurrency,
    piePalette,
  ]);

  const kategorienExpenseTimeChart = useMemo(() => {
    const { periodLabels, byKey } = kategorienExpensePeriodMatrix;
    const n = periodLabels.length;
    const keys = [...byKey.keys()];
    keys.sort(
      (a, b) =>
        totalSpendForKey(kategorienExpenseDailyMatrix, b) - totalSpendForKey(kategorienExpenseDailyMatrix, a),
    );
    const series = keys.map((key) => {
      const opt = resolveVerlaufOption(
        key,
        verlaufCategoryOptions,
        categoryAggsExpense,
        verlaufUncategorizedColor,
        piePalette,
        0,
      );
      return {
        name: opt.label,
        data: Array.from({ length: n }, (_, i) => byKey.get(key)?.[i] ?? 0),
      };
    });
    const colors = keys.map((key, si) =>
      resolveVerlaufOption(
        key,
        verlaufCategoryOptions,
        categoryAggsExpense,
        verlaufUncategorizedColor,
        piePalette,
        si,
      ).colorHex,
    );
    const options: ApexOptions = {
      chart: {
        type: 'area',
        stacked: true,
        toolbar: { show: true },
        zoom: { enabled: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
      },
      colors,
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'solid', opacity: 0.55 },
      xaxis: {
        categories: periodLabels,
        labels: {
          rotate: n > 14 ? -45 : 0,
          rotateAlways: n > 14,
          style: { fontSize: '11px' },
        },
      },
      yaxis: { labels: { formatter: (val) => formatMoneyShort(Number(val), defaultCurrency) } },
      dataLabels: { enabled: false },
      legend: { position: 'bottom', fontSize: '12px', markers: { size: 12 } },
      tooltip: {
        theme: theme.palette.mode,
        shared: true,
        intersect: false,
        y: { formatter: (val) => formatMoneyFull(Number(val), defaultCurrency) },
      },
      grid: { borderColor: theme.palette.divider, strokeDashArray: 4 },
    };
    return { options, series };
  }, [
    kategorienExpensePeriodMatrix,
    kategorienExpenseDailyMatrix,
    verlaufCategoryOptions,
    categoryAggsExpense,
    verlaufUncategorizedColor,
    theme,
    defaultCurrency,
    piePalette,
  ]);

  /** Muss dieselben `VerlaufPickOption`-Referenzen wie `verlaufPickOptions` nutzen (nicht `VerlaufCategoryOption[]`). */
  const verlaufAutocompletePickValue = useMemo(() => {
    const out: VerlaufPickOption[] = [];
    for (const row of verlaufPickOptions) {
      if (row.rowKind === 'parent') continue;
      if (row.rowKind === 'none') {
        if (verlaufSelectedKeys.includes('__none__')) out.push(row);
      } else if (verlaufSelectedKeys.includes(row.option.key)) {
        out.push(row);
      }
    }
    return out;
  }, [verlaufPickOptions, verlaufSelectedKeys]);

  const kategorienAutocompletePickValue = useMemo(() => {
    const out: VerlaufPickOption[] = [];
    for (const row of verlaufPickOptions) {
      if (row.rowKind === 'parent') continue;
      if (row.rowKind === 'none') {
        if (kategorienSelectedKeys.includes('__none__')) out.push(row);
      } else if (kategorienSelectedKeys.includes(row.option.key)) {
        out.push(row);
      }
    }
    return out;
  }, [verlaufPickOptions, kategorienSelectedKeys]);

  const toggleVerlaufSubtree = useCallback((subtreeKeys: string[]) => {
    setVerlaufSelectedKeys((prev) => {
      const allOn = subtreeKeys.length > 0 && subtreeKeys.every((k) => prev.includes(k));
      if (allOn) return prev.filter((k) => !subtreeKeys.includes(k));
      const next = new Set(prev);
      for (const k of subtreeKeys) next.add(k);
      return Array.from(next).sort();
    });
  }, []);

  const toggleKategorienSubtree = useCallback((subtreeKeys: string[]) => {
    setKategorienSelectedKeys((prev) => {
      const allOn = subtreeKeys.length > 0 && subtreeKeys.every((k) => prev.includes(k));
      if (allOn) return prev.filter((k) => !subtreeKeys.includes(k));
      const next = new Set(prev);
      for (const k of subtreeKeys) next.add(k);
      return Array.from(next).sort();
    });
  }, []);

  const verlaufChart = useMemo(() => {
    const { periodLabels, byKey } = verlaufPeriodMatrix;
    const n = periodLabels.length;

    const series = verlaufSortedSelectedKeys.map((key, si) => {
      const opt = resolveVerlaufOption(
        key,
        verlaufCategoryOptions,
        categoryAggsExpense,
        verlaufUncategorizedColor,
        piePalette,
        si,
      );
      const name = opt.label;
      return {
        name,
        data: Array.from({ length: n }, (_, i) => {
          const arr = byKey.get(key);
          return arr ? (arr[i] ?? 0) : 0;
        }),
      };
    });

    const colors = verlaufSortedSelectedKeys.map((key, si) =>
      resolveVerlaufOption(
        key,
        verlaufCategoryOptions,
        categoryAggsExpense,
        verlaufUncategorizedColor,
        piePalette,
        si,
      ).colorHex,
    );

    const options: ApexOptions = {
      chart: {
        type: 'area',
        stacked: true,
        toolbar: { show: true },
        zoom: { enabled: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
        events: {
          dataPointSelection: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= n) return;
            setVerlaufSelectedPeriodIndex(i);
          },
          click: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= n) return;
            setVerlaufSelectedPeriodIndex(i);
          },
        },
      },
      colors,
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'solid', opacity: 0.55 },
      xaxis: {
        categories: periodLabels,
        title: { text: verlaufXAxisTitle },
        labels: {
          rotate: n > 14 ? -45 : 0,
          rotateAlways: n > 14,
          style: { fontSize: '11px' },
        },
      },
      yaxis: {
        labels: {
          formatter: (val) => formatMoneyShort(Number(val), defaultCurrency),
        },
      },
      dataLabels: { enabled: false },
      legend: {
        position: 'bottom',
        fontSize: '12px',
        markers: { size: 12 },
      },
      tooltip: {
        theme: theme.palette.mode,
        shared: true,
        intersect: false,
        y: {
          formatter: (val) => formatMoneyFull(Number(val), defaultCurrency),
        },
      },
      grid: {
        borderColor: theme.palette.divider,
        strokeDashArray: 4,
      },
    };

    return { options, series };
  }, [
    categoryQueriesTick,
    verlaufPeriodMatrix,
    verlaufSortedSelectedKeys,
    verlaufCategoryOptions,
    verlaufUncategorizedColor,
    verlaufXAxisTitle,
    categoryAggsExpense,
    theme,
    defaultCurrency,
    piePalette,
  ]);

  function setPreset(preset: '7d' | '30d' | '90d' | 'ytd' | '365d') {
    const end = todayIsoInAppTimezone();
    let start: string;
    if (preset === 'ytd') {
      start = `${end.slice(0, 4)}-01-01`;
    } else {
      const days = preset === '7d' ? 7 : preset === '30d' ? 30 : preset === '90d' ? 90 : 365;
      start = addDays(end, -(days - 1));
    }
    setFrom(start);
    setTo(end);
  }

  function shiftRangeByMonths(deltaMonths: number) {
    setFrom((f) => addMonthsToIsoDate(f, deltaMonths));
    setTo((t) => addMonthsToIsoDate(t, deltaMonths));
  }

  const sharedLoading = txQuery.isLoading;
  const sharedError = txQuery.isError;
  const saldoSnapshotsLoading =
    tab === 'tagesbilanz' &&
    saldoSnapshotAccountIds.length > 0 &&
    saldoSnapshotQueries.some((q) => q.isLoading);
  const saldoSnapshotError = saldoSnapshotQueries.find((q) => q.isError)?.error;
  const noAccountsSelected = includedAccountIds !== null && includedAccountIds.length === 0;
  const sharedDataReady =
    rangeOk &&
    !sharedLoading &&
    !sharedError &&
    (noAccountsSelected || txQuery.data !== undefined);
  const categoryQueriesLoading =
    (tab === 'kategorien' ||
      tab === 'kategorieverlauf' ||
      tab === 'regelcluster' ||
      tab === 'ausgaben_sunburst') &&
    categoryQueries.some((q) => q.isLoading);
  const firstCategoryQueryError = categoryQueries.find((q) => q.isError)?.error;
  const rulesQueriesLoading =
    (tab === 'regelcluster' || tab === 'ausgaben_sunburst') && rulesQueries.some((q) => q.isLoading);
  const firstRulesQueryError = rulesQueries.find((q) => q.isError)?.error;

  const mergedCategoryRoots = useMemo(() => {
    const out: CategoryOut[] = [];
    for (const q of categoryQueries) {
      for (const r of q.data ?? []) out.push(r);
    }
    return out;
  }, [categoryQueries]);

  const allRulesSorted = useMemo(() => {
    const out: CategoryRuleOut[] = [];
    for (const q of rulesQueries) {
      for (const r of q.data?.rules ?? []) out.push(r);
    }
    out.sort((a, b) => b.id - a.id);
    return out;
  }, [rulesQueries]);

  const categoryNodeById = useMemo(
    () => buildCategoryNodeByIdMap(mergedCategoryRoots),
    [mergedCategoryRoots],
  );

  const rootColorByCategoryRootName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of mergedCategoryRoots) {
      const hex = r.effective_color_hex?.trim();
      if (hex && !m.has(r.name)) m.set(r.name, hex);
    }
    return m;
  }, [mergedCategoryRoots]);

  const expenseSunburstSeriesData = useMemo(() => {
    const rules = allRulesSorted;
    const txs = analysisTransactions.filter((t) => Number(t.amount) < 0);
    if (!txs.length) return [] as ExpenseSunburstDatum[];
    return buildExpenseRuleSunburstSeries(
      txs,
      categoryNodeById,
      rules,
      rootColorByCategoryRootName,
      piePalette,
    );
  }, [analysisTransactions, categoryNodeById, allRulesSorted, rootColorByCategoryRootName, piePalette]);

  const expenseSunburstSelectionTitle = useMemo(() => {
    const sel = expenseSunburstSelection;
    if (!sel) return '';
    if (sel.depth === 1) return `Hauptkategorie „${sel.root}“`;
    if (sel.depth === 2) return `„${sel.root}“ › „${sel.sub}“`;
    return `„${sel.root}“ › „${sel.sub}“ › Regel „${sel.rule}“`;
  }, [expenseSunburstSelection]);

  const transactionsForExpenseSunburstSelection = useMemo(() => {
    if (!expenseSunburstSelection) return [];
    const rules = allRulesSorted;
    const sel = expenseSunburstSelection;
    return analysisTransactions
      .filter((t) => {
        if (Number(t.amount) >= 0) return false;
        const { root, sub } = resolveCategoryRootAndSub(t.category_id, categoryNodeById);
        const { label: ruleLabel } = displayNameClusterForTransaction(t, rules);
        if (sel.depth === 1) return root === sel.root;
        if (sel.depth === 2) return root === sel.root && sub === sel.sub;
        return root === sel.root && sub === sel.sub && ruleLabel === sel.rule;
      })
      .slice()
      .sort((a, b) => b.id - a.id);
  }, [analysisTransactions, expenseSunburstSelection, categoryNodeById, allRulesSorted]);

  const subcategoryPickOptions = useMemo(
    () => flattenSubcategoryPickOptionsWithMeta(mergedCategoryRoots),
    [mergedCategoryRoots],
  );

  const regelClusterSubtreeIds = useMemo(() => {
    if (regelClusterSubcategoryId == null) return null;
    const node = findCategoryById(mergedCategoryRoots, regelClusterSubcategoryId);
    if (!node) return null;
    return new Set(collectDescendantCategoryIds(node));
  }, [mergedCategoryRoots, regelClusterSubcategoryId]);

  const regelClusterDailyMatrix = useMemo(() => {
    if (!regelClusterSubtreeIds) {
      return { days: [] as string[], byKey: new Map<string, number[]>() };
    }
    const rules = allRulesSorted;
    return buildDailyExpenseMatrixClustered(analysisTransactions, from, to, (t) => {
      if (t.category_id == null || !regelClusterSubtreeIds.has(t.category_id)) return null;
      if (Number(t.amount) >= 0) return null;
      return displayNameClusterForTransaction(t, rules).clusterKey;
    });
  }, [analysisTransactions, from, to, regelClusterSubtreeIds, allRulesSorted]);

  const regelClusterPeriodMatrix = useMemo(
    () => rollupVerlaufFromDaily(regelClusterDailyMatrix, regelClusterBucket),
    [regelClusterDailyMatrix, regelClusterBucket],
  );

  const regelClusterSortedKeys = useMemo(() => {
    const keys = [...regelClusterDailyMatrix.byKey.keys()];
    keys.sort(
      (a, b) => totalSpendForKey(regelClusterDailyMatrix, b) - totalSpendForKey(regelClusterDailyMatrix, a),
    );
    return keys;
  }, [regelClusterDailyMatrix]);

  const regelClusterXAxisTitle =
    regelClusterBucket === 'day'
      ? 'Tag'
      : regelClusterBucket === 'week'
        ? 'Kalenderwoche (Mo–So im Filter)'
        : 'Monat';

  const transactionsForSelectedRegelClusterPeriod = useMemo(() => {
    if (regelClusterPeriodIndex == null || !regelClusterSubtreeIds) return [];
    const daysIn = regelClusterPeriodMatrix.periodDays[regelClusterPeriodIndex];
    if (!daysIn?.length) return [];
    const daySet = new Set(daysIn);
    return analysisTransactions
      .filter((t) => {
        if (Number(t.amount) >= 0) return false;
        if (t.category_id == null || !regelClusterSubtreeIds.has(t.category_id)) return false;
        return daySet.has(t.booking_date.slice(0, 10));
      })
      .slice()
      .sort((a, b) => b.id - a.id);
  }, [analysisTransactions, regelClusterPeriodIndex, regelClusterPeriodMatrix.periodDays, regelClusterSubtreeIds]);

  const transactionsForRegelClusterBarSelection = useMemo(() => {
    if (regelClusterBarClusterKey == null || !regelClusterSubtreeIds) return [];
    const rules = allRulesSorted;
    return analysisTransactions
      .filter((t) => {
        if (Number(t.amount) >= 0) return false;
        if (t.category_id == null || !regelClusterSubtreeIds.has(t.category_id)) return false;
        return displayNameClusterForTransaction(t, rules).clusterKey === regelClusterBarClusterKey;
      })
      .slice()
      .sort((a, b) => b.id - a.id);
  }, [analysisTransactions, regelClusterBarClusterKey, regelClusterSubtreeIds, allRulesSorted]);

  const [regelClusterCounterpartyKey, setRegelClusterCounterpartyKey] = useState<string | null>(null);

  const regelClusterCounterpartyAgg = useMemo(() => {
    const rows = transactionsForRegelClusterBarSelection;
    const by = new Map<string, { label: string; totalAbs: number; count: number }>();
    for (const t of rows) {
      const label =
        t.counterparty_partner_name ??
        t.counterparty_name ??
        t.counterparty ??
        'Unbekannt';
      const key = label.trim() || 'Unbekannt';
      const amt = Math.abs(Number(t.amount));
      const prev = by.get(key);
      if (prev) {
        prev.totalAbs += Number.isFinite(amt) ? amt : 0;
        prev.count += 1;
      } else {
        by.set(key, { label: key, totalAbs: Number.isFinite(amt) ? amt : 0, count: 1 });
      }
    }
    const sorted = Array.from(by.values()).sort((a, b) => b.totalAbs - a.totalAbs);
    const top = sorted.slice(0, 14);
    const rest = sorted.slice(14);
    if (rest.length) {
      top.push({
        label: `Weitere (${rest.length})`,
        totalAbs: rest.reduce((s, r) => s + r.totalAbs, 0),
        count: rest.reduce((s, r) => s + r.count, 0),
      });
    }
    return top;
  }, [transactionsForRegelClusterBarSelection]);

  const regelClusterCounterpartyChart = useMemo(() => {
    const rows = regelClusterCounterpartyAgg;
    const labels = rows.map((r) => r.label);
    const data = rows.map((r) => r.totalAbs);
    const colors = rows.map((_, si) => piePalette[si % piePalette.length]);
    const options: ApexOptions = {
      chart: {
        type: 'bar',
        toolbar: { show: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
        events: {
          dataPointSelection: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= rows.length) return;
            const key = rows[i]?.label ?? null;
            if (!key || key.startsWith('Weitere')) return;
            setRegelClusterCounterpartyKey(key);
          },
          click: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= rows.length) return;
            const key = rows[i]?.label ?? null;
            if (!key || key.startsWith('Weitere')) return;
            setRegelClusterCounterpartyKey(key);
          },
        },
      },
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 2,
          distributed: true,
          dataLabels: { position: 'right' },
        },
      },
      dataLabels: {
        enabled: true,
        formatter: (val: string | number) => formatMoneyShort(Number(val), defaultCurrency),
        style: { fontSize: '11px' },
      },
      xaxis: {
        categories: labels,
        labels: {
          formatter: (val: string | number) => {
            const n = typeof val === 'number' ? val : Number(val);
            if (Number.isFinite(n)) return formatMoneyShort(n, defaultCurrency);
            return String(val);
          },
          style: { fontSize: '11px' },
        },
      },
      yaxis: {
        labels: {
          maxWidth: 260,
          style: { fontSize: '11px' },
          formatter: (val: string | number) => String(val),
        },
      },
      colors,
      grid: { borderColor: theme.palette.divider, strokeDashArray: 4 },
      tooltip: {
        theme: theme.palette.mode,
        y: { formatter: (val: number) => formatMoneyFull(val, defaultCurrency) },
      },
      legend: { show: false },
    };
    return { options, series: [{ name: 'Ausgaben', data }] };
  }, [regelClusterCounterpartyAgg, piePalette, theme, defaultCurrency]);

  const transactionsForRegelClusterCounterpartySelection = useMemo(() => {
    if (!regelClusterCounterpartyKey) return transactionsForRegelClusterBarSelection;
    return transactionsForRegelClusterBarSelection.filter((t) => {
      const label =
        t.counterparty_partner_name ??
        t.counterparty_name ??
        t.counterparty ??
        'Unbekannt';
      const key = label.trim() || 'Unbekannt';
      return key === regelClusterCounterpartyKey;
    });
  }, [transactionsForRegelClusterBarSelection, regelClusterCounterpartyKey]);

  const regelClusterCounterpartyDailyMatrix = useMemo(() => {
    if (regelClusterBarClusterKey == null || !regelClusterSubtreeIds) {
      return { days: [] as string[], byKey: new Map<string, number[]>() };
    }
    const rules = allRulesSorted;
    const allowedKeys = new Set(
      regelClusterCounterpartyAgg
        .map((r) => r.label)
        .filter((k) => k && !k.startsWith('Weitere')),
    );
    return buildDailyExpenseMatrixClustered(analysisTransactions, from, to, (t) => {
      if (Number(t.amount) >= 0) return null;
      if (t.category_id == null || !regelClusterSubtreeIds.has(t.category_id)) return null;
      if (displayNameClusterForTransaction(t, rules).clusterKey !== regelClusterBarClusterKey) return null;
      const label =
        t.counterparty_partner_name ??
        t.counterparty_name ??
        t.counterparty ??
        'Unbekannt';
      const key = label.trim() || 'Unbekannt';
      if (!allowedKeys.has(key)) return null;
      return key;
    });
  }, [
    analysisTransactions,
    from,
    to,
    regelClusterSubtreeIds,
    allRulesSorted,
    regelClusterBarClusterKey,
    regelClusterCounterpartyAgg,
  ]);

  const regelClusterCounterpartyPeriodMatrix = useMemo(
    () => rollupVerlaufFromDaily(regelClusterCounterpartyDailyMatrix, regelClusterBucket),
    [regelClusterCounterpartyDailyMatrix, regelClusterBucket],
  );

  const regelClusterCounterpartyTimeChart = useMemo(() => {
    const { periodLabels, byKey } = regelClusterCounterpartyPeriodMatrix;
    const n = periodLabels.length;
    const keys = Array.from(byKey.keys());
    keys.sort((a, b) => (regelClusterCounterpartyAgg.find((x) => x.label === b)?.totalAbs ?? 0) - (regelClusterCounterpartyAgg.find((x) => x.label === a)?.totalAbs ?? 0));
    const series = keys.map((key) => ({
      name: key,
      data: Array.from({ length: n }, (_, i) => {
        const arr = byKey.get(key);
        return arr ? (arr[i] ?? 0) : 0;
      }),
    }));
    const colors = keys.map((_, si) => piePalette[si % piePalette.length]);
    const options: ApexOptions = {
      chart: {
        type: 'area',
        stacked: true,
        toolbar: { show: true },
        zoom: { enabled: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
      },
      colors,
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'solid', opacity: 0.55 },
      xaxis: {
        categories: periodLabels,
        labels: {
          rotate: n > 14 ? -45 : 0,
          rotateAlways: n > 14,
          style: { fontSize: '11px' },
        },
      },
      yaxis: {
        labels: {
          formatter: (val) => formatMoneyShort(Number(val), defaultCurrency),
        },
      },
      dataLabels: { enabled: false },
      legend: {
        position: 'bottom',
        fontSize: '12px',
        markers: { size: 12 },
      },
      tooltip: {
        theme: theme.palette.mode,
        shared: true,
        intersect: false,
        y: {
          formatter: (val) => formatMoneyFull(Number(val), defaultCurrency),
        },
      },
      grid: {
        borderColor: theme.palette.divider,
        strokeDashArray: 4,
      },
    };
    return { options, series };
  }, [
    regelClusterCounterpartyPeriodMatrix,
    regelClusterCounterpartyAgg,
    theme,
    defaultCurrency,
    piePalette,
  ]);

  const regelClusterBarSelectionTitle = useMemo(() => {
    if (regelClusterBarClusterKey == null) return '';
    return regelClusterLabelForKey(regelClusterBarClusterKey);
  }, [regelClusterBarClusterKey]);

  const regelClusterSelectedPeriodTitle = useMemo(() => {
    if (regelClusterPeriodIndex == null) return '';
    const label = regelClusterPeriodMatrix.periodLabels[regelClusterPeriodIndex] ?? '';
    const raster =
      regelClusterBucket === 'day' ? 'Tag' : regelClusterBucket === 'week' ? 'Woche' : 'Monat';
    return `${raster} · ${label}`;
  }, [regelClusterPeriodIndex, regelClusterPeriodMatrix.periodLabels, regelClusterBucket]);

  const regelClusterBarChart = useMemo(() => {
    const keys = regelClusterSortedKeys;
    const labels = keys.map((k) => regelClusterLabelForKey(k));
    const data = keys.map((k) => totalSpendForKey(regelClusterDailyMatrix, k));
    const colors = keys.map((_, si) => piePalette[si % piePalette.length]);
    const options: ApexOptions = {
      chart: {
        type: 'bar',
        toolbar: { show: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
        events: {
          dataPointSelection: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= keys.length) return;
            setRegelClusterBarClusterKey(keys[i]);
            setRegelClusterPeriodIndex(null);
          },
          click: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= keys.length) return;
            setRegelClusterBarClusterKey(keys[i]);
            setRegelClusterPeriodIndex(null);
          },
        },
      },
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 2,
          distributed: true,
          dataLabels: { position: 'right' },
        },
      },
      dataLabels: {
        enabled: true,
        formatter: (val: string | number) => formatMoneyShort(Number(val), defaultCurrency),
        style: { fontSize: '11px' },
      },
      /**
       * Horizontal: Apex legt `categories` auf die eine Achse, Zahlen auf die andere.
       * Nur Zahlen als Währung formatieren — sonst Anzeigenamen (Strings) durchreichen (vermeidet „NaN €“).
       */
      xaxis: {
        categories: labels,
        labels: {
          formatter: (val: string | number) => {
            const n = typeof val === 'number' ? val : Number(val);
            if (Number.isFinite(n)) return formatMoneyShort(n, defaultCurrency);
            return String(val);
          },
          style: { fontSize: '11px' },
        },
      },
      yaxis: {
        labels: {
          maxWidth: 240,
          style: { fontSize: '11px' },
          formatter: (val: string | number) => {
            const n = typeof val === 'number' ? val : Number(val);
            if (Number.isFinite(n)) return formatMoneyShort(n, defaultCurrency);
            return String(val);
          },
        },
      },
      colors,
      grid: { borderColor: theme.palette.divider, strokeDashArray: 4 },
      tooltip: {
        theme: theme.palette.mode,
        y: { formatter: (val: number) => formatMoneyFull(val, defaultCurrency) },
      },
      legend: { show: false },
    };
    return { options, series: [{ name: 'Ausgaben', data }] };
  }, [regelClusterSortedKeys, regelClusterDailyMatrix, theme, defaultCurrency, piePalette]);

  const regelClusterPieChart = useMemo(() => {
    const keys = regelClusterSortedKeys;
    const labels = keys.map((k) => regelClusterLabelForKey(k));
    const data = keys.map((k) => totalSpendForKey(regelClusterDailyMatrix, k));
    const colors = keys.map((_, si) => piePalette[si % piePalette.length]);
    const options: ApexOptions = {
      chart: {
        type: 'donut',
        toolbar: { show: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
        events: {
          dataPointSelection: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= keys.length) return;
            setRegelClusterBarClusterKey(keys[i]);
            setRegelClusterPeriodIndex(null);
          },
          click: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= keys.length) return;
            setRegelClusterBarClusterKey(keys[i]);
            setRegelClusterPeriodIndex(null);
          },
        },
      },
      labels,
      colors,
      legend: {
        position: 'bottom',
        fontSize: '12px',
        markers: { size: 10 },
      },
      dataLabels: { enabled: false },
      tooltip: {
        theme: theme.palette.mode,
        y: { formatter: (val: number) => formatMoneyFull(val, defaultCurrency) },
      },
      plotOptions: {
        pie: {
          donut: {
            size: '62%',
            labels: {
              show: true,
              total: {
                show: true,
                label: 'Summe',
                formatter: (w: any) => {
                  const totals = w?.globals?.seriesTotals as number[] | undefined;
                  const sum = Array.isArray(totals) ? totals.reduce((a, b) => a + (Number(b) || 0), 0) : 0;
                  return formatMoneyShort(sum, defaultCurrency);
                },
              },
              value: {
                formatter: (val: string) => formatMoneyShort(Number(val), defaultCurrency),
              },
            },
          },
        },
      },
      stroke: { width: 1, colors: [theme.palette.background.paper] as any },
    };
    return { options, series: data };
  }, [regelClusterSortedKeys, regelClusterDailyMatrix, theme, defaultCurrency, piePalette]);

  const regelClusterTimeChart = useMemo(() => {
    const { periodLabels, byKey } = regelClusterPeriodMatrix;
    const n = periodLabels.length;
    const keys = regelClusterSortedKeys;
    const series = keys.map((key) => ({
      name: regelClusterLabelForKey(key),
      data: Array.from({ length: n }, (_, i) => {
        const arr = byKey.get(key);
        return arr ? (arr[i] ?? 0) : 0;
      }),
    }));
    const colors = keys.map((_, si) => piePalette[si % piePalette.length]);
    const options: ApexOptions = {
      chart: {
        type: 'area',
        stacked: true,
        toolbar: { show: true },
        zoom: { enabled: true },
        foreColor: theme.palette.text.secondary,
        background: 'transparent',
        fontFamily: theme.typography.fontFamily,
        events: {
          dataPointSelection: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= n) return;
            setRegelClusterBarClusterKey(null);
            setRegelClusterPeriodIndex(i);
          },
          click: (_e, _chart, opts) => {
            const i = opts?.dataPointIndex;
            if (typeof i !== 'number' || i < 0 || i >= n) return;
            setRegelClusterBarClusterKey(null);
            setRegelClusterPeriodIndex(i);
          },
        },
      },
      colors,
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'solid', opacity: 0.55 },
      xaxis: {
        categories: periodLabels,
        title: { text: regelClusterXAxisTitle },
        labels: {
          rotate: n > 14 ? -45 : 0,
          rotateAlways: n > 14,
          style: { fontSize: '11px' },
        },
      },
      yaxis: {
        labels: {
          formatter: (val) => formatMoneyShort(Number(val), defaultCurrency),
        },
      },
      dataLabels: { enabled: false },
      legend: {
        position: 'bottom',
        fontSize: '12px',
        markers: { size: 12 },
      },
      tooltip: {
        theme: theme.palette.mode,
        shared: true,
        intersect: false,
        y: {
          formatter: (val) => formatMoneyFull(Number(val), defaultCurrency),
        },
      },
      grid: {
        borderColor: theme.palette.divider,
        strokeDashArray: 4,
      },
    };
    return { options, series };
  }, [
    regelClusterPeriodMatrix,
    regelClusterSortedKeys,
    regelClusterXAxisTitle,
    theme,
    defaultCurrency,
    piePalette,
  ]);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Analysen
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Diagramme zu Buchungen und Kategorien. Tagesbilanz: kumulierter Verlauf. Kategorien: Torten für Einnahmen
          und Ausgaben. Kategorieverlauf: gestapelte Flächen je Kategorie. Anzeigeregeln: Ausgaben einer Unterkategorie
          nach Zuordnungsregel-Anzeigenamen gruppiert (Balken + Zeitverlauf). Ausgaben-Sunburst: drei Ebenen
          (Hauptkategorie → Unterkategorie → Regel) als Ringdiagramm.
        </Typography>
      </Box>

      <Tabs
        value={tab}
        onChange={handleTabChange}
        sx={{ borderBottom: 1, borderColor: 'divider' }}
        variant={isXs ? 'scrollable' : 'standard'}
        scrollButtons="auto"
        allowScrollButtonsMobile
      >
        <Tab value="tagesbilanz" label="Tagesbilanz" />
        <Tab value="kategorien" label="Kategorien" />
        <Tab value="kategorieverlauf" label="Kategorieverlauf" />
        <Tab value="regelcluster" label="Anzeigeregeln" />
        <Tab value="ausgaben_sunburst" label="Ausgaben-Sunburst" />
        <Tab value="geldfluss" label="Geldfluss" />
      </Tabs>

      <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="body2" color="text.secondary">
              Schnellwahl
            </Typography>
            <ButtonGroup size="small" variant="outlined">
              <Button onClick={() => setPreset('7d')}>7 Tage</Button>
              <Button onClick={() => setPreset('30d')}>30 Tage</Button>
              <Button onClick={() => setPreset('90d')}>90 Tage</Button>
              <Button onClick={() => setPreset('ytd')}>YTD</Button>
              <Button onClick={() => setPreset('365d')}>1 Jahr</Button>
            </ButtonGroup>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} flexWrap="wrap">
            <Typography variant="body2" color="text.secondary" sx={{ minWidth: 72 }}>
              Zeitraum
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid rgba(127,127,127,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                }}
              />
              <span>–</span>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid rgba(127,127,127,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                }}
              />
              <ButtonGroup size="small" variant="outlined">
                <Button onClick={() => shiftRangeByMonths(-1)}>−1 Monat</Button>
                <Button onClick={() => shiftRangeByMonths(1)}>+1 Monat</Button>
              </ButtonGroup>
            </Stack>
            <Button
              size="small"
              variant="outlined"
              onClick={(e) => setAccountFilterAnchor(e.currentTarget)}
              sx={{ minWidth: 220, justifyContent: 'flex-start', textAlign: 'left' }}
            >
              {accountFilterSummary}
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={(e) => setTransferFilterAnchor(e.currentTarget)}
              sx={{ minWidth: 200, justifyContent: 'flex-start', textAlign: 'left' }}
            >
              {transferFilterSummary}
            </Button>
            <Popover
              open={Boolean(transferFilterAnchor)}
              anchorEl={transferFilterAnchor}
              onClose={() => setTransferFilterAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
              slotProps={{
                paper: {
                  sx: { maxWidth: 400, mt: 0.5, p: 2 },
                },
              }}
            >
              <Typography variant="subtitle2" fontWeight={600} gutterBottom>
                Umbuchungen
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
                Gilt für Balken, Kategorien, Kategorieverlauf, Anzeigeregeln und Geldfluss. Es werden abgehende
                Buchungen mit Zielkonto gefiltert (je Art). Der <strong>Saldo-Verlauf</strong> nutzt weiterhin alle
                Buchungen zur Kontostandsberechnung.
              </Typography>
              <Stack spacing={0.25}>
                {ANALYSIS_TRANSFER_KIND_KEYS.map((k) => (
                  <FormControlLabel
                    key={k}
                    control={
                      <Checkbox
                        size="small"
                        checked={transferKindInclusion[k]}
                        onChange={() =>
                          setTransferKindInclusion((prev) => ({ ...prev, [k]: !prev[k] }))
                        }
                      />
                    }
                    label={transferKindLabel(k)}
                  />
                ))}
              </Stack>
              <Stack direction="row" spacing={1} sx={{ mt: 1.5 }} flexWrap="wrap" useFlexGap>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => setTransferKindInclusion({ ...DEFAULT_TRANSFER_KIND_INCLUSION })}
                >
                  Alle einblenden
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() =>
                    setTransferKindInclusion(
                      Object.fromEntries(ANALYSIS_TRANSFER_KIND_KEYS.map((key) => [key, false])) as Record<
                        AnalysisTransferKindKey,
                        boolean
                      >,
                    )
                  }
                >
                  Alle ausblenden
                </Button>
              </Stack>
            </Popover>
            <Popover
              open={Boolean(accountFilterAnchor)}
              anchorEl={accountFilterAnchor}
              onClose={() => setAccountFilterAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
              slotProps={{
                paper: {
                  sx: { maxHeight: 420, width: 340, mt: 0.5 },
                },
              }}
            >
              <List dense disablePadding sx={{ py: 1 }}>
                <ListItemButton
                  selected={includedAccountIds === null}
                  onClick={() => setIncludedAccountIds(null)}
                  sx={{ pl: 1, alignItems: 'flex-start' }}
                >
                  <ListItemText
                    primary="Alle meine Konten"
                    secondary="Alle Konten, auf die du Zugriff hast"
                    secondaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                  />
                </ListItemButton>
                <Divider />
                {householdWithGroups.map(({ household: hh, groups }) => {
                  const hhAccounts = accounts.filter((a) => a.household_id === hh.id);
                  const hhAccountIds = hhAccounts.map((a) => a.id);
                  const hhAll =
                    hhAccountIds.length > 0 && hhAccountIds.every((id) => includedSet.has(id));
                  const hhSome = hhAccountIds.some((id) => includedSet.has(id));
                  return (
                    <Box key={hh.id}>
                      <ListItemButton
                        sx={{ pl: 1 }}
                        onClick={() => {
                          const next = new Set(includedSet);
                          if (hhAll) for (const id of hhAccountIds) next.delete(id);
                          else for (const id of hhAccountIds) next.add(id);
                          applyIncludedSet(next);
                        }}
                      >
                        <Checkbox
                          edge="start"
                          checked={hhAccountIds.length > 0 && hhAll}
                          indeterminate={hhSome && !hhAll}
                          tabIndex={-1}
                          disableRipple
                        />
                        <ListItemText primary={hh.name} />
                      </ListItemButton>
                      {groups.map((g) => {
                        const gAccounts = accounts.filter(
                          (a) => a.household_id === hh.id && a.account_group_id === g.id,
                        );
                        const gAccountIds = gAccounts.map((a) => a.id);
                        const gAll =
                          gAccountIds.length > 0 && gAccountIds.every((id) => includedSet.has(id));
                        const gSome = gAccountIds.some((id) => includedSet.has(id));
                        return (
                          <Box key={g.id}>
                            <ListItemButton
                              sx={{ pl: 3 }}
                              onClick={() => {
                                const next = new Set(includedSet);
                                if (gAll) for (const id of gAccountIds) next.delete(id);
                                else for (const id of gAccountIds) next.add(id);
                                applyIncludedSet(next);
                              }}
                            >
                              <Checkbox
                                edge="start"
                                checked={gAccountIds.length > 0 && gAll}
                                indeterminate={gSome && !gAll}
                                tabIndex={-1}
                                disableRipple
                              />
                              <ListItemText primary={g.name} />
                            </ListItemButton>
                            {gAccounts.map((acc) => (
                              <ListItemButton
                                key={acc.id}
                                sx={{ pl: 5 }}
                                onClick={() => {
                                  const next = new Set(includedSet);
                                  if (next.has(acc.id)) next.delete(acc.id);
                                  else next.add(acc.id);
                                  applyIncludedSet(next);
                                }}
                              >
                                <Checkbox
                                  edge="start"
                                  checked={includedSet.has(acc.id)}
                                  tabIndex={-1}
                                  disableRipple
                                />
                                <ListItemText primary={acc.name} />
                              </ListItemButton>
                            ))}
                          </Box>
                        );
                      })}
                    </Box>
                  );
                })}
              </List>
            </Popover>
            <Button
              variant="outlined"
              onClick={() => void txQuery.refetch()}
              disabled={txQuery.isFetching || !rangeOk || noAccountsSelected}
            >
              {txQuery.isFetching ? 'Laden…' : 'Aktualisieren'}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      {!rangeOk ? (
        <Alert severity="warning">Bitte „Von“ vor oder gleich „Bis“ wählen.</Alert>
      ) : accountsQuery.isError ? (
        <Alert severity="error">{apiErrorMessage(accountsQuery.error)}</Alert>
      ) : sharedError ? (
        <Alert severity="error">{apiErrorMessage(txQuery.error)}</Alert>
      ) : sharedLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : tab === 'geldfluss' ? (
        <MoneyFlow
          embedded
          from={from}
          to={to}
          includedAccountIds={includedAccountIds}
          transferKindInclusion={transferKindInclusion}
        />
      ) : tab === 'tagesbilanz' ? (
        <>
          {daily.length === 0 ? (
            <Alert severity="info">Keine Tage im Zeitraum.</Alert>
          ) : (
            <Stack spacing={2}>
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle1" fontWeight={600} gutterBottom>
                  Saldoverlauf
                </Typography>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  <strong>Kreis</strong>: Tag mit Saldo-Snapshot aus der Datenbank. <strong>Dreieck</strong>: Tag ohne
                  Snapshot — der Wert wird aus dem letzten bekannten Saldo und den Buchungen bis zum Tagesende
                  fortgerechnet (inkl. Buchungen bis zu {SALDO_TX_LOOKBACK_DAYS} Tage vor „Von“, damit der Stand zum
                  Filterbeginn nicht „hängen bleibt“). Die Linie verbindet alle Tage.{' '}
                  <strong>Klick auf Linie oder Marker</strong> filtert die Buchungsliste unten auf den Kalendertag.
                </Typography>
                {saldoSnapshotError ? (
                  <Alert severity="error" sx={{ mt: 1 }}>
                    {apiErrorMessage(saldoSnapshotError)}
                  </Alert>
                ) : saldoSnapshotsLoading ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                    <CircularProgress size={32} />
                  </Box>
                ) : daily.length === 0 ? (
                  <Alert severity="info" sx={{ mt: 1 }}>
                    Keine Tage im gewählten Zeitraum.
                  </Alert>
                ) : (
                  <Box sx={{ width: '100%', minHeight: isXs ? 260 : 300, '& .apexcharts-canvas': { mx: 'auto' } }}>
                    <Chart
                      options={saldoVerlaufOptions}
                      series={saldoVerlaufSeries}
                      type="line"
                      height={isXs ? 280 : 320}
                      width="100%"
                    />
                  </Box>
                )}
              </Paper>
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Jeder Balken reicht vom kumulierten Stand des Vortags bis zum Stand nach diesem Tag (Wasserfall /
                Aktienstufen). Farbe = Tagesänderung (grün aufwärts, rot abwärts).{' '}
                <strong>Balken anklicken</strong>, um die Buchungen dieses Tages darunter anzuzeigen.
              </Typography>
                <Box sx={{ width: '100%', minHeight: isXs ? 300 : 400, '& .apexcharts-canvas': { mx: 'auto' } }}>
                  <Chart options={chartOptions} series={series} type="rangeBar" height={isXs ? 320 : 420} width="100%" />
              </Box>
            </Paper>
            </Stack>
          )}
          {selectedBarDay && sharedDataReady ? (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  Buchungen am {formatDate(selectedBarDay)}
                </Typography>
                <Button size="small" variant="outlined" onClick={() => setSelectedBarDay(null)}>
                  Auswahl aufheben
                </Button>
              </Stack>
              <TransactionBookingsTable
                rows={transactionsForSelectedDay}
                accounts={accounts}
                emptyMessage="Keine Buchungen an diesem Tag (im gewählten Filter)."
                hideInlineHint
              />
            </Paper>
          ) : null}
        </>
      ) : tab === 'kategorien' ? (
        <>
          {!analysisTransactions.length ? (
            <Alert severity="info">Keine Buchungen im Zeitraum.</Alert>
          ) : (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                <strong>Einnahmen-Torte</strong>: nur Buchungen mit positivem Betrag. <strong>Ausgaben-Torte</strong>: nur
                negative Beträge (Scheibengröße nach Summe im Absolutbetrag, Beschriftung mit Vorzeichen). Wähle die
                Kategorien wie beim Kategorieverlauf (Hauptzeile schaltet den ganzen Teilbaum).{' '}
                <strong>Segment anklicken</strong> für die Buchungsliste unten.
              </Typography>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                spacing={2}
                alignItems={{ xs: 'stretch', md: 'center' }}
                sx={{ mt: 2, mb: 1 }}
                flexWrap="wrap"
                useFlexGap
              >
                <Autocomplete<VerlaufPickOption, true, false, false>
                  multiple
                  disableCloseOnSelect
                  options={verlaufPickOptions}
                  getOptionLabel={(row) => row.option.label}
                  isOptionEqualToValue={(opt, val) => verlaufPickRowListKey(opt) === verlaufPickRowListKey(val)}
                  value={kategorienAutocompletePickValue}
                  onChange={(_, newRows) => {
                    const keys = newRows
                      .filter((r) => r.rowKind === 'none' || r.rowKind === 'leaf')
                      .map((r) => r.option.key)
                      .filter((k) => typeof k === 'string' && k.length > 0);
                    setKategorienSelectedKeys([...new Set(keys)].sort());
                  }}
                  renderOption={(props, row, { selected }) => {
                    if (row.rowKind === 'parent') {
                      const sk = row.subtreeKeys;
                      const allOn = sk.length > 0 && sk.every((k) => kategorienSelectedKeys.includes(k));
                      const someOn = sk.some((k) => kategorienSelectedKeys.includes(k));
                      const { key: _liKey, onMouseDown: _omd, ...liProps } = props as HTMLAttributes<HTMLLIElement> & {
                        key?: string;
                      };
                      return (
                        <Box
                          key={verlaufPickRowListKey(row)}
                          component="li"
                          {...liProps}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleKategorienSubtree(sk);
                          }}
                          sx={{
                            ...((liProps as { sx?: object }).sx as object),
                            cursor: 'pointer',
                            listStyle: 'none',
                          }}
                        >
                          <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', py: 0.25, pl: 0.5 }}>
                            <Checkbox
                              size="small"
                              checked={allOn}
                              indeterminate={someOn && !allOn}
                              tabIndex={-1}
                              sx={{ p: 0.25, pointerEvents: 'none' }}
                            />
                            <Box
                              sx={{
                                width: 10,
                                height: 10,
                                borderRadius: '50%',
                                bgcolor: row.option.colorHex,
                                flexShrink: 0,
                                border: 1,
                                borderColor: 'divider',
                              }}
                            />
                            <CategorySymbolDisplay value={row.option.iconEmoji} fontSize="1.15rem" />
                            <Typography variant="subtitle2" fontWeight={600}>
                              {row.option.label}
                            </Typography>
                            {someOn && !allOn ? (
                              <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                                (Teilauswahl)
                              </Typography>
                            ) : null}
                          </Stack>
                        </Box>
                      );
                    }
                    const opt = row.option;
                    const leafSelected =
                      selected ||
                      (row.rowKind === 'none'
                        ? kategorienSelectedKeys.includes('__none__')
                        : kategorienSelectedKeys.includes(opt.key));
                    const { key: _lk, ...leafLiProps } = props as HTMLAttributes<HTMLLIElement> & { key?: string };
                    const indentSub =
                      row.rowKind === 'leaf' && row.option.label.includes(' › ');
                    return (
                      <li key={verlaufPickRowListKey(row)} {...leafLiProps}>
                        <Stack
                          direction="row"
                          alignItems="center"
                          spacing={1}
                          sx={{ width: '100%', pl: indentSub ? 2.5 : 0.5 }}
                        >
                          <Checkbox size="small" checked={leafSelected} sx={{ p: 0.25 }} />
                          <Box
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              bgcolor: opt.colorHex,
                              flexShrink: 0,
                              border: 1,
                              borderColor: 'divider',
                            }}
                          />
                          <CategorySymbolDisplay value={opt.iconEmoji} fontSize="1.15rem" />
                          <Typography variant="body2">{opt.label}</Typography>
                        </Stack>
                      </li>
                    );
                  }}
                  renderTags={(tagValue, getTagProps) =>
                    tagValue.map((row, index) => {
                      const option = row.option;
                      return (
                        <Chip
                          {...getTagProps({ index })}
                          key={verlaufPickRowListKey(row)}
                          size="small"
                          variant="outlined"
                          sx={{
                            borderColor: option.colorHex,
                            bgcolor: alpha(option.colorHex, 0.14),
                            '& .MuiChip-label': { px: 0.75 },
                          }}
                          label={
                            <Stack direction="row" alignItems="center" spacing={0.5}>
                              <Box
                                sx={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  bgcolor: option.colorHex,
                                  flexShrink: 0,
                                }}
                              />
                              <CategorySymbolDisplay value={option.iconEmoji} fontSize="1rem" />
                              <Typography component="span" variant="caption" noWrap sx={{ maxWidth: 180 }}>
                                {option.label}
                              </Typography>
                            </Stack>
                          }
                        />
                      );
                    })
                  }
                  renderInput={(params) => (
                    <TextField {...params} label="Kategorien im Diagramm" placeholder="Auswählen…" size="small" />
                  )}
                  sx={{ flex: 1, minWidth: 260, maxWidth: 640 }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => setKategorienSelectedKeys([...allPieCategoryKeysSorted])}
                  disabled={allPieCategoryKeysSorted.length === 0}
                >
                  Alle mit Buchungen
                </Button>
              </Stack>
              {categoryQueriesLoading ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Kategorienamen werden geladen…
                </Typography>
              ) : null}
              {kategorienSelectedKeys.length === 0 ? (
                <Alert severity="info" sx={{ mt: 1 }}>
                  Bitte mindestens eine Kategorie auswählen.
                </Alert>
              ) : (
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                spacing={3}
                alignItems="stretch"
                sx={{ mt: 1 }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" fontWeight={700} color="success.main" gutterBottom textAlign="center">
                    Einnahmen
                  </Typography>
                    {categoryAggsIncomeFiltered.length === 0 ? (
                    <Alert severity="info" sx={{ mt: 1 }}>
                        Keine Einnahmen für die gewählten Kategorien im Zeitraum.
                    </Alert>
                  ) : (
                      <Box sx={{ width: '100%', minHeight: isXs ? 300 : 400 }}>
                      <Chart
                        options={incomeDonut.options}
                        series={incomeDonut.series}
                        type="donut"
                          height={isXs ? 320 : 420}
                        width="100%"
                      />
                    </Box>
                  )}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="subtitle2" fontWeight={700} color="error.main" gutterBottom textAlign="center">
                    Ausgaben
                  </Typography>
                    {categoryAggsExpenseFiltered.length === 0 ? (
                    <Alert severity="info" sx={{ mt: 1 }}>
                        Keine Ausgaben für die gewählten Kategorien im Zeitraum.
                    </Alert>
                  ) : (
                      <Box sx={{ width: '100%', minHeight: isXs ? 300 : 400 }}>
                      <Chart
                        options={expenseDonut.options}
                        series={expenseDonut.series}
                        type="donut"
                          height={isXs ? 320 : 420}
                        width="100%"
                      />
                    </Box>
                  )}
                </Box>
              </Stack>
              )}
            </Paper>
          )}
          {kategorienSelectedKeys.length > 0 ? (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Accordion elevation={0} sx={{ border: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="subtitle2" fontWeight={600}>
                    Verlauf über die Zeit
                  </Typography>
                </AccordionSummary>
                <AccordionDetails sx={{ pt: 0 }}>
                  <Stack
                    direction={{ xs: 'column', md: 'row' }}
                    spacing={2}
                    alignItems={{ xs: 'stretch', md: 'center' }}
                    sx={{ mb: 2, mt: 0.5 }}
                    flexWrap="wrap"
                    useFlexGap
                  >
                    <FormControl size="small" sx={{ minWidth: 200 }}>
                      <InputLabel id="analyses-kategorien-bucket">Aggregierung</InputLabel>
                      <Select
                        labelId="analyses-kategorien-bucket"
                        label="Aggregierung"
                        value={verlaufBucket}
                        onChange={(e) => setVerlaufBucket(e.target.value as VerlaufBucket)}
                      >
                        <MenuItem value="day">Tag</MenuItem>
                        <MenuItem value="week">Woche</MenuItem>
                        <MenuItem value="month">Monat</MenuItem>
                      </Select>
                    </FormControl>
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="stretch">
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="subtitle2" fontWeight={700} color="success.main" gutterBottom textAlign="center">
                        Einnahmen
                      </Typography>
                      {kategorienIncomeTimeChart.series.length === 0 ? (
                        <Alert severity="info" sx={{ mt: 1 }}>
                          Keine Einnahmen im Verlauf für die gewählten Kategorien.
                        </Alert>
                      ) : (
                        <Box sx={{ width: '100%', minHeight: isXs ? 320 : 420, '& .apexcharts-canvas': { mx: 'auto' } }}>
                          <Chart
                            options={kategorienIncomeTimeChart.options}
                            series={kategorienIncomeTimeChart.series}
                            type="area"
                            height={isXs ? 340 : 420}
                            width="100%"
                          />
                        </Box>
                      )}
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="subtitle2" fontWeight={700} color="error.main" gutterBottom textAlign="center">
                        Ausgaben
                      </Typography>
                      {kategorienExpenseTimeChart.series.length === 0 ? (
                        <Alert severity="info" sx={{ mt: 1 }}>
                          Keine Ausgaben im Verlauf für die gewählten Kategorien.
                        </Alert>
                      ) : (
                        <Box sx={{ width: '100%', minHeight: isXs ? 320 : 420, '& .apexcharts-canvas': { mx: 'auto' } }}>
                          <Chart
                            options={kategorienExpenseTimeChart.options}
                            series={kategorienExpenseTimeChart.series}
                            type="area"
                            height={isXs ? 340 : 420}
                            width="100%"
                          />
                        </Box>
                      )}
                    </Box>
                  </Stack>
                </AccordionDetails>
              </Accordion>
            </Paper>
          ) : null}
          {selectedCategorySlice && sharedDataReady && analysisTransactions.length ? (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  Buchungen: {selectedCategoryTitle}
                </Typography>
                <Button size="small" variant="outlined" onClick={() => setSelectedCategorySlice(null)}>
                  Auswahl aufheben
                </Button>
              </Stack>
              <TransactionBookingsTable
                rows={transactionsForSelectedCategory}
                accounts={accounts}
                emptyMessage="Keine Buchungen für diese Kategorie."
                hideInlineHint
              />
            </Paper>
          ) : null}
        </>
      ) : tab === 'kategorieverlauf' ? (
        <>
          {firstCategoryQueryError ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Kategorien konnten nicht vollständig geladen werden: {apiErrorMessage(firstCategoryQueryError)}. Namen
              fehlen ggf. in der Auswahl.
            </Alert>
          ) : null}
          {!analysisTransactions.length ? (
            <Alert severity="info">Keine Buchungen im Zeitraum.</Alert>
          ) : dailyExpenseMatrix.days.length === 0 ? (
            <Alert severity="info">Keine Tage im Zeitraum.</Alert>
          ) : (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                Nur <strong>Ausgaben</strong> (negative Beträge): Summe der <strong>Absolutbeträge</strong> je Kategorie
                pro gewähltem Zeitraster (Tag / Kalenderwoche Mo–So nur mit Tagen im Filter / Kalendermonat), gestapelt.
                Serien wählst du unten (nach <strong>Hauptkategorie</strong> gruppiert: Hauptzeile wählt alle
                Unterkategorien ab, teilweise Auswahl = unbestimmter Haken). Farben wie in den
                Kategorieeinstellungen (sonst Fallback).{' '}
                <strong>Zeitpunkt im Diagramm anklicken</strong>, um die zugehörigen Ausgaben darunter zu sehen.
              </Typography>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                spacing={2}
                alignItems={{ xs: 'stretch', md: 'center' }}
                sx={{ mb: 2, mt: 1 }}
                flexWrap="wrap"
                useFlexGap
              >
                <FormControl size="small" sx={{ minWidth: 200 }}>
                  <InputLabel id="analyses-verlauf-bucket">Aggregierung</InputLabel>
                  <Select
                    labelId="analyses-verlauf-bucket"
                    label="Aggregierung"
                    value={verlaufBucket}
                    onChange={(e) => setVerlaufBucket(e.target.value as VerlaufBucket)}
                  >
                    <MenuItem value="day">Tag</MenuItem>
                    <MenuItem value="week">Woche</MenuItem>
                    <MenuItem value="month">Monat</MenuItem>
                  </Select>
                </FormControl>
                <Autocomplete<VerlaufPickOption, true, false, false>
                  multiple
                  disableCloseOnSelect
                  options={verlaufPickOptions}
                  getOptionLabel={(row) => row.option.label}
                  isOptionEqualToValue={(opt, val) => verlaufPickRowListKey(opt) === verlaufPickRowListKey(val)}
                  value={verlaufAutocompletePickValue}
                  onChange={(_, newRows) => {
                    const keys = newRows
                      .filter((r) => r.rowKind === 'none' || r.rowKind === 'leaf')
                      .map((r) => r.option.key)
                      .filter((k) => typeof k === 'string' && k.length > 0);
                    setVerlaufSelectedKeys([...new Set(keys)].sort());
                  }}
                  renderOption={(props, row, { selected }) => {
                    if (row.rowKind === 'parent') {
                      const sk = row.subtreeKeys;
                      const allOn = sk.length > 0 && sk.every((k) => verlaufSelectedKeys.includes(k));
                      const someOn = sk.some((k) => verlaufSelectedKeys.includes(k));
                      const { key: _liKey, onMouseDown: _omd, ...liProps } = props as HTMLAttributes<HTMLLIElement> & {
                        key?: string;
                      };
                      return (
                        <Box
                          key={verlaufPickRowListKey(row)}
                          component="li"
                          {...liProps}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleVerlaufSubtree(sk);
                          }}
                          sx={{
                            ...((liProps as { sx?: object }).sx as object),
                            cursor: 'pointer',
                            listStyle: 'none',
                          }}
                        >
                          <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', py: 0.25, pl: 0.5 }}>
                            <Checkbox
                              size="small"
                              checked={allOn}
                              indeterminate={someOn && !allOn}
                              tabIndex={-1}
                              sx={{ p: 0.25, pointerEvents: 'none' }}
                            />
                            <Box
                              sx={{
                                width: 10,
                                height: 10,
                                borderRadius: '50%',
                                bgcolor: row.option.colorHex,
                                flexShrink: 0,
                                border: 1,
                                borderColor: 'divider',
                              }}
                            />
                            <CategorySymbolDisplay value={row.option.iconEmoji} fontSize="1.15rem" />
                            <Typography variant="subtitle2" fontWeight={600}>
                              {row.option.label}
                            </Typography>
                            {someOn && !allOn ? (
                              <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                                (Teilauswahl)
                              </Typography>
                            ) : null}
                          </Stack>
                        </Box>
                      );
                    }
                    const opt = row.option;
                    const leafSelected =
                      selected ||
                      (row.rowKind === 'none'
                        ? verlaufSelectedKeys.includes('__none__')
                        : verlaufSelectedKeys.includes(opt.key));
                    const { key: _lk, ...leafLiProps } = props as HTMLAttributes<HTMLLIElement> & { key?: string };
                    const indentSub =
                      row.rowKind === 'leaf' && row.option.label.includes(' › ');
                    return (
                      <li key={verlaufPickRowListKey(row)} {...leafLiProps}>
                        <Stack
                          direction="row"
                          alignItems="center"
                          spacing={1}
                          sx={{ width: '100%', pl: indentSub ? 2.5 : 0.5 }}
                        >
                          <Checkbox size="small" checked={leafSelected} sx={{ p: 0.25 }} />
                          <Box
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              bgcolor: opt.colorHex,
                              flexShrink: 0,
                              border: 1,
                              borderColor: 'divider',
                            }}
                          />
                          <CategorySymbolDisplay value={opt.iconEmoji} fontSize="1.15rem" />
                          <Typography variant="body2">{opt.label}</Typography>
                        </Stack>
                      </li>
                    );
                  }}
                  renderTags={(tagValue, getTagProps) =>
                    tagValue.map((row, index) => {
                      const option = row.option;
                      return (
                        <Chip
                          {...getTagProps({ index })}
                          key={verlaufPickRowListKey(row)}
                          size="small"
                          variant="outlined"
                          sx={{
                            borderColor: option.colorHex,
                            bgcolor: alpha(option.colorHex, 0.14),
                            '& .MuiChip-label': { px: 0.75 },
                          }}
                          label={
                            <Stack direction="row" alignItems="center" spacing={0.5}>
                              <Box
                                sx={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  bgcolor: option.colorHex,
                                  flexShrink: 0,
                                }}
                              />
                              <CategorySymbolDisplay value={option.iconEmoji} fontSize="1rem" />
                              <Typography component="span" variant="caption" noWrap sx={{ maxWidth: 180 }}>
                                {option.label}
                              </Typography>
                            </Stack>
                          }
                        />
                      );
                    })
                  }
                  renderInput={(params) => (
                    <TextField {...params} label="Kategorien im Diagramm" placeholder="Auswählen…" size="small" />
                  )}
                  sx={{ flex: 1, minWidth: 260, maxWidth: 640 }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() => setVerlaufSelectedKeys(keysWithSpendInVerlauf)}
                  disabled={keysWithSpendInVerlauf.length === 0}
                >
                  Alle mit Ausgaben
                </Button>
              </Stack>
              {categoryQueriesLoading ? (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Kategorienamen werden geladen…
                </Typography>
              ) : null}
              {verlaufSelectedKeys.length === 0 ? (
                <Alert severity="info">Bitte mindestens eine Kategorie auswählen.</Alert>
              ) : (
                <Box sx={{ width: '100%', minHeight: isXs ? 320 : 420, '& .apexcharts-canvas': { mx: 'auto' } }}>
                  <Chart
                    options={verlaufChart.options}
                    series={verlaufChart.series}
                    type="area"
                    height={isXs ? 340 : 440}
                    width="100%"
                  />
                </Box>
              )}
            </Paper>
          )}
          {verlaufSelectedPeriodIndex != null && sharedDataReady && analysisTransactions.length ? (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  Buchungen: Ausgaben · {verlaufSelectedPeriodTitle}
                </Typography>
                <Button size="small" variant="outlined" onClick={() => setVerlaufSelectedPeriodIndex(null)}>
                  Auswahl aufheben
                </Button>
              </Stack>
              <TransactionBookingsTable
                rows={transactionsForSelectedVerlaufPeriod}
                accounts={accounts}
                emptyMessage="Keine Ausgaben in dieser Periode (im gewählten Filter)."
                hideInlineHint
              />
            </Paper>
          ) : null}
        </>
      ) : tab === 'ausgaben_sunburst' ? (
        <>
          {firstCategoryQueryError ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Kategorien konnten nicht vollständig geladen werden: {apiErrorMessage(firstCategoryQueryError)}. Namen
              fehlen ggf. in der Auswahl.
            </Alert>
          ) : null}
          {firstRulesQueryError ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Zuordnungsregeln konnten nicht geladen werden: {apiErrorMessage(firstRulesQueryError)}.
            </Alert>
          ) : null}
          {!analysisTransactions.length ? (
            <Alert severity="info">Keine Buchungen im Zeitraum.</Alert>
          ) : (
            <Stack spacing={2}>
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  <strong>Sunburst</strong> der <strong>Ausgaben</strong> (negative Beträge, gleicher Konten- und
                  Umbuchungsfilter wie oben): von innen nach außen <strong>Hauptkategorie</strong> →{' '}
                  <strong>Unterkategorie</strong> (direktes Kind der Wurzel im Kategoriebaum) →{' '}
                  <strong>Anzeigename</strong> der ersten passenden Zuordnungsregel wie bei „Anzeigeregeln“.{' '}
                  <strong>Segment anklicken</strong>, um die Buchungen darunter zu filtern.
                </Typography>
                {categoryQueriesLoading || rulesQueriesLoading ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Kategorien und Regeln werden geladen…
                  </Typography>
                ) : null}
              </Paper>
              {!expenseSunburstSeriesData.length ? (
                <Alert severity="info">Keine Ausgaben im gewählten Zeitraum (nach Filter).</Alert>
              ) : (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Box sx={{ width: '100%', maxWidth: 900, mx: 'auto' }}>
                    <ExpenseRuleSunburstChart
                      data={expenseSunburstSeriesData}
                      height={isXs ? 420 : 520}
                      currency={defaultCurrency}
                      theme={theme}
                      onSelectPath={setExpenseSunburstSelection}
                    />
                  </Box>
                </Paper>
              )}
              {expenseSunburstSelection && sharedDataReady && analysisTransactions.length ? (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                    <Typography variant="subtitle1" fontWeight={600}>
                      Buchungen: Ausgaben · {expenseSunburstSelectionTitle} · {from}–{to}
                    </Typography>
                    <Button size="small" variant="outlined" onClick={() => setExpenseSunburstSelection(null)}>
                      Auswahl aufheben
                    </Button>
                  </Stack>
                  <TransactionBookingsTable
                    rows={transactionsForExpenseSunburstSelection}
                    accounts={accounts}
                    emptyMessage="Keine Buchungen für diese Auswahl (im gewählten Filter)."
                    hideInlineHint
                  />
                </Paper>
              ) : null}
            </Stack>
          )}
        </>
      ) : (
        <>
          {firstCategoryQueryError ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Kategorien konnten nicht vollständig geladen werden: {apiErrorMessage(firstCategoryQueryError)}. Namen
              fehlen ggf. in der Auswahl.
            </Alert>
          ) : null}
          {firstRulesQueryError ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Zuordnungsregeln konnten nicht geladen werden: {apiErrorMessage(firstRulesQueryError)}.
            </Alert>
          ) : null}
          {!analysisTransactions.length ? (
            <Alert severity="info">Keine Buchungen im Zeitraum.</Alert>
          ) : (
            <Stack spacing={2}>
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                  Ausgaben unter der gewählten Unterkategorie (inkl. tieferer Unterkategorien), gruppiert nach dem
                  effektiven <strong>Anzeigenamen</strong> der ersten passenden Zuordnungsregel pro Buchung (gleiche
                  Reihenfolge wie bei der automatischen Zuweisung). Aggregierung wie beim Kategorieverlauf.{' '}
                  <strong>Zeitdiagramm anklicken</strong>, um die Buchungen der Periode zu sehen.
                </Typography>
                <Stack
                  direction={{ xs: 'column', md: 'row' }}
                  spacing={2}
                  alignItems={{ xs: 'stretch', md: 'center' }}
                  sx={{ mt: 1 }}
                  flexWrap="wrap"
                  useFlexGap
                >
                  <FormControl size="small" sx={{ minWidth: 280, flex: { md: '1 1 280px' } }}>
                    <InputLabel id="analyses-regel-cluster-sub">Unterkategorie</InputLabel>
                    <Select
                      labelId="analyses-regel-cluster-sub"
                      label="Unterkategorie"
                      value={regelClusterSubcategoryId ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRegelClusterSubcategoryId(v === '' ? null : Number(v));
                      }}
                      renderValue={(selected) => {
                        const selectedStr = String(selected ?? '');
                        if (selectedStr === '') {
                          return (
                            <Typography component="span" color="text.secondary" fontStyle="italic" variant="body2">
                              Bitte wählen…
                            </Typography>
                          );
                        }
                        const id = Number(selectedStr);
                        const o = subcategoryPickOptions.find((x) => x.id === id);
                        if (!o) return String(selected);
                        return <RegelClusterSubcategoryRow o={o} />;
                      }}
                    >
                      <MenuItem value="">
                        <Typography component="span" color="text.secondary" fontStyle="italic" variant="body2">
                          Bitte wählen…
                        </Typography>
                      </MenuItem>
                      {subcategoryPickOptions.map((o) => (
                        <MenuItem key={o.id} value={o.id}>
                          <RegelClusterSubcategoryRow o={o} />
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 200 }}>
                    <InputLabel id="analyses-regel-cluster-bucket">Aggregierung</InputLabel>
                    <Select
                      labelId="analyses-regel-cluster-bucket"
                      label="Aggregierung"
                      value={regelClusterBucket}
                      onChange={(e) => setRegelClusterBucket(e.target.value as VerlaufBucket)}
                    >
                      <MenuItem value="day">Tag</MenuItem>
                      <MenuItem value="week">Woche</MenuItem>
                      <MenuItem value="month">Monat</MenuItem>
                    </Select>
                  </FormControl>
                </Stack>
                {categoryQueriesLoading || rulesQueriesLoading ? (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                    Kategorien und Regeln werden geladen…
                  </Typography>
                ) : null}
                {!categoryQueriesLoading && subcategoryPickOptions.length === 0 ? (
                  <Alert severity="info" sx={{ mt: 2 }}>
                    Es sind keine <strong>Unterkategorien</strong> angelegt (unter einer Hauptkategorie). Lege zuerst
                    Unterkategorien in den Kategorieeinstellungen an.
                  </Alert>
                ) : null}
              </Paper>
              {regelClusterSubcategoryId == null ? (
                <Alert severity="info">
                  Wähle oben eine <strong>Unterkategorie</strong>. Es werden alle Ausgaben in diesem Teilbaum
                  ausgewertet und nach dem <strong>Anzeigenamen</strong> der passenden Zuordnungsregel gruppiert
                  (neueste passende Regel zuerst). Buchungen ohne passende Regel erscheinen unter „Ohne passende
                  Regel“.
                </Alert>
              ) : regelClusterSubtreeIds == null ? (
                <Alert severity="warning">Die gewählte Kategorie wurde nicht gefunden (Kategoriebaum neu laden).</Alert>
              ) : regelClusterSortedKeys.length === 0 ? (
                <Alert severity="info">Keine Ausgaben in dieser Unterkategorie im gewählten Zeitraum.</Alert>
              ) : (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'stretch' }}>
                    <Box sx={{ flex: 3, minWidth: 320 }}>
                      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
                        Summen je Anzeigename
                      </Typography>
                      <Box sx={{ width: '100%', minHeight: isXs ? 260 : 320, '& .apexcharts-canvas': { mx: 'auto' } }}>
                        <Chart
                          options={regelClusterBarChart.options}
                          series={regelClusterBarChart.series}
                          type="bar"
                          height={isXs ? 280 : Math.min(120 + regelClusterSortedKeys.length * 36, 520)}
                          width="100%"
                        />
                      </Box>
                    </Box>
                    <Box sx={{ flex: 2, minWidth: 280 }}>
                      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
                        Anteile (Torte)
                      </Typography>
                      <Box sx={{ width: '100%', minHeight: isXs ? 320 : 320, '& .apexcharts-canvas': { mx: 'auto' } }}>
                        <Chart
                          options={regelClusterPieChart.options}
                          series={regelClusterPieChart.series}
                          type="donut"
                          height={isXs ? 360 : 360}
                          width="100%"
                        />
                      </Box>
                    </Box>
                  </Stack>
                  <Accordion elevation={0} sx={{ mt: 2, border: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Typography variant="subtitle2" fontWeight={600}>
                        Verlauf über die Zeit
                      </Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ pt: 0 }}>
                      <Box sx={{ width: '100%', minHeight: isXs ? 320 : 420, '& .apexcharts-canvas': { mx: 'auto' } }}>
                        <Chart
                          options={regelClusterTimeChart.options}
                          series={regelClusterTimeChart.series}
                          type="area"
                          height={isXs ? 340 : 440}
                          width="100%"
                        />
                      </Box>
                    </AccordionDetails>
                  </Accordion>
                </Paper>
              )}
            </Stack>
          )}
          {regelClusterBarClusterKey != null &&
          sharedDataReady &&
          analysisTransactions.length > 0 &&
          regelClusterSubcategoryId != null ? (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  Buchungen: Ausgaben · Anzeigename „{regelClusterBarSelectionTitle}“ · {from}–{to}
                </Typography>
                <Button size="small" variant="outlined" onClick={() => setRegelClusterBarClusterKey(null)}>
                  Auswahl aufheben
                </Button>
              </Stack>
              {transactionsForRegelClusterBarSelection.length ? (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider', mb: 2 }}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={2}
                    alignItems={{ sm: 'center' }}
                    justifyContent="space-between"
                    sx={{ mb: 1 }}
                  >
                    <Typography variant="subtitle2" fontWeight={600}>
                      Buchungsempfänger / Gegenparteien
                    </Typography>
                    {regelClusterCounterpartyKey ? (
                      <Button size="small" variant="outlined" onClick={() => setRegelClusterCounterpartyKey(null)}>
                        Filter zurücksetzen
                      </Button>
                    ) : null}
                  </Stack>
                  <Box sx={{ width: '100%', minHeight: isXs ? 260 : 320, '& .apexcharts-canvas': { mx: 'auto' } }}>
                    <Chart
                      options={regelClusterCounterpartyChart.options}
                      series={regelClusterCounterpartyChart.series}
                      type="bar"
                      height={isXs ? 280 : Math.min(140 + regelClusterCounterpartyAgg.length * 34, 520)}
                      width="100%"
                    />
                  </Box>
                  {regelClusterCounterpartyKey ? (
                    <Typography variant="caption" color="text.secondary">
                      Aktiver Filter: <strong>{regelClusterCounterpartyKey}</strong>
                    </Typography>
                  ) : null}
                  {regelClusterCounterpartyAgg.length ? (
                    <Accordion elevation={0} sx={{ mt: 2, border: 1, borderColor: 'divider', '&:before': { display: 'none' } }}>
                      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Typography variant="subtitle2" fontWeight={600}>
                          Verlauf (Gegenparteien)
                        </Typography>
                      </AccordionSummary>
                      <AccordionDetails sx={{ pt: 0 }}>
                        <Box sx={{ width: '100%', minHeight: isXs ? 320 : 420, '& .apexcharts-canvas': { mx: 'auto' } }}>
                          <Chart
                            options={regelClusterCounterpartyTimeChart.options}
                            series={regelClusterCounterpartyTimeChart.series}
                            type="area"
                            height={isXs ? 340 : 420}
                            width="100%"
                          />
                        </Box>
                      </AccordionDetails>
                    </Accordion>
                  ) : null}
                </Paper>
              ) : null}
              <TransactionBookingsTable
                rows={transactionsForRegelClusterCounterpartySelection}
                accounts={accounts}
                emptyMessage="Keine Buchungen für diesen Anzeigenamen (im gewählten Filter)."
                hideInlineHint
              />
            </Paper>
          ) : regelClusterBarClusterKey == null &&
            regelClusterPeriodIndex != null &&
            sharedDataReady &&
            analysisTransactions.length > 0 &&
            regelClusterSubcategoryId != null ? (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  Buchungen: Ausgaben · {regelClusterSelectedPeriodTitle}
                </Typography>
                <Button size="small" variant="outlined" onClick={() => setRegelClusterPeriodIndex(null)}>
                  Auswahl aufheben
                </Button>
              </Stack>
              <TransactionBookingsTable
                rows={transactionsForSelectedRegelClusterPeriod}
                accounts={accounts}
                emptyMessage="Keine Ausgaben in dieser Periode (im gewählten Filter)."
                hideInlineHint
              />
            </Paper>
          ) : null}
        </>
      )}
    </Stack>
  );
}
