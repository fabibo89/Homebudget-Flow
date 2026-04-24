from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel


class EarningsDocumentOut(BaseModel):
    id: int
    owner_user_id: int
    uploaded_by_user_id: int | None = None

    file_name: str
    mime: str
    size_bytes: int
    sha256: str
    period_year: int | None = None
    period_month: int | None = None
    period_label: str = ""
    relative_path: str
    created_at: datetime


class EarningsDocumentsImportResult(BaseModel):
    imported: int
    skipped_existing: int
    items: list[EarningsDocumentOut]


class EarningsDocumentsAnalysisOut(BaseModel):
    total: int
    by_top_level: list[dict]
    by_year: list[dict]


class EarningsDocumentsTimelinePoint(BaseModel):
    year: int
    month: int
    value: float = 0.0


class EarningsDocumentsTimelineOut(BaseModel):
    metric: str
    points: list[EarningsDocumentsTimelinePoint]


class EarningsDocumentsTimelineMetricOut(BaseModel):
    id: str
    label: str
    depth: int = 0


class EarningsDocumentsTimelineBreakdownPoint(BaseModel):
    year: int
    month: int
    values: dict[str, float]  # series_id -> value


class EarningsDocumentsTimelineBreakdownSeries(BaseModel):
    id: str
    label: str
    depth: int = 0


class EarningsDocumentsTimelineBreakdownOut(BaseModel):
    metric: str
    series: list[EarningsDocumentsTimelineBreakdownSeries]
    points: list[EarningsDocumentsTimelineBreakdownPoint]


class EarningsDocumentLineOut(BaseModel):
    id: int
    document_id: int
    parent_id: int | None = None
    kind: str
    label: str
    amount: str | None = None
    currency: str
    order_index: int
