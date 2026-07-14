// =============================================================
// Merchant Admin Dashboard (Shopify Polaris) — v2 with filters,
// search, bulk actions, and source badges.
// File location: /app/routes/app._index.jsx
// =============================================================
import { json } from "@remix-run/node";
import { useState, useMemo, useEffect } from "react";
import { useLoaderData, useFetcher, useRevalidator, Link } from "@remix-run/react";
import {
  Page, Card, IndexTable, Text, Badge, Button, ButtonGroup, EmptyState,
  Layout, Banner, useIndexResourceState, Filters, ChoiceList, InlineStack, BlockStack, Box,
  Modal, DropZone, Thumbnail, TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../utils/supabase.server";

// SKU group key = the part of the SKU before the first space, lowercased.
//   "KB-50119 BL-34" -> "kb-50119"
const groupKeyFromSku = (sku) => {
  const s = String(sku == null ? "" : sku).trim();
  if (!s) return null;
  return s.split(/\s+/)[0].toLowerCase();
};

// Upload any files posted under the "photos" field to Supabase Storage and
// return their public URLs. Shared by the single + bulk image actions.
async function uploadPostedPhotos(form, shop) {
  const uploaded = [];
  const photos = form.getAll("photos");
  for (const file of photos) {
    if (typeof file === "string" || !file || !file.size) continue;
    if (file.size > 5 * 1024 * 1024) continue; // skip >5MB
    const safeName = (file.name || "img").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const path = `${shop}/admin/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
    try {
      const buf = await file.arrayBuffer();
      const { data, error: upErr } = await supabaseAdmin.storage
        .from("review-images")
        .upload(path, buf, { contentType: file.type || "image/jpeg", upsert: false });
      if (!upErr && data) {
        const { data: pub } = supabaseAdmin.storage.from("review-images").getPublicUrl(data.path);
        if (pub?.publicUrl) uploaded.push(pub.publicUrl);
      } else if (upErr) {
        console.error("[admin image upload]", upErr);
      }
    } catch (e) { console.error("[admin image upload exception]", e); }
  }
  return uploaded;
}

// ---------------- Loader ----------------
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [reviewsRes, shopRes] = await Promise.all([
    supabaseAdmin
      .from("reviews")
      .select("id, product_id, product_handle, group_key, title, author_name, author_location, rating, content, status, source, image_urls, created_at")
      .eq("shop_domain", shop)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin.from("shops").select("plan_type, installed_at").eq("shop_domain", shop).maybeSingle(),
  ]);

  return json({
    shop,
    plan: shopRes.data?.plan_type ?? "standard",
    reviews: reviewsRes.data ?? [],
    error: reviewsRes.error?.message ?? null,
  });
};

// ---------------- Action ----------------
export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");

  // ---- Sync product groups from the Shopify catalogue (no row selection) ----
  // Reads every product + its first variant SKU and records the SKU group so
  // the storefront can club reviews across products that share a SKU base.
  if (intent === "sync-groups") {
    const rows = [];
    let cursor = null, hasNext = true, pages = 0;
    try {
      while (hasNext && pages < 100) {
        const resp = await admin.graphql(
          `#graphql
          query ProductGroups($cursor: String) {
            products(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              edges { node { id handle variants(first: 1) { edges { node { sku } } } } }
            }
          }`,
          { variables: { cursor } }
        );
        const payload = await resp.json();
        const conn = payload?.data?.products;
        if (!conn) break;
        for (const edge of conn.edges || []) {
          const n = edge.node;
          const numericId = String(n.id).split("/").pop();
          const sku = n.variants?.edges?.[0]?.node?.sku || null;
          rows.push({
            shop_domain: shop,
            product_id: numericId,
            product_handle: n.handle,
            sku,
            group_key: groupKeyFromSku(sku),
            updated_at: new Date().toISOString(),
          });
        }
        hasNext = conn.pageInfo?.hasNextPage;
        cursor = conn.pageInfo?.endCursor;
        pages++;
      }
    } catch (e) {
      console.error("[sync-groups]", e);
      return json({ ok: false, error: "Could not read products from Shopify" }, { status: 500 });
    }

    if (rows.length) {
      const { error } = await supabaseAdmin
        .from("product_groups")
        .upsert(rows, { onConflict: "shop_domain,product_id" });
      if (error) return json({ ok: false, error: error.message }, { status: 500 });

      // Backfill group_key onto existing reviews so grouping also speeds up the
      // storefront and works even before product_groups is fully populated.
      const byKey = {};
      for (const r of rows) {
        if (!r.group_key) continue;
        if (r.product_handle) byKey[r.product_handle] = r.group_key;
        if (r.product_id) byKey[r.product_id] = r.group_key;
      }
      const groupKeys = Array.from(new Set(rows.map((r) => r.group_key).filter(Boolean)));
      for (const gk of groupKeys) {
        const handles = rows.filter((r) => r.group_key === gk).map((r) => r.product_handle).filter(Boolean);
        const gids = rows.filter((r) => r.group_key === gk).map((r) => r.product_id).filter(Boolean);
        const keys = Array.from(new Set([...handles, ...gids]));
        if (!keys.length) continue;
        await supabaseAdmin.from("reviews").update({ group_key: gk })
          .eq("shop_domain", shop).in("product_handle", keys);
        await supabaseAdmin.from("reviews").update({ group_key: gk })
          .eq("shop_domain", shop).in("product_id", keys);
      }
    }

    const groups = new Set(rows.map((r) => r.group_key).filter(Boolean));
    return json({ ok: true, synced: rows.length, groups: groups.size, intent: "sync-groups" });
  }

  // ---- Find duplicate reviews (dry run — returns ids to delete) ----
  // Two reviews are "duplicates" when the same person left the same text, with
  // the same rating, on the same product. We keep ONE of each set (preferring a
  // copy that has photos, otherwise the oldest) and report the rest.
  if (intent === "find-duplicates" || intent === "delete-duplicates") {
    // Pull every review for the shop (paged, since there can be thousands).
    const all = [];
    const PAGE = 1000;
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await supabaseAdmin
        .from("reviews")
        .select("id, author_name, content, rating, product_handle, product_id, image_urls, created_at")
        .eq("shop_domain", shop)
        .order("created_at", { ascending: true })
        .range(start, start + PAGE - 1);
      if (error) return json({ ok: false, error: error.message }, { status: 500 });
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    const norm = (s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ");
    const groupsMap = new Map();
    for (const r of all) {
      const key = [
        norm(r.author_name),
        norm(r.content),
        String(r.rating),
        norm(r.product_handle),
        norm(r.product_id),
      ].join("␟");
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key).push(r);
    }

    const dupIds = [];
    let dupSets = 0;
    for (const rows of groupsMap.values()) {
      if (rows.length < 2) continue;
      dupSets++;
      // Keeper = prefers a copy WITH photos, else the oldest (rows are
      // already ordered oldest-first, so it's a stable choice).
      rows.sort((a, b) => {
        const ai = (a.image_urls?.length ? 1 : 0);
        const bi = (b.image_urls?.length ? 1 : 0);
        if (bi !== ai) return bi - ai;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
      for (let i = 1; i < rows.length; i++) dupIds.push(rows[i].id);
    }

    if (intent === "find-duplicates") {
      return json({ ok: true, intent: "find-duplicates", dupIds, dupCount: dupIds.length, dupSets });
    }

    // delete-duplicates: delete exactly the ids we computed here (re-computed
    // server-side so a stale client can't ask us to delete the wrong rows).
    if (!dupIds.length) {
      return json({ ok: true, intent: "delete-duplicates", deleted: 0 });
    }
    for (let i = 0; i < dupIds.length; i += 200) {
      const chunk = dupIds.slice(i, i + 200);
      const { error } = await supabaseAdmin
        .from("reviews").delete().in("id", chunk).eq("shop_domain", shop);
      if (error) return json({ ok: false, error: error.message }, { status: 500 });
    }
    return json({ ok: true, intent: "delete-duplicates", deleted: dupIds.length });
  }

  const ids = JSON.parse(form.get("ids") || "[]");

  if (!ids.length) return json({ ok: false, error: "No rows selected" }, { status: 400 });

  if (intent === "delete") {
    const { error } = await supabaseAdmin.from("reviews").delete().in("id", ids).eq("shop_domain", shop);
    if (error) return json({ ok: false, error: error.message }, { status: 500 });
    return json({ ok: true });
  }
  if (intent === "approve") {
    const { error } = await supabaseAdmin.from("reviews").update({ status: "approved" }).in("id", ids).eq("shop_domain", shop);
    if (error) return json({ ok: false, error: error.message }, { status: 500 });
    return json({ ok: true });
  }
  if (intent === "hide") {
    const { error } = await supabaseAdmin.from("reviews").update({ status: "hidden" }).in("id", ids).eq("shop_domain", shop);
    if (error) return json({ ok: false, error: error.message }, { status: 500 });
    return json({ ok: true });
  }
  if (intent === "single-toggle") {
    const id = ids[0];
    const next = String(form.get("next") || "approved");
    const { error } = await supabaseAdmin.from("reviews").update({ status: next }).eq("id", id).eq("shop_domain", shop);
    if (error) return json({ ok: false, error: error.message }, { status: 500 });
    return json({ ok: true });
  }
  if (intent === "single-delete") {
    const { error } = await supabaseAdmin.from("reviews").delete().eq("id", ids[0]).eq("shop_domain", shop);
    if (error) return json({ ok: false, error: error.message }, { status: 500 });
    return json({ ok: true });
  }
  if (intent === "set-images") {
    const id = ids[0];
    let keep = [];
    try { keep = JSON.parse(form.get("keep") || "[]"); } catch { keep = []; }

    // Upload any newly-added files to Supabase Storage
    const uploaded = await uploadPostedPhotos(form, shop);

    // Also accept pasted URLs (one per line or comma-separated)
    const urlText = String(form.get("image_urls_text") || "").trim();
    const pasted = urlText ? urlText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : [];

    const finalUrls = [...keep, ...pasted, ...uploaded].slice(0, 10);
    const { error } = await supabaseAdmin
      .from("reviews")
      .update({ image_urls: finalUrls })
      .eq("id", id)
      .eq("shop_domain", shop);
    if (error) return json({ ok: false, error: error.message }, { status: 500 });
    return json({ ok: true, image_urls: finalUrls });
  }

  // ---- Bulk: APPEND the same images to every selected review ----
  // Lets you attach one set of photos to a whole set of reviews at once
  // (e.g. select all reviews for a product group, then add product photos).
  if (intent === "bulk-add-images") {
    const uploaded = await uploadPostedPhotos(form, shop);
    const urlText = String(form.get("image_urls_text") || "").trim();
    const pasted = urlText ? urlText.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : [];
    const toAdd = [...pasted, ...uploaded];
    if (!toAdd.length) {
      return json({ ok: false, error: "Add at least one photo or image URL" }, { status: 400 });
    }

    const { data: rows, error: selErr } = await supabaseAdmin
      .from("reviews")
      .select("id, image_urls")
      .in("id", ids)
      .eq("shop_domain", shop);
    if (selErr) return json({ ok: false, error: selErr.message }, { status: 500 });

    for (const row of rows || []) {
      const merged = [...(row.image_urls || []), ...toAdd].slice(0, 10);
      const { error: upErr } = await supabaseAdmin
        .from("reviews")
        .update({ image_urls: merged })
        .eq("id", row.id)
        .eq("shop_domain", shop);
      if (upErr) return json({ ok: false, error: upErr.message }, { status: 500 });
    }
    return json({ ok: true, count: rows?.length || 0, intent: "bulk-add-images" });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
};

// ---------------- Component ----------------
export default function AdminIndex() {
  const { reviews, plan, error } = useLoaderData();
  const fetcher = useFetcher();
  const dupeFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState([]);
  const [sourceFilter, setSourceFilter] = useState([]);
  const [ratingFilter, setRatingFilter] = useState([]);

  // ----- Photo manager modal (single review OR bulk set) -----
  const [imgReview, setImgReview] = useState(null); // the review being edited, or null in bulk mode
  const [bulkImgOpen, setBulkImgOpen] = useState(false);
  const [bulkImgCount, setBulkImgCount] = useState(0);
  const [keepUrls, setKeepUrls] = useState([]);
  const [newFiles, setNewFiles] = useState([]);
  const [urlText, setUrlText] = useState("");
  const [savingImgs, setSavingImgs] = useState(false);

  const modalOpen = Boolean(imgReview) || bulkImgOpen;

  const openImages = (r) => {
    setBulkImgOpen(false);
    setImgReview(r);
    setKeepUrls(r.image_urls || []);
    setNewFiles([]);
    setUrlText("");
  };
  const closeImages = () => { setImgReview(null); setBulkImgOpen(false); setSavingImgs(false); };

  // ----- Sync product groups -----
  const [syncing, setSyncing] = useState(false);
  const syncGroups = () => {
    setSyncing(true);
    fetcher.submit({ intent: "sync-groups" }, { method: "post" });
  };

  // ----- Delete duplicate reviews (scan → confirm → delete) -----
  const [dupModal, setDupModal] = useState(false);
  const scanning = dupeFetcher.state !== "idle" && dupeFetcher.formData?.get("intent") === "find-duplicates";
  const deletingDupes = dupeFetcher.state !== "idle" && dupeFetcher.formData?.get("intent") === "delete-duplicates";
  const dupData = dupeFetcher.data;

  const scanDuplicates = () => dupeFetcher.submit({ intent: "find-duplicates" }, { method: "post" });
  const confirmDeleteDuplicates = () => dupeFetcher.submit({ intent: "delete-duplicates" }, { method: "post" });

  useEffect(() => {
    if (dupeFetcher.state !== "idle" || !dupeFetcher.data) return;
    if (dupeFetcher.data.intent === "find-duplicates") {
      setDupModal(true);
    } else if (dupeFetcher.data.intent === "delete-duplicates") {
      setDupModal(false);
      revalidator.revalidate();
    }
  }, [dupeFetcher.state, dupeFetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveImages = () => {
    const fd = new FormData();
    if (bulkImgOpen) {
      // Append the same photos to every selected review.
      fd.append("intent", "bulk-add-images");
      fd.append("ids", JSON.stringify(selectedResources));
    } else {
      if (!imgReview) return;
      fd.append("intent", "set-images");
      fd.append("ids", JSON.stringify([imgReview.id]));
      fd.append("keep", JSON.stringify(keepUrls));
    }
    fd.append("image_urls_text", urlText);
    newFiles.forEach((f) => fd.append("photos", f));
    setSavingImgs(true);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (savingImgs) {
      setSavingImgs(false);
      if (fetcher.data.ok) { closeImages(); clearSelection(); revalidator.revalidate(); }
    }
    if (syncing && (fetcher.data.intent === "sync-groups" || fetcher.data.synced != null)) {
      setSyncing(false);
      if (fetcher.data.ok) revalidator.revalidate();
    }
  }, [fetcher.state, fetcher.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    return reviews.filter((r) => {
      if (statusFilter.length && !statusFilter.includes(r.status)) return false;
      if (sourceFilter.length && !sourceFilter.includes(r.source)) return false;
      if (ratingFilter.length && !ratingFilter.includes(String(r.rating))) return false;
      if (query) {
        const q = query.toLowerCase();
        const hay = (r.author_name + " " + r.content + " " + r.product_id).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [reviews, query, statusFilter, sourceFilter, ratingFilter]);

  const resourceName = { singular: "review", plural: "reviews" };
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(filtered);

  const submitMutation = (form) => {
    fetcher.submit(form, { method: "post" });
    setTimeout(() => { revalidator.revalidate(); clearSelection(); }, 250);
  };

  const bulk = (intent) =>
    submitMutation({ intent, ids: JSON.stringify(selectedResources) });

  const openBulkImages = () => {
    setImgReview(null);
    setBulkImgCount(selectedResources.length);
    setBulkImgOpen(true);
    setKeepUrls([]);
    setNewFiles([]);
    setUrlText("");
  };

  const onToggle = (id, current) =>
    submitMutation({ intent: "single-toggle", ids: JSON.stringify([id]), next: current === "approved" ? "hidden" : "approved" });
  const onDelete = (id) =>
    submitMutation({ intent: "single-delete", ids: JSON.stringify([id]) });

  const statusTone = (s) => s === "approved" ? "success" : s === "pending" ? "attention" : "critical";
  const sourceTone = (s) => s === "csv_import" ? "info" : s === "manual" ? "attention" : "success";

  const promotedBulkActions = [
    { content: "Approve", onAction: () => bulk("approve") },
    { content: "Hide", onAction: () => bulk("hide") },
    { content: "Add images", onAction: openBulkImages },
    { content: "Delete", onAction: () => bulk("delete"), destructive: true },
  ];

  const filters = [
    {
      key: "status", label: "Status", filter: (
        <ChoiceList
          title="Status" titleHidden allowMultiple choices={[
            { label: "Approved", value: "approved" },
            { label: "Pending", value: "pending" },
            { label: "Hidden", value: "hidden" },
          ]} selected={statusFilter} onChange={setStatusFilter}
        />
      ),
    },
    {
      key: "source", label: "Source", filter: (
        <ChoiceList
          title="Source" titleHidden allowMultiple choices={[
            { label: "Storefront", value: "storefront" },
            { label: "CSV import", value: "csv_import" },
            { label: "Manual", value: "manual" },
          ]} selected={sourceFilter} onChange={setSourceFilter}
        />
      ),
    },
    {
      key: "rating", label: "Rating", filter: (
        <ChoiceList
          title="Rating" titleHidden allowMultiple choices={[5,4,3,2,1].map((n) => ({ label: `${n} ★`, value: String(n) }))}
          selected={ratingFilter} onChange={setRatingFilter}
        />
      ),
    },
  ];

  const formatDate = (iso) => {
    try {
      const d = new Date(iso);
      const opts = { day: "numeric", month: "short", year: "numeric" };
      return d.toLocaleDateString("en-IN", opts);
    } catch { return ""; }
  };

  const StarRating = ({ value }) => (
    <span style={{ whiteSpace: "nowrap", color: "#FFB400", letterSpacing: "1px", fontSize: 14 }}>
      {"★".repeat(value)}
      <span style={{ color: "#D1D5DB" }}>{"★".repeat(5 - value)}</span>
    </span>
  );

  const rowMarkup = filtered.map((r, i) => {
    const productLabel = r.product_handle || r.product_id;
    const isStoreWide = !productLabel;
    return (
      <IndexTable.Row id={r.id} key={r.id} position={i} selected={selectedResources.includes(r.id)}>
        <IndexTable.Cell>
          {isStoreWide ? (
            <Badge tone="info">Store-wide</Badge>
          ) : (
            <BlockStack gap="050">
              <div style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <Text as="span" variant="bodySm" tone="subdued">{productLabel}</Text>
              </div>
              {r.group_key ? (
                <div style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <Text as="span" variant="bodySm" tone="subdued">Group: {r.group_key}</Text>
                </div>
              ) : null}
            </BlockStack>
          )}
        </IndexTable.Cell>

        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="span" fontWeight="semibold" truncate>{r.author_name}</Text>
            {r.author_location ? (
              <Text as="span" variant="bodySm" tone="subdued">{r.author_location}</Text>
            ) : null}
          </BlockStack>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <StarRating value={r.rating} />
        </IndexTable.Cell>

        <IndexTable.Cell>
          <div style={{
            maxWidth: 360,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            lineHeight: "1.4",
          }}>
            {r.title ? (
              <Text as="span" fontWeight="semibold" variant="bodySm">{r.title}. </Text>
            ) : null}
            <Text as="span" variant="bodySm" tone="subdued">{r.content}</Text>
          </div>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <Button size="micro" variant="tertiary" onClick={() => openImages(r)}>
            {r.image_urls?.length
              ? `${r.image_urls.length} photo${r.image_urls.length > 1 ? "s" : ""}`
              : "Add"}
          </Button>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <div style={{ whiteSpace: "nowrap" }}>
            <Text as="span" variant="bodySm" tone="subdued">{formatDate(r.created_at)}</Text>
          </div>
        </IndexTable.Cell>

        <IndexTable.Cell><Badge tone={sourceTone(r.source)}>{r.source.replace(/_/g, " ")}</Badge></IndexTable.Cell>
        <IndexTable.Cell><Badge tone={statusTone(r.status)}>{r.status}</Badge></IndexTable.Cell>

        <IndexTable.Cell>
          <div style={{ whiteSpace: "nowrap" }}>
            <ButtonGroup>
              <Button size="micro" onClick={() => onToggle(r.id, r.status)}>
                {r.status === "approved" ? "Hide" : "Approve"}
              </Button>
              <Button size="micro" tone="critical" onClick={() => onDelete(r.id)}>Delete</Button>
            </ButtonGroup>
          </div>
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  return (
    <Page
      title="Reviews"
      subtitle={reviews.length > 0 ? `${reviews.length} total review${reviews.length === 1 ? "" : "s"}` : undefined}
      primaryAction={{ content: "Import CSV", url: "/app/import" }}
      secondaryActions={[
        { content: syncing ? "Syncing…" : "Sync product groups", onAction: syncGroups, loading: syncing },
        { content: scanning ? "Scanning…" : "Delete duplicates", onAction: scanDuplicates, loading: scanning },
      ]}
    >
      <TitleBar title="Reviews" />
      <Layout>
        {plan === "early_adopter_free" ? (
          <Layout.Section>
            <Banner tone="success" title="You're on the Early Adopter (free) plan 🎉">
              <p>Thanks for being one of our first 50 stores. All features are included at no cost.</p>
            </Banner>
          </Layout.Section>
        ) : null}

        {fetcher.data && fetcher.data.intent === "sync-groups" && fetcher.data.ok ? (
          <Layout.Section>
            <Banner tone="success" title="Product groups synced" onDismiss={() => {}}>
              <p>
                Matched {fetcher.data.synced} product{fetcher.data.synced === 1 ? "" : "s"} into{" "}
                {fetcher.data.groups} SKU group{fetcher.data.groups === 1 ? "" : "s"}. Reviews are now
                clubbed across products that share a SKU base.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        {error ? (
          <Layout.Section>
            <Banner tone="critical" title="Could not load reviews"><p>{error}</p></Banner>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <Card padding="0">
            <Box padding="300">
              <Filters
                queryValue={query}
                queryPlaceholder="Search by author, product or content"
                onQueryChange={setQuery}
                onQueryClear={() => setQuery("")}
                filters={filters}
                onClearAll={() => {
                  setStatusFilter([]); setSourceFilter([]); setRatingFilter([]); setQuery("");
                }}
              />
            </Box>
            {filtered.length === 0 ? (
              <EmptyState
                heading={reviews.length === 0 ? "No reviews yet" : "No reviews match your filters"}
                action={reviews.length === 0 ? { content: "Import CSV", url: "/app/import" } : undefined}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>{reviews.length === 0
                  ? "Import reviews from a CSV (use a Trustoo export directly), or wait for customers to submit reviews from your storefront."
                  : "Try removing a filter to see more reviews."}</p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={filtered.length}
                selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                promotedBulkActions={promotedBulkActions}
                headings={[
                  { title: "Product" },
                  { title: "Reviewer" },
                  { title: "Rating" },
                  { title: "Review" },
                  { title: "Images" },
                  { title: "Date" },
                  { title: "Source" },
                  { title: "Status" },
                  { title: "Actions" },
                ]}
              >
                {rowMarkup}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="200">
            <InlineStack gap="200">
              <Text as="span" variant="bodySm" tone="subdued">Plan: <strong>{plan}</strong></Text>
              <Text as="span" variant="bodySm" tone="subdued">Total reviews: <strong>{reviews.length}</strong></Text>
            </InlineStack>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {modalOpen ? (
        <Modal
          open
          onClose={closeImages}
          title={bulkImgOpen
            ? `Add photos to ${bulkImgCount} review${bulkImgCount === 1 ? "" : "s"}`
            : `Photos — ${imgReview?.author_name}`}
          primaryAction={{
            content: bulkImgOpen ? "Add to selected" : "Save photos",
            onAction: saveImages,
            loading: savingImgs,
          }}
          secondaryActions={[{ content: "Cancel", onAction: closeImages }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {bulkImgOpen ? (
                <Banner tone="info">
                  <p>These photos will be <strong>added</strong> to all {bulkImgCount} selected review
                  {bulkImgCount === 1 ? "" : "s"} (existing photos are kept).</p>
                </Banner>
              ) : null}

              {!bulkImgOpen && keepUrls.length ? (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">Current photos</Text>
                  <InlineStack gap="300" wrap>
                    {keepUrls.map((u) => (
                      <div key={u} style={{ textAlign: "center" }}>
                        <Thumbnail size="large" alt="review photo" source={u} />
                        <Button size="micro" variant="plain" tone="critical"
                          onClick={() => setKeepUrls((prev) => prev.filter((x) => x !== u))}>
                          Remove
                        </Button>
                      </div>
                    ))}
                  </InlineStack>
                </BlockStack>
              ) : null}

              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Add photos</Text>
                <DropZone accept="image/*" type="image"
                  onDrop={(_files, accepted) => setNewFiles((prev) => [...prev, ...accepted])}>
                  <DropZone.FileUpload actionTitle="Upload images" actionHint="PNG or JPG, up to ~4 MB each" />
                </DropZone>
                {newFiles.length ? (
                  <InlineStack gap="300" wrap>
                    {newFiles.map((f, i) => (
                      <div key={i} style={{ textAlign: "center" }}>
                        <Thumbnail size="large" alt={f.name}
                          source={typeof window !== "undefined" ? window.URL.createObjectURL(f) : ""} />
                        <Button size="micro" variant="plain" tone="critical"
                          onClick={() => setNewFiles((prev) => prev.filter((_, idx) => idx !== i))}>
                          Remove
                        </Button>
                      </div>
                    ))}
                  </InlineStack>
                ) : null}
              </BlockStack>

              <TextField
                label="…or paste image URLs (one per line)"
                value={urlText}
                onChange={setUrlText}
                multiline={3}
                autoComplete="off"
                placeholder="https://example.com/photo1.jpg"
              />

              {fetcher.data && fetcher.data.ok === false ? (
                <Banner tone="critical"><p>{fetcher.data.error}</p></Banner>
              ) : null}
              <Text as="p" variant="bodySm" tone="subdued">
                Up to 10 photos per review. Uploads are stored in your Supabase storage bucket.
                {bulkImgOpen ? " Tip: filter to one product group, select all, then add shared photos." : ""}
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}

      {dupModal ? (
        <Modal
          open
          onClose={() => setDupModal(false)}
          title="Delete duplicate reviews"
          primaryAction={
            dupData?.dupCount
              ? {
                  content: `Delete ${dupData.dupCount} duplicate${dupData.dupCount === 1 ? "" : "s"}`,
                  destructive: true,
                  onAction: confirmDeleteDuplicates,
                  loading: deletingDupes,
                }
              : undefined
          }
          secondaryActions={[{ content: dupData?.dupCount ? "Cancel" : "Close", onAction: () => setDupModal(false) }]}
        >
          <Modal.Section>
            {dupData?.dupCount ? (
              <BlockStack gap="300">
                <Text as="p">
                  Found <strong>{dupData.dupCount}</strong> duplicate review
                  {dupData.dupCount === 1 ? "" : "s"} across <strong>{dupData.dupSets}</strong> set
                  {dupData.dupSets === 1 ? "" : "s"}.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  A duplicate is the same reviewer, same text, same rating, on the same product.
                  One copy of each set is kept (the one with photos, otherwise the oldest) and the
                  rest are deleted. This can't be undone.
                </Text>
              </BlockStack>
            ) : (
              <Text as="p">No duplicate reviews found. 🎉</Text>
            )}
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
