import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  Link,
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
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  DeleteOutline as DeleteOutlineIcon,
  EditOutlined as EditOutlinedIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiErrorMessage,
  createAccountGroup,
  createBankAccount,
  createHousehold,
  deleteAccountGroup,
  deleteHousehold,
  fetchAccountGroups,
  fetchAccounts,
  fetchBankCredentials,
  fetchHouseholds,
  updateAccountGroup,
  updateHousehold,
  type BankAccount,
} from '../api/client';

type GroupBankAccountsBlockProps = {
  groupId: number;
  accounts: BankAccount[];
  accountsLoading: boolean;
  accountsError: unknown | null;
};

function GroupBankAccountsBlock({
  groupId,
  accounts,
  accountsLoading,
  accountsError,
}: GroupBankAccountsBlockProps) {
  const rows = accounts.filter((a) => a.account_group_id === groupId);
  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" fontWeight={600} gutterBottom>
        Bankkonten
      </Typography>
      {accountsError ? (
        <Alert severity="error">{apiErrorMessage(accountsError)}</Alert>
      ) : accountsLoading ? (
        <Box sx={{ py: 1 }}>
          <CircularProgress size={22} />
        </Box>
      ) : rows.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Noch kein Konto — <strong>Bankkonto hinzufügen</strong> oder nach einem FinTS-Speichern unter{' '}
          <Link component={RouterLink} to="/settings/fints" underline="hover">
            Bankzugang (FinTS)
          </Link>{' '}
          erscheinen neue Konten hier.
        </Typography>
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ mt: 1 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>IBAN</TableCell>
                <TableCell>Provider</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.name}</TableCell>
                  <TableCell sx={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}>{a.iban}</TableCell>
                  <TableCell>{a.provider}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}

export default function Setup() {
  const qc = useQueryClient();

  const householdsQuery = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });

  const [hhDialogOpen, setHhDialogOpen] = useState(false);
  const [editingHouseholdId, setEditingHouseholdId] = useState<number | null>(null);
  const [hhName, setHhName] = useState('');
  const [hhError, setHhError] = useState('');

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [groupHouseholdId, setGroupHouseholdId] = useState<number | ''>('');
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [groupError, setGroupError] = useState('');

  const [bankDialog, setBankDialog] = useState<{
    open: boolean;
    accountGroupId: number | null;
    groupLabel?: string;
  }>({ open: false, accountGroupId: null });
  const [bankForm, setBankForm] = useState({
    name: '',
    iban: '',
    currency: 'EUR',
    provider: 'comdirect',
    credential_id: '' as '' | number,
  });
  const [bankError, setBankError] = useState('');

  const households = householdsQuery.data ?? [];
  const [expandedHh, setExpandedHh] = useState<number | null>(null);

  const groupsQuery = useQuery({
    queryKey: ['account-groups', expandedHh],
    queryFn: () => fetchAccountGroups(expandedHh!),
    enabled: expandedHh != null,
  });

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  const allAccounts: BankAccount[] = accountsQuery.data ?? [];

  const saveHhMut = useMutation({
    mutationFn: () => {
      const name = hhName.trim();
      if (editingHouseholdId != null) {
        return updateHousehold(editingHouseholdId, { name });
      }
      return createHousehold(name);
    },
    onSuccess: (h) => {
      const expandNewHousehold = editingHouseholdId === null;
      void qc.invalidateQueries({ queryKey: ['households'] });
      setHhDialogOpen(false);
      setEditingHouseholdId(null);
      setHhName('');
      setHhError('');
      if (expandNewHousehold) {
        setExpandedHh(h.id);
      }
    },
    onError: (e) => setHhError(apiErrorMessage(e)),
  });

  const saveGroupMut = useMutation({
    mutationFn: () => {
      const name = groupName.trim();
      const description = groupDesc.trim();
      if (editingGroupId != null) {
        return updateAccountGroup(editingGroupId, { name, description });
      }
      return createAccountGroup({
        household_id: Number(groupHouseholdId),
        name,
        description,
      });
    },
    onSuccess: () => {
      const wasCreate = editingGroupId == null;
      const hhId = groupHouseholdId;
      void qc.invalidateQueries({ queryKey: ['account-groups'] });
      void qc.invalidateQueries({ queryKey: ['households'] });
      setGroupDialogOpen(false);
      setEditingGroupId(null);
      setGroupName('');
      setGroupDesc('');
      setGroupError('');
      if (wasCreate && hhId !== '') {
        setExpandedHh(Number(hhId));
      }
    },
    onError: (e) => setGroupError(apiErrorMessage(e)),
  });

  const deleteHhMut = useMutation({
    mutationFn: deleteHousehold,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['households'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
      void qc.invalidateQueries({ queryKey: ['bank-credentials'] });
      setExpandedHh(null);
    },
    onError: (e) => window.alert(apiErrorMessage(e)),
  });

  const deleteGroupMut = useMutation({
    mutationFn: deleteAccountGroup,
    onSuccess: () => {
      if (expandedHh != null) {
        void qc.invalidateQueries({ queryKey: ['account-groups', expandedHh] });
      }
      void qc.invalidateQueries({ queryKey: ['households'] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
      void qc.invalidateQueries({ queryKey: ['bank-credentials'] });
    },
    onError: (e) => window.alert(apiErrorMessage(e)),
  });

  const createBankMut = useMutation({
    mutationFn: () => {
      const gid = bankDialog.accountGroupId;
      if (gid == null) throw new Error('Keine Kontogruppe');
      if (bankForm.credential_id === '') {
        throw new Error('Bitte einen FinTS-Zugang wählen.');
      }
      return createBankAccount({
        account_group_id: gid,
        name: bankForm.name.trim(),
        iban: bankForm.iban.replace(/\s/g, ''),
        currency: bankForm.currency,
        provider: bankForm.provider,
        credential_id: bankForm.credential_id,
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
      void qc.invalidateQueries({ queryKey: ['households'] });
      void qc.invalidateQueries({ queryKey: ['bank-credentials'] });
      setBankDialog({ open: false, accountGroupId: null });
      setBankError('');
      setBankForm({
        name: '',
        iban: '',
        currency: 'EUR',
        provider: 'comdirect',
        credential_id: '',
      });
    },
    onError: (e) => setBankError(apiErrorMessage(e)),
  });

  const bankCredsForDialog = useQuery({
    queryKey: ['bank-credentials'],
    queryFn: () => fetchBankCredentials(),
    enabled: bankDialog.open && bankDialog.accountGroupId != null,
  });
  const creds = bankCredsForDialog.data ?? [];
  const groupList = groupsQuery.data ?? [];

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Einrichtung
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Haushalt → Kontogruppe → <strong>FinTS-Zugang</strong> (nur Login/PIN). Beim Speichern legt das Backend die
          erkannten <strong>Bankkonten</strong> (IBANs) an — nicht am Zugang gespeichert. Weitere Konten bei gleicher
          Anmeldung über <strong>Bankkonto hinzufügen</strong>. Anschließend in der Übersicht synchronisieren.
        </Typography>
      </Box>

      <Box>
        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditingHouseholdId(null);
              setHhName('');
              setHhError('');
              setHhDialogOpen(true);
            }}
          >
            Neuer Haushalt
          </Button>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            disabled={households.length === 0}
            onClick={() => {
              setEditingGroupId(null);
              setGroupHouseholdId(households[0]?.id ?? '');
              setGroupName('');
              setGroupDesc('');
              setGroupError('');
              setGroupDialogOpen(true);
            }}
          >
            Neue Kontogruppe
          </Button>
        </Stack>

        {householdsQuery.isError ? <Alert severity="error">{apiErrorMessage(householdsQuery.error)}</Alert> : null}

        {householdsQuery.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : households.length === 0 ? (
          <Alert severity="info">Lege zuerst einen Haushalt an (z. B. „Familie“).</Alert>
        ) : (
          <Stack spacing={2}>
            {households.map((h) => (
              <Card key={h.id} elevation={0} sx={{ border: 1, borderColor: 'divider' }}>
                <CardContent>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ sm: 'center' }}>
                    <Box>
                      <Typography variant="h6" fontWeight={700}>
                        {h.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        ID {h.id}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                      <Button
                        size="small"
                        variant={expandedHh === h.id ? 'contained' : 'outlined'}
                        onClick={() => setExpandedHh(expandedHh === h.id ? null : h.id)}
                      >
                        {expandedHh === h.id ? 'Kontogruppen ausblenden' : 'Kontogruppen anzeigen'}
                      </Button>
                      <Tooltip title="Haushalt umbenennen">
                        <span>
                          <IconButton
                            size="small"
                            color="primary"
                            aria-label="Haushalt bearbeiten"
                            disabled={deleteHhMut.isPending || deleteGroupMut.isPending || saveHhMut.isPending}
                            onClick={() => {
                              setEditingHouseholdId(h.id);
                              setHhName(h.name);
                              setHhError('');
                              setHhDialogOpen(true);
                            }}
                          >
                            <EditOutlinedIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Haushalt löschen (nur Besitzer; Kontogruppen und zugehörige Daten werden mit entfernt)">
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            aria-label="Haushalt löschen"
                            disabled={deleteHhMut.isPending || deleteGroupMut.isPending}
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Haushalt „${h.name}“ mitsamt allen Kontogruppen, FinTS-Zugängen und Bankkonten wirklich löschen? Dies kann nicht rückgängig gemacht werden.`,
                                )
                              ) {
                                deleteHhMut.mutate(h.id);
                              }
                            }}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </Stack>

                  {expandedHh === h.id ? (
                    <Box sx={{ mt: 2 }}>
                      {groupsQuery.isLoading ? (
                        <CircularProgress size={28} />
                      ) : groupsQuery.isError ? (
                        <Alert severity="error">{apiErrorMessage(groupsQuery.error)}</Alert>
                      ) : groupList.length === 0 ? (
                        <Alert severity="warning">Noch keine Kontogruppe – „Neue Kontogruppe“ wählen und Haushalt zuordnen.</Alert>
                      ) : (
                        <Stack spacing={1.5}>
                          {groupList.map((g) => (
                            <Paper key={g.id} variant="outlined" sx={{ p: 2 }}>
                              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ sm: 'center' }}>
                                <Box>
                                  <Typography fontWeight={600}>{g.name}</Typography>
                                  {g.description ? (
                                    <Typography variant="body2" color="text.secondary">
                                      {g.description}
                                    </Typography>
                                  ) : null}
                                  <Typography variant="caption" color="text.secondary">
                                    Gruppe #{g.id}
                                  </Typography>
                                </Box>
                                <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                                  <Button
                                    size="small"
                                    variant="contained"
                                    onClick={() => {
                                      setBankDialog({ open: true, accountGroupId: g.id, groupLabel: g.name });
                                      setBankError('');
                                    }}
                                  >
                                    Bankkonto hinzufügen
                                  </Button>
                                  <Tooltip title="Kontogruppe bearbeiten (Name & Beschreibung)">
                                    <span>
                                      <IconButton
                                        size="small"
                                        color="primary"
                                        aria-label="Kontogruppe bearbeiten"
                                        disabled={
                                          deleteGroupMut.isPending ||
                                          deleteHhMut.isPending ||
                                          saveGroupMut.isPending
                                        }
                                        onClick={() => {
                                          setEditingGroupId(g.id);
                                          setGroupHouseholdId(g.household_id);
                                          setGroupName(g.name);
                                          setGroupDesc(g.description ?? '');
                                          setGroupError('');
                                          setGroupDialogOpen(true);
                                        }}
                                      >
                                        <EditOutlinedIcon fontSize="small" />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                  <Tooltip title="Kontogruppe löschen (Bankkonten und zugehörige Daten dieser Gruppe werden mit entfernt)">
                                    <span>
                                      <IconButton
                                        size="small"
                                        color="error"
                                        aria-label="Kontogruppe löschen"
                                        disabled={deleteGroupMut.isPending || deleteHhMut.isPending}
                                        onClick={() => {
                                          if (
                                            window.confirm(
                                              `Kontogruppe „${g.name}“ mitsamt Bankkonten und Sync-Daten wirklich löschen?`,
                                            )
                                          ) {
                                            deleteGroupMut.mutate(g.id);
                                          }
                                        }}
                                      >
                                        <DeleteOutlineIcon fontSize="small" />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                </Stack>
                              </Stack>
                              <GroupBankAccountsBlock
                                groupId={g.id}
                                accounts={allAccounts}
                                accountsLoading={accountsQuery.isLoading}
                                accountsError={accountsQuery.isError ? accountsQuery.error : null}
                              />
                            </Paper>
                          ))}
                        </Stack>
                      )}
                    </Box>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </Stack>
        )}
      </Box>

      {/* Haushalt */}
      <Dialog
        open={hhDialogOpen}
        onClose={() => !saveHhMut.isPending && setHhDialogOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{editingHouseholdId != null ? 'Haushalt bearbeiten' : 'Haushalt anlegen'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {hhError ? <Alert severity="error">{hhError}</Alert> : null}
            <TextField
              autoFocus
              label="Name"
              fullWidth
              value={hhName}
              onChange={(e) => setHhName(e.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setHhDialogOpen(false);
              setEditingHouseholdId(null);
            }}
            disabled={saveHhMut.isPending}
          >
            Abbrechen
          </Button>
          <Button
            variant="contained"
            disabled={saveHhMut.isPending || !hhName.trim()}
            onClick={() => {
              setHhError('');
              saveHhMut.mutate();
            }}
          >
            {saveHhMut.isPending ? '…' : editingHouseholdId != null ? 'Speichern' : 'Anlegen'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Kontogruppe */}
      <Dialog
        open={groupDialogOpen}
        onClose={() => !saveGroupMut.isPending && setGroupDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{editingGroupId != null ? 'Kontogruppe bearbeiten' : 'Kontogruppe anlegen'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {groupError ? <Alert severity="error">{groupError}</Alert> : null}
            <FormControl fullWidth disabled={editingGroupId != null}>
              <InputLabel id="ghh">Haushalt</InputLabel>
              <Select
                labelId="ghh"
                label="Haushalt"
                value={groupHouseholdId === '' ? '' : groupHouseholdId}
                onChange={(e) => setGroupHouseholdId(e.target.value as number)}
              >
                {households.map((h) => (
                  <MenuItem key={h.id} value={h.id}>
                    {h.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {editingGroupId != null ? (
              <Typography variant="caption" color="text.secondary">
                Der Haushalt kann bei einer bestehenden Kontogruppe nicht geändert werden.
              </Typography>
            ) : null}
            <TextField label="Name" fullWidth value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            <TextField
              label="Beschreibung (optional)"
              fullWidth
              multiline
              minRows={2}
              value={groupDesc}
              onChange={(e) => setGroupDesc(e.target.value)}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setGroupDialogOpen(false);
              setEditingGroupId(null);
            }}
            disabled={saveGroupMut.isPending}
          >
            Abbrechen
          </Button>
          <Button
            variant="contained"
            disabled={
              saveGroupMut.isPending ||
              !groupName.trim() ||
              (editingGroupId === null && groupHouseholdId === '')
            }
            onClick={() => {
              setGroupError('');
              saveGroupMut.mutate();
            }}
          >
            {saveGroupMut.isPending ? '…' : editingGroupId != null ? 'Speichern' : 'Anlegen'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bankkonto */}
      <Dialog open={bankDialog.open} onClose={() => !createBankMut.isPending && setBankDialog({ open: false, accountGroupId: null })} fullWidth maxWidth="sm">
        <DialogTitle>Bankkonto anlegen</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {bankError ? <Alert severity="error">{bankError}</Alert> : null}
            <Typography variant="body2" color="text.secondary">
              {bankDialog.groupLabel
                ? `Kontogruppe: ${bankDialog.groupLabel} (#${bankDialog.accountGroupId})`
                : bankDialog.accountGroupId != null
                  ? `Kontogruppe #${bankDialog.accountGroupId}`
                  : ''}
            </Typography>
            <TextField
              label="Anzeigename"
              fullWidth
              required
              value={bankForm.name}
              onChange={(e) => setBankForm((f) => ({ ...f, name: e.target.value }))}
            />
            <TextField
              label="IBAN"
              fullWidth
              required
              helperText="Ohne Leerzeichen; Kennung für FinTS-Sync und eindeutig pro Provider."
              value={bankForm.iban}
              onChange={(e) => setBankForm((f) => ({ ...f, iban: e.target.value }))}
            />
            <TextField
              label="Währung"
              fullWidth
              value={bankForm.currency}
              onChange={(e) => setBankForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
            <TextField
              label="Provider"
              fullWidth
              value={bankForm.provider}
              onChange={(e) => setBankForm((f) => ({ ...f, provider: e.target.value }))}
            />
            <FormControl fullWidth required>
              <InputLabel id="cred">FinTS-Zugang</InputLabel>
              <Select
                labelId="cred"
                label="FinTS-Zugang"
                value={bankForm.credential_id === '' ? '' : bankForm.credential_id}
                onChange={(e) => {
                  const v = e.target.value;
                  setBankForm((f) => ({ ...f, credential_id: v === '' ? '' : Number(v) }));
                }}
              >
                {creds.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.provider} · BLZ {c.fints_blz}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {!bankCredsForDialog.isLoading && creds.length === 0 ? (
              <Alert severity="warning">
                Zuerst unter dieser Kontogruppe einen FinTS-Zugang anlegen (oder in den Einstellungen), dann kann das
                Bankkonto verknüpft werden.
              </Alert>
            ) : null}
            {bankCredsForDialog.isError ? (
              <Alert severity="warning">FinTS-Zugänge konnten nicht geladen werden.</Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBankDialog({ open: false, accountGroupId: null })} disabled={createBankMut.isPending}>
            Abbrechen
          </Button>
          <Button
            variant="contained"
            disabled={
              createBankMut.isPending ||
              !bankForm.name.trim() ||
              !bankForm.iban.trim() ||
              bankForm.credential_id === '' ||
              creds.length === 0
            }
            onClick={() => {
              setBankError('');
              createBankMut.mutate();
            }}
          >
            {createBankMut.isPending ? '…' : 'Anlegen'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
