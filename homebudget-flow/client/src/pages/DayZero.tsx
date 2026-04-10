import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  InputLabel,
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
  Typography,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import Chart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import {
  fetchAccounts,
  fetchDayZeroMeltdown,
  fetchTransactions,
  type BankAccount,
  type DayZeroMeltdownOut,
  type Transaction,
} from '../api/client';
import { apiErrorMessage } from '../api/client';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';
import { formatMoney } from '../lib/transactionUi';
import { getAppTimeZone } from '../lib/appTimeZone';

/** Vertikaler Trenner zwischen Konto-, Meltdown- und Differenz-Block in der Day-Zero-Saldo-Tabelle. */
const dayZeroSaldoTableSectionDividerSx = {
  borderLeft: '1px solid',
  borderLeftColor: 'divider',
} as const;

function accountHasTagZeroRule(a: BankAccount): boolean {
  // Heuristic: rule config is stored on account, but not part of BankAccount type.
  // We filter by presence of tag_zero_date (computed field) to show only accounts that are configured and have D0.
  return Boolean(a.day_zero_date?.trim());
}

function isoDayInTimeZone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = get('year');
  const m = get('month');
  const day = get('day');
  return `${y}-${m}-${day}`;
}

/** Ab Tag nach ``todayIso`` (YYYY-MM-DD, exkl.) Werte auf ``null`` — Linien enden am letzten sichtbaren Tag. */
function maskSeriesAfterCalendarDay(
  dayIsos: string[],
  values: (number | null)[],
  todayIso: string,
): (number | null)[] {
  return values.map((v, i) => {
    const d = dayIsos[i]?.slice(0, 10);
    if (d == null || d > todayIso) return null;
    return v;
  });
}

function collectFiniteSeriesValues(seriesArrays: readonly (readonly (number | null)[])[]): number[] {
  const nums: number[] = [];
  for (const arr of seriesArrays) {
    for (const v of arr) {
      if (typeof v === 'number' && Number.isFinite(v)) nums.push(v);
    }
  }
  return nums;
}

/**
 * Y-Achsen-Minimum anheben, wenn unterhalb der Linien nur Luft wäre.
 * Untergrenze nur aus ``linesForMin`` (ohne Ausgaben-Balken), sonst ziehen viele 0€-Tage das Minimum auf 0.
 * ``allForMax`` inkl. Balken, damit die Skala nach oben nicht abschneidet.
 */
function yAxisMinTrimZeroGap(args: {
  linesForMin: readonly (readonly (number | null)[])[];
  allForMax?: readonly (readonly (number | null)[])[];
}): number | undefined {
  const minNums = collectFiniteSeriesValues(args.linesForMin);
  const maxNums = collectFiniteSeriesValues(args.allForMax ?? args.linesForMin);
  if (minNums.length === 0 || maxNums.length === 0) return undefined;
  const minV = Math.min(...minNums);
  if (minV < 0) return undefined;
  const positives = minNums.filter((n) => n > 0);
  if (positives.length === 0) return undefined;
  const minPos = Math.min(...positives);
  const maxV = Math.max(...maxNums);
  const span = maxV - minPos;
  const pad = span > 0 ? span * 0.06 : Math.max(minPos * 0.02, 1);
  return minPos - pad;
}

function diffColor(args: { goodWhen: 'positive' | 'negative' | 'zeroOrPositive' | 'zeroOrNegative'; diff: number }): string {
  const { goodWhen, diff } = args;
  const ok =
    (goodWhen === 'positive' && diff > 0) ||
    (goodWhen === 'negative' && diff < 0) ||
    (goodWhen === 'zeroOrPositive' && diff >= 0) ||
    (goodWhen === 'zeroOrNegative' && diff <= 0);
  return ok ? 'success.main' : 'error.main';
}

function valueSignColor(v: number): string {
  if (v > 0) return 'success.main';
  if (v < 0) return 'error.main';
  return 'text.secondary';
}

/** Einheitlich europäisch (de-DE), z. B. 02.03.2026 — für Achsen, Tooltips und Texte. */
function formatEuropeanDate(isoDay: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone,
    }).format(new Date(`${isoDay.slice(0, 10)}T12:00:00Z`));
  } catch {
    return isoDay;
  }
}

/** Eröffnung vor Buchungen am Tag Null (API ``konto_saldo_start_backcalc`` / ``tag_zero_amount``). */
function tableKontoStart(data: DayZeroMeltdownOut): number | null {
  const raw =
    data.konto_saldo_start_backcalc != null && String(data.konto_saldo_start_backcalc).trim() !== ''
      ? data.konto_saldo_start_backcalc
      : data.tag_zero_amount != null && String(data.tag_zero_amount).trim() !== ''
        ? data.tag_zero_amount
        : '';
  if (raw === '') return null;
  const v = Number(raw);
  return Number.isNaN(v) ? null : v;
}

/** Meltdown-Start wie Tabellenspalte (``tag_zero_rule_booking_amount``). */
function tableMeltdownStart(data: DayZeroMeltdownOut): number | null {
  if (data.tag_zero_rule_booking_amount == null || String(data.tag_zero_rule_booking_amount).trim() === '') {
    return null;
  }
  const v = Number(data.tag_zero_rule_booking_amount);
  return Number.isNaN(v) ? null : v;
}

function kontoBalanceIstDay(d: DayZeroMeltdownOut['days'][number]): number {
  const s = (d as { konto_balance_actual?: string }).konto_balance_actual ?? d.balance_actual;
  const v = Number(s);
  return Number.isNaN(v) ? 0 : v;
}

function kontoBalanceSollDay(d: DayZeroMeltdownOut['days'][number]): number {
  const s = (d as { konto_balance_target?: string }).konto_balance_target ?? d.balance_target;
  const v = Number(s);
  return Number.isNaN(v) ? 0 : v;
}

/**
 * Fixe Konto-Tagesrate (unten): wie „Konto · Soll“ oben = konto_balance_target am ersten Tag / n.
 * Fallback: konto_saldo_start_backcalc / n.
 */
function kontoFixProTagRate(data: DayZeroMeltdownOut): number | null {
  const n = data.days.length;
  if (n <= 0) return null;
  const d0 = data.days[0];
  if (d0 != null) {
    const anchor = kontoBalanceSollDay(d0);
    if (Number.isFinite(anchor)) return anchor / n;
  }
  const ts = tableKontoStart(data);
  return ts != null && Number.isFinite(Number(ts)) ? Number(ts) / n : null;
}

/** Startwert für Meltdown Soll/Ist: Regel-Buchung am Tag Null, sonst Meltdown-Start / erster Meltdown-Saldo. */
function meltdownDayZeroStart(data: DayZeroMeltdownOut): number | null {
  const ruleBooking =
    data.tag_zero_rule_booking_amount != null && String(data.tag_zero_rule_booking_amount).trim() !== ''
      ? Number(data.tag_zero_rule_booking_amount)
      : null;
  if (ruleBooking != null && !Number.isNaN(ruleBooking)) return ruleBooking;
  const mdStart =
    data.meltdown_start_amount != null && String(data.meltdown_start_amount).trim() !== ''
      ? Number(data.meltdown_start_amount)
      : null;
  if (mdStart != null && !Number.isNaN(mdStart)) return mdStart;
  const d0 = data.days[0]?.balance_actual != null ? Number(data.days[0].balance_actual) : null;
  if (d0 != null && !Number.isNaN(d0)) return d0;
  return null;
}

function buildSaldoChart(args: {
  data: DayZeroMeltdownOut;
  showMeltdownIst: boolean;
  showMeltdownSoll: boolean;
  showSaldoIst: boolean;
  showSaldoSoll: boolean;
  showAusgaben: boolean;
  onToggleMeltdownIst: () => void;
  onToggleMeltdownSoll: () => void;
  onToggleSaldoIst: () => void;
  onToggleSaldoSoll: () => void;
  onToggleAusgaben: () => void;
  onPickSpendDay: (isoDay: string) => void;
}): { options: ApexOptions; series: any[] } {
  const {
    data,
    showMeltdownIst,
    showMeltdownSoll,
    showSaldoIst,
    showSaldoSoll,
    showAusgaben,
    onToggleMeltdownIst,
    onToggleMeltdownSoll,
    onToggleSaldoIst,
    onToggleSaldoSoll,
    onToggleAusgaben,
    onPickSpendDay,
  } = args;
  const tz = getAppTimeZone();
  const todayIso = isoDayInTimeZone(new Date(), tz);
  const dayIsos = data.days.map((d) => d.day);
  const cats = dayIsos;
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const meltdownStart = meltdownDayZeroStart(data);
  const downmelt =
    meltdownStart == null || Number.isNaN(meltdownStart)
      ? null
      : data.days.map((_, i) => {
          const denom = Math.max(1, data.days.length - 1);
          const f = 1 - i / denom;
          return meltdownStart * f;
        });
  // Meltdown · Ist = Server-Pfad (balance_actual ≡ konto_balance_actual), nicht meltdownStart + net_actual.
  const lived =
    data.days.length === 0 ? null : data.days.map((d) => kontoBalanceIstDay(d));
  const livedMasked = lived ? maskSeriesAfterCalendarDay(dayIsos, lived, todayIso) : null;

  const saldoIstData = maskSeriesAfterCalendarDay(
    dayIsos,
    showSaldoIst ? data.days.map((d) => kontoBalanceIstDay(d)) : data.days.map(() => null),
    todayIso,
  );
  const saldoSollData = showSaldoSoll
    ? data.days.map((d) => kontoBalanceSollDay(d))
    : data.days.map(() => null);
  const spendBars = data.days.map((d) => Number(d.spend_actual)); // Ausgaben als positive Balken

  const saldoIstForYBounds = maskSeriesAfterCalendarDay(
    dayIsos,
    data.days.map((d) => kontoBalanceIstDay(d)),
    todayIso,
  );
  const saldoSollForYBounds = data.days.map((d) => kontoBalanceSollDay(d));
  const saldoLinesForYMin = [
    ...(livedMasked ? [livedMasked] : []),
    ...(downmelt ? [downmelt] : []),
    saldoIstForYBounds,
    saldoSollForYBounds,
  ];
  const yAxisMinSaldo = yAxisMinTrimZeroGap({
    linesForMin: saldoLinesForYMin,
    allForMax: [...saldoLinesForYMin, spendBars],
  });

  const nullLine = data.days.map(() => null);
  // Reihenfolge: Meltdown (Ist/Soll) zuerst (voll), Konto (Saldo) danach (dünner).
  const series = [
    ...(livedMasked ? [{ name: 'Meltdown · Ist', data: showMeltdownIst ? livedMasked : nullLine }] : []),
    ...(downmelt ? [{ name: 'Meltdown · Soll', data: showMeltdownSoll ? downmelt : nullLine }] : []),
    { name: 'Konto · Ist', data: saldoIstData },
    { name: 'Konto · Soll', data: saldoSollData },
    { name: 'Ausgaben', type: 'column', data: showAusgaben ? spendBars : nullLine },
  ];

  /** Meltdown = blaue Familie; Konto (Saldo) = grüne Familie; Soll-Linien gestrichelt. */
  const COLOR_MELTDOWN_IST_LINE = '#008FFB';
  const COLOR_MELTDOWN_SOLL_LINE = '#00E396';
  const COLOR_AUSGABEN = '#FEB019';
  const strokeStyles = series.map((s: { name?: string; type?: string }) => {
    const n = String(s.name ?? '');
    if (n === 'Meltdown · Ist') return { w: 3, dash: 0, color: COLOR_MELTDOWN_IST_LINE };
    if (n === 'Meltdown · Soll') return { w: 3, dash: 6, color: COLOR_MELTDOWN_IST_LINE };
    if (n === 'Konto · Ist') return { w: 2, dash: 0, color: COLOR_MELTDOWN_SOLL_LINE };
    if (n === 'Konto · Soll') return { w: 2, dash: 6, color: COLOR_MELTDOWN_SOLL_LINE };
    return { w: 0, dash: 0, color: COLOR_AUSGABEN };
  });

  const options: ApexOptions = {
    chart: {
      type: 'line',
      height: 340,
      toolbar: { show: false },
      zoom: { enabled: false },
      events: {
        legendClick: (_chartCtx, seriesIndex, config) => {
          const name = String(config?.globals?.seriesNames?.[seriesIndex] ?? '');
          if (name === 'Meltdown · Ist') onToggleMeltdownIst();
          else if (name === 'Meltdown · Soll') onToggleMeltdownSoll();
          else if (name === 'Konto · Ist') onToggleSaldoIst();
          else if (name === 'Konto · Soll') onToggleSaldoSoll();
          else if (name === 'Ausgaben') onToggleAusgaben();
          return false; // prevent Apex default hide/show
        },
        dataPointSelection: (_event, _chartCtx, cfg) => {
          const si = cfg?.seriesIndex;
          const di = cfg?.dataPointIndex;
          const name = String(cfg?.w?.globals?.seriesNames?.[si] ?? '');
          if (name !== 'Ausgaben' || !showAusgaben) return;
          const day = cats?.[di];
          if (isIsoDay(day)) onPickSpendDay(day);
        },
      },
    },
    colors: strokeStyles.map((s) => s.color),
    plotOptions: { bar: { columnWidth: '55%' } },
    grid: {
      borderColor: 'rgba(255,255,255,0.10)',
      strokeDashArray: 0,
      xaxis: { lines: { show: false } },
      yaxis: { lines: { show: true } },
    },
    stroke: {
      width: strokeStyles.map((s) => s.w),
      curve: 'smooth',
      dashArray: strokeStyles.map((s) => s.dash),
    },
    markers: { size: 0 },
    xaxis: {
      categories: cats,
      axisBorder: { show: true, color: 'rgba(255,255,255,0.12)' },
      axisTicks: { show: true, color: 'rgba(255,255,255,0.12)' },
      labels: {
        rotate: -45,
        formatter: (v: any) => {
          if (!isIsoDay(v)) return String(v);
          return formatEuropeanDate(v, tz);
        },
      },
    },
    annotations: {
      yaxis: [
        {
          y: 0,
          borderColor: 'rgba(255,255,255,0.85)',
          borderWidth: 2,
          strokeDashArray: 0,
        },
      ],
    },
    yaxis: {
      ...(yAxisMinSaldo != null ? { min: yAxisMinSaldo } : {}),
      axisBorder: { show: true, color: 'rgba(255,255,255,0.12)' },
      axisTicks: { show: true, color: 'rgba(255,255,255,0.12)' },
      labels: { formatter: (v: number) => formatMoney(String(v.toFixed(2)), data.currency) },
    },
    tooltip: {
      shared: true,
      intersect: false,
      theme: 'dark',
      fillSeriesColor: false,
      style: { fontSize: '12px' },
      custom: ({ dataPointIndex, w }) => {
        const xRaw = w?.globals?.categoryLabels?.[dataPointIndex] ?? w?.globals?.labels?.[dataPointIndex];
        const x = isIsoDay(xRaw) ? formatEuropeanDate(xRaw, tz) : String(xRaw ?? '');
        const rows: string[] = [];
        const names: string[] = w?.globals?.seriesNames ?? [];
        const series: any[] = w?.globals?.series ?? [];
        for (let i = 0; i < names.length; i++) {
          const v = series?.[i]?.[dataPointIndex];
          const n = names[i] ?? '';
          const num = typeof v === 'number' ? v : v == null ? NaN : Number(v);
          if (!Number.isFinite(num)) continue;
          rows.push(
            `<div style="display:flex;justify-content:space-between;gap:12px;">` +
              `<span>${n}</span>` +
              `<span style="font-variant-numeric:tabular-nums;font-weight:700;">${formatMoney(num.toFixed(2), data.currency)}</span>` +
            `</div>`,
          );
        }
        return (
          `<div style="padding:10px 12px;min-width:220px">` +
            `<div style="opacity:.85;margin-bottom:6px">${x}</div>` +
            rows.join('') +
          `</div>`
        );
      },
    },
    legend: {
      position: 'top',
      onItemClick: { toggleDataSeries: false },
      onItemHover: { highlightDataSeries: false },
      formatter: (seriesName: string) => {
        const disabled =
          (seriesName === 'Meltdown · Ist' && !showMeltdownIst) ||
          (seriesName === 'Meltdown · Soll' && !showMeltdownSoll) ||
          (seriesName === 'Konto · Ist' && !showSaldoIst) ||
          (seriesName === 'Konto · Soll' && !showSaldoSoll) ||
          (seriesName === 'Ausgaben' && !showAusgaben);
        return disabled ? `<span style="opacity:0.45">${seriesName}</span>` : seriesName;
      },
    },
  };
  return { options, series };
}

/** Geld-pro-Tag: Konto-Ist aus konto_balance_actual; Konto-Soll-Fix = erster konto_balance_target / n (wie Saldo-Diagramm). */
function buildGeldProTagChart(args: {
  data: DayZeroMeltdownOut;
  showMeltdownIst: boolean;
  showMeltdownStart: boolean;
  showKontoIst: boolean;
  showKontoStart: boolean;
  showAusgaben: boolean;
  showAusgabenKumAvg: boolean;
  showKontoSollKumAvg: boolean;
  showMeltdownSollKumAvg: boolean;
  onToggleMeltdownIst: () => void;
  onToggleMeltdownStart: () => void;
  onToggleKontoIst: () => void;
  onToggleKontoStart: () => void;
  onToggleAusgaben: () => void;
  onToggleAusgabenKumAvg: () => void;
  onToggleKontoSollKumAvg: () => void;
  onToggleMeltdownSollKumAvg: () => void;
  onPickSpendDay: (isoDay: string) => void;
}): { options: ApexOptions; series: any[] } {
  const {
    data,
    showMeltdownIst,
    showMeltdownStart,
    showKontoIst,
    showKontoStart,
    showAusgaben,
    showAusgabenKumAvg,
    showKontoSollKumAvg,
    showMeltdownSollKumAvg,
    onToggleMeltdownIst,
    onToggleMeltdownStart,
    onToggleKontoIst,
    onToggleKontoStart,
    onToggleAusgaben,
    onToggleAusgabenKumAvg,
    onToggleKontoSollKumAvg,
    onToggleMeltdownSollKumAvg,
    onPickSpendDay,
  } = args;
  const tz = getAppTimeZone();
  const todayIso = isoDayInTimeZone(new Date(), tz);
  const dayIsos = data.days.map((x) => x.day);
  const cats = dayIsos;
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const n = data.days.length;
  const kontoFixRate = kontoFixProTagRate(data);
  const md0 = meltdownDayZeroStart(data);
  const hasMd = md0 != null && !Number.isNaN(md0);

  const livedMeltdown: number[] | null =
    n === 0 ? null : data.days.map((d) => kontoBalanceIstDay(d));

  const kontoStartPerDay =
    n > 0 && kontoFixRate != null && Number.isFinite(kontoFixRate)
      ? data.days.map(() => kontoFixRate)
      : data.days.map(() => null);
  const kontoIstPerDay = data.days.map((_, i) => {
    const left = n - i;
    if (left <= 0) return null;
    const bal = kontoBalanceIstDay(data.days[i]);
    if (!Number.isFinite(bal)) return null;
    return bal / left;
  });
  const meltdownStartPerDay =
    n > 0 && hasMd ? data.days.map(() => (md0 as number) / n) : data.days.map(() => null);
  const meltdownIstPerDay = data.days.map((_, i) => {
    if (!livedMeltdown) return null;
    const left = n - i;
    if (left <= 0) return null;
    return livedMeltdown[i] / left;
  });

  /** Kumulativer Durchschnitt: Summe Ausgaben 0..i geteilt durch (i+1) — wie Tabelle „Geld pro Tag“. */
  const ausgabenKumAvgRaw: (number | null)[] = (() => {
    if (n === 0) return [];
    let run = 0;
    return data.days.map((row, i) => {
      run += Number(row.spend_actual ?? 0);
      const days = i + 1;
      return days > 0 ? run / days : null;
    });
  })();
  const saldoTabChart = tableKontoStart(data);
  const meltdownTabChart = tableMeltdownStart(data);
  const denomM = Math.max(1, n - 1);
  const kontoSollKumAvgRaw: (number | null)[] = data.days.map((row, i) => {
    if (saldoTabChart == null || Number.isNaN(saldoTabChart)) return null;
    const soll = kontoBalanceSollDay(row);
    if (!Number.isFinite(soll)) return null;
    const days = i + 1;
    return (saldoTabChart - soll) / days;
  });
  const meltdownSollKumAvgRaw: (number | null)[] = data.days.map((_, i) => {
    if (!hasMd || meltdownTabChart == null || Number.isNaN(meltdownTabChart)) return null;
    const soll = (md0 as number) * (1 - i / denomM);
    const days = i + 1;
    return (meltdownTabChart - soll) / days;
  });

  const nullLine = data.days.map(() => null);
  const mdIstMasked = maskSeriesAfterCalendarDay(dayIsos, meltdownIstPerDay, todayIso);
  const kIstMasked = maskSeriesAfterCalendarDay(dayIsos, kontoIstPerDay, todayIso);
  const ausgabenKumAvgMasked = maskSeriesAfterCalendarDay(dayIsos, ausgabenKumAvgRaw, todayIso);
  const kontoSollKumAvgMasked = maskSeriesAfterCalendarDay(dayIsos, kontoSollKumAvgRaw, todayIso);
  const meltdownSollKumAvgMasked = maskSeriesAfterCalendarDay(dayIsos, meltdownSollKumAvgRaw, todayIso);
  const spendBars = data.days.map((x) => Number(x.spend_actual));
  const geldLinesForYMin = [
    mdIstMasked,
    meltdownStartPerDay,
    kIstMasked,
    kontoStartPerDay,
    ausgabenKumAvgMasked,
    kontoSollKumAvgMasked,
    meltdownSollKumAvgMasked,
  ];
  const yAxisMinGeld = yAxisMinTrimZeroGap({
    linesForMin: geldLinesForYMin,
    allForMax: [...geldLinesForYMin, spendBars],
  });

  const COLOR_MD = '#008FFB';
  const COLOR_KONTO = '#00E396';
  const COLOR_BAR = '#FEB019';
  const COLOR_AUSGABEN_KUM = '#FDD835';
  const COLOR_KONTO_SOLL_KUM = '#A7FFEB';
  const COLOR_MD_SOLL_KUM = '#82B1FF';

  // Soll (Fixrate): unmaskiert über den ganzen geladenen Zeitraum; Ist endet am Kalendertag „heute“.
  const series = [
    { name: 'Meltdown · Ist', data: showMeltdownIst ? mdIstMasked : nullLine },
    { name: 'Meltdown · Soll', data: showMeltdownStart ? meltdownStartPerDay : nullLine },
    { name: 'Meltdown · Soll Ø kumul.', data: showMeltdownSollKumAvg ? meltdownSollKumAvgMasked : nullLine },
    { name: 'Konto · Ist', data: showKontoIst ? kIstMasked : nullLine },
    { name: 'Konto · Soll', data: showKontoStart ? kontoStartPerDay : nullLine },
    { name: 'Konto · Soll Ø kumul.', data: showKontoSollKumAvg ? kontoSollKumAvgMasked : nullLine },
    { name: 'Ausgaben · Ø kumul.', data: showAusgabenKumAvg ? ausgabenKumAvgMasked : nullLine },
    { name: 'Ausgaben', type: 'column', data: showAusgaben ? spendBars : nullLine },
  ];

  const strokeStyles = series.map((s: { name?: string; type?: string }) => {
    const nm = String(s.name ?? '');
    if (nm === 'Meltdown · Ist') return { w: 3, dash: 0, color: COLOR_MD };
    if (nm === 'Meltdown · Soll') return { w: 3, dash: 6, color: COLOR_MD };
    if (nm === 'Konto · Ist') return { w: 2, dash: 0, color: COLOR_KONTO };
    if (nm === 'Konto · Soll') return { w: 2, dash: 6, color: COLOR_KONTO };
    if (nm === 'Ausgaben · Ø kumul.') return { w: 3, dash: 0, color: COLOR_AUSGABEN_KUM };
    if (nm === 'Konto · Soll Ø kumul.') return { w: 2, dash: 4, color: COLOR_KONTO_SOLL_KUM };
    if (nm === 'Meltdown · Soll Ø kumul.') return { w: 2, dash: 4, color: COLOR_MD_SOLL_KUM };
    return { w: 0, dash: 0, color: COLOR_BAR };
  });

  const options: ApexOptions = {
    chart: {
      type: 'line',
      height: 340,
      stacked: false,
      toolbar: { show: false },
      zoom: { enabled: false },
      events: {
        legendClick: (_chartCtx, seriesIndex, config) => {
          const name = String(config?.globals?.seriesNames?.[seriesIndex] ?? '');
          if (name === 'Meltdown · Ist') onToggleMeltdownIst();
          else if (name === 'Meltdown · Soll') onToggleMeltdownStart();
          else if (name === 'Meltdown · Soll Ø kumul.') onToggleMeltdownSollKumAvg();
          else if (name === 'Konto · Ist') onToggleKontoIst();
          else if (name === 'Konto · Soll') onToggleKontoStart();
          else if (name === 'Konto · Soll Ø kumul.') onToggleKontoSollKumAvg();
          else if (name === 'Ausgaben · Ø kumul.') onToggleAusgabenKumAvg();
          else if (name === 'Ausgaben') onToggleAusgaben();
          return false;
        },
        dataPointSelection: (_event, _chartCtx, cfg) => {
          const si = cfg?.seriesIndex;
          const di = cfg?.dataPointIndex;
          const name = String(cfg?.w?.globals?.seriesNames?.[si] ?? '');
          if (name !== 'Ausgaben' || !showAusgaben) return;
          const day = cats?.[di];
          if (isIsoDay(day)) onPickSpendDay(day);
        },
      },
    },
    colors: strokeStyles.map((s) => s.color),
    plotOptions: { bar: { columnWidth: '55%' } },
    stroke: { width: strokeStyles.map((s) => s.w), curve: 'smooth', dashArray: strokeStyles.map((s) => s.dash) },
    markers: { size: 0 },
    grid: {
      borderColor: 'rgba(255,255,255,0.10)',
      strokeDashArray: 0,
      xaxis: { lines: { show: false } },
      yaxis: { lines: { show: true } },
    },
    xaxis: {
      categories: cats,
      axisBorder: { show: true, color: 'rgba(255,255,255,0.12)' },
      axisTicks: { show: true, color: 'rgba(255,255,255,0.12)' },
      labels: {
        rotate: -45,
        formatter: (v: any) => {
          if (!isIsoDay(v)) return String(v);
          return formatEuropeanDate(v, tz);
        },
      },
    },
    annotations: {
      yaxis: [
        {
          y: 0,
          borderColor: 'rgba(255,255,255,0.85)',
          borderWidth: 2,
          strokeDashArray: 0,
        },
      ],
    },
    yaxis: {
      ...(yAxisMinGeld != null ? { min: yAxisMinGeld } : {}),
      axisBorder: { show: true, color: 'rgba(255,255,255,0.12)' },
      axisTicks: { show: true, color: 'rgba(255,255,255,0.12)' },
      labels: { formatter: (v: number) => formatMoney(String(v.toFixed(2)), data.currency) },
    },
    tooltip: {
      shared: true,
      intersect: false,
      theme: 'dark',
      fillSeriesColor: false,
      style: { fontSize: '12px' },
      custom: ({ dataPointIndex, w }) => {
        const xRaw = w?.globals?.categoryLabels?.[dataPointIndex] ?? w?.globals?.labels?.[dataPointIndex];
        const x = isIsoDay(xRaw) ? formatEuropeanDate(xRaw, tz) : String(xRaw ?? '');
        const rows: string[] = [];
        const names: string[] = w?.globals?.seriesNames ?? [];
        const ser: any[] = w?.globals?.series ?? [];
        for (let i = 0; i < names.length; i++) {
          const v = ser?.[i]?.[dataPointIndex];
          const n = names[i] ?? '';
          const num = typeof v === 'number' ? v : v == null ? NaN : Number(v);
          if (!Number.isFinite(num)) continue;
          rows.push(
            `<div style="display:flex;justify-content:space-between;gap:12px;">` +
              `<span>${n}</span>` +
              `<span style="font-variant-numeric:tabular-nums;font-weight:700;">${formatMoney(num.toFixed(2), data.currency)}</span>` +
            `</div>`,
          );
        }
        return (
          `<div style="padding:10px 12px;min-width:240px">` +
            `<div style="opacity:.85;margin-bottom:6px">${x}</div>` +
            rows.join('') +
          `</div>`
        );
      },
    },
    legend: {
      position: 'top',
      onItemClick: { toggleDataSeries: false },
      onItemHover: { highlightDataSeries: false },
      formatter: (seriesName: string) => {
        const disabled =
          (seriesName === 'Meltdown · Ist' && !showMeltdownIst) ||
          (seriesName === 'Meltdown · Soll' && !showMeltdownStart) ||
          (seriesName === 'Meltdown · Soll Ø kumul.' && !showMeltdownSollKumAvg) ||
          (seriesName === 'Konto · Ist' && !showKontoIst) ||
          (seriesName === 'Konto · Soll' && !showKontoStart) ||
          (seriesName === 'Konto · Soll Ø kumul.' && !showKontoSollKumAvg) ||
          (seriesName === 'Ausgaben · Ø kumul.' && !showAusgabenKumAvg) ||
          (seriesName === 'Ausgaben' && !showAusgaben);
        return disabled ? `<span style="opacity:0.45">${seriesName}</span>` : seriesName;
      },
    },
  };
  return { options, series };
}

export default function DayZero() {
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  const accountsAll = accountsQ.data ?? [];
  const accounts = useMemo(() => accountsAll.filter(accountHasTagZeroRule), [accountsAll]);
  const [pick, setPick] = useState<number | ''>('');
  const [showMeltdownIst, setShowMeltdownIst] = useState(true);
  const [showMeltdownSoll, setShowMeltdownSoll] = useState(true);
  const [showSaldoIst, setShowSaldoIst] = useState(true);
  const [showSaldoSoll, setShowSaldoSoll] = useState(true);
  const [showSaldoAusgaben, setShowSaldoAusgaben] = useState(true);
  const [selectedSpendDay, setSelectedSpendDay] = useState<string | null>(null);
  const [showSpendSaldoFix, setShowSpendSaldoFix] = useState(true);
  const [showSpendSaldoDyn, setShowSpendSaldoDyn] = useState(true);
  const [showSpendMeltdownFixSoll, setShowSpendMeltdownFixSoll] = useState(true);
  const [showSpendMeltdownDynIst, setShowSpendMeltdownDynIst] = useState(true);
  const [showSpendAusgaben, setShowSpendAusgaben] = useState(false);
  const [showSpendAusgabenKumAvg, setShowSpendAusgabenKumAvg] = useState(true);
  const [showSpendKontoSollKumAvg, setShowSpendKontoSollKumAvg] = useState(true);
  const [showSpendMeltdownSollKumAvg, setShowSpendMeltdownSollKumAvg] = useState(true);

  const effectiveAccountId = pick === '' ? (accounts[0]?.id ?? null) : pick;

  const meltdownQ = useQuery({
    queryKey: ['dayzero-meltdown', effectiveAccountId],
    queryFn: () => fetchDayZeroMeltdown(effectiveAccountId as number, 1),
    enabled: effectiveAccountId != null,
  });

  const toggleMeltdownIst = useCallback(() => setShowMeltdownIst((v) => !v), []);
  const toggleMeltdownSoll = useCallback(() => setShowMeltdownSoll((v) => !v), []);
  const toggleSaldoIst = useCallback(() => setShowSaldoIst((v) => !v), []);
  const toggleSaldoSoll = useCallback(() => setShowSaldoSoll((v) => !v), []);
  const toggleSaldoAusgaben = useCallback(() => setShowSaldoAusgaben((v) => !v), []);
  const pickSpendDay = useCallback((isoDay: string) => setSelectedSpendDay(isoDay), []);
  const toggleSpendSaldoFix = useCallback(() => setShowSpendSaldoFix((v) => !v), []);
  const toggleSpendSaldoDyn = useCallback(() => setShowSpendSaldoDyn((v) => !v), []);
  const toggleSpendMeltdownFixSoll = useCallback(() => setShowSpendMeltdownFixSoll((v) => !v), []);
  const toggleSpendMeltdownDynIst = useCallback(() => setShowSpendMeltdownDynIst((v) => !v), []);
  const toggleSpendAusgaben = useCallback(() => setShowSpendAusgaben((v) => !v), []);
  const toggleSpendAusgabenKumAvg = useCallback(() => setShowSpendAusgabenKumAvg((v) => !v), []);
  const toggleSpendKontoSollKumAvg = useCallback(() => setShowSpendKontoSollKumAvg((v) => !v), []);
  const toggleSpendMeltdownSollKumAvg = useCallback(() => setShowSpendMeltdownSollKumAvg((v) => !v), []);

  const todaySummary = useMemo(() => {
    const d = meltdownQ.data;
    if (!d) return null;
    const todayIso = isoDayInTimeZone(new Date(), getAppTimeZone());
    const n = d.days.length;
    const md0 = meltdownDayZeroStart(d);
    const hasMd = md0 != null && !Number.isNaN(md0);
    const kontoFixProTag = kontoFixProTagRate(d);
    /** Meltdown Start: gleiche Tagesanzahl n (parallel zur Konto-Fixrate). */
    const meltdownFixProTag = n > 0 && hasMd ? (md0 as number) / n : null;

    const idx = d.days.findIndex((x) => x.day === todayIso);
    if (idx < 0) {
      return {
        todayIso,
        inRange: false as const,
        currency: d.currency,
        kontoFixProTag,
        meltdownFixProTag,
        kontoDynProTagHeute: null as number | null,
        meltdownDynProTagHeute: null as number | null,
        geldIstProTagAvg: null as number | null,
        kontoGeldSollProTagAvg: null as number | null,
        meltdownGeldSollProTagAvg: null as number | null,
        kontoGeldDeltaIstSoll: null as number | null,
        meltdownGeldDeltaIstSoll: null as number | null,
      };
    }

    const day = d.days[idx];
    const saldoStartTab = tableKontoStart(d);
    const meltdownStartTab = tableMeltdownStart(d);
    const kontoIstRaw =
      d.konto_saldo_ist != null && String(d.konto_saldo_ist).trim() !== ''
        ? Number(d.konto_saldo_ist)
        : kontoBalanceIstDay(day);
    const kontoSaldoHeute = Number.isFinite(kontoIstRaw) ? kontoIstRaw : kontoBalanceIstDay(day);
    const kontoSollHeute = kontoBalanceSollDay(day);
    const kontoSollTagNull = kontoBalanceSollDay(d.days[0]);
    /** Meltdown · Soll wie Saldo-Diagramm: linear von Meltdown-Start auf 0, Tag ``idx`` = ``md0 * (1 - idx/(n-1))``. */
    const denomMeltdown = Math.max(1, n - 1);
    const meltdownSollHeute =
      hasMd && idx >= 0 ? (md0 as number) * (1 - idx / denomMeltdown) : null;
    const meltdownSollTagNull = hasMd ? (md0 as number) : null;

    /** Tabelle Saldo: Meltdown · Ist = Meltdown · Start − (Konto · Start − Konto · Ist). */
    const meltdownIstHeuteVal =
      meltdownStartTab != null &&
      saldoStartTab != null &&
      Number.isFinite(kontoSaldoHeute) &&
      !Number.isNaN(meltdownStartTab) &&
      !Number.isNaN(saldoStartTab)
        ? meltdownStartTab - (saldoStartTab - kontoSaldoHeute)
        : null;
    const daysLeftInclToday = Math.max(0, n - idx);
    /** Konto Ist: Saldo heute (ausgerichtet) ÷ Tage von heute bis Periodenende inkl. heute (= bis nächster Zyklus im Fenster). */
    const kontoDynProTagHeute =
      daysLeftInclToday > 0 && Number.isFinite(kontoSaldoHeute) ? kontoSaldoHeute / daysLeftInclToday : null;
    /** Dyn: Stand Meltdown-Ist-Kurve ÷ verbleibende Tage — wie Diagramm. */
    const meltdownDynProTagHeute =
      daysLeftInclToday > 0 && meltdownIstHeuteVal != null && Number.isFinite(meltdownIstHeuteVal)
        ? meltdownIstHeuteVal / daysLeftInclToday
        : null;

    /** Geld-Zeile Tabelle: Ist = Summe spend_actual (ohne Umbuchungen) von Periodenbeginn bis heute, geteilt durch Anzahl Tage inkl. heute. */
    const daysElapsedGeld = idx + 1;
    let spendSumToToday = 0;
    for (let i = 0; i <= idx; i++) {
      spendSumToToday += Number(d.days[i]?.spend_actual ?? 0);
    }
    const geldIstProTagAvg =
      daysElapsedGeld > 0 && Number.isFinite(spendSumToToday) ? spendSumToToday / daysElapsedGeld : null;
    /** Soll = (Tabellen-Start minus Soll-Saldo heute) geteilt durch dieselbe Tagesanzahl — Ø tägliche geplante Absenkung laut Soll-Linie. */
    const kontoGeldSollProTagAvg =
      saldoStartTab != null &&
      Number.isFinite(kontoSollHeute) &&
      !Number.isNaN(saldoStartTab) &&
      daysElapsedGeld > 0
        ? (saldoStartTab - kontoSollHeute) / daysElapsedGeld
        : null;
    const meltdownGeldSollProTagAvg =
      meltdownStartTab != null &&
      meltdownSollHeute != null &&
      Number.isFinite(meltdownSollHeute) &&
      !Number.isNaN(meltdownStartTab) &&
      daysElapsedGeld > 0
        ? (meltdownStartTab - meltdownSollHeute) / daysElapsedGeld
        : null;
    const kontoGeldDeltaIstSoll =
      geldIstProTagAvg != null &&
      kontoGeldSollProTagAvg != null &&
      Number.isFinite(geldIstProTagAvg) &&
      Number.isFinite(kontoGeldSollProTagAvg)
        ? geldIstProTagAvg - kontoGeldSollProTagAvg
        : null;
    const meltdownGeldDeltaIstSoll =
      geldIstProTagAvg != null &&
      meltdownGeldSollProTagAvg != null &&
      Number.isFinite(geldIstProTagAvg) &&
      Number.isFinite(meltdownGeldSollProTagAvg)
        ? geldIstProTagAvg - meltdownGeldSollProTagAvg
        : null;

    return {
      todayIso,
      inRange: true as const,
      currency: d.currency,
      kontoSaldoHeute,
      kontoSollHeute,
      meltdownSollHeute,
      kontoSollTagNull,
      meltdownSollTagNull,
      meltdownIstHeute: meltdownIstHeuteVal,
      kontoFixProTag,
      meltdownFixProTag,
      kontoDynProTagHeute,
      meltdownDynProTagHeute,
      geldIstProTagAvg,
      kontoGeldSollProTagAvg,
      meltdownGeldSollProTagAvg,
      kontoGeldDeltaIstSoll,
      meltdownGeldDeltaIstSoll,
    };
  }, [meltdownQ.data]);

  const charts = useMemo(() => {
    if (!meltdownQ.data) return null;
    const d = meltdownQ.data;

    return {
      saldo: buildSaldoChart({
        data: d,
        showMeltdownIst,
        showMeltdownSoll,
        showSaldoIst,
        showSaldoSoll,
        showAusgaben: showSaldoAusgaben,
        onToggleMeltdownIst: toggleMeltdownIst,
        onToggleMeltdownSoll: toggleMeltdownSoll,
        onToggleSaldoIst: toggleSaldoIst,
        onToggleSaldoSoll: toggleSaldoSoll,
        onToggleAusgaben: toggleSaldoAusgaben,
        onPickSpendDay: pickSpendDay,
      }),
      spend: buildGeldProTagChart({
        data: d,
        showKontoStart: showSpendSaldoFix,
        showKontoIst: showSpendSaldoDyn,
        showMeltdownStart: showSpendMeltdownFixSoll,
        showMeltdownIst: showSpendMeltdownDynIst,
        showAusgaben: showSpendAusgaben,
        showAusgabenKumAvg: showSpendAusgabenKumAvg,
        showKontoSollKumAvg: showSpendKontoSollKumAvg,
        showMeltdownSollKumAvg: showSpendMeltdownSollKumAvg,
        onToggleKontoStart: toggleSpendSaldoFix,
        onToggleKontoIst: toggleSpendSaldoDyn,
        onToggleMeltdownStart: toggleSpendMeltdownFixSoll,
        onToggleMeltdownIst: toggleSpendMeltdownDynIst,
        onToggleAusgaben: toggleSpendAusgaben,
        onToggleAusgabenKumAvg: toggleSpendAusgabenKumAvg,
        onToggleKontoSollKumAvg: toggleSpendKontoSollKumAvg,
        onToggleMeltdownSollKumAvg: toggleSpendMeltdownSollKumAvg,
        onPickSpendDay: pickSpendDay,
      }),
    };
  }, [
    meltdownQ.data,
    showMeltdownIst,
    showMeltdownSoll,
    showSaldoIst,
    showSaldoSoll,
    showSaldoAusgaben,
    toggleMeltdownIst,
    toggleMeltdownSoll,
    toggleSaldoIst,
    toggleSaldoSoll,
    toggleSaldoAusgaben,
    pickSpendDay,
    showSpendSaldoFix,
    showSpendSaldoDyn,
    showSpendMeltdownFixSoll,
    showSpendMeltdownDynIst,
    showSpendAusgaben,
    showSpendAusgabenKumAvg,
    showSpendKontoSollKumAvg,
    showSpendMeltdownSollKumAvg,
    toggleSpendSaldoFix,
    toggleSpendSaldoDyn,
    toggleSpendMeltdownFixSoll,
    toggleSpendMeltdownDynIst,
    toggleSpendAusgaben,
    toggleSpendAusgabenKumAvg,
    toggleSpendKontoSollKumAvg,
    toggleSpendMeltdownSollKumAvg,
  ]);

  const spendTxQ = useQuery({
    queryKey: ['dayzero-spend-txs', effectiveAccountId, selectedSpendDay],
    enabled: effectiveAccountId != null && selectedSpendDay != null,
    queryFn: () =>
      fetchTransactions({
        bank_account_id: effectiveAccountId as number,
        from: selectedSpendDay as string,
        to: selectedSpendDay as string,
        limit: 500,
        offset: 0,
      }),
  });

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Day Zero
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Zeitraum: Tag Null bis +1 Monat. Nur Konten mit konfigurierte(r) Tag‑Null‑Regel und gesetztem Tag‑Null‑Datum.
        </Typography>
      </Box>

      {accountsQ.isError ? <Alert severity="error">{apiErrorMessage(accountsQ.error)}</Alert> : null}

      {accountsQ.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : accounts.length === 0 ? (
        <Alert severity="info">
          Keine Konten mit Tag‑Null‑Regel/Tag‑Null‑Datum. Lege unter <strong>Einstellungen → Bankkonten</strong> eine Tag‑Null‑Regel an und speichere sie.
        </Alert>
      ) : (
        <>
          <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
              <FormControl size="small" sx={{ minWidth: { xs: 0, sm: 260 }, width: { xs: '100%', sm: 'auto' } }}>
                <InputLabel id="dz-acc">Konto</InputLabel>
                <Select
                  labelId="dz-acc"
                  label="Konto"
                  value={pick === '' ? (effectiveAccountId ?? '') : pick}
                  onChange={(e) => setPick(e.target.value === '' ? '' : Number(e.target.value))}
                >
                  {accounts.map((a) => (
                    <MenuItem key={a.id} value={a.id}>
                      {a.name}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
              {meltdownQ.data ? (
                <Typography variant="body2" color="text.secondary">
                  Tag Null:{' '}
                  <strong>{formatEuropeanDate(String(meltdownQ.data.tag_zero_date), getAppTimeZone())}</strong> · Ende:{' '}
                  <strong>{formatEuropeanDate(String(meltdownQ.data.period_end_exclusive), getAppTimeZone())}</strong>
                </Typography>
              ) : null}
            </Stack>
          </Paper>

          {meltdownQ.isError ? <Alert severity="error">{apiErrorMessage(meltdownQ.error)}</Alert> : null}
          {meltdownQ.isLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : charts ? (
            <Stack spacing={2}>
              {meltdownQ.data ? (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                    Tag Null &amp; Heute
                  </Typography>
                  {meltdownQ.data.konto_saldo_not_tagesaktuell ? (
                    <Alert severity="warning" sx={{ mb: 1.5 }}>
                      Der zuletzt synchronisierte Kontostand ist nicht tagesaktuell (heute in der App‑Zeitzone:{' '}
                      <strong>{formatEuropeanDate(isoDayInTimeZone(new Date(), getAppTimeZone()), getAppTimeZone())}</strong>
                      ). Die Auswertung ist am zuverlässigsten, wenn Saldo und Buchungen zum selben Kalendertag passen.
                      Sync‑Stand:{' '}
                      {meltdownQ.data.konto_saldo_ledger_day ? (
                        <strong>
                          {formatEuropeanDate(String(meltdownQ.data.konto_saldo_ledger_day), getAppTimeZone())}
                        </strong>
                      ) : (
                        <strong>unbekannt</strong>
                      )}
                      {meltdownQ.data.konto_saldo_ist_at
                        ? ` (${meltdownQ.data.konto_saldo_ist_at})`
                        : ''}
                      .
                    </Alert>
                  ) : null}
                  <TableContainer>
                    <Table size="small" sx={{ '& td, & th': { py: 0.75 } }}>
                      <TableHead>
                        <TableRow>
                          <TableCell rowSpan={2} sx={{ verticalAlign: 'bottom' }} />
                          <TableCell colSpan={4} align="center" sx={{ borderBottom: 0, fontWeight: 700 }}>
                            Konto
                          </TableCell>
                          <TableCell
                            colSpan={4}
                            align="center"
                            sx={{ borderBottom: 0, fontWeight: 700, ...dayZeroSaldoTableSectionDividerSx }}
                          >
                            Meltdown
                          </TableCell>
                          <TableCell
                            colSpan={2}
                            align="center"
                            sx={{ borderBottom: 0, fontWeight: 700, ...dayZeroSaldoTableSectionDividerSx }}
                          >
                            Differenz
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell align="right">Start</TableCell>
                          <TableCell align="right">Ist</TableCell>
                          <TableCell align="right">Soll</TableCell>
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            Δ (Ist−Soll)
                          </TableCell>
                          <TableCell align="right" sx={dayZeroSaldoTableSectionDividerSx}>
                            Start
                          </TableCell>
                          <TableCell align="right">Ist</TableCell>
                          <TableCell align="right">Soll</TableCell>
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            Δ (Ist−Soll)
                          </TableCell>
                          <TableCell align="right" sx={dayZeroSaldoTableSectionDividerSx}>
                            Δ Start
                          </TableCell>
                          <TableCell align="right">Δ Soll</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(() => {
                          const d = meltdownQ.data;
                          const cur = d.currency;
                          const saldoD0 = tableKontoStart(d);
                          const meltdownD0 = tableMeltdownStart(d);
                          const diffStartSaldo =
                            saldoD0 != null &&
                            meltdownD0 != null &&
                            !Number.isNaN(saldoD0) &&
                            !Number.isNaN(meltdownD0)
                              ? saldoD0 - meltdownD0
                              : null;
                          const diffSollHeute =
                            todaySummary?.inRange &&
                            todaySummary.kontoSollHeute != null &&
                            todaySummary.meltdownSollHeute != null &&
                            Number.isFinite(todaySummary.kontoSollHeute) &&
                            Number.isFinite(todaySummary.meltdownSollHeute)
                              ? todaySummary.kontoSollHeute - todaySummary.meltdownSollHeute
                              : null;
                          const kontoDeltaIstSoll =
                            todaySummary?.inRange &&
                            todaySummary.kontoSaldoHeute != null &&
                            todaySummary.kontoSollHeute != null &&
                            Number.isFinite(todaySummary.kontoSaldoHeute) &&
                            Number.isFinite(todaySummary.kontoSollHeute)
                              ? todaySummary.kontoSaldoHeute - todaySummary.kontoSollHeute
                              : null;
                          const meltdownDeltaIstSoll =
                            todaySummary?.inRange &&
                            todaySummary.meltdownIstHeute != null &&
                            todaySummary.meltdownSollHeute != null &&
                            Number.isFinite(todaySummary.meltdownIstHeute) &&
                            Number.isFinite(todaySummary.meltdownSollHeute)
                              ? todaySummary.meltdownIstHeute - todaySummary.meltdownSollHeute
                              : null;
                          const money = (v: number | null) =>
                            v == null || Number.isNaN(v) ? (
                              '—'
                            ) : (
                              <Typography
                                component="span"
                                sx={{
                                  color: valueSignColor(v),
                                  fontWeight: 700,
                                  fontVariantNumeric: 'tabular-nums',
                                }}
                              >
                                {formatMoney(v.toFixed(2), cur)}
                              </Typography>
                            );
                          return (
                            <>
                              <TableRow hover>
                                <TableCell sx={{ maxWidth: 220 }}>
                                  <Typography variant="body2" fontWeight={600}>
                                    Saldo
                                  </Typography>
                                </TableCell>
                                <TableCell align="right">{money(saldoD0)}</TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(todaySummary.kontoSaldoHeute) : '—'}
                                </TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(todaySummary.kontoSollHeute) : '—'}
                                </TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(kontoDeltaIstSoll) : '—'}
                                </TableCell>
                                <TableCell align="right" sx={dayZeroSaldoTableSectionDividerSx}>
                                  {money(meltdownD0)}
                                </TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(todaySummary.meltdownIstHeute) : '—'}
                                </TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(todaySummary.meltdownSollHeute) : '—'}
                                </TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(meltdownDeltaIstSoll) : '—'}
                                </TableCell>
                                <TableCell align="right" sx={dayZeroSaldoTableSectionDividerSx}>
                                  {money(diffStartSaldo)}
                                </TableCell>
                                <TableCell align="right">{money(diffSollHeute)}</TableCell>
                              </TableRow>
                              {todaySummary ? (
                                <TableRow hover>
                                  {(() => {
                                    const ts = todaySummary;
                                    const diffStartGpt =
                                      ts.kontoFixProTag != null &&
                                      ts.meltdownFixProTag != null &&
                                      !Number.isNaN(ts.kontoFixProTag) &&
                                      !Number.isNaN(ts.meltdownFixProTag)
                                        ? ts.kontoFixProTag - ts.meltdownFixProTag
                                        : null;
                                    const diffSollGpt =
                                      ts.inRange &&
                                      ts.kontoGeldSollProTagAvg != null &&
                                      ts.meltdownGeldSollProTagAvg != null &&
                                      Number.isFinite(ts.kontoGeldSollProTagAvg) &&
                                      Number.isFinite(ts.meltdownGeldSollProTagAvg)
                                        ? ts.kontoGeldSollProTagAvg - ts.meltdownGeldSollProTagAvg
                                        : null;
                                    return (
                                      <>
                                        <TableCell sx={{ maxWidth: 220 }}>
                                          <Typography variant="body2" fontWeight={600}>
                                            Geld pro Tag
                                          </Typography>
                                        </TableCell>
                                        <TableCell align="right">{money(ts.kontoFixProTag)}</TableCell>
                                        <TableCell align="right">
                                          {ts.inRange ? money(ts.geldIstProTagAvg) : '—'}
                                        </TableCell>
                                        <TableCell align="right">
                                          {ts.inRange ? money(ts.kontoGeldSollProTagAvg) : '—'}
                                        </TableCell>
                                        <TableCell align="right">
                                          {ts.inRange ? money(ts.kontoGeldDeltaIstSoll) : '—'}
                                        </TableCell>
                                        <TableCell align="right" sx={dayZeroSaldoTableSectionDividerSx}>
                                          {money(ts.meltdownFixProTag)}
                                        </TableCell>
                                        <TableCell align="right">
                                          {ts.inRange ? money(ts.geldIstProTagAvg) : '—'}
                                        </TableCell>
                                        <TableCell align="right">
                                          {ts.inRange ? money(ts.meltdownGeldSollProTagAvg) : '—'}
                                        </TableCell>
                                        <TableCell align="right">
                                          {ts.inRange ? money(ts.meltdownGeldDeltaIstSoll) : '—'}
                                        </TableCell>
                                        <TableCell align="right" sx={dayZeroSaldoTableSectionDividerSx}>
                                          {money(diffStartGpt)}
                                        </TableCell>
                                        <TableCell align="right">{money(diffSollGpt)}</TableCell>
                                      </>
                                    );
                                  })()}
                                </TableRow>
                              ) : null}
                            </>
                          );
                        })()}
                      </TableBody>
                    </Table>
                  </TableContainer>
                  {todaySummary && !todaySummary.inRange ? (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25 }}>
                      Heute ({formatEuropeanDate(todaySummary.todayIso, getAppTimeZone())}) liegt nicht im Tag‑Null‑Zeitraum dieses Kontos.
                    </Typography>
                  ) : null}
                </Paper>
              ) : null}
              {meltdownQ.data ? (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                    Grundlagen &amp; Buchungen im Zeitraum
                  </Typography>
                  <Stack spacing={2}>
                    <Stack spacing={0.75}>
                      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
                        <strong>Konto‑Ist</strong> (neuester Sync):{' '}
                        <strong>
                          {meltdownQ.data.konto_saldo_ist != null &&
                          String(meltdownQ.data.konto_saldo_ist).trim() !== ''
                            ? formatMoney(String(meltdownQ.data.konto_saldo_ist), meltdownQ.data.currency)
                            : '—'}
                        </strong>
                        . <strong>Konto‑Start</strong> (Bank‑Rückrechnung + Regel + Umbuchungs‑Anpassung):{' '}
                        <strong>
                          {meltdownQ.data.konto_saldo_start_backcalc != null &&
                          String(meltdownQ.data.konto_saldo_start_backcalc).trim() !== ''
                            ? formatMoney(String(meltdownQ.data.konto_saldo_start_backcalc), meltdownQ.data.currency)
                            : '—'}
                        </strong>
                        . (Hinweis Meltdown/Snapshot:{' '}
                        {meltdownQ.data.tag_zero_saldo_includes_rule_booking === true
                          ? 'Snapshot enthält Regel‑Buchung (Heuristik).'
                          : meltdownQ.data.tag_zero_saldo_includes_rule_booking === false
                            ? 'Snapshot vor Regel‑Buchung, Betrag nachgerechnet.'
                            : 'Kein Snapshot / nicht anwendbar.'}
                        )
                      </Typography>
                    </Stack>
                    <Stack spacing={1}>
                      <Typography variant="body2" fontWeight={600}>
                        Umbuchungen (im Zeitraum, als interne Umbuchung erkannt)
                      </Typography>
                      {(meltdownQ.data.transfer_bookings ?? []).length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          Keine.
                        </Typography>
                      ) : (
                        <TableContainer>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>Datum</TableCell>
                                <TableCell align="right">Betrag</TableCell>
                                <TableCell>Gegenpart / Text</TableCell>
                                <TableCell>Zielkonto</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {(meltdownQ.data.transfer_bookings ?? []).map((r) => (
                                <TableRow key={r.id}>
                                  <TableCell>{formatEuropeanDate(r.booking_date, getAppTimeZone())}</TableCell>
                                  <TableCell align="right">{formatMoney(r.amount, meltdownQ.data.currency)}</TableCell>
                                  <TableCell sx={{ maxWidth: 280 }}>
                                    {(r.counterparty_name || '').trim() || '—'}
                                    {r.description?.trim() ? (
                                      <Typography component="span" variant="caption" color="text.secondary" display="block">
                                        {r.description.slice(0, 120)}
                                        {r.description.length > 120 ? '…' : ''}
                                      </Typography>
                                    ) : null}
                                  </TableCell>
                                  <TableCell>
                                    {r.transfer_target_bank_account_id != null
                                      ? `#${r.transfer_target_bank_account_id}`
                                      : '—'}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      )}
                    </Stack>
                    <Stack spacing={1}>
                      <Typography variant="body2" fontWeight={600}>
                        Vertrags-Buchungen (contract_id im Zeitraum)
                      </Typography>
                      {(meltdownQ.data.contract_bookings ?? []).length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          Keine.
                        </Typography>
                      ) : (
                        <TableContainer>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>Datum</TableCell>
                                <TableCell align="right">Betrag</TableCell>
                                <TableCell>Vertrag</TableCell>
                                <TableCell>Gegenpart / Text</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {(meltdownQ.data.contract_bookings ?? []).map((r) => (
                                <TableRow key={r.id}>
                                  <TableCell>{formatEuropeanDate(r.booking_date, getAppTimeZone())}</TableCell>
                                  <TableCell align="right">{formatMoney(r.amount, meltdownQ.data.currency)}</TableCell>
                                  <TableCell>{r.contract_label?.trim() || (r.contract_id != null ? `#${r.contract_id}` : '—')}</TableCell>
                                  <TableCell sx={{ maxWidth: 280 }}>
                                    {(r.counterparty_name || '').trim() || '—'}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      )}
                    </Stack>
                  </Stack>
                </Paper>
              ) : null}
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                  Saldo Ist/Soll
                </Typography>
                <Chart options={charts.saldo.options} series={charts.saldo.series} type="line" height={340} />
                <Stack spacing={1} sx={{ mt: 1.5 }}>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Meltdown · Ist</strong> und <strong>Konto · Ist</strong> zeigen denselben tatsächlichen
                    Kontostand über die Periode (Ist); zwei Legenden-Einträge erlauben, Meltdown- und Konto-Soll-Linien
                    getrennt ein- und auszublenden. Per Klick in der Legende blendest du einzelne Reihen aus.
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Meltdown · Soll</strong> ist die lineare Rampe vom Meltdown-Start am Periodenbeginn bis 0 am
                    letzten Tag (gleichmäßiger „Verbrauch“ des Meltdown-Betrags). <strong>Konto · Soll</strong> ist der
                    geplante Kontostand pro Tag laut Zielkurve (Soll-Saldo aus den Tagesdaten).
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Ausgaben</strong> sind die tatsächlichen Tagesausgaben (Balken). Per Klick auf einen Balken
                    öffnest du die Buchungen dieses Tags darunter.
                  </Typography>
                </Stack>
              </Paper>
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                  Geld pro Tag (Soll/Ist, Ausgaben, kumul. Ø)
                </Typography>
                <Chart options={charts.spend.options} series={charts.spend.series} type="line" height={340} />
                <Stack spacing={1} sx={{ mt: 1.5 }}>
                  <Typography variant="body2" color="text.secondary" component="div">
                    Achse: Beträge <strong>pro Tag</strong>. <strong>Ist (Meltdown · Ist / Konto · Ist):</strong> aktueller
                    Kontosaldo Ist geteilt durch die <strong>noch verbleibenden</strong> Tage bis Periodenende — „Rest
                    gleichmäßig auf die verbleibenden Tage verteilt“. Beide Legenden-Linien sind rechnerisch gleich; getrennt
                    zum Ein- und Ausblenden wie im Saldo-Diagramm. <strong>Feste Soll-Linien:</strong> Meltdown-Start geteilt
                    durch die Gesamttage (Meltdown · Soll) bzw. Soll-Anker am ersten Tag geteilt durch n (Konto · Soll).
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Meltdown · Soll:</strong> Meltdown-Start geteilt durch die Anzahl Periodentage — konstante tägliche
                    Soll-Rate bei linearer Rampe. <strong>Konto · Soll:</strong> konstante tägliche Soll-Rate aus dem Soll-Saldo
                    am ersten Tag (sonst Tabellen-Start geteilt durch n), zum Saldo-Diagramm passend.
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Ausgaben · Ø kumul.:</strong> Summe der Ausgaben von Periodenbeginn bis zum jeweiligen Tag (inkl.),
                    geteilt durch die Anzahl dieser Tage — dein realer durchschnittlicher Tageswert, analog zur Zeile „Geld
                    pro Tag“ in der Tabelle.
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Konto · Soll Ø kumul.</strong> und <strong>Meltdown · Soll Ø kumul.:</strong> (Tabellen-Start minus
                    Soll an diesem Tag), geteilt durch die vergangenen Tage — Durchschnitt der geplanten täglichen Absenkung
                    laut linearer Soll-Linie bis zu diesem Tag. Ergänzt die <strong>festen</strong> Soll-Linien (pro verbleibendem
                    Tag) durch einen <strong>rückblickenden Mittelwert</strong> zum Vergleich mit den Ausgaben.
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Ausgaben</strong> (Balken): Tagesausgaben; Klick öffnet wie im Saldo-Diagramm die Buchungen des
                    Tags.
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Vergleich:</strong> Liegt „Ausgaben · Ø kumul.“ über „Konto · Soll Ø kumul.“, war dein
                    Ausgabentempo im Mittel höher als der Konto-Plan; darunter niedriger. Entsprechend mit „Meltdown · Soll Ø
                    kumul.“.
                  </Typography>
                </Stack>
              </Paper>

              {selectedSpendDay ? (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Stack spacing={1.25}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'baseline' }} justifyContent="space-between">
                      <Typography variant="subtitle1" fontWeight={700}>
                        Buchungen am {formatEuropeanDate(selectedSpendDay, getAppTimeZone())}
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ cursor: 'pointer', textDecoration: 'underline', alignSelf: { xs: 'flex-start', sm: 'auto' } }}
                        onClick={() => setSelectedSpendDay(null)}
                      >
                        Auswahl löschen
                      </Typography>
                    </Stack>

                    {spendTxQ.isError ? <Alert severity="error">{apiErrorMessage(spendTxQ.error)}</Alert> : null}
                    {spendTxQ.isLoading ? (
                      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                        <CircularProgress />
                      </Box>
                    ) : (
                      <TransactionBookingsTable
                        rows={(spendTxQ.data ?? []) as Transaction[]}
                        accounts={accountsAll}
                        emptyMessage="Keine Buchungen an diesem Tag."
                        hideInlineHint
                      />
                    )}
                  </Stack>
                </Paper>
              ) : null}
            </Stack>
          ) : null}
        </>
      )}
    </Stack>
  );
}

