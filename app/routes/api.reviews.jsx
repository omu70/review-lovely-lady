// =============================================================
// Public storefront API for reviews
// File location:  /app/routes/api.reviews.jsx
//
// GET  /api/reviews?shop=<domain>&productId=<id>&page=1&limit=12
// POST /api/reviews   (JSON body)
// OPTIONS — CORS preflight
// =============================================================
import { json } from "@remix-run/node";
import { supabaseAdmin, corsHeaders } from "../utils/supabase.server";

const respond = (body, init = {}) =>
  json(body, {
    ...init,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(init.headers || {}) },
  });

// ---------- CORS preflight ----------
export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return respond({ error: "Method not allowed" }, { status: 405 });
  }

  const contentType = request.headers.get("content-type") || "";
  let body = {};
  let uploadedImageUrls = [];

  // ---- Multipart (with photos) ----
  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return respond({ error: "Invalid form data" }, { status: 400 });
    }

    body = {
      shop_domain:     form.get("shop_domain"),
      product_id:      form.get("product_id"),
      product_handle:  form.get("product_handle"),
      author_name:     form.get("author_name"),
      author_location: form.get("author_location"),
      rating:          form.get("rating"),
      content:         form.get("content"),
      is_verified:     form.get("is_verified") === "true",
    };

    // Upload each photo to Supabase Storage
    const photos = form.getAll("photos");
    for (const file of photos) {
      if (typeof file === "string" || !file || !file.size) continue;
      if (file.size > 5 * 1024 * 1024) continue; // skip >5MB
      const safeName = (file.name || "img").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
      const path = `${body.shop_domain || "unknown"}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;

      try {
        const arrayBuf = await file.arrayBuffer();
        const { data, error } = await supabaseAdmin.storage
          .from("review-images")
          .upload(path, arrayBuf, { contentType: file.type || "image/jpeg", upsert: false });
        if (!error && data) {
          const { data: pub } = supabaseAdmin.storage.from("review-images").getPublicUrl(data.path);
          if (pub?.publicUrl) uploadedImageUrls.push(pub.publicUrl);
        } else if (error) {
          console.error("[upload]", error);
        }
      } catch (e) {
        console.error("[upload exception]", e);
      }
      if (uploadedImageUrls.length >= 6) break;  // cap at 6 photos
    }
  } else {
    // ---- JSON (no photos) ----
    try {
      body = await request.json();
    } catch {
      return respond({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  const {
    shop_domain,
    product_id,
    product_handle,
    author_name,
    author_location,
    rating,
    content,
    is_verified = true,
  } = body || {};

  if (!shop_domain || !author_name || !rating || !content) {
    return respond({ error: "Missing required fields" }, { status: 400 });
  }
  if (!product_id && !product_handle) {
    return respond({ error: "Missing product_id or product_handle" }, { status: 400 });
  }

  const ratingInt = parseInt(rating, 10);
  if (Number.isNaN(ratingInt) || ratingInt < 1 || ratingInt > 5) {
    return respond({ error: "rating must be 1–5" }, { status: 400 });
  }

  const initials = author_name
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // Defensive: ensure shop row exists (in case install hook didn't run)
  await supabaseAdmin
    .from("shops")
    .upsert({ shop_domain }, { onConflict: "shop_domain", ignoreDuplicates: true });

  const { data, error } = await supabaseAdmin
    .from("reviews")
    .insert({
      shop_domain,
      product_id: product_id ? String(product_id) : (product_handle ? String(product_handle) : null),
      product_handle: product_handle ? String(product_handle) : null,
      author_name: String(author_name).slice(0, 80),
      author_initials: initials || "AN",
      author_location: author_location ? String(author_location).slice(0, 80) : null,
      is_verified: Boolean(is_verified),
      rating: ratingInt,
      content: String(content).slice(0, 4000),
      image_urls: uploadedImageUrls,
      status: "pending", // merchant approves in admin
    })
    .select()
    .single();

  if (error) {
    console.error("[api.reviews POST]", error);
    return respond({ error: "Could not save review" }, { status: 500 });
  }

  return respond({ ok: true, review: data }, { status: 201 });
};

// ---------- GET (list + aggregates) ----------
export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const shop = url.searchParams.get("shop");
  const productId = url.searchParams.get("productId");
  const productHandle = url.searchParams.get("productHandle");
  const groupKeyParam = (url.searchParams.get("groupKey") || "").trim().toLowerCase() || null;
  const storeOnly = url.searchParams.get("store") === "true";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "12", 10)));

  if (!shop) {
    return respond({ error: "shop is required" }, { status: 400 });
  }
  if (!storeOnly && !productId && !productHandle) {
    return respond({ error: "Provide productId, productHandle, or store=true" }, { status: 400 });
  }

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  // Helper that builds the base filter for either product- or store-scoped queries
  const SELECT_COLS = "id, title, author_name, author_initials, author_location, author_country, is_verified, is_featured, rating, content, image_urls, video_url, reply, reply_at, created_at";

  // Store-only mode: just store-wide reviews
  if (storeOnly) {
    const rowsRes = await supabaseAdmin
      .from("reviews")
      .select(SELECT_COLS, { count: "exact" })
      .eq("shop_domain", shop)
      .eq("status", "approved")
      .is("product_id", null)
      .is("product_handle", null)
      .order("is_featured", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, to);

    const aggRes = await supabaseAdmin
      .from("reviews")
      .select("rating")
      .eq("shop_domain", shop)
      .eq("status", "approved")
      .is("product_id", null)
      .is("product_handle", null);

    if (rowsRes.error || aggRes.error) {
      return respond({ error: "DB error" }, { status: 500 });
    }
    const total = rowsRes.count ?? 0;
    const ratings = aggRes.data || [];
    const totalRatings = ratings.length;
    const average = totalRatings === 0 ? 0
      : Number((ratings.reduce((s, r) => s + r.rating, 0) / totalRatings).toFixed(1));
    return respond({
      reviews: rowsRes.data || [],
      page, limit, total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      average, totalRatings,
    });
  }

  // ---------------------------------------------------------------
  // Product page mode — CLUB reviews across the whole SKU group.
  //
  // Products whose SKU shares the same base code (the part before the
  // first space, e.g. "KB-50119") share ONE pool of reviews. We resolve
  // the current product's group, gather every sibling product's handle/id,
  // and return the combined pool with a single shared average.
  // ---------------------------------------------------------------
  const productKey = productHandle || productId;

  // Keys we will match reviews against (this product + all siblings in its group).
  const matchKeys = new Set();
  if (productHandle) matchKeys.add(productHandle);
  if (productId) matchKeys.add(productId);

  // 1) Figure out this product's group_key.
  let groupKey = groupKeyParam;
  if (!groupKey && productKey) {
    // interpolation-safe: productKey is a slug or numeric id (no dots/commas)
    const meRes = await supabaseAdmin
      .from("product_groups")
      .select("group_key")
      .eq("shop_domain", shop)
      .or(`product_handle.eq.${productKey},product_id.eq.${productKey}`)
      .not("group_key", "is", null)
      .limit(1);
    groupKey = meRes.data?.[0]?.group_key || null;
  }

  // 2) Pull in every sibling product that belongs to the same group.
  if (groupKey) {
    const sibRes = await supabaseAdmin
      .from("product_groups")
      .select("product_handle, product_id")
      .eq("shop_domain", shop)
      .eq("group_key", groupKey);
    for (const row of sibRes.data || []) {
      if (row.product_handle) matchKeys.add(row.product_handle);
      if (row.product_id) matchKeys.add(row.product_id);
    }
  }

  const keyList = Array.from(matchKeys);

  // 3) Fetch the group's reviews. We match a review if its handle OR its id
  //    is one of the group's keys, OR it was tagged directly with group_key.
  const groupQueries = [];
  if (keyList.length) {
    groupQueries.push(
      supabaseAdmin.from("reviews").select(SELECT_COLS)
        .eq("shop_domain", shop).eq("status", "approved").in("product_handle", keyList)
    );
    groupQueries.push(
      supabaseAdmin.from("reviews").select(SELECT_COLS)
        .eq("shop_domain", shop).eq("status", "approved").in("product_id", keyList)
    );
  }
  if (groupKey) {
    groupQueries.push(
      supabaseAdmin.from("reviews").select(SELECT_COLS)
        .eq("shop_domain", shop).eq("status", "approved").eq("group_key", groupKey)
    );
  }

  const storePromise = supabaseAdmin
    .from("reviews")
    .select(SELECT_COLS)
    .eq("shop_domain", shop)
    .eq("status", "approved")
    .is("product_id", null)
    .is("product_handle", null)
    .order("is_featured", { ascending: false })
    .order("created_at", { ascending: false });

  const [groupResults, storeRes] = await Promise.all([
    Promise.all(groupQueries),
    storePromise,
  ]);

  const anyGroupErr = groupResults.find((r) => r.error);
  if (anyGroupErr?.error || storeRes.error) {
    console.error("[api.reviews]", anyGroupErr?.error || storeRes.error);
    return respond({ error: "DB error" }, { status: 500 });
  }

  // Merge + de-duplicate the group reviews (the same row can come back from
  // more than one of the queries above).
  const seen = new Set();
  const productRows = [];
  for (const res of groupResults) {
    for (const r of res.data || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      productRows.push(r);
    }
  }
  // Featured first, then newest first.
  productRows.sort((a, b) => {
    const f = (b.is_featured ? 1 : 0) - (a.is_featured ? 1 : 0);
    if (f !== 0) return f;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const storeRows = storeRes.data || [];
  // Combined: group reviews first (top of feed), then store-wide.
  const combined = productRows.concat(storeRows);
  const total = combined.length;

  // Average is computed from the GROUP's reviews so every product in the same
  // SKU group shows the same rating (fallback to combined if the group is empty).
  const baseList = productRows.length ? productRows : combined;
  const average = baseList.length === 0 ? 0
    : Number((baseList.reduce((s, r) => s + r.rating, 0) / baseList.length).toFixed(1));

  const paginated = combined.slice(from, to + 1);

  return respond({
    reviews: paginated,
    page, limit, total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    average, totalRatings: total, // show combined count in "(N Reviews)" badge
    groupKey,                     // handy for debugging / storefront cache keys
  });
};
