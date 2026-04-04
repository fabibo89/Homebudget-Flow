import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Collapse,
  FormControl,
  IconButton,
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
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  apiErrorMessage,
  confirmContract,
  fetchAccounts,
  fetchContractTransactions,
  fetchContracts,
  fetchHouseholds,
  ignoreContract,
  recognizeContracts,
  type BankAccount,
  type ContractOut,
} from '../api/client';
import { formatMoney } from '../lib/transactionUi';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';

type TabKey = 'confirmed' | 'suggested' | 'ignored';

export default function Contracts() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const qc = useQueryClient();
  const householdsQ = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });
  const households = householdsQ.data ?? [];
  const [householdId, setHouseholdId] = useState<number | ''>('');

  const hid = householdId === '' ? (households[0]?.id ?? null) : householdId;

  const [tab, setTab] = useState<TabKey>('confirmed');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    setExpandedId(null);
  }, [tab]);

  const contractsQ = useQuery({
    queryKey: ['contracts', hid],
    queryFn: () => fetchContracts(hid as number),
    enabled: hid != null,
  });

  const accountsQ = useQuery({
    queryKey: ['accounts', hid],
    queryFn: () => fetchAccounts(),
    enabled: hid != null,
  });

  const accounts: BankAccount[] = useMemo(() => {
    const all = accountsQ.data ?? [];
    if (hid == null) return [];
    return all.filter((a) => a.household_id === hid);
  }, [accountsQ.data, hid]);

  const rowsByTab = useMemo(() => {
    const all = contractsQ.data ?? [];
    const suggested = all.filter((c) => c.status === 'suggested');
    suggested.sort((a, b) => {
      const ta = a.last_booking ? new Date(a.last_booking).getTime() : Number.NEGATIVE_INFINITY;
      const tb = b.last_booking ? new Date(b.last_booking).getTime() : Number.NEGATIVE_INFINITY;
      return tb - ta;
    });
    return {
      suggested,
      confirmed: all.filter((c) => c.status === 'confirmed'),
      ignored: all.filter((c) => c.status === 'ignored'),
    };
  }, [contractsQ.data]);

  const currentRows = rowsByTab[tab];

  const recognizeMut = useMutation({
    mutationFn: () => recognizeContracts(hid as number, 60),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const confirmMut = useMutation({
    mutationFn: (id: number) => confirmContract(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contracts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
    },
  });

  const ignoreMut = useMutation({
    mutationFn: (id: number) => ignoreContract(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['contracts'] }),
  });

  const txQ = useQuery({
    queryKey: ['contractTx', expandedId, tab],
    queryFn: () => fetchContractTransactions(expandedId!),
    enabled: expandedId != null && (tab === 'confirmed' || tab === 'suggested'),
  });

  function toggleExpand(c: ContractOut) {
    if (c.status !== 'confirmed' && c.status !== 'suggested') return;
    setExpandedId((prev) => (prev === c.id ? null : c.id));
  }

  if (householdsQ.isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (households.length === 0) {
    return <Alert severity="info">Kein Haushalt vorhanden — bitte zuerst einen Haushalt anlegen.</Alert>;
  }

  return (
    <Stack spacing={2} sx={{ width: '100%', maxWidth: '100%', minWidth: 0 }}>
      <Stack spacing={0.75}>
        <Typography variant={isMobile ? 'h6' : 'h5'} fontWeight={700} component="h1">
          Verträge und Abos
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.45 }}>
          Vorschläge aus der Buchungsanalyse; bestätigte Verträge erscheinen in der Buchungsübersicht mit einem
          Symbol. Mit „Neuerkennung“ werden alle sichtbaren Konten erneut ausgewertet.
        </Typography>
      </Stack>

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        flexWrap="wrap"
      >
        <FormControl fullWidth sx={{ minWidth: { sm: 260 }, maxWidth: { sm: 400 } }}>
          <InputLabel id="contracts-hh">Haushalt</InputLabel>
          <Select
            labelId="contracts-hh"
            label="Haushalt"
            value={hid ?? ''}
            onChange={(e) => setHouseholdId(Number(e.target.value))}
          >
            {households.map((h) => (
              <MenuItem key={h.id} value={h.id}>
                {h.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button
          variant="contained"
          fullWidth={isMobile}
          sx={{ flexShrink: 0, py: { xs: 1.25, sm: 1 } }}
          disabled={hid == null || recognizeMut.isPending}
          onClick={() => recognizeMut.mutate()}
        >
          {recognizeMut.isPending ? 'Analyse…' : 'Neuerkennung'}
        </Button>
        {recognizeMut.isSuccess ? (
          <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.4 }}>
            Aktualisiert: {recognizeMut.data.suggestions_updated} Vorschläge,{' '}
            {recognizeMut.data.confirmed_links_touched} Links bestätigt
          </Typography>
        ) : null}
      </Stack>

      {recognizeMut.isError ? <Alert severity="error">{apiErrorMessage(recognizeMut.error)}</Alert> : null}

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{
          borderBottom: 1,
          borderColor: 'divider',
          minHeight: 44,
          '& .MuiTab-root': { minHeight: 44, py: 1 },
        }}
      >
        <Tab label={`Bestätigt (${rowsByTab.confirmed.length})`} value="confirmed" />
        <Tab label={`Vorgeschlagen (${rowsByTab.suggested.length})`} value="suggested" />
        <Tab label={`Ignoriert (${rowsByTab.ignored.length})`} value="ignored" />
      </Tabs>

      {contractsQ.isError ? <Alert severity="error">{apiErrorMessage(contractsQ.error)}</Alert> : null}

      {contractsQ.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={32} />
        </Box>
      ) : isMobile ? (
        <ContractListMobile
          tab={tab}
          rows={currentRows}
          accounts={accounts}
          expandedId={expandedId}
          onToggleExpand={toggleExpand}
          txRows={txQ.data ?? []}
          txLoading={txQ.isLoading}
          txError={txQ.error}
          onConfirm={(id) => confirmMut.mutate(id)}
          onIgnore={(id) => ignoreMut.mutate(id)}
          confirmPending={confirmMut.isPending}
          ignorePending={ignoreMut.isPending}
        />
      ) : (
        <Paper elevation={0} sx={{ border: 1, borderColor: 'divider', overflow: 'hidden' }}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {tab === 'confirmed' || tab === 'suggested' ? <TableCell width={48} /> : null}
                  <TableCell>Gegenpart / Muster</TableCell>
                  <TableCell align="right">Betrag (typ.)</TableCell>
                  <TableCell>Rhythmus</TableCell>
                  <TableCell align="right">Treffer</TableCell>
                  <TableCell>Zeitraum</TableCell>
                  <TableCell align="right">Vertrauen</TableCell>
                  <TableCell>Konto</TableCell>
                  {tab === 'suggested' ? <TableCell align="right">Aktion</TableCell> : null}
                </TableRow>
              </TableHead>
              <TableBody>
                {currentRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={tab === 'ignored' ? 7 : tab === 'suggested' ? 9 : 8}>
                      <Typography variant="body2" color="text.secondary">
                        Keine Einträge in dieser Kategorie.
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  currentRows.map((r) => (
                    <FragmentRowDesktop
                      key={r.id}
                      r={r}
                      tab={tab}
                      expanded={expandedId === r.id}
                      onToggleExpand={() => toggleExpand(r)}
                      accounts={accounts}
                      txRows={expandedId === r.id ? txQ.data ?? [] : []}
                      txLoading={expandedId === r.id && txQ.isLoading}
                      txError={expandedId === r.id ? txQ.error : undefined}
                      onConfirm={() => confirmMut.mutate(r.id)}
                      onIgnore={() => ignoreMut.mutate(r.id)}
                      confirmPending={confirmMut.isPending}
                      ignorePending={ignoreMut.isPending}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}
    </Stack>
  );
}

function ContractListMobile({
  tab,
  rows,
  accounts,
  expandedId,
  onToggleExpand,
  txRows,
  txLoading,
  txError,
  onConfirm,
  onIgnore,
  confirmPending,
  ignorePending,
}: {
  tab: TabKey;
  rows: ContractOut[];
  accounts: BankAccount[];
  expandedId: number | null;
  onToggleExpand: (c: ContractOut) => void;
  txRows: import('../api/client').Transaction[];
  txLoading: boolean;
  txError: unknown;
  onConfirm: (id: number) => void;
  onIgnore: (id: number) => void;
  confirmPending: boolean;
  ignorePending: boolean;
}) {
  if (rows.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Keine Einträge in dieser Kategorie.
        </Typography>
      </Paper>
    );
  }

  return (
    <Stack spacing={1.5} sx={{ width: '100%', minWidth: 0 }}>
      {rows.map((r) => (
        <ContractCardMobile
          key={r.id}
          r={r}
          tab={tab}
          expanded={expandedId === r.id}
          onToggleExpand={() => onToggleExpand(r)}
          accounts={accounts}
          txRows={expandedId === r.id ? txRows : []}
          txLoading={expandedId === r.id && txLoading}
          txError={expandedId === r.id ? txError : undefined}
          onConfirm={() => onConfirm(r.id)}
          onIgnore={() => onIgnore(r.id)}
          confirmPending={confirmPending}
          ignorePending={ignorePending}
        />
      ))}
    </Stack>
  );
}

function ContractCardMobile({
  r,
  tab,
  expanded,
  onToggleExpand,
  accounts,
  txRows,
  txLoading,
  txError,
  onConfirm,
  onIgnore,
  confirmPending,
  ignorePending,
}: {
  r: ContractOut;
  tab: TabKey;
  expanded: boolean;
  onToggleExpand: () => void;
  accounts: BankAccount[];
  txRows: import('../api/client').Transaction[];
  txLoading: boolean;
  txError: unknown;
  onConfirm: () => void;
  onIgnore: () => void;
  confirmPending: boolean;
  ignorePending: boolean;
}) {
  const accName =
    r.bank_account_name ||
    accounts.find((a) => a.id === r.bank_account_id)?.name ||
    `#${r.bank_account_id}`;
  const countLabel =
    r.status === 'confirmed' ? `${r.transaction_count} Buchungen` : `${r.occurrences} Treffer`;
  const canExpand = tab === 'confirmed' || tab === 'suggested';

  return (
    <Card
      elevation={0}
      variant="outlined"
      sx={{
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
        <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ width: '100%', minWidth: 0 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} sx={{ wordBreak: 'break-word' }}>
              {r.label}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
              {accName}
            </Typography>
          </Box>
          {canExpand ? (
            <Tooltip title="Buchungen anzeigen">
              <IconButton
                size="medium"
                onClick={onToggleExpand}
                aria-expanded={expanded}
                aria-label={expanded ? 'Buchungen ausblenden' : 'Buchungen einblenden'}
                sx={{ flexShrink: 0, mt: -0.5 }}
              >
                <ExpandMoreIcon
                  sx={{
                    transform: expanded ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                  }}
                />
              </IconButton>
            </Tooltip>
          ) : null}
        </Stack>

        <Stack spacing={1.25} sx={{ mt: 1.5 }}>
          <MobileKv label="Betrag" value={formatMoney(r.amount_typical, r.currency)} />
          <MobileKv label="Rhythmus" value={r.rhythm_display} valueAlign="left" />
          <MobileKv label="Treffer" value={countLabel} />
          <MobileKv
            label="Zeitraum"
            value={`${r.first_booking ?? '—'} → ${r.last_booking ?? '—'}`}
            valueNoWrap={false}
          />
          <MobileKv label="Vertrauen" value={`${Math.round(r.confidence * 100)} %`} valueAlign="left" />
        </Stack>

        {tab === 'suggested' ? (
          <Stack direction="column" spacing={1} sx={{ mt: 2 }}>
            <Button
              fullWidth
              variant="contained"
              size="medium"
              disabled={confirmPending}
              onClick={onConfirm}
            >
              Bestätigen
            </Button>
            <Button fullWidth variant="outlined" color="inherit" disabled={ignorePending} onClick={onIgnore}>
              Ignorieren
            </Button>
          </Stack>
        ) : null}

        {canExpand ? (
          <Collapse in={expanded} timeout="auto" unmountOnExit>
            <Box
              sx={{
                mt: 2,
                pt: 2,
                borderTop: 1,
                borderColor: 'divider',
                mx: -2,
                px: 2,
                pb: 0,
                bgcolor: 'action.hover',
              }}
            >
              {txLoading ? (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                  <CircularProgress size={28} />
                </Box>
              ) : txError ? (
                <Alert severity="error">{apiErrorMessage(txError)}</Alert>
              ) : (
                <TransactionBookingsTable
                  rows={txRows}
                  accounts={accounts}
                  title={tab === 'suggested' ? 'Erkannte Buchungen (Vorschlag)' : 'Buchungen zu diesem Vertrag'}
                  hideInlineHint
                  categoryColumnAdvanced={false}
                />
              )}
            </Box>
          </Collapse>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MobileKv({
  label,
  value,
  valueAlign = 'right',
  valueNoWrap = true,
}: {
  label: string;
  value: string;
  valueAlign?: 'left' | 'right';
  valueNoWrap?: boolean;
}) {
  return (
    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1.5} sx={{ width: '100%' }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, pt: 0.125 }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        fontWeight={600}
        textAlign={valueAlign}
        sx={{
          flex: 1,
          minWidth: 0,
          wordBreak: valueNoWrap ? 'break-all' : 'break-word',
        }}
      >
        {value}
      </Typography>
    </Stack>
  );
}

function FragmentRowDesktop({
  r,
  tab,
  expanded,
  onToggleExpand,
  accounts,
  txRows,
  txLoading,
  txError,
  onConfirm,
  onIgnore,
  confirmPending,
  ignorePending,
}: {
  r: ContractOut;
  tab: TabKey;
  expanded: boolean;
  onToggleExpand: () => void;
  accounts: BankAccount[];
  txRows: import('../api/client').Transaction[];
  txLoading: boolean;
  txError: unknown;
  onConfirm: () => void;
  onIgnore: () => void;
  confirmPending: boolean;
  ignorePending: boolean;
}) {
  const accName =
    r.bank_account_name ||
    accounts.find((a) => a.id === r.bank_account_id)?.name ||
    `#${r.bank_account_id}`;
  const countLabel =
    r.status === 'confirmed' ? `${r.transaction_count} Buchungen` : `${r.occurrences} Treffer`;

  return (
    <>
      <TableRow hover>
        {tab === 'confirmed' || tab === 'suggested' ? (
          <TableCell>
            <Tooltip title="Alle zugehörigen Buchungen anzeigen">
              <IconButton size="small" onClick={onToggleExpand} aria-expanded={expanded}>
                <ExpandMoreIcon
                  sx={{
                    transform: expanded ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                  }}
                />
              </IconButton>
            </Tooltip>
          </TableCell>
        ) : null}
        <TableCell sx={{ maxWidth: 280 }}>
          <Typography variant="body2" fontWeight={600} noWrap title={r.label}>
            {r.label}
          </Typography>
        </TableCell>
        <TableCell align="right">{formatMoney(r.amount_typical, r.currency)}</TableCell>
        <TableCell>{r.rhythm_display}</TableCell>
        <TableCell align="right">{countLabel}</TableCell>
        <TableCell>
          <Typography variant="body2" color="text.secondary">
            {r.first_booking ?? '—'} → {r.last_booking ?? '—'}
          </Typography>
        </TableCell>
        <TableCell align="right">{Math.round(r.confidence * 100)}&nbsp;%</TableCell>
        <TableCell>
          <Typography variant="body2" noWrap title={accName}>
            {accName}
          </Typography>
        </TableCell>
        {tab === 'suggested' ? (
          <TableCell align="right">
            <Stack direction="row" spacing={1} justifyContent="flex-end">
              <Button size="small" variant="outlined" disabled={confirmPending} onClick={onConfirm}>
                Bestätigen
              </Button>
              <Button size="small" color="inherit" disabled={ignorePending} onClick={onIgnore}>
                Ignorieren
              </Button>
            </Stack>
          </TableCell>
        ) : null}
      </TableRow>
      {(tab === 'confirmed' || tab === 'suggested') && expanded ? (
        <TableRow>
          <TableCell
            colSpan={tab === 'suggested' ? 9 : 8}
            sx={{ borderTop: 0, py: 0, backgroundColor: 'action.hover' }}
          >
            <Collapse in={expanded} unmountOnExit>
              <Box sx={{ py: 2, px: 1 }}>
                {txLoading ? (
                  <CircularProgress size={28} />
                ) : txError ? (
                  <Alert severity="error">{apiErrorMessage(txError)}</Alert>
                ) : (
                  <TransactionBookingsTable
                    rows={txRows}
                    accounts={accounts}
                    title={
                      tab === 'suggested'
                        ? 'Erkannte Buchungen (Vorschlag)'
                        : 'Buchungen zu diesem Vertrag'
                    }
                    hideInlineHint
                    categoryColumnAdvanced={false}
                  />
                )}
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
