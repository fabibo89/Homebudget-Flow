import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiErrorMessage, fetchUserSettings, patchUserSettings } from '../api/client';

const QUERY_KEY = ['user-settings'] as const;

export default function UserSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchUserSettings,
  });

  const [displayName, setDisplayName] = useState('');
  const [allHouseholdTx, setAllHouseholdTx] = useState(false);

  useEffect(() => {
    if (data) {
      setDisplayName(data.display_name);
      setAllHouseholdTx(data.all_household_transactions);
    }
  }, [data]);

  const mutation = useMutation({
    mutationFn: patchUserSettings,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const dirty =
    data &&
    (displayName !== data.display_name || allHouseholdTx !== data.all_household_transactions);

  const handleSave = () => {
    if (!data) return;
    const body: { display_name?: string; all_household_transactions?: boolean } = {};
    if (displayName !== data.display_name) body.display_name = displayName;
    if (allHouseholdTx !== data.all_household_transactions) body.all_household_transactions = allHouseholdTx;
    if (Object.keys(body).length === 0) return;
    mutation.mutate(body);
  };

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} gutterBottom>
        Konto und Sichtbarkeit
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3, maxWidth: 640 }}>
        Anzeigename und ob du alle Buchungen des Haushalts siehst oder nur die deiner zugewiesenen
        Kontogruppen.
      </Typography>

      {error ? (
        <Alert severity="error" sx={{ mb: 2 }}>
          {apiErrorMessage(error)}
        </Alert>
      ) : null}

      <Card variant="outlined">
        <CardContent>
          {isLoading ? (
            <Box sx={{ py: 2, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            <Stack spacing={3} sx={{ maxWidth: 520 }}>
              <TextField
                label="E-Mail"
                value={data?.email ?? ''}
                disabled
                fullWidth
                helperText="Die E-Mail-Adresse kann hier nicht geändert werden."
              />
              <TextField
                label="Anzeigename"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                fullWidth
                disabled={isFetching}
                inputProps={{ maxLength: 255 }}
              />
              <Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={allHouseholdTx}
                      onChange={(_, v) => setAllHouseholdTx(v)}
                      disabled={isFetching}
                    />
                  }
                  label="Alle Haushalts-Buchungen anzeigen"
                />
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, pl: 0.5 }}>
                  Wenn aktiv: Buchungen aller Kontogruppen im Haushalt. Wenn aus: nur Buchungen aus
                  Kontogruppen, denen du zugeordnet bist.
                </Typography>
              </Box>
              <Box>
                <Button
                  variant="contained"
                  onClick={handleSave}
                  disabled={!dirty || mutation.isPending || isFetching}
                >
                  {mutation.isPending ? 'Speichern…' : 'Speichern'}
                </Button>
              </Box>
              {mutation.isError ? (
                <Alert severity="error">{apiErrorMessage(mutation.error)}</Alert>
              ) : null}
              {mutation.isSuccess && !mutation.isPending ? (
                <Alert severity="success" onClose={() => mutation.reset()}>
                  Einstellungen gespeichert.
                </Alert>
              ) : null}
            </Stack>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
