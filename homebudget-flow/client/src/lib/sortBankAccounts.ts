import type { BankAccount } from '../api/client';

const collator = new Intl.Collator('de', { sensitivity: 'base' });

function groupSortKey(accountGroupId: number, groupLabelById: ReadonlyMap<number, string>): string {
  return groupLabelById.get(accountGroupId) ?? `\uFFFF${String(accountGroupId).padStart(10, '0')}`;
}

/** Kontogruppe (Anzeigetext), dann Konto-Name, dann IBAN — für Listen in der UI. */
export function sortBankAccountsForDisplay(
  accounts: readonly BankAccount[],
  groupLabelById: ReadonlyMap<number, string>,
): BankAccount[] {
  return [...accounts].sort((a, b) => {
    let c = collator.compare(groupSortKey(a.account_group_id, groupLabelById), groupSortKey(b.account_group_id, groupLabelById));
    if (c !== 0) return c;
    c = collator.compare(a.name, b.name);
    if (c !== 0) return c;
    return collator.compare(a.iban, b.iban);
  });
}
