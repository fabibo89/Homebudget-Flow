import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControl,
  Paper,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as echarts from 'echarts';
import {
  apiErrorMessage,
  deleteEarningsDocument,
  fetchEarningsDocumentLines,
  fetchEarningsDocuments,
  fetchEarningsDocumentsAnalysis,
  fetchEarningsDocumentsTimeline,
  fetchEarningsDocumentsTimelineMetrics,
  fetchEarningsDocumentsTimelineBreakdown,
  importEarningsDocuments,
  rerunEarningsDocument,
  type EarningsDocumentLineOut,
  type EarningsDocumentOut,
  type EarningsDocumentsTimelineMetricOut,
  type EarningsDocumentsTimelineBreakdownOut,
} from '../api/client';

function downloadUrl(docId: number): string {
  const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
  return `${base}/api/earnings-documents/${docId}/download`;
}

function isPdfName(name: string): boolean {
  return String(name || '').toLowerCase().endsWith('.pdf');
}

function normalizeRelPath(p: string): string {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

async function collectDroppedFiles(dt: DataTransfer): Promise<Array<{ file: File; relative_path: string }>> {
  // Chrome/Chromium: Ordner-Drop + Multi via webkitGetAsEntry (liefert komplette Hierarchie).
  const items = Array.from(dt.items ?? []);
  const hasEntries = items.some((it: any) => typeof it.webkitGetAsEntry === 'function');
  const fromEntries: Array<{ file: File; relative_path: string }> = [];
  if (hasEntries) {

    async function fileFromEntry(entry: any, relBase: string) {
      const f: File = await new Promise((resolve, reject) => entry.file(resolve, reject));
      if (!isPdfName(f.name)) return;
      const rel = normalizeRelPath(relBase ? `${relBase}/${f.name}` : f.name);
      fromEntries.push({ file: f, relative_path: rel });
    }

    async function walk(entry: any, relBase: string): Promise<void> {
      if (!entry) return;
      if (entry.isFile) {
        await fileFromEntry(entry, relBase);
        return;
      }
      if (!entry.isDirectory) return;
      const dirName = entry.name ? String(entry.name) : '';
      const nextBase = dirName ? (relBase ? `${relBase}/${dirName}` : dirName) : relBase;
      const reader = entry.createReader();
      for (;;) {
        const entries: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!entries.length) break;
        for (const e of entries) {
          await walk(e, nextBase);
        }
      }
    }

    for (const it of items) {
      const entry = (it as any).webkitGetAsEntry?.();
      if (!entry) continue;
      try {
        await walk(entry, '');
      } catch {
        // Safari/verschiedene Finder-Quellen liefern teils unvollständige Entries.
        // Dann greifen wir unten zusätzlich auf dt.files zurück.
      }
    }

    // Kein early-return: wir mergen unten zusätzlich dt.files, weil Safari/Quellen
    // teilweise nur einen Teil der Items als Entry auflösen.
  }

  // Zusätzlich: dt.items -> getAsFile(). Gerade Safari liefert Multi-Drop häufig nur hier vollständig.
  const fromItemsFiles = items
    .map((it) => it.getAsFile?.())
    .filter((f): f is File => Boolean(f))
    .filter((f) => isPdfName(String(f.name || '')))
    .map((f) => ({ file: f, relative_path: normalizeRelPath(f.name) || String(f.name || 'document.pdf') }));

  // Fallback: dt.files (Safari liefert hier oft nur 1, aber Multi-Select funktioniert zuverlässig).
  const files = Array.from(dt.files) as any[];
  const fromFiles = files
    .filter((f) => isPdfName(String(f.name || '')))
    .map((f) => {
      const rel = normalizeRelPath(String(f.webkitRelativePath || f.relativePath || f.path || f.name || ''));
      return { file: f as File, relative_path: rel || String(f.name || 'document.pdf') };
    });

  // Merge (Entries + Files) + Dedupe nach File-Signatur.
  // Entries zuerst, damit deren `relative_path` (bei Ordnern) bevorzugt wird.
  const seen = new Set<string>();
  const outFinal: Array<{ file: File; relative_path: string }> = [];
  const merged = fromEntries.concat(fromItemsFiles, fromFiles);
  for (const it of merged) {
    const f = it.file as any;
    const key = `${f.name}|${f.size}|${f.lastModified ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outFinal.push(it);
  }
  return outFinal;
}

type SectionNode = {
  section: EarningsDocumentLineOut;
  children: EarningsDocumentLineOut[]; // items + sums
  sections: SectionNode[]; // nested sections
};

function isTransfersSection(node: SectionNode): boolean {
  return String(node.section.label || '').trim() === 'Überweisungen';
}

function renderLinesTable(lines: EarningsDocumentLineOut[]) {
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow
            sx={{
              '& th': {
                bgcolor: 'action.hover',
                fontWeight: 800,
                borderBottomWidth: 2,
                borderBottomColor: 'divider',
              },
            }}
          >
            <TableCell>Position</TableCell>
            <TableCell align="right">Betrag</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {lines.map((l) => (
            <TableRow
              key={l.id}
              sx={
                l.kind === 'sum'
                  ? {
                      '& td': {
                        bgcolor: 'action.selected',
                        fontWeight: 800,
                        borderTopWidth: 2,
                        borderTopColor: 'divider',
                      },
                    }
                  : undefined
              }
            >
              <TableCell>
                <Typography variant="body2" sx={{ fontWeight: l.kind === 'sum' ? 800 : 500 }}>
                  {l.label}
                </Typography>
              </TableCell>
              <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                {fmtAmount(l.amount, l.currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function buildTree(lines: EarningsDocumentLineOut[]): SectionNode[] {
  const sections = lines.filter((l) => l.kind === 'section');
  const byId = new Map<number, EarningsDocumentLineOut>();
  for (const l of lines) byId.set(l.id, l);

  const sectionChildrenByParent = new Map<number, EarningsDocumentLineOut[]>();
  const itemChildrenByParent = new Map<number, EarningsDocumentLineOut[]>();
  for (const l of lines) {
    if (l.parent_id == null) continue;
    if (l.kind === 'section') {
      const arr = sectionChildrenByParent.get(l.parent_id) ?? [];
      arr.push(l);
      sectionChildrenByParent.set(l.parent_id, arr);
    } else {
      const arr = itemChildrenByParent.get(l.parent_id) ?? [];
      arr.push(l);
      itemChildrenByParent.set(l.parent_id, arr);
    }
  }

  const mkNode = (s: EarningsDocumentLineOut): SectionNode => {
    const childSections = (sectionChildrenByParent.get(s.id) ?? [])
      .slice()
      .sort((a, b) => a.order_index - b.order_index)
      .map(mkNode);
    const children = (itemChildrenByParent.get(s.id) ?? []).slice().sort((a, b) => a.order_index - b.order_index);
    return { section: s, sections: childSections, children };
  };

  const topSections = sections.filter((s) => s.parent_id == null).slice().sort((a, b) => a.order_index - b.order_index);
  return topSections.map(mkNode);
}

function fmtAmount(a: string | null, currency: string) {
  if (!a) return '—';
  const n = Number(a);
  if (!Number.isFinite(n)) return `${a} ${currency}`;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(n);
}

function parseAmount(a: string | null): number | null {
  if (a == null) return null;
  const n = Number(String(a).trim());
  return Number.isFinite(n) ? n : null;
}

function fmtCurrency(n: number, currency: string) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(n);
}

function frameSx(depth: number) {
  const palette = [
    { bg: 'rgba(33, 150, 243, 0.06)', border: 'rgba(33, 150, 243, 0.22)' }, // blue
    { bg: 'rgba(0, 150, 136, 0.06)', border: 'rgba(0, 150, 136, 0.22)' }, // teal
    { bg: 'rgba(255, 193, 7, 0.06)', border: 'rgba(255, 193, 7, 0.22)' }, // amber
    { bg: 'rgba(156, 39, 176, 0.06)', border: 'rgba(156, 39, 176, 0.22)' }, // purple
  ];
  const c = palette[Math.max(0, depth) % palette.length];
  return {
    bgcolor: c.bg,
    borderColor: c.border,
  } as const;
}

type SectionTotals = Array<{ section: string; total: number }>;

function computeSectionTotals(
  tree: SectionNode[],
): SectionTotals {
  const sumNode = (node: SectionNode): number => {
    const self = node.children.reduce((s, l) => {
      if (l.kind === 'sum') return s;
      const n = parseAmount(l.amount);
      return n == null ? s : s + n;
    }, 0);
    const nested = node.sections.reduce((s, ch) => s + sumNode(ch), 0);
    return self + nested;
  };

  return tree.map((grp) => ({ section: grp.section.label, total: sumNode(grp) }));
}

function findAmount(
  tree: SectionNode[],
  predicate: (label: string) => boolean,
): number | null {
  const walk = (node: SectionNode): number | null => {
    for (const l of node.children) {
      const lab = String(l.label || '');
      if (!predicate(lab)) continue;
      const n = parseAmount(l.amount);
      if (n != null) return n;
    }
    for (const s of node.sections) {
      const r = walk(s);
      if (r != null) return r;
    }
    return null;
  };
  for (const grp of tree) {
    const r = walk(grp);
    if (r != null) return r;
  }
  return null;
}

function EChart(props: { option: echarts.EChartsOption; height?: number }) {
  const { option, height = 420 } = props;
  const [el, setEl] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!el) return;
    const inst = echarts.init(el, undefined, { renderer: 'canvas' });
    inst.setOption(option, true);
    const onResize = () => inst.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      inst.dispose();
    };
  }, [el, option]);

  return <Box ref={setEl} sx={{ width: '100%', height }} />;
}

function periodKey(d: EarningsDocumentOut): number {
  const y = d.period_year ?? 0;
  const m = d.period_month ?? 0;
  return y * 100 + m;
}

function formatPeriod(d: EarningsDocumentOut): string {
  if (d.period_label?.trim()) return d.period_label.trim();
  if (d.period_year && d.period_month) return `${String(d.period_month).padStart(2, '0')}.${d.period_year}`;
  return '—';
}

function ymKey(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function ymLabel(year: number, month: number): string {
  return `${String(month).padStart(2, '0')}.${year}`;
}

export default function EarningsDocumentsSettings() {
  const [tab, setTab] = useState(0);
  const [uiError, setUiError] = useState('');
  const [pickedInfo, setPickedInfo] = useState('');
  const [lastImportAtMs, setLastImportAtMs] = useState(0);
  const [selectedDocId, setSelectedDocId] = useState<number | null>(null);
  const [positionsView, setPositionsView] = useState(0);
  const [analysisMetric, setAnalysisMetric] = useState<string>('payout');
  const [analysisFromYm, setAnalysisFromYm] = useState<string>('');
  const [analysisToYm, setAnalysisToYm] = useState<string>('');
  const [rerunAllDone, setRerunAllDone] = useState(0);

  const docsQuery = useQuery({
    queryKey: ['earnings-docs', lastImportAtMs],
    queryFn: () => fetchEarningsDocuments(),
    enabled: true,
  });

  const analysisQuery = useQuery({
    queryKey: ['earnings-docs-analysis', lastImportAtMs],
    queryFn: () => fetchEarningsDocumentsAnalysis(),
    enabled: true,
  });

  const timelineQuery = useQuery({
    queryKey: ['earnings-docs-timeline', analysisMetric, analysisFromYm, analysisToYm, lastImportAtMs],
    queryFn: () =>
      fetchEarningsDocumentsTimeline({
        metric: analysisMetric,
        from_ym: analysisFromYm,
        to_ym: analysisToYm,
      }),
    enabled: true,
  });

  const timelineMetricsQuery = useQuery({
    queryKey: ['earnings-docs-timeline-metrics', lastImportAtMs],
    queryFn: () => fetchEarningsDocumentsTimelineMetrics(),
    enabled: true,
  });

  const timelineMetrics = timelineMetricsQuery.data ?? ([] as EarningsDocumentsTimelineMetricOut[]);
  useEffect(() => {
    if (!timelineMetrics.length) return;
    const ids = new Set(timelineMetrics.map((m) => m.id));
    if (ids.has(analysisMetric)) return;
    // Default: bevorzugt Auszahlungsbetrag-Root, sonst erstes Element.
    const payoutLike = timelineMetrics.find((m) => m.id.toLowerCase().includes('sectionpath:auszahlungsbetrag'));
    setAnalysisMetric((payoutLike?.id || timelineMetrics[0]?.id) ?? 'payout');
  }, [timelineMetricsQuery.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const breakdownQuery = useQuery({
    queryKey: ['earnings-docs-timeline-breakdown', analysisMetric, analysisFromYm, analysisToYm, lastImportAtMs],
    queryFn: () =>
      fetchEarningsDocumentsTimelineBreakdown({
        metric: analysisMetric,
        from_ym: analysisFromYm,
        to_ym: analysisToYm,
      }),
    enabled: String(analysisMetric || '').startsWith('sectionpath:'),
  });

  const breakdown = useMemo(() => {
    const data = (breakdownQuery.data ?? null) as EarningsDocumentsTimelineBreakdownOut | null;
    if (!data) return null;
    const labels = data.points.map((p) => `${String(p.month).padStart(2, '0')}/${String(p.year).slice(-2)}`);
    const series = data.series.map((s) => ({
      id: s.id,
      label: s.label,
      values: data.points.map((p) => Number(p.values?.[s.id] ?? 0)),
    }));
    return { labels, series };
  }, [breakdownQuery.data]);

  const linesQuery = useQuery({
    queryKey: ['earnings-doc-lines', selectedDocId],
    queryFn: () => fetchEarningsDocumentLines(selectedDocId!),
    enabled: selectedDocId != null,
  });

  const importMut = useMutation({
    mutationFn: async (items: Array<{ file: File; relative_path: string }>) => {
      return await importEarningsDocuments({ items });
    },
    onSuccess: () => {
      setLastImportAtMs(Date.now());
      setPickedInfo('');
      setUiError('');
    },
  });

  const rerunMut = useMutation({
    mutationFn: async (docId: number) => await rerunEarningsDocument(docId),
    onSuccess: () => setLastImportAtMs(Date.now()),
  });

  const deleteMut = useMutation({
    mutationFn: async (docId: number) => await deleteEarningsDocument(docId),
    onSuccess: (_res, docId) => {
      if (selectedDocId === docId) setSelectedDocId(null);
      setLastImportAtMs(Date.now());
    },
  });

  const rerunAllMut = useMutation({
    mutationFn: async (docIds: number[]) => {
      setRerunAllDone(0);
      const total = docIds.length;
      if (!total) return { ok: true, total: 0 };
      await Promise.all(
        docIds.map(async (id) => {
          await rerunEarningsDocument(id);
          setRerunAllDone((x) => x + 1);
        }),
      );
      return { ok: true, total };
    },
    onSuccess: () => setLastImportAtMs(Date.now()),
  });

  async function handleImport(items: Array<{ file: File; relative_path: string }>) {
    setUiError('');
    if (!items.length) {
      setUiError('Keine PDFs erkannt. Bitte PDFs (oder einen Ordner mit PDFs) droppen.');
      return;
    }
    setPickedInfo(`Ausgewählt: ${items.length} PDF(s)`);
    importMut.reset();
    importMut.mutate(items);
  }

  const docs = useMemo(() => {
    const arr = (docsQuery.data ?? []).slice();
    arr.sort((a, b) => {
      const pa = periodKey(a);
      const pb = periodKey(b);
      if (pa !== pb) return pb - pa; // newest period first
      return b.id - a.id;
    });
    return arr;
  }, [docsQuery.data]);

  const analysisDocs = docs;

  const analysisTimeline = useMemo(() => {
    const pts = timelineQuery.data?.points ?? [];
    const labels = pts.map((p) => `${String(p.month).padStart(2, '0')}/${String(p.year).slice(-2)}`);
    const values = pts.map((p) => p.value ?? 0);
    const ym = pts.map((p) => `${p.year}-${String(p.month).padStart(2, '0')}`);
    return { labels, values, ym };
  }, [timelineQuery.data]);

  const timelineYmOptions = useMemo(() => {
    // Optionen aus allen Docs (nicht nur Timeline), damit Filter auch Werte "0" abdecken kann.
    const keys = new Set<string>();
    for (const d of docs) {
      if (!d.period_year || !d.period_month) continue;
      keys.add(`${d.period_year}-${String(d.period_month).padStart(2, '0')}`);
    }
    return Array.from(keys).sort();
  }, [docs]);

  const overviewRows = useMemo(() => {
    const withYm = docs.filter((d) => Boolean(d.period_year) && Boolean(d.period_month)) as Array<
      EarningsDocumentOut & { period_year: number; period_month: number }
    >;
    const withoutYm = docs.filter((d) => !(d.period_year && d.period_month));

    if (withYm.length === 0) {
      return withoutYm.map((doc) => ({ kind: 'doc' as const, doc }));
    }

    // Fehlende Hinweise nur bis zum letzten abgeschlossenen Monat (nicht aktueller Monat).
    const now = new Date();
    const nowKey = ymKey(now.getFullYear(), now.getMonth() + 1);
    const lastCompleteKey = nowKey - 1;

    const byYm = new Map<number, EarningsDocumentOut[]>();
    let min = Number.POSITIVE_INFINITY;
    let maxDoc = Number.NEGATIVE_INFINITY;
    for (const d of withYm) {
      const k = ymKey(d.period_year, d.period_month);
      min = Math.min(min, k);
      maxDoc = Math.max(maxDoc, k);
      const arr = byYm.get(k) ?? [];
      arr.push(d);
      byYm.set(k, arr);
    }
    const max = Math.max(maxDoc, lastCompleteKey);

    const rows: Array<
      | { kind: 'doc'; doc: EarningsDocumentOut }
      | { kind: 'missing'; year: number; month: number }
    > = [];

    for (let k = max; k >= min; k -= 1) {
      const year = Math.floor(k / 12);
      const month = (k % 12) + 1;
      const docsFor = (byYm.get(k) ?? []).slice().sort((a, b) => b.id - a.id);
      if (docsFor.length === 0) {
        if (k <= lastCompleteKey) {
          rows.push({ kind: 'missing', year, month });
        }
      } else {
        for (const doc of docsFor) rows.push({ kind: 'doc', doc });
      }
    }

    // Nicht zuordenbare Dokumente (ohne Zeitraum) ans Ende.
    for (const doc of withoutYm) rows.push({ kind: 'doc', doc });
    return rows;
  }, [docs]);

  const overviewKpis = useMemo(() => {
    let missingMonths = 0;
    const periodsPresent = new Set<number>();
    for (const r of overviewRows) {
      if (r.kind === 'missing') missingMonths += 1;
      else if (r.doc.period_year && r.doc.period_month) periodsPresent.add(ymKey(r.doc.period_year, r.doc.period_month));
    }
    return {
      docs_total: docs.length,
      months_present: periodsPresent.size,
      months_missing: missingMonths,
    };
  }, [overviewRows, docs.length]);

  const selectedDoc: EarningsDocumentOut | null = selectedDocId == null ? null : (docs.find((d) => d.id === selectedDocId) ?? null);
  const tree = useMemo(() => buildTree(linesQuery.data ?? []), [linesQuery.data]);
  const sectionTotals = useMemo(() => computeSectionTotals(tree), [tree]);
  const gross = useMemo(() => findAmount(tree, (l) => l.toLowerCase().includes('gesamtbrutto')), [tree]);
  const payout = useMemo(
    () => findAmount(tree, (l) => l.toLowerCase().startsWith('auszahlungsbetrag')),
    [tree],
  );

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Verdienstnachweise
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Importiere PDFs per Drag&amp;Drop. Wir speichern Datei + Metadaten und lesen daraus Positions- und Summenpositionen.
        </Typography>
      </Box>

      <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
        <Stack spacing={2}>
          <Box
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void (async () => {
                const items = await collectDroppedFiles(e.dataTransfer);
                if (items.length <= 1) {
                  // Safari kann bei Drag&Drop nur eine Datei liefern (je nach Quelle/Finder).
                  setPickedInfo(
                    items.length === 1
                      ? `Ausgewählt: 1 PDF (Hinweis: Safari liefert bei Drag&Drop oft nur 1 — nutze „PDFs auswählen“ für Multi)`
                      : '',
                  );
                }
                await handleImport(items);
              })();
            }}
            sx={{
              border: '2px dashed rgba(127,127,127,0.35)',
              borderRadius: 2,
              p: 3,
              bgcolor: 'background.default',
            }}
          >
            <Stack spacing={1} alignItems="flex-start">
              <Typography variant="subtitle2" fontWeight={700}>
                Drag &amp; Drop
              </Typography>
              <Typography variant="body2" color="text.secondary">
                PDFs oder Ordner mit PDFs hier ablegen.
              </Typography>
              <Button variant="outlined" component="label" disabled={importMut.isPending}>
                PDFs auswählen
                <input
                  type="file"
                  hidden
                  accept="application/pdf,.pdf"
                  multiple
                  onChange={(e) => {
                    const fs = e.target.files ? Array.from(e.target.files) : [];
                    const items = fs.map((f: any) => ({
                      file: f as File,
                      relative_path: String((f as any).webkitRelativePath || f.name || 'document.pdf'),
                    }));
                    void handleImport(items);
                    e.currentTarget.value = '';
                  }}
                />
              </Button>
              <Button variant="outlined" component="label" disabled={importMut.isPending}>
                Ordner auswählen (Chrome)
                <input
                  type="file"
                  hidden
                  multiple
                  accept="application/pdf,.pdf"
                  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                  // @ts-ignore - nonstandard attribute supported by Chromium
                  webkitdirectory="true"
                  onChange={(e) => {
                    const fs = e.target.files ? Array.from(e.target.files) : [];
                    const items = fs
                      .filter((f: any) => isPdfName(String(f?.name || '')))
                      .map((f: any) => ({
                        file: f as File,
                        relative_path: String((f as any).webkitRelativePath || f.name || 'document.pdf'),
                      }));
                    void handleImport(items);
                    e.currentTarget.value = '';
                  }}
                />
              </Button>
              {pickedInfo ? (
                <Typography variant="caption" color="text.secondary">
                  {pickedInfo}
                </Typography>
              ) : null}
            </Stack>
          </Box>

          {uiError ? <Alert severity="error">{uiError}</Alert> : null}

          {importMut.isPending ? (
            <Alert severity="info" icon={<CircularProgress size={18} />}>
              Import läuft…
            </Alert>
          ) : importMut.isError ? (
            <Alert severity="error">{apiErrorMessage(importMut.error)}</Alert>
          ) : importMut.isSuccess ? (
            <Alert severity="success">
              Import OK. Neu: {importMut.data.imported} · Schon vorhanden: {importMut.data.skipped_existing}
            </Alert>
          ) : null}
        </Stack>
      </Paper>

      <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab label={`Übersicht (${docs.length})`} />
          <Tab label="Analyse" />
          <Tab label="Positionsbaum" />
        </Tabs>

        {tab === 0 ? (
          <Box sx={{ pt: 2 }}>
            {docsQuery.isError ? <Alert severity="error">{apiErrorMessage(docsQuery.error)}</Alert> : null}
            {docsQuery.isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress />
              </Box>
            ) : (
              <Stack spacing={1.5}>
                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const ids = docs.map((d) => d.id);
                      if (!ids.length) return;
                      if (!confirm(`Rerun für alle ${ids.length} Dokumente starten?`)) return;
                      rerunAllMut.mutate(ids);
                    }}
                    disabled={rerunAllMut.isPending || rerunMut.isPending || deleteMut.isPending}
                  >
                    Rerun all
                  </Button>
                </Box>

                {rerunAllMut.isPending ? (
                  <Alert severity="info" icon={<CircularProgress size={18} />}>
                    Rerun läuft… {rerunAllDone}/{docs.length}
                  </Alert>
                ) : rerunAllMut.isError ? (
                  <Alert severity="error">{apiErrorMessage(rerunAllMut.error)}</Alert>
                ) : null}

                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <Alert severity="info" sx={{ py: 0.5 }}>
                    Dokumente vorhanden: <strong>{overviewKpis.docs_total}</strong>
                  </Alert>
                  <Alert severity="success" sx={{ py: 0.5 }}>
                    Zeiträume vorhanden: <strong>{overviewKpis.months_present}</strong>
                  </Alert>
                  <Alert severity={overviewKpis.months_missing > 0 ? 'warning' : 'success'} sx={{ py: 0.5 }}>
                    Zeiträume fehlen: <strong>{overviewKpis.months_missing}</strong>
                  </Alert>
                </Stack>

                <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
                  <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Zeitraum</TableCell>
                      <TableCell>Datei</TableCell>
                      <TableCell>Pfad</TableCell>
                      <TableCell>Größe</TableCell>
                      <TableCell>Erstellt</TableCell>
                      <TableCell align="right">Aktionen</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {docs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6}>Noch keine Verdienstnachweise importiert.</TableCell>
                      </TableRow>
                    ) : (
                      overviewRows.map((r) => {
                        if (r.kind === 'missing') {
                          return (
                            <TableRow key={`missing-${r.year}-${r.month}`} hover>
                              <TableCell sx={{ whiteSpace: 'nowrap' }}>{ymLabel(r.year, r.month)}</TableCell>
                              <TableCell colSpan={5}>
                                <Typography variant="body2" color="warning.main" fontWeight={700}>
                                  Hinweis: Verdienstnachweis fehlt in diesem Zeitraum.
                                </Typography>
                              </TableCell>
                            </TableRow>
                          );
                        }

                        const d = r.doc;
                        return (
                          <TableRow
                            key={d.id}
                            hover
                            selected={selectedDocId === d.id}
                            onClick={() => {
                              setSelectedDocId(d.id);
                              setTab(2);
                            }}
                            sx={{ cursor: 'pointer' }}
                          >
                            <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatPeriod(d)}</TableCell>
                            <TableCell>
                              <Button
                                variant="text"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setSelectedDocId(d.id);
                                  setTab(2);
                                }}
                                sx={{ textTransform: 'none', px: 0 }}
                              >
                                {d.file_name}
                              </Button>
                            </TableCell>
                            <TableCell sx={{ maxWidth: 420 }}>
                              <Typography variant="body2" noWrap title={d.relative_path || ''}>
                                {d.relative_path || '—'}
                              </Typography>
                            </TableCell>
                            <TableCell>{new Intl.NumberFormat('de-DE').format(d.size_bytes)} B</TableCell>
                            <TableCell>{String(d.created_at).slice(0, 19).replace('T', ' ')}</TableCell>
                            <TableCell align="right">
                              <Stack direction="row" spacing={1} justifyContent="flex-end">
                                <Button
                                  size="small"
                                  variant="outlined"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    rerunMut.mutate(d.id);
                                  }}
                                  disabled={rerunMut.isPending || deleteMut.isPending}
                                >
                                  Rerun
                                </Button>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  component="a"
                                  href={downloadUrl(d.id)}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                  }}
                                >
                                  Download
                                </Button>
                                <Button
                                  size="small"
                                  variant="outlined"
                                  color="error"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (!confirm(`Verdienstnachweis löschen?\n\n${d.file_name}`)) return;
                                    deleteMut.mutate(d.id);
                                  }}
                                  disabled={deleteMut.isPending || rerunMut.isPending}
                                >
                                  Löschen
                                </Button>
                              </Stack>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                  </Table>
                </TableContainer>
              </Stack>
            )}
          </Box>
        ) : null}

        {tab === 1 ? (
          <Box sx={{ pt: 2 }}>
            {analysisQuery.isError ? <Alert severity="error">{apiErrorMessage(analysisQuery.error)}</Alert> : null}
            {analysisQuery.isLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                <CircularProgress />
              </Box>
            ) : (
              <Stack spacing={2}>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
                  <FormControl size="small" sx={{ minWidth: 260 }}>
                    <InputLabel id="analysisMetric">Wert</InputLabel>
                    <Select
                      labelId="analysisMetric"
                      label="Wert"
                      value={analysisMetric}
                      onChange={(e) => setAnalysisMetric(String(e.target.value || 'payout'))}
                      renderValue={(v) => {
                        const id = String(v || '');
                        const m = timelineMetrics.find((x) => x.id === id);
                        return m ? m.label : id;
                      }}
                    >
                      {timelineMetrics.map((m) => {
                        const checked = analysisMetric === m.id;
                        return (
                          <MenuItem key={m.id} value={m.id}>
                            <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', pl: Math.max(0, m.depth) * 2 }}>
                              <Checkbox checked={checked} sx={{ p: 0.5, mr: 1 }} />
                              <Typography
                                variant="body2"
                                sx={{
                                  fontWeight: m.depth === 0 ? 700 : 500,
                                  opacity: m.depth === 0 ? 1 : 0.9,
                                }}
                              >
                                {m.label}
                              </Typography>
                            </Box>
                          </MenuItem>
                        );
                      })}
                    </Select>
                  </FormControl>

                  <FormControl size="small" sx={{ minWidth: 160 }}>
                    <InputLabel id="analysisFrom">Von</InputLabel>
                    <Select
                      labelId="analysisFrom"
                      label="Von"
                      value={analysisFromYm}
                      onChange={(e) => setAnalysisFromYm(String(e.target.value || ''))}
                    >
                      <MenuItem value="">Alle</MenuItem>
                      {timelineYmOptions.map((k) => (
                        <MenuItem key={k} value={k}>
                          {k}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>

                  <FormControl size="small" sx={{ minWidth: 160 }}>
                    <InputLabel id="analysisTo">Bis</InputLabel>
                    <Select
                      labelId="analysisTo"
                      label="Bis"
                      value={analysisToYm}
                      onChange={(e) => setAnalysisToYm(String(e.target.value || ''))}
                    >
                      <MenuItem value="">Alle</MenuItem>
                      {timelineYmOptions.map((k) => (
                        <MenuItem key={k} value={k}>
                          {k}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Box>

                <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                    Zeitverlauf (Beträge pro Monat)
                  </Typography>
                  {timelineQuery.isError ? (
                    <Alert severity="error">{apiErrorMessage(timelineQuery.error)}</Alert>
                  ) : analysisTimeline.labels.length ? (
                    <EChart
                      height={260}
                      option={{
                        grid: { left: 72, right: 20, top: 20, bottom: 35, containLabel: true },
                        tooltip: {
                          trigger: 'axis',
                          valueFormatter: (v: any) =>
                            new Intl.NumberFormat('de-DE', {
                              style: 'currency',
                              currency: 'EUR',
                              maximumFractionDigits: 0,
                              minimumFractionDigits: 0,
                            }).format(Number(v)),
                        },
                        xAxis: { type: 'category', data: analysisTimeline.labels, axisLabel: { rotate: 25 } },
                        yAxis: {
                          type: 'value',
                          axisLabel: {
                            formatter: (v: any) =>
                              new Intl.NumberFormat('de-DE', {
                                style: 'currency',
                                currency: 'EUR',
                                maximumFractionDigits: 0,
                                minimumFractionDigits: 0,
                              }).format(Number(v)),
                          },
                        },
                        series: [
                          {
                            name: 'Wert',
                            type: 'line',
                            data: analysisTimeline.values,
                            smooth: true,
                            symbolSize: 6,
                            areaStyle: { opacity: 0.12 },
                          },
                        ],
                      }}
                    />
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      Keine auswertbaren Monatswerte in der aktuellen Auswahl.
                    </Typography>
                  )}
                </Paper>

                {String(analysisMetric || '').startsWith('sectionpath:') ? (
                  <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
                    <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                      Aufschlüsselung (Ebene darunter)
                    </Typography>
                    {breakdownQuery.isError ? (
                      <Alert severity="error">{apiErrorMessage(breakdownQuery.error)}</Alert>
                    ) : breakdownQuery.isLoading ? (
                      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                        <CircularProgress />
                      </Box>
                    ) : breakdown && breakdown.series.length ? (
                      <EChart
                        height={300}
                        option={{
                          grid: { left: 72, right: 20, top: 20, bottom: 70, containLabel: true },
                          tooltip: {
                            trigger: 'axis',
                            axisPointer: { type: 'shadow' },
                            valueFormatter: (v: any) =>
                              new Intl.NumberFormat('de-DE', {
                                style: 'currency',
                                currency: 'EUR',
                                maximumFractionDigits: 0,
                                minimumFractionDigits: 0,
                              }).format(Number(v)),
                          },
                          legend: { type: 'scroll', bottom: 0 },
                          xAxis: { type: 'category', data: breakdown.labels, axisLabel: { rotate: 25 } },
                          yAxis: {
                            type: 'value',
                            axisLabel: {
                              formatter: (v: any) =>
                                new Intl.NumberFormat('de-DE', {
                                  style: 'currency',
                                  currency: 'EUR',
                                  maximumFractionDigits: 0,
                                  minimumFractionDigits: 0,
                                }).format(Number(v)),
                            },
                          },
                          series: breakdown.series.map((s) => ({
                            name: s.label,
                            type: 'line',
                            stack: 'total',
                            emphasis: { focus: 'series' },
                            data: s.values,
                            showSymbol: false,
                            smooth: true,
                            areaStyle: { opacity: 0.22 },
                          })),
                        }}
                      />
                    ) : (
                      <Typography variant="body2" color="text.secondary">
                        Keine Untergruppen für diese Auswahl gefunden.
                      </Typography>
                    )}
                  </Paper>
                ) : null}
              </Stack>
            )}
          </Box>
        ) : null}

        {tab === 2 ? (
          <Box sx={{ pt: 2 }}>
            {!selectedDoc ? <Alert severity="warning">Wähle in der Übersicht ein Dokument aus.</Alert> : null}
            {selectedDoc ? (
              <Stack spacing={2}>
                <Typography variant="subtitle1" fontWeight={700}>
                  {selectedDoc.file_name}
                </Typography>
                {linesQuery.isError ? <Alert severity="error">{apiErrorMessage(linesQuery.error)}</Alert> : null}
                {linesQuery.isLoading ? (
                  <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
                    <CircularProgress />
                  </Box>
                ) : tree.length === 0 ? (
                  <Alert severity="info">
                    Keine Positionen erkannt. Falls das PDF ein Scan ist, brauchen wir OCR (kann ich als nächsten Schritt
                    ergänzen).
                  </Alert>
                ) : (
                  <Stack spacing={2}>
                    <Tabs
                      value={positionsView}
                      onChange={(_, v) => setPositionsView(v)}
                      variant="scrollable"
                      scrollButtons="auto"
                    >
                      <Tab label="Tabelle" />
                      <Tab label="Aufklappbar" />
                      <Tab label="Waterfall" />
                      <Tab label="Sankey" />
                      <Tab label="Be-/Entzüge" />
                    </Tabs>

                    {positionsView === 0 ? (
                      <>
                        {(() => {
                          const renderNode = (node: SectionNode, depth: number) => {
                            const table = node.children.length ? renderLinesTable(node.children) : null;

                            // Für übergeordnete Cluster: Rahmen um die Bestandteile + darunter die eigene Tabelle.
                            const transfers = node.sections.find(isTransfersSection) ?? null;
                            const childSections = node.sections.filter((s) => !isTransfersSection(s));

                            if (node.sections.length) {
                              return (
                                <Paper
                                  key={node.section.id}
                                  elevation={0}
                                  sx={{
                                    border: 1,
                                    ...frameSx(depth),
                                    borderRadius: 2,
                                    p: 1.5,
                                    ml: depth ? 1.25 : 0,
                                  }}
                                >
                                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                                    <Typography variant={depth === 0 ? 'subtitle1' : 'subtitle2'} fontWeight={900}>
                                      {node.section.label}
                                    </Typography>
                                  </Box>

                                  <Stack spacing={1.25}>{childSections.map((ch) => renderNode(ch, depth + 1))}</Stack>

                                  {table ? (
                                    <Box sx={{ mt: 1.25, pt: 1.25, borderTop: 1, borderColor: 'divider' }}>{table}</Box>
                                  ) : null}

                                  {transfers && transfers.children.length ? (
                                    <Box sx={{ mt: 1.25, pt: 1.25, borderTop: 1, borderColor: 'divider' }}>
                                      <Typography variant="subtitle2" fontWeight={900} gutterBottom>
                                        Überweisungen
                                      </Typography>
                                      {renderLinesTable(transfers.children)}
                                    </Box>
                                  ) : null}
                                </Paper>
                              );
                            }

                            // Leaf-Cluster: normaler Rahmen + Tabelle direkt darunter.
                            return (
                              <Paper
                                key={node.section.id}
                                elevation={0}
                                sx={{
                                  border: 1,
                                  ...frameSx(depth),
                                  borderRadius: 2,
                                  p: 1.5,
                                  ml: depth ? 1.25 : 0,
                                }}
                              >
                                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
                                  <Typography variant={depth === 0 ? 'subtitle1' : 'subtitle2'} fontWeight={900}>
                                    {node.section.label}
                                  </Typography>
                                </Box>
                                {table}
                              </Paper>
                            );
                          };

                          return <Stack spacing={1.5}>{tree.map((root) => renderNode(root, 0))}</Stack>;
                        })()}
                      </>
                    ) : null}

                    {positionsView === 1 ? (
                      <>
                        {(() => {
                          const sumNodeItems = (node: SectionNode): number => {
                            // Für Parent-Cluster: Summe ergibt sich aus den Child-Clustern (fachliche Rollup-Logik).
                            // Für Leaf-Cluster: Summe der Einzelpositionen (ohne Summenzeilen).
                            if (node.sections.length) {
                              const parent = String(node.section.label || '').trim();
                              const allowByParent: Record<string, Set<string>> = {
                                Bruttoentgelt: new Set(['Entgelt', 'Sonstige Bezüge']),
                                Nettoentgelt: new Set([
                                  'Bruttoentgelt',
                                  'Gesetzliche Abzüge Steuer',
                                  'Gesetzliche Abzüge Sozialversicherung',
                                ]),
                                Auszahlungsbetrag: new Set(['Nettoentgelt', 'Persönliche Be- und Abzüge']),
                              };
                              const allow = allowByParent[parent];
                              const kids = allow
                                ? node.sections.filter((ch) => allow.has(String(ch.section.label || '').trim()))
                                : node.sections;
                              return kids.reduce((s, ch) => s + sumNodeItems(ch), 0);
                            }
                            return node.children.reduce((s, l) => {
                              if (l.kind === 'sum') return s;
                              const n = parseAmount(l.amount);
                              return n == null ? s : s + n;
                            }, 0);
                          };

                          const nodeCurrency = (node: SectionNode): string => {
                            const c = node.children.find((l) => l.currency)?.currency;
                            if (c) return c;
                            for (const ch of node.sections) {
                              const cc = nodeCurrency(ch);
                              if (cc) return cc;
                            }
                            return 'EUR';
                          };

                          const renderNode = (node: SectionNode, depth: number) => (
                            <Accordion
                              key={node.section.id}
                              defaultExpanded={depth <= 1}
                              elevation={0}
                              sx={{
                                border: 1,
                                ...frameSx(depth),
                                borderRadius: 2,
                                ml: depth ? 1.25 : 0,
                                '&:before': { display: 'none' },
                              }}
                            >
                              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 1.5 }}>
                                <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', width: '100%', gap: 2 }}>
                                  <Typography variant={depth === 0 ? 'subtitle1' : 'subtitle2'} fontWeight={900}>
                                    {node.section.label}
                                  </Typography>
                                  <Typography variant="body2" fontWeight={900} sx={{ whiteSpace: 'nowrap' }}>
                                    {fmtCurrency(sumNodeItems(node), nodeCurrency(node))}
                                  </Typography>
                                </Box>
                              </AccordionSummary>
                              <AccordionDetails sx={{ pt: 0, px: 1.5, pb: 1.5 }}>
                                {/* Parent-Cluster soll die Bestandteile "umschließen" */}
                                {(() => {
                                  const transfers = node.sections.find(isTransfersSection) ?? null;
                                  const childSections = node.sections.filter((s) => !isTransfersSection(s));
                                  return (
                                    <>
                                      {childSections.length ? (
                                        <Stack spacing={1.25}>{childSections.map((ch) => renderNode(ch, depth + 1))}</Stack>
                                      ) : null}
                                    </>
                                  );
                                })()}

                                {node.children.length ? (
                                  <Box sx={{ mt: node.sections.length ? 1.25 : 0, pt: node.sections.length ? 1.25 : 0, borderTop: node.sections.length ? 1 : 0, borderColor: 'divider' }}>
                                    {renderLinesTable(node.children)}
                                  </Box>
                                ) : null}

                                {(() => {
                                  const transfers = node.sections.find(isTransfersSection) ?? null;
                                  const childSections = node.sections.filter((s) => !isTransfersSection(s));
                                  return transfers && transfers.children.length ? (
                                    <Box
                                      sx={{
                                        mt: (node.children.length || childSections.length) ? 1.25 : 0,
                                        border: 1,
                                        borderColor: 'divider',
                                        borderRadius: 2,
                                        p: 1.25,
                                      }}
                                    >
                                      <Typography variant="subtitle2" fontWeight={900} gutterBottom>
                                        Überweisungen
                                      </Typography>
                                      {renderLinesTable(transfers.children)}
                                    </Box>
                                  ) : null;
                                })()}
                              </AccordionDetails>
                            </Accordion>
                          );

                          return <Stack spacing={1.25}>{tree.map((root) => renderNode(root, 0))}</Stack>;
                        })()}
                      </>
                    ) : null}

                    {positionsView === 2 ? (
                      <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
                        <Typography variant="subtitle2" fontWeight={800} gutterBottom>
                          Überleitung (Waterfall)
                        </Typography>
                        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                          Start: Gesamtbrutto · Schritte: Sektionen · Ende: Auszahlungsbetrag
                        </Typography>
                        <EChart
                          height={460}
                          option={((): echarts.EChartsOption => {
                            const steps = sectionTotals
                              .filter((s) => s.section !== 'Bruttoentgelt')
                              .filter((s) => Math.abs(s.total) > 0.0001);
                            const categories = ['Gesamtbrutto', ...steps.map((s) => s.section), 'Auszahlung'];
                            const start = gross ?? 0;
                            const end = payout ?? steps.reduce((acc, s) => acc + s.total, start);

                            let running = start;
                            const helper: number[] = [];
                            const delta: number[] = [];

                            helper.push(0);
                            delta.push(start);
                            for (const s of steps) {
                              helper.push(Math.min(running, running + s.total));
                              delta.push(Math.abs(s.total));
                              running += s.total;
                            }
                            helper.push(0);
                            delta.push(end);

                            return {
                              grid: { left: 40, right: 20, top: 40, bottom: 70 },
                              tooltip: {
                                trigger: 'axis',
                                axisPointer: { type: 'shadow' },
                                valueFormatter: (v: any) =>
                                  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(v)),
                              },
                              xAxis: { type: 'category', data: categories, axisLabel: { rotate: 25 } },
                              yAxis: { type: 'value' },
                              series: [
                                {
                                  name: 'helper',
                                  type: 'bar',
                                  stack: 'total',
                                  itemStyle: { color: 'transparent' },
                                  emphasis: { itemStyle: { color: 'transparent' } },
                                  data: helper,
                                },
                                {
                                  name: 'Betrag',
                                  type: 'bar',
                                  stack: 'total',
                                  data: delta.map((v, i) => {
                                    if (i === 0) return { value: v, itemStyle: { color: '#2e7d32' } };
                                    if (i === delta.length - 1) return { value: v, itemStyle: { color: '#1565c0' } };
                                    const stepVal = steps[i - 1]?.total ?? 0;
                                    return { value: v, itemStyle: { color: stepVal < 0 ? '#c62828' : '#2e7d32' } };
                                  }),
                                },
                              ],
                            };
                          })()}
                        />
                      </Paper>
                    ) : null}

                    {positionsView === 3 ? (
                      <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
                        <Typography variant="subtitle2" fontWeight={800} gutterBottom>
                          Flow (Sankey)
                        </Typography>
                        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                          Sektionen als Knoten, Beträge als Flüsse (vereinfachtes Überleitungsbild).
                        </Typography>
                        <EChart
                          height={520}
                          option={((): echarts.EChartsOption => {
                            type Node = { name: string };
                            type Link = { source: string; target: string; value: number };

                            const byLabel = new Map<string, SectionNode>();
                            const walk = (n: SectionNode) => {
                              byLabel.set(String(n.section.label || '').trim(), n);
                              for (const ch of n.sections) walk(ch);
                            };
                            for (const r of tree) walk(r);

                            const get = (label: string) => byLabel.get(label);

                            const sumItems = (node?: SectionNode | null): number => {
                              if (!node) return 0;
                              return node.children.reduce((s, l) => {
                                if (l.kind === 'sum') return s;
                                const n = parseAmount(l.amount);
                                return n == null ? s : s + n;
                              }, 0);
                            };

                            const itemFlows = (node?: SectionNode | null) => {
                              if (!node) return [] as Array<{ label: string; value: number; signed: number }>;
                              return node.children
                                .filter((l) => l.kind !== 'sum')
                                .map((l) => {
                                  const signed = parseAmount(l.amount) ?? 0;
                                  return { label: String(l.label || ''), value: Math.abs(signed), signed };
                                })
                                .filter((x) => x.value > 0.0001);
                            };

                            const entgelt = get('Entgelt');
                            const sonst = get('Sonstige Bezüge');
                            const brutto = get('Bruttoentgelt');
                            const steuer = get('Gesetzliche Abzüge Steuer');
                            const sv = get('Gesetzliche Abzüge Sozialversicherung');
                            const netto = get('Nettoentgelt');
                            const pers = get('Persönliche Be- und Abzüge');
                            const auszahlung = get('Auszahlungsbetrag');

                            const nodes = new Map<string, Node>();
                            const links: Link[] = [];
                            const addNode = (name: string) => nodes.set(name, { name });
                            const addLink = (source: string, target: string, value: number) => {
                              if (!Number.isFinite(value) || value <= 0.0001) return;
                              addNode(source);
                              addNode(target);
                              links.push({ source, target, value });
                            };

                            // 1) Entgelt & Sonstige Bezüge (Details) -> Bruttoentgelt
                            const entgeltDetails = itemFlows(entgelt);
                            for (const it of entgeltDetails) addLink(it.label, 'Entgelt', it.value);
                            addLink('Entgelt', 'Bruttoentgelt', entgeltDetails.reduce((s, it) => s + it.value, 0));

                            const sonstDetails = itemFlows(sonst);
                            for (const it of sonstDetails) addLink(it.label, 'Sonstige Bezüge', it.value);
                            addLink('Sonstige Bezüge', 'Bruttoentgelt', sonstDetails.reduce((s, it) => s + it.value, 0));

                            // Bruttoentgelt node exists even if details are empty (falls PDF anders ist)
                            addNode('Bruttoentgelt');

                            // 2) Bruttoentgelt Abfluss -> Steuer + Details, SV + Details, Rest -> Nettoentgelt
                            const steuerDetails = itemFlows(steuer);
                            const svDetails = itemFlows(sv);
                            const steuerVal = steuerDetails.reduce((s, it) => s + it.value, 0);
                            const svVal = svDetails.reduce((s, it) => s + it.value, 0);
                            for (const it of steuerDetails) addLink('Gesetzliche Abzüge Steuer', it.label, it.value);
                            for (const it of svDetails) addLink('Gesetzliche Abzüge Sozialversicherung', it.label, it.value);
                            addLink('Bruttoentgelt', 'Gesetzliche Abzüge Steuer', steuerVal);
                            addLink('Bruttoentgelt', 'Gesetzliche Abzüge Sozialversicherung', svVal);

                            // Netto: bevorzugt aus Nettoentgelt-Items (Gesetzl. Netto), sonst als Brutto - Abzüge
                            const nettoVal = Math.abs(sumItems(netto)) > 0.0001 ? Math.abs(sumItems(netto)) : Math.max(0, sumItems(brutto) - steuerVal - svVal);
                            addLink('Bruttoentgelt', 'Nettoentgelt', nettoVal);

                            // 3) Nettoentgelt Abfluss -> Persönliche Be- und Abzüge + Details, Rest -> Auszahlungsbetrag
                            const persDetails = itemFlows(pers);
                            const persVal = persDetails.reduce((s, it) => s + it.value, 0);
                            for (const it of persDetails) addLink('Persönliche Be- und Abzüge', it.label, it.value);
                            addLink('Nettoentgelt', 'Persönliche Be- und Abzüge', persVal);

                            const payoutVal =
                              Math.abs(sumItems(auszahlung)) > 0.0001 ? Math.abs(sumItems(auszahlung)) : Math.max(0, nettoVal - persVal);
                            addLink('Nettoentgelt', 'Auszahlungsbetrag', payoutVal);

                            // ensure key nodes exist for readability
                            for (const n of [
                              'Entgelt',
                              'Sonstige Bezüge',
                              'Bruttoentgelt',
                              'Gesetzliche Abzüge Steuer',
                              'Gesetzliche Abzüge Sozialversicherung',
                              'Nettoentgelt',
                              'Persönliche Be- und Abzüge',
                              'Auszahlungsbetrag',
                            ]) addNode(n);

                            return {
                              tooltip: { trigger: 'item' },
                              series: [
                                {
                                  type: 'sankey',
                                  data: Array.from(nodes.values()),
                                  links,
                                  emphasis: { focus: 'adjacency' },
                                  nodeGap: 10,
                                  nodeWidth: 18,
                                  lineStyle: { color: 'gradient', curveness: 0.5 },
                                },
                              ],
                            };
                          })()}
                        />
                      </Paper>
                    ) : null}

                    {positionsView === 4 ? (
                      <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
                        <Typography variant="subtitle2" fontWeight={800} gutterBottom>
                          Be- und Entzüge (diverging bars)
                        </Typography>
                        <EChart
                          height={520}
                          option={((): echarts.EChartsOption => {
                            const rows = sectionTotals
                              .filter((s) => Math.abs(s.total) > 0.0001)
                              .slice()
                              .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
                              .slice(0, 14);
                            const cats = rows.map((r) => r.section);
                            const pos = rows.map((r) => (r.total > 0 ? r.total : 0));
                            const neg = rows.map((r) => (r.total < 0 ? r.total : 0));
                            return {
                              grid: { left: 170, right: 20, top: 20, bottom: 30 },
                              tooltip: {
                                trigger: 'axis',
                                axisPointer: { type: 'shadow' },
                                valueFormatter: (v: any) =>
                                  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(Number(v)),
                              },
                              xAxis: { type: 'value' },
                              yAxis: { type: 'category', data: cats, axisLabel: { width: 160, overflow: 'truncate' } },
                              series: [
                                { name: 'Entzüge', type: 'bar', stack: 't', data: neg, itemStyle: { color: '#c62828' } },
                                { name: 'Bezüge', type: 'bar', stack: 't', data: pos, itemStyle: { color: '#2e7d32' } },
                              ],
                            };
                          })()}
                        />
                      </Paper>
                    ) : null}
                  </Stack>
                )}
              </Stack>
            ) : null}
          </Box>
        ) : null}
      </Paper>
    </Stack>
  );
}

