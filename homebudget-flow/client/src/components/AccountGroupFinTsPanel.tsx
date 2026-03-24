import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Delete as DeleteIcon, Add as AddIcon, Edit as EditIcon } from '@mui/icons-material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiErrorMessage,
  createBankCredential,
  deleteBankCredential,
  fetchBankCredentials,
  submitSyncTransactionTan,
  updateBankCredential,
  type BankCredential,
  type SyncAccountNeedsTan,
} from '../api/client';

const emptyForm = () => ({
  provider: 'comdirect',
  fints_blz: '',
  fints_user: '',
  fints_endpoint: 'https://fints.comdirect.de/fints',
  pin: '',
});

function isNeedsTan(x: unknown): x is SyncAccountNeedsTan {
  return typeof x === 'object' && x !== null && (x as SyncAccountNeedsTan).status === 'needs_transaction_tan';
}

type Props = {
  accountGroupId: number;
  /** z. B. „Haushalt · Kontogruppe“ — nur Anzeige im Titel */
  groupLabel?: string;
  /** Unter „Bankzugang (FinTS)“: flache Liste ohne innere Einrückung/Trennlinie wie in der Einrichtung */
  variant?: 'default' | 'flat';
};

export default function AccountGroupFinTsPanel({ accountGroupId, groupLabel, variant = 'default' }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [testLog, setTestLog] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fintsTanOpen, setFintsTanOpen] = useState(false);
  const [fintsTanValue, setFintsTanValue] = useState('');
  const [fintsTanBusy, setFintsTanBusy] = useState(false);
  const [fintsTanCtx, setFintsTanCtx] = useState<{
    jobId: string;
    mime: string;
    b64: string;
    hint: string | null;
  } | null>(null);
  const isEdit = editingId !== null;

  const qKey = ['bank-credentials'] as const;

  const q = useQuery({
    queryKey: qKey,
    queryFn: () => fetchBankCredentials(),
  });

  function applyCredentialSuccess(c: BankCredential) {
    void qc.invalidateQueries({ queryKey: ['bank-credentials'] });
    void qc.invalidateQueries({ queryKey: ['accounts'] });
    setTestLog(c.fints_log ?? '');
    setSaveSuccess(true);
    setFormError('');
  }

  async function saveCredential() {
    setFormError('');
    if (!form.fints_blz.trim() || !form.fints_user.trim()) {
      setFormError('BLZ und FinTS-Benutzer sind erforderlich.');
      return;
    }
    if (!isEdit && !form.pin.trim()) {
      setFormError('PIN ist beim Anlegen erforderlich (wird verschlüsselt gespeichert).');
      return;
    }
    setSaving(true);
    try {
      let r: unknown;
      if (!isEdit) {
        r = await createBankCredential({
          provision_account_group_id: accountGroupId,
          provider: form.provider,
          fints_blz: form.fints_blz.trim(),
          fints_user: form.fints_user.trim(),
          fints_endpoint: form.fints_endpoint.trim(),
          pin: form.pin.trim(),
        });
      } else {
        if (editingId == null) throw new Error('Kein Zugang gewählt');
        const nextPin = form.pin.trim();
        r = await updateBankCredential(editingId, {
          provision_account_group_id: accountGroupId,
          provider: form.provider,
          fints_blz: form.fints_blz.trim(),
          fints_user: form.fints_user.trim(),
          fints_endpoint: form.fints_endpoint.trim(),
          ...(nextPin ? { pin: nextPin } : {}),
        });
      }

      if (isNeedsTan(r)) {
        setFintsTanCtx({
          jobId: r.job_id,
          mime: r.challenge_mime || 'image/png',
          b64: r.challenge_image_base64,
          hint: r.challenge_hint,
        });
        setFintsTanValue('');
        setFintsTanOpen(true);
        return;
      }
      applyCredentialSuccess(r as BankCredential);
    } catch (e) {
      setFormError(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function submitFintsTan() {
    if (!fintsTanCtx) return;
    const tan = fintsTanValue.trim();
    if (!tan) return;
    setFintsTanBusy(true);
    setFormError('');
    try {
      const sub = await submitSyncTransactionTan(fintsTanCtx.jobId, tan);
      const raw = sub.result;
      if (raw != null && typeof raw === 'object' && raw !== null && 'id' in raw && 'fints_user' in raw) {
        applyCredentialSuccess(raw as BankCredential);
        setFintsTanOpen(false);
        setFintsTanCtx(null);
        setFintsTanValue('');
        return;
      }
      setFormError('Antwort nach TAN ohne Bank-Zugangsdaten — bitte erneut versuchen.');
    } catch (e) {
      setFormError(apiErrorMessage(e));
    } finally {
      setFintsTanBusy(false);
    }
  }

  function closeDialog() {
    setOpen(false);
    setEditingId(null);
    setFormError('');
    setTestLog('');
    setSaveSuccess(false);
    setForm(emptyForm());
  }

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setFormError('');
    setTestLog('');
    setSaveSuccess(false);
    setOpen(true);
  }

  function openEdit(c: BankCredential) {
    setEditingId(c.id);
    setForm({
      provider: c.provider,
      fints_blz: c.fints_blz,
      fints_user: c.fints_user,
      fints_endpoint: c.fints_endpoint,
      pin: '',
    });
    setFormError('');
    setTestLog('');
    setSaveSuccess(false);
    setOpen(true);
  }

  const deleteMut = useMutation({
    mutationFn: deleteBankCredential,
    onSuccess: () => void qc.invalidateQueries({ queryKey: qKey }),
  });

  const rows: BankCredential[] = q.data ?? [];
  const busy = saving || deleteMut.isPending || fintsTanBusy;

  const rootSx =
    variant === 'flat'
      ? {
          py: 2.5,
          borderBottom: 1,
          borderColor: 'divider',
          '&:last-of-type': { borderBottom: 0 },
        }
      : { mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' };

  return (
    <Box sx={rootSx}>
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>
        FinTS-Zugang (Online-Banking){groupLabel ? ` · ${groupLabel}` : ''}
      </Typography>
      {variant === 'flat' ? (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
          <strong>Speichern</strong> führt die FinTS-Prüfung aus; neu erkannte IBANs werden als Bankkonten in <strong>dieser</strong> Kontogruppe angelegt. Pro Login/Provider nur ein Zugang (nutzerweit). Bei PhotoTAN erscheint ein Dialog wie beim Konten-Sync.
        </Typography>
      ) : (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
          Beim <strong>Speichern</strong> prüft der Server FinTS (SEPA-Kontenliste). Zugang wird <strong>nutzerweit</strong>
          gespeichert; fehlende <strong>Bankkonten</strong> (IBANs) werden in <strong>dieser</strong> Kontogruppe angelegt.
          Die Kontogruppe steht am jeweiligen Bankkonto, nicht am FinTS-Zugang. <code>CREDENTIALS_FERNET_KEY</code> in der Server-<code>.env</code>.
        </Typography>
      )}

      <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={openCreate}>
        FinTS-Zugang anlegen
      </Button>

      {q.isError ? (
        <Alert severity="error" sx={{ mt: 1 }}>
          {apiErrorMessage(q.error)}
        </Alert>
      ) : null}

      {q.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={24} />
        </Box>
      ) : (
        <TableContainer component={Paper} elevation={0} sx={{ border: 1, borderColor: 'divider', mt: 1.5 }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Provider</TableCell>
                <TableCell>BLZ</TableCell>
                <TableCell>User</TableCell>
                <TableCell>PIN</TableCell>
                <TableCell align="right">Aktion</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Typography color="text.secondary" variant="body2" sx={{ py: 1 }}>
                      Noch kein FinTS-Zugang für diesen Nutzer.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((c) => (
                  <TableRow key={c.id} hover>
                    <TableCell>{c.provider}</TableCell>
                    <TableCell>{c.fints_blz}</TableCell>
                    <TableCell>{c.fints_user}</TableCell>
                    <TableCell>{c.has_pin ? 'ja' : 'nein'}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center" flexWrap="wrap">
                        <IconButton
                          size="small"
                          color="primary"
                          aria-label="Bearbeiten"
                          disabled={deleteMut.isPending || saving}
                          onClick={() => openEdit(c)}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          size="small"
                          color="error"
                          aria-label="Löschen"
                          disabled={deleteMut.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `FinTS-Zugang „${c.provider}“ (BLZ ${c.fints_blz}) löschen? Verknüpfte Bankkonten behalten ggf. die Zuordnung.`,
                              )
                            )
                              deleteMut.mutate(c.id);
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog open={fintsTanOpen} onClose={() => (!fintsTanBusy ? setFintsTanOpen(false) : undefined)} maxWidth="sm" fullWidth>
        <DialogTitle>PhotoTAN (FinTS-Zugang)</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {fintsTanCtx?.hint ? (
              <Typography variant="body2" color="text.secondary">
                {fintsTanCtx.hint}
              </Typography>
            ) : null}
            {fintsTanCtx?.b64 ? (
              <Box
                component="img"
                src={`data:${fintsTanCtx.mime};base64,${fintsTanCtx.b64}`}
                alt="PhotoTAN"
                sx={{ maxWidth: '100%', height: 'auto', borderRadius: 1 }}
              />
            ) : (
              <Typography variant="body2" color="text.secondary">
                Kein Bild von der Bank — TAN laut App eingeben.
              </Typography>
            )}
            <TextField
              label="TAN"
              value={fintsTanValue}
              onChange={(e) => setFintsTanValue(e.target.value)}
              autoFocus
              fullWidth
              autoComplete="one-time-code"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFintsTanOpen(false)} disabled={fintsTanBusy}>
            Abbrechen
          </Button>
          <Button variant="contained" onClick={() => void submitFintsTan()} disabled={!fintsTanValue.trim() || fintsTanBusy}>
            {fintsTanBusy ? <CircularProgress size={20} /> : 'Absenden'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={open} onClose={() => !busy && closeDialog()} fullWidth maxWidth="md">
        <DialogTitle>{isEdit ? 'FinTS-Zugang bearbeiten' : 'FinTS-Zugang anlegen'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {formError ? (
              <Alert severity="error" onClose={() => setFormError('')}>
                {formError}
              </Alert>
            ) : null}
            {saveSuccess ? (
              <Alert severity="success" onClose={() => setSaveSuccess(false)}>
                Gespeichert. FinTS-Prüfung und Konten-Anlage abgeschlossen.
              </Alert>
            ) : null}

            {!saveSuccess ? (
              <>
                <TextField
                  label="Provider"
                  fullWidth
                  value={form.provider}
                  onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                />
                <TextField
                  label="BLZ"
                  fullWidth
                  required
                  value={form.fints_blz}
                  onChange={(e) => setForm((f) => ({ ...f, fints_blz: e.target.value }))}
                />
                <TextField
                  label="FinTS-Benutzer"
                  fullWidth
                  required
                  value={form.fints_user}
                  onChange={(e) => setForm((f) => ({ ...f, fints_user: e.target.value }))}
                />
                <TextField
                  label="FinTS-Endpoint"
                  fullWidth
                  value={form.fints_endpoint}
                  onChange={(e) => setForm((f) => ({ ...f, fints_endpoint: e.target.value }))}
                />
                <TextField
                  label={isEdit ? 'Neue PIN (leer = unverändert)' : 'PIN'}
                  type="password"
                  fullWidth
                  required={!isEdit}
                  autoComplete="off"
                  value={form.pin}
                  onChange={(e) => setForm((f) => ({ ...f, pin: e.target.value }))}
                />
                <Typography variant="body2" color="text.secondary">
                  Beim Speichern: FinTS-Abfrage und ggf. Anlage mehrerer Bankkonten (je erkannte IBAN). Beim Bearbeiten
                  ohne neue PIN wird die gespeicherte PIN für die Prüfung verwendet.
                </Typography>
              </>
            ) : null}

            <TextField
              label="Ausgabe (Log)"
              fullWidth
              multiline
              minRows={saveSuccess ? 10 : 6}
              value={testLog}
              placeholder={saveSuccess ? '' : 'Nach erfolgreichem Speichern erscheint hier die FinTS-Ausgabe.'}
              InputProps={{
                readOnly: true,
                sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: '0.8rem' },
              }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={saving}>
            {saveSuccess ? 'Schließen' : 'Abbrechen'}
          </Button>
          {!saveSuccess ? (
            <Button
              variant="contained"
              disabled={saving}
              onClick={() => void saveCredential()}
              startIcon={saving ? <CircularProgress size={18} color="inherit" /> : undefined}
            >
              {saving ? 'FinTS prüfen & speichern…' : 'Speichern'}
            </Button>
          ) : null}
        </DialogActions>
      </Dialog>
    </Box>
  );
}
