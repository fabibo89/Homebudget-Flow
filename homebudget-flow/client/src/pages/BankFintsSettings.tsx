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
        return list.map((g) => ({
          householdName: h.name,
          group: g,
        }));
      }),
    [households, groupQueries],
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
          {flatGroups.map(({ householdName, group: g }) => (
            <AccountGroupFinTsPanel
              key={g.id}
              accountGroupId={g.id}
              groupLabel={`${householdName} · ${g.name}`}
              provisionGroupOptions={provisionGroupOptions}
              variant="flat"
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
