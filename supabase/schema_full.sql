-- =============================================================
-- Shopify Reviews App — FULL consolidated schema
-- File: /supabase/schema_full.sql
--
-- Run this ONCE in your new project: Supabase → SQL Editor → paste → Run.
-- It is idempotent (safe to re-run) and already includes every
-- migration (002–005), the bug fix for the review generator, and the
-- session table the app needs to log in.
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1) shops — one row per installed store; gates the free tier
-- -------------------------------------------------------------
create table if not exists public.shops (
  shop_domain   text        primary key,
  installed_at  timestamptz not null default now(),
  plan_type     text        not null default 'standard'
                              check (plan_type in ('early_adopter_free','standard'))
);

-- -------------------------------------------------------------
-- 2) reviews
-- -------------------------------------------------------------
create table if not exists public.reviews (
  id              uuid        primary key default gen_random_uuid(),
  shop_domain     text        not null references public.shops(shop_domain) on delete cascade,
  product_id      text,                       -- nullable → store-wide reviews
  product_handle  text,
  title           text,
  author_name     text        not null,
  author_initials text        not null,
  author_email    text,
  author_country  text,
  author_location text,
  is_verified     boolean     not null default true,
  is_featured     boolean     not null default false,
  rating          integer     not null check (rating between 1 and 5),
  content         text        not null,
  reply           text,
  reply_at        timestamptz,
  item_type       text,
  image_urls      text[]      not null default '{}',
  video_url       text,
  status          text        not null default 'approved'
                                check (status in ('approved','pending','hidden')),
  -- NOTE: 'ai_sample' added here — the generator inserts this value.
  -- Without it, "Generate sample reviews" fails with a constraint error.
  source          text        not null default 'storefront'
                                check (source in ('storefront','csv_import','manual','ai_sample')),
  created_at      timestamptz not null default now()
);

-- If the table already existed from an older run, make sure the columns
-- and the corrected source constraint are present.
alter table public.reviews alter column product_id     drop not null;
alter table public.reviews alter column product_handle drop not null;
alter table public.reviews add column if not exists product_handle  text;
alter table public.reviews add column if not exists title           text;
alter table public.reviews add column if not exists author_email    text;
alter table public.reviews add column if not exists author_country  text;
alter table public.reviews add column if not exists author_location text;
alter table public.reviews add column if not exists is_featured     boolean not null default false;
alter table public.reviews add column if not exists reply           text;
alter table public.reviews add column if not exists reply_at        timestamptz;
alter table public.reviews add column if not exists item_type       text;
alter table public.reviews add column if not exists image_urls      text[] not null default '{}';
alter table public.reviews add column if not exists video_url       text;
alter table public.reviews add column if not exists source          text not null default 'storefront';
-- SKU grouping (migration 006): reviews can carry the SKU group directly.
alter table public.reviews add column if not exists group_key       text;

alter table public.reviews drop constraint if exists reviews_source_check;
alter table public.reviews
  add constraint reviews_source_check
  check (source in ('storefront','csv_import','manual','ai_sample'));

-- Hot-path indexes
create index if not exists idx_reviews_shop_domain     on public.reviews (shop_domain);
create index if not exists idx_reviews_product_id      on public.reviews (product_id);
create index if not exists idx_reviews_product_handle  on public.reviews (product_handle);
create index if not exists idx_reviews_shop_product_status
  on public.reviews (shop_domain, product_id, status);
create index if not exists idx_reviews_created_at      on public.reviews (created_at desc);
create index if not exists idx_reviews_source          on public.reviews (source);
create index if not exists idx_reviews_author_location on public.reviews (author_location);
create index if not exists idx_reviews_is_featured     on public.reviews (is_featured);
create index if not exists idx_reviews_store_wide
  on public.reviews (shop_domain, status)
  where product_id is null and product_handle is null;
create index if not exists idx_reviews_group_key
  on public.reviews (shop_domain, group_key);

-- -------------------------------------------------------------
-- 3) shopify_sessions — used by the app to keep you logged in
-- -------------------------------------------------------------
create table if not exists public.shopify_sessions (
  id         text        primary key,
  shop       text        not null,
  payload    jsonb       not null,
  updated_at timestamptz not null default now()
);
create index if not exists idx_shopify_sessions_shop on public.shopify_sessions (shop);

-- -------------------------------------------------------------
-- 3b) product_groups — maps each product to its SKU group so that
--     products sharing the same SKU base (e.g. "KB-50119") share
--     one pool of reviews. Filled by "Sync product groups" in admin.
-- -------------------------------------------------------------
create table if not exists public.product_groups (
  shop_domain    text        not null references public.shops(shop_domain) on delete cascade,
  product_id     text        not null,
  product_handle text,
  sku            text,
  group_key      text,
  updated_at     timestamptz not null default now(),
  primary key (shop_domain, product_id)
);
create index if not exists idx_product_groups_group
  on public.product_groups (shop_domain, group_key);
create index if not exists idx_product_groups_handle
  on public.product_groups (shop_domain, product_handle);

-- -------------------------------------------------------------
-- 4) Row Level Security
--    (the app uses the service-role key on the server, which
--     bypasses RLS — these policies only govern public access)
-- -------------------------------------------------------------
alter table public.shops            enable row level security;
alter table public.reviews          enable row level security;
alter table public.shopify_sessions enable row level security;
alter table public.product_groups   enable row level security;

drop policy if exists "Public read approved reviews" on public.reviews;
create policy "Public read approved reviews"
  on public.reviews for select
  using (status = 'approved');
-- (no public policies on shops or shopify_sessions → locked to server only)

-- -------------------------------------------------------------
-- 5) Storage bucket for review images (photo uploads)
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('review-images', 'review-images', true)
on conflict (id) do nothing;

drop policy if exists "Public read review images" on storage.objects;
create policy "Public read review images"
  on storage.objects for select
  using (bucket_id = 'review-images');

drop policy if exists "Service role uploads" on storage.objects;
create policy "Service role uploads"
  on storage.objects for insert
  with check (bucket_id = 'review-images');
