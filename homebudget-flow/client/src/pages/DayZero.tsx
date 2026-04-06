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

/** „Konto · Ist“ in der Tabelle Tag Null = API ``tag_zero_amount`` (nach Regel-Buchung). */
function tableKontoTagZero(data: DayZeroMeltdownOut): number | null {
  if (data.tag_zero_amount == null || String(data.tag_zero_amount).trim() === '') return null;
  const v = Number(data.tag_zero_amount);
  return Number.isNaN(v) ? null : v;
}

/** Startwert für Meltdown Soll/Ist: Regel-Buchung am Tag Null, sonst Kontostand. */
function meltdownDayZeroStart(data: DayZeroMeltdownOut): number | null {
  const accountStart =
    data.tag_zero_amount != null && String(data.tag_zero_amount).trim() !== '' ? Number(data.tag_zero_amount) : null;
  const ruleBooking =
    data.tag_zero_rule_booking_amount != null && String(data.tag_zero_rule_booking_amount).trim() !== ''
      ? Number(data.tag_zero_rule_booking_amount)
      : null;
  if (ruleBooking != null && !Number.isNaN(ruleBooking)) return ruleBooking;
  if (accountStart != null && !Number.isNaN(accountStart)) return accountStart;
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
  const lived =
    meltdownStart == null || Number.isNaN(meltdownStart)
      ? null
      : data.days.map((d, i) => {
          const prev = i === 0 ? meltdownStart : 0;
          return prev; // placeholder, overwritten below
        });
  if (lived) {
    let cur = meltdownStart as number;
    lived[0] = cur;
    for (let i = 1; i < data.days.length; i++) {
      cur += Number(data.days[i].net_actual || 0);
      lived[i] = cur;
    }
  }
  const livedMasked = lived ? maskSeriesAfterCalendarDay(dayIsos, lived, todayIso) : null;

  const tableStart = tableKontoTagZero(data);
  const apiIst0 =
    data.days.length > 0 ? Number(data.days[0].balance_actual) : Number.NaN;
  const saldoIstOffset =
    tableStart != null && Number.isFinite(apiIst0) ? tableStart - apiIst0 : 0;
  const denomSaldo = Math.max(1, data.days.length - 1);

  const saldoIstData = maskSeriesAfterCalendarDay(
    dayIsos,
    showSaldoIst
      ? data.days.map((d) => Number(d.balance_actual) + saldoIstOffset)
      : data.days.map(() => null),
    todayIso,
  );
  const saldoSollData = showSaldoSoll
    ? data.days.map((_, i) => {
        if (tableStart != null) {
          return tableStart * (1 - i / denomSaldo);
        }
        return Number(data.days[i]?.balance_target ?? 0);
      })
    : data.days.map(() => null);
  const spendBars = data.days.map((d) => Number(d.spend_actual)); // Ausgaben als positive Balken

  const saldoIstForYBounds = maskSeriesAfterCalendarDay(
    dayIsos,
    data.days.map((d) => Number(d.balance_actual) + saldoIstOffset),
    todayIso,
  );
  const saldoSollForYBounds = data.days.map((_, i) => {
    if (tableStart != null) {
      return tableStart * (1 - i / denomSaldo);
    }
    return Number(data.days[i]?.balance_target ?? 0);
  });
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

/** Geld-pro-Tag-Diagramm: gleiche Definitionen wie Tabelle „Geld pro Tag“ + Saldo-Diagramm (Ausrichtung, md0, n). */
function buildGeldProTagChart(args: {
  data: DayZeroMeltdownOut;
  showMeltdownIst: boolean;
  showMeltdownStart: boolean;
  showKontoIst: boolean;
  showKontoStart: boolean;
  showAusgaben: boolean;
  onToggleMeltdownIst: () => void;
  onToggleMeltdownStart: () => void;
  onToggleKontoIst: () => void;
  onToggleKontoStart: () => void;
  onToggleAusgaben: () => void;
  onPickSpendDay: (isoDay: string) => void;
}): { options: ApexOptions; series: any[] } {
  const {
    data,
    showMeltdownIst,
    showMeltdownStart,
    showKontoIst,
    showKontoStart,
    showAusgaben,
    onToggleMeltdownIst,
    onToggleMeltdownStart,
    onToggleKontoIst,
    onToggleKontoStart,
    onToggleAusgaben,
    onPickSpendDay,
  } = args;
  const tz = getAppTimeZone();
  const todayIso = isoDayInTimeZone(new Date(), tz);
  const dayIsos = data.days.map((x) => x.day);
  const cats = dayIsos;
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const n = data.days.length;
  const tableStart = tableKontoTagZero(data);
  const apiIst0 = data.days.length > 0 ? Number(data.days[0].balance_actual) : Number.NaN;
  const saldoIstOffset =
    tableStart != null && Number.isFinite(apiIst0) ? tableStart - apiIst0 : 0;
  const md0 = meltdownDayZeroStart(data);
  const hasMd = md0 != null && !Number.isNaN(md0);

  const livedMeltdown: number[] | null = !hasMd
    ? null
    : (() => {
        const arr: number[] = new Array(n).fill(0);
        let cur = md0 as number;
        arr[0] = cur;
        for (let i = 1; i < n; i++) {
          cur += Number(data.days[i].net_actual || 0);
          arr[i] = cur;
        }
        return arr;
      })();

  const kontoStartPerDay =
    n > 0 && tableStart != null && Number.isFinite(Number(tableStart))
      ? data.days.map(() => Number(tableStart) / n)
      : data.days.map(() => null);
  const kontoIstPerDay = data.days.map((_, i) => {
    const left = n - i;
    if (left <= 0) return null;
    const bal = Number(data.days[i].balance_actual) + saldoIstOffset;
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

  const nullLine = data.days.map(() => null);
  const mdIstMasked = maskSeriesAfterCalendarDay(dayIsos, meltdownIstPerDay, todayIso);
  const kIstMasked = maskSeriesAfterCalendarDay(dayIsos, kontoIstPerDay, todayIso);
  const spendBars = data.days.map((x) => Number(x.spend_actual));
  const geldLinesForYMin = [mdIstMasked, meltdownStartPerDay, kIstMasked, kontoStartPerDay];
  const yAxisMinGeld = yAxisMinTrimZeroGap({
    linesForMin: geldLinesForYMin,
    allForMax: [...geldLinesForYMin, spendBars],
  });

  const COLOR_MD = '#008FFB';
  const COLOR_KONTO = '#00E396';
  const COLOR_BAR = '#FEB019';

  // Soll (Fixrate): unmaskiert über den ganzen geladenen Zeitraum; Ist endet am Kalendertag „heute“.
  const series = [
    { name: 'Meltdown · Ist', data: showMeltdownIst ? mdIstMasked : nullLine },
    { name: 'Meltdown · Soll', data: showMeltdownStart ? meltdownStartPerDay : nullLine },
    { name: 'Konto · Ist', data: showKontoIst ? kIstMasked : nullLine },
    { name: 'Konto · Soll', data: showKontoStart ? kontoStartPerDay : nullLine },
    { name: 'Ausgaben', type: 'column', data: showAusgaben ? spendBars : nullLine },
  ];

  const strokeStyles = series.map((s: { name?: string; type?: string }) => {
    const nm = String(s.name ?? '');
    if (nm === 'Meltdown · Ist') return { w: 3, dash: 0, color: COLOR_MD };
    if (nm === 'Meltdown · Soll') return { w: 3, dash: 6, color: COLOR_MD };
    if (nm === 'Konto · Ist') return { w: 2, dash: 0, color: COLOR_KONTO };
    if (nm === 'Konto · Soll') return { w: 2, dash: 6, color: COLOR_KONTO };
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
          else if (name === 'Konto · Ist') onToggleKontoIst();
          else if (name === 'Konto · Soll') onToggleKontoStart();
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
          (seriesName === 'Konto · Ist' && !showKontoIst) ||
          (seriesName === 'Konto · Soll' && !showKontoStart) ||
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

  const todaySummary = useMemo(() => {
    const d = meltdownQ.data;
    if (!d) return null;
    const todayIso = isoDayInTimeZone(new Date(), getAppTimeZone());
    const n = d.days.length;
    const tableStart = tableKontoTagZero(d);
    const md0 = meltdownDayZeroStart(d);
    const hasMd = md0 != null && !Number.isNaN(md0);
    /** Konto Start: Saldo-Start ÷ Kalendertage Tag Null → Periodenende (wie bis „nächster“ Zyklus im geladenen Fenster). */
    const kontoFixProTag =
      n > 0 && tableStart != null && Number.isFinite(Number(tableStart))
        ? Number(tableStart) / n
        : null;
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
      };
    }

    const day = d.days[idx];
    const apiIst0 = Number(d.days[0]?.balance_actual ?? NaN);
    const saldoIstOffset =
      tableStart != null && Number.isFinite(apiIst0) ? tableStart - apiIst0 : 0;
    const kontoSaldoHeute = Number(day.balance_actual) + saldoIstOffset;

    const livedIst = !hasMd
      ? null
      : (() => {
          let cur = md0 as number;
          for (let i = 1; i <= idx; i++) cur += Number(d.days[i].net_actual || 0);
          return cur;
        })();
    const daysLeftInclToday = Math.max(0, n - idx);
    /** Konto Ist: Saldo heute (ausgerichtet) ÷ Tage von heute bis Periodenende inkl. heute (= bis nächster Zyklus im Fenster). */
    const kontoDynProTagHeute =
      daysLeftInclToday > 0 && Number.isFinite(kontoSaldoHeute) ? kontoSaldoHeute / daysLeftInclToday : null;
    /** Dyn: Stand Meltdown-Ist-Kurve ÷ verbleibende Tage — wie Diagramm. */
    const meltdownDynProTagHeute =
      livedIst != null && daysLeftInclToday > 0 ? livedIst / daysLeftInclToday : null;

    return {
      todayIso,
      inRange: true as const,
      currency: d.currency,
      kontoSaldoHeute,
      meltdownIstHeute: livedIst,
      kontoFixProTag,
      meltdownFixProTag,
      kontoDynProTagHeute,
      meltdownDynProTagHeute,
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
        onToggleKontoStart: toggleSpendSaldoFix,
        onToggleKontoIst: toggleSpendSaldoDyn,
        onToggleMeltdownStart: toggleSpendMeltdownFixSoll,
        onToggleMeltdownIst: toggleSpendMeltdownDynIst,
        onToggleAusgaben: toggleSpendAusgaben,
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
    toggleSpendSaldoFix,
    toggleSpendSaldoDyn,
    toggleSpendMeltdownFixSoll,
    toggleSpendMeltdownDynIst,
    toggleSpendAusgaben,
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
                  <TableContainer>
                    <Table size="small" sx={{ '& td, & th': { py: 0.75 } }}>
                      <TableHead>
                        <TableRow>
                          <TableCell rowSpan={2} sx={{ verticalAlign: 'bottom' }} />
                          <TableCell colSpan={2} align="center" sx={{ borderBottom: 0, fontWeight: 700 }}>
                            Konto
                          </TableCell>
                          <TableCell colSpan={2} align="center" sx={{ borderBottom: 0, fontWeight: 700 }}>
                            Meltdown
                          </TableCell>
                          <TableCell colSpan={3} align="center" sx={{ borderBottom: 0, fontWeight: 700 }}>
                            Differenz
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell align="right">Start</TableCell>
                          <TableCell align="right">Ist</TableCell>
                          <TableCell align="right">Start</TableCell>
                          <TableCell align="right">Ist</TableCell>
                          <TableCell align="right">Start</TableCell>
                          <TableCell align="right">Ist</TableCell>
                          <TableCell align="right">Soll vs. Ist</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {(() => {
                          const d = meltdownQ.data;
                          const cur = d.currency;
                          const saldoD0 =
                            d.tag_zero_amount != null && String(d.tag_zero_amount).trim() !== ''
                              ? Number(d.tag_zero_amount)
                              : null;
                          const meltdownD0 =
                            d.tag_zero_rule_booking_amount != null &&
                            String(d.tag_zero_rule_booking_amount).trim() !== ''
                              ? Number(d.tag_zero_rule_booking_amount)
                              : null;
                          const diffStartSaldo =
                            saldoD0 != null &&
                            meltdownD0 != null &&
                            !Number.isNaN(saldoD0) &&
                            !Number.isNaN(meltdownD0)
                              ? saldoD0 - meltdownD0
                              : null;
                          const diffIstSaldo =
                            todaySummary?.inRange &&
                            todaySummary.kontoSaldoHeute != null &&
                            todaySummary.meltdownIstHeute != null &&
                            Number.isFinite(todaySummary.kontoSaldoHeute) &&
                            Number.isFinite(todaySummary.meltdownIstHeute)
                              ? todaySummary.kontoSaldoHeute - todaySummary.meltdownIstHeute
                              : null;
                          const diffSollVsIstSaldo =
                            diffStartSaldo != null &&
                            diffIstSaldo != null &&
                            Number.isFinite(diffStartSaldo) &&
                            Number.isFinite(diffIstSaldo)
                              ? diffStartSaldo - diffIstSaldo
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
                                  <Typography variant="caption" color="text.secondary" display="block">
                                    Start: Tag Null · Ist: heute (im Zeitraum) — Konto = Saldo, Meltdown = Ist‑Kurve
                                  </Typography>
                                </TableCell>
                                <TableCell align="right">{money(saldoD0)}</TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(todaySummary.kontoSaldoHeute) : '—'}
                                </TableCell>
                                <TableCell align="right">{money(meltdownD0)}</TableCell>
                                <TableCell align="right">
                                  {todaySummary?.inRange ? money(todaySummary.meltdownIstHeute) : '—'}
                                </TableCell>
                                <TableCell align="right">{money(diffStartSaldo)}</TableCell>
                                <TableCell align="right">{money(diffIstSaldo)}</TableCell>
                                <TableCell align="right">{money(diffSollVsIstSaldo)}</TableCell>
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
                                    const diffIstGpt =
                                      ts.kontoDynProTagHeute != null &&
                                      ts.meltdownDynProTagHeute != null &&
                                      Number.isFinite(ts.kontoDynProTagHeute) &&
                                      Number.isFinite(ts.meltdownDynProTagHeute)
                                        ? ts.kontoDynProTagHeute - ts.meltdownDynProTagHeute
                                        : null;
                                    const diffSollVsIstGpt =
                                      diffStartGpt != null &&
                                      diffIstGpt != null &&
                                      Number.isFinite(diffStartGpt) &&
                                      Number.isFinite(diffIstGpt)
                                        ? diffStartGpt - diffIstGpt
                                        : null;
                                    return (
                                      <>
                                        <TableCell sx={{ maxWidth: 220 }}>
                                          <Typography variant="body2" fontWeight={600}>
                                            Geld pro Tag
                                          </Typography>
                                          <Typography variant="caption" color="text.secondary" display="block">
                                            Konto: Start = Saldo‑Start ÷ Tage (Tag Null→Periodenende) · Ist = Saldo heute ÷
                                            Tage (heute→Periodenende)
                                            {!ts.inRange ? ' · Ist nur wenn heute im Zeitraum' : ''}
                                          </Typography>
                                        </TableCell>
                                        <TableCell align="right">{money(ts.kontoFixProTag)}</TableCell>
                                        <TableCell align="right">{money(ts.kontoDynProTagHeute)}</TableCell>
                                        <TableCell align="right">{money(ts.meltdownFixProTag)}</TableCell>
                                        <TableCell align="right">{money(ts.meltdownDynProTagHeute)}</TableCell>
                                        <TableCell align="right">{money(diffStartGpt)}</TableCell>
                                        <TableCell align="right">{money(diffIstGpt)}</TableCell>
                                        <TableCell align="right">{money(diffSollVsIstGpt)}</TableCell>
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
                        <strong>Saldo zum Day Zero</strong> (Ausgangspunkt für die Konto-Kurve):{' '}
                        <strong>
                          {meltdownQ.data.tag_zero_amount != null && String(meltdownQ.data.tag_zero_amount).trim() !== ''
                            ? formatMoney(String(meltdownQ.data.tag_zero_amount), meltdownQ.data.currency)
                            : '—'}
                        </strong>
                        .{' '}
                        {meltdownQ.data.tag_zero_saldo_includes_rule_booking === true
                          ? 'Der verwendete Saldo-Snapshot wurde nach der Tag-Null-Regel-Buchung erfasst — die Regel-Buchung ist im Saldo enthalten.'
                          : meltdownQ.data.tag_zero_saldo_includes_rule_booking === false
                            ? 'Der Snapshot lag vor der Regel-Buchung; der Regelbetrag wurde zum Saldo addiert (siehe Server-Logik).'
                            : 'Saldo aus Buchungsrekonstruktion oder ohne Snapshot-Zuordnung — die Tag-Null-Regel ist in der Berechnung berücksichtigt.'}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.5 }}>
                        <strong>Meltdown-Start</strong> (Anzeige, inkl. Anpassung ausgehender Umbuchungen):{' '}
                        <strong>
                          {meltdownQ.data.meltdown_start_amount != null &&
                          String(meltdownQ.data.meltdown_start_amount).trim() !== ''
                            ? formatMoney(String(meltdownQ.data.meltdown_start_amount), meltdownQ.data.currency)
                            : '—'}
                        </strong>
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
              </Paper>
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                  Geld pro Tag (Konto & Meltdown, Soll/Ist)
                </Typography>
                <Chart options={charts.spend.options} series={charts.spend.series} type="line" height={340} />
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

