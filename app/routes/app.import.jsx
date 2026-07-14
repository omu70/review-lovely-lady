// =============================================================
// CSV Import for Reviews — Trustoo-compatible
// File: /app/routes/app.import.jsx
//
// Accepts CSVs with Trustoo's columns OR our minimal columns.
// Required: product_id OR product_handle, author OR author_name,
//           rating, content
// Optional: title, author_country, author_location, author_email,
//           commented_at, reply, reply_at, verify_purchase / is_verified,
//           feature, publish, item_type, photo_url_1..5, image_urls,
//           video_url
// =============================================================
import { json } from "@remix-run/node";
import { useState } from "react";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import {
  Page, Card, BlockStack, Text, Button, Banner, DropZone, List, Box, InlineStack, Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { supabaseAdmin } from "../utils/supabase.server";

// ------------------- Helpers -------------------
const truthy = (v) => ["1", "true", "yes", "y", "on", "approved"].includes(String(v ?? "").trim().toLowerCase());

// SKU group key = part of the SKU before the first space, lowercased.
const groupKeyFromSku = (sku) => {
  const s = String(sku == null ? "" : sku).trim();
  if (!s) return null;
  return s.split(/\s+/)[0].toLowerCase();
};

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Try ISO first, then m/d/yyyy
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let [_, mo, da, ye] = m;
    if (ye.length === 2) ye = "20" + ye;
    const dd = new Date(`${ye}-${mo.padStart(2,"0")}-${da.padStart(2,"0")}`);
    if (!isNaN(dd.getTime())) return dd.toISOString();
  }
  return null;
}

function parseCSV(text) {
  const out = []; let row = []; let cur = ""; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
      else if (c === "\r") {}
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

// ------------------- Action -------------------
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // Make sure the shop row exists before inserting reviews
  // (auth handler usually does this on install, but be defensive)
  await supabaseAdmin
    .from("shops")
    .upsert({ shop_domain: shop }, { onConflict: "shop_domain", ignoreDuplicates: true });

  const form = await request.formData();
  const csvText = form.get("csv");
  if (!csvText || typeof csvText !== "string") {
    return json({ ok: false, error: "No CSV provided" }, { status: 400 });
  }

  const rows = parseCSV(csvText);
  if (rows.length < 2) return json({ ok: false, error: "CSV is empty" }, { status: 400 });

  // Normalise headers — strip "*", lowercase, trim
  const headers = rows[0].map((h) => String(h).replace(/\*/g, "").trim().toLowerCase());
  const idx = (k) => headers.indexOf(k);

  // Either product_id OR product_handle works
  if (idx("product_id") < 0 && idx("product_handle") < 0) {
    return json({ ok: false, error: "Missing column: product_id or product_handle" }, { status: 400 });
  }
  if (idx("rating") < 0) return json({ ok: false, error: "Missing column: rating" }, { status: 400 });

  // Author can be 'author' or 'author_name'
  const authorCol = idx("author_name") >= 0 ? "author_name" : "author";
  if (idx(authorCol) < 0) return json({ ok: false, error: "Missing column: author or author_name" }, { status: 400 });

  // Content can be 'content' (we accept reviews without title/content if either exists)
  const hasContent = idx("content") >= 0;
  const hasTitle = idx("title") >= 0;

  const records = [];
  const errors = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.every((c) => !c)) continue;

    const get = (k) => idx(k) >= 0 ? String(r[idx(k)] ?? "").trim() : "";

    const rating = parseInt(get("rating"), 10);
    const author_name = get(authorCol);
    const content = hasContent ? get("content") : "";
    const title = hasTitle ? get("title") : "";
    const product_id = get("product_id");
    const product_handle = get("product_handle");

    if (!author_name)              { errors.push(`Row ${i + 1}: missing author`); continue; }
    // product_id / product_handle empty = STORE-WIDE review (allowed)
    if (Number.isNaN(rating) || rating < 1 || rating > 5) {
      errors.push(`Row ${i + 1}: rating must be 1-5`); continue;
    }
    if (!content && !title) {
      errors.push(`Row ${i + 1}: needs at least content or title`); continue;
    }

    const initials = author_name.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase() || "AN";

    // Photos — Trustoo uses photo_url_1..5; we also accept image_urls (comma separated)
    let image_urls = [];
    for (let n = 1; n <= 5; n++) {
      const u = get(`photo_url_${n}`);
      if (u) image_urls.push(u);
    }
    if (idx("image_urls") >= 0) {
      const extra = get("image_urls").split(",").map(s => s.trim()).filter(Boolean);
      image_urls = image_urls.concat(extra);
    }

    // Verify / publish / feature flags
    const is_verified = idx("verify_purchase") >= 0
      ? truthy(get("verify_purchase"))
      : idx("is_verified") >= 0 ? truthy(get("is_verified")) : true;
    const publishRaw = get("publish");
    const status = publishRaw
      ? (truthy(publishRaw) ? "approved" : "hidden")
      : "approved";
    const is_featured = idx("feature") >= 0 ? truthy(get("feature")) : false;

    // Country / location
    const author_country = get("author_country");
    const author_location = get("author_location") || author_country || null;

    // Dates
    const commented_at = parseDate(get("commented_at")) || null;
    const reply_at = parseDate(get("reply_at")) || null;

    // Optional sku column → derive the SKU group so imports club automatically.
    const sku = get("sku");
    const group_key = groupKeyFromSku(sku);

    const record = {
      shop_domain: shop,
      product_id: product_id || null,
      product_handle: product_handle || null,
      author_name: author_name.slice(0, 80),
      author_initials: initials,
      author_email: get("author_email") || null,
      author_country: author_country || null,
      author_location,
      is_verified,
      rating,
      title: title || null,
      content: (content || title).slice(0, 4000),
      image_urls,
      video_url: get("video_url") || null,
      reply: get("reply") || null,
      reply_at,
      is_featured,
      item_type: get("item_type") || null,
      group_key,
      status,
      source: "csv_import",
    };

    // product_id / product_handle:
    // - both empty   → store-wide review
    // - only handle  → store handle as product_id too (widget matches by handle)
    if (!record.product_id && record.product_handle) {
      record.product_id = record.product_handle;
    }

    if (commented_at) record.created_at = commented_at;

    records.push(record);
  }

  if (records.length === 0) {
    return json({ ok: false, error: "No valid rows", errors }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from("reviews").insert(records);
  if (error) return json({ ok: false, error: error.message }, { status: 500 });

  return json({ ok: true, inserted: records.length, errors });
};

// ------------------- Component -------------------
export default function ImportPage() {
  const action = useActionData();
  const nav = useNavigation();
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");

  const handleDrop = (_d, accepted) => {
    const f = accepted[0]; if (!f) return;
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setCsvText(reader.result);
    reader.readAsText(f);
  };

  const TRUSTOO_HEADERS = "product_handle,rating,author,title,content,author_country,author_email,commented_at,reply,reply_at,verify_purchase,feature,publish,item_type,photo_url_1,photo_url_2,photo_url_3,photo_url_4,photo_url_5,video_url";

  const downloadBlankTrustoo = () => {
    const tmpl = TRUSTOO_HEADERS + "\n" +
      "your-product-handle,5,Your Name,Great product,\"Write your review here.\",IN,,12/5/2024,,,yes,no,yes,,,,,,,\n";
    saveBlob("reviews-template-trustoo.csv", tmpl);
  };

  const downloadSamples = () => {
    const samples = [
      ["woodfire-pillar","Navya Reddy","Hyderabad, India",5,"Looks stunning at home","So elegant and rustic. The craftsmanship is amazing. Bada premium feel hai aur budget me bhi. Top-notch bhai.","IN","",new Date(Date.now()-6*86400000).toLocaleDateString("en-US"),"yes","yes","yes",""],
      ["woodfire-pillar","Rishabh Desai","Mumbai, India",5,"Perfect centerpiece","Ek number decor piece hai. Bohot hi elegant look deta hai. Ekdum perfect center-piece. Macha diya!","IN","",new Date(Date.now()-7*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Jahnvi Joshi","Delhi, India",5,"Aesthetic & premium","Totally an aesthetic piece. The craftsmanship is amazing. Bada premium feel hai aur budget me bhi. Superb!","IN","",new Date(Date.now()-7*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Megha Kapoor","Bengaluru, India",5,"A1 quality","Yaar, this product is fab! Value for money deal hai. Bina soche le lo, the premium design is unmatchable. A1 quality.","IN","",new Date(Date.now()-9*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Myra Bhatia","Chandigarh, India",5,"Top-notch","Such a classy look. Bohot hi elegant look deta hai. Ekdum perfect center-piece. Top-notch bhai.","IN","",new Date(Date.now()-24*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Shaurya Malhotra","Pune, India",5,"Loved the size","Totally loved the aesthetic vibe. Perfect size, na zyada bada na chota. Plus gorgeous aesthetics. Jhakaas!","IN","",new Date(Date.now()-30*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Neha Chawla","Jaipur, India",5,"Chha gaye!","Bohot badiya laga mujhe. Value for money deal hai. Bina soche le lo, the premium design is unmatchable. Chha gaye!","IN","",new Date(Date.now()-31*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Aarav Patel","Ahmedabad, India",4,"Solid build","Quality is solid, packaging was neat. Slightly smaller than I expected from photos but still looks great in my room.","IN","",new Date(Date.now()-45*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Diya Khanna","Lucknow, India",5,"Best purchase","Kamaal ki finish hai. Sturdy hai aur material bohot premium lagta hai. Best purchase. Ekdum kadak.","IN","",new Date(Date.now()-50*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
      ["woodfire-pillar","Ishaan Trivedi","Kolkata, India",4,"Looks really nice","Looks really nice in person. Delivery was quick. Would have given 5 stars if assembly instructions were clearer.","IN","",new Date(Date.now()-60*86400000).toLocaleDateString("en-US"),"yes","no","yes",""],
    ];

    const head = "product_handle,author,author_location,rating,title,content,author_country,author_email,commented_at,verify_purchase,feature,publish,reply\n";
    const rows = samples.map((r) =>
      r.map((v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(",")
    ).join("\n");
    saveBlob("reviews-sample-10-trustoo.csv", head + rows + "\n");
  };

  const saveBlob = (name, text) => {
    const blob = new Blob([text], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  };

  return (
    <Page>
      <TitleBar title="Import reviews from CSV" />
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="300">
            <InlineStack gap="200" align="start">
              <Text as="h2" variant="headingMd">Trustoo-compatible CSV import</Text>
              <Badge tone="info">Drop in your existing Trustoo export</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              Required: <strong>author</strong>, <strong>rating</strong> (1–5), and either
              {" "}<strong>title</strong> or <strong>content</strong>.
            </Text>
            <Text as="p" tone="subdued">
              For product reviews, add <strong>product_handle</strong> (from URL, e.g.
              {" "}<code>woodfire-pillar</code>) or <strong>product_id</strong>.
              {" "}<strong>Leave both empty for store-wide reviews</strong> shown on your homepage.
            </Text>
            <Text as="p" tone="subdued">
              Optional <strong>sku</strong> column: reviews are clubbed across products that share the
              same SKU base (the part before the first space, e.g. <code>KB-50119 BL-34</code> and
              {" "}<code>KB-50119 OF-32</code> both map to group <code>kb-50119</code>).
            </Text>
            <Text as="p" tone="subdued">
              Optional: <strong>author_country</strong>, <strong>author_email</strong>,
              {" "}<strong>commented_at</strong>, <strong>reply</strong>, <strong>reply_at</strong>,
              {" "}<strong>verify_purchase</strong>, <strong>feature</strong>, <strong>publish</strong>,
              {" "}<strong>item_type</strong>, <strong>photo_url_1..5</strong>, <strong>video_url</strong>.
            </Text>
            <InlineStack gap="200">
              <Button onClick={downloadBlankTrustoo}>Download blank template</Button>
              <Button onClick={downloadSamples} variant="primary">Download 10 sample reviews</Button>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              For <code>product_handle</code>, use the slug from the product URL
              (<code>/products/<strong>woodfire-pillar</strong></code>). It's easier than the numeric ID.
            </Text>
          </BlockStack>
        </Card>

        <Card>
          <Form method="post">
            <BlockStack gap="300">
              <DropZone accept=".csv,text/csv" allowMultiple={false} onDrop={handleDrop}>
                {fileName
                  ? <Box padding="400"><Text as="p">{fileName}</Text></Box>
                  : <DropZone.FileUpload actionTitle="Upload CSV" actionHint="Accepts .csv files" />}
              </DropZone>
              <input type="hidden" name="csv" value={csvText} />
              <Button variant="primary" submit disabled={!csvText || nav.state === "submitting"}>
                {nav.state === "submitting" ? "Importing..." : "Import reviews"}
              </Button>
            </BlockStack>
          </Form>
        </Card>

        {action?.ok ? (
          <Banner tone="success" title={`Imported ${action.inserted} reviews`}>
            {action.errors?.length ? (
              <BlockStack gap="100">
                <Text as="p">Skipped rows:</Text>
                <List type="bullet">
                  {action.errors.slice(0, 10).map((e, i) => <List.Item key={i}>{e}</List.Item>)}
                </List>
              </BlockStack>
            ) : null}
          </Banner>
        ) : null}

        {action?.ok === false ? (
          <Banner tone="critical" title="Import failed">
            <p>{action.error}</p>
            {action.errors?.length ? (
              <List type="bullet">
                {action.errors.slice(0, 10).map((e, i) => <List.Item key={i}>{e}</List.Item>)}
              </List>
            ) : null}
          </Banner>
        ) : null}
      </BlockStack>
    </Page>
  );
}
