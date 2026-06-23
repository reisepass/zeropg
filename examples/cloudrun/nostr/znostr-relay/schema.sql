-- znostr-relay schema. Self-bootstrapped at boot (no external migration tool).
-- Events are stored verbatim as JSONB plus extracted columns for filtering.
-- pubkey/id are kept as lowercase hex text (not bytea) to keep filter binds simple.

create table if not exists events (
  id          text primary key,            -- 32-byte event id, lowercase hex
  pubkey      text not null,               -- 32-byte pubkey, lowercase hex
  created_at  bigint not null,             -- unix seconds
  kind        integer not null,
  content     text not null,
  sig         text not null,               -- 64-byte schnorr sig, lowercase hex
  tags        jsonb not null default '[]', -- the raw tags array
  -- d-tag value for parameterized-replaceable events (kind 30000-39999), else ''
  d_tag       text not null default '',
  first_seen  timestamptz not null default now()
);

create index if not exists events_kind_idx        on events (kind);
create index if not exists events_pubkey_idx       on events (pubkey);
create index if not exists events_created_at_idx   on events (created_at desc);
create index if not exists events_kind_created_idx on events (kind, created_at desc);
-- GIN over the raw tags for #<tag> filters (jsonb containment).
create index if not exists events_tags_gin_idx     on events using gin (tags);

-- A flat (event_id, tag_name, tag_value) projection makes #e / #p / #<x> filters
-- index-friendly without jsonb-path gymnastics. Populated by the app on insert.
create table if not exists event_tags (
  event_id  text not null references events(id) on delete cascade,
  tag_name  text not null,    -- single-letter tag name, e.g. 'e','p','t','d'
  tag_value text not null,
  primary key (event_id, tag_name, tag_value)
);
create index if not exists event_tags_lookup_idx on event_tags (tag_name, tag_value);
