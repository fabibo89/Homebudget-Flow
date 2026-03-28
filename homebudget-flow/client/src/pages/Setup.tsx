import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormGroup,
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
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  Add as AddIcon,
  DeleteOutline as DeleteOutlineIcon,
  EditOutlined as EditOutlinedIcon,
  ExpandMore as ExpandMoreIcon,
  PersonAddAlt1 as PersonAddAlt1Icon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  acceptHouseholdInvitation,
  apiErrorMessage,
  createAccountGroup,
  createBankAccount,
  createHousehold,
  deleteAccountGroup,
  deleteHousehold,
  deleteHouseholdInvitation,
  fetchAccountGroupMembers,
  fetchAccountGroups,
  fetchAccounts,
  fetchBankCredentials,
  fetchCurrentUser,
  fetchHouseholdMembers,
  fetchHouseholds,
  fetchIncomingHouseholdInvitations,
  fetchOutgoingHouseholdInvitations,
  inviteHouseholdMember,
  putAccountGroupMembers,
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

type AccountGroupSharingBlockProps = {
  groupId: number;
  householdId: number;
};

function AccountGroupSharingBlock({ groupId, householdId }: AccountGroupSharingBlockProps) {
  const qc = useQueryClient();
  const membersQ = useQuery({
    queryKey: ['household-members', householdId],
    queryFn: () => fetchHouseholdMembers(householdId),
  });
  const agMembersQ = useQuery({
    queryKey: ['account-group-members', groupId],
    queryFn: () => fetchAccountGroupMembers(groupId),
  });
  const [draft, setDraft] = useState<number[] | null>(null);

  useEffect(() => {
    if (agMembersQ.data) {
      setDraft(agMembersQ.data.map((m) => m.user_id));
    }
  }, [agMembersQ.data]);

  const putMut = useMutation({
    mutationFn: (userIds: number[]) => putAccountGroupMembers(groupId, userIds),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['account-group-members', groupId] });
      void qc.invalidateQueries({ queryKey: ['accounts'] });
      void qc.invalidateQueries({ queryKey: ['transactions'] });
      void qc.invalidateQueries({ queryKey: ['sync-overview'] });
    },
  });

  const canSave = useMemo(() => {
    if (draft == null || !agMembersQ.data) return false;
    const a = [...draft].sort((x, y) => x - y).join(',');
    const b = agMembersQ.data
      .map((m) => m.user_id)
      .sort((x, y) => x - y)
      .join(',');
    return a !== b;
  }, [draft, agMembersQ.data]);

  if (agMembersQ.isError) {
    return null;
  }
  if (membersQ.isLoading || agMembersQ.isLoading || !draft) {
    return (
      <Box sx={{ mt: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }
  if (membersQ.isError) {
    return null;
  }

  const members = membersQ.data ?? [];
  const toggle = (uid: number) => {
    setDraft((prev) => {
      const p = prev ?? [];
      if (p.includes(uid)) {
        if (p.length <= 1) return p;
        return p.filter((x) => x !== uid);
      }
      return [...p, uid];
    });
  };

  return (
    <Box sx={{ mt: 2 }}>
      <Typography variant="subtitle2" fontWeight={600} gutterBottom>
        Zugriff (Haushaltsmitglieder)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Wer diese Kontogruppe und die zugehörigen Bankkonten/Buchungen sieht (wenn unter Profil nicht „alle
        Haushaltsbuchungen“ aktiv ist).
      </Typography>
      <FormGroup>
        {members.map((m) => (
          <FormControlLabel
            key={m.user_id}
            control={
              <Checkbox
                checked={draft.includes(m.user_id)}
                onChange={() => toggle(m.user_id)}
                disabled={putMut.isPending || (draft.includes(m.user_id) && draft.length === 1)}
              />
            }
            label={`${m.display_name || m.email} (${m.email})${m.role === 'owner' ? ' · Besitzer' : ''}`}
          />
        ))}
      </FormGroup>
      <Button
        size="small"
        variant="outlined"
        sx={{ mt: 1 }}
        disabled={!canSave || putMut.isPending || draft.length < 1}
        onClick={() => {
          if (draft.length >= 1) putMut.mutate(draft);
        }}
      >
        {putMut.isPending ? 'Speichern…' : 'Zugriff speichern'}
      </Button>
      {putMut.isError ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {apiErrorMessage(putMut.error)}
        </Alert>
      ) : null}
    </Box>
  );
}

function GroupBankAccountsBlock({
  groupId,
  accounts,
  accountsLoading,
  accountsError,
}: GroupBankAccountsBlockProps) {
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));
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
        <TableContainer component={Paper} variant="outlined" sx={{ mt: 1, overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: isXs ? 520 : 640 }}>
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
  const theme = useTheme();
  const isXs = useMediaQuery(theme.breakpoints.down('sm'));

  const householdsQuery = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });

  const incomingInvQuery = useQuery({
    queryKey: ['household-invitations-incoming'],
    queryFn: fetchIncomingHouseholdInvitations,
  });

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
  const [groupMemberUserIds, setGroupMemberUserIds] = useState<number[]>([]);

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
  const [inviteEmailByHh, setInviteEmailByHh] = useState<Record<number, string>>({});
  const [inviteErrorByHh, setInviteErrorByHh] = useState<Record<number, string>>({});

  const groupQueries = useQueries({
    queries: households.map((h) => ({
      queryKey: ['account-groups', h.id],
      queryFn: () => fetchAccountGroups(h.id),
      enabled: householdsQuery.isSuccess && households.length > 0,
    })),
  });

  const outgoingInvQueries = useQueries({
    queries: households.map((h) => ({
      queryKey: ['household-invitations-out', h.id],
      queryFn: () => fetchOutgoingHouseholdInvitations(h.id),
      enabled: householdsQuery.isSuccess && households.length > 0 && h.my_role === 'owner',
    })),
  });

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });
  const allAccounts: BankAccount[] = accountsQuery.data ?? [];

  const meQuery = useQuery({ queryKey: ['me'], queryFn: fetchCurrentUser });

  const householdMembersForDialog = useQuery({
    queryKey: ['household-members', groupHouseholdId],
    queryFn: () => fetchHouseholdMembers(Number(groupHouseholdId)),
    enabled: groupDialogOpen && groupHouseholdId !== '' && editingGroupId === null,
  });

  useEffect(() => {
    if (!groupDialogOpen || editingGroupId != null) return;
    const myId = meQuery.data?.id;
    const mem = householdMembersForDialog.data;
    if (!myId || !mem?.length) return;
    setGroupMemberUserIds((prev) => {
      if (prev.length > 0) return prev;
      return mem.some((m) => m.user_id === myId) ? [myId] : [];
    });
  }, [groupDialogOpen, editingGroupId, meQuery.data?.id, householdMembersForDialog.data]);

  const saveHhMut = useMutation({
    mutationFn: () => {
      const name = hhName.trim();
      if (editingHouseholdId != null) {
        return updateHousehold(editingHouseholdId, { name });
      }
      return createHousehold(name);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['households'] });
      setHhDialogOpen(false);
      setEditingHouseholdId(null);
      setHhName('');
      setHhError('');
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
      if (groupMemberUserIds.length < 1) {
        throw new Error('Mindestens eine Person muss Zugriff auf die Kontogruppe haben.');
      }
      return createAccountGroup({
        household_id: Number(groupHouseholdId),
        name,
        description,
        member_user_ids: groupMemberUserIds,
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
      setGroupMemberUserIds([]);
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
    },
    onError: (e) => window.alert(apiErrorMessage(e)),
  });

  const deleteGroupMut = useMutation({
    mutationFn: deleteAccountGroup,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['account-groups'] });
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

  const acceptInvMut = useMutation({
    mutationFn: acceptHouseholdInvitation,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['households'] });
      void qc.invalidateQueries({ queryKey: ['household-invitations-incoming'] });
      void qc.invalidateQueries({ queryKey: ['household-invitations-out'] });
      void qc.invalidateQueries({ queryKey: ['account-groups'] });
    },
  });

  const deleteInvMut = useMutation({
    mutationFn: deleteHouseholdInvitation,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['household-invitations-incoming'] });
      void qc.invalidateQueries({ queryKey: ['household-invitations-out'] });
    },
  });

  const inviteMut = useMutation({
    mutationFn: ({ householdId, email }: { householdId: number; email: string }) =>
      inviteHouseholdMember(householdId, email),
    onSuccess: (_, v) => {
      void qc.invalidateQueries({ queryKey: ['household-invitations-out', v.householdId] });
      setInviteEmailByHh((prev) => ({ ...prev, [v.householdId]: '' }));
      setInviteErrorByHh((prev) => {
        const n = { ...prev };
        delete n[v.householdId];
        return n;
      });
    },
    onError: (e, v) =>
      setInviteErrorByHh((prev) => ({ ...prev, [v.householdId]: apiErrorMessage(e) })),
  });

  const bankCredsForDialog = useQuery({
    queryKey: ['bank-credentials'],
    queryFn: () => fetchBankCredentials(),
    enabled: bankDialog.open && bankDialog.accountGroupId != null,
  });
  const creds = bankCredsForDialog.data ?? [];

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

      {incomingInvQuery.isError ? (
        <Alert severity="warning">{apiErrorMessage(incomingInvQuery.error)}</Alert>
      ) : null}
      {(incomingInvQuery.data ?? []).length > 0 ? (
        <Stack spacing={1.5}>
          {(incomingInvQuery.data ?? []).map((inv) => (
            <Alert
              key={inv.id}
              severity="info"
              action={
                <Stack direction="row" spacing={1} alignItems="center">
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => acceptInvMut.mutate(inv.id)}
                    disabled={acceptInvMut.isPending}
                  >
                    Annehmen
                  </Button>
                  <Button
                    size="small"
                    onClick={() => deleteInvMut.mutate(inv.id)}
                    disabled={deleteInvMut.isPending}
                  >
                    Ablehnen
                  </Button>
                </Stack>
              }
            >
              <strong>{inv.inviter_email}</strong> lädt dich in den Haushalt „<strong>{inv.household_name}</strong>“
              ein.
            </Alert>
          ))}
        </Stack>
      ) : null}

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
              setGroupMemberUserIds([]);
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
            {households.map((h, i) => {
              const gq = groupQueries[i];
              const groupList = gq?.data ?? [];
              const oq = outgoingInvQueries[i];
              return (
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
                      <Tooltip
                        title={
                          h.my_role === 'owner'
                            ? 'Haushalt löschen (Kontogruppen und zugehörige Daten werden mit entfernt)'
                            : 'Nur der Haushaltsbesitzer kann den Haushalt löschen'
                        }
                      >
                        <span>
                          <IconButton
                            size="small"
                            color="error"
                            aria-label="Haushalt löschen"
                            disabled={
                              deleteHhMut.isPending || deleteGroupMut.isPending || h.my_role !== 'owner'
                            }
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

                    <Box sx={{ mt: 2 }}>
                      {h.my_role === 'owner' ? (
                        <Accordion
                          disableGutters
                          elevation={0}
                          defaultExpanded={false}
                          sx={{
                            mb: 2,
                            border: 1,
                            borderColor: 'divider',
                            borderRadius: 1,
                            '&:before': { display: 'none' },
                          }}
                        >
                          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 2 }}>
                            <Typography variant="subtitle2" fontWeight={600}>
                              Mitglieder einladen
                            </Typography>
                          </AccordionSummary>
                          <AccordionDetails sx={{ px: 2, pt: 0, pb: 2 }}>
                            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                              Nur für registrierte Nutzer: gleiche E-Mail wie beim Login. Die Person sieht die Einladung
                              hier unter Einrichtung, sobald sie angemeldet ist.
                            </Typography>
                            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-start' }}>
                              <TextField
                                size="small"
                                label="E-Mail-Adresse"
                                type="email"
                                fullWidth
                                value={inviteEmailByHh[h.id] ?? ''}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setInviteEmailByHh((prev) => ({ ...prev, [h.id]: v }));
                                  setInviteErrorByHh((prev) => {
                                    const n = { ...prev };
                                    delete n[h.id];
                                    return n;
                                  });
                                }}
                                disabled={inviteMut.isPending}
                              />
                              <Button
                                variant="outlined"
                                startIcon={<PersonAddAlt1Icon />}
                                disabled={
                                  inviteMut.isPending || !(inviteEmailByHh[h.id] ?? '').trim()
                                }
                                onClick={() => {
                                  setInviteErrorByHh((prev) => {
                                    const n = { ...prev };
                                    delete n[h.id];
                                    return n;
                                  });
                                  inviteMut.mutate({
                                    householdId: h.id,
                                    email: (inviteEmailByHh[h.id] ?? '').trim(),
                                  });
                                }}
                                sx={{ flexShrink: 0 }}
                              >
                                Einladen
                              </Button>
                            </Stack>
                            {inviteErrorByHh[h.id] ? (
                              <Alert severity="error" sx={{ mt: 1 }}>
                                {inviteErrorByHh[h.id]}
                              </Alert>
                            ) : null}
                            {oq?.isFetching ? (
                              <Box sx={{ mt: 1 }}>
                                <CircularProgress size={22} />
                              </Box>
                            ) : null}
                            {(oq?.data ?? []).length > 0 ? (
                              <Box sx={{ mt: 2 }}>
                                <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
                                  Ausstehende Einladungen
                                </Typography>
                                <Stack spacing={0.75}>
                                  {(oq?.data ?? []).map((o) => (
                                    <Stack
                                      key={o.id}
                                      direction="row"
                                      alignItems="center"
                                      justifyContent="space-between"
                                      flexWrap="wrap"
                                      useFlexGap
                                      gap={1}
                                    >
                                      <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                                        {o.invitee_email}
                                      </Typography>
                                      <Button
                                        size="small"
                                        color="inherit"
                                        onClick={() => deleteInvMut.mutate(o.id)}
                                        disabled={deleteInvMut.isPending}
                                      >
                                        Zurücknehmen
                                      </Button>
                                    </Stack>
                                  ))}
                                </Stack>
                              </Box>
                            ) : null}
                          </AccordionDetails>
                        </Accordion>
                      ) : null}
                      {gq?.isLoading ? (
                        <CircularProgress size={28} />
                      ) : gq?.isError ? (
                        <Alert severity="error">{apiErrorMessage(gq.error)}</Alert>
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
                                          setGroupMemberUserIds([]);
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
                              <AccountGroupSharingBlock groupId={g.id} householdId={h.id} />
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
                </CardContent>
              </Card>
            );
            })}
          </Stack>
        )}
      </Box>

      {/* Haushalt */}
      <Dialog
        open={hhDialogOpen}
        onClose={() => !saveHhMut.isPending && setHhDialogOpen(false)}
        fullWidth
        maxWidth="xs"
        fullScreen={isXs}
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
        fullScreen={isXs}
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
                onChange={(e) => {
                  setGroupHouseholdId(e.target.value as number);
                  setGroupMemberUserIds([]);
                }}
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
            {editingGroupId === null && groupHouseholdId !== '' ? (
              <Box>
                <Typography variant="subtitle2" fontWeight={600} gutterBottom>
                  Zugriff
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Wer diese Kontogruppe nutzen darf (sichtbar mit Profil-Einstellung „nur freigegebene Kontogruppen“).
                </Typography>
                {householdMembersForDialog.isLoading ? (
                  <CircularProgress size={22} />
                ) : (
                  <FormGroup>
                    {(householdMembersForDialog.data ?? []).map((m) => (
                      <FormControlLabel
                        key={m.user_id}
                        control={
                          <Checkbox
                            checked={groupMemberUserIds.includes(m.user_id)}
                            onChange={() => {
                              setGroupMemberUserIds((prev) => {
                                if (prev.includes(m.user_id)) {
                                  if (prev.length <= 1) return prev;
                                  return prev.filter((x) => x !== m.user_id);
                                }
                                return [...prev, m.user_id];
                              });
                            }}
                            disabled={
                              saveGroupMut.isPending ||
                              (groupMemberUserIds.includes(m.user_id) && groupMemberUserIds.length === 1)
                            }
                          />
                        }
                        label={`${m.display_name || m.email} (${m.email})${m.role === 'owner' ? ' · Besitzer' : ''}`}
                      />
                    ))}
                  </FormGroup>
                )}
              </Box>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setGroupDialogOpen(false);
              setEditingGroupId(null);
              setGroupMemberUserIds([]);
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
              (editingGroupId === null &&
                (groupHouseholdId === '' || groupMemberUserIds.length < 1))
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
      <Dialog
        open={bankDialog.open}
        onClose={() => !createBankMut.isPending && setBankDialog({ open: false, accountGroupId: null })}
        fullWidth
        maxWidth="sm"
        fullScreen={isXs}
      >
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
