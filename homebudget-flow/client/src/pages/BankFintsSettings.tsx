import { useMemo } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, CircularProgress, Link, Stack, Typography } from '@mui/material';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiErrorMessage, fetchAccountGroups, fetchHouseholds } from '../api/client';
import AccountGroupFinTsPanel from '../components/AccountGroupFinTsPanel';

export default function BankFintsSettings() {
  const householdsQuery = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });
  const households = householdsQuery.data ?? [];

  const groupQueries = useQueries({
    queries: households.map((h) => ({
      queryKey: ['account-groups', h.id],
      queryFn: () => fetchAccountGroups(h.id),
      enabled: householdsQuery.isSuccess,
    })),
  });

  const flatGroups = useMemo(
    () =>
      households.flatMap((h, hi) => {
        const list = groupQueries[hi]?.data ?? [];
        return list
          .filter((g) => g.current_user_is_member)
          .map((g) => ({
            householdName: h.name,
            group: g,
          }));
      }),
    [households, groupQueries],
  );

  /** Stabile Reihenfolge: die erste Gruppe zeigt die nutzerweite Zugangs-Tabelle genau einmal. */
  const sortedFlatGroups = useMemo(
    () =>
      [...flatGroups].sort((a, b) => {
        const h = a.householdName.localeCompare(b.householdName, 'de');
        if (h !== 0) return h;
        return a.group.name.localeCompare(b.group.name, 'de');
      }),
    [flatGroups],
  );

  const provisionGroupOptions = useMemo(
    () =>
      flatGroups.map(({ householdName, group: g }) => ({
        id: g.id,
        label: `${householdName} · ${g.name}`,
      })),
    [flatGroups],
  );

  const loading = householdsQuery.isLoading || groupQueries.some((q) => q.isLoading);
  const firstGroupError = groupQueries.find((q) => q.isError);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Bankzugang (FinTS)
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Nur Online-Banking-Zugang (Login/PIN), nutzerweit. Beim Anlegen oder Bearbeiten eines Zugangs wählst du im
          Dialog die <strong>Kontogruppe für neue Bankkonten</strong> (erkannte IBANs). Die Kontenliste je Gruppe siehst
          du unter{' '}
          <Link component={RouterLink} to="/settings/setup" underline="hover">
            Einrichtung
          </Link>{' '}
          und unter{' '}
          <Link component={RouterLink} to="/settings/accounts" underline="hover">
            Bankkonten
          </Link>
          .
        </Typography>
      </Box>

      {householdsQuery.isError ? (
        <Alert severity="error">{apiErrorMessage(householdsQuery.error)}</Alert>
      ) : null}
      {firstGroupError ? (
        <Alert severity="error">{apiErrorMessage(firstGroupError.error)}</Alert>
      ) : null}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : households.length === 0 ? (
        <Alert severity="info">
          Noch kein Haushalt – zuerst unter{' '}
          <Link component={RouterLink} to="/settings/setup" underline="hover">
            Einrichtung
          </Link>{' '}
          einen Haushalt und eine Kontogruppe anlegen.
        </Alert>
      ) : flatGroups.length === 0 ? (
        <Alert severity="warning">
          Keine Kontogruppe – unter{' '}
          <Link component={RouterLink} to="/settings/setup" underline="hover">
            Einrichtung
          </Link>{' '}
          eine Kontogruppe anlegen.
        </Alert>
      ) : (
        <Stack spacing={0}>
          {sortedFlatGroups[0] ? (
            <Alert severity="info" sx={{ mb: 2 }}>
              FinTS-Zugänge sind <strong>nutzerweit</strong> (nicht pro Kontogruppe). Die Übersicht steht{' '}
              <strong>nur einmal</strong> unter dem ersten Block:{' '}
              <strong>
                {sortedFlatGroups[0].householdName} · {sortedFlatGroups[0].group.name}
              </strong>
              . In den weiteren Blöcken kannst du ebenfalls einen Zugang anlegen; die Tabelle dort ist ausgeblendet.
              Wenn die Meldung kommt, der Zugang existiere bereits, die Liste wurde neu geladen — dann den Eintrag dort
              bearbeiten oder löschen.
            </Alert>
          ) : null}
          {sortedFlatGroups.map(({ householdName, group: g }, idx) => (
            <AccountGroupFinTsPanel
              key={g.id}
              accountGroupId={g.id}
              groupLabel={`${householdName} · ${g.name}`}
              provisionGroupOptions={provisionGroupOptions}
              variant="flat"
              showCredentialsTable={idx === 0}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
