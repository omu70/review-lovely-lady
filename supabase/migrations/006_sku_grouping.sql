-- =============================================================
-- 006 — SKU-based review grouping
--
-- Goal: products whose SKU shares the same base code (the part
-- BEFORE the first space) share ONE pool of reviews.
--   "KB-50119 BL-34"  ->  group_key = "kb-50119"
--   "KB-50119 OF-32"  ->  group_key = "kb-50119"   (same pool)
--   "KB-50200 RD-10"  ->  group_key = "kb-50200"   (separate pool)
--
-- Run this ONCE in Supabase → SQL Editor. It is idempotent.
-- After running it, open the app admin and click
-- "Sync product groups" once so the mapping below is filled in
-- from your Shopify catalogue.
-- =============================================================

-- 1) A group_key on reviews. Optional — lets a review be tagged
--    with its SKU group directly (e.g. CSV imports that include a
--    `sku` column). Reviews without it are grouped at query time
--    via the product_groups table below.
alter table public.reviews add column if not exists group_key text;
create index if not exists idx_reviews_group_key
  on public.reviews (shop_domain, group_key);

-- 2) product_groups — one row per product in your store, mapping
--    handle / numeric id -> SKU -> group_key.
--    Populated by the "Sync product groups" button in the app admin
--    (it reads your catalogue via the read_products scope).
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

-- 3) RLS: the app talks to this table with the service-role key
--    (which bypasses RLS), so no public policies are needed.
alter table public.product_groups enable row level security;
