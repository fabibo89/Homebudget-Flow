import type { Transaction } from '../../api/client';
import { formatDateTime } from '../../lib/transactionUi';

export const TX_DETAIL_FIELDS: { key: keyof Transaction; label: string; mono?: boolean }[] = [
  { key: 'id', label: 'Interne ID' },
  { key: 'bank_account_id', label: 'Bankkonto' },
  { key: 'external_id', label: 'Externe ID', mono: true },
  { key: 'amount', label: 'Betrag', mono: true },
  { key: 'currency', label: 'Währung' },
  { key: 'booking_date', label: 'Buchungsdatum' },
  { key: 'value_date', label: 'Wertstellung' },
  { key: 'category_name', label: 'Kategorie' },
  { key: 'category_id', label: 'Kategorie-ID', mono: true },
  { key: 'description', label: 'Verwendungszweck' },
  { key: 'counterparty', label: 'Gegenpartei' },
  { key: 'imported_at', label: 'Importiert am' },
];

export function transactionFieldDisplayValue(
  tx: Transaction,
  key: keyof Transaction,
  accountNameById: Map<number, string>,
): string {
  if (key === 'bank_account_id') {
    const name = accountNameById.get(tx.bank_account_id);
    return name ? `${tx.bank_account_id} — ${name}` : String(tx.bank_account_id);
  }
  if (key === 'value_date') return tx.value_date ?? '—';
  if (key === 'counterparty') return tx.counterparty ?? '—';
  if (key === 'category_name') return tx.category_name ?? '—';
  if (key === 'category_id') return tx.category_id != null ? String(tx.category_id) : '—';
  if (key === 'imported_at') return `${formatDateTime(tx.imported_at)} (${tx.imported_at})`;
  if (key === 'description') return tx.description || '—';
  return String(tx[key]);
}
