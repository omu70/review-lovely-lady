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

// ---------------- Loader ----------------
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [reviewsRes, shopRes] = await Promise.all([
    supabaseAdmin
      .from("reviews")
      .select("id, product_id, product_handle, title, author_name, author_location, rating, content, status, source, image_urls, created_at")
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
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent");
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
  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
};

// ---------------- Component ----------------
export default function AdminIndex() {
  const { reviews, plan, error } = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState([]);
  const [sourceFilter, setSourceFilter] = useState([]);
  const [ratingFilter, setRatingFilter] = useState([]);

  // ----- Photo manager modal -----
  const [imgReview, setImgReview] = useState(null);
  const [keepUrls, setKeepUrls] = useState([]);
  const [newFiles, setNewFiles] = useState([]);
  const [urlText, setUrlText] = useState("");
  const [savingImgs, setSavingImgs] = useState(false);

  const openImages = (r) => {
    setImgReview(r);
    setKeepUrls(r.image_urls || []);
    setNewFiles([]);
    setUrlText("");
  };
  const closeImages = () => { setImgReview(null); setSavingImgs(false); };

  const saveImages = () => {
    if (!imgReview) return;
    const fd = new FormData();
    fd.append("intent", "set-images");
    fd.append("ids", JSON.stringify([imgReview.id]));
    fd.append("keep", JSON.stringify(keepUrls));
    fd.append("image_urls_text", urlText);
    newFiles.forEach((f) => fd.append("photos", f));
    setSavingImgs(true);
    fetcher.submit(fd, { method: "post", encType: "multipart/form-data" });
  };

  useEffect(() => {
    if (savingImgs && fetcher.state === "idle" && fetcher.data) {
      setSavingImgs(false);
      if (fetcher.data.ok) { setImgReview(null); revalidator.revalidate(); }
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

  const onToggle = (id, current) =>
    submitMutation({ intent: "single-toggle", ids: JSON.stringify([id]), next: current === "approved" ? "hidden" : "approved" });
  const onDelete = (id) =>
    submitMutation({ intent: "single-delete", ids: JSON.stringify([id]) });

  const statusTone = (s) => s === "approved" ? "success" : s === "pending" ? "attention" : "critical";
  const sourceTone = (s) => s === "csv_import" ? "info" : s === "manual" ? "attention" : "success";

  const promotedBulkActions = [
    { content: "Approve", onAction: () => bulk("approve") },
    { content: "Hide", onAction: () => bulk("hide") },
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
            <div style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <Text as="span" variant="bodySm" tone="subdued">{productLabel}</Text>
            </div>
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

      {imgReview ? (
        <Modal
          open
          onClose={closeImages}
          title={`Photos — ${imgReview.author_name}`}
          primaryAction={{ content: "Save photos", onAction: saveImages, loading: savingImgs }}
          secondaryActions={[{ content: "Cancel", onAction: closeImages }]}
        >
          <Modal.Section>
            <BlockStack gap="400">
              {keepUrls.length ? (
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
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
