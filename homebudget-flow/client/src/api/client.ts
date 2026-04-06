import axios, { AxiosError } from 'axios';
import { setAppTimeZone } from '../lib/appTimeZone';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE ?? '',
  headers: { 'Content-Type': 'application/json' },
});

export function setAuthToken(token: string | null) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}

export function apiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const d = err.response?.data as unknown;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object' && 'detail' in d) {
      const det = (d as { detail: unknown }).detail;
      if (typeof det === 'string') return det;
      if (Array.isArray(det)) {
        return det
          .map((x) => (typeof x === 'object' && x && 'msg' in x ? String((x as { msg: string }).msg) : String(x)))
          .join(', ');
      }
    }
    if (err.response?.status === 401) return 'Nicht angemeldet oder Ungültige Zugangsdaten.';
  }
  return err instanceof Error ? err.message : 'Unbekannter Fehler';
}

export type TokenOut = { access_token: string; token_type?: string };

export async function login(email: string, password: string): Promise<TokenOut> {
  const { data } = await api.post<TokenOut>('/api/auth/login', { email, password });
  return data;
}

export async function register(
  email: string,
  password: string,
  displayName?: string,
): Promise<TokenOut> {
  const { data } = await api.post<TokenOut>('/api/auth/register', {
    email,
    password,
    display_name: displayName ?? '',
  });
  return data;
}

export type UserMe = {
  id: number;
  email: string;
  display_name: string;
  all_household_transactions: boolean;
  /** IANA-Zeitzone (Server APP_TIMEZONE) — für Datums-/Zeitanzeige im Client. */
  app_timezone: string;
};

export async function fetchCurrentUser(): Promise<UserMe> {
  const { data } = await api.get<UserMe>('/api/auth/me');
  setAppTimeZone(data.app_timezone);
  return data;
}

export async function patchCurrentUser(body: {
  display_name?: string;
  all_household_transactions?: boolean;
}): Promise<UserMe> {
  const { data } = await api.patch<UserMe>('/api/auth/me', body);
  setAppTimeZone(data.app_timezone);
  return data;
}

/** Temporäre Nutzereinstellungen (parallel zu /api/auth/me); gleiche Payload wie patchCurrentUser. */
export type UserSettings = UserMe;

export async function fetchUserSettings(): Promise<UserSettings> {
  const { data } = await api.get<UserSettings>('/api/users/me/settings');
  setAppTimeZone(data.app_timezone);
  return data;
}

export async function patchUserSettings(body: {
  display_name?: string;
  all_household_transactions?: boolean;
}): Promise<UserSettings> {
  const { data } = await api.patch<UserSettings>('/api/users/me/settings', body);
  setAppTimeZone(data.app_timezone);
  return data;
}

// --- Haushalt / Kontogruppen / Bankkonten ---

export type Household = {
  id: number;
  name: string;
  created_at: string;
  /** Immer member — gleiche Rechte für alle Haushaltsmitglieder (keine Besitzer-Rolle). */
  my_role: 'member';
};

export type HouseholdInvitationIncoming = {
  id: number;
  household_id: number;
  household_name: string;
  inviter_email: string;
  invitee_email: string;
  created_at: string;
  expires_at: string;
};

export type HouseholdInvitationOutgoing = {
  id: number;
  invitee_email: string;
  created_at: string;
  expires_at: string;
};

export async function fetchIncomingHouseholdInvitations(): Promise<HouseholdInvitationIncoming[]> {
  const { data } = await api.get<HouseholdInvitationIncoming[]>('/api/households/invitations/incoming');
  return data;
}

export async function fetchOutgoingHouseholdInvitations(householdId: number): Promise<HouseholdInvitationOutgoing[]> {
  const { data } = await api.get<HouseholdInvitationOutgoing[]>(
    `/api/households/${householdId}/invitations`,
  );
  return data;
}

export async function inviteHouseholdMember(householdId: number, email: string): Promise<HouseholdInvitationOutgoing> {
  const { data } = await api.post<HouseholdInvitationOutgoing>(`/api/households/${householdId}/invitations`, {
    email,
  });
  return data;
}

export async function acceptHouseholdInvitation(invitationId: number): Promise<Household> {
  const { data } = await api.post<Household>(`/api/households/invitations/${invitationId}/accept`);
  return data;
}

export async function deleteHouseholdInvitation(invitationId: number): Promise<void> {
  await api.delete(`/api/households/invitations/${invitationId}`);
}

export async function fetchHouseholds(): Promise<Household[]> {
  const { data } = await api.get<Household[]>('/api/households');
  return data;
}

/** Persistente Verträge (Vorschlag / bestätigt / ignoriert). */
export type ContractOut = {
  id: number;
  household_id: number;
  bank_account_id: number;
  bank_account_name: string;
  status: 'suggested' | 'confirmed' | 'ignored';
  label: string;
  amount_typical: string;
  currency: string;
  rhythm: string;
  rhythm_display: string;
  occurrences: number;
  first_booking: string | null;
  last_booking: string | null;
  confidence: number;
  signature_hash: string;
  sample_transaction_ids: number[];
  transaction_count: number;
  /** Einheitliche Kategorie aller Buchungen, sonst „Divers“, alle ohne „—“ */
  category_summary: string;
  category_color_hex?: string | null;
};

export type ContractRecognizeResult = {
  suggestions_updated: number;
  confirmed_links_touched: number;
};

export async function fetchContracts(
  bankAccountId: number | 'all',
  status?: 'suggested' | 'confirmed' | 'ignored',
): Promise<ContractOut[]> {
  const { data } = await api.get<ContractOut[]>('/api/contracts', {
    params: {
      ...(bankAccountId === 'all' ? {} : { bank_account_id: bankAccountId }),
      ...(status ? { status } : {}),
    },
  });
  return data;
}

/** Vertragserkennung nur für ein Bankkonto (sichtbare Konten). */
export async function recognizeContracts(
  bankAccountId: number,
  monthsBack = 60,
): Promise<ContractRecognizeResult> {
  const { data } = await api.post<ContractRecognizeResult>('/api/contracts/recognize', null, {
    params: { bank_account_id: bankAccountId, months_back: monthsBack },
  });
  return data;
}

export async function confirmContract(contractId: number): Promise<{ ok: boolean; transactions_linked: number }> {
  const { data } = await api.post<{ ok: boolean; transactions_linked: number }>(
    `/api/contracts/${contractId}/confirm`,
  );
  return data;
}

export async function ignoreContract(contractId: number): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>(`/api/contracts/${contractId}/ignore`);
  return data;
}

export async function createHousehold(name: string): Promise<Household> {
  const { data } = await api.post<Household>('/api/households', { name });
  return data;
}

export async function updateHousehold(id: number, body: { name: string }): Promise<Household> {
  const { data } = await api.patch<Household>(`/api/households/${id}`, body);
  return data;
}

export async function deleteHousehold(id: number): Promise<void> {
  await api.delete(`/api/households/${id}`);
}

// --- Kategorien (Haupt / Unter, Farbe, Symbol) ---

export type CategoryOut = {
  id: number;
  household_id: number;
  name: string;
  parent_id: number | null;
  color_hex: string | null;
  effective_color_hex: string;
  icon_emoji: string | null;
  image_mime: string | null;
  has_image: boolean;
  created_by_user_id?: number | null;
  created_by_display?: string | null;
  children: CategoryOut[];
};

export async function fetchCategories(householdId: number): Promise<CategoryOut[]> {
  const { data } = await api.get<CategoryOut[]>(`/api/households/${householdId}/categories`);
  return data;
}

export async function createCategory(
  householdId: number,
  body: {
    name: string;
    parent_id?: number | null;
    color_hex?: string | null;
    icon_emoji?: string | null;
  },
): Promise<CategoryOut> {
  const { data } = await api.post<CategoryOut>(`/api/households/${householdId}/categories`, body);
  return data;
}

export async function updateCategory(
  householdId: number,
  categoryId: number,
  body: {
    name?: string;
    color_hex?: string | null;
    icon_emoji?: string | null;
  },
): Promise<CategoryOut> {
  const { data } = await api.patch<CategoryOut>(
    `/api/households/${householdId}/categories/${categoryId}`,
    body,
  );
  return data;
}

export async function deleteCategory(householdId: number, categoryId: number): Promise<void> {
  await api.delete(`/api/households/${householdId}/categories/${categoryId}`);
}

export type CategoryRuleType =
  | 'description_contains'
  | 'description_contains_word'
  | 'description_equals'
  | 'counterparty_contains'
  | 'counterparty_contains_word'
  | 'counterparty_equals'
  | 'conditions';

export type CategoryRuleCondition =
  | { type: 'direction'; value: 'credit' | 'debit' | 'all' }
  | { type: 'description_contains'; pattern: string }
  | { type: 'description_contains_word'; pattern: string }
  | { type: 'description_equals'; pattern: string }
  | { type: 'counterparty_contains'; pattern: string }
  | { type: 'counterparty_contains_word'; pattern: string }
  | { type: 'counterparty_equals'; pattern: string }
  | { type: 'amount_gte'; amount: string }
  | { type: 'amount_lte'; amount: string }
  | {
      type: 'amount_between';
      min_amount?: string | null;
      max_amount?: string | null;
    };

export type CategoryRuleOut = {
  id: number;
  household_id: number;
  category_id: number | null;
  /** true, wenn die Zielkategorie fehlt — Regel greift nicht, bis neu zugeordnet */
  category_missing?: boolean;
  /** true: alle Konten im Haushalt; false: nur Konten des Erstellers (sichtbare Gruppen) */
  applies_to_household?: boolean;
  rule_type: CategoryRuleType;
  pattern: string;
  /** Effektiver Anzeigename (eigener Name oder Mustertext in Großbuchstaben). */
  display_name: string;
  /** Nur wenn vom Nutzer gesetzt; sonst null (Vorgabe aus Muster). */
  display_name_override?: string | null;
  /** True: '.' und Whitespace gleich behandeln (z. B. "ERNST LEBENSMITTEL" == "ERNST.LEBENSMITTEL"). */
  normalize_dot_space: boolean;
  conditions: CategoryRuleCondition[];
  created_at: string;
  created_by_user_id?: number | null;
  created_by_display?: string | null;
};

export type CategoryRulesListResponse = {
  rules: CategoryRuleOut[];
  warnings: string[];
};

export type CategoryRuleOverwriteCandidate = {
  transaction_id: number;
  bank_account_id: number;
  booking_date: string;
  amount: string;
  currency: string;
  description: string;
  counterparty: string | null;
  current_category_id: number;
  current_category_name: string;
  suggested_category_id: number;
  suggested_category_name: string;
};

export type CategoryRuleCreatedOut = CategoryRuleOut & {
  transactions_updated: number;
  category_overwrite_candidates: CategoryRuleOverwriteCandidate[];
  category_overwrite_truncated: boolean;
};

export async function fetchCategoryRules(householdId: number): Promise<CategoryRulesListResponse> {
  const { data } = await api.get<CategoryRulesListResponse>(`/api/households/${householdId}/category-rules`);
  return data;
}

export type CategoryRuleSuggestion = {
  rule_type: CategoryRuleType;
  pattern: string;
  transaction_count: number;
  distinct_label_count: number;
  sample_labels: string[];
};

export type CategoryRuleSuggestionsBundle = {
  active: CategoryRuleSuggestion[];
  ignored: CategoryRuleSuggestion[];
};

export type CategoryRuleSuggestionPreviewGroup = {
  label: string;
  transactions: Transaction[];
};

export type CategoryRuleSuggestionPreviewOut = {
  rule_type: CategoryRuleType;
  pattern: string;
  truncated: boolean;
  groups: CategoryRuleSuggestionPreviewGroup[];
};

export async function fetchCategoryRuleSuggestions(householdId: number): Promise<CategoryRuleSuggestionsBundle> {
  const { data } = await api.get<CategoryRuleSuggestionsBundle>(
    `/api/households/${householdId}/category-rule-suggestions`,
  );
  return data;
}

export async function fetchCategoryRuleSuggestionPreview(args: {
  householdId: number;
  rule_type: CategoryRuleType;
  pattern: string;
  sample_labels: string[];
  limit_per_label?: number;
  limit_total?: number;
}): Promise<CategoryRuleSuggestionPreviewOut> {
  const { data } = await api.post<CategoryRuleSuggestionPreviewOut>(
    `/api/households/${args.householdId}/category-rule-suggestions/preview`,
    {
      rule_type: args.rule_type,
      pattern: args.pattern,
      sample_labels: args.sample_labels,
      limit_per_label: args.limit_per_label ?? 25,
      limit_total: args.limit_total ?? 200,
    },
  );
  return data;
}

export async function dismissCategoryRuleSuggestion(
  householdId: number,
  body: CategoryRuleSuggestion,
): Promise<void> {
  await api.post(`/api/households/${householdId}/category-rule-suggestion-dismissals`, {
    rule_type: body.rule_type,
    pattern: body.pattern,
    transaction_count: body.transaction_count,
    distinct_label_count: body.distinct_label_count,
    sample_labels: body.sample_labels,
  });
}

export async function restoreCategoryRuleSuggestion(
  householdId: number,
  body: { rule_type: CategoryRuleType; pattern: string },
): Promise<void> {
  await api.delete(`/api/households/${householdId}/category-rule-suggestion-dismissals`, { data: body });
}

export async function createCategoryRule(
  householdId: number,
  body: {
    conditions?: CategoryRuleCondition[];
    rule_type?: CategoryRuleType;
    pattern?: string;
    display_name_override?: string | null;
    normalize_dot_space?: boolean;
    category_id: number;
    applies_to_household?: boolean;
    apply_to_uncategorized?: boolean;
    also_assign_transaction_id?: number | null;
  },
): Promise<CategoryRuleCreatedOut> {
  const { data } = await api.post<CategoryRuleCreatedOut>(
    `/api/households/${householdId}/category-rules`,
    body,
  );
  return data;
}

export async function updateCategoryRule(
  householdId: number,
  ruleId: number,
  body: {
    conditions?: CategoryRuleCondition[];
    rule_type?: CategoryRuleType;
    pattern?: string;
    display_name_override?: string | null;
    normalize_dot_space?: boolean;
    category_id: number;
    applies_to_household?: boolean;
    apply_to_uncategorized?: boolean;
  },
): Promise<CategoryRuleCreatedOut> {
  const { data } = await api.patch<CategoryRuleCreatedOut>(
    `/api/households/${householdId}/category-rules/${ruleId}`,
    body,
  );
  return data;
}

export async function deleteCategoryRule(householdId: number, ruleId: number): Promise<void> {
  await api.delete(`/api/households/${householdId}/category-rules/${ruleId}`);
}

export async function reverseCategoryRule(
  householdId: number,
  ruleId: number,
): Promise<CategoryRuleCreatedOut> {
  const { data } = await api.post<CategoryRuleCreatedOut>(
    `/api/households/${householdId}/category-rules/${ruleId}/reverse`,
  );
  return data;
}

export async function bulkPatchTransactionCategories(body: {
  items: { transaction_id: number; category_id: number }[];
}): Promise<{ updated: number }> {
  const { data } = await api.post<{ updated: number }>('/api/transactions/bulk-category', body);
  return data;
}

export type AccountGroup = {
  id: number;
  household_id: number;
  name: string;
  description: string;
  /** Mitgliedschaft des angemeldeten Nutzers an dieser Kontogruppe. */
  current_user_is_member: boolean;
  /** Freigabeliste / Gruppe bearbeiten-löschen (can_edit am Mitglied). */
  current_user_can_manage_sharing: boolean;
};

export type HouseholdMember = {
  user_id: number;
  email: string;
  display_name: string;
  /** Immer member — gleiche Rechte für alle Haushaltsmitglieder. */
  role: 'member';
};

export async function fetchHouseholdMembers(householdId: number): Promise<HouseholdMember[]> {
  const { data } = await api.get<HouseholdMember[]>(`/api/households/${householdId}/members`);
  return data;
}

export type AccountGroupMember = {
  user_id: number;
  email: string;
  display_name: string;
  can_edit: boolean;
};

export async function fetchAccountGroupMembers(accountGroupId: number): Promise<AccountGroupMember[]> {
  const { data } = await api.get<AccountGroupMember[]>(
    `/api/households/account-groups/${accountGroupId}/members`,
  );
  return data;
}

export async function putAccountGroupMembers(accountGroupId: number, userIds: number[]): Promise<AccountGroupMember[]> {
  const { data } = await api.put<AccountGroupMember[]>(`/api/households/account-groups/${accountGroupId}/members`, {
    user_ids: userIds,
  });
  return data;
}

export async function fetchAccountGroups(householdId: number): Promise<AccountGroup[]> {
  const { data } = await api.get<AccountGroup[]>(`/api/households/${householdId}/account-groups`);
  return data;
}

export async function createAccountGroup(body: {
  household_id: number;
  name: string;
  description?: string;
  member_user_ids?: number[];
}): Promise<AccountGroup> {
  const { data } = await api.post<AccountGroup>('/api/households/account-groups', {
    household_id: body.household_id,
    name: body.name,
    description: body.description ?? '',
    member_user_ids: body.member_user_ids ?? [],
  });
  return data;
}

export async function updateAccountGroup(
  id: number,
  body: { name: string; description: string },
): Promise<AccountGroup> {
  const { data } = await api.patch<AccountGroup>(`/api/households/account-groups/${id}`, body);
  return data;
}

export async function deleteAccountGroup(id: number): Promise<void> {
  await api.delete(`/api/households/account-groups/${id}`);
}

export type BankAccount = {
  id: number;
  account_group_id: number;
  household_id: number;
  credential_id: number;
  provider: string;
  name: string;
  iban: string;
  currency: string;
  balance: string;
  balance_at: string | null;
  balance_attempt_at: string | null;
  balance_success_at: string | null;
  transactions_attempt_at: string | null;
  transactions_success_at: string | null;
  /** Tag Null: Datum der letzten passenden Buchung (Tag-Null-Regel); kein Betrag in der DB */
  day_zero_date?: string | null;
};

export async function fetchAccounts(): Promise<BankAccount[]> {
  const { data } = await api.get<BankAccount[]>('/api/accounts');
  return data;
}

export async function createBankAccount(body: {
  account_group_id: number;
  provider?: string;
  iban: string;
  name: string;
  currency?: string;
  credential_id: number;
}): Promise<BankAccount> {
  const { data } = await api.post<BankAccount>('/api/households/bank-accounts', {
    account_group_id: body.account_group_id,
    provider: body.provider ?? 'comdirect',
    iban: body.iban,
    name: body.name,
    currency: body.currency ?? 'EUR',
    credential_id: body.credential_id,
  });
  return data;
}

export async function updateBankAccount(
  id: number,
  body: {
    /** Andere Kontogruppe desselben Haushalts (Umzuordnen des Kontos). */
    account_group_id?: number;
    name?: string;
    iban?: string;
    currency?: string;
    provider?: string;
    credential_id?: number;
  },
): Promise<BankAccount> {
  const { data } = await api.patch<BankAccount>(`/api/accounts/${id}`, body);
  return data;
}

export async function refreshBankAccountDayZero(id: number): Promise<BankAccount> {
  const { data } = await api.post<BankAccount>(`/api/accounts/${id}/day-zero/refresh`);
  return data;
}

export type TagZeroRuleSource = 'none' | 'category_rule' | 'custom';

export type TagZeroRuleOut = {
  source: TagZeroRuleSource;
  category_rule_id?: number | null;
  display_name_override?: string | null;
  normalize_dot_space?: boolean;
  conditions?: CategoryRuleCondition[];
};

export async function fetchTagZeroRule(bankAccountId: number): Promise<TagZeroRuleOut> {
  const { data } = await api.get<TagZeroRuleOut>(`/api/accounts/${bankAccountId}/tag-zero-rule`);
  return data;
}

export async function upsertTagZeroRule(
  bankAccountId: number,
  body:
    | { source: 'none' }
    | { source: 'category_rule'; category_rule_id: number }
    | {
        source: 'custom';
        display_name_override?: string;
        normalize_dot_space?: boolean;
        conditions?: CategoryRuleCondition[];
        rule_type?: CategoryRuleType;
        pattern?: string;
      },
): Promise<TagZeroRuleOut> {
  const { data } = await api.put<TagZeroRuleOut>(`/api/accounts/${bankAccountId}/tag-zero-rule`, body);
  return data;
}

export type DayZeroMeltdownDay = {
  day: string;
  balance_actual: string;
  balance_target: string;
  net_actual: string;
  spend_actual: string;
  spend_target_fixed: string;
  spend_target_dynamic: string;
  remaining: string;
};

export type DayZeroMeltdownBookingRef = {
  id: number;
  booking_date: string;
  amount: string;
  description: string;
  counterparty_name?: string | null;
  transfer_target_bank_account_id?: number | null;
  contract_id?: number | null;
  contract_label?: string | null;
};

export type DayZeroMeltdownOut = {
  bank_account_id: number;
  tag_zero_date: string;
  /** Kontostand am Tag Null (berechnet). */
  tag_zero_amount?: string | null;
  /** Betrag der neuesten Buchung, die der Tag-Null-Regel entspricht. */
  tag_zero_rule_booking_amount?: string | null;
  /** Meltdown-Start (Anzeige), inkl. Umbuchungs-Anpassung. */
  meltdown_start_amount?: string | null;
  /** Ob der Tag-Null-Saldo die Regel-Buchung schon enthält (Snapshot-Heuristik). */
  tag_zero_saldo_includes_rule_booking?: boolean | null;
  period_start: string;
  period_end_exclusive: string;
  currency: string;
  days: DayZeroMeltdownDay[];
  transfer_bookings: DayZeroMeltdownBookingRef[];
  contract_bookings: DayZeroMeltdownBookingRef[];
};

export async function fetchDayZeroMeltdown(bankAccountId: number, months = 1): Promise<DayZeroMeltdownOut> {
  const { data } = await api.get<DayZeroMeltdownOut>(`/api/accounts/${bankAccountId}/dayzero-meltdown`, {
    params: { months },
  });
  return data;
}

export type BalanceSnapshotOut = {
  id: number;
  bank_account_id: number;
  balance: string;
  currency: string;
  recorded_at: string;
};

/** Neueste Einträge zuerst (je erfolgreichem Saldo-Sync). */
export async function fetchBalanceSnapshots(
  bankAccountId: number,
  limit = 500,
): Promise<BalanceSnapshotOut[]> {
  const { data } = await api.get<BalanceSnapshotOut[]>(
    `/api/accounts/${bankAccountId}/balance-snapshots`,
    { params: { limit } },
  );
  return data;
}

export async function updateBalanceSnapshot(
  bankAccountId: number,
  snapshotId: number,
  body: { balance?: string; currency?: string; recorded_at?: string },
): Promise<BalanceSnapshotOut> {
  const { data } = await api.patch<BalanceSnapshotOut>(
    `/api/accounts/${bankAccountId}/balance-snapshots/${snapshotId}`,
    body,
  );
  return data;
}

export async function deleteBalanceSnapshot(bankAccountId: number, snapshotId: number): Promise<void> {
  await api.delete(`/api/accounts/${bankAccountId}/balance-snapshots/${snapshotId}`);
}

// --- Transaktionen ---

/** Aus dem Betrag abgeleitet (API liefert konsistent zum Backend, Fallback im Client nur aus `amount`). */
export type BookingFlow = 'einnahme' | 'ausgabe' | 'neutral';

export type Transaction = {
  id: number;
  bank_account_id: number;
  external_id: string;
  amount: string;
  currency: string;
  booking_date: string;
  value_date: string | null;
  description: string;
  counterparty: string | null;
  counterparty_name?: string | null;
  counterparty_iban?: string | null;
  counterparty_partner_name?: string | null;
  counterparty_bic?: string | null;
  raw_json?: string | null;
  sepa_end_to_end_id?: string | null;
  sepa_mandate_reference?: string | null;
  sepa_creditor_id?: string | null;
  bank_reference?: string | null;
  customer_reference?: string | null;
  prima_nota?: string | null;
  imported_at: string;
  category_id: number | null;
  category_name: string | null;
  transfer_target_bank_account_id?: number | null;
  transfer_kind?: 'none' | 'own_internal' | 'own_to_shared' | 'own_to_other_user';
  /** Effektive Anzeigefarbe der Kategorie (#rrggbb), wie in den Kategorieeinstellungen. */
  category_color_hex?: string | null;
  /** Vom Server aus `amount` berechnet; optional für ältere gecachte Antworten. */
  booking_flow?: BookingFlow;
  /** Externe Positionszeilen (z. B. Amazon-Produkte), für die Listenansicht */
  enrichment_preview_lines?: string[];
  contract_id?: number | null;
  contract_label?: string | null;
};

export async function fetchContractTransactions(contractId: number, limit = 500): Promise<Transaction[]> {
  const { data } = await api.get<Transaction[]>(`/api/contracts/${contractId}/transactions`, {
    params: { limit },
  });
  return data;
}

export type TransactionEnrichment = {
  id: number;
  source: 'paypal' | 'amazon' | string;
  external_ref: string;
  booking_date: string;
  amount: string;
  currency: string;
  description: string;
  counterparty: string | null;
  vendor: string | null;
  details: Record<string, unknown>;
  raw: Record<string, unknown>;
  matched_at: string;
};

export type ExternalRecordMapping = {
  record_id: number;
  source: string;
  external_ref: string;
  order_id: string | null;
  booking_date: string;
  amount: string;
  currency: string;
  description: string;
  counterparty: string | null;
  vendor: string | null;
  matched: boolean;
  matched_transaction_id: number | null;
  matched_bank_account_id: number | null;
  matched_bank_account_name: string | null;
  matched_booking_date: string | null;
  matched_amount: string | null;
  matched_currency: string | null;
  matched_description: string | null;
  matched_counterparty: string | null;
  matched_at: string | null;
};

export async function fetchExternalRecordMappings(
  householdId: number,
  source: 'amazon' | 'paypal',
  limit = 500,
): Promise<ExternalRecordMapping[]> {
  const { data } = await api.get<ExternalRecordMapping[]>('/api/transactions/enrichments/external-records', {
    params: { household_id: householdId, source, limit },
  });
  return data;
}

export async function fetchTransactionEnrichments(transactionId: number): Promise<TransactionEnrichment[]> {
  const { data } = await api.get<TransactionEnrichment[]>(`/api/transactions/${transactionId}/enrichments`);
  return data;
}

export async function importTransactionEnrichments(body: {
  household_id: number;
  source: 'paypal' | 'amazon';
  records: Array<{
    external_ref?: string;
    booking_date: string;
    amount: string;
    currency?: string;
    description?: string;
    counterparty?: string | null;
    vendor?: string | null;
    details?: Record<string, unknown>;
    raw?: Record<string, unknown>;
  }>;
  auto_match?: boolean;
}): Promise<{
  imported: number;
  matched: number;
  unmatched: number;
  skipped_low_confidence: number;
  skipped_internal?: number;
}> {
  const { data } = await api.post('/api/transactions/enrichments/import', body);
  return data;
}

export async function patchTransactionCategory(
  transactionId: number,
  body: { category_id: number | null },
): Promise<Transaction> {
  const { data } = await api.patch<Transaction>(`/api/transactions/${transactionId}`, body);
  return data;
}

export async function fetchTransactions(params: {
  from?: string;
  to?: string;
  bank_account_id?: number;
  description_contains?: string;
  counterparty_contains?: string;
  /** Nur ganze Wörter (Wortgrenzen), gilt für Verwendungszweck- und Gegenpartei-Filter. */
  whole_words?: boolean;
  limit?: number;
  offset?: number;
}): Promise<Transaction[]> {
  const { data } = await api.get<Transaction[]>('/api/transactions', {
    params: {
      from: params.from,
      to: params.to,
      bank_account_id: params.bank_account_id,
      description_contains: params.description_contains?.trim() || undefined,
      counterparty_contains: params.counterparty_contains?.trim() || undefined,
      whole_words: params.whole_words === true ? true : undefined,
      limit: params.limit ?? 200,
      offset: params.offset ?? 0,
    },
  });
  return data;
}

const TX_PAGE_MAX = 2000;

/** Alle Buchungen im Zeitraum (paginiert, bis zu 2000 pro Request). */
export async function fetchAllTransactions(params: {
  from?: string;
  to?: string;
  bank_account_id?: number;
  description_contains?: string;
  counterparty_contains?: string;
  whole_words?: boolean;
}): Promise<Transaction[]> {
  const all: Transaction[] = [];
  let offset = 0;
  for (;;) {
    const batch = await fetchTransactions({
      ...params,
      limit: TX_PAGE_MAX,
      offset,
    });
    all.push(...batch);
    if (batch.length < TX_PAGE_MAX) break;
    offset += TX_PAGE_MAX;
  }
  return all;
}

// --- Umbuchungen (Paare) ---

export type TransferPair = {
  id: number;
  household_id: number;
  created_at: string;
  out_transaction: Transaction;
  in_transaction: Transaction;
};

export async function fetchTransferPairs(params: {
  from?: string;
  to?: string;
  bank_account_id?: number;
  limit?: number;
  offset?: number;
}): Promise<TransferPair[]> {
  const { data } = await api.get<TransferPair[]>('/api/transfers', {
    params: {
      from: params.from,
      to: params.to,
      bank_account_id: params.bank_account_id,
      limit: params.limit ?? 200,
      offset: params.offset ?? 0,
    },
  });
  return data;
}

// --- Sync ---

export type SyncOverviewRow = {
  bank_account_id: number;
  name: string;
  iban: string | null;
  balance: string;
  currency: string;
  sync_status: string;
  balance_attempt_at: string | null;
  balance_success_at: string | null;
  transactions_attempt_at: string | null;
  transactions_success_at: string | null;
  last_error: string | null;
  day_zero_date?: string | null;
};

export async function fetchSyncOverview(): Promise<SyncOverviewRow[]> {
  const { data } = await api.get<{ accounts: SyncOverviewRow[] }>('/api/sync/overview');
  return data.accounts;
}

export type SyncAccountNeedsTan = {
  status: 'needs_transaction_tan';
  job_id: string;
  /** Fehlt bei FinTS-Zugang-Jobs (nur Konten-Sync). */
  bank_account_id: number | null;
  challenge_mime: string;
  challenge_image_base64: string;
  challenge_hint: string | null;
};

export type SyncAccountCompleted = {
  ok: true;
  status: 'completed';
  bank_account_id: number;
  job_id?: null;
};

export type SyncAccountResponse = SyncAccountCompleted | SyncAccountNeedsTan;

export async function syncAccount(bankAccountId: number): Promise<SyncAccountResponse> {
  const res = await api.post<unknown>(`/api/sync/accounts/${bankAccountId}`, undefined, {
    validateStatus: (s) => s === 200 || s === 202,
  });
  const data = res.data as Record<string, unknown>;
  if (res.status === 202 || data.status === 'needs_transaction_tan') {
    return data as SyncAccountNeedsTan;
  }
  return {
    ok: true,
    status: 'completed',
    bank_account_id: Number(data.bank_account_id),
    job_id: null,
  };
}

export type SubmitSyncTanResponse = {
  ok: boolean;
  status: string;
  bank_account_id?: number | null;
  /** FinTS-Test / Bank-Zugang nach TAN-Eingabe */
  result?: unknown;
};

export async function submitSyncTransactionTan(jobId: string, tan: string): Promise<SubmitSyncTanResponse> {
  const { data } = await api.post<SubmitSyncTanResponse>(`/api/sync/jobs/${jobId}/transaction-tan`, { tan });
  return data;
}

export async function syncAll(): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>('/api/sync/all');
  return data;
}

// --- Temporär: Backfill fehlender Felder ---

export type BackfillAllAccountsResult = {
  ok: boolean;
  accounts: Array<{
    bank_account_id: number;
    ok: boolean;
    from_date?: string | null;
    scanned_fetched?: number;
    matched_existing?: number;
    updated_rows?: number;
    error?: string;
  }>;
};

export async function backfillTransactionsAll(): Promise<BackfillAllAccountsResult> {
  const { data } = await api.post<BackfillAllAccountsResult>('/api/sync/backfill-transactions');
  return data;
}

export async function backfillTransactionsAccount(bankAccountId: number): Promise<SyncAccountResponse> {
  const res = await api.post<unknown>(`/api/sync/accounts/${bankAccountId}/backfill-transactions`, undefined, {
    validateStatus: (s) => s === 200 || s === 202,
  });
  const data = res.data as Record<string, unknown>;
  if (res.status === 202 || data.status === 'needs_transaction_tan') {
    return data as SyncAccountNeedsTan;
  }
  return {
    ok: true,
    status: 'completed',
    bank_account_id: Number(data.bank_account_id ?? bankAccountId),
    job_id: null,
  };
}

export type RecheckTransferPairsResult = {
  ok: boolean;
  accounts: number;
  candidates: number;
  pair_attempts: number;
};

export async function recheckTransferPairsAll(): Promise<RecheckTransferPairsResult> {
  const { data } = await api.post<RecheckTransferPairsResult>('/api/sync/recheck-transfer-pairs');
  return data;
}

// --- Bank-Zugänge (FinTS) ---

export type BankCredential = {
  id: number;
  user_id: number;
  provider: string;
  fints_blz: string;
  fints_user: string;
  fints_endpoint: string;
  has_pin: boolean;
  created_at: string;
  /** Nur nach POST/PATCH: Log des FinTS-Abrufs */
  fints_log?: string | null;
  /** False, wenn der Zugang ohne erfolgreiche FinTS-Prüfung gespeichert wurde */
  fints_verified_ok?: boolean;
  fints_verification_message?: string;
};

/** Alle FinTS-Zugänge des angemeldeten Nutzers (nicht an Kontogruppe gebunden). */
export async function fetchBankCredentials(): Promise<BankCredential[]> {
  const { data } = await api.get<BankCredential[]>('/api/bank-credentials');
  return data;
}

export type BankCredentialOrNeedsTan = BankCredential | SyncAccountNeedsTan;

export async function createBankCredential(body: {
  /** Kontogruppe für neu angelegte Bankkonten aus dem FinTS-Abruf */
  provision_account_group_id: number;
  provider?: string;
  fints_blz: string;
  fints_user: string;
  fints_endpoint?: string;
  pin: string;
  /** Default true: bei FinTS-Fehler/leerer SEPA-Liste Zugang trotzdem speichern (nicht verifiziert) */
  save_on_fints_failure?: boolean;
}): Promise<BankCredentialOrNeedsTan> {
  const res = await api.post<unknown>(
    '/api/bank-credentials',
    {
      provision_account_group_id: body.provision_account_group_id,
      provider: body.provider ?? 'comdirect',
      fints_blz: body.fints_blz,
      fints_user: body.fints_user,
      fints_endpoint: body.fints_endpoint ?? 'https://fints.comdirect.de/fints',
      pin: body.pin,
      save_on_fints_failure: body.save_on_fints_failure ?? true,
    },
    { validateStatus: (s) => s === 200 || s === 202 },
  );
  const data = res.data as Record<string, unknown>;
  if (res.status === 202 || data.status === 'needs_transaction_tan') {
    return data as SyncAccountNeedsTan;
  }
  return data as BankCredential;
}

export async function updateBankCredential(
  id: number,
  body: {
    /** Optional: Ziel-Kontogruppe für neu angelegte Konten; sonst aus verknüpften Bankkonten */
    provision_account_group_id?: number;
    provider?: string;
    fints_blz?: string;
    fints_user?: string;
    fints_endpoint?: string;
    /** Nur setzen, wenn eine neue PIN gespeichert werden soll */
    pin?: string;
    save_on_fints_failure?: boolean;
  },
): Promise<BankCredentialOrNeedsTan> {
  const res = await api.patch<unknown>(`/api/bank-credentials/${id}`, body, {
    validateStatus: (s) => s === 200 || s === 202,
  });
  const data = res.data as Record<string, unknown>;
  if (res.status === 202 || data.status === 'needs_transaction_tan') {
    return data as SyncAccountNeedsTan;
  }
  return data as BankCredential;
}

export async function deleteBankCredential(id: number): Promise<void> {
  await api.delete(`/api/bank-credentials/${id}`);
}

export type FintsSepaAccountOut = { iban: string; bic: string; accountnumber: string };

export type FintsTestResult = { ok: boolean; log: string; accounts: FintsSepaAccountOut[] };

export type FintsTestOrNeedsTan = FintsTestResult | SyncAccountNeedsTan;

/** Gleicher Ablauf wie fints_test.py; bei PhotoTAN HTTP 202 + transaction-tan. */
export async function runFintsConnectivityTest(body: {
  account_group_id?: number;
  provider?: string;
  fints_blz: string;
  fints_user: string;
  fints_endpoint?: string;
  pin?: string;
}): Promise<FintsTestOrNeedsTan> {
  const res = await api.post<unknown>(
    '/api/bank-credentials/fints-test',
    {
      account_group_id: body.account_group_id,
      provider: body.provider ?? 'comdirect',
      fints_blz: body.fints_blz,
      fints_user: body.fints_user,
      fints_endpoint: body.fints_endpoint ?? 'https://fints.comdirect.de/fints',
      pin: body.pin ?? '',
    },
    { validateStatus: (s) => s === 200 || s === 202 },
  );
  const data = res.data as Record<string, unknown>;
  if (res.status === 202 || data.status === 'needs_transaction_tan') {
    return data as SyncAccountNeedsTan;
  }
  return data as FintsTestResult;
}

export { AxiosError };
