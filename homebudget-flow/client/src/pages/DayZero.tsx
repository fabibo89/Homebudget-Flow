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
import { formatDate, formatMoney } from '../lib/transactionUi';
import { getAppTimeZone } from '../lib/appTimeZone';

function accountHasTagZeroRule(a: BankAccount): boolean {
  // Heuristic: rule config is stored on account, but not part of BankAccount type.
  // We filter by presence of tag_zero_date (computed field) to show only accounts that are configured and have D0.
  return Boolean(a.last_salary_booking_date?.trim());
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

function buildSaldoChart(args: {
  data: DayZeroMeltdownOut;
  showSaldoIst: boolean;
  showSaldoSoll: boolean;
  onToggleSaldoIst: () => void;
  onToggleSaldoSoll: () => void;
  onPickSpendDay: (isoDay: string) => void;
}): { options: ApexOptions; series: any[] } {
  const { data, showSaldoIst, showSaldoSoll, onToggleSaldoIst, onToggleSaldoSoll, onPickSpendDay } = args;
  const tz = getAppTimeZone();
  const cats = data.days.map((d) => d.day);
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const tagZeroAmount = data.tag_zero_amount != null && String(data.tag_zero_amount).trim() !== '' ? Number(data.tag_zero_amount) : null;
  const downmelt = tagZeroAmount == null || Number.isNaN(tagZeroAmount)
    ? null
    : data.days.map((_, i) => {
        const denom = Math.max(1, data.days.length - 1);
        const f = 1 - i / denom;
        return tagZeroAmount * f;
      });
  const lived = tagZeroAmount == null || Number.isNaN(tagZeroAmount)
    ? null
    : data.days.map((d, i) => {
        const prev = i === 0 ? tagZeroAmount : 0;
        return prev; // placeholder, overwritten below
      });
  if (lived) {
    let cur = tagZeroAmount as number;
    lived[0] = cur;
    for (let i = 1; i < data.days.length; i++) {
      cur += Number(data.days[i].net_actual || 0);
      lived[i] = cur;
    }
  }

  const saldoIstData = showSaldoIst ? data.days.map((d) => Number(d.balance_actual)) : data.days.map(() => null);
  const saldoSollData = showSaldoSoll ? data.days.map((d) => Number(d.balance_target)) : data.days.map(() => null);
  const spendBars = data.days.map((d) => Number(d.spend_actual)); // Ausgaben als positive Balken

  // Reihenfolge: Meltdown (Ist/Soll) zuerst (voll), Saldo-Linien danach (dünner).
  const series = [
    ...(lived ? [{ name: 'Meltdown Ist', data: lived }] : []),
    ...(downmelt ? [{ name: 'Meltdown Soll', data: downmelt }] : []),
    { name: 'Saldo (Ist)', data: saldoIstData },
    { name: 'Saldo (Soll)', data: saldoSollData },
    { name: 'Ausgaben (Ist)', type: 'column', data: spendBars },
  ];
  const options: ApexOptions = {
    chart: {
      type: 'line',
      height: 340,
      toolbar: { show: false },
      zoom: { enabled: false },
      events: {
        legendClick: (_chartCtx, seriesIndex, config) => {
          const name = String(config?.globals?.seriesNames?.[seriesIndex] ?? '');
          if (name === 'Saldo (Ist)') onToggleSaldoIst();
          else if (name === 'Saldo (Soll)') onToggleSaldoSoll();
          return false; // prevent Apex default hide/show
        },
        dataPointSelection: (_event, _chartCtx, cfg) => {
          const si = cfg?.seriesIndex;
          const di = cfg?.dataPointIndex;
          const name = String(cfg?.w?.globals?.seriesNames?.[si] ?? '');
          if (name !== 'Ausgaben (Ist)') return;
          const day = cats?.[di];
          if (isIsoDay(day)) onPickSpendDay(day);
        },
      },
    },
    plotOptions: { bar: { columnWidth: '55%' } },
    grid: {
      borderColor: 'rgba(255,255,255,0.10)',
      strokeDashArray: 0,
      xaxis: { lines: { show: false } },
      yaxis: { lines: { show: true } },
    },
    stroke: {
      // Meltdown-Linien: voll (breiter, ohne Dash). Saldo-Linien: dünner / leicht gestrichelt.
      width: lived && downmelt ? [3, 3, 2, 2, 0] : lived || downmelt ? [3, 3, 2, 2, 0] : [2, 2, 0],
      curve: 'smooth',
      dashArray: lived && downmelt ? [0, 0, 4, 6, 0] : lived || downmelt ? [0, 0, 4, 6, 0] : [0, 6, 0],
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
          return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', timeZone: tz }).format(
            new Date(`${v}T12:00:00Z`),
          );
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
        const x = isIsoDay(xRaw) ? xRaw : String(xRaw ?? '');
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
          (seriesName === 'Saldo (Ist)' && !showSaldoIst) || (seriesName === 'Saldo (Soll)' && !showSaldoSoll);
        return disabled ? `<span style="opacity:0.45">${seriesName}</span>` : seriesName;
      },
    },
  };
  return { options, series };
}

// Spend chart wird inline gebaut, weil es viele Toggles hat.

export default function DayZero() {
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  const accountsAll = accountsQ.data ?? [];
  const accounts = useMemo(() => accountsAll.filter(accountHasTagZeroRule), [accountsAll]);
  const [pick, setPick] = useState<number | ''>('');
  const [showSaldoIst, setShowSaldoIst] = useState(false);
  const [showSaldoSoll, setShowSaldoSoll] = useState(false);
  const [selectedSpendDay, setSelectedSpendDay] = useState<string | null>(null);
  // Spend chart toggles (legend). Saldo-basierte Soll-Linien default aus.
  const [showSpendSaldoFix, setShowSpendSaldoFix] = useState(false);
  const [showSpendSaldoDyn, setShowSpendSaldoDyn] = useState(false);
  // Meltdown-basierte Soll-Linien default an.
  const [showSpendMeltdownFixSoll, setShowSpendMeltdownFixSoll] = useState(true);
  const [showSpendMeltdownDynSoll, setShowSpendMeltdownDynSoll] = useState(true);
  const [showSpendMeltdownDynIst, setShowSpendMeltdownDynIst] = useState(true);

  const effectiveAccountId = pick === '' ? (accounts[0]?.id ?? null) : pick;

  const meltdownQ = useQuery({
    queryKey: ['dayzero-meltdown', effectiveAccountId],
    queryFn: () => fetchDayZeroMeltdown(effectiveAccountId as number, 1),
    enabled: effectiveAccountId != null,
  });

  const toggleSaldoIst = useCallback(() => setShowSaldoIst((v) => !v), []);
  const toggleSaldoSoll = useCallback(() => setShowSaldoSoll((v) => !v), []);
  const pickSpendDay = useCallback((isoDay: string) => setSelectedSpendDay(isoDay), []);
  const toggleSpendSaldoFix = useCallback(() => setShowSpendSaldoFix((v) => !v), []);
  const toggleSpendSaldoDyn = useCallback(() => setShowSpendSaldoDyn((v) => !v), []);
  const toggleSpendMeltdownFixSoll = useCallback(() => setShowSpendMeltdownFixSoll((v) => !v), []);
  const toggleSpendMeltdownDynSoll = useCallback(() => setShowSpendMeltdownDynSoll((v) => !v), []);
  const toggleSpendMeltdownDynIst = useCallback(() => setShowSpendMeltdownDynIst((v) => !v), []);

  const todaySummary = useMemo(() => {
    const d = meltdownQ.data;
    if (!d) return null;
    const tz = getAppTimeZone();
    const todayIso = isoDayInTimeZone(new Date(), tz);
    const idx = d.days.findIndex((x) => x.day === todayIso);
    if (idx < 0) return { todayIso, inRange: false as const };
    const day = d.days[idx];

    const n = d.days.length;
    const denom = Math.max(1, n - 1);
    const tagZeroAmount =
      d.tag_zero_amount != null && String(d.tag_zero_amount).trim() !== '' ? Number(d.tag_zero_amount) : null;
    const hasTz = tagZeroAmount != null && !Number.isNaN(tagZeroAmount as number);
    const downmeltSoll = !hasTz
      ? null
      : (() => {
          const f = 1 - idx / denom;
          return (tagZeroAmount as number) * f;
        })();
    const livedIst = !hasTz
      ? null
      : (() => {
          let cur = tagZeroAmount as number;
          for (let i = 1; i <= idx; i++) cur += Number(d.days[i].net_actual || 0);
          return cur;
        })();
    const daysLeftInclToday = Math.max(0, n - idx);
    const mdFixSoll = hasTz ? (tagZeroAmount as number) / denom : null;
    const mdDynSoll = downmeltSoll != null && daysLeftInclToday > 0 ? downmeltSoll / daysLeftInclToday : null;
    const mdDynIst = livedIst != null && daysLeftInclToday > 0 ? livedIst / daysLeftInclToday : null;

    return {
      todayIso,
      inRange: true as const,
      currency: d.currency,
      saldoIst: Number(day.balance_actual),
      saldoSoll: Number(day.balance_target),
      spendIst: Number(day.spend_actual),
      spendSaldoFix: Number(day.spend_target_fixed),
      spendSaldoDyn: Number(day.spend_target_dynamic),
      mdSoll: downmeltSoll,
      mdIst: livedIst,
      mdFixSoll,
      mdDynSoll,
      mdDynIst,
    };
  }, [meltdownQ.data]);

  const charts = useMemo(() => {
    if (!meltdownQ.data) return null;
    const d = meltdownQ.data;
    const n = d.days.length;
    const denom = Math.max(1, n - 1);
    const tagZeroAmount =
      d.tag_zero_amount != null && String(d.tag_zero_amount).trim() !== '' ? Number(d.tag_zero_amount) : null;
    const hasTz = tagZeroAmount != null && !Number.isNaN(tagZeroAmount as number);
    const downmeltSoll = !hasTz
      ? null
      : d.days.map((_, i) => {
          const f = 1 - i / denom;
          return (tagZeroAmount as number) * f;
        });
    const livedIst = !hasTz
      ? null
      : (() => {
          const arr: number[] = new Array(n).fill(0);
          let cur = tagZeroAmount as number;
          arr[0] = cur;
          for (let i = 1; i < n; i++) {
            cur += Number(d.days[i].net_actual || 0);
            arr[i] = cur;
          }
          return arr;
        })();

    // Spend derived from meltdown curves (budget per day): fix and dynamic.
    const meltdownFixSoll = !downmeltSoll ? null : d.days.map(() => (tagZeroAmount as number) / denom);
    const meltdownDynSoll = !downmeltSoll
      ? null
      : d.days.map((_, i) => {
          const left = Math.max(0, n - i);
          return left > 0 ? downmeltSoll[i] / left : 0;
        });
    const meltdownDynIst = !livedIst
      ? null
      : d.days.map((_, i) => {
          const left = Math.max(0, n - i);
          return left > 0 ? livedIst[i] / left : 0;
        });

    return {
      saldo: buildSaldoChart({
        data: d,
        showSaldoIst,
        showSaldoSoll,
        onToggleSaldoIst: toggleSaldoIst,
        onToggleSaldoSoll: toggleSaldoSoll,
        onPickSpendDay: pickSpendDay,
      }),
      spend: (() => {
        const tz = getAppTimeZone();
        const cats = d.days.map((x) => x.day);
        const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

        const keepOrNull = (on: boolean, xs: (number | null)[]) => (on ? xs : xs.map(() => null));
        const saldoFix = keepOrNull(showSpendSaldoFix, d.days.map((x) => Number(x.spend_target_fixed)));
        const saldoDyn = keepOrNull(showSpendSaldoDyn, d.days.map((x) => Number(x.spend_target_dynamic)));
        const mdFixSoll = meltdownFixSoll ? keepOrNull(showSpendMeltdownFixSoll, meltdownFixSoll) : null;
        const mdDynSoll = meltdownDynSoll ? keepOrNull(showSpendMeltdownDynSoll, meltdownDynSoll) : null;
        const mdDynIst = meltdownDynIst ? keepOrNull(showSpendMeltdownDynIst, meltdownDynIst) : null;

        // Reihenfolge nach Wunsch: Pos 1/2 = Meltdown Ist dyn, dann Meltdown Soll fix.
        const series = [
          ...(mdDynIst ? [{ name: 'Soll dyn (Meltdown Ist)', type: 'line', data: mdDynIst }] : []),
          ...(mdFixSoll ? [{ name: 'Soll fix (Meltdown Soll)', type: 'line', data: mdFixSoll }] : []),
          ...(mdDynSoll ? [{ name: 'Soll dyn (Meltdown Soll)', type: 'line', data: mdDynSoll }] : []),
          { name: 'Soll fix (Saldo)', type: 'line', data: saldoFix },
          { name: 'Soll dyn (Saldo)', type: 'line', data: saldoDyn },
        ];
        const strokeWidths = series.map((s: any) => (s.type === 'column' ? 0 : 2));
        // Saldo-basierte Linien etwas stärker, damit man sie bei Aktivierung gut sieht.
        for (let i = 0; i < series.length; i++) {
          const n = String(series[i]?.name ?? '');
          if (n === 'Soll fix (Saldo)' || n === 'Soll dyn (Saldo)') strokeWidths[i] = 3;
        }

        const isDisabled = (name: string) => {
          if (name === 'Soll fix (Saldo)') return !showSpendSaldoFix;
          if (name === 'Soll dyn (Saldo)') return !showSpendSaldoDyn;
          if (name === 'Soll fix (Meltdown Soll)') return !showSpendMeltdownFixSoll;
          if (name === 'Soll dyn (Meltdown Soll)') return !showSpendMeltdownDynSoll;
          if (name === 'Soll dyn (Meltdown Ist)') return !showSpendMeltdownDynIst;
          return false;
        };

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
                if (name === 'Soll fix (Saldo)') toggleSpendSaldoFix();
                else if (name === 'Soll dyn (Saldo)') toggleSpendSaldoDyn();
                else if (name === 'Soll fix (Meltdown Soll)') toggleSpendMeltdownFixSoll();
                else if (name === 'Soll dyn (Meltdown Soll)') toggleSpendMeltdownDynSoll();
                else if (name === 'Soll dyn (Meltdown Ist)') toggleSpendMeltdownDynIst();
                return false;
              },
            },
          },
          stroke: { width: strokeWidths, curve: 'smooth' },
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
                return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', timeZone: tz }).format(
                  new Date(`${v}T12:00:00Z`),
                );
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
            axisBorder: { show: true, color: 'rgba(255,255,255,0.12)' },
            axisTicks: { show: true, color: 'rgba(255,255,255,0.12)' },
            labels: { formatter: (v: number) => formatMoney(String(v.toFixed(2)), d.currency) },
          },
          tooltip: {
            shared: true,
            intersect: false,
            theme: 'dark',
            fillSeriesColor: false,
            style: { fontSize: '12px' },
            custom: ({ dataPointIndex, w }) => {
              const xRaw = w?.globals?.categoryLabels?.[dataPointIndex] ?? w?.globals?.labels?.[dataPointIndex];
              const x = isIsoDay(xRaw) ? xRaw : String(xRaw ?? '');
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
                    `<span style="font-variant-numeric:tabular-nums;font-weight:700;">${formatMoney(num.toFixed(2), d.currency)}</span>` +
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
            formatter: (seriesName: string) =>
              isDisabled(seriesName) ? `<span style="opacity:0.45">${seriesName}</span>` : seriesName,
          },
        };
        return { options, series };
      })(),
    };
  }, [
    meltdownQ.data,
    showSaldoIst,
    showSaldoSoll,
    toggleSaldoIst,
    toggleSaldoSoll,
    pickSpendDay,
    showSpendSaldoFix,
    showSpendSaldoDyn,
    showSpendMeltdownFixSoll,
    showSpendMeltdownDynSoll,
    showSpendMeltdownDynIst,
    toggleSpendSaldoFix,
    toggleSpendSaldoDyn,
    toggleSpendMeltdownFixSoll,
    toggleSpendMeltdownDynSoll,
    toggleSpendMeltdownDynIst,
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
                  Tag Null: <strong>{meltdownQ.data.tag_zero_date}</strong> · Ende: <strong>{meltdownQ.data.period_end_exclusive}</strong>
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
              {todaySummary ? (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                    Heute
                  </Typography>
                  {todaySummary.inRange ? (
                    <TableContainer>
                      <Table size="small" sx={{ '& td, & th': { py: 0.75 } }}>
                        <TableHead>
                          <TableRow>
                            <TableCell />
                            <TableCell align="right">Soll</TableCell>
                            <TableCell align="right">Ist</TableCell>
                            <TableCell align="right">Diff</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {(() => {
                            const rows: Array<{
                              label: string;
                              soll: number | null;
                              ist: number | null;
                              goodWhen: 'zeroOrPositive' | 'zeroOrNegative';
                            }> = [
                              {
                                label: 'Saldo',
                                soll: todaySummary.saldoSoll,
                                ist: todaySummary.saldoIst,
                                goodWhen: 'zeroOrPositive',
                              },
                              {
                                label: 'Geld pro Tag',
                                soll: todaySummary.mdFixSoll ?? null, // Soll fix (Meltdown Soll)
                                ist: todaySummary.mdDynIst ?? null, // Soll dyn (Meltdown Ist)
                                goodWhen: 'zeroOrPositive',
                              },
                            ];
                            return rows.map((r) => {
                              const diff = r.ist != null && r.soll != null ? r.ist - r.soll : null;
                              return (
                                <TableRow key={r.label} hover>
                                  <TableCell>{r.label}</TableCell>
                                  <TableCell align="right">
                                    {r.soll == null ? (
                                      '—'
                                    ) : (
                                      <Typography
                                        component="span"
                                        sx={{ color: valueSignColor(r.soll), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                                      >
                                        {formatMoney(r.soll.toFixed(2), todaySummary.currency)}
                                      </Typography>
                                    )}
                                  </TableCell>
                                  <TableCell align="right">
                                    {r.ist == null ? (
                                      '—'
                                    ) : (
                                      <Typography
                                        component="span"
                                        sx={{ color: valueSignColor(r.ist), fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}
                                      >
                                        {formatMoney(r.ist.toFixed(2), todaySummary.currency)}
                                      </Typography>
                                    )}
                                  </TableCell>
                                  <TableCell align="right">
                                    {diff == null ? (
                                      '—'
                                    ) : (
                                      <Typography
                                        component="span"
                                        sx={{
                                          color: valueSignColor(diff),
                                          fontWeight: 700,
                                          fontVariantNumeric: 'tabular-nums',
                                        }}
                                      >
                                        {formatMoney(diff.toFixed(2), todaySummary.currency)}
                                      </Typography>
                                    )}
                                  </TableCell>
                                </TableRow>
                              );
                            });
                          })()}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Heute ({todaySummary.todayIso}) liegt nicht im Tag‑Null‑Zeitraum dieses Kontos.
                    </Typography>
                  )}
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
                  Geld pro Tag (Ist/Soll)
                </Typography>
                <Chart options={charts.spend.options} series={charts.spend.series} type="line" height={340} />
              </Paper>

              {selectedSpendDay ? (
                <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
                  <Stack spacing={1.25}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'baseline' }} justifyContent="space-between">
                      <Typography variant="subtitle1" fontWeight={700}>
                        Buchungen am {formatDate(selectedSpendDay)}
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

