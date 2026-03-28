"""Heuristiken für Kategorie-Regel-Vorschläge aus unkategorisierten Buchungen."""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass

from app.db.models import CategoryRule, Transaction
from app.schemas.category_rule_conditions import rule_effective_conditions

TOKEN_RE = re.compile(r"[a-zäöüß0-9]+", re.IGNORECASE)

# Häufige „leere“ Wörter in Verwendungszweck / Händlernamen
_STOP_TOKENS = frozenset(
    {
        "gmbh",
        "kg",
        "ag",
        "ohg",
        "ug",
        "mbh",
        "ltd",
        "inc",
        "llp",
        "und",
        "oder",
        "von",
        "mit",
        "auf",
        "für",
        "fur",
        "aus",
        "bei",
        "per",
        "pos",
        "ref",
        "nr",
        "no",
        "id",
        "zahlung",
        "uberweisung",
        "überweisung",
        "lastschrift",
        "sepa",
        "online",
        "internet",
        "the",
        "dat",
        "end",
        "to",
        "de",
    },
)

_MIN_TOKEN_LEN = 3
_MIN_TX = 2
_MIN_DISTINCT_LABELS = 2
_MAX_SAMPLES = 5
_MAX_SUGGESTIONS = 40  # Default für max_suggestions; Pool wird per suggestion_pool_limit erhöht
_MAX_SUGGESTIONS_HARD_CAP = 500


def suggestion_pool_limit(dismissal_count: int) -> int:
    """Kandidaten vor Ignorieren-Filter: ignorierte Muster + 20, mindestens wie bisher 40, oben gedeckelt.

    So bleiben nach Filterung der ignorierten Schlüssel typischerweise noch Platz für neue aktive Vorschläge.
    """
    n = max(0, int(dismissal_count))
    return min(max(_MAX_SUGGESTIONS, n + 20), _MAX_SUGGESTIONS_HARD_CAP)


def suggestion_pattern_norm(pattern: str) -> str:
    """Gleiche Normalisierung wie beim Zusammenführen von Vorschlägen (Schlüssel für Ignorieren)."""
    return (pattern or "").strip()[:512].lower()


def _tokenize(text: str) -> list[str]:
    s = re.sub(r"[-_/.,;:]+", " ", (text or "").lower())
    return [m.group(0).lower() for m in TOKEN_RE.finditer(s)]


def _significant_tokens(text: str) -> set[str]:
    return {t for t in _tokenize(text) if len(t) >= _MIN_TOKEN_LEN and t not in _STOP_TOKENS and not t.isdigit()}


@dataclass(frozen=True)
class _SuggestionKey:
    rule_type: str
    pattern_norm: str


@dataclass
class _SuggestionAcc:
    pattern_display: str
    rule_type: str
    tx_ids: set[int]
    labels: set[str]


def _rule_already_exists(rules: list[CategoryRule], rule_type: str, pattern: str) -> bool:
    pl = pattern.strip().lower()
    if not pl:
        return True
    for r in rules:
        for cond in rule_effective_conditions(r):
            ct = getattr(cond, "type", None)
            if ct != rule_type:
                continue
            cpat = getattr(cond, "pattern", None)
            if isinstance(cpat, str) and cpat.strip().lower() == pl:
                return True
    return False


def _hypothetical_matches(tx: Transaction, rule_type: str, pattern: str) -> bool:
    needle = pattern.strip().lower()
    if not needle:
        return False
    if rule_type == "counterparty_contains":
        hay = (tx.counterparty or "").lower()
        return needle in hay
    if rule_type == "description_contains":
        hay = (tx.description or "").lower()
        return needle in hay
    return False


def compute_category_rule_suggestions(
    uncategorized: list[Transaction],
    existing_rules: list[CategoryRule],
    rule_allowed_accounts: dict[int, frozenset[int]],
    *,
    max_suggestions: int = _MAX_SUGGESTIONS,
) -> list[dict]:
    """
    Findet wiederkehrende Muster in Gegenpartei / Verwendungszweck (nur *contains*-Regeln).

    Mindestens zwei Buchungen; entweder mehrere unterschiedliche Texte mit gemeinsamem Muster oder
    derselbe Text mehrfach. Keine Vorschläge, die schon als gleichwertige Regel existieren. Nur Buchungen,
    die von keiner bestehenden Regel getroffen werden.
    """
    from app.services.category_rules import first_matching_rule_category_id

    rules = list(existing_rules)
    unmatched = [
        tx for tx in uncategorized if first_matching_rule_category_id(tx, rules, rule_allowed_accounts) is None
    ]
    acc: dict[_SuggestionKey, _SuggestionAcc] = {}

    def touch(rule_type: str, pattern_display: str, tx: Transaction, label: str) -> None:
        label = (label or "").strip()
        if len(label) < 2:
            return
        pn = suggestion_pattern_norm(pattern_display)
        if not pn:
            return
        key = _SuggestionKey(rule_type=rule_type, pattern_norm=pn)
        if key not in acc:
            acc[key] = _SuggestionAcc(
                pattern_display=pattern_display.strip()[:512],
                rule_type=rule_type,
                tx_ids=set(),
                labels=set(),
            )
        acc[key].tx_ids.add(tx.id)
        if len(acc[key].labels) < 24:
            acc[key].labels.add(label)

    # 1) Exakt gleiche Gegenpartei (normalisiert)
    cp_groups: dict[str, list[Transaction]] = defaultdict(list)
    for tx in unmatched:
        cp = (tx.counterparty or "").strip()
        if len(cp) < 2:
            continue
        cp_groups[cp.lower()].append(tx)

    for txs in cp_groups.values():
        if len(txs) < _MIN_TX:
            continue
        sample_cp = (txs[0].counterparty or "").strip()
        if _rule_already_exists(rules, "counterparty_contains", sample_cp):
            continue
        for t in txs:
            touch("counterparty_contains", sample_cp, t, (t.counterparty or "").strip())

    # 2) Token-basiert: gemeinsame Wörter in Gegenpartei (z. B. „edeka“ bei „Edeka Garching“ / „Edeka City“)
    for tx in unmatched:
        cp = (tx.counterparty or "").strip()
        if len(cp) < 2:
            continue
        for tok in _significant_tokens(cp):
            if _rule_already_exists(rules, "counterparty_contains", tok):
                continue
            if not _hypothetical_matches(tx, "counterparty_contains", tok):
                continue
            touch("counterparty_contains", tok, tx, cp)

    # 3) Gleiches für Verwendungszweck
    desc_groups: dict[str, list[Transaction]] = defaultdict(list)
    for tx in unmatched:
        d = (tx.description or "").strip()
        if len(d) < 4:
            continue
        desc_groups[d.lower()].append(tx)

    for txs in desc_groups.values():
        if len(txs) < _MIN_TX:
            continue
        sample_d = (txs[0].description or "").strip()
        if _rule_already_exists(rules, "description_contains", sample_d):
            continue
        for t in txs:
            touch("description_contains", sample_d, t, (t.description or "").strip())

    for tx in unmatched:
        d = (tx.description or "").strip()
        if len(d) < 4:
            continue
        for tok in _significant_tokens(d):
            if _rule_already_exists(rules, "description_contains", tok):
                continue
            if not _hypothetical_matches(tx, "description_contains", tok):
                continue
            touch("description_contains", tok, tx, d)

    out: list[dict] = []
    for key, a in acc.items():
        if len(a.tx_ids) < _MIN_TX:
            continue
        # Mehrere unterschiedliche Texte ODER derselbe Text bei mehreren Buchungen (z. B. wiederholter Händlername)
        if len(a.labels) < _MIN_DISTINCT_LABELS and not (len(a.labels) == 1 and len(a.tx_ids) >= _MIN_TX):
            continue
        samples = sorted(a.labels)[:_MAX_SAMPLES]
        out.append(
            {
                "rule_type": key.rule_type,
                "pattern": a.pattern_display,
                "transaction_count": len(a.tx_ids),
                "distinct_label_count": len(a.labels),
                "sample_labels": samples,
            },
        )

    out.sort(key=lambda x: (-x["transaction_count"], -x["distinct_label_count"], x["pattern"]))
    cap = max(1, min(int(max_suggestions), _MAX_SUGGESTIONS_HARD_CAP))
    return out[:cap]
