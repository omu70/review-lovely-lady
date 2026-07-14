/* =============================================================
   Reviews — auto-injection script
   File: /extensions/reviews-widget/assets/app-embed.js
   Loaded by app-embed.liquid on every product page.
   ============================================================= */
(function () {
  var cfg = window.__EVO_REVIEWS__;
  if (!cfg || !cfg.apiBase) return;

  var apiBase = (cfg.apiBase || "").replace(/\/$/, "");
  if (!apiBase || /reviews-app-shopify\.vercel\.app/.test(apiBase)) apiBase = "https://review-lovely-lady.vercel.app";
  var isProductPage = Boolean(cfg.productId && cfg.productHandle);
  // We prefer handle since CSV imports use handle; fall back to id.
  var productKey = cfg.productHandle || cfg.productId;

  // SKU grouping: products whose SKU shares the same base code (the part
  // before the first space, e.g. "KB-50119") share one pool of reviews.
  function groupKeyFromSku(sku) {
    var s = String(sku == null ? "" : sku).trim();
    if (!s) return "";
    return s.split(/\s+/)[0].toLowerCase();
  }
  var groupKey = groupKeyFromSku(cfg.productSku);

  // Compact count: 920 → "920", 1234 → "1.2K", 12345 → "12K", 1.5M → "1.5M"
  function fmtCount(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    if (n < 1000000) return Math.floor(n / 1000) + "K";
    return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  }

  function findFirst(selectors) {
    if (!selectors) return null;
    var list = selectors.split(",");
    for (var i = 0; i < list.length; i++) {
      var el = document.querySelector(list[i].trim());
      if (el) return el;
    }
    return null;
  }

  // ---------- Star badge ----------
  function injectBadge() {
    if (!cfg.showBadge) return;
    if (document.querySelector("[data-evo-star-badge]")) return;

    var target = findFirst(cfg.badgeTarget);
    if (!target) return;

    // If target's parent is a flex/grid layout, jump up one level so the badge
    // takes its own row instead of squeezing in next to the title.
    var insertAfter = target;
    try {
      var parentStyle = window.getComputedStyle(target.parentNode || target);
      if (parentStyle && (parentStyle.display === "flex" || parentStyle.display === "inline-flex" || parentStyle.display === "grid")) {
        insertAfter = target.parentNode;
      }
    } catch (e) {}

    var wrap = document.createElement("div");
    wrap.setAttribute("data-evo-star-badge", "");
    wrap.className = "evo-star-badge";
    wrap.dataset.shop = cfg.shop;
    wrap.dataset.productId = cfg.productId;
    wrap.dataset.api = apiBase;

    wrap.innerHTML = '' +
      '<div class="evo-sb__row">' +
        '<span class="evo-sb__star"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2.5l2.95 6.4 7.05.7-5.3 4.85 1.55 6.95L12 17.9l-6.25 3.5L7.3 14.45 2 9.6l7.05-.7L12 2.5z" fill="#FFC107"/></svg></span>' +
        '<span class="evo-sb__avg" data-evo-avg>—</span>' +
        '<span class="evo-sb__divider">|</span>' +
        '<span class="evo-sb__verified"><svg viewBox="0 0 18 18" width="18" height="18"><polygon fill="#005eff" points="9,16 7.1,16.9 5.8,15.2 3.7,15.1 3.4,13 1.5,12 2.2,9.9 1.1,8.2 2.6,6.7 2.4,4.6 4.5,4 5.3,2 7.4,2.4 9,1.1 10.7,2.4 12.7,2 13.6,4 15.6,4.6 15.5,6.7 17,8.2 15.9,9.9 16.5,12 14.7,13 14.3,15.1 12.2,15.2 10.9,16.9"/><path d="M5.7 9.1 L7.8 11.2 L12.2 6.7" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
        '<span class="evo-sb__count" data-evo-count>(0 Reviews)</span>' +
      '</div>';

    insertAfter.parentNode.insertBefore(wrap, insertAfter.nextSibling);

    // Live aggregate (prefer handle for matching imported reviews)
    fetch(apiBase + "/api/reviews?shop=" + encodeURIComponent(cfg.shop) +
          "&productHandle=" + encodeURIComponent(productKey) +
          "&productId=" + encodeURIComponent(cfg.productId) +
          (groupKey ? "&groupKey=" + encodeURIComponent(groupKey) : "") +
          "&page=1&limit=1")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        wrap.querySelector("[data-evo-avg]").textContent   = (d.average || 0).toFixed(1);
        wrap.querySelector("[data-evo-count]").textContent = "(" + fmtCount(d.totalRatings || 0) + " Reviews)";
      })
      .catch(function () {});
  }

  // ---------- Review grid ----------
  function injectGrid() {
    if (!cfg.showGrid) return;
    if (document.querySelector("[data-evo-review-widget]")) return;

    var target = findFirst(cfg.gridTarget);
    if (!target) target = document.querySelector("main") || document.body;

    var section = document.createElement("section");
    section.className = "evo-rw";
    section.setAttribute("data-evo-review-widget", "");
    section.dataset.shop = cfg.shop;
    section.dataset.productId = cfg.productId;
    section.dataset.productHandle = cfg.productHandle || "";
    section.dataset.groupKey = groupKey || "";
    section.dataset.api = apiBase;
    section.dataset.page = "1";
    section.dataset.limit = "12";

    section.innerHTML = '' +
      '<header class="evo-rw__header">' +
        '<div class="evo-rw__summary">' +
          '<div class="evo-rw__avg" data-evo-rw-avg>0.0</div>' +
          '<div class="evo-rw__sumright">' +
            '<div class="evo-rw__stars" data-evo-rw-stars></div>' +
            '<div class="evo-rw__total" data-evo-rw-total>0 reviews</div>' +
          '</div>' +
        '</div>' +
        '<div class="evo-rw__actions">' +
          '<button class="evo-rw__btn" type="button" data-evo-write>Write a review</button>' +
          '<button class="evo-rw__icon-btn" type="button" aria-label="Filter">' +
            '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16M7 12h10M10 18h4" stroke="#111827" stroke-width="2" stroke-linecap="round"/></svg>' +
          '</button>' +
        '</div>' +
      '</header>' +
      '<hr class="evo-rw__divider"/>' +
      '<div class="evo-rw__grid" data-evo-rw-grid></div>' +
      '<nav class="evo-rw__pager" data-evo-rw-pager></nav>' +
      '<div class="evo-rw__modal" data-evo-modal hidden>' +
        '<div class="evo-rw__modal-card" role="dialog" aria-modal="true">' +
          '<button class="evo-rw__modal-close" type="button" data-evo-modal-close>&times;</button>' +
          '<h3>Write a review</h3>' +
          '<form data-evo-form>' +
            '<label>Your full name<input type="text" name="author_name" required maxlength="80" placeholder="e.g. Aman Sharma"/></label>' +
            '<label>Your location<input type="text" name="author_location" maxlength="80" placeholder="e.g. Mumbai, India"/></label>' +
            '<label>Rating<select name="rating" required>' +
              '<option value="5">5 — Excellent</option><option value="4">4 — Good</option>' +
              '<option value="3">3 — Okay</option><option value="2">2 — Poor</option>' +
              '<option value="1">1 — Terrible</option>' +
            '</select></label>' +
            '<label>Review<textarea name="content" rows="4" required maxlength="4000"></textarea></label>' +
            '<label>Add photos (up to 5, max 5MB each)<input type="file" name="photos" accept="image/*" multiple data-evo-photos/></label>' +
            '<div class="evo-rw__photo-previews" data-evo-photo-previews></div>' +
            '<button class="evo-rw__btn evo-rw__btn--primary" type="submit">Submit review</button>' +
            '<p class="evo-rw__form-msg" data-evo-form-msg></p>' +
          '</form>' +
        '</div>' +
      '</div>';

    if (target.tagName === "MAIN" || target.tagName === "BODY") {
      target.appendChild(section);
    } else {
      target.parentNode.insertBefore(section, target.nextSibling);
    }

    bindGridLogic(section);
  }

  // -------- Grid behaviour --------
  function bindGridLogic(root) {
    var apiBase = (root.dataset.api || "").replace(/\/$/, "");
    if (!apiBase || /reviews-app-shopify\.vercel\.app/.test(apiBase)) apiBase = "https://review-lovely-lady.vercel.app";
    var shop = root.dataset.shop;
    var productId = root.dataset.productId;
    var productHandle = root.dataset.productHandle || "";
    var groupKey = root.dataset.groupKey || "";
    var isStoreMode = root.dataset.store === "true";
    var limit = parseInt(root.dataset.limit || "12", 10);

    var grid = root.querySelector("[data-evo-rw-grid]");
    var pager = root.querySelector("[data-evo-rw-pager]");
    var avgEl = root.querySelector("[data-evo-rw-avg]");
    var totalEl = root.querySelector("[data-evo-rw-total]");
    var starsEl = root.querySelector("[data-evo-rw-stars]");

    function star(filled) {
      return '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.95 6.4 7.05.7-5.3 4.85 1.55 6.95L12 17.9l-6.25 3.5L7.3 14.45 2 9.6l7.05-.7L12 2.5z" fill="' + (filled ? '#FFC107' : '#E5E7EB') + '"/></svg>';
    }
    function starsHTML(rating) {
      var h = ""; for (var i = 1; i <= 5; i++) h += star(i <= Math.round(rating)); return h;
    }
    function timeAgo(iso) {
      var t = new Date(iso).getTime();
      if (isNaN(t)) return "";
      var s = Math.max(1, Math.floor((Date.now() - t) / 1000));
      var u = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
      for (var i = 0; i < u.length; i++) { var n = Math.floor(s / u[i][1]); if (n >= 1) return n + " " + u[i][0] + (n > 1 ? "s" : "") + " ago"; }
      return s + " seconds ago";
    }
    function fmtDate(iso) {
      var d = new Date(iso); if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    }
    function esc(s) { return String(s || "").replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
    function verified() {
      return '<span class="evo-rw__verified"><svg viewBox="0 0 24 24"><path d="M9 16.2l-3.5-3.5-1.4 1.4L9 19l11-11-1.4-1.4z" fill="#374151"/></svg>Verified purchase</span>';
    }
    function imagesHTML(arr) {
      if (!arr || !arr.length) return "";
      var MAX = 5;
      var encoded = encodeURIComponent(JSON.stringify(arr));
      var html = '<div class="evo-rw__imgs">';
      for (var i = 0; i < Math.min(MAX, arr.length); i++) {
        var isLast = (i === MAX - 1) && arr.length > MAX;
        html +=
          '<button type="button" class="evo-rw__img" data-evo-thumb data-imgs="' + encoded + '" data-idx="' + i + '" aria-label="View photo ' + (i + 1) + '">' +
            '<img src="' + esc(arr[i]) + '" loading="lazy" alt=""/>' +
            (isLast ? '<span class="evo-rw__img-more">+' + (arr.length - MAX + 1) + '</span>' : '') +
          '</button>';
      }
      html += '</div>';
      return html;
    }

    // ---- Lightbox (singleton) ----
    function ensureLightbox(){
      var lb = document.querySelector("[data-evo-lightbox]");
      if (lb) return lb;
      lb = document.createElement("div");
      lb.className = "evo-lightbox";
      lb.setAttribute("data-evo-lightbox", "");
      lb.hidden = true;
      lb.innerHTML =
        '<button class="evo-lightbox__close" data-evo-lb-close aria-label="Close">&times;</button>' +
        '<button class="evo-lightbox__prev" data-evo-lb-prev aria-label="Previous">&#10094;</button>' +
        '<button class="evo-lightbox__next" data-evo-lb-next aria-label="Next">&#10095;</button>' +
        '<img class="evo-lightbox__img" data-evo-lb-img alt=""/>' +
        '<div class="evo-lightbox__counter" data-evo-lb-counter></div>';
      document.body.appendChild(lb);

      function close(){ lb.hidden = true; lb._imgs = null; }
      function show(){
        var imgEl = lb.querySelector("[data-evo-lb-img]");
        var counterEl = lb.querySelector("[data-evo-lb-counter]");
        if (!lb._imgs || !lb._imgs.length) return;
        imgEl.src = lb._imgs[lb._idx];
        counterEl.textContent = (lb._idx + 1) + " / " + lb._imgs.length;
      }
      function step(delta){
        if (!lb._imgs) return;
        lb._idx = (lb._idx + delta + lb._imgs.length) % lb._imgs.length;
        show();
      }
      lb.querySelector("[data-evo-lb-close]").onclick = close;
      lb.querySelector("[data-evo-lb-prev]").onclick = function(){ step(-1); };
      lb.querySelector("[data-evo-lb-next]").onclick = function(){ step(1); };
      lb.addEventListener("click", function(e){ if (e.target === lb) close(); });
      document.addEventListener("keydown", function(e){
        if (lb.hidden) return;
        if (e.key === "Escape") close();
        else if (e.key === "ArrowLeft") step(-1);
        else if (e.key === "ArrowRight") step(1);
      });
      lb._show = show;
      return lb;
    }
    function openLightbox(imgs, idx){
      var lb = ensureLightbox();
      lb._imgs = imgs;
      lb._idx = idx || 0;
      lb.hidden = false;
      lb._show();
    }
    function renderCards(reviews) {
      if (!reviews.length) { grid.innerHTML = '<div class="evo-rw__empty">No reviews yet — be the first!</div>'; return; }
      grid.innerHTML = reviews.map(function (r) {
        var locationLine = r.author_location
          ? '<div class="evo-rw__location">📍 ' + esc(r.author_location) + '</div>'
          : "";
        return '<article class="evo-rw__card">' +
          '<div class="evo-rw__card-top">' +
            '<div class="evo-rw__card-stars">' + starsHTML(r.rating) + '</div>' +
            '<div class="evo-rw__card-date" title="' + esc(fmtDate(r.created_at)) + '">' + timeAgo(r.created_at) + '</div>' +
          '</div>' +
          '<div class="evo-rw__card-author">' +
            '<div class="evo-rw__avatar">' + esc(r.author_initials || "??") + '</div>' +
            '<div>' +
              '<div class="evo-rw__author-name">' + esc(r.author_name) + '</div>' +
              (r.is_verified ? verified() : "") +
              locationLine +
            '</div>' +
          '</div>' +
          '<p class="evo-rw__card-content">' + esc(r.content) + '</p>' +
          '<div class="evo-rw__card-footer">' + esc(fmtDate(r.created_at)) + '</div>' +
          imagesHTML(r.image_urls) +
        '</article>';
      }).join("");
    }
    function renderPager(page, totalPages) {
      if (totalPages <= 1) { pager.innerHTML = ""; return; }
      var h = '<button data-page="' + (page - 1) + '" ' + (page <= 1 ? "disabled" : "") + '>Prev</button>';
      var s = Math.max(1, page - 2), e = Math.min(totalPages, s + 4); s = Math.max(1, e - 4);
      for (var i = s; i <= e; i++) h += '<button data-page="' + i + '" ' + (i === page ? 'aria-current="true"' : "") + '>' + i + '</button>';
      h += '<button data-page="' + (page + 1) + '" ' + (page >= totalPages ? "disabled" : "") + '>Next</button>';
      pager.innerHTML = h;
    }
    function load(page) {
      grid.innerHTML = '<div class="evo-rw__empty">Loading reviews…</div>';
      var qs = "shop=" + encodeURIComponent(shop) + "&page=" + page + "&limit=" + limit;
      if (isStoreMode) {
        qs += "&store=true";
      } else {
        qs += "&productId=" + encodeURIComponent(productId);
        if (productHandle) qs += "&productHandle=" + encodeURIComponent(productHandle);
        if (groupKey)      qs += "&groupKey=" + encodeURIComponent(groupKey);
      }
      fetch(apiBase + "/api/reviews?" + qs)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) { grid.innerHTML = '<div class="evo-rw__empty">Could not load reviews.</div>'; return; }
          root.dataset.page = String(d.page);
          avgEl.textContent = (d.average || 0).toFixed(1);
          totalEl.textContent = (d.totalRatings || 0) + " reviews";
          starsEl.innerHTML = starsHTML(d.average || 0);
          renderCards(d.reviews || []);
          renderPager(d.page, d.totalPages);
        })
        .catch(function () { grid.innerHTML = '<div class="evo-rw__empty">Could not load reviews.</div>'; });
    }
    pager.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-page]"); if (!b || b.disabled) return;
      load(parseInt(b.dataset.page, 10));
      root.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // Delegate clicks on thumbnails to open lightbox
    root.addEventListener("click", function(e){
      var th = e.target.closest("[data-evo-thumb]");
      if (!th) return;
      try {
        var imgs = JSON.parse(decodeURIComponent(th.dataset.imgs));
        var idx = parseInt(th.dataset.idx, 10) || 0;
        openLightbox(imgs, idx);
      } catch(_){}
    });

    // Modal
    var modal = root.querySelector("[data-evo-modal]");
    var openBtn = root.querySelector("[data-evo-write]");
    var closeBtn = root.querySelector("[data-evo-modal-close]");
    var form = root.querySelector("[data-evo-form]");
    var formMsg = root.querySelector("[data-evo-form-msg]");
    openBtn.addEventListener("click", function () { modal.hidden = false; });
    closeBtn.addEventListener("click", function () { modal.hidden = true; form.reset(); formMsg.textContent = ""; });
    modal.addEventListener("click", function (e) { if (e.target === modal) { modal.hidden = true; form.reset(); formMsg.textContent = ""; } });
    // Photo preview rendering as user picks files
    var photosInput = form.querySelector("[data-evo-photos]");
    var previewsEl  = form.querySelector("[data-evo-photo-previews]");
    if (photosInput) {
      photosInput.addEventListener("change", function() {
        previewsEl.innerHTML = "";
        var files = Array.prototype.slice.call(photosInput.files || []).slice(0, 5);
        files.forEach(function(f) {
          if (!f.type || !f.type.startsWith("image/")) return;
          var url = URL.createObjectURL(f);
          previewsEl.insertAdjacentHTML("beforeend",
            '<div class="evo-rw__photo-preview"><img src="' + url + '" alt=""/></div>');
        });
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      formMsg.textContent = "Submitting…";

      var fd = new FormData();
      fd.append("shop_domain", shop);
      fd.append("product_id", productId || "");
      fd.append("product_handle", productHandle || "");
      fd.append("author_name", form.author_name.value);
      fd.append("author_location", form.author_location.value || "");
      fd.append("rating", String(parseInt(form.rating.value, 10) || 5));
      fd.append("content", form.content.value);
      fd.append("is_verified", "false");

      if (photosInput && photosInput.files) {
        var files = Array.prototype.slice.call(photosInput.files).slice(0, 5);
        files.forEach(function(f) { fd.append("photos", f); });
      }

      fetch(apiBase + "/api/reviews", {
        method: "POST",
        body: fd,   // browser sets multipart/form-data automatically
      })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { formMsg.textContent = res.d.error || "Could not submit."; return; }
        formMsg.textContent = "Thanks! Your review is pending approval.";
        setTimeout(function () {
          modal.hidden = true; form.reset(); formMsg.textContent = "";
          if (previewsEl) previewsEl.innerHTML = "";
        }, 1400);
      })
      .catch(function () { formMsg.textContent = "Network error."; });
    });

    load(1);
  }

  // =====================================================
  // CARD BADGES — for collections, search, related, etc.
  // =====================================================
  var TITLE_SELECTORS = [
    "h1","h2","h3","h4","h5","h6",
    ".card__heading", ".card__title", ".card-title",
    ".product-card__title", ".product-card-title", ".product__title",
    ".product-title", ".grid-product__title",
    "[class*='card-title']", "[class*='card__title']",
    "[class*='product-title']", "[class*='product-card__title']",
    "[class*='product__title']", "[class*='card__heading']"
  ].join(",");

  function getLinkHandle(link) {
    if (!link) return null;
    var m = (link.getAttribute("href") || "").match(/\/products\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  // For a given title element, find the product handle in nearest ancestor (up to 5 levels)
  function findHandleForTitle(titleEl) {
    // 1. Link inside the title itself
    var inside = titleEl.querySelector && titleEl.querySelector('a[href*="/products/"]');
    var handle = getLinkHandle(inside);
    if (handle) return handle;
    // 2. The title might BE an anchor
    if (titleEl.tagName === "A") {
      handle = getLinkHandle(titleEl);
      if (handle) return handle;
    }
    // 3. Walk up to 5 levels and look for a product link inside that ancestor
    var n = titleEl.parentElement;
    for (var i = 0; i < 5 && n; i++) {
      var link = n.querySelector && n.querySelector('a[href*="/products/"]');
      var h = getLinkHandle(link);
      if (h) return h;
      n = n.parentElement;
    }
    return null;
  }

  function buildCardBadgeHTML(avg, count) {
    return '' +
      '<span class="evo-card-badge__star" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 2.5l2.95 6.4 7.05.7-5.3 4.85 1.55 6.95L12 17.9l-6.25 3.5L7.3 14.45 2 9.6l7.05-.7L12 2.5z" fill="#FFC107"/></svg>' +
      '</span>' +
      '<span class="evo-card-badge__avg">' + avg + '</span>' +
      '<span class="evo-card-badge__divider">|</span>' +
      '<span class="evo-card-badge__verified" aria-hidden="true">' +
        '<svg viewBox="0 0 18 18" width="12" height="12">' +
          '<polygon fill="#005eff" points="9,16 7.1,16.9 5.8,15.2 3.7,15.1 3.4,13 1.5,12 2.2,9.9 1.1,8.2 2.6,6.7 2.4,4.6 4.5,4 5.3,2 7.4,2.4 9,1.1 10.7,2.4 12.7,2 13.6,4 15.6,4.6 15.5,6.7 17,8.2 15.9,9.9 16.5,12 14.7,13 14.3,15.1 12.2,15.2 10.9,16.9"/>' +
          '<path d="M5.7 9.1 L7.8 11.2 L12.2 6.7" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>' +
      '</span>' +
      '<span class="evo-card-badge__count">(' + fmtCount(count) + ' Reviews)</span>';
  }

  function uniqueHandlesIn(el) {
    var out = new Set();
    var anchors = el.querySelectorAll('a[href*="/products/"]');
    for (var i = 0; i < anchors.length; i++) {
      var h = getLinkHandle(anchors[i]);
      if (h) out.add(h);
    }
    return out;
  }

  // Walk up from a product link until we find the SMALLEST container that:
  //   - Contains an <img>
  //   - Contains links pointing to EXACTLY ONE product (this one)
  // That's the product card. If we hit a container with multiple products, we
  // went too far (we entered the grid) and stop.
  function findStrictCard(link) {
    var n = link.parentElement;
    for (var depth = 0; depth < 6 && n; depth++) {
      var handles = uniqueHandlesIn(n);
      if (handles.size > 1) return null;        // we're in a grid, stop
      var hasImg = n.querySelector("img") !== null;
      if (hasImg && handles.size === 1) return n; // this is a product card
      n = n.parentElement;
    }
    return null;
  }

  // Skip cards inside shoppable-video / carousel widgets (e.g. "Watch & Buy"),
  // whose narrow layout clips the badge and makes it look broken.
  function inBlockedZone(el) {
    var n = el;
    for (var i = 0; i < 8 && n; i++) {
      var cls = (n.getAttribute && n.getAttribute("class")) || "";
      if (/reel|shoppable|watch|tolstoy|videowise|vibe|story|swiper|slick|flickity|splide|glide|carousel|slider/i.test(cls)) return true;
      // A <video> in a close ancestor means this is a shoppable-video card.
      if (i < 4 && n.querySelector && n.querySelector("video")) return true;
      n = n.parentElement;
    }
    return false;
  }

  function injectCardBadges() {
    if (cfg.showCardBadges === false) return;

    var seenCards = new WeakSet();
    var byHandle = {};  // handle -> [card,card,...]

    var links = document.querySelectorAll('a[href*="/products/"]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var handle = getLinkHandle(link);
      if (!handle) continue;
      if (isProductPage && handle === cfg.productHandle) continue;

      var card = findStrictCard(link);
      if (!card) continue;
      if (inBlockedZone(card)) continue;
      if (seenCards.has(card)) continue;
      if (card.querySelector("[data-evo-card-badge]")) {
        seenCards.add(card);
        continue;
      }
      seenCards.add(card);

      if (!byHandle[handle]) byHandle[handle] = [];
      byHandle[handle].push(card);
    }

    Object.keys(byHandle).forEach(function (handle) {
      fetch(apiBase + "/api/reviews?shop=" + encodeURIComponent(cfg.shop) +
            "&productHandle=" + encodeURIComponent(handle) +
            "&page=1&limit=1")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.totalRatings) return;
          var avg = (d.average || 0).toFixed(1);
          var count = d.totalRatings;
          byHandle[handle].forEach(function (card) {
            if (card.querySelector("[data-evo-card-badge]")) return;
            // Find the title within the card
            var title =
              card.querySelector("h1, h2, h3, h4, h5, h6") ||
              card.querySelector(TITLE_SELECTORS);
            if (!title) {
              // Fallback: any text-bearing product link
              var fb = card.querySelector('a[href*="/products/"]');
              if (fb && (fb.textContent || "").trim()) title = fb;
            }
            if (!title) return;

            var ref = title;
            if (ref.tagName === "A") ref = ref.parentElement || ref;
            var badge = document.createElement("div");
            badge.setAttribute("data-evo-card-badge", "");
            badge.className = "evo-card-badge";
            badge.innerHTML = buildCardBadgeHTML(avg, count);
            ref.parentNode.insertBefore(badge, ref.nextSibling);
          });
        })
        .catch(function () { /* silent */ });
    });
  }

  // ---------- Run after DOM ready ----------
  function init() {
    if (isProductPage) {
      try { injectBadge(); } catch(e){}
      try { injectGrid();  } catch(e){}
    }
    try { injectCardBadges(); } catch(e){}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Re-run card badges when AJAX-loaded collection grids change (some themes)
  var observer = new MutationObserver(function (muts) {
    var changed = false;
    muts.forEach(function (m) {
      if (m.addedNodes && m.addedNodes.length) {
        for (var i = 0; i < m.addedNodes.length; i++) {
          var n = m.addedNodes[i];
          if (n.nodeType === 1 && (n.querySelector && n.querySelector('a[href*="/products/"]'))) {
            changed = true; break;
          }
        }
      }
    });
    if (changed) {
      try { injectCardBadges(); } catch(e){}
    }
  });
  try {
    observer.observe(document.body, { childList: true, subtree: true });
  } catch(e){}
})();
