import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { fetchAccountGroups, fetchHouseholds, type AccountGroup, type Household } from '../api/client';

/** Stabile Fallback-Referenz: `?? []` pro Render würde useMemo/useQueries jedes Mal invalidieren. */
const NO_HOUSEHOLDS: Household[] = [];

export type HouseholdWithGroups = {
  household: Household;
  groups: AccountGroup[];
};

/** „Haushalt · Kontogruppe“ je `account_group_id` (für Sortierung / Anzeige). */
export function useAccountGroupLabelMap(): {
  groupLabelById: Map<number, string>;
  loading: boolean;
  /** Haushalt → Kontogruppen (z. B. für Analysen-Filter). */
  householdWithGroups: HouseholdWithGroups[];
} {
  const householdsQuery = useQuery({ queryKey: ['households'], queryFn: fetchHouseholds });
  const households = householdsQuery.data;
  const householdList = households ?? NO_HOUSEHOLDS;

  const groupQueries = useQueries({
    queries: householdList.map((h) => ({
      queryKey: ['account-groups', h.id] as const,
      queryFn: () => fetchAccountGroups(h.id),
      enabled: householdsQuery.isSuccess && householdList.length > 0,
    })),
  });

  // `groupQueries` ist jedes Render ein neues Array — nicht als useMemo-Dep nutzen (sonst neue Map,
  // neue sortierte Konten-Liste, useQueries(Saldo) feuert für alle Konten bei jedem Re-Render).
  const groupFetchSignature = groupQueries.map((q) => q.dataUpdatedAt).join('|');

  const groupLabelById = useMemo(() => {
    const m = new Map<number, string>();
    const list = households ?? NO_HOUSEHOLDS;
    list.forEach((h, hi) => {
      for (const g of groupQueries[hi]?.data ?? []) {
        if (!g.current_user_is_member) continue;
        m.set(g.id, `${h.name} · ${g.name}`);
      }
    });
    return m;
  }, [households, groupFetchSignature]);

  const householdWithGroups = useMemo((): HouseholdWithGroups[] => {
    const list = households ?? NO_HOUSEHOLDS;
    return list.map((h, hi) => ({
      household: h,
      groups: [...(groupQueries[hi]?.data ?? [])]
        .filter((g) => g.current_user_is_member)
        .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    }));
  }, [households, groupFetchSignature]);

  const loading =
    householdsQuery.isLoading || groupQueries.some((q) => q.isLoading && householdsQuery.isSuccess);

  return { groupLabelById, loading, householdWithGroups };
}
