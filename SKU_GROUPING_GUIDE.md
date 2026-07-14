# SKU-based review grouping — setup

Products whose SKU shares the same **base code** now share one pool of reviews.
The base code is the part of the SKU **before the first space**:

| Product SKU        | Group key   |
| ------------------ | ----------- |
| `KB-50119 BL-34`   | `kb-50119`  |
| `KB-50119 OF-32`   | `kb-50119`  ← same pool |
| `KB-50200 RD-10`   | `kb-50200`  ← separate pool |

Every product in a group shows the **same review list and the same star average**,
exactly like the big D2C brands do across colour/size variants.

## Deploy order (important)

1. **Run the SQL first.** In Supabase → SQL Editor, paste and run
   `supabase/migrations/006_sku_grouping.sql`.
   It adds a `group_key` column to `reviews` and creates the `product_groups`
   table. It is idempotent (safe to re-run). Fresh installs can just run the
   updated `supabase/schema_full.sql` instead — it already includes both.

   > Run this **before** deploying the new code, because the admin page and the
   > storefront API now read the new column/table.

2. **Deploy the app** (`git push` → Vercel) and **redeploy the theme extension**
   (`shopify app deploy`) so the storefront widget sends the SKU.

3. **Open the app admin → click "Sync product groups"** (top-right).
   This reads your Shopify catalogue (first variant SKU of each product),
   records each product's group, and backfills `group_key` onto your existing
   imported reviews. Re-run it whenever you add products or change SKUs.

## How it works

- **Storefront**: the widget reads the product's variant SKU, computes the group
  key, and asks the API for that group. The API also resolves the group from
  `product_groups` when only a handle is known (e.g. collection card badges), so
  every product in a group shows the grouped count/average.
- **Admin**: each product review row shows its `Group:` key so you can see what
  is clubbed together.
- **CSV import**: an optional `sku` column is now supported — if present, the
  group is derived on import (no sync needed for those rows).

## Adding images to reviews

Two ways, both in the app admin:

- **Individually** — click the photo button in a review's *Images* column
  (upload files or paste URLs; existing behaviour, unchanged).
- **To a set of reviews** — select multiple reviews (tip: filter to one product
  or group, then *Select all*), then use the new **"Add images"** bulk action.
  The photos you add are **appended** to every selected review (existing photos
  are kept). Great for putting the same product photos across a whole SKU group.

## Notes / edge cases

- A product with **no SKU**, or a SKU with **no space**, gets a group of just
  itself (the whole SKU becomes the key) — it behaves exactly as before.
- Grouping only affects **product-specific** reviews. **Store-wide** reviews
  (imported with no handle/id) still appear under every product as before.
- Matching is case-insensitive; keys are lowercased everywhere.
