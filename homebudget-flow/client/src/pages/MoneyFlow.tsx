import { type HTMLAttributes, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { useQueries, useQuery } from '@tanstack/react-query';
import '@svgdotjs/svg.js';
import { ApexSankey } from 'apexsankey';
import {
  apiErrorMessage,
  fetchAccounts,
  fetchAllTransactions,
  fetchCategories,
  fetchCategoryRules,
  fetchTransferPairs,
  type TransferPair,
  type CategoryOut,
} from '../api/client';
import { displayNameClusterForTransaction } from '../lib/categoryRuleMatching';
import {
  collectDescendantCategoryIds,
  findCategoryById,
  formatMoney,
} from '../lib/transactionUi';
import { getAppTimeZone, todayIsoInAppTimezone } from '../lib/appTimeZone';
import TransactionBookingsTable from '../components/transactions/TransactionBookingsTable';
import { CategorySymbolDisplay } from '../components/CategorySymbol';

function ensureCryptoRandomUUID() {
  const g: any = globalThis as any;
  const fallback = () => {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  // If crypto exists and already has randomUUID, we're done.
  try {
    if (g.crypto && typeof g.crypto.randomUUID === 'function') return;
  } catch {
    // ignore
  }

  // Best-effort: some environments expose `crypto` as read-only; use defineProperty where possible.
  try {
    if (!g.crypto) {
      Object.defineProperty(g, 'crypto', {
        value: {},
        configurable: true,
        enumerable: false,
        writable: true,
      });
    }
  } catch {
    // ignore: if we can't define it, we'll still try to patch existing crypto below
  }

  try {
    if (g.crypto && typeof g.crypto.randomUUID !== 'function') {
      Object.defineProperty(g.crypto, 'randomUUID', {
        value: fallback,
        configurable: true,
        enumerable: false,
        writable: true,
      });
      return;
    }
  } catch {
    // ignore
  }

  // Last resort: assignment (may fail in strict/read-only contexts).
  try {
    if (g.crypto && typeof g.crypto.randomUUID !== 'function') g.crypto.randomUUID = fallback;
  } catch {
    // ignore
  }
}

function includedAccountsKey(ids: number[] | null | undefined): string {
  if (ids == null) return 'all';
  if (ids.length === 0) return 'none';
  return [...ids].sort((a, b) => a - b).join(',');
}

type VerlaufCategoryOption = {
  key: string;
  label: string;
  colorHex: string;
  iconEmoji: string | null;
};

/** Alle Kategorie-Schlüssel im Teilbaum (Wurzel inkl.). */
function collectSubtreeKeys(node: CategoryOut): string[] {
  const keys = [`c${node.id}`];
  for (const ch of node.children ?? []) keys.push(...collectSubtreeKeys(ch));
  return keys;
}

type VerlaufPickOption =
  | { rowKind: 'none'; option: VerlaufCategoryOption }
  | { rowKind: 'parent'; option: VerlaufCategoryOption; subtreeKeys: string[] }
  | { rowKind: 'leaf'; option: VerlaufCategoryOption };

function verlaufPickRowListKey(row: VerlaufPickOption): string {
  if (row.rowKind === 'none') return '__none__';
  if (row.rowKind === 'parent') return `__parent__:${row.option.key}`;
  return row.option.key;
}

function walkCategoryPickChildren(rows: VerlaufPickOption[], node: CategoryOut, pathPrefix: string) {
  const label = pathPrefix ? `${pathPrefix} › ${node.name}` : node.name;
  const children = node.children ?? [];
  if (children.length === 0) {
    rows.push({
      rowKind: 'leaf',
      option: {
        key: `c${node.id}`,
        label,
        colorHex: node.effective_color_hex,
        iconEmoji: node.icon_emoji,
      },
    });
    return;
  }
  rows.push({
    rowKind: 'parent',
    option: {
      key: `c${node.id}`,
      label,
      colorHex: node.effective_color_hex,
      iconEmoji: node.icon_emoji,
    },
    subtreeKeys: collectSubtreeKeys(node),
  });
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  for (const ch of sorted) walkCategoryPickChildren(rows, ch, label);
}

function buildVerlaufPickOptions(roots: CategoryOut[], noneOption: VerlaufCategoryOption): VerlaufPickOption[] {
  const rows: VerlaufPickOption[] = [{ rowKind: 'none', option: noneOption }];
  const sortedRoots = [...roots].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  for (const root of sortedRoots) {
    const children = root.children ?? [];
    if (children.length === 0) {
      rows.push({
        rowKind: 'leaf',
        option: {
          key: `c${root.id}`,
          label: root.name,
          colorHex: root.effective_color_hex,
          iconEmoji: root.icon_emoji,
        },
      });
      continue;
    }
    rows.push({
      rowKind: 'parent',
      option: {
        key: `c${root.id}`,
        label: root.name,
        colorHex: root.effective_color_hex,
        iconEmoji: root.icon_emoji,
      },
      subtreeKeys: collectSubtreeKeys(root),
    });
    const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const ch of sorted) walkCategoryPickChildren(rows, ch, root.name);
  }
  return rows;
}

function parseIsoDate(s: string): Date {
  // Input comes from `<input type="date">` -> YYYY-MM-DD
  return new Date(`${s}T12:00:00Z`);
}

function addDays(iso: string, delta: number): string {
  const d = parseIsoDate(iso);
  d.setUTCDate(d.getUTCDate() + delta);
  // Keep YYYY-MM-DD for stable string comparisons / API params.
  return d.toISOString().slice(0, 10);
}

type EdgeKind = 'transfer' | 'expense';

type ExpenseGroup = {
  kind: 'expense';
  fromAccountId: number;
  categoryId: number | null;
  categoryRoot: string;
  categorySub: string;
  ruleClusterKey: string;
  ruleLabel: string;
  totalAbs: number;
  txIds: number[];
};

type TransferGroup = {
  kind: 'transfer';
  fromAccountId: number;
  toAccountId: number;
  totalAbs: number;
  pairIds: number[];
};

function flattenCategoryNodes(roots: CategoryOut[]): CategoryOut[] {
  const out: CategoryOut[] = [];
  const walk = (n: CategoryOut) => {
    out.push(n);
    for (const ch of n.children ?? []) walk(ch);
  };
  for (const r of roots) walk(r);
  return out;
}

function resolveCategoryRootAndSub(
  categoryId: number | null,
  nodeById: Map<number, CategoryOut>,
): { root: string; sub: string } {
  if (categoryId == null) return { root: 'Ohne Kategorie', sub: '—' };
  const leaf = nodeById.get(categoryId);
  if (!leaf) return { root: 'Kategorie (unbekannt)', sub: String(categoryId) };

  const chain: CategoryOut[] = [];
  let cur: CategoryOut | undefined = leaf;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.push(cur);
    if (cur.parent_id == null) break;
    cur = nodeById.get(cur.parent_id);
  }

  // chain: [leaf, ..., root] (unless graph is broken)
  const rootNode = chain[chain.length - 1];
  const rootName = rootNode?.name ?? leaf.name;

  // Direct child of root if available, else leaf.
  const childUnderRoot = chain.length >= 2 ? chain[chain.length - 2] : leaf;
  const subName = childUnderRoot?.name ?? leaf.name;
  return { root: rootName, sub: subName };
}

function formatMoneyAbs(amountAbs: number, currency: string): string {
  return formatMoney(String(amountAbs), currency);
}

type MoneyFlowProps = {
  /** Optional: embed into another page with shared filters. */
  embedded?: boolean;
  /** Optional: controlled range when embedded. */
  from?: string;
  to?: string;
  /** Optional: account filter (null = all visible; [] = none). */
  includedAccountIds?: number[] | null;
};

export default function MoneyFlow(props: MoneyFlowProps) {
  const tz = getAppTimeZone();
  const today = useMemo(() => todayIsoInAppTimezone(), []);
  const defaultFrom = useMemo(() => addDays(today, -30), [today]);
  const [localFrom, setLocalFrom] = useState(defaultFrom);
  const [localTo, setLocalTo] = useState(today);
  const [kategorienSelectedKeys, setKategorienSelectedKeys] = useState<string[]>([]);

  const from = props.from ?? localFrom;
  const to = props.to ?? localTo;
  const embedded = props.embedded === true;
  const includedIds = props.includedAccountIds;
  const includedSig = includedAccountsKey(includedIds);

  const rangeOk = from <= to;

  const accountsQ = useQuery({
    queryKey: ['moneyflow-accounts'],
    queryFn: fetchAccounts,
  });

  const txsQ = useQuery({
    queryKey: ['moneyflow-transactions', from, to, includedSig],
    queryFn: () => fetchAllTransactions({ from, to }),
    enabled: rangeOk,
  });

  const transfersQ = useQuery({
    queryKey: ['moneyflow-transfers', from, to, includedSig],
    queryFn: () => fetchTransferPairs({ from, to, limit: 2000 }),
    enabled: rangeOk,
  });

  const householdIds = useMemo(() => {
    const acc = accountsQ.data ?? [];
    return [...new Set(acc.map((a) => a.household_id))].sort((a, b) => a - b);
  }, [accountsQ.data]);

  const categoriesQueries = useQueries({
    queries: householdIds.map((hid) => ({
      queryKey: ['moneyflow-categories', hid],
      queryFn: () => fetchCategories(hid),
      enabled: householdIds.length > 0,
    })),
  });

  const categoryRulesQueries = useQueries({
    queries: householdIds.map((hid) => ({
      queryKey: ['moneyflow-category-rules', hid],
      queryFn: () => fetchCategoryRules(hid),
      enabled: householdIds.length > 0,
    })),
  });

  const categoriesByHousehold = useMemo(() => {
    const out = new Map<number, CategoryOut[]>();
    for (let i = 0; i < householdIds.length; i++) {
      const hid = householdIds[i];
      const q = categoriesQueries[i];
      if (hid == null || !q?.data) continue;
      out.set(hid, q.data);
    }
    return out;
  }, [categoriesQueries, householdIds]);

  const rulesByHousehold = useMemo(() => {
    // Map household_id -> list of category rules.
    const out = new Map<number, any[]>();
    for (let i = 0; i < householdIds.length; i++) {
      const hid = householdIds[i];
      const q = categoryRulesQueries[i];
      if (hid == null || !q?.data) continue;
      out.set(hid, (q.data as any).rules ?? []);
    }
    return out;
  }, [categoryRulesQueries, householdIds]);

  const accountById = useMemo(() => {
    const out = new Map<number, { name: string; currency: string; household_id: number }>();
    for (const a of accountsQ.data ?? []) out.set(a.id, { name: a.name, currency: a.currency, household_id: a.household_id });
    return out;
  }, [accountsQ.data]);

  const includedSet = useMemo(() => {
    if (includedIds == null) return null;
    return new Set(includedIds);
  }, [includedSig]);

  const scopedTransactions = useMemo(() => {
    const all = txsQ.data ?? [];
    if (includedSet == null) return all;
    if (includedSet.size === 0) return [];
    return all.filter((t) => includedSet.has(t.bank_account_id));
  }, [txsQ.data, includedSet]);

  const scopedTransferPairs = useMemo(() => {
    const all = transfersQ.data ?? [];
    if (includedSet == null) return all;
    if (includedSet.size === 0) return [];
    return all.filter(
      (p) =>
        includedSet.has(p.out_transaction.bank_account_id) ||
        includedSet.has(p.in_transaction.bank_account_id),
    );
  }, [transfersQ.data, includedSet]);

  const nodeByHousehold = useMemo(() => {
    const out = new Map<number, Map<number, CategoryOut>>();
    for (const [hid, roots] of categoriesByHousehold.entries()) {
      const m = new Map<number, CategoryOut>();
      for (const n of flattenCategoryNodes(roots)) m.set(n.id, n);
      out.set(hid, m);
    }
    return out;
  }, [categoriesByHousehold]);

  const mergedCategoryRoots = useMemo(() => {
    const out: CategoryOut[] = [];
    for (const roots of categoriesByHousehold.values()) out.push(...roots);
    return out;
  }, [categoriesByHousehold]);

  const verlaufPickOptions = useMemo(() => {
    const noneOpt: VerlaufCategoryOption = {
      key: '__none__',
      label: 'Ohne Kategorie',
      colorHex: '#6b7280',
      iconEmoji: null,
    };
    return buildVerlaufPickOptions(mergedCategoryRoots, noneOpt);
  }, [mergedCategoryRoots]);

  const kategorienAutocompletePickValue = useMemo(() => {
    if (kategorienSelectedKeys.length === 0) return [] as VerlaufPickOption[];
    const out: VerlaufPickOption[] = [];
    for (const row of verlaufPickOptions) {
      if (row.rowKind === 'parent') continue;
      if (row.rowKind === 'none') {
        if (kategorienSelectedKeys.includes('__none__')) out.push(row);
      } else if (kategorienSelectedKeys.includes(row.option.key)) {
        out.push(row);
      }
    }
    return out;
  }, [verlaufPickOptions, kategorienSelectedKeys]);

  const keysWithSpendInMoneyFlow = useMemo(() => {
    const out = new Set<string>();
    for (const tx of scopedTransactions ?? []) {
      const amt = Number(tx.amount);
      if (!Number.isFinite(amt) || amt >= 0) continue;
      // Exclude internal transfer outgoing legs (those are shown as account→account edges).
      if (tx.transfer_target_bank_account_id != null) continue;
      if (tx.category_id == null) out.add('__none__');
      else out.add(`c${tx.category_id}`);
    }
    return Array.from(out).sort();
  }, [scopedTransactions]);

  const categoryFilterIds = useMemo(() => {
    // Empty selection => no filter (show all)
    if (kategorienSelectedKeys.length === 0) return null;
    const ids = new Set<number>();
    for (const k of kategorienSelectedKeys) {
      if (!k.startsWith('c')) continue;
      const id = Number(k.slice(1));
      if (!Number.isFinite(id)) continue;
      const node = findCategoryById(mergedCategoryRoots, id);
      if (!node) continue;
      for (const cid of collectDescendantCategoryIds(node)) ids.add(cid);
    }
    return ids;
  }, [mergedCategoryRoots, kategorienSelectedKeys]);

  function toggleKategorienSubtree(subtreeKeys: string[]) {
    if (!subtreeKeys.length) return;
    const allOn = subtreeKeys.every((k) => kategorienSelectedKeys.includes(k));
    const next = new Set(kategorienSelectedKeys);
    if (allOn) subtreeKeys.forEach((k) => next.delete(k));
    else subtreeKeys.forEach((k) => next.add(k));
    setKategorienSelectedKeys([...next].sort());
  }

  const expenseGroupsAll = useMemo<ExpenseGroup[]>(() => {
    const txs = scopedTransactions;
    if (!accountsQ.data) return [];

    const groups = new Map<string, ExpenseGroup>();

    for (const tx of txs) {
      const amt = Number(tx.amount);
      if (!Number.isFinite(amt)) continue;
      if (!(amt < 0)) continue;

      // Exclude internal transfer outgoing legs: those have a target account set.
      if (tx.transfer_target_bank_account_id != null) continue;

      // Optional category filter (root/subcategory selection).
      if (categoryFilterIds) {
        if (tx.category_id == null) {
          if (!kategorienSelectedKeys.includes('__none__')) continue;
          // keep uncategorized
        } else if (!categoryFilterIds.has(tx.category_id)) continue;
      }

      const acc = accountById.get(tx.bank_account_id);
      if (!acc) continue;
      const hid = acc.household_id;
      const rulesSorted = (rulesByHousehold.get(hid) ?? []).slice().sort((a: any, b: any) => b.id - a.id);
      const matched = displayNameClusterForTransaction(tx, rulesSorted);

      const nodeMap = nodeByHousehold.get(hid) ?? new Map<number, CategoryOut>();
      const resolved = resolveCategoryRootAndSub(tx.category_id ?? null, nodeMap);

      const categoryRoot = resolved.root;
      const categorySub = resolved.sub;

      const key = `expense|${tx.bank_account_id}|${tx.category_id ?? '__none__'}|${matched.clusterKey}`;
      const totalAbs = Math.abs(amt);
      const prev = groups.get(key);
      if (prev) {
        prev.totalAbs += totalAbs;
        prev.txIds.push(tx.id);
      } else {
        groups.set(key, {
          kind: 'expense',
          fromAccountId: tx.bank_account_id,
          categoryId: tx.category_id ?? null,
          categoryRoot,
          categorySub,
          ruleClusterKey: matched.clusterKey,
          ruleLabel: matched.label,
          totalAbs,
          txIds: [tx.id],
        });
      }
    }
    return Array.from(groups.values());
  }, [
    scopedTransactions,
    accountsQ.data,
    accountById,
    rulesByHousehold,
    nodeByHousehold,
    categoryFilterIds,
    kategorienSelectedKeys,
  ]);

  const transferGroupsAll = useMemo<TransferGroup[]>(() => {
    const pairs = scopedTransferPairs;
    const groups = new Map<string, TransferGroup>();
    for (const p of pairs) {
      const outTx = p.out_transaction;
      const inTx = p.in_transaction;
      const amt = Number(outTx.amount);
      if (!Number.isFinite(amt)) continue;
      const fromAccountId = outTx.bank_account_id;
      const toAccountId = inTx.bank_account_id;
      const key = `transfer|${fromAccountId}|${toAccountId}`;
      const prev = groups.get(key);
      const totalAbs = Math.abs(amt);
      if (prev) {
        prev.totalAbs += totalAbs;
        prev.pairIds.push(p.id);
      } else {
        groups.set(key, { kind: 'transfer', fromAccountId, toAccountId, totalAbs, pairIds: [p.id] });
      }
    }
    return Array.from(groups.values());
  }, [scopedTransferPairs]);

  const MAX_TRANSFER_EDGES = 10;
  const MAX_EXPENSE_EDGES = 12;

  const transferGroupsTop = useMemo(() => {
    const sorted = transferGroupsAll.slice().sort((a, b) => b.totalAbs - a.totalAbs);
    return sorted.slice(0, MAX_TRANSFER_EDGES);
  }, [transferGroupsAll]);

  const expenseGroupsTop = useMemo(() => {
    const sorted = expenseGroupsAll.slice().sort((a, b) => b.totalAbs - a.totalAbs);
    return sorted.slice(0, MAX_EXPENSE_EDGES);
  }, [expenseGroupsAll]);

  const hiddenTransferCount = Math.max(0, transferGroupsAll.length - transferGroupsTop.length);
  const hiddenExpenseCount = Math.max(0, expenseGroupsAll.length - expenseGroupsTop.length);

  const [selected, setSelected] = useState<{
    kind: EdgeKind;
    key: string;
  } | null>(null);

  const selectedExpenseGroup = useMemo(() => {
    if (!selected || selected.kind !== 'expense') return null;
    return expenseGroupsTop.find((g) => `expense|${g.fromAccountId}|${g.categoryId ?? '__none__'}|${g.ruleClusterKey}` === selected.key) ?? null;
  }, [selected, expenseGroupsTop]);

  const selectedTransferGroup = useMemo(() => {
    if (!selected || selected.kind !== 'transfer') return null;
    return (
      transferGroupsTop.find((g) => `transfer|${g.fromAccountId}|${g.toAccountId}` === selected.key) ?? null
    );
  }, [selected, transferGroupsTop]);

  const txsForSelectedExpense = useMemo(() => {
    if (!selectedExpenseGroup) return [];
    const idSet = new Set(selectedExpenseGroup.txIds);
    return (scopedTransactions ?? [])
      .filter((t) => idSet.has(t.id))
      .slice()
      .sort((a, b) => b.booking_date.localeCompare(a.booking_date) || b.id - a.id);
  }, [selectedExpenseGroup, scopedTransactions]);

  const txsForSelectedTransfer = useMemo(() => {
    if (!selectedTransferGroup) return [];
    const pairIdSet = new Set(selectedTransferGroup.pairIds);
    const rows: TransferPair['out_transaction'][] = [];
    for (const p of scopedTransferPairs ?? []) {
      if (!pairIdSet.has(p.id)) continue;
      rows.push(p.out_transaction, p.in_transaction);
    }
    return rows
      .slice()
      .sort((a, b) => b.booking_date.localeCompare(a.booking_date) || b.id - a.id);
  }, [selectedTransferGroup, scopedTransferPairs]);

  const loading =
    accountsQ.isLoading ||
    txsQ.isLoading ||
    transfersQ.isLoading ||
    categoriesQueries.some((q) => q.isLoading) ||
    categoryRulesQueries.some((q) => q.isLoading);

  const error =
    accountsQ.error ||
    txsQ.error ||
    transfersQ.error ||
    categoriesQueries.find((q) => q.isError)?.error ||
    categoryRulesQueries.find((q) => q.isError)?.error;

  const accountLabel = (id: number) => accountById.get(id)?.name ?? `#${id}`;
  const currencyForAccount = (id: number) => accountById.get(id)?.currency ?? 'EUR';

  // --- Sankey (hooks must run before any early return — Rules of Hooks)
  type SankeyNode = { id: string; title: string; color?: string };
  type SankeyEdge = { source: string; target: string; value: number; type?: string };

  /** Ein Diagramm: Umbuchungen Konto→Konto und Ausgaben Konto→Kategorie→Unterkategorie→Regel. */
  const sankeyCombinedData = useMemo(() => {
    const nodes = new Map<string, SankeyNode>();
    const edges: SankeyEdge[] = [];
    const accNodeId = (id: number) => `acc:${id}`;

    transferGroupsTop.forEach((g, i) => {
      const fromId = accNodeId(g.fromAccountId);
      const toId = accNodeId(g.toAccountId);
      nodes.set(fromId, { id: fromId, title: `🏦 ${accountLabel(g.fromAccountId)}`, color: '#38bdf8' });
      nodes.set(toId, { id: toId, title: `🏦 ${accountLabel(g.toAccountId)}`, color: '#7dd3fc' });
      edges.push({
        source: fromId,
        target: toId,
        value: Number(g.totalAbs.toFixed(2)),
        // `type` is used as multigraph edge-name (must be unique per edge).
        // We also encode a stable selection key to map clicks back to a group.
        type: `tr|${g.fromAccountId}|${g.toAccountId}|${i}`,
      });
    });

    expenseGroupsTop.forEach((g, i) => {
      const aId = accNodeId(g.fromAccountId);
      const isUncategorized = g.categoryId == null;
      // For "Ohne Kategorie", keep nodes account-specific (no aggregation across accounts).
      // And: no subcategory / no rule layer. Path ends at "Keine Kategorie".
      const rootId = isUncategorized ? `root:uncat:${g.fromAccountId}` : `root:${g.categoryRoot}`;
      const subId = isUncategorized ? `sub:uncat:${g.fromAccountId}` : `sub:${g.categoryRoot}>>${g.categorySub}`;
      const ruleId = `rule:${g.ruleClusterKey}>>${g.ruleLabel}`;
      nodes.set(aId, { id: aId, title: `🏦 ${accountLabel(g.fromAccountId)}`, color: '#4aa3ff' });
      nodes.set(rootId, {
        id: rootId,
        title: isUncategorized ? '📁 Keine Kategorie' : `📁 ${g.categoryRoot}`,
        color: '#22c55e',
      });
      if (!isUncategorized) {
        nodes.set(subId, {
          id: subId,
          title: `🏷️ ${g.categorySub}`,
          color: '#a3e635',
        });
        nodes.set(ruleId, {
          id: ruleId,
          title: `🔎 ${g.ruleLabel}`,
          color: '#c084fc',
        });
      }
      const v = Number(g.totalAbs.toFixed(2));
      const groupKey = `expense|${g.fromAccountId}|${g.categoryId ?? '__none__'}|${g.ruleClusterKey}`;
      edges.push({ source: aId, target: rootId, value: v, type: `ex|${groupKey}|a|${i}` });
      if (!isUncategorized) {
        edges.push({ source: rootId, target: subId, value: v, type: `ex|${groupKey}|b|${i}` });
        edges.push({ source: subId, target: ruleId, value: v, type: `ex|${groupKey}|c|${i}` });
      }
    });

    return {
      nodes: Array.from(nodes.values()),
      edges,
      options: { alignLinkTypes: true } as any,
    };
  }, [transferGroupsTop, expenseGroupsTop, accountById]);

  const sankeyRef = useRef<HTMLDivElement | null>(null);
  const sankeyInstanceRef = useRef<any>(null);

  useEffect(() => {
    if (error) return;
    const el = sankeyRef.current;
    if (!el) return;
    // Reset container & destroy previous instance if possible.
    try {
      sankeyInstanceRef.current?.graph?.a11yHelper?.destroy?.();
      sankeyInstanceRef.current?.graph?.destroy?.();
      sankeyInstanceRef.current?.destroy?.();
    } catch {
      // ignore best-effort cleanup
    }
    el.innerHTML = '';

    const data = sankeyCombinedData;
    if (!data.edges.length || !data.nodes.length) return;

    const width = Math.max(860, el.clientWidth || 860);
    const nodeCount = data.nodes.length;
    const height = Math.min(980, Math.max(540, 380 + nodeCount * 14));

    ensureCryptoRandomUUID();
    const sankey = new ApexSankey(el, {
      width,
      height,
      canvasStyle: 'background: transparent;',
      spacing: 40,
      nodeWidth: 18,
      edgeOpacity: 0.5,
      edgeGradientFill: true,
      enableTooltip: true,
      tooltipTemplate: ({ source, target, value }: { source?: any; target?: any; value?: number }) => {
        const s = source?.title ?? '—';
        const t = target?.title ?? '—';
        const v = Number(value ?? 0);
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;">
            <span style="font-weight:600;">${s}</span>
            <span style="opacity:0.6;">→</span>
            <span style="font-weight:600;">${t}</span>
            <span style="opacity:0.6;">·</span>
            <span style="font-weight:700;">${formatMoneyAbs(Math.abs(v), 'EUR')}</span>
          </div>
        `;
      },
      nodeTooltipTemplate: ({ node, value }: { node?: any; value?: number }) => {
        const n = node?.title ?? '—';
        const v = Number(value ?? 0);
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;">
            <span style="font-weight:600;">${n}</span>
            <span style="opacity:0.6;">·</span>
            <span style="font-weight:700;">${formatMoneyAbs(Math.abs(v), 'EUR')}</span>
          </div>
        `;
      },
      fontColor: '#e5e7eb',
      fontSize: '12px',
      onNodeClick: (node: any) => {
        const id = node?.data?.id as string | undefined;
        if (!id) return;
        // Node click selects related bookings if possible.
        // Currently we only map edges to groups; for node clicks we clear selection.
        setSelected(null);
      },
    } as any);
    sankeyInstanceRef.current = sankey;
    sankey.render(data as any);

    // Wire up click handlers for edges (shows bookings below).
    const edgeEls = Array.from(el.querySelectorAll<SVGPathElement>('path[data-edge-source][data-edge-target]'));
    const onEdgeClick = (evt: Event) => {
      const path = evt.currentTarget as SVGPathElement;
      const name = path.getAttribute('data-edge-name') ?? '';
      if (name.startsWith('tr|')) {
        const parts = name.split('|');
        const from = Number(parts[1]);
        const to = Number(parts[2]);
        if (!Number.isFinite(from) || !Number.isFinite(to)) return;
        setSelected({ kind: 'transfer', key: `transfer|${from}|${to}` });
        return;
      }
      if (name.startsWith('ex|')) {
        // ex|expense|from|cat|ruleKey|a|i
        // We encoded as: ex|${groupKey}|a|${i} and groupKey already starts with "expense|..."
        const match = name.match(/^ex\|(expense\|.+)\|[abc]\|\d+$/);
        if (!match) return;
        setSelected({ kind: 'expense', key: match[1] });
      }
    };
    edgeEls.forEach((p) => p.addEventListener('click', onEdgeClick));

    return () => {
      edgeEls.forEach((p) => p.removeEventListener('click', onEdgeClick));
    };
  }, [error, sankeyCombinedData]);

  if (loading && !accountsQ.data) {
    return (
      <Stack spacing={2} sx={{ p: 1 }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (error) {
    return <Alert severity="error">{apiErrorMessage(error)}</Alert>;
  }

  return (
    <Stack spacing={2}>
      {!embedded ? (
        <Box>
          <Typography variant="h5" fontWeight={700} gutterBottom>
            Geldfluss
          </Typography>
          <Typography color="text.secondary" variant="body2">
            Zeitraum {from}–{to} ({tz}). Ein Diagramm: Umbuchungen zwischen Konten + Ausgabenfluss Konto → Kategorie → Unterkategorie
            → Regel (erste Trefferregel wie in den Analysen). Umbuchungs-Buchungen werden nicht mehr als „Ohne Kategorie“ gezählt.
          </Typography>
        </Box>
      ) : (
        <Typography color="text.secondary" variant="body2">
          Zeitraum {from}–{to} ({tz}). Ein Diagramm: Umbuchungen zwischen Konten + Ausgabenfluss Konto → Kategorie → Unterkategorie →
          Regel (erste Trefferregel wie in den Analysen). Umbuchungs-Buchungen werden nicht mehr als „Ohne Kategorie“ gezählt.
        </Typography>
      )}

      {!embedded ? (
        <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
              <Typography variant="body2" color="text.secondary">
                Schnellwahl
              </Typography>
              <ButtonGroup size="small" variant="outlined">
                <Button onClick={() => setLocalFrom(addDays(today, -7))}>7 Tage</Button>
                <Button onClick={() => setLocalFrom(addDays(today, -30))}>30 Tage</Button>
                <Button onClick={() => setLocalFrom(addDays(today, -90))}>90 Tage</Button>
                <Button
                  onClick={() => {
                    const t = parseIsoDate(today);
                    const start = `${t.getUTCFullYear()}-01-01`;
                    setLocalFrom(start);
                    setLocalTo(today);
                  }}
                >
                  YTD
                </Button>
                <Button
                  onClick={() => {
                    setLocalFrom(addDays(today, -(365 - 1)));
                    setLocalTo(today);
                  }}
                >
                  1 Jahr
                </Button>
              </ButtonGroup>
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
              <TextField
                size="small"
                label="Von"
                type="date"
                value={from}
                onChange={(e) => setLocalFrom(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                size="small"
                label="Bis"
                type="date"
                value={to}
                onChange={(e) => setLocalTo(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
              {!rangeOk ? <Alert severity="warning">Bitte „Von“ vor oder gleich „Bis“ wählen.</Alert> : null}
            </Stack>
          </Stack>
        </Paper>
      ) : null}

      <Paper elevation={0} sx={{ p: 2, border: 1, borderColor: 'divider' }}>
        <Stack spacing={1} sx={{ mb: 1 }}>
          <Typography variant="subtitle2" fontWeight={700}>
            Sankey
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Umbuchungen (türkise Kanten zwischen Konten) und Ausgaben (blau → grün → lila) in einer Ansicht. Top{' '}
            {transferGroupsTop.length} Umbuchungen, Top {expenseGroupsTop.length} Ausgaben-Gruppen.
            {hiddenTransferCount > 0 ? ` ${hiddenTransferCount} weitere Umbuchungen` : ''}
            {hiddenExpenseCount > 0 ? ` · ${hiddenExpenseCount} weitere Ausgaben-Gruppen` : ''}.
          </Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
            <Autocomplete<VerlaufPickOption, true, false, false>
              multiple
              size="small"
              disableCloseOnSelect
              options={verlaufPickOptions}
              getOptionLabel={(row) => row.option.label}
              isOptionEqualToValue={(opt, val) => verlaufPickRowListKey(opt) === verlaufPickRowListKey(val)}
              value={kategorienAutocompletePickValue}
              onChange={(_, newRows) => {
                const keys = newRows
                  .filter((r) => r.rowKind === 'none' || r.rowKind === 'leaf')
                  .map((r) => r.option.key)
                  .filter((k) => typeof k === 'string' && k.length > 0);
                setKategorienSelectedKeys([...new Set(keys)].sort());
              }}
              renderOption={(props, row, { selected }) => {
                if (row.rowKind === 'parent') {
                  const sk = row.subtreeKeys;
                  const allOn = sk.length > 0 && sk.every((k) => kategorienSelectedKeys.includes(k));
                  const someOn = sk.some((k) => kategorienSelectedKeys.includes(k));
                  const { key: _liKey, onMouseDown: _omd, ...liProps } = props as HTMLAttributes<HTMLLIElement> & {
                    key?: string;
                  };
                  return (
                    <Box
                      key={verlaufPickRowListKey(row)}
                      component="li"
                      {...liProps}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleKategorienSubtree(sk);
                      }}
                      sx={{
                        ...((liProps as { sx?: object }).sx as object),
                        cursor: 'pointer',
                        listStyle: 'none',
                      }}
                    >
                      <Stack direction="row" alignItems="center" spacing={1} sx={{ width: '100%', py: 0.25, pl: 0.5 }}>
                        <Checkbox
                          size="small"
                          checked={allOn}
                          indeterminate={someOn && !allOn}
                          tabIndex={-1}
                          sx={{ p: 0.25, pointerEvents: 'none' }}
                        />
                        <Box
                          sx={{
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            bgcolor: row.option.colorHex,
                            flexShrink: 0,
                            border: 1,
                            borderColor: 'divider',
                          }}
                        />
                        <CategorySymbolDisplay value={row.option.iconEmoji} fontSize="1.15rem" />
                        <Typography variant="subtitle2" fontWeight={600}>
                          {row.option.label}
                        </Typography>
                        {someOn && !allOn ? (
                          <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                            (Teilauswahl)
                          </Typography>
                        ) : null}
                      </Stack>
                    </Box>
                  );
                }
                const opt = row.option;
                const leafSelected =
                  selected ||
                  (row.rowKind === 'none'
                    ? kategorienSelectedKeys.includes('__none__')
                    : kategorienSelectedKeys.includes(opt.key));
                const { key: _lk, ...leafLiProps } = props as HTMLAttributes<HTMLLIElement> & { key?: string };
                const indentSub = row.rowKind === 'leaf' && row.option.label.includes(' › ');
                return (
                  <li key={verlaufPickRowListKey(row)} {...leafLiProps}>
                    <Stack
                      direction="row"
                      alignItems="center"
                      spacing={1}
                      sx={{ width: '100%', pl: indentSub ? 2.5 : 0.5 }}
                    >
                      <Checkbox size="small" checked={leafSelected} sx={{ p: 0.25 }} />
                      <Box
                        sx={{
                          width: 10,
                          height: 10,
                          borderRadius: '50%',
                          bgcolor: opt.colorHex,
                          flexShrink: 0,
                          border: 1,
                          borderColor: 'divider',
                        }}
                      />
                      <CategorySymbolDisplay value={opt.iconEmoji} fontSize="1.15rem" />
                      <Typography variant="body2">{opt.label}</Typography>
                    </Stack>
                  </li>
                );
              }}
              renderTags={(tagValue, getTagProps) =>
                tagValue.map((row, index) => {
                  const option = row.option;
                  return (
                    <Chip
                      {...getTagProps({ index })}
                      key={verlaufPickRowListKey(row)}
                      size="small"
                      variant="outlined"
                      sx={{
                        borderColor: option.colorHex,
                        bgcolor: alpha(option.colorHex, 0.14),
                        '& .MuiChip-label': { px: 0.75 },
                      }}
                      label={
                        <Stack direction="row" alignItems="center" spacing={0.5}>
                          <Box
                            sx={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              bgcolor: option.colorHex,
                              flexShrink: 0,
                              border: 1,
                              borderColor: 'divider',
                            }}
                          />
                          <CategorySymbolDisplay value={option.iconEmoji} fontSize="1.0rem" />
                          <span>{option.label}</span>
                        </Stack>
                      }
                    />
                  );
                })
              }
              renderInput={(params) => <TextField {...params} label="Kategorien im Diagramm" placeholder="Alle" />}
              sx={{ minWidth: 320, flex: 2 }}
            />
            <Button
              size="small"
              variant="outlined"
              onClick={() => setKategorienSelectedKeys(keysWithSpendInMoneyFlow)}
              disabled={keysWithSpendInMoneyFlow.length === 0}
            >
              Alle mit Ausgaben
            </Button>
          </Stack>
        </Stack>

        {sankeyCombinedData.edges.length === 0 ? (
          <Alert severity="info">Keine Umbuchungen und keine Ausgaben-Gruppen im Zeitraum.</Alert>
        ) : (
          <Box ref={sankeyRef} sx={{ width: '100%', minHeight: 400, overflowX: 'auto' }} />
        )}

        {selectedTransferGroup ? (
          <Paper elevation={0} sx={{ mt: 2, p: 2, border: 1, borderColor: 'divider' }}>
            <Stack spacing={1.2}>
              <Typography variant="subtitle2" fontWeight={700}>
                Umbuchung: {accountLabel(selectedTransferGroup.fromAccountId)} → {accountLabel(selectedTransferGroup.toAccountId)}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Summe:{' '}
                <strong>
                  {formatMoneyAbs(selectedTransferGroup.totalAbs, currencyForAccount(selectedTransferGroup.fromAccountId))}
                </strong>{' '}
                · Paare: {selectedTransferGroup.pairIds.length}
              </Typography>
              <TransactionBookingsTable
                rows={txsForSelectedTransfer}
                accounts={accountsQ.data ?? []}
                emptyMessage="Keine Buchungen in dieser Umbuchung (im gewählten Filter)."
                hideInlineHint
              />
            </Stack>
          </Paper>
        ) : null}

        {selectedExpenseGroup ? (
          <Paper elevation={0} sx={{ mt: 2, p: 2, border: 1, borderColor: 'divider' }}>
            <Stack spacing={1.2}>
              <Typography variant="subtitle2" fontWeight={700}>
                Ausgabe: {accountLabel(selectedExpenseGroup.fromAccountId)} → {selectedExpenseGroup.categoryRoot} /{' '}
                {selectedExpenseGroup.categorySub}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Regel: <strong>{selectedExpenseGroup.ruleLabel}</strong> · Summe: <strong>{formatMoneyAbs(selectedExpenseGroup.totalAbs, currencyForAccount(selectedExpenseGroup.fromAccountId))}</strong> · Buchungen:{' '}
                {selectedExpenseGroup.txIds.length}
              </Typography>
              <TransactionBookingsTable
                rows={txsForSelectedExpense}
                accounts={accountsQ.data ?? []}
                emptyMessage="Keine Buchungen in dieser Gruppe (im gewählten Filter)."
                hideInlineHint
              />
            </Stack>
          </Paper>
        ) : null}
      </Paper>
    </Stack>
  );
}

