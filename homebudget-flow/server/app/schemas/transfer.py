from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.schemas.transaction import TransactionOut


class TransferPairOut(BaseModel):
    id: int
    household_id: int
    created_at: datetime
    out_transaction: TransactionOut
    in_transaction: TransactionOut

    model_config = {"from_attributes": True}

