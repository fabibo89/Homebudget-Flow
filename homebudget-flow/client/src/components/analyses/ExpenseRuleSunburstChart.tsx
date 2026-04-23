import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Theme } from '@mui/material/styles';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { SunburstChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { SunburstSeriesOption } from 'echarts/charts';

echarts.use([SunburstChart, TooltipComponent, CanvasRenderer]);

export type ExpenseSunburstPathFilter =
  | { depth: 1; root: string }
  | { depth: 2; root: string; sub: string }
  | { depth: 3; root: string; sub: string; rule: string };

export type ExpenseSunburstDatum = NonNullable<SunburstSeriesOption['data']>[number] & {
  pathFilter?: ExpenseSunburstPathFilter;
};

function formatMoneyDe(n: number, currency: string): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(n);
}

export default function ExpenseRuleSunburstChart(props: {
  /** Wurzel „Ausgaben“ mit drei Ebenen darunter; leer = kein Diagramm. */
  data: ExpenseSunburstDatum[];
  height: number;
  currency: string;
  theme: Theme;
  /** Klick auf Ring-Segment (nicht die Mitte ohne pathFilter). */
  onSelectPath: (path: ExpenseSunburstPathFilter | null) => void;
}) {
  const { data, height, currency, theme, onSelectPath } = props;
  const elRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const onSelectPathRef = useRef(onSelectPath);
  onSelectPathRef.current = onSelectPath;

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    const onClick = (params: { data?: unknown }) => {
      const d = params.data as ExpenseSunburstDatum | undefined;
      const pf = d?.pathFilter;
      if (pf) onSelectPathRef.current(pf);
      else onSelectPathRef.current(null);
    };
    chart.on('click', onClick);

    const ro = new ResizeObserver(() => {
      chart.resize();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.off('click', onClick);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const isDark = theme.palette.mode === 'dark';
    const option: EChartsCoreOption = {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'item',
        backgroundColor: isDark ? theme.palette.grey[900] : theme.palette.background.paper,
        borderColor: theme.palette.divider,
        textStyle: { color: theme.palette.text.primary, fontSize: 12 },
        formatter: (p: unknown) => {
          const item = p as { name?: string; value?: number; treePathInfo?: { name: string }[] };
          const path = (item.treePathInfo ?? []).map((x) => x.name).filter(Boolean);
          const label = path.join(' › ');
          const v = item.value;
          const valStr =
            typeof v === 'number' && Number.isFinite(v) ? formatMoneyDe(v, currency) : '—';
          return `${label}<br/><strong>${valStr}</strong>`;
        },
      },
      series: [
        {
          type: 'sunburst',
          data: data.length ? data : [],
          radius: [0, '92%'],
          sort: 'desc',
          emphasis: {
            focus: 'ancestor',
          },
          label: {
            rotate: 'radial',
            color: theme.palette.text.primary,
            fontSize: 10,
            minAngle: 6,
          },
          itemStyle: {
            borderWidth: 1,
            borderColor: theme.palette.divider,
          },
          levels: [
            {
              // Ebene 0: implizite Root (ECharts) — unsichtbar lassen
              // ECharts behandelt `series.data` als children eines Root-Knotens.
              // Darum sind Kategorien Tiefe 1, Subkategorien Tiefe 2, Regeln Tiefe 3.
              r0: '0%',
              r: '0%',
              label: { show: false },
            },
            {
              // Ebene 1: Kategorien (innerster Ring)
              r0: '0%',
              r: '34%',
              label: { rotate: 'tangential', fontSize: 11, minAngle: 8 },
            },
            {
              // Ebene 2: Subkategorien
              r0: '34%',
              r: '64%',
              label: { rotate: 'tangential', fontSize: 10, minAngle: 7 },
            },
            {
              // Ebene 3: Regeln (außen)
              r0: '64%',
              r: '92%',
              label: { position: 'outside', padding: 2, silent: false, fontSize: 9, minAngle: 6 },
            },
          ],
        },
      ],
    };

    chart.setOption(option, true);
  }, [data, currency, theme]);

  return <div ref={elRef} style={{ width: '100%', height }} />;
}
