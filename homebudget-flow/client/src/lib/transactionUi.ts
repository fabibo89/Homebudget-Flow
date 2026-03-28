import type { CategoryOut, CategoryRuleCondition, CategoryRuleType, Transaction } from '../api/client';

export function formatMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (Number.isNaN(n)) return `${amount} ${currency}`;
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(n);
}

/**
 * Aus dem Betrag abgeleitete Buchungsart (Bankkonvention: positiv = Gutschrift / Einnahme).
 * Färbung und Tags in der UI beziehen sich darauf, nicht auf „Vorzeichen“ als Konzept.
 */
export type BookingFlow = 'einnahme' | 'ausgabe' | 'neutral';

export function bookingFlowFromAmount(amountStr: string): BookingFlow {
  const n = Number(amountStr);
  if (Number.isNaN(n) || n === 0) return 'neutral';
  return n > 0 ? 'einnahme' : 'ausgabe';
}

/** `booking_flow` aus der API, sonst aus `amount` (z. B. Kandidaten ohne API-Feld). */
export function bookingFlowFromTransaction(tx: Pick<Transaction, 'amount' | 'booking_flow'>): BookingFlow {
  const f = tx.booking_flow;
  if (f === 'einnahme' || f === 'ausgabe' || f === 'neutral') return f;
  return bookingFlowFromAmount(tx.amount);
}

export function bookingFlowLabel(flow: BookingFlow): string {
  if (flow === 'einnahme') return 'Einnahme';
  if (flow === 'ausgabe') return 'Ausgabe';
  return '';
}

/**
 * Textfarbe für eine Buchungsart: Einnahme grün, Ausgabe rot, neutral Standard.
 */
export function bookingFlowAmountSxColor(flow: BookingFlow): 'success.main' | 'error.main' | 'text.primary' {
  if (flow === 'einnahme') return 'success.main';
  if (flow === 'ausgabe') return 'error.main';
  return 'text.primary';
}

/**
 * Betragstextfarbe aus `booking_flow` der API bzw. Fallback aus `amount`.
 */
export function amountSxColorFromTransaction(tx: Pick<Transaction, 'amount' | 'booking_flow'>): 'success.main' | 'error.main' | 'text.primary' {
  return bookingFlowAmountSxColor(bookingFlowFromTransaction(tx));
}

/**
 * Nur aus dem Betrag (ohne Transaction), z. B. für API-Objekte ohne `booking_flow`.
 */
export function amountSxColorFromBookingArt(amountStr: string): 'success.main' | 'error.main' | 'text.primary' {
  return bookingFlowAmountSxColor(bookingFlowFromAmount(amountStr));
}

/** @deprecated Nutze {@link amountSxColorFromTransaction} oder {@link amountSxColorFromBookingArt}. */
export function signedAmountSxColor(amountStr: string): 'success.main' | 'error.main' | 'text.primary' {
  return amountSxColorFromBookingArt(amountStr);
}

export type CategoryFlatOption = { id: number; label: string };

export function flattenCategories(nodes: CategoryOut[], prefix = ''): CategoryFlatOption[] {
  const out: CategoryFlatOption[] = [];
  for (const n of nodes) {
    const label = prefix ? `${prefix} › ${n.name}` : n.name;
    out.push({ id: n.id, label });
    if (n.children?.length) {
      out.push(...flattenCategories(n.children, label));
    }
  }
  return out;
}

/** Nur Unterkategorien — für Buchungs- und Regel-Zuordnung (Hauptkategorien nur zur Gruppierung). */
export function flattenSubcategoryPickOptions(nodes: CategoryOut[]): CategoryFlatOption[] {
  const out: CategoryFlatOption[] = [];
  for (const root of nodes) {
    for (const sub of root.children ?? []) {
      out.push({ id: sub.id, label: `${root.name} › ${sub.name}` });
    }
  }
  return out;
}

export type CategoryFlatOptionWithMeta = {
  id: number;
  label: string;
  effective_color_hex: string;
  icon_emoji: string | null;
};

/** Wie {@link flattenSubcategoryPickOptions}, inkl. Farbe und Symbol der Unterkategorie. */
export function flattenSubcategoryPickOptionsWithMeta(nodes: CategoryOut[]): CategoryFlatOptionWithMeta[] {
  const out: CategoryFlatOptionWithMeta[] = [];
  for (const root of nodes) {
    for (const sub of root.children ?? []) {
      out.push({
        id: sub.id,
        label: `${root.name} › ${sub.name}`,
        effective_color_hex: sub.effective_color_hex,
        icon_emoji: sub.icon_emoji,
      });
    }
  }
  return out;
}

export function flattenCategoriesWithMeta(
  nodes: CategoryOut[],
  prefix = '',
): CategoryFlatOptionWithMeta[] {
  const out: CategoryFlatOptionWithMeta[] = [];
  for (const n of nodes) {
    const label = prefix ? `${prefix} › ${n.name}` : n.name;
    out.push({
      id: n.id,
      label,
      effective_color_hex: n.effective_color_hex,
      icon_emoji: n.icon_emoji,
    });
    if (n.children?.length) {
      out.push(...flattenCategoriesWithMeta(n.children, label));
    }
  }
  return out;
}

export function findCategoryById(roots: CategoryOut[], id: number): CategoryOut | null {
  for (const n of roots) {
    if (n.id === id) return n;
    const d = findCategoryById(n.children ?? [], id);
    if (d) return d;
  }
  return null;
}

/** Unterkategorie inkl. aller Kind-Kategorien (IDs). */
export function collectDescendantCategoryIds(node: CategoryOut): number[] {
  const ids = [node.id];
  for (const ch of node.children ?? []) ids.push(...collectDescendantCategoryIds(ch));
  return ids;
}

/** Option für Kategorie-Dropdowns (z. B. Buchung zuweisen); „Keine Kategorie“ ohne Farbe/Icon. */
export type CategoryPickOption = {
  id: number | null;
  label: string;
  effective_color_hex?: string;
  icon_emoji?: string | null;
};

export type RuleTargetField = 'description' | 'counterparty';
export type RuleMatchMode = 'contains' | 'whole_word' | 'equals';

/** Vorgabe-Anzeigename für eine Regel: Mustertext in Großbuchstaben. */
export function defaultCategoryRuleDisplayName(pattern: string): string {
  const t = pattern.trim();
  return t ? t.toUpperCase().slice(0, 512) : '';
}

export function categoryRuleApiType(field: RuleTargetField, mode: RuleMatchMode): CategoryRuleType {
  if (field === 'description') {
    if (mode === 'whole_word') return 'description_contains_word';
    return mode === 'contains' ? 'description_contains' : 'description_equals';
  }
  if (mode === 'whole_word') return 'counterparty_contains_word';
  return mode === 'contains' ? 'counterparty_contains' : 'counterparty_equals';
}

export type CategoryRuleFormState = {
  direction: 'all' | 'credit' | 'debit';
  field: RuleTargetField;
  mode: RuleMatchMode;
  pattern: string;
  amountMin: string;
  amountMax: string;
};

/** Lädt Formularfelder aus gespeicherten API-Bedingungen (erstes Text-Muster; Betrag aus between/gte/lte). */
export function categoryRuleConditionsToFormState(conditions: CategoryRuleCondition[]): CategoryRuleFormState {
  let direction: 'all' | 'credit' | 'debit' = 'all';
  let field: RuleTargetField = 'description';
  let mode: RuleMatchMode = 'contains';
  let pattern = '';
  let amountMin = '';
  let amountMax = '';
  let textSet = false;

  for (const c of conditions) {
    if (c.type === 'direction') {
      direction = c.value;
      continue;
    }
    if (
      !textSet &&
      (c.type === 'description_contains' ||
        c.type === 'description_contains_word' ||
        c.type === 'description_equals' ||
        c.type === 'counterparty_contains' ||
        c.type === 'counterparty_contains_word' ||
        c.type === 'counterparty_equals')
    ) {
      textSet = true;
      if (c.type === 'description_contains') {
        field = 'description';
        mode = 'contains';
        pattern = c.pattern;
      } else if (c.type === 'description_contains_word') {
        field = 'description';
        mode = 'whole_word';
        pattern = c.pattern;
      } else if (c.type === 'description_equals') {
        field = 'description';
        mode = 'equals';
        pattern = c.pattern;
      } else if (c.type === 'counterparty_contains') {
        field = 'counterparty';
        mode = 'contains';
        pattern = c.pattern;
      } else if (c.type === 'counterparty_contains_word') {
        field = 'counterparty';
        mode = 'whole_word';
        pattern = c.pattern;
      } else {
        field = 'counterparty';
        mode = 'equals';
        pattern = c.pattern;
      }
      continue;
    }
    if (c.type === 'amount_between') {
      amountMin =
        c.min_amount != null && String(c.min_amount).trim() !== ''
          ? String(c.min_amount).replace('.', ',')
          : '';
      amountMax =
        c.max_amount != null && String(c.max_amount).trim() !== ''
          ? String(c.max_amount).replace('.', ',')
          : '';
      continue;
    }
    if (c.type === 'amount_gte') {
      amountMin = String(c.amount).replace('.', ',');
      continue;
    }
    if (c.type === 'amount_lte') {
      amountMax = String(c.amount).replace('.', ',');
      continue;
    }
  }

  return { direction, field, mode, pattern, amountMin, amountMax };
}

export function describeCategoryRuleCondition(c: CategoryRuleCondition): string {
  switch (c.type) {
    case 'direction':
      if (c.value === 'credit') return 'Nur Gutschriften (Betrag > 0)';
      if (c.value === 'debit') return 'Nur Lastschriften (Betrag < 0)';
      return 'Alle Buchungsrichtungen';
    case 'description_contains':
      return `Verwendungszweck enthält „${c.pattern}“`;
    case 'description_contains_word':
      return `Verwendungszweck enthält „${c.pattern}“ (ganze Wörter)`;
    case 'description_equals':
      return `Verwendungszweck ist exakt „${c.pattern}“`;
    case 'counterparty_contains':
      return `Gegenpartei enthält „${c.pattern}“`;
    case 'counterparty_contains_word':
      return `Gegenpartei enthält „${c.pattern}“ (ganze Wörter)`;
    case 'counterparty_equals':
      return `Gegenpartei ist exakt „${c.pattern}“`;
    case 'amount_gte':
      return `Betrag ≥ ${c.amount}`;
    case 'amount_lte':
      return `Betrag ≤ ${c.amount}`;
    case 'amount_between': {
      const parts: string[] = [];
      if (c.min_amount != null && String(c.min_amount).trim() !== '') parts.push(`≥ ${c.min_amount}`);
      if (c.max_amount != null && String(c.max_amount).trim() !== '') parts.push(`≤ ${c.max_amount}`);
      return `Betrag ${parts.join(' und ')}`;
    }
    default:
      return JSON.stringify(c);
  }
}

/** Filter-Tabs für die Regelliste (Einstellungen): Ausgaben / Einnahmen / alle / Vorschläge. */
export type CategoryRulesBookingsTab = 'ausgabe' | 'einnahme' | 'alle' | 'vorschlaege';

/**
 * Ordnet eine Regel dem Tab zu: explizite Richtungs-Bedingung → Ausgabe/Einnahme,
 * sonst „alle“ (Richtung „alle“ oder keine Richtungs-Bedingung, z. B. Legacy).
 */
export function categoryRuleBookingsTab(rule: { conditions: CategoryRuleCondition[] }): CategoryRulesBookingsTab {
  for (const c of rule.conditions ?? []) {
    if (c.type === 'direction') {
      if (c.value === 'credit') return 'einnahme';
      if (c.value === 'debit') return 'ausgabe';
      return 'alle';
    }
  }
  return 'alle';
}

export function defaultRulePatternFromTx(tx: Transaction, field: RuleTargetField): string {
  const raw = field === 'description' ? tx.description || '' : tx.counterparty || '';
  return raw.trim().slice(0, 512);
}

export function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('de-DE').format(new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')));
  } catch {
    return iso;
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** ISO-Datum (YYYY-MM-DD) um delta Kalendermonate verschieben (lokal, wie beim Datumsfeld). */
export function addMonthsToIsoDate(iso: string, deltaMonths: number): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  d.setMonth(d.getMonth() + deltaMonths);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
