-- Persist ignored contract suggestions by fingerprint per bank account.

create table if not exists contract_suggestion_ignores (
  id integer primary key autoincrement,
  bank_account_id integer not null,
  fingerprint varchar(64) not null,
  created_at datetime not null default (datetime('now')),
  constraint fk_contract_sugg_ignore_bank_account
    foreign key (bank_account_id) references bank_accounts(id) on delete cascade,
  constraint uq_contract_sugg_ignore_acc_fp unique (bank_account_id, fingerprint)
);

create index if not exists ix_contract_sugg_ignore_bank_account_id
  on contract_suggestion_ignores (bank_account_id);

