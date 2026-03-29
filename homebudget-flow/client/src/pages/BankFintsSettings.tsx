import { useMemo } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Alert, Box, CircularProgress, Link, Stack, Typography } from '@mui/material';
import { useQueries, useQuery } from '@tanstack/react-query';
import { apiErrorMessage, fetchAccountGroups, fetchAccounts, fetchHouseholds } from '../api/client';
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

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: fetchAccounts });

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

  const groupLabelById = useMemo(() => {
    const m = new Map<number, string>();
    for (const { householdName, group: g } of flatGroups) {
      m.set(g.id, `${householdName} · ${g.name}`);
    }
    return m;
  }, [flatGroups]);

  const defaultProvisionGroupId = sortedFlatGroups[0]?.group.id ?? 0;

  const loading = householdsQuery.isLoading || groupQueries.some((q) => q.isLoading);
  const firstGroupError = groupQueries.find((q) => q.isError);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          Bankzugang (FinTS)
        </Typography>
        <Typography color="text.secondary" variant="body2">
          Online-Banking-Zugänge (Login/PIN) sind <strong>nutzerweit</strong>. Beim Anlegen oder Bearbeiten wählst du,
          in welcher <strong>Kontogruppe neue Bankkonten</strong> (erkannte IBANs) angelegt werden. Welches Konto zu
          welcher Gruppe gehört, siehst du in der Tabelle unten und unter{' '}
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
      {accountsQuery.isError ? (
        <Alert severity="warning">
          Bankkonten für die Zuordnung konnten nicht geladen werden: {apiErrorMessage(accountsQuery.error)}
        </Alert>
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
      ) : defaultProvisionGroupId === 0 ? (
        <Alert severity="warning">Keine Kontogruppe für die Voreinstellung verfügbar.</Alert>
      ) : (
        <AccountGroupFinTsPanel
          accountGroupId={defaultProvisionGroupId}
          provisionGroupOptions={provisionGroupOptions}
          variant="flat"
          bankAccounts={accountsQuery.data ?? []}
          groupLabelById={groupLabelById}
        />
      )}
    </Stack>
  );
}
