import type {
  CategoryRuleCondition,
  CategoryRuleOut,
  CategoryRuleType,
  Transaction,
} from '../api/client';
import { defaultCategoryRuleDisplayName } from './transactionUi';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wie Backend: Groß-/Kleinschreibung ignorieren; durch Leerzeichen getrennte Token als ganze Wörter. */
function textMatchesWholeWords(hay: string, pattern: string): boolean {
  const hayL = (hay || '').toLowerCase();
  const terms = pattern
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!terms.length) return false;
  for (const t of terms) {
    const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i');
    if (!re.test(hayL)) return false;
  }
  return true;
}

function legacyConditions(ruleType: CategoryRuleType, pattern: string): CategoryRuleCondition[] {
  const pat = pattern.trim();
  if (!pat) return [];
  switch (ruleType) {
    case 'description_contains':
      return [{ type: 'description_contains', pattern: pat }];
    case 'description_contains_word':
      return [{ type: 'description_contains_word', pattern: pat }];
    case 'description_equals':
      return [{ type: 'description_equals', pattern: pat }];
    case 'counterparty_contains':
      return [{ type: 'counterparty_contains', pattern: pat }];
    case 'counterparty_contains_word':
      return [{ type: 'counterparty_contains_word', pattern: pat }];
    case 'counterparty_equals':
      return [{ type: 'counterparty_equals', pattern: pat }];
    default:
      return [];
  }
}

/** Effektive Bedingungsliste wie `rule_effective_conditions` im Backend. */
export function ruleEffectiveConditions(rule: CategoryRuleOut): CategoryRuleCondition[] {
  if (rule.conditions?.length) return rule.conditions;
  if (rule.rule_type && rule.rule_type !== 'conditions') {
    return legacyConditions(rule.rule_type, rule.pattern ?? '');
  }
  return [];
}

export function transactionMatchesConditions(tx: Transaction, conditions: CategoryRuleCondition[]): boolean {
  if (!conditions.length) return false;
  let amt = Number(tx.amount);
  if (Number.isNaN(amt)) amt = 0;

  for (const c of conditions) {
    if (c.type === 'direction') {
      if (c.value === 'credit' && !(amt > 0)) return false;
      if (c.value === 'debit' && !(amt < 0)) return false;
      continue;
    }
    if (c.type === 'description_contains') {
      const needle = c.pattern.toLowerCase();
      const h = (tx.description || '').toLowerCase();
      if (!needle || !h.includes(needle)) return false;
      continue;
    }
    if (c.type === 'description_contains_word') {
      if (!textMatchesWholeWords(tx.description || '', c.pattern)) return false;
      continue;
    }
    if (c.type === 'description_equals') {
      const d = (tx.description || '').trim().toLowerCase();
      const pat = c.pattern.trim().toLowerCase();
      if (!pat || d !== pat) return false;
      continue;
    }
    if (c.type === 'counterparty_contains') {
      const needle = c.pattern.toLowerCase();
      const h = (tx.counterparty || '').toLowerCase();
      if (!needle || !h.includes(needle)) return false;
      continue;
    }
    if (c.type === 'counterparty_contains_word') {
      if (!textMatchesWholeWords(tx.counterparty || '', c.pattern)) return false;
      continue;
    }
    if (c.type === 'counterparty_equals') {
      const cp = (tx.counterparty || '').trim().toLowerCase();
      const pat = c.pattern.trim().toLowerCase();
      if (!pat || !cp || cp !== pat) return false;
      continue;
    }
    if (c.type === 'amount_gte') {
      const bound = Number(c.amount);
      if (Number.isNaN(bound) || amt < bound) return false;
      continue;
    }
    if (c.type === 'amount_lte') {
      const bound = Number(c.amount);
      if (Number.isNaN(bound) || amt > bound) return false;
      continue;
    }
    if (c.type === 'amount_between') {
      if (c.min_amount != null && c.min_amount !== '') {
        const lo = Number(c.min_amount);
        if (!Number.isNaN(lo) && amt < lo) return false;
      }
      if (c.max_amount != null && c.max_amount !== '') {
        const hi = Number(c.max_amount);
        if (!Number.isNaN(hi) && amt > hi) return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

export function transactionMatchesCategoryRule(tx: Transaction, rule: CategoryRuleOut): boolean {
  return transactionMatchesConditions(tx, ruleEffectiveConditions(rule));
}

/**
 * Ordnet eine Buchung dem Anzeigenamen der ersten passenden Zuordnungsregel zu,
 * die dieselbe Zielkategorie wie die Buchung hat (neueste Regel-ID zuerst — wie Backend).
 */
export function displayNameClusterForTransaction(
  tx: Transaction,
  rulesSortedByIdDesc: CategoryRuleOut[],
): { clusterKey: string; label: string } {
  const cid = tx.category_id;
  if (cid == null) {
    return { clusterKey: '__none__', label: 'Ohne Kategorie' };
  }
  const forCat = rulesSortedByIdDesc.filter((r) => r.category_id === cid && !r.category_missing);
  for (const rule of forCat) {
    if (transactionMatchesCategoryRule(tx, rule)) {
      const label = rule.display_name?.trim() || defaultCategoryRuleDisplayName(rule.pattern);
      return { clusterKey: `dn:${label}`, label: label || 'Regel' };
    }
  }
  return { clusterKey: '__no_rule__', label: 'Ohne passende Regel' };
}
