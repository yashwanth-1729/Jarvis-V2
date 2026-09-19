-- Supabase table for synced connectors (see docs/connectors.md).
--
-- Holds connector definitions and SEALED secrets only: `secret` is an
-- AES-256-GCM envelope made on the device with the user's sync passphrase
-- (frontend/src/lib/connectorCrypto.ts). The service key used by the app
-- bypasses RLS; RLS is enabled with no policies so the anon key cannot read it.

create table if not exists public.connectors (
  uid        text primary key,
  kind       text not null check (kind in ('google', 'mcp')),
  name       text not null,
  config     text not null default '{}',
  secret     text,
  deleted    boolean not null default false,
  updated_at text not null
);

alter table public.connectors enable row level security;
