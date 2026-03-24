from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, EmailStr, Field, field_validator


class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = ""

    @field_validator("password")
    @classmethod
    def password_within_bcrypt_bytes(cls, v: str) -> str:
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Passwort darf maximal 72 Bytes lang sein (UTF-8).")
        return v


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserMeOut(BaseModel):
    email: EmailStr
    display_name: str
    all_household_transactions: bool


class UserMePatch(BaseModel):
    all_household_transactions: Optional[bool] = None
