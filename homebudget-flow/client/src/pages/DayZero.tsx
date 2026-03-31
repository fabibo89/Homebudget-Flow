import { useMemo, useState } from 'react';
import { Alert, Box, CircularProgress, FormControl, InputLabel, MenuItem, Paper, Select, Stack, Typography } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import Chart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { fetchAccounts, fetchDayZeroMeltdown, type BankAccount, type DayZeroMeltdownOut } from '../api/client';
import { apiErrorMessage } from '../api/client';
import { formatMoney } from '../lib/transactionUi';
import { getAppTimeZone } from '../lib/appTimeZone';

function accountHasTagZeroRule(a: BankAccount): boolean {
  // Heuristic: rule config is stored on account, but not part of BankAccount type.
  // We filter by presence of tag_zero_date (computed field) to show only accounts that are configured and have D0.
  return Boolean(a.last_salary_booking_date?.trim());
}

function buildSaldoChart(data: DayZeroMeltdownOut): { options: ApexOptions; series: any[] } {
  const tz = getAppTimeZone();
  const cats = data.days.map((d) => d.day);
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const series = [
    { name: 'Saldo (Ist)', data: data.days.map((d) => Number(d.balance_actual)) },
    { name: 'Saldo (Soll)', data: data.days.map((d) => Number(d.balance_target)) },
  ];
  const options: ApexOptions = {
    chart: { type: 'line', height: 340, toolbar: { show: false } },
    stroke: { width: 3, curve: 'smooth' },
    xaxis: {
      categories: cats,
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
    yaxis: {
      labels: { formatter: (v: number) => formatMoney(String(v.toFixed(2)), data.currency) },
    },
    tooltip: {
      theme: 'dark',
      fillSeriesColor: false,
      style: { fontSize: '12px' },
      x: { formatter: (v: any) => (isIsoDay(v) ? v : String(v)) },
      y: { formatter: (v: number) => formatMoney(String(v.toFixed(2)), data.currency) },
    },
    legend: { position: 'top' },
  };
  return { options, series };
}

function buildSpendChart(data: DayZeroMeltdownOut): { options: ApexOptions; series: any[] } {
  const tz = getAppTimeZone();
  const cats = data.days.map((d) => d.day);
  const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const series = [
    { name: 'Ausgaben (Ist)', type: 'column', data: data.days.map((d) => Number(d.spend_actual)) },
    { name: 'Ausgaben (Soll fix)', type: 'line', data: data.days.map((d) => Number(d.spend_target_fixed)) },
    { name: 'Ausgaben (Soll dyn)', type: 'line', data: data.days.map((d) => Number(d.spend_target_dynamic)) },
  ];
  const options: ApexOptions = {
    chart: { type: 'line', height: 340, stacked: false, toolbar: { show: false } },
    stroke: { width: [0, 3, 3], curve: 'smooth' },
    plotOptions: { bar: { columnWidth: '55%' } },
    xaxis: {
      categories: cats,
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
    yaxis: {
      labels: { formatter: (v: number) => formatMoney(String(v.toFixed(2)), data.currency) },
    },
    tooltip: {
      theme: 'dark',
      fillSeriesColor: false,
      style: { fontSize: '12px' },
      x: { formatter: (v: any) => (isIsoDay(v) ? v : String(v)) },
      y: { formatter: (v: number) => formatMoney(String(v.toFixed(2)), data.currency) },
    },
    legend: { position: 'top' },
  };
  return { options, series };
}

export default function DayZero() {
  const accountsQ = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  const accountsAll = accountsQ.data ?? [];
  const accounts = useMemo(() => accountsAll.filter(accountHasTagZeroRule), [accountsAll]);
  const [pick, setPick] = useState<number | ''>('');

  const effectiveAccountId = pick === '' ? (accounts[0]?.id ?? null) : pick;

  const meltdownQ = useQuery({
    queryKey: ['dayzero-meltdown', effectiveAccountId],
    queryFn: () => fetchDayZeroMeltdown(effectiveAccountId as number, 1),
    enabled: effectiveAccountId != null,
  });

  const charts = useMemo(() => {
    if (!meltdownQ.data) return null;
    return {
      saldo: buildSaldoChart(meltdownQ.data),
      spend: buildSpendChart(meltdownQ.data),
    };
  }, [meltdownQ.data]);

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
            </Stack>
          ) : null}
        </>
      )}
    </Stack>
  );
}

