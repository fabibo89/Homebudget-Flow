import type { Transaction } from '../api/client';

/** Abgehende Umbuchung mit Zielkonto — je nach API-Zuordnung. */
export type AnalysisTransferKindKey =
  | 'own_internal'
  | 'own_to_shared'
  | 'own_to_other_user'
  | 'unclassified';

export const ANALYSIS_TRANSFER_KIND_KEYS: AnalysisTransferKindKey[] = [
  'own_internal',
  'own_to_shared',
  'own_to_other_user',
  'unclassified',
];

export const DEFAULT_TRANSFER_KIND_INCLUSION: Record<AnalysisTransferKindKey, boolean> = {
  own_internal: true,
  own_to_shared: true,
  own_to_other_user: true,
  unclassified: true,
};

export function transferKindLabel(k: AnalysisTransferKindKey): string {
  if (k === 'own_internal') return 'Eigene Umbuchung';
  if (k === 'own_to_shared') return 'Eigen → Gemeinsames Konto';
  if (k === 'own_to_other_user') return 'Eigen → Konto einer anderen Person';
  return 'Sonstige Umbuchung';
}

/** Nur abgehende Umbuchungen (Zielkonto gesetzt); sonst `null`. */
export function effectiveAnalysisTransferKind(t: Transaction): AnalysisTransferKindKey | null {
  if (t.transfer_target_bank_account_id == null) return null;
  const k = t.transfer_kind ?? 'none';
  if (k === 'own_internal' || k === 'own_to_shared' || k === 'own_to_other_user') return k;
  return 'unclassified';
}

/** `true` = Buchung bleibt in der Analyse; `false` = ausgeschlossen. Nicht-Umbuchungen immer `true`. */
export function passesAnalysisTransferFilter(
  t: Transaction,
  inclusion: Record<AnalysisTransferKindKey, boolean>,
): boolean {
  const eff = effectiveAnalysisTransferKind(t);
  if (eff === null) return true;
  return inclusion[eff] === true;
}
