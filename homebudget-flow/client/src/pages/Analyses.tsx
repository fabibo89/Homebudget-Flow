import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HTMLAttributes } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
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
import type { ApexOptions } from 'apexcharts';
import Chart from 'react-apexcharts';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  apiErrorMessage,
  fetchAccounts,
  fetchAllTransactions,
  fetchCategories,
  type CategoryOut,
  type Transaction,
} from '../api/client';
import { CategorySymbolDisplay } from '../components/CategorySymbol';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';
import { useAccountGroupLabelMap } from '../hooks/useAccountGroupLabelMap';
import { sortBankAccountsForDisplay } from '../lib/sortBankAccounts';
import {
  addMonthsToIsoDate,
  flattenCategoriesWithMeta,
  formatDate,
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
    const key = d.toISOString().slice(0, 10);
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
  return d.toISOString().slice(0, 10);
}

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
    days.push(d.toISOString().slice(0, 10));
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
  return d.toISOString().slice(0, 10);
}

function formatWeekRangeLabel(weekMondayIso: string): string {
  const start = parseIsoDate(weekMondayIso);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const short = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });
  const endLong = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
  return `${short.format(start)}–${endLong.format(end)}`;
}

function formatMonthBucketLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(d);
}

/** Tageswerte zu Wochen- oder Monatssummen zusammenfassen (Reihenfolge = erster Vorkommenstag im Filter). */
function rollupVerlaufFromDaily(daily: DailyExpenseMatrix, bucket: VerlaufBucket): VerlaufPeriodMatrix {
  const { days, byKey } = daily;
  if (bucket === 'day' || days.length === 0) {
    const periodLabels = days.map((d) =>
      new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short' }).format(parseIsoDate(d)),
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

type AnalysisTab = 'tagesbilanz' | 'kategorien' | 'kategorieverlauf';

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
              formatter: (val, opts) => {
                const i = opts?.seriesIndex;
                if (typeof i === 'number' && aggs[i]) {
                  return formatMoneyShort(aggs[i].sum, defaultCurrency);
                }
                return formatMoneyShort(Number(val), defaultCurrency);
              },
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
        const i = opts.seriesIndex;
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
        const i = opts.seriesIndex;
        const a = aggs[i];
        if (!a) return legendName;
        return `${legendName} (${formatMoneyFull(a.sum, defaultCurrency)})`;
      },
    },
    tooltip: {
      theme: theme.palette.mode,
      y: {
        formatter: (_val, opts) => {
          const i = opts.seriesIndex;
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
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const defaultFrom = useMemo(() => addDays(today, -30), [today]);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [accountFilter, setAccountFilter] = useState<number | 'all'>('all');
  const [selectedBarDay, setSelectedBarDay] = useState<string | null>(null);
  const [selectedCategorySlice, setSelectedCategorySlice] = useState<CategorySliceSelection | null>(null);
  const [verlaufSelectedKeys, setVerlaufSelectedKeys] = useState<string[]>([]);
  const [verlaufBucket, setVerlaufBucket] = useState<VerlaufBucket>('week');
  const [verlaufSelectedPeriodIndex, setVerlaufSelectedPeriodIndex] = useState<number | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
  });

  const { groupLabelById } = useAccountGroupLabelMap();

  const rangeOk = from <= to;
  const txQuery = useQuery({
    queryKey: ['analyses-transactions', from, to, accountFilter],
    queryFn: () =>
      fetchAllTransactions({
        from: from || undefined,
        to: to || undefined,
        bank_account_id: accountFilter === 'all' ? undefined : accountFilter,
      }),
    enabled: rangeOk && (tab === 'tagesbilanz' || tab === 'kategorien' || tab === 'kategorieverlauf'),
  });

  useEffect(() => {
    setSelectedBarDay(null);
    setSelectedCategorySlice(null);
    setVerlaufSelectedPeriodIndex(null);
  }, [from, to, accountFilter, verlaufBucket]);

  function handleTabChange(_: unknown, v: AnalysisTab) {
    setTab(v);
    setSelectedBarDay(null);
    setSelectedCategorySlice(null);
    setVerlaufSelectedPeriodIndex(null);
  }

  const accounts = useMemo(
    () => sortBankAccountsForDisplay(accountsQuery.data ?? [], groupLabelById),
    [accountsQuery.data, groupLabelById],
  );
  const defaultCurrency = accounts[0]?.currency ?? 'EUR';

  const daily = useMemo(() => {
    if (!txQuery.data) return [];
    return dailyNetSums(txQuery.data, from, to);
  }, [txQuery.data, from, to]);

  const cumulative = useMemo(() => cumulativeFromDaily(daily), [daily]);

  const categoryAggsIncome = useMemo(() => {
    if (!txQuery.data?.length) return [];
    return aggregateByCategory(txQuery.data.filter((t) => Number(t.amount) > 0));
  }, [txQuery.data]);

  const categoryAggsExpense = useMemo(() => {
    if (!txQuery.data?.length) return [];
    return aggregateByCategory(txQuery.data.filter((t) => Number(t.amount) < 0));
  }, [txQuery.data]);

  const dailyExpenseMatrix = useMemo(
    () =>
      txQuery.data?.length
        ? buildDailyExpenseMatrix(txQuery.data, from, to)
        : { days: [] as string[], byKey: new Map<string, number[]>() },
    [txQuery.data, from, to],
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
  }, [from, to, accountFilter, keysWithSpendSignature]);

  const householdIdsForCategories = useMemo(() => {
    const s = new Set<number>();
    for (const a of accounts) s.add(a.household_id);
    return [...s].sort((a, b) => a - b);
  }, [accounts]);

  const categoryQueries = useQueries({
    queries: householdIdsForCategories.map((hid) => ({
      queryKey: ['categories', hid],
      queryFn: () => fetchCategories(hid),
      enabled: rangeOk && tab === 'kategorieverlauf' && householdIdsForCategories.length > 0,
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
    const all = txQuery.data;
    if (all == null || verlaufSelectedPeriodIndex == null) return [];
    const daysIn = verlaufPeriodMatrix.periodDays[verlaufSelectedPeriodIndex];
    if (!daysIn?.length) return [];
    const daySet = new Set(daysIn);
    return all
      .filter((t) => Number(t.amount) < 0 && daySet.has(t.booking_date.slice(0, 10)))
      .slice()
      .sort((a, b) => b.id - a.id);
  }, [txQuery.data, verlaufSelectedPeriodIndex, verlaufPeriodMatrix.periodDays]);

  const verlaufSelectedPeriodTitle = useMemo(() => {
    if (verlaufSelectedPeriodIndex == null) return '';
    const label = verlaufPeriodMatrix.periodLabels[verlaufSelectedPeriodIndex] ?? '';
    const raster =
      verlaufBucket === 'day' ? 'Tag' : verlaufBucket === 'week' ? 'Woche' : 'Monat';
    return `${raster} · ${label}`;
  }, [verlaufSelectedPeriodIndex, verlaufPeriodMatrix.periodLabels, verlaufBucket]);

  const transactionsForSelectedDay = useMemo(() => {
    const all = txQuery.data;
    if (!all || !selectedBarDay) return [];
    return all
      .filter((t) => t.booking_date.slice(0, 10) === selectedBarDay)
      .slice()
      .sort((a, b) => b.id - a.id);
  }, [txQuery.data, selectedBarDay]);

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
    const labels = daily.map((d) =>
      new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short' }).format(parseIsoDate(d.day)),
    );

    const rangeData = daily.map((d, i) => {
      const prev = i === 0 ? 0 : cumulative[i - 1];
      const curr = cumulative[i];
      const low = Math.min(prev, curr);
      const high = Math.max(prev, curr);
      return {
        x: labels[i],
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
        type: 'category',
        tickAmount: Math.min(12, Math.max(4, Math.floor(labels.length / 14))),
        labels: {
          rotate: -45,
          rotateAlways: labels.length > 14,
          style: { fontSize: '11px' },
        },
        title: { text: 'Buchungstag' },
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
  }, [daily, cumulative, theme, defaultCurrency, posColor, negColor]);

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
        categoryAggsIncome,
        'income',
        theme,
        defaultCurrency,
        piePalette,
        (key) => setSelectedCategorySlice({ flow: 'income', categoryKey: key }),
      ),
    [categoryAggsIncome, theme, defaultCurrency, piePalette],
  );

  const expenseDonut = useMemo(
    () =>
      createCategoryDonutConfig(
        categoryAggsExpense,
        'expense',
        theme,
        defaultCurrency,
        piePalette,
        (key) => setSelectedCategorySlice({ flow: 'expense', categoryKey: key }),
      ),
    [categoryAggsExpense, theme, defaultCurrency, piePalette],
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

  const toggleVerlaufSubtree = useCallback((subtreeKeys: string[]) => {
    setVerlaufSelectedKeys((prev) => {
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
      const icon = opt.iconEmoji?.trim();
      const name = icon ? `${icon} ${opt.label}` : opt.label;
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
        markers: { width: 12, height: 12, radius: 2 },
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
    const end = new Date().toISOString().slice(0, 10);
    let start: string;
    if (preset === 'ytd') {
      start = `${new Date().getFullYear()}-01-01`;
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
  const sharedDataReady = rangeOk && !sharedLoading && !sharedError && txQuery.data;
  const categoryQueriesLoading =
    tab === 'kategorieverlauf' && categoryQueries.some((q) => q.isLoading);
  const firstCategoryQueryError = categoryQueries.find((q) => q.isError)?.error;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Analysen
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Diagramme zu Buchungen und Kategorien. Tagesbilanz: kumulierter Verlauf. Kategorien: Torten für Einnahmen
          und Ausgaben. Kategorieverlauf: gestapelte Flächen – Ausgaben (Absolutbeträge) je Kategorie, wahlweise nach
          Tag, Woche oder Monat aggregiert.
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
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="analyses-acc">Konto</InputLabel>
              <Select
                labelId="analyses-acc"
                label="Konto"
                value={accountFilter}
                onChange={(e) => {
                  const v = e.target.value;
                  setAccountFilter(v === 'all' ? 'all' : Number(v));
                }}
              >
                <MenuItem value="all">Alle Konten</MenuItem>
                {accounts.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button variant="outlined" onClick={() => void txQuery.refetch()} disabled={txQuery.isFetching || !rangeOk}>
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
      ) : tab === 'tagesbilanz' ? (
        <>
          {daily.length === 0 ? (
            <Alert severity="info">Keine Tage im Zeitraum.</Alert>
          ) : (
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
          {!txQuery.data?.length ? (
            <Alert severity="info">Keine Buchungen im Zeitraum.</Alert>
          ) : (
            <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                <strong>Einnahmen-Torte</strong>: nur Buchungen mit positivem Betrag. <strong>Ausgaben-Torte</strong>: nur
                negative Beträge (Scheibengröße nach Summe im Absolutbetrag, Beschriftung mit Vorzeichen).{' '}
                <strong>Segment anklicken</strong> für die Buchungsliste unten.
              </Typography>
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
                  {categoryAggsIncome.length === 0 ? (
                    <Alert severity="info" sx={{ mt: 1 }}>
                      Keine Einnahmen im Zeitraum.
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
                  {categoryAggsExpense.length === 0 ? (
                    <Alert severity="info" sx={{ mt: 1 }}>
                      Keine Ausgaben im Zeitraum.
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
            </Paper>
          )}
          {selectedCategorySlice && sharedDataReady && txQuery.data?.length ? (
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
      ) : (
        <>
          {firstCategoryQueryError ? (
            <Alert severity="warning" sx={{ mb: 1 }}>
              Kategorien konnten nicht vollständig geladen werden: {apiErrorMessage(firstCategoryQueryError)}. Namen
              fehlen ggf. in der Auswahl.
            </Alert>
          ) : null}
          {!txQuery.data?.length ? (
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
          {verlaufSelectedPeriodIndex != null && sharedDataReady && txQuery.data?.length ? (
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
      )}
    </Stack>
  );
}
