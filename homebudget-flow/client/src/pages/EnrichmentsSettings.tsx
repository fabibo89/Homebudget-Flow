import { useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
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
import { ExpandMore as ExpandMoreIcon } from '@mui/icons-material';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  apiErrorMessage,
  fetchExternalRecordMappings,
  fetchHouseholds,
  importTransactionEnrichments,
  type ExternalRecordMapping,
  type Household,
} from '../api/client';

type MappingOrderCluster = {
  orderKey: string;
  rows: ExternalRecordMapping[];
  amountSum: number;
  currencies: Set<string>;
  matchedTxCount: number;
};

type ExternalImportRecord = {
  external_ref: string;
  booking_date: string;
  amount: string;
  currency: string;
  description: string;
  counterparty: string | null;
  vendor: string | null;
  details: Record<string, unknown>;
  raw: Record<string, unknown>;
};

function parseIsoDateOnly(s: string): string | null {
  const v = (s || '').trim();
  if (!v) return null;
  const d = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function asDecimalString(s: string | undefined | null): string | null {
  const v = String(s ?? '').trim();
  if (!v || v.toLowerCase() === 'not available') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return v;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = (cols[c] ?? '').trim();
    rows.push(row);
  }
  return rows;
}

function mapAmazonOrderRow(row: Record<string, string>): ExternalImportRecord | null {
  const orderId = (row['Order ID'] || '').trim();
  const asin = (row['ASIN'] || '').trim();
  const bookingDate = parseIsoDateOnly(row['Order Date'] || '');
  const currency = (row['Currency'] || 'EUR').trim() || 'EUR';
  const amount =
    asDecimalString(row['Total Amount']) ?? asDecimalString(row['Shipment Item Subtotal']) ?? null;
  if (!orderId || !bookingDate || !amount) return null;
  const product = (row['Product Name'] || '').trim();
  const externalRef = asin ? `${orderId}:${asin}` : orderId;
  return {
    external_ref: externalRef,
    booking_date: bookingDate,
    amount,
    currency,
    description: product || `Amazon Bestellung ${orderId}`,
    counterparty: 'Amazon',
    vendor: 'Amazon',
    details: {
      order_id: orderId,
      asin,
      product_name: product,
      quantity: (row['Original Quantity'] || '').trim(),
      order_status: (row['Order Status'] || '').trim(),
      payment_method_type: (row['Payment Method Type'] || '').trim(),
      carrier_tracking: (row['Carrier Name & Tracking Number'] || '').trim(),
      ship_date: (row['Ship Date'] || '').trim(),
      shipping_option: (row['Shipping Option'] || '').trim(),
      shipping_charge: (row['Shipping Charge'] || '').trim(),
      total_discounts: (row['Total Discounts'] || '').trim(),
      website: (row['Website'] || '').trim(),
    },
    raw: row,
  };
}

function findOrderHistoryCsv(files: FileList | File[]): File | null {
  const arr = Array.from(files);
  const exact = arr.find((f) => f.name === 'Order History.csv');
  if (exact) return exact;
  return arr.find((f) => f.name.toLowerCase().endsWith('order history.csv')) ?? null;
}

function parseGermanDateOnly(s: string): string | null {
  const v = (s || '').trim();
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseGermanDecimalString(s: string | undefined | null): string | null {
  const v = String(s ?? '').trim();
  if (!v) return null;
  const normalized = v.replace(/\./g, '').replace(',', '.');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return normalized;
}

function isPayPalActivityExportHeaderLine(line: string): boolean {
  const h = line.toLowerCase();
  return (
    h.includes('transaktionscode') &&
    h.includes('netto') &&
    (h.includes('beschreibung') || h.includes('zugehöriger transaktionscode'))
  );
}

function mapPayPalCsrRow(row: Record<string, string>): ExternalImportRecord | null {
  const code = (row['Transaktionscode'] || '').trim();
  const bookingDate = parseGermanDateOnly(row['Datum'] || '');
  const amount = parseGermanDecimalString(row['Netto']);
  const currency = (row['Währung'] || 'EUR').trim() || 'EUR';
  const typ = (row['Beschreibung'] || '').trim();
  const name = (row['Name'] || '').trim();
  const email = (row['Absender E-Mail-Adresse'] || '').trim();
  const related = (row['Zugehöriger Transaktionscode'] || '').trim();
  const invoice = (row['Rechnungsnummer'] || '').trim();
  if (!code || !bookingDate || !amount) return null;
  const counterparty = name || email || null;
  const descParts = [typ, name || email].filter(Boolean);
  return {
    external_ref: code,
    booking_date: bookingDate,
    amount,
    currency,
    description: descParts.join(' · ') || `PayPal ${code}`,
    counterparty,
    vendor: 'PayPal',
    details: {
      paypal_transaction_code: code,
      paypal_related_code: related || undefined,
      paypal_beschreibung: typ,
      paypal_rechnungsnummer: invoice || undefined,
      paypal_sender_email: email || undefined,
    },
    raw: row,
  };
}

function toOrderKey(row: ExternalRecordMapping): string {
  const orderId = (row.order_id ?? '').trim();
  if (orderId) return orderId;
  const ref = (row.external_ref ?? '').trim();
  if (!ref) return `record-${row.record_id}`;
  const i = ref.indexOf(':');
  return i > 0 ? ref.slice(0, i) : ref;
}

function clusterByOrder(rows: ExternalRecordMapping[]): MappingOrderCluster[] {
  const byOrder = new Map<string, MappingOrderCluster>();
  for (const row of rows) {
    const key = toOrderKey(row);
    const amountNum = Number(row.amount);
    const cluster = byOrder.get(key) ?? {
      orderKey: key,
      rows: [],
      amountSum: 0,
      currencies: new Set<string>(),
      matchedTxCount: 0,
    };
    cluster.rows.push(row);
    if (!Number.isNaN(amountNum)) cluster.amountSum += amountNum;
    if (row.currency) cluster.currencies.add(row.currency);
    if (row.matched_transaction_id != null) {
      cluster.matchedTxCount += 1;
    }
    byOrder.set(key, cluster);
  }
  return Array.from(byOrder.values()).sort((a, b) => a.orderKey.localeCompare(b.orderKey, 'de'));
}

const eurFmt = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function parseAmount(s: string | null | undefined): number | null {
  const n = Number(String(s ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Summe der eindeutigen Bankbuchungen pro Cluster.
 * Amazon: CSV-Beträge sind typischerweise positiv, Bank-Lastschriften negativ → für Vergleich |Bank|.
 * PayPal: CSV (Netto) und Bank nutzen dasselbe Vorzeichen → summieren mit Vorzeichen.
 */
function sumUniqueMatchedBookings(rows: ExternalRecordMapping[], source: 'amazon' | 'paypal'): number {
  const byTxId = new Map<number, number>();
  for (const r of rows) {
    if (r.matched_transaction_id == null) continue;
    const amt = parseAmount(r.matched_amount);
    if (amt == null) continue;
    const stored = source === 'amazon' ? Math.abs(amt) : amt;
    if (!byTxId.has(r.matched_transaction_id)) byTxId.set(r.matched_transaction_id, stored);
  }
  let s = 0;
  for (const v of byTxId.values()) s += v;
  return s;
}

function uniqueMatchedTransactionCount(rows: ExternalRecordMapping[]): number {
  const ids = new Set<number>();
  for (const r of rows) {
    if (r.matched_transaction_id != null) ids.add(r.matched_transaction_id);
  }
  return ids.size;
}

function rowOrderBankDelta(r: ExternalRecordMapping, source: 'amazon' | 'paypal'): number | null {
  const o = parseAmount(r.amount);
  const b = parseAmount(r.matched_amount);
  if (o == null || b == null) return null;
  if (source === 'amazon') return o - Math.abs(b);
  return o - b;
}

function formatSignedEur(n: number): string {
  const sign = n > 0 ? '+' : '';
  return `${sign}${eurFmt.format(n)}`;
}

const mappingUi = {
  amazon: {
    panelTitle: 'Mapping-Ergebnis (Amazon CSV → Bankbuchung)',
    clusterSingular: 'Bestellung',
    clusterPlural: 'Bestellungen',
    csvColumn: 'Amazon',
  },
  paypal: {
    panelTitle: 'Mapping-Ergebnis (PayPal CSV → Bankbuchung)',
    clusterSingular: 'Gruppe',
    clusterPlural: 'Gruppen',
    csvColumn: 'PayPal',
  },
} as const;

function ExternalRecordMappingsPanel(props: {
  source: 'amazon' | 'paypal';
  householdId: number | null;
  refreshKey: number;
}) {
  const { source, householdId, refreshKey } = props;
  const ui = mappingUi[source];
  const [mappedOpen, setMappedOpen] = useState(true);
  const [unmappedOpen, setUnmappedOpen] = useState(true);

  const mappingsQuery = useQuery({
    queryKey: ['external-record-mappings', householdId, source, refreshKey],
    queryFn: () => fetchExternalRecordMappings(householdId!, source, 1000),
    enabled: Boolean(householdId),
  });

  const matchedRows = useMemo(
    () => (mappingsQuery.data ?? []).filter((x: ExternalRecordMapping) => x.matched),
    [mappingsQuery.data],
  );
  const unmatchedRows = useMemo(
    () => (mappingsQuery.data ?? []).filter((x: ExternalRecordMapping) => !x.matched),
    [mappingsQuery.data],
  );
  const matchedClusters = useMemo(() => clusterByOrder(matchedRows), [matchedRows]);
  const unmatchedClusters = useMemo(() => clusterByOrder(unmatchedRows), [unmatchedRows]);

  return (
    <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
          <Typography variant="h6">{ui.panelTitle}</Typography>
          <Button
            size="small"
            variant="outlined"
            onClick={() => void mappingsQuery.refetch()}
            disabled={mappingsQuery.isFetching || !householdId}
          >
            {mappingsQuery.isFetching ? 'Laden…' : 'Aktualisieren'}
          </Button>
        </Stack>

        {mappingsQuery.isError ? <Alert severity="error">{apiErrorMessage(mappingsQuery.error)}</Alert> : null}

        {mappingsQuery.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            <Alert severity="info">
              Gemappt: {matchedRows.length} · Ohne Mapping: {unmatchedRows.length} · Geladene Einträge:{' '}
              {(mappingsQuery.data ?? []).length}
            </Alert>

            <Accordion expanded={mappedOpen} onChange={(_, ex) => setMappedOpen(ex)} disableGutters elevation={0}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">
                  Gemappt ({matchedRows.length}) · {ui.clusterPlural} ({matchedClusters.length})
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0 }}>
                <Stack spacing={1.5}>
                  {matchedClusters.length === 0 ? (
                    <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
                      <Table size="small">
                        <TableBody>
                          <TableRow>
                            <TableCell>Keine gemappten Einträge.</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : (
                    matchedClusters.map((cluster) => {
                      const sumBookings = sumUniqueMatchedBookings(cluster.rows, source);
                      const sumOrders = cluster.amountSum;
                      const clusterDelta = sumOrders - sumBookings;
                      const uniqTx = uniqueMatchedTransactionCount(cluster.rows);
                      return (
                        <Box key={`mapped-${cluster.orderKey}`} sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
                          <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
                            <Typography variant="subtitle2" fontWeight={700}>
                              {ui.clusterSingular} {cluster.orderKey}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
                              Zeilen: {cluster.rows.length} · Eindeutige Buchungen: {uniqTx}
                            </Typography>
                            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={2} sx={{ mt: 0.75 }}>
                              <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                <strong>Summe CSV:</strong> {eurFmt.format(sumOrders)}{' '}
                                {Array.from(cluster.currencies).join(', ') || 'EUR'}
                              </Typography>
                              <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                                <strong>Summe Buchungen:</strong> {eurFmt.format(sumBookings)} EUR
                              </Typography>
                              <Typography
                                variant="body2"
                                sx={{
                                  fontVariantNumeric: 'tabular-nums',
                                  color: Math.abs(clusterDelta) < 0.005 ? 'success.main' : 'warning.main',
                                  fontWeight: 600,
                                }}
                              >
                                <strong>Δ</strong> CSV − Buchungen: {formatSignedEur(clusterDelta)} EUR
                              </Typography>
                            </Stack>
                          </Box>
                          <TableContainer>
                            <Table size="small">
                              <TableHead>
                                <TableRow>
                                  <TableCell>Ref</TableCell>
                                  <TableCell>{ui.csvColumn}</TableCell>
                                  <TableCell>Buchung</TableCell>
                                  <TableCell align="right">Δ Zeile</TableCell>
                                </TableRow>
                              </TableHead>
                              <TableBody>
                                {cluster.rows.map((r) => {
                                  const d = rowOrderBankDelta(r, source);
                                  return (
                                    <TableRow key={r.record_id}>
                                      <TableCell>
                                        <Typography variant="body2" fontWeight={600}>
                                          {r.external_ref}
                                        </Typography>
                                      </TableCell>
                                      <TableCell>
                                        <Typography variant="body2">
                                          {r.booking_date} · {r.amount} {r.currency}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary">
                                          {r.description || '—'}
                                        </Typography>
                                      </TableCell>
                                      <TableCell>
                                        <Typography variant="body2">
                                          #{r.matched_transaction_id} · {r.matched_booking_date} · {r.matched_amount}{' '}
                                          {r.matched_currency}
                                        </Typography>
                                        <Typography variant="caption" color="text.secondary">
                                          {r.matched_bank_account_name ?? '—'} · {r.matched_description ?? '—'}
                                        </Typography>
                                      </TableCell>
                                      <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                        {d == null ? (
                                          '—'
                                        ) : (
                                          <Typography
                                            component="span"
                                            variant="body2"
                                            color={Math.abs(d) < 0.005 ? 'success.main' : 'warning.main'}
                                          >
                                            {formatSignedEur(d)}
                                          </Typography>
                                        )}
                                      </TableCell>
                                    </TableRow>
                                  );
                                })}
                              </TableBody>
                            </Table>
                          </TableContainer>
                        </Box>
                      );
                    })
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>

            <Accordion expanded={unmappedOpen} onChange={(_, ex) => setUnmappedOpen(ex)} disableGutters elevation={0}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2">
                  Ohne Mapping ({unmatchedRows.length}) · {ui.clusterPlural} ({unmatchedClusters.length})
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0 }}>
                <Stack spacing={1.5}>
                  {unmatchedClusters.length === 0 ? (
                    <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
                      <Table size="small">
                        <TableBody>
                          <TableRow>
                            <TableCell>Keine offenen Einträge.</TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </TableContainer>
                  ) : (
                    unmatchedClusters.map((cluster) => (
                      <Box
                        key={`unmapped-${cluster.orderKey}`}
                        sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}
                      >
                        <Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', bgcolor: 'action.hover' }}>
                          <Typography variant="subtitle2" fontWeight={700}>
                            {ui.clusterSingular} {cluster.orderKey}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
                            Zeilen: {cluster.rows.length}
                          </Typography>
                          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={2} sx={{ mt: 0.75 }}>
                            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                              <strong>Summe CSV:</strong> {eurFmt.format(cluster.amountSum)}{' '}
                              {Array.from(cluster.currencies).join(', ') || 'EUR'}
                            </Typography>
                            <Typography variant="body2" color="text.secondary">
                              <strong>Summe Buchungen:</strong> —
                            </Typography>
                            <Typography variant="body2" color="warning.main" sx={{ fontWeight: 600 }}>
                              <strong>Δ</strong> —
                            </Typography>
                          </Stack>
                        </Box>
                        <TableContainer>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>Ref</TableCell>
                                <TableCell>{ui.csvColumn}</TableCell>
                                <TableCell>Beschreibung</TableCell>
                                <TableCell align="right">Δ Zeile</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {cluster.rows.map((r) => (
                                <TableRow key={r.record_id}>
                                  <TableCell>
                                    <Typography variant="body2" fontWeight={600}>
                                      {r.external_ref}
                                    </Typography>
                                  </TableCell>
                                  <TableCell>
                                    {r.booking_date} · {r.amount} {r.currency}
                                  </TableCell>
                                  <TableCell sx={{ maxWidth: 420 }}>
                                    <Typography variant="body2" noWrap title={r.description || ''}>
                                      {r.description || '—'}
                                    </Typography>
                                  </TableCell>
                                  <TableCell align="right" sx={{ color: 'text.secondary' }}>
                                    —
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      </Box>
                    ))
                  )}
                </Stack>
              </AccordionDetails>
            </Accordion>
          </>
        )}
      </Stack>
    </Paper>
  );
}

export default function EnrichmentsSettings() {
  const householdsQuery = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });
  const households = householdsQuery.data ?? [];
  const defaultHouseholdId = households[0]?.id ?? null;

  const [householdId, setHouseholdId] = useState<number | ''>('');
  const effectiveHouseholdId = householdId === '' ? defaultHouseholdId : householdId;

  const [enrichTab, setEnrichTab] = useState(0);
  const [amazonFileName, setAmazonFileName] = useState('');
  const [amazonParseInfo, setAmazonParseInfo] = useState('');
  const [amazonUiError, setAmazonUiError] = useState('');
  const [lastAmazonImportAtMs, setLastAmazonImportAtMs] = useState(0);
  const [paypalFileName, setPaypalFileName] = useState('');
  const [paypalParseInfo, setPaypalParseInfo] = useState('');
  const [paypalUiError, setPaypalUiError] = useState('');
  const [lastPayPalImportAtMs, setLastPayPalImportAtMs] = useState(0);

  const importAmazonMut = useMutation({
    mutationFn: async (records: ExternalImportRecord[]) => {
      if (!effectiveHouseholdId) throw new Error('Kein Haushalt ausgewählt.');
      const batchSize = 5000;
      let imported = 0;
      let matched = 0;
      let unmatched = 0;
      let skipped_low_confidence = 0;
      for (let i = 0; i < records.length; i += batchSize) {
        const chunk = records.slice(i, i + batchSize);
        const res = await importTransactionEnrichments({
          household_id: effectiveHouseholdId,
          source: 'amazon',
          records: chunk,
          auto_match: true,
        });
        imported += res.imported;
        matched += res.matched;
        unmatched += res.unmatched;
        skipped_low_confidence += res.skipped_low_confidence;
      }
      return { imported, matched, unmatched, skipped_low_confidence };
    },
    onSuccess: () => setLastAmazonImportAtMs(Date.now()),
  });

  const importPayPalMut = useMutation({
    mutationFn: async (records: ExternalImportRecord[]) => {
      if (!effectiveHouseholdId) throw new Error('Kein Haushalt ausgewählt.');
      const batchSize = 5000;
      let imported = 0;
      let matched = 0;
      let unmatched = 0;
      let skipped_low_confidence = 0;
      let skipped_internal = 0;
      for (let i = 0; i < records.length; i += batchSize) {
        const chunk = records.slice(i, i + batchSize);
        const res = await importTransactionEnrichments({
          household_id: effectiveHouseholdId,
          source: 'paypal',
          records: chunk,
          auto_match: true,
        });
        imported += res.imported;
        matched += res.matched;
        unmatched += res.unmatched;
        skipped_low_confidence += res.skipped_low_confidence;
        skipped_internal += res.skipped_internal ?? 0;
      }
      return { imported, matched, unmatched, skipped_low_confidence, skipped_internal };
    },
    onSuccess: () => setLastPayPalImportAtMs(Date.now()),
  });

  const householdLabel = useMemo(() => {
    const id = effectiveHouseholdId;
    if (!id) return '';
    const h = households.find((x: Household) => x.id === id);
    return h?.name ?? `#${id}`;
  }, [effectiveHouseholdId, households]);

  async function handleAmazonFiles(files: FileList | File[]) {
    setAmazonUiError('');
    setAmazonParseInfo('');
    setAmazonFileName('');
    const file = findOrderHistoryCsv(files);
    if (!file) {
      setAmazonUiError('Keine "Order History.csv" gefunden. Bitte den Amazon-Export-Ordner oder die CSV-Datei auswählen.');
      return;
    }
    setAmazonFileName(file.name);
    const text = await file.text();
    const rows = parseCsv(text);
    const mapped: ExternalImportRecord[] = [];
    for (const r of rows) {
      const rec = mapAmazonOrderRow(r);
      if (rec) mapped.push(rec);
    }
    setAmazonParseInfo(`Gefunden: ${rows.length} CSV-Zeilen · importierbar: ${mapped.length}`);
    if (mapped.length === 0) {
      setAmazonUiError('Keine importierbaren Bestellzeilen gefunden (fehlende Order ID / Datum / Betrag).');
      return;
    }
    if (!effectiveHouseholdId) {
      setAmazonUiError('Bitte zuerst einen Haushalt wählen.');
      return;
    }
    if (importAmazonMut.isPending) return;
    importAmazonMut.reset();
    importAmazonMut.mutate(mapped);
  }

  async function handlePayPalFiles(files: FileList | File[]) {
    setPaypalUiError('');
    setPaypalParseInfo('');
    setPaypalFileName('');
    const csvFiles = Array.from(files).filter((f) => f.name.toLowerCase().endsWith('.csv'));
    let picked: { file: File; text: string } | null = null;
    for (const f of csvFiles) {
      const t = await f.text();
      const firstLine = t.split('\n')[0] ?? '';
      if (isPayPalActivityExportHeaderLine(firstLine)) {
        picked = { file: f, text: t };
        break;
      }
    }
    if (!picked) {
      setPaypalUiError(
        'Keine PayPal-Aktivitäts-CSV erkannt (erwartete Spalten u. a. Transaktionscode, Netto, Beschreibung).',
      );
      return;
    }
    setPaypalFileName(picked.file.name);
    const rows = parseCsv(picked.text);
    const mapped: ExternalImportRecord[] = [];
    for (const r of rows) {
      const rec = mapPayPalCsrRow(r);
      if (rec) mapped.push(rec);
    }
    setPaypalParseInfo(`Gefunden: ${rows.length} CSV-Zeilen · importierbar: ${mapped.length}`);
    if (mapped.length === 0) {
      setPaypalUiError('Keine importierbaren Zeilen (fehlender Transaktionscode / Datum / Netto).');
      return;
    }
    if (!effectiveHouseholdId) {
      setPaypalUiError('Bitte zuerst einen Haushalt wählen.');
      return;
    }
    if (importPayPalMut.isPending) return;
    importPayPalMut.reset();
    importPayPalMut.mutate(mapped);
  }

  const mappingsRefreshKey = enrichTab === 0 ? lastAmazonImportAtMs : lastPayPalImportAtMs;
  const mappingsSource = enrichTab === 0 ? 'amazon' : 'paypal';

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Externe Aufschlüsselungen (Amazon &amp; PayPal)
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Importiere CSV-Exporte und verknüpfe sie mit Bankbuchungen. Wähle unten die Quelle per Tab.
        </Typography>
      </Box>

      {householdsQuery.isError ? <Alert severity="error">{apiErrorMessage(householdsQuery.error)}</Alert> : null}

      <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', p: 2 }}>
        <Stack spacing={2}>
          <FormControl size="small" sx={{ minWidth: 240 }}>
            <InputLabel id="hh">Haushalt</InputLabel>
            <Select
              labelId="hh"
              label="Haushalt"
              value={householdId}
              onChange={(e) => setHouseholdId(e.target.value === '' ? '' : Number(e.target.value))}
              renderValue={(v) => {
                if (String(v) === '') return defaultHouseholdId ? householdLabel : '—';
                const h = households.find((x) => x.id === Number(v));
                return h?.name ?? `#${v}`;
              }}
            >
              <MenuItem value="">(Standard) {defaultHouseholdId ? householdLabel : '—'}</MenuItem>
              {households.map((h) => (
                <MenuItem key={h.id} value={h.id}>
                  {h.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <Tabs value={enrichTab} onChange={(_, v) => setEnrichTab(v)} aria-label="Enrichment-Quelle">
            <Tab label="Amazon" />
            <Tab label="PayPal" />
          </Tabs>

          {enrichTab === 0 ? (
            <Stack spacing={2}>
              <Alert severity="info">
                <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 0.5 }}>
                  So forderst du deine persönlichen Informationen an
                </Typography>
                <Typography variant="body2" component="div">
                  <div style={{ marginBottom: '0.5rem' }}>
                    Direktlink:{' '}
                    <a
                      href="https://www.amazon.de/hz/privacy-central/data-requests/preview.html"
                      target="_blank"
                      rel="noreferrer"
                    >
                      https://www.amazon.de/hz/privacy-central/data-requests/preview.html
                    </a>
                  </div>
                  <ol style={{ margin: '0 0 0 1.2rem', padding: 0 }}>
                    <li>Gehe zu „Deine Daten anfordern“ bei Amazon.</li>
                    <li>Melde dich in deinem Amazon-Konto an (aus Sicherheitsgründen erforderlich).</li>
                    <li>Wähle die Informationen aus, die du erhalten möchtest.</li>
                    <li>Wähle „Anfrage senden“.</li>
                    <li>Öffne den Bestätigungslink in der E-Mail von Amazon.</li>
                    <li>
                      Wenn der Export bereit ist, lade ihn über den sicheren Link aus der E-Mail herunter und importiere
                      anschließend hier die Datei <b>Order History.csv</b>.
                    </li>
                  </ol>
                </Typography>
              </Alert>

              {amazonUiError ? <Alert severity="error">{amazonUiError}</Alert> : null}

              <Box
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleAmazonFiles(e.dataTransfer.files);
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
                    Amazon · Drag &amp; Drop
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Ordner oder <b>Order History.csv</b> hier ablegen.
                  </Typography>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                    <Button variant="outlined" component="label" disabled={importAmazonMut.isPending}>
                      Datei auswählen
                      <input
                        type="file"
                        hidden
                        accept=".csv,text/csv"
                        onChange={(e) => {
                          const f = e.target.files;
                          if (f && f.length) void handleAmazonFiles(f);
                          e.currentTarget.value = '';
                        }}
                      />
                    </Button>
                    <Button variant="outlined" component="label" disabled={importAmazonMut.isPending}>
                      Ordner auswählen (Chromium)
                      <input
                        type="file"
                        hidden
                        multiple
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore - nonstandard attribute supported by Chromium
                        webkitdirectory="true"
                        onChange={(e) => {
                          const f = e.target.files;
                          if (f && f.length) void handleAmazonFiles(f);
                          e.currentTarget.value = '';
                        }}
                      />
                    </Button>
                  </Stack>
                  {amazonFileName ? (
                    <Typography variant="caption" color="text.secondary">
                      Datei: {amazonFileName}
                    </Typography>
                  ) : null}
                  {amazonParseInfo ? (
                    <Typography variant="caption" color="text.secondary">
                      {amazonParseInfo}
                    </Typography>
                  ) : null}
                </Stack>
              </Box>

              {importAmazonMut.isPending ? (
                <Alert severity="info" icon={<CircularProgress size={18} />}>
                  Import läuft… (Haushalt: {householdLabel})
                </Alert>
              ) : importAmazonMut.isError ? (
                <Alert severity="error">{apiErrorMessage(importAmazonMut.error)}</Alert>
              ) : importAmazonMut.isSuccess ? (
                <Alert severity="success">
                  Import OK. Imported: {importAmazonMut.data.imported} · Matched: {importAmazonMut.data.matched} ·
                  Unmatched: {importAmazonMut.data.unmatched} · Low-confidence:{' '}
                  {importAmazonMut.data.skipped_low_confidence}
                </Alert>
              ) : (
                <Alert severity="warning">
                  Matching über die Amazon <b>Order ID</b> im Verwendungszweck/Gegenpartei; negative Buchungen.
                </Alert>
              )}
            </Stack>
          ) : (
            <Stack spacing={2}>
              <Alert severity="info">
                <Typography variant="body2">
                  PayPal: unter <b>Aktivitäten</b> den gewünschten Zeitraum wählen und als CSV exportieren (deutsche
                  Spalten: Datum, Netto, Transaktionscode, …). Zeilen <b>Bankgutschrift auf PayPal-Konto</b> werden
                  importiert, aber nicht mit der Bank gematcht (nur die eigentliche Zahlung).
                </Typography>
              </Alert>

              {paypalUiError ? <Alert severity="error">{paypalUiError}</Alert> : null}

              <Box
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handlePayPalFiles(e.dataTransfer.files);
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
                    PayPal · Drag &amp; Drop
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    PayPal-Aktivitäts-<b>.csv</b> hier ablegen (auch aus einem Ordner mit mehreren Dateien).
                  </Typography>
                  <Button variant="outlined" component="label" disabled={importPayPalMut.isPending}>
                    CSV auswählen
                    <input
                      type="file"
                      hidden
                      accept=".csv,text/csv"
                      multiple
                      onChange={(e) => {
                        const f = e.target.files;
                        if (f && f.length) void handlePayPalFiles(f);
                        e.currentTarget.value = '';
                      }}
                    />
                  </Button>
                  {paypalFileName ? (
                    <Typography variant="caption" color="text.secondary">
                      Datei: {paypalFileName}
                    </Typography>
                  ) : null}
                  {paypalParseInfo ? (
                    <Typography variant="caption" color="text.secondary">
                      {paypalParseInfo}
                    </Typography>
                  ) : null}
                </Stack>
              </Box>

              {importPayPalMut.isPending ? (
                <Alert severity="info" icon={<CircularProgress size={18} />}>
                  Import läuft… (Haushalt: {householdLabel})
                </Alert>
              ) : importPayPalMut.isError ? (
                <Alert severity="error">{apiErrorMessage(importPayPalMut.error)}</Alert>
              ) : importPayPalMut.isSuccess ? (
                <Alert severity="success">
                  Import OK. Imported: {importPayPalMut.data.imported} · Matched: {importPayPalMut.data.matched} ·
                  Unmatched: {importPayPalMut.data.unmatched} · Ohne Match-Versuch (intern):{' '}
                  {importPayPalMut.data.skipped_internal} · Low-confidence: {importPayPalMut.data.skipped_low_confidence}
                </Alert>
              ) : (
                <Alert severity="warning">
                  Matching: gleicher <b>Betrag</b> wie in der Bankbuchung, „PayPal“ in Verwendungszweck oder Gegenpartei,
                  möglichst nahes <b>Buchungsdatum</b>.
                </Alert>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>

      <ExternalRecordMappingsPanel
        source={mappingsSource}
        householdId={effectiveHouseholdId ?? null}
        refreshKey={mappingsRefreshKey}
      />
    </Stack>
  );
}
