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
  { key: 'counterparty_name', label: 'Gegenpartei (Name)' },
  { key: 'counterparty_iban', label: 'Gegenpartei (IBAN)', mono: true },
  { key: 'counterparty_bic', label: 'Gegenpartei (BIC)', mono: true },
  { key: 'counterparty_partner_name', label: 'Gegenpartei (Partnername)' },
  { key: 'sepa_end_to_end_id', label: 'SEPA End-to-End-Referenz', mono: true },
  { key: 'sepa_mandate_reference', label: 'SEPA Mandatsreferenz', mono: true },
  { key: 'sepa_creditor_id', label: 'SEPA Gläubiger-ID', mono: true },
  { key: 'bank_reference', label: 'Bankreferenz', mono: true },
  { key: 'customer_reference', label: 'Kundenreferenz', mono: true },
  { key: 'prima_nota', label: 'Prima Nota', mono: true },
  { key: 'imported_at', label: 'Importiert am' },
  { key: 'raw_json', label: 'Rohdaten (FinTS)', mono: true },
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
  if (key === 'counterparty_name') return tx.counterparty_name ?? '—';
  if (key === 'counterparty_iban') return tx.counterparty_iban ?? '—';
  if (key === 'counterparty_bic') return tx.counterparty_bic ?? '—';
  if (key === 'counterparty_partner_name') return tx.counterparty_partner_name ?? '—';
  if (key === 'sepa_end_to_end_id') return tx.sepa_end_to_end_id ?? '—';
  if (key === 'sepa_mandate_reference') return tx.sepa_mandate_reference ?? '—';
  if (key === 'sepa_creditor_id') return tx.sepa_creditor_id ?? '—';
  if (key === 'bank_reference') return tx.bank_reference ?? '—';
  if (key === 'customer_reference') return tx.customer_reference ?? '—';
  if (key === 'prima_nota') return tx.prima_nota ?? '—';
  if (key === 'category_name') return tx.category_name ?? '—';
  if (key === 'category_id') return tx.category_id != null ? String(tx.category_id) : '—';
  if (key === 'imported_at') return `${formatDateTime(tx.imported_at)} (${tx.imported_at})`;
  if (key === 'description') return tx.description || '—';
  if (key === 'raw_json') {
    const raw = tx.raw_json;
    if (!raw) return '—';
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(obj, null, 2);
    } catch {
      return raw;
    }
  }
  return String(tx[key]);
}
