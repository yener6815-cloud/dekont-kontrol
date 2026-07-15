create table if not exists public.panel_state (
  state_key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists panel_state_updated_at_idx
on public.panel_state (updated_at desc);

alter table public.panel_state enable row level security;
