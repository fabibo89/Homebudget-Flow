import { useCallback, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
  TableFooter,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useQuery } from '@tanstack/react-query';
import Chart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import {
  fetchAccounts,
  fetchDayZeroMeltdown,
  fetchTransactions,
  type BankAccount,
  type DayZeroMeltdownBookingRef,
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
  /** Kein negatives Achsen-Minimum, solange alle Linien ≥ 0 — sonst wirkt wie ein negativer Saldo (Balken starten „unter null“). */
  return Math.max(0, minPos - pad);
}

/**
 * Obergrenze fürs Saldo-Diagramm: Apex berechnet bei ``chart.stacked: true`` im Combo-Chart die
 * Y-Skala fälschlich aus der Summe aller Serien pro Tag (mehrere Saldolinien → künstlich hohes Max).
 * Hier: echtes Maximum aus allen Linienpunkten plus Ausgaben-Balkenhöhe (``spend_actual``), mit Padding.
 */
function yAxisMaxSaldoMixed(args: {
  linesForMax: readonly (readonly (number | null)[])[];
  stackedBarsPerDay: readonly (number | null)[];
  yMinHint?: number;
}): number | undefined {
  const lineVals = collectFiniteSeriesValues(args.linesForMax);
  const barVals = collectFiniteSeriesValues([args.stackedBarsPerDay]);
  if (lineVals.length === 0 && barVals.length === 0) return undefined;
  const maxV = Math.max(
    lineVals.length ? Math.max(...lineVals) : -Infinity,
    barVals.length ? Math.max(...barVals) : -Infinity,
  );
  if (!Number.isFinite(maxV) || maxV === -Infinity) return undefined;
  const minLine = lineVals.length ? Math.min(...lineVals) : maxV;
  const lo =
    args.yMinHint != null && Number.isFinite(args.yMinHint) ? Math.min(minLine, args.yMinHint) : minLine;
  const span = Math.max(maxV - lo, Math.abs(maxV) * 0.02, 1);
  const hi = maxV + span * 0.08;
  if (args.yMinHint != null && Number.isFinite(args.yMinHint) && hi <= args.yMinHint) {
    return args.yMinHint + span * 0.08;
  }
  return hi;
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

function sumBookingRefAmounts(rows: readonly { amount?: string | null }[]): number {
  let s = 0;
  for (const r of rows) {
    const raw = r.amount;
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) s += n;
  }
  return s;
}

function transferBookingsBySign(
  rows: readonly DayZeroMeltdownBookingRef[] | undefined,
  sign: 'positive' | 'negative',
): DayZeroMeltdownBookingRef[] {
  return (rows ?? []).filter((r) => {
    const n = Number(r.amount);
    if (!Number.isFinite(n)) return false;
    return sign === 'positive' ? n > 0 : n < 0;
  });
}

type GeldeingangRow = { kind: 'income' | 'transfer_in'; row: DayZeroMeltdownBookingRef };

function mergeGeldeingaengeRows(
  income: DayZeroMeltdownBookingRef[] | undefined,
  transfersIn: DayZeroMeltdownBookingRef[],
): GeldeingangRow[] {
  const out: GeldeingangRow[] = [];
  for (const r of income ?? []) out.push({ kind: 'income', row: r });
  for (const r of transfersIn) out.push({ kind: 'transfer_in', row: r });
  out.sort((a, b) => {
    const c = String(a.row.booking_date).localeCompare(String(b.row.booking_date));
    if (c !== 0) return c;
    return a.row.id - b.row.id;
  });
  return out;
}

/**
 * Saldo-Tabelle „Konto“ · Startwert: **Konto · Day Zero** (``tableKontoMorningTagNull``) + **Summe Geldeingänge**
 * im Zeitraum — API ``einnahmen_summe_tag_zero_zeitraum`` (alle positiven Buchungen inkl. eingehender Umbuchungen,
 * wie Accordion „Geldeingänge“). Fallback nur wenn die Summe fehlt: Morgen-Saldo + ``meltdown_start_amount`` +
 * ``income_bookings``.
 */
function tableKontoSaldoRowStart(data: DayZeroMeltdownOut): number | null {
  const m = tableKontoMorningTagNull(data);
  if (m == null) return null;
  const eRaw = data.einnahmen_summe_tag_zero_zeitraum;
  if (eRaw != null && String(eRaw).trim() !== '') {
    const e = Number(eRaw);
    if (Number.isFinite(e)) return m + e;
  }
  let s = m;
  const mdRaw = data.meltdown_start_amount;
  if (mdRaw != null && String(mdRaw).trim() !== '') {
    const md = Number(mdRaw);
    if (Number.isFinite(md)) s += md;
  }
  s += sumBookingRefAmounts(data.income_bookings ?? []);
  return Number.isFinite(s) ? s : null;
}

/** Nur errechneter Morgen-Saldo am Tag Null (API ``konto_saldo_morgen_tag_null``) — ohne Umbuchungen, Einnahmen, Verträge. */
function tableKontoMorningTagNull(data: DayZeroMeltdownOut): number | null {
  const mRaw = data.konto_saldo_morgen_tag_null;
  if (mRaw == null || String(mRaw).trim() === '') return null;
  const m = Number(mRaw);
  return Number.isFinite(m) ? m : null;
}

function MeltdownBookingSumFooter(props: { sum: number; currency: string }) {
  const { sum, currency } = props;
  return (
    <TableFooter>
      <TableRow>
        <TableCell sx={{ fontWeight: 700, borderTop: 1, borderColor: 'divider' }}>Summe (Zeitraum)</TableCell>
        <TableCell
          align="right"
          sx={{
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            borderTop: 1,
            borderColor: 'divider',
            color: valueSignColor(sum),
          }}
        >
          {formatMoney(sum.toFixed(2), currency)}
        </TableCell>
        <TableCell colSpan={2} sx={{ borderTop: 1, borderColor: 'divider' }} />
      </TableRow>
    </TableFooter>
  );
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

/** Summe der negativen Beträge unter ``transfer_bookings`` (abgehende Umbuchungen, Bank-Vorzeichen). */
function sumNegativeTransferBookings(data: DayZeroMeltdownOut): number {
  let s = 0;
  for (const r of data.transfer_bookings ?? []) {
    const n = Number(r.amount);
    if (Number.isFinite(n) && n < 0) s += n;
  }
  return s;
}

/**
 * Konto · ohne Fixkosten · Startwert: **Konto**-Start (Saldo-Zeile) + Vertrags-Netto im Zeitraum + Summe negativer
 * Umbuchungen — rechnerisch „Konto abzüglich Vertragslast und abgehender Umbuchungen“ (alles Bank-Vorzeichen;
 * typisch sind Vertrags-Netto und Umbuchungen ≤ 0).
 */
function tableKontoMorgenStartInklEinnahmen(data: DayZeroMeltdownOut): number | null {
  const kontoStart = tableKontoSaldoRowStart(data);
  if (kontoStart != null && Number.isFinite(kontoStart)) {
    const vRaw = data.vertraege_netto_summe_tag_zero_zeitraum;
    const v =
      vRaw != null && String(vRaw).trim() !== '' ? Number(vRaw) : 0;
    if (vRaw != null && String(vRaw).trim() !== '' && !Number.isFinite(v)) return null;
    const negTr = sumNegativeTransferBookings(data);
    const out = kontoStart + v + negTr;
    return Number.isFinite(out) ? out : null;
  }
  const c =
    data.konto_morgen_start_inkl_einnahmen != null && String(data.konto_morgen_start_inkl_einnahmen).trim() !== ''
      ? Number(data.konto_morgen_start_inkl_einnahmen)
      : NaN;
  if (Number.isFinite(c)) return c;
  const mRaw = data.konto_saldo_morgen_tag_null;
  const eRaw = data.einnahmen_summe_tag_zero_zeitraum;
  const vRaw = data.vertraege_netto_summe_tag_zero_zeitraum;
  if (
    mRaw != null &&
    String(mRaw).trim() !== '' &&
    eRaw != null &&
    String(eRaw).trim() !== '' &&
    vRaw != null &&
    String(vRaw).trim() !== ''
  ) {
    const m = Number(mRaw);
    const e = Number(eRaw);
    const v = Number(vRaw);
    if (Number.isFinite(m) && Number.isFinite(e) && Number.isFinite(v)) return m + e + v;
  }
  if (
    mRaw != null &&
    String(mRaw).trim() !== '' &&
    eRaw != null &&
    String(eRaw).trim() !== ''
  ) {
    const m = Number(mRaw);
    const e = Number(eRaw);
    if (Number.isFinite(m) && Number.isFinite(e)) return m + e;
  }
  return null;
}

/**
 * Saldo-Diagramm · Meltdown‑Linie: Start = „Konto · ohne Fixkosten“; pro Tag um die nicht‑Vertrags‑Ausgaben
 * (``spend_excl_contract``) verringert — kumulativ je Kalendertag (Vertragsausgaben wirken nicht).
 */
function saldoReferenzMeltdownLineSeries(data: DayZeroMeltdownOut): (number | null)[] {
  const ref = tableKontoMorgenStartInklEinnahmen(data);
  if (ref == null || !Number.isFinite(ref) || Number.isNaN(ref)) {
    return data.days.map(() => null);
  }
  let run = ref;
  return data.days.map((d) => {
    const excl = Number(d.spend_excl_contract ?? 0);
    const s = Number.isFinite(excl) && excl >= 0 ? excl : 0;
    run -= s;
    return run;
  });
}

/** Lineare Soll-Rampe von „Konto · ohne Fixkosten“ auf 0 — gleiche Formel wie Tabelle / ``kontoMorgenSollHeute``. */
function kontoReferenzstartLinearSollSeries(data: DayZeroMeltdownOut): (number | null)[] {
  const ref = tableKontoMorgenStartInklEinnahmen(data);
  const n = data.days.length;
  if (ref == null || !Number.isFinite(ref) || Number.isNaN(ref) || n === 0) {
    return data.days.map(() => null);
  }
  const denom = Math.max(1, n - 1);
  return data.days.map((_, i) => ref * (1 - i / denom));
}

/**
 * Meltdown · ohne Fixkosten: Meltdown-Start (Summe aller Einnahmen im Zeitraum) + Vertrags-Netto im Zeitraum
 * (Bank-Vorzeichen; Vertrags-Netto typischerweise negativ → rechnerisch Abzug der Belastung).
 */
function tableMeltdownReferenzStartTagNull(data: DayZeroMeltdownOut): number | null {
  const md = tableMeltdownStart(data);
  if (md == null || !Number.isFinite(md) || Number.isNaN(md)) return null;
  const vRaw = data.vertraege_netto_summe_tag_zero_zeitraum;
  if (vRaw == null || String(vRaw).trim() === '') return md;
  const v = Number(vRaw);
  if (!Number.isFinite(v) || Number.isNaN(v)) return md;
  return md + v;
}

/** Meltdown-Start: API ``meltdown_start_amount`` = Summe aller positiven Umbuchungen im Zeitraum. */
function tableMeltdownStart(data: DayZeroMeltdownOut): number | null {
  if (data.meltdown_start_amount != null && String(data.meltdown_start_amount).trim() !== '') {
    const v = Number(data.meltdown_start_amount);
    if (!Number.isNaN(v)) return v;
  }
  return null;
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

/** Positive Tageshöhe für Vertrags-Anteil (Balken): typisch negatives ``contract_net_daily_avg`` → Ausgabe. */
function contractBarPerDay(d: DayZeroMeltdownOut['days'][number]): number {
  const raw = d.contract_net_daily_avg;
  if (raw == null || String(raw).trim() === '') return 0;
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return n <= 0 ? -n : 0;
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

/** Startwert für Meltdown Soll/Ist: ``meltdown_start_amount`` (Summe aller Einnahmen), sonst erster Meltdown-Saldo. */
function meltdownDayZeroStart(data: DayZeroMeltdownOut): number | null {
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
  showKontoIst: boolean;
  showReferenzMeltdownLine: boolean;
  showKontoReferenzSollLinear: boolean;
  showBarSonstige: boolean;
  showBarVertraege: boolean;
  onToggleKontoIst: () => void;
  onToggleReferenzMeltdownLine: () => void;
  onToggleKontoReferenzSollLinear: () => void;
  onToggleBarSonstige: () => void;
  onToggleBarVertraege: () => void;
  onPickSpendDay: (isoDay: string) => void;
}): { options: ApexOptions; series: any[] } {
  const {
    data,
    showKontoIst,
    showReferenzMeltdownLine,
    showKontoReferenzSollLinear,
    showBarSonstige,
    showBarVertraege,
    onToggleKontoIst,
    onToggleReferenzMeltdownLine,
    onToggleKontoReferenzSollLinear,
    onToggleBarSonstige,
    onToggleBarVertraege,
    onPickSpendDay,
  } = args;
  const tz = getAppTimeZone();
  const todayIso = isoDayInTimeZone(new Date(), tz);
  const dayIsos = data.days.map((d) => d.day);
  const cats = dayIsos;
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const referenzLineRaw = saldoReferenzMeltdownLineSeries(data);
  const referenzLineMasked = maskSeriesAfterCalendarDay(
    dayIsos,
    showReferenzMeltdownLine ? referenzLineRaw : data.days.map(() => null),
    todayIso,
  );

  const saldoIstData = maskSeriesAfterCalendarDay(
    dayIsos,
    showKontoIst ? data.days.map((d) => kontoBalanceIstDay(d)) : data.days.map(() => null),
    todayIso,
  );

  const spendSonstige = data.days.map((d) => Number(d.spend_excl_contract ?? 0));
  const spendVertraege = data.days.map((d) => Number(d.spend_contract ?? 0));
  const spendTotal = data.days.map((d) => Number(d.spend_actual ?? 0));

  const saldoIstForYBounds = maskSeriesAfterCalendarDay(
    dayIsos,
    data.days.map((d) => kontoBalanceIstDay(d)),
    todayIso,
  );
  const referenzForYBounds = maskSeriesAfterCalendarDay(dayIsos, referenzLineRaw, todayIso);
  const referenzLinearSollRaw = kontoReferenzstartLinearSollSeries(data);
  const referenzLinearSollData = showKontoReferenzSollLinear
    ? referenzLinearSollRaw
    : data.days.map(() => null);
  const saldoLinesForYMin = [saldoIstForYBounds, referenzForYBounds, referenzLinearSollRaw];
  const yAxisMinSaldo = yAxisMinTrimZeroGap({
    linesForMin: saldoLinesForYMin,
    allForMax: [...saldoLinesForYMin, spendTotal],
  });
  const yAxisMaxSaldo = yAxisMaxSaldoMixed({
    linesForMax: saldoLinesForYMin,
    stackedBarsPerDay: spendTotal,
    yMinHint: yAxisMinSaldo,
  });

  const nullLine = data.days.map(() => null);
  /** Linien zuerst, gestapelte Ausgaben-Balken (sonstige unten, Verträge oben). */
  const series = [
    { name: 'Konto · Ist', data: saldoIstData },
    { name: 'Meltdown‑Linie (ohne Fixkosten)', data: referenzLineMasked },
    { name: 'Konto · ohne Fixkosten · Soll (linear)', data: referenzLinearSollData },
    {
      name: 'Ausgaben · sonstige',
      type: 'column',
      stack: 'ausgaben',
      data: showBarSonstige ? spendSonstige : nullLine,
    },
    {
      name: 'Ausgaben · Verträge',
      type: 'column',
      stack: 'ausgaben',
      data: showBarVertraege ? spendVertraege : nullLine,
    },
  ];

  const COLOR_KONTO_IST = '#00E396';
  const COLOR_REFERENZ_MELTDOWN = '#008FFB';
  const COLOR_REFERENZ_SOLL_LINEAR = '#69F0AE';
  const COLOR_BAR_SONSTIGE = '#FEB019';
  const COLOR_BAR_VERTRAEGE = '#FF4560';
  const strokeStyles = series.map((s: { name?: string; type?: string }) => {
    const n = String(s.name ?? '');
    if (n === 'Konto · Ist') return { w: 2, dash: 0, color: COLOR_KONTO_IST };
    if (n === 'Meltdown‑Linie (ohne Fixkosten)') return { w: 3, dash: 6, color: COLOR_REFERENZ_MELTDOWN };
    if (n === 'Konto · ohne Fixkosten · Soll (linear)') return { w: 2, dash: 6, color: COLOR_REFERENZ_SOLL_LINEAR };
    if (n === 'Ausgaben · sonstige') return { w: 0, dash: 0, color: COLOR_BAR_SONSTIGE };
    if (n === 'Ausgaben · Verträge') return { w: 0, dash: 0, color: COLOR_BAR_VERTRAEGE };
    return { w: 0, dash: 0, color: COLOR_BAR_SONSTIGE };
  });

  const options: ApexOptions = {
    chart: {
      type: 'line',
      height: 340,
      stacked: true,
      stackOnlyBar: true,
      toolbar: { show: false },
      zoom: { enabled: false },
      events: {
        legendClick: (_chartCtx, seriesIndex, config) => {
          const names = config?.globals?.seriesNames;
          const name =
            typeof seriesIndex === 'number' && names ? String(names[seriesIndex] ?? '') : '';
          if (name === 'Konto · Ist') onToggleKontoIst();
          else if (name === 'Meltdown‑Linie (ohne Fixkosten)') onToggleReferenzMeltdownLine();
          else if (name === 'Konto · ohne Fixkosten · Soll (linear)') onToggleKontoReferenzSollLinear();
          else if (name === 'Ausgaben · sonstige') onToggleBarSonstige();
          else if (name === 'Ausgaben · Verträge') onToggleBarVertraege();
          return false; // prevent Apex default hide/show
        },
        dataPointSelection: (_event, _chartCtx, cfg) => {
          const si = cfg?.seriesIndex;
          const di = cfg?.dataPointIndex;
          const sNames = cfg?.w?.globals?.seriesNames;
          const name = typeof si === 'number' && sNames ? String(sNames[si] ?? '') : '';
          const isSpend = name === 'Ausgaben · Verträge' || name === 'Ausgaben · sonstige';
          if (!isSpend) return;
          if (name === 'Ausgaben · Verträge' && !showBarVertraege) return;
          if (name === 'Ausgaben · sonstige' && !showBarSonstige) return;
          const day = typeof di === 'number' ? cats?.[di] : undefined;
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
      ...(yAxisMaxSaldo != null ? { max: yAxisMaxSaldo } : {}),
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
          (seriesName === 'Konto · Ist' && !showKontoIst) ||
          (seriesName === 'Meltdown‑Linie (ohne Fixkosten)' && !showReferenzMeltdownLine) ||
          (seriesName === 'Konto · ohne Fixkosten · Soll (linear)' && !showKontoReferenzSollLinear) ||
          (seriesName === 'Ausgaben · sonstige' && !showBarSonstige) ||
          (seriesName === 'Ausgaben · Verträge' && !showBarVertraege);
        return disabled ? `<span style="opacity:0.45">${seriesName}</span>` : seriesName;
      },
    },
  };
  return { options, series };
}

/**
 * Geld pro Tag nur für die Zeile „Konto · ohne Fixkosten“: Fix/Tag, Ø Ist/Tag (kumul., ohne Verträge), Ø Soll/Tag
 * (Rest der Meltdown‑Linie ohne Fixkosten geteilt durch Resttage).
 */
function buildGeldProTagChart(args: {
  data: DayZeroMeltdownOut;
  showFixTag: boolean;
  showIstTag: boolean;
  showSollTag: boolean;
  onToggleFixTag: () => void;
  onToggleIstTag: () => void;
  onToggleSollTag: () => void;
}): { options: ApexOptions; series: any[] } {
  const { data, showFixTag, showIstTag, showSollTag, onToggleFixTag, onToggleIstTag, onToggleSollTag } = args;
  const tz = getAppTimeZone();
  const todayIso = isoDayInTimeZone(new Date(), tz);
  const dayIsos = data.days.map((x) => x.day);
  const cats = dayIsos;
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

  const n = data.days.length;
  const referenzOhneFix = saldoReferenzMeltdownLineSeries(data);
  const kontoOhneFixSollDynPerDay = data.days.map((_, i) => {
    const left = n - i;
    if (left <= 0) return null;
    const r = referenzOhneFix[i];
    if (r == null || !Number.isFinite(r)) return null;
    return r / left;
  });
  const morgenStartTab = tableKontoMorgenStartInklEinnahmen(data);
  const kontoOhneFixSollFixPerDay =
    n > 0 && morgenStartTab != null && Number.isFinite(morgenStartTab) && !Number.isNaN(morgenStartTab)
      ? data.days.map(() => morgenStartTab / n)
      : data.days.map(() => null);

  /** Kumulativer Durchschnitt: Summe Ausgaben ohne Verträge 0..i geteilt durch (i+1) — wie Spalte Ø Ist/Tag. */
  const istKumAvgExclRaw: (number | null)[] = (() => {
    if (n === 0) return [];
    let run = 0;
    return data.days.map((row, i) => {
      run += Number(row.spend_excl_contract ?? 0);
      const days = i + 1;
      return days > 0 ? run / days : null;
    });
  })();

  const nullLine = data.days.map(() => null);
  const kontoOhneFixDynMasked = maskSeriesAfterCalendarDay(dayIsos, kontoOhneFixSollDynPerDay, todayIso);
  const istKumAvgExclMasked = maskSeriesAfterCalendarDay(dayIsos, istKumAvgExclRaw, todayIso);
  const geldLinesForYMin = [kontoOhneFixSollFixPerDay, istKumAvgExclMasked, kontoOhneFixDynMasked];
  const yAxisMinGeld = yAxisMinTrimZeroGap({
    linesForMin: geldLinesForYMin,
    allForMax: geldLinesForYMin,
  });

  const COLOR_FIX = '#AB47BC';
  const COLOR_IST = '#00E396';
  const COLOR_SOLL = '#FF8A65';

  const nameFixTag = 'Fix/Tag';
  const nameIstTag = '\u00d8 Ist/Tag';
  const nameSollTag = '\u00d8 Soll/Tag';

  const series = [
    { name: nameFixTag, data: showFixTag ? kontoOhneFixSollFixPerDay : nullLine },
    { name: nameIstTag, data: showIstTag ? istKumAvgExclMasked : nullLine },
    { name: nameSollTag, data: showSollTag ? kontoOhneFixDynMasked : nullLine },
  ];

  const strokeStyles = [
    { w: 2, dash: 6, color: COLOR_FIX },
    { w: 2, dash: 0, color: COLOR_IST },
    { w: 4, dash: 0, color: COLOR_SOLL },
  ];

  const options: ApexOptions = {
    chart: {
      type: 'line',
      height: 340,
      stacked: false,
      toolbar: { show: false },
      zoom: { enabled: false },
      events: {
        legendClick: (_chartCtx, seriesIndex, config) => {
          const names = config?.globals?.seriesNames;
          const name =
            typeof seriesIndex === 'number' && names ? String(names[seriesIndex] ?? '') : '';
          if (name === nameFixTag) onToggleFixTag();
          else if (name === nameIstTag) onToggleIstTag();
          else if (name === nameSollTag) onToggleSollTag();
          return false;
        },
      },
    },
    colors: strokeStyles.map((s) => s.color),
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
          (seriesName === nameFixTag && !showFixTag) ||
          (seriesName === nameIstTag && !showIstTag) ||
          (seriesName === nameSollTag && !showSollTag);
        return disabled ? `<span style="opacity:0.45">${seriesName}</span>` : seriesName;
      },
    },
  };
  return { options, series };
}

export default function DayZero() {
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  const accountsAll = accountsQ.data ?? [];
  const accountNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of accountsAll) {
      m.set(a.id, a.name);
    }
    return m;
  }, [accountsAll]);
  const accounts = useMemo(() => accountsAll.filter(accountHasTagZeroRule), [accountsAll]);
  const [pick, setPick] = useState<number | ''>('');
  const [showSaldoIst, setShowSaldoIst] = useState(true);
  const [showSaldoReferenzMeltdownLine, setShowSaldoReferenzMeltdownLine] = useState(true);
  const [showSaldoKontoReferenzSollLinear, setShowSaldoKontoReferenzSollLinear] = useState(true);
  const [showSaldoBarSonstige, setShowSaldoBarSonstige] = useState(true);
  const [showSaldoBarVertraege, setShowSaldoBarVertraege] = useState(true);
  const [selectedSpendDay, setSelectedSpendDay] = useState<string | null>(null);
  const [showSpendFixTag, setShowSpendFixTag] = useState(true);
  const [showSpendIstTag, setShowSpendIstTag] = useState(true);
  const [showSpendSollTag, setShowSpendSollTag] = useState(true);

  const effectiveAccountId = pick === '' ? (accounts[0]?.id ?? null) : pick;

  const meltdownQ = useQuery({
    queryKey: ['dayzero-meltdown', effectiveAccountId],
    queryFn: () => fetchDayZeroMeltdown(effectiveAccountId as number, 1),
    enabled: effectiveAccountId != null,
  });

  const toggleSaldoIst = useCallback(() => setShowSaldoIst((v) => !v), []);
  const toggleSaldoReferenzMeltdownLine = useCallback(() => setShowSaldoReferenzMeltdownLine((v) => !v), []);
  const toggleSaldoKontoReferenzSollLinear = useCallback(() => setShowSaldoKontoReferenzSollLinear((v) => !v), []);
  const toggleSaldoBarSonstige = useCallback(() => setShowSaldoBarSonstige((v) => !v), []);
  const toggleSaldoBarVertraege = useCallback(() => setShowSaldoBarVertraege((v) => !v), []);
  const pickSpendDay = useCallback((isoDay: string) => setSelectedSpendDay(isoDay), []);
  const toggleSpendFixTag = useCallback(() => setShowSpendFixTag((v) => !v), []);
  const toggleSpendIstTag = useCallback(() => setShowSpendIstTag((v) => !v), []);
  const toggleSpendSollTag = useCallback(() => setShowSpendSollTag((v) => !v), []);

  const todaySummary = useMemo(() => {
    const d = meltdownQ.data;
    if (!d) return null;
    const todayIso = isoDayInTimeZone(new Date(), getAppTimeZone());
    const n = d.days.length;
    const md0 = meltdownDayZeroStart(d);
    const hasMd = md0 != null && !Number.isNaN(md0);
    const kontoFixProTag = kontoFixProTagRate(d);
    /** Meltdown Fix/Tag: meltdown_start_amount / n (Summe Einnahmen / Periodentage). */
    const meltdownFixProTag = n > 0 && hasMd ? (md0 as number) / n : null;
    /** Vertrags-Netto im Zeitraum ÷ Kalendertage, als positive Tagesbelastung (wie Diagramm-Balken). */
    const vertrageGeldProTag = n > 0 ? contractBarPerDay(d.days[0]) : null;

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
        vertrageGeldProTag,
        kontoMorgenSollHeute: null as number | null,
        kontoMorgenDeltaIstSoll: null as number | null,
        kontoMorgenFixProTag: null as number | null,
        kontoMorgenGeldSollProTagAvg: null as number | null,
        kontoMorgenGeldDeltaIstSoll: null as number | null,
        meltdownReferenzSollHeute: null as number | null,
        meltdownReferenzDeltaIstSoll: null as number | null,
        meltdownReferenzFixProTag: null as number | null,
        meltdownReferenzGeldSollProTagAvg: null as number | null,
        meltdownReferenzGeldDeltaIstSoll: null as number | null,
        kontoCompositeSollHeute: null as number | null,
        kontoCompositeDeltaIstSoll: null as number | null,
        kontoCompositeFixProTag: null as number | null,
        kontoCompositeGeldSollProTagAvg: null as number | null,
        kontoCompositeGeldDeltaIstSoll: null as number | null,
        geldIstProTagAvgExclContract: null as number | null,
        kontoCompositeGeldSollMinusIst: null as number | null,
        kontoCompositeGeldStartMinusIst: null as number | null,
        kontoMorgenGeldSollMinusIst: null as number | null,
        kontoMorgenGeldStartMinusIst: null as number | null,
        meltdownGeldSollMinusIst: null as number | null,
        meltdownGeldStartMinusIst: null as number | null,
        meltdownReferenzGeldSollMinusIst: null as number | null,
        meltdownReferenzGeldStartMinusIst: null as number | null,
        kontoDayZeroFixProTag: null as number | null,
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

    /** Konto · ohne Fixkosten · Soll: wie Konto-Soll-Linie — linear vom Tabellen-Startwert auf 0 bis Periodenende. */
    const kontoMorgenStartTab = tableKontoMorgenStartInklEinnahmen(d);
    const denomKontoMorgen = Math.max(1, n - 1);
    const kontoMorgenSollHeute =
      kontoMorgenStartTab != null &&
      Number.isFinite(kontoMorgenStartTab) &&
      !Number.isNaN(kontoMorgenStartTab) &&
      idx >= 0
        ? kontoMorgenStartTab * (1 - idx / denomKontoMorgen)
        : null;
    const kontoMorgenDeltaIstSoll =
      kontoMorgenSollHeute != null &&
      Number.isFinite(kontoSaldoHeute) &&
      Number.isFinite(kontoMorgenSollHeute)
        ? kontoSaldoHeute - kontoMorgenSollHeute
        : null;

    /** Konto · Zeile: linearer Soll vom zusammengesetzten Start (Morgen + pos. Umbuchungen + sonst. Einnahmen) auf 0. */
    const kontoCompositeStartTab = tableKontoSaldoRowStart(d);
    const denomKontoComposite = Math.max(1, n - 1);
    const kontoCompositeSollHeute =
      kontoCompositeStartTab != null &&
      Number.isFinite(kontoCompositeStartTab) &&
      !Number.isNaN(kontoCompositeStartTab) &&
      idx >= 0
        ? kontoCompositeStartTab * (1 - idx / denomKontoComposite)
        : null;
    const kontoCompositeDeltaIstSoll =
      kontoCompositeSollHeute != null &&
      Number.isFinite(kontoSaldoHeute) &&
      Number.isFinite(kontoCompositeSollHeute)
        ? kontoSaldoHeute - kontoCompositeSollHeute
        : null;

    /** Konto · Day Zero (Geld-Tabelle): Fix/Tag = Morgen-Saldo Tag Null / Periodentage — nur Referenz zum Start. */
    const kontoMorningTagNullTab = tableKontoMorningTagNull(d);
    const kontoDayZeroFixProTag =
      n > 0 &&
      kontoMorningTagNullTab != null &&
      Number.isFinite(kontoMorningTagNullTab) &&
      !Number.isNaN(kontoMorningTagNullTab)
        ? kontoMorningTagNullTab / n
        : null;

    /** Wie Konto-Fix/Tag, aber Startwert = „Konto · ohne Fixkosten“ (Startwert-Spalte). */
    const kontoMorgenFixProTag =
      n > 0 &&
      kontoMorgenStartTab != null &&
      Number.isFinite(kontoMorgenStartTab) &&
      !Number.isNaN(kontoMorgenStartTab)
        ? kontoMorgenStartTab / n
        : null;

    /** Fix/Tag für Zeile „Konto“: zusammengesetzter Start (Morgen + pos. Umbuchungen + sonst. Einnahmen) / Periodentage. */
    const kontoCompositeFixProTag =
      n > 0 &&
      kontoCompositeStartTab != null &&
      Number.isFinite(kontoCompositeStartTab) &&
      !Number.isNaN(kontoCompositeStartTab)
        ? kontoCompositeStartTab / n
        : null;

    /** Meltdown · ohne Fixkosten: linearer Soll-Pfad vom Startwert Meltdown + Vertrags-Netto (signed). */
    const meltdownReferenzStartTab = tableMeltdownReferenzStartTagNull(d);
    const denomMeltdownReferenz = Math.max(1, n - 1);
    const hasMeltdownReferenz =
      meltdownReferenzStartTab != null &&
      Number.isFinite(meltdownReferenzStartTab) &&
      !Number.isNaN(meltdownReferenzStartTab);
    const meltdownReferenzSollHeute =
      hasMeltdownReferenz && idx >= 0
        ? (meltdownReferenzStartTab as number) * (1 - idx / denomMeltdownReferenz)
        : null;
    const meltdownReferenzDeltaIstSoll =
      meltdownReferenzSollHeute != null &&
      Number.isFinite(kontoSaldoHeute) &&
      Number.isFinite(meltdownReferenzSollHeute)
        ? kontoSaldoHeute - meltdownReferenzSollHeute
        : null;
    const meltdownReferenzFixProTag =
      n > 0 && hasMeltdownReferenz ? (meltdownReferenzStartTab as number) / n : null;

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
    let spendExclContractSumToToday = 0;
    for (let i = 0; i <= idx; i++) {
      const row = d.days[i];
      const exRaw = row?.spend_excl_contract;
      const hasEx = exRaw != null && String(exRaw).trim() !== '';
      const nEx = hasEx ? Number(exRaw) : Number(row?.spend_actual ?? 0);
      if (Number.isFinite(nEx)) spendExclContractSumToToday += nEx;
    }
    const geldIstProTagAvgExclContract =
      daysElapsedGeld > 0 && Number.isFinite(spendExclContractSumToToday)
        ? spendExclContractSumToToday / daysElapsedGeld
        : null;
    /** Ø Soll/Tag (Geld-Tabelle): Soll-Stand auf der linearen Rampe heute, geteilt durch restliche Tage inkl. heute. */
    const kontoGeldSollProTagAvg =
      daysLeftInclToday > 0 && Number.isFinite(kontoSollHeute)
        ? kontoSollHeute / daysLeftInclToday
        : null;
    const meltdownGeldSollProTagAvg =
      daysLeftInclToday > 0 &&
      meltdownSollHeute != null &&
      Number.isFinite(meltdownSollHeute)
        ? meltdownSollHeute / daysLeftInclToday
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
    /** Wie Diagramm „Meltdown‑Linie (ohne Fixkosten)“: Rest am Stichtag (nicht die lineare Soll-Rampe). */
    const kontoMorgenMeltdownPfadRestHeute = (() => {
      const serie = saldoReferenzMeltdownLineSeries(d);
      const v = serie[idx];
      return v != null && Number.isFinite(v) ? v : null;
    })();
    const kontoMorgenRestFuerGeldSollProTag =
      kontoMorgenMeltdownPfadRestHeute != null
        ? kontoMorgenMeltdownPfadRestHeute
        : kontoMorgenSollHeute;
    const kontoMorgenGeldSollProTagAvg =
      daysLeftInclToday > 0 &&
      kontoMorgenRestFuerGeldSollProTag != null &&
      Number.isFinite(kontoMorgenRestFuerGeldSollProTag)
        ? kontoMorgenRestFuerGeldSollProTag / daysLeftInclToday
        : null;
    const kontoMorgenGeldDeltaIstSoll =
      geldIstProTagAvgExclContract != null &&
      kontoMorgenGeldSollProTagAvg != null &&
      Number.isFinite(geldIstProTagAvgExclContract) &&
      Number.isFinite(kontoMorgenGeldSollProTagAvg)
        ? geldIstProTagAvgExclContract - kontoMorgenGeldSollProTagAvg
        : null;
    const meltdownReferenzGeldSollProTagAvg =
      daysLeftInclToday > 0 &&
      meltdownReferenzSollHeute != null &&
      Number.isFinite(meltdownReferenzSollHeute)
        ? meltdownReferenzSollHeute / daysLeftInclToday
        : null;
    const meltdownReferenzGeldDeltaIstSoll =
      geldIstProTagAvgExclContract != null &&
      meltdownReferenzGeldSollProTagAvg != null &&
      Number.isFinite(geldIstProTagAvgExclContract) &&
      Number.isFinite(meltdownReferenzGeldSollProTagAvg)
        ? geldIstProTagAvgExclContract - meltdownReferenzGeldSollProTagAvg
        : null;
    const kontoCompositeGeldSollProTagAvg =
      daysLeftInclToday > 0 &&
      kontoCompositeSollHeute != null &&
      Number.isFinite(kontoCompositeSollHeute)
        ? kontoCompositeSollHeute / daysLeftInclToday
        : null;
    const kontoCompositeGeldDeltaIstSoll =
      geldIstProTagAvg != null &&
      kontoCompositeGeldSollProTagAvg != null &&
      Number.isFinite(geldIstProTagAvg) &&
      Number.isFinite(kontoCompositeGeldSollProTagAvg)
        ? geldIstProTagAvg - kontoCompositeGeldSollProTagAvg
        : null;

    /** Geld-Tabelle: Soll − Ist bzw. Fix/Tag (Start) − Ø Ist — negativ bei höherem Ist als Soll/Start-Rate. */
    const kontoCompositeGeldSollMinusIst =
      kontoCompositeGeldSollProTagAvg != null &&
      geldIstProTagAvg != null &&
      Number.isFinite(kontoCompositeGeldSollProTagAvg) &&
      Number.isFinite(geldIstProTagAvg)
        ? kontoCompositeGeldSollProTagAvg - geldIstProTagAvg
        : null;
    const kontoCompositeGeldStartMinusIst =
      kontoCompositeFixProTag != null &&
      geldIstProTagAvg != null &&
      Number.isFinite(kontoCompositeFixProTag) &&
      Number.isFinite(geldIstProTagAvg)
        ? kontoCompositeFixProTag - geldIstProTagAvg
        : null;
    const kontoMorgenGeldSollMinusIst =
      kontoMorgenGeldSollProTagAvg != null &&
      geldIstProTagAvgExclContract != null &&
      Number.isFinite(kontoMorgenGeldSollProTagAvg) &&
      Number.isFinite(geldIstProTagAvgExclContract)
        ? kontoMorgenGeldSollProTagAvg - geldIstProTagAvgExclContract
        : null;
    const kontoMorgenGeldStartMinusIst =
      kontoMorgenFixProTag != null &&
      geldIstProTagAvgExclContract != null &&
      Number.isFinite(kontoMorgenFixProTag) &&
      Number.isFinite(geldIstProTagAvgExclContract)
        ? kontoMorgenFixProTag - geldIstProTagAvgExclContract
        : null;
    const meltdownGeldSollMinusIst =
      meltdownGeldSollProTagAvg != null &&
      geldIstProTagAvg != null &&
      Number.isFinite(meltdownGeldSollProTagAvg) &&
      Number.isFinite(geldIstProTagAvg)
        ? meltdownGeldSollProTagAvg - geldIstProTagAvg
        : null;
    const meltdownGeldStartMinusIst =
      meltdownFixProTag != null &&
      geldIstProTagAvg != null &&
      Number.isFinite(meltdownFixProTag) &&
      Number.isFinite(geldIstProTagAvg)
        ? meltdownFixProTag - geldIstProTagAvg
        : null;
    const meltdownReferenzGeldSollMinusIst =
      meltdownReferenzGeldSollProTagAvg != null &&
      geldIstProTagAvgExclContract != null &&
      Number.isFinite(meltdownReferenzGeldSollProTagAvg) &&
      Number.isFinite(geldIstProTagAvgExclContract)
        ? meltdownReferenzGeldSollProTagAvg - geldIstProTagAvgExclContract
        : null;
    const meltdownReferenzGeldStartMinusIst =
      meltdownReferenzFixProTag != null &&
      geldIstProTagAvgExclContract != null &&
      Number.isFinite(meltdownReferenzFixProTag) &&
      Number.isFinite(geldIstProTagAvgExclContract)
        ? meltdownReferenzFixProTag - geldIstProTagAvgExclContract
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
      vertrageGeldProTag,
      kontoMorgenSollHeute,
      kontoMorgenDeltaIstSoll,
      kontoMorgenFixProTag,
      kontoMorgenGeldSollProTagAvg,
      kontoMorgenGeldDeltaIstSoll,
      meltdownReferenzSollHeute,
      meltdownReferenzDeltaIstSoll,
      meltdownReferenzFixProTag,
      meltdownReferenzGeldSollProTagAvg,
      meltdownReferenzGeldDeltaIstSoll,
      kontoCompositeSollHeute,
      kontoCompositeDeltaIstSoll,
      kontoCompositeFixProTag,
      kontoCompositeGeldSollProTagAvg,
      kontoCompositeGeldDeltaIstSoll,
      geldIstProTagAvgExclContract,
      kontoCompositeGeldSollMinusIst,
      kontoCompositeGeldStartMinusIst,
      kontoMorgenGeldSollMinusIst,
      kontoMorgenGeldStartMinusIst,
      meltdownGeldSollMinusIst,
      meltdownGeldStartMinusIst,
      meltdownReferenzGeldSollMinusIst,
      meltdownReferenzGeldStartMinusIst,
      kontoDayZeroFixProTag,
    };
  }, [meltdownQ.data]);

  const charts = useMemo(() => {
    if (!meltdownQ.data) return null;
    const d = meltdownQ.data;

    return {
      saldo: buildSaldoChart({
        data: d,
        showKontoIst: showSaldoIst,
        showReferenzMeltdownLine: showSaldoReferenzMeltdownLine,
        showKontoReferenzSollLinear: showSaldoKontoReferenzSollLinear,
        showBarSonstige: showSaldoBarSonstige,
        showBarVertraege: showSaldoBarVertraege,
        onToggleKontoIst: toggleSaldoIst,
        onToggleReferenzMeltdownLine: toggleSaldoReferenzMeltdownLine,
        onToggleKontoReferenzSollLinear: toggleSaldoKontoReferenzSollLinear,
        onToggleBarSonstige: toggleSaldoBarSonstige,
        onToggleBarVertraege: toggleSaldoBarVertraege,
        onPickSpendDay: pickSpendDay,
      }),
      spend: buildGeldProTagChart({
        data: d,
        showFixTag: showSpendFixTag,
        showIstTag: showSpendIstTag,
        showSollTag: showSpendSollTag,
        onToggleFixTag: toggleSpendFixTag,
        onToggleIstTag: toggleSpendIstTag,
        onToggleSollTag: toggleSpendSollTag,
      }),
    };
  }, [
    meltdownQ.data,
    showSaldoIst,
    showSaldoReferenzMeltdownLine,
    showSaldoKontoReferenzSollLinear,
    showSaldoBarSonstige,
    showSaldoBarVertraege,
    toggleSaldoIst,
    toggleSaldoReferenzMeltdownLine,
    toggleSaldoKontoReferenzSollLinear,
    toggleSaldoBarSonstige,
    toggleSaldoBarVertraege,
    pickSpendDay,
    showSpendFixTag,
    showSpendIstTag,
    showSpendSollTag,
    toggleSpendFixTag,
    toggleSpendIstTag,
    toggleSpendSollTag,
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
                  {(() => {
                    const d = meltdownQ.data;
                    const cur = d.currency;
                    const kontoMorgenStartInklEinnahmen = tableKontoMorgenStartInklEinnahmen(d);
                    const kontoMorningTagNullTab = tableKontoMorningTagNull(d);
                    const kontoSaldoRowStartTab = tableKontoSaldoRowStart(d);
                    const meltdownReferenzStartTagNullTab = tableMeltdownReferenzStartTagNull(d);
                    const meltdownD0 = tableMeltdownStart(d);
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
                      <Stack spacing={2.5}>
                        <Box>
                          <Typography variant="subtitle2" fontWeight={700} color="text.secondary" sx={{ mb: 0.75 }}>
                            Saldo
                          </Typography>
                          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.75 }}>
                            Tag Null → heute. Alle Beträge in Euro (Bestand). Spalte Startwert: je Zeile der Bezug zu
                            Periodenbeginn (bei <strong>Konto · Day Zero</strong>: ausschließlich der errechnete
                            Morgen-Saldo am Tag Null — <strong>nur diese Spalte</strong>, ohne Ist/Soll-Vergleich; bei{' '}
                            <strong>Konto</strong>: <strong>Konto · Day Zero</strong> (Morgen-Saldo Tag Null) zuzüglich
                            Summe <strong>Geldeingänge</strong> im Zeitraum (alle positiven Zuflüsse inkl. eingehender
                            Umbuchungen, vgl. Grundlagen); bei{' '}
                            <strong>Konto · ohne Fixkosten</strong>: Konto-Start zuzüglich Vertrags-Netto und negativer
                            Umbuchungen (Bank-Vorzeichen); bei <strong>Meltdown · ohne Fixkosten</strong>: Meltdown-Start plus Vertrags-Netto
                            im Zeitraum — Bank-Vorzeichen, typisch negativ). Spalte Ist: aktueller Messwert zum Stichtag (bei{' '}
                            <strong>Konto</strong>, <strong>Konto · ohne Fixkosten</strong> und{' '}
                            <strong>Meltdown · ohne Fixkosten</strong>: Kontostand; bei <strong>Meltdown</strong>: Meltdown‑Ist).
                            Spalte Soll: Vorgabe der linearen Soll‑Linie am Stichtag. Spalte Ist − Soll: Differenz (Ist
                            abzüglich Soll).
                          </Typography>
                          <TableContainer>
                            <Table size="small" sx={{ '& td, & th': { py: 0.75 } }}>
                              <TableHead>
                                <TableRow>
                                  <TableCell sx={{ fontWeight: 700 }} />
                                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                                    Startwert
                                  </TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                                    Ist
                                  </TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 700 }}>
                                    Soll
                                  </TableCell>
                                  <TableCell align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                                    Ist − Soll
                                  </TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                <TableRow hover>
                                  <TableCell sx={{ maxWidth: 360 }}>
                                    <Typography variant="body2" fontWeight={600}>
                                      Konto · Day Zero
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                      Nur Referenz: errechneter Morgen-Saldo am Tag Null (ohne positive Umbuchungen,
                                      sonstige Einnahmen oder Vertrags-Netto). Kein Ist/Soll-Vergleich in dieser Zeile.
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right">{money(kontoMorningTagNullTab)}</TableCell>
                                  <TableCell align="right">—</TableCell>
                                  <TableCell align="right">—</TableCell>
                                  <TableCell align="right">—</TableCell>
                                </TableRow>
                                <TableRow hover>
                                  <TableCell sx={{ maxWidth: 360 }}>
                                    <Typography variant="body2" fontWeight={600}>
                                      Konto
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                      Start: Morgen-Saldo Tag Null plus positive Umbuchungen und sonstige Einnahmen (ohne
                                      eingehende Umbuchungen). Soll: gleichmäßige Rampe auf 0; Ist: Kontostand.
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right">{money(kontoSaldoRowStartTab)}</TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.kontoSaldoHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.kontoCompositeSollHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.kontoCompositeDeltaIstSoll) : '—'}
                                  </TableCell>
                                </TableRow>
                                <TableRow hover>
                                  <TableCell sx={{ maxWidth: 360 }}>
                                    <Typography variant="body2" fontWeight={600}>
                                      Konto · ohne Fixkosten
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                      Start = <strong>Konto</strong>-Start (Saldo) + Vertrags-Netto im Zeitraum + Summe
                                      negativer Umbuchungen — rechnerisch Konto abzüglich Vertragslast und abgehender
                                      Umbuchungen (Bank-Vorzeichen). Gleicher Kontostand in Ist, anderer Soll-Bezug.
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right">{money(kontoMorgenStartInklEinnahmen)}</TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.kontoSaldoHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.kontoMorgenSollHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.kontoMorgenDeltaIstSoll) : '—'}
                                  </TableCell>
                                </TableRow>
                                <TableRow hover>
                                  <TableCell sx={{ maxWidth: 360 }}>
                                    <Typography variant="body2" fontWeight={600}>
                                      Meltdown
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                      Start = Summe aller Einnahmen im Zeitraum (positive Buchungen, inkl. eingehender
                                      Umbuchungen). Soll: lineare Rampe; Ist: abgeleitete Meltdown-Kurve (Ausgaben ohne
                                      Verträge) — nicht roher Kontostand.
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right">{money(meltdownD0)}</TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.meltdownIstHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.meltdownSollHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(meltdownDeltaIstSoll) : '—'}
                                  </TableCell>
                                </TableRow>
                                <TableRow hover>
                                  <TableCell sx={{ maxWidth: 360 }}>
                                    <Typography variant="body2" fontWeight={600}>
                                      Meltdown · ohne Fixkosten
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                      Meltdown-Start plus Vertrags-Netto; Ist weiterhin Kontostand — gleicher Messwert wie
                                      bei „Konto“, anderer Soll-Pfad.
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right">{money(meltdownReferenzStartTagNullTab)}</TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.kontoSaldoHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.meltdownReferenzSollHeute) : '—'}
                                  </TableCell>
                                  <TableCell align="right">
                                    {todaySummary?.inRange ? money(todaySummary.meltdownReferenzDeltaIstSoll) : '—'}
                                  </TableCell>
                                </TableRow>
                              </TableBody>
                            </Table>
                          </TableContainer>
                        </Box>

                        {todaySummary ? (
                          <Box>
                            <Typography variant="subtitle2" fontWeight={700} color="text.secondary" sx={{ mb: 0.75 }}>
                              Geld pro Tag
                            </Typography>
                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.75 }}>
                              Alle Beträge in Euro pro Kalendertag. Fix/Tag = fixe Tagesrate aus der Soll‑Rechnung (wie
                              Diagramm); Ø Ist/Tag = durchschnittliche Ausgaben/Tag ohne Umbuchungen bis heute; Ø Soll/Tag
                              = verbleibender Soll‑Stand (lineare Rampe) an diesem Tag geteilt durch die restlichen
                              Kalendertage <strong>inkl. heute</strong>;{' '}
                              <strong>Soll − Ist</strong> = Ø Soll/Tag (Rest‑Soll zu Resttagen) minus Ø‑Ist (negativ, wenn
                              dein bisheriger Tages‑Ist‑Mittel über diesem Rest‑Soll‑Pro‑Tag liegt); <strong>Start − Ist</strong>{' '}
                              = Fix/Tag (Start
                              geteilt durch Periodentage) minus Ø‑Ist — negativ bei Überausgabe gegenüber der gleichmäßigen
                              Start‑Tagesrate. Zeile <strong>Konto · Day Zero</strong> steht zuerst und zeigt nur{' '}
                              <strong>Fix/Tag</strong> (= Morgen-Saldo am Tag Null geteilt durch die Periodentage); die übrigen Spalten
                              entfallen. Zeile                               <strong>Konto</strong> entspricht der Saldo‑Zeile „Konto“
                              (Start: Konto · Day Zero + Summe Geldeingänge im Zeitraum). Bei{' '}
                              <strong>Konto · ohne Fixkosten</strong> und <strong>Meltdown · ohne Fixkosten</strong> ist
                              Ø Ist/Tag <strong>ohne Vertragsausgaben</strong> (tägliche Ausgaben ohne vertragsverknüpfte
                              Buchungen), passend zur Logik „ohne Fixkosten“; die übrigen Zeilen nutzen die volle
                              Tagesausgabe inkl. Verträge. Zeile <strong>Konto · ohne Fixkosten</strong>: Fix/Tag aus dem
                              erweiterten Startwert inkl. Vertrags‑Netto; Ø Soll/Tag nutzt den <strong>Rest</strong> der
                              Meltdown‑Linie ohne Fixkosten (wie im Saldo‑Diagramm) geteilt durch Resttage — z. B. 219,68�
                              16 Tage � 13,73 €/Tag. Zeile{' '}
                              <strong>Meltdown</strong>: wie im Diagramm (Summe Einnahmen / Periodentage). Zeile{' '}
                              <strong>Meltdown · ohne Fixkosten</strong>: Fix/Tag und Ø Soll/Tag vom Startwert
                              Meltdown‑Start + Vertrags‑Netto (Bank‑Vorzeichen, typisch negativ). Verträge: Summe
                              Vertrags‑Buchungen im Zeitraum ÷ Kalendertage
                              (gleichmäßiger Tagesanteil).
                            </Typography>
                            <TableContainer>
                              <Table size="small" sx={{ '& td, & th': { py: 0.75 } }}>
                                <TableHead>
                                  <TableRow>
                                    <TableCell sx={{ fontWeight: 700 }} />
                                    <TableCell align="right" sx={{ fontWeight: 700 }}>
                                      Fix/Tag
                                    </TableCell>
                                    <TableCell align="right" sx={{ fontWeight: 700 }}>
                                      Ø Ist/Tag
                                    </TableCell>
                                    <TableCell align="right" sx={{ fontWeight: 700 }}>
                                      Ø Soll/Tag
                                    </TableCell>
                                    <TableCell align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                                      Soll − Ist
                                    </TableCell>
                                    <TableCell align="right" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                                      Start − Ist
                                    </TableCell>
                                  </TableRow>
                                </TableHead>
                                <TableBody>
                                  {(() => {
                                    const ts = todaySummary;
                                    return (
                                      <>
                                        <TableRow hover>
                                          <TableCell sx={{ maxWidth: 360 }}>
                                            <Typography variant="body2" fontWeight={600}>
                                              Konto · Day Zero
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                              Nur <strong>Fix/Tag</strong>: Morgen-Saldo am Tag Null geteilt durch die
                                              Periodentage (Referenz zum Startwert der Saldo-Zeile). Keine weiteren
                                              Kennzahlen in dieser Zeile.
                                            </Typography>
                                          </TableCell>
                                          <TableCell align="right">{money(ts.kontoDayZeroFixProTag)}</TableCell>
                                          <TableCell align="right">—</TableCell>
                                          <TableCell align="right">—</TableCell>
                                          <TableCell align="right">—</TableCell>
                                          <TableCell align="right">—</TableCell>
                                        </TableRow>
                                        <TableRow hover>
                                          <TableCell sx={{ maxWidth: 360 }}>
                                            <Typography variant="body2" fontWeight={600}>
                                              Konto
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                              Ø Ist/Tag inkl. aller Ausgaben (ohne Umbuchungen); Vergleich mit Soll aus
                                              linearem Abbau des zusammengesetzten Konto‑Starts.
                                            </Typography>
                                          </TableCell>
                                          <TableCell align="right">{money(ts.kontoCompositeFixProTag)}</TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.geldIstProTagAvg) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.kontoCompositeGeldSollProTagAvg) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.kontoCompositeGeldSollMinusIst) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.kontoCompositeGeldStartMinusIst) : '—'}
                                          </TableCell>
                                        </TableRow>
                                        <TableRow hover>
                                          <TableCell sx={{ maxWidth: 360 }}>
                                            <Typography variant="body2" fontWeight={600}>
                                              Konto · ohne Fixkosten
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                              Ø Ist/Tag <strong>ohne</strong> Vertragsausgaben. Ø Soll/Tag = Stand der blauen
                                              Diagrammlinie „Meltdown‑Linie (ohne Fixkosten)“ geteilt durch Resttage (nicht die
                                              grüne lineare Soll‑Rampe).
                                            </Typography>
                                          </TableCell>
                                          <TableCell align="right">{money(ts.kontoMorgenFixProTag)}</TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.geldIstProTagAvgExclContract) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.kontoMorgenGeldSollProTagAvg) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.kontoMorgenGeldSollMinusIst) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.kontoMorgenGeldStartMinusIst) : '—'}
                                          </TableCell>
                                        </TableRow>
                                        <TableRow hover>
                                          <TableCell>
                                            <Typography variant="body2" fontWeight={600}>
                                              Meltdown
                                            </Typography>
                                          </TableCell>
                                          <TableCell align="right">{money(ts.meltdownFixProTag)}</TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.geldIstProTagAvg) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.meltdownGeldSollProTagAvg) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.meltdownGeldSollMinusIst) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.meltdownGeldStartMinusIst) : '—'}
                                          </TableCell>
                                        </TableRow>
                                        <TableRow hover>
                                          <TableCell sx={{ maxWidth: 360 }}>
                                            <Typography variant="body2" fontWeight={600}>
                                              Meltdown · ohne Fixkosten
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.25 }}>
                                              Ø Ist/Tag <strong>ohne</strong> Vertragsausgaben; Soll‑Bezug Meltdown‑Start
                                              + Vertrags‑Netto.
                                            </Typography>
                                          </TableCell>
                                          <TableCell align="right">{money(ts.meltdownReferenzFixProTag)}</TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.geldIstProTagAvgExclContract) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.meltdownReferenzGeldSollProTagAvg) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.meltdownReferenzGeldSollMinusIst) : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.inRange ? money(ts.meltdownReferenzGeldStartMinusIst) : '—'}
                                          </TableCell>
                                        </TableRow>
                                        <TableRow hover>
                                          <TableCell>
                                            <Typography variant="body2" fontWeight={600}>
                                              Verträge
                                            </Typography>
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.vertrageGeldProTag != null && ts.vertrageGeldProTag > 0
                                              ? money(ts.vertrageGeldProTag)
                                              : '—'}
                                          </TableCell>
                                          <TableCell align="right">
                                            {ts.vertrageGeldProTag != null && ts.vertrageGeldProTag > 0
                                              ? money(ts.vertrageGeldProTag)
                                              : '—'}
                                          </TableCell>
                                          <TableCell align="right">—</TableCell>
                                          <TableCell align="right">—</TableCell>
                                          <TableCell align="right">—</TableCell>
                                        </TableRow>
                                      </>
                                    );
                                  })()}
                                </TableBody>
                              </Table>
                            </TableContainer>
                          </Box>
                        ) : null}
                      </Stack>
                    );
                  })()}
                  {todaySummary && !todaySummary.inRange ? (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25 }}>
                      Heute ({formatEuropeanDate(todaySummary.todayIso, getAppTimeZone())}) liegt nicht im Tag‑Null‑Zeitraum dieses Kontos.
                    </Typography>
                  ) : null}
                </Paper>
              ) : null}
              {meltdownQ.data ? (
                <Accordion
                  defaultExpanded={false}
                  disableGutters
                  elevation={0}
                  sx={{
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                    '&:before': { display: 'none' },
                    boxShadow: 'none',
                  }}
                >
                  <AccordionSummary
                    expandIcon={<ExpandMoreIcon />}
                    sx={{
                      px: 2,
                      minHeight: 52,
                      '& .MuiAccordionSummary-content': { my: 1 },
                    }}
                  >
                    <Typography variant="subtitle1" fontWeight={700}>
                      Grundlagen &amp; Buchungen im Zeitraum
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails sx={{ px: 2, pt: 0, pb: 2 }}>
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
                        Geldeingänge (im Zeitraum)
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: -0.25 }}>
                        Alle Zuflüsse: sonstige Einnahmen (ohne Umbuchungs-Erkennung) <strong>und</strong> eingehende
                        Umbuchungen (positive Beträge). Summe positiver Buchungen inkl. eingehender Umbuchungen (API):{' '}
                        <strong>
                          {meltdownQ.data.einnahmen_summe_tag_zero_zeitraum != null &&
                          String(meltdownQ.data.einnahmen_summe_tag_zero_zeitraum).trim() !== ''
                            ? formatMoney(
                                String(meltdownQ.data.einnahmen_summe_tag_zero_zeitraum),
                                meltdownQ.data.currency,
                              )
                            : '—'}
                        </strong>
                        . Der Startwert „Konto · ohne Fixkosten“ rechnet diese Einnahmen weiterhin mit.
                      </Typography>
                      {(() => {
                        const d = meltdownQ.data;
                        const transfersIn = transferBookingsBySign(d.transfer_bookings, 'positive');
                        const rows = mergeGeldeingaengeRows(d.income_bookings, transfersIn);
                        const sumRows = rows.reduce((s, x) => {
                          const n = Number(x.row.amount);
                          return s + (Number.isFinite(n) ? n : 0);
                        }, 0);
                        if (rows.length === 0) {
                          return (
                            <Typography variant="body2" color="text.secondary">
                              Keine.
                            </Typography>
                          );
                        }
                        return (
                          <TableContainer>
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell>Datum</TableCell>
                                  <TableCell align="right">Betrag</TableCell>
                                  <TableCell>Art</TableCell>
                                  <TableCell>Vertrag</TableCell>
                                  <TableCell>Gegenpart / Text</TableCell>
                                  <TableCell>Zielkonto</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {rows.map(({ kind, row: r }) => (
                                  <TableRow key={`${kind}-${r.id}`}>
                                    <TableCell>{formatEuropeanDate(r.booking_date, getAppTimeZone())}</TableCell>
                                    <TableCell align="right">{formatMoney(r.amount, d.currency)}</TableCell>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                      {kind === 'income' ? 'Einnahme' : 'Umbuchung (eingehend)'}
                                    </TableCell>
                                    <TableCell>
                                      {kind === 'income'
                                        ? r.contract_label?.trim() || (r.contract_id != null ? `#${r.contract_id}` : '—')
                                        : '—'}
                                    </TableCell>
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
                                      {kind === 'transfer_in' && r.transfer_target_bank_account_id != null
                                        ? (() => {
                                            const tid = r.transfer_target_bank_account_id;
                                            const nm = accountNameById.get(tid)?.trim();
                                            return nm ? `${nm} (#${tid})` : `#${tid}`;
                                          })()
                                        : '—'}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                              <MeltdownBookingSumFooter sum={sumRows} currency={d.currency} />
                            </Table>
                          </TableContainer>
                        );
                      })()}
                    </Stack>
                    <Stack spacing={1}>
                      <Typography variant="body2" fontWeight={600}>
                        Umbuchungen (Geldausgang, im Zeitraum)
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: -0.25 }}>
                        Nur ausgehende Umbuchungen: Buchungen, die als interne Umbuchung erkannt wurden und einen{' '}
                        <strong>negativen</strong> Betrag haben (Abfluss vom Konto).
                      </Typography>
                      {(() => {
                        const d = meltdownQ.data;
                        const transfersOut = transferBookingsBySign(d.transfer_bookings, 'negative');
                        if (transfersOut.length === 0) {
                          return (
                            <Typography variant="body2" color="text.secondary">
                              Keine.
                            </Typography>
                          );
                        }
                        return (
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
                                {transfersOut.map((r) => (
                                  <TableRow key={r.id}>
                                    <TableCell>{formatEuropeanDate(r.booking_date, getAppTimeZone())}</TableCell>
                                    <TableCell align="right">{formatMoney(r.amount, d.currency)}</TableCell>
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
                                        ? (() => {
                                            const tid = r.transfer_target_bank_account_id;
                                            const nm = accountNameById.get(tid)?.trim();
                                            return nm ? `${nm} (#${tid})` : `#${tid}`;
                                          })()
                                        : '—'}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                              <MeltdownBookingSumFooter
                                sum={sumBookingRefAmounts(transfersOut)}
                                currency={d.currency}
                              />
                            </Table>
                          </TableContainer>
                        );
                      })()}
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
                            <MeltdownBookingSumFooter
                              sum={sumBookingRefAmounts(meltdownQ.data.contract_bookings ?? [])}
                              currency={meltdownQ.data.currency}
                            />
                          </Table>
                        </TableContainer>
                      )}
                    </Stack>
                  </Stack>
                  </AccordionDetails>
                </Accordion>
              ) : null}
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                  Saldo &amp; Ausgaben
                </Typography>
                <Chart options={charts.saldo.options} series={charts.saldo.series} type="line" height={340} />
                <Stack spacing={1} sx={{ mt: 1.5 }}>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Konto · Ist</strong> ist der tatsächliche Kontostand (Saldoverlauf) je Kalendertag bis „heute“
                    (App‑Zeitzone). <strong>Meltdown‑Linie (ohne Fixkosten)</strong> startet am Tabellenwert{' '}
                    <strong>Konto · ohne Fixkosten</strong> und wird pro Tag um die Ausgaben <em>ohne</em>{' '}
                    Vertragsbuchungen verringert; Vertragsausgaben ändern diese Linie nicht.{' '}
                    <strong>Konto · ohne Fixkosten · Soll (linear)</strong> ist die gleichmäßige Rampe von „Konto · ohne
                    Fixkosten“ auf 0 über die Periodenlänge (Spalte Soll der Tabelle).
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Ausgaben · sonstige</strong> und <strong>Ausgaben · Verträge</strong> sind gestapelte
                    Tagesbalken (nicht‑Vertrags‑ vs. Vertrags‑Ausgaben, gleiche Logik wie in den Tagesdaten). Klick auf
                    einen Balken öffnet die Buchungen dieses Tags darunter. Legende: Reihen ein-/ausblenden.
                  </Typography>
                </Stack>
              </Paper>
              <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                  Geld pro Tag — nur „Konto · ohne Fixkosten“
                </Typography>
                <Chart options={charts.spend.options} series={charts.spend.series} type="line" height={340} />
                <Stack spacing={1} sx={{ mt: 1.5 }}>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Fix/Tag:</strong> Tabellen‑Start „Konto · ohne Fixkosten“ geteilt durch die Periodentage —
                    gleichmäßige Soll‑Rate der linearen Rampe (grüne Linie im Saldo‑Diagramm). Entspricht der Spalte Fix/Tag.
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Ø Ist/Tag:</strong> kumulativer Mittelwert der täglichen Ausgaben <em>ohne</em> Vertragsbuchungen
                    bis zum jeweiligen Tag (wie Spalte Ø Ist/Tag der Zeile „Konto · ohne Fixkosten“).
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    <strong>Ø Soll/Tag:</strong> wie die blaue Meltdown‑Linie im Saldo‑Diagramm — Rest des Pfads geteilt durch
                    die verbleibenden Kalendertage inkl. heute (Spalte Ø Soll/Tag).
                  </Typography>
                  <Typography variant="body2" color="text.secondary" component="div">
                    Legende: alle drei Reihen ein‑/ausblendbar.
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

