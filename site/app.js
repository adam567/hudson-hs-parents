// Hudson HS Parents — frontend.
// Vanilla JS + Supabase + Leaflet + Leaflet.draw. No build step.

(() => {
  const cfg = window.HHSP_CONFIG || {};
  const NEEDS_SETUP =
    !cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT") ||
    !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY === "YOUR_ANON_KEY";

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const fmt$ = n => n == null ? "—" : "$" + Math.round(n).toLocaleString();
  const fmtDate = s => s ? new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "—";
  const escape = s => (s == null ? "" : String(s)).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  const toast = (msg, ms = 2400) => {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms);
  };

  if (NEEDS_SETUP) {
    document.body.innerHTML = `
      <main style="max-width:600px;margin:60px auto;padding:24px;background:#fff;border:1px solid #e6e2d8;border-radius:8px;font:15px/1.5 -apple-system,system-ui,sans-serif">
        <h1 style="margin:0 0 12px">Setup needed</h1>
        <p>This deployment is missing its Supabase credentials. See <code>SETUP.md</code>.</p>
      </main>`;
    return;
  }

  if (location.hash && /^#error=/.test(location.hash)) {
    history.replaceState(null, "", location.pathname + location.search);
  }

  const supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" }
  });

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    user: null,
    prefs: null,
    targets: [],          // v_targets rows
    savedAreas: [],
    tags: [],             // [{id, name, household_ids:[...], notes, created_at, updated_at}]
    tagsByHh: new Map(),  // household_id -> [tag objects]
    selectedIds: new Set(),
    activeTagFilter: null,   // tag id, when filtering by a tag
    lastClickedIdx: -1,
    filters: {
      tiers: { T1: true, T2: true, T3: false },
      cohorts: new Set(),
      minValue: null, maxValue: null,
      minYears: null, maxYears: null,
      minSqft: null, maxSqft: null,
      minYearBuilt: null, maxYearBuilt: null,
      adultCount: "",
      mailingMode: "",
      search: "",
      drawnArea: null,           // {type:'Polygon', coordinates:[[[lng,lat],...]]}
      // Entity-owned households (trusts, LLCs) where voter records DON'T
      // resolve a natural-person resident: hidden by default. The agent
      // doesn't want to walk up to "South Family Revocable Trust" with no
      // idea who lives there. Toggle in Property to surface them.
      includeUnresolvedEntities: false,
    },
    map: null,
    markerLayer: null,
    heatLayer: null,
    drawLayer: null,
    drawControl: null,
    visibleSet: [],
    firstLoad: true,
    viewMode: "map",          // "map" | "list"
    // Multi-level sort. First entry is the primary sort, then ties are broken
    // by each subsequent entry. Click a header to set the primary sort
    // (replacing the list); shift-click to append a secondary/tertiary sort
    // or toggle the direction of an existing level. Default: strongest lead
    // at the top. Tier rank ascending (T1 first), with evidence_score as an
    // implicit final tiebreaker inside cmpOne when col === "tier".
    sort: [{ col: "tier", dir: "asc" }],
    // Dev-only one-time pass to classify owner-voter surname mismatches.
    // Gated on localStorage.dev_review === "1"; not visible to end users.
    review: {
      enabled: false,
      worklist: [],     // ordered household_ids of unreviewed mismatches
      cursor: 0,
    },
  };

  // ── Auth ────────────────────────────────────────────────────────────
  // Quick-login profiles: lets a household member sign in without typing.
  // Credentials are not secret — the threat model is URL-obscurity, since
  // nothing on this site warrants stronger auth (public-records data only).
  // Add a profile here, then either click the labeled button on the auth
  // screen or bookmark `?u=<key>` for a zero-click sign-in.
  const QUICK_LOGINS = {
    ts: { label: "Tiffany", email: "tiffanyscavone@gmail.com", password: "tststs" },
  };
  // Aliases let her type just "ts" in the email field if the form gets reset.
  const EMAIL_ALIASES = Object.fromEntries(
    Object.entries(QUICK_LOGINS).map(([k, v]) => [k, v.email])
  );

  async function doSignIn() {
    $("#authErr").textContent = "";
    let email = $("#email").value.trim();
    const password = $("#password").value;
    if (!email || !password) { $("#authErr").textContent = "Email and password required."; return; }
    if (EMAIL_ALIASES[email]) email = EMAIL_ALIASES[email];
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { $("#authErr").textContent = error.message; return; }
    await onSignedIn();
  }
  function quickSignIn(key) {
    const p = QUICK_LOGINS[key];
    if (!p) return;
    $("#email").value = p.email;
    $("#password").value = p.password;
    doSignIn();
  }
  $("#signInBtn").addEventListener("click", doSignIn);
  $("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") doSignIn(); });
  $("#email").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#password").focus(); });
  $("#quickTsBtn")?.addEventListener("click", () => quickSignIn("ts"));
  $("#signOutBtn").addEventListener("click", async () => {
    await supabase.auth.signOut(); location.reload();
  });

  async function start() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) { await onSignedIn(); return; }
    // Bookmark a URL with `?u=ts` for zero-click sign-in.
    const which = new URLSearchParams(location.search).get("u");
    if (which && QUICK_LOGINS[which]) {
      quickSignIn(which);
    }
  }

  async function onSignedIn() {
    $("#authView").hidden = true;
    $("#appView").hidden = false;
    $("#topbar").hidden = false;
    const { data: { user } } = await supabase.auth.getUser();
    state.user = user;
    $("#userEmail").textContent = user?.email || "";
    await loadPrefs();
    await loadEverything();
    await markLastSeen();
    initMap();
    bindUI();
    render();
  }

  // ── Data loaders ────────────────────────────────────────────────────
  async function loadPrefs() {
    const { data, error } = await supabase.from("user_preferences").select("*").maybeSingle();
    if (error) { console.warn("prefs", error); }
    if (!data) {
      // Auto-trigger should have created one; insert if missing.
      const { data: inserted } = await supabase.from("user_preferences")
        .insert({ user_id: state.user.id }).select().single();
      state.prefs = inserted;
    } else {
      state.prefs = data;
    }
    // Apply prefs to filter state
    if (state.prefs?.default_visible_tiers && Array.isArray(state.prefs.default_visible_tiers)) {
      const enabled = new Set(state.prefs.default_visible_tiers);
      ["T1","T2","T3"].forEach(t => state.filters.tiers[t] = enabled.has(t));
      $$("#sidebar [data-tier]").forEach(el => {
        el.checked = enabled.has(el.dataset.tier);
      });
    }
    // First-run intro banner for the "Adjacent leads" section.
    if (!state.prefs?.adjacent_leads_intro_dismissed_at) {
      const intro = $("#adjacentIntro");
      if (intro) intro.hidden = false;
    }
    // Apply persisted entity-owner toggle.
    if (state.prefs?.include_unresolved_entities === true) {
      state.filters.includeUnresolvedEntities = true;
      const cb = $("#filterIncludeEntities");
      if (cb) cb.checked = true;
    }
  }

  async function dismissAdjacentIntro() {
    const intro = $("#adjacentIntro");
    if (intro) intro.hidden = true;
    if (!state.prefs) return;
    state.prefs.adjacent_leads_intro_dismissed_at = new Date().toISOString();
    await supabase.from("user_preferences")
      .update({ adjacent_leads_intro_dismissed_at: state.prefs.adjacent_leads_intro_dismissed_at })
      .eq("user_id", state.user.id);
  }

  async function markLastSeen() {
    if (!state.prefs) return;
    await supabase.from("user_preferences")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", state.user.id);
  }

  async function loadEverything() {
    const results = await Promise.all([
      supabase.from("v_targets").select("*"),
      supabase.from("saved_areas").select("*").order("name"),
      supabase.from("tags").select("*").order("name"),
    ]);
    if (results[0].error) toast("targets: " + results[0].error.message);
    else state.targets = (results[0].data || []).filter(r => r.tier && r.tier !== "TX");
    state.savedAreas = results[1].data || [];
    state.tags = results[2].data || [];
    rebuildTagsByHh();
    drawTierCounts();
    drawSavedAreas();
    drawSavedTags();
    drawFreshness();
  }

  function rebuildTagsByHh() {
    state.tagsByHh = new Map();
    state.tags.forEach(t => {
      (t.household_ids || []).forEach(hid => {
        if (!state.tagsByHh.has(hid)) state.tagsByHh.set(hid, []);
        state.tagsByHh.get(hid).push(t);
      });
    });
  }

  function drawFreshness() {
    if (!state.targets.length) return;
    const dates = state.targets.map(r => r.refreshed_at).filter(Boolean).sort().reverse();
    if (dates[0]) $("#dataFreshness").textContent = "Data refreshed " + fmtDate(dates[0]);
  }

  function drawTierCounts() {
    const counts = { T1: 0, T2: 0, T3: 0 };
    state.targets.forEach(r => { if (counts[r.tier] != null) counts[r.tier]++; });
    Object.entries(counts).forEach(([t, n]) => {
      const el = $(`[data-count="${t}"]`);
      if (el) el.textContent = n;
    });
  }

  function drawSavedAreas() {
    const list = $("#savedAreaList");
    list.innerHTML = state.savedAreas.map(a => `
      <div class="saved-row" data-id="${a.id}">
        <span class="name">${escape(a.name)}</span>
        <button class="apply" title="Use as filter">use</button>
        <button class="del" title="Delete">×</button>
      </div>`).join("") || `<div class="muted small">No saved areas yet. Draw one on the map then save it here.</div>`;
    $$("#savedAreaList .apply").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest(".saved-row").dataset.id;
        const area = state.savedAreas.find(a => a.id === id);
        if (area) applyDrawnArea(area.geometry_geojson);
      });
    });
    $$("#savedAreaList .del").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.closest(".saved-row").dataset.id;
        if (!confirm("Delete this saved area?")) return;
        await supabase.from("saved_areas").delete().eq("id", id);
        state.savedAreas = state.savedAreas.filter(a => a.id !== id);
        drawSavedAreas();
      });
    });
  }

  // ── Filtering ───────────────────────────────────────────────────────
  function passesFilters(r) {
    if (!state.filters.tiers[r.tier]) return false;
    const f = state.filters;
    if (f.minValue != null && (r.market_value ?? 0) < f.minValue) return false;
    if (f.maxValue != null && (r.market_value ?? 0) > f.maxValue) return false;
    if (f.minYears != null && (r.years_owned ?? 0) < f.minYears) return false;
    if (f.maxYears != null && (r.years_owned ?? 0) > f.maxYears) return false;
    if (f.minSqft != null && (r.sqft ?? 0) < f.minSqft) return false;
    if (f.maxSqft != null && (r.sqft ?? 0) > f.maxSqft) return false;
    if (f.minYearBuilt != null && (r.year_built ?? 0) < f.minYearBuilt) return false;
    if (f.maxYearBuilt != null && (r.year_built ?? 0) > f.maxYearBuilt) return false;
    if (f.adultCount === "1" && r.adult_count !== 1) return false;
    if (f.adultCount === "2" && r.adult_count !== 2) return false;
    if (f.adultCount === "3" && (r.adult_count ?? 0) < 3) return false;
    if (f.mailingMode === "only" && !r.mailing_same_as_situs) return false;
    if (f.mailingMode === "exclude" && r.out_of_hudson_mailing) return false;
    if (!f.includeUnresolvedEntities && isInstitutionalOwner(r) && !hasResidentMatch(r)) return false;
    if (f.search) {
      const hay = [r.display_name, r.situs_address, ...(r.owner_names || [])].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    if (!cohortPasses(r)) return false;
    if (f.drawnArea && r.lat && r.lng) {
      if (!pointInPolygon([r.lng, r.lat], f.drawnArea)) return false;
    }
    if (state.activeTagFilter) {
      const tag = state.tags.find(t => t.id === state.activeTagFilter);
      if (!tag || !(tag.household_ids || []).includes(r.household_id)) return false;
    }
    return true;
  }

  function cohortPasses(r) {
    const cohorts = state.filters.cohorts;
    if (!cohorts.size) return true;
    const checks = {
      recent_grads: () => r.has_19_20_voter,
      long_tenure_15: () => (r.years_owned ?? 0) >= 15,
      long_tenure_25: () => (r.years_owned ?? 0) >= 25,
      top_value: () => {
        const sorted = state.targets
          .map(x => x.market_value).filter(x => x != null).sort((a,b) => b - a);
        if (!sorted.length) return false;
        const cutoff = sorted[Math.floor(sorted.length * 0.25)];
        return (r.market_value ?? 0) >= cutoff;
      },
      two_adults: () => (r.adult_count ?? 0) >= 2,
      single_adult: () => r.adult_count === 1,
      surname_match: () => r.owner_voter_surname_match === true
        || (r.owner_voter_surname_match === false
            && (r.owner_voter_review === "owner_lives_here" || r.owner_voter_review === "trust_or_llc")),
    };
    for (const c of cohorts) {
      if (!checks[c] || !checks[c]()) return false;
    }
    return true;
  }

  function pointInPolygon(point, polyGeoJson) {
    // polyGeoJson: GeoJSON Polygon — coordinates: [[[lng,lat], ...]]
    const rings = polyGeoJson.coordinates || [];
    if (!rings.length) return false;
    return ringContains(rings[0], point);
  }
  function ringContains(ring, [x, y]) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function applyDrawnArea(geo) {
    state.filters.drawnArea = geo;
    state._closeSidebar?.();
    if (state.drawLayer) state.drawLayer.clearLayers();
    if (geo && geo.coordinates) {
      const ll = geo.coordinates[0].map(([lng, lat]) => [lat, lng]);
      const poly = L.polygon(ll, { color: "#6b4f2a", weight: 2, fillOpacity: 0.08 }).addTo(state.drawLayer);
      state.map.fitBounds(poly.getBounds().pad(0.2));
    }
    render();
  }

  function syncFilterUI() {
    Object.entries(state.filters.tiers).forEach(([t, on]) => {
      const cb = $(`[data-tier="${t}"]`); if (cb) cb.checked = on;
    });
    $$(".chip").forEach(c => c.classList.toggle("active", state.filters.cohorts.has(c.dataset.cohort)));
    $("#filterMinValue").value = state.filters.minValue ?? "";
    $("#filterMaxValue").value = state.filters.maxValue ?? "";
    $("#filterMinYears").value = state.filters.minYears ?? "";
    $("#filterMaxYears").value = state.filters.maxYears ?? "";
    $("#filterMinSqft").value = state.filters.minSqft ?? "";
    $("#filterMaxSqft").value = state.filters.maxSqft ?? "";
    $("#filterMinYearBuilt").value = state.filters.minYearBuilt ?? "";
    $("#filterMaxYearBuilt").value = state.filters.maxYearBuilt ?? "";
    $("#filterAdultCount").value = state.filters.adultCount;
    $("#filterMailing").value = state.filters.mailingMode;
    $("#filterSearch").value = state.filters.search;
  }

  // ── Map ──────────────────────────────────────────────────────────────
  const BASEMAPS = {
    light: { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png", attribution: "© CARTO © OpenStreetMap" },
    street: { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap" },
    satellite: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "© Esri" },
  };
  let basemapLayer = null;

  function initMap() {
    const startCenter = [
      state.prefs?.default_map_center_lat ?? 41.2406,
      state.prefs?.default_map_center_lng ?? -81.4407,
    ];
    const startZoom = state.prefs?.default_map_zoom ?? 13;
    state.map = L.map("map", { zoomControl: true, preferCanvas: true, tap: false }).setView(startCenter, startZoom);
    setBasemap(state.prefs?.default_basemap || "light");
    state.markerLayer = L.layerGroup().addTo(state.map);
    state.drawLayer = new L.FeatureGroup().addTo(state.map);

    // Save viewport on moveend (debounced)
    let saveT;
    state.map.on("moveend", () => {
      clearTimeout(saveT);
      saveT = setTimeout(persistViewport, 800);
    });

    // Keep Leaflet's measured size in sync with CSS layout changes:
    // orientation flips, iOS address-bar collapse, sidebar overlay open/close,
    // map ⇄ list view toggle. ResizeObserver covers most of these in one shot.
    const mapEl = document.getElementById("map");
    let invalT;
    const requestInvalidate = () => {
      clearTimeout(invalT);
      invalT = setTimeout(() => {
        if (state.map && !mapEl.hidden) state.map.invalidateSize();
      }, 120);
    };
    if (window.ResizeObserver) new ResizeObserver(requestInvalidate).observe(mapEl);
    window.addEventListener("orientationchange", requestInvalidate);
    window.addEventListener("resize", requestInvalidate);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", requestInvalidate);

    // Leaflet.draw control
    state.drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polygon: { allowIntersection: false, shapeOptions: { color: "#6b4f2a", weight: 2 } },
        rectangle: { shapeOptions: { color: "#6b4f2a", weight: 2 } },
        marker: false, polyline: false, circle: false, circlemarker: false,
      },
      edit: { featureGroup: state.drawLayer, edit: false, remove: false },
    });
    state.map.on(L.Draw.Event.CREATED, evt => {
      state.drawLayer.clearLayers();
      state.drawLayer.addLayer(evt.layer);
      const gj = evt.layer.toGeoJSON();
      state.filters.drawnArea = gj.geometry;
      render();
      toast("Filtered to drawn area");
    });
  }

  function setBasemap(key) {
    if (basemapLayer) state.map.removeLayer(basemapLayer);
    const b = BASEMAPS[key] || BASEMAPS.light;
    basemapLayer = L.tileLayer(b.url, { maxZoom: 19, attribution: b.attribution }).addTo(state.map);
  }

  async function persistViewport() {
    const c = state.map.getCenter();
    const z = state.map.getZoom();
    await supabase.from("user_preferences")
      .update({
        default_map_center_lat: c.lat,
        default_map_center_lng: c.lng,
        default_map_zoom: z,
      }).eq("user_id", state.user.id);
  }

  function drawMap() {
    state.markerLayer.clearLayers();
    if (state.heatLayer) { state.map.removeLayer(state.heatLayer); state.heatLayer = null; }
    if ($("#layerHeatmap").checked) {
      const heatData = state.visibleSet
        .filter(r => r.lat && r.lng && r.tier !== "T3")  // T3 = adjacent, never contributes to senior density
        .map(r => {
          // T1 = ground truth; T2 = inferred. T3 is excluded above.
          const w = r.tier === "T1" ? 1.00 : 0.65;
          return [r.lat, r.lng, w];
        });
      state.heatLayer = L.heatLayer(heatData, { radius: 24, blur: 18 }).addTo(state.map);
    }
    state.visibleSet.forEach(r => {
      if (!r.lat || !r.lng) return;
      const innerCls = `lead-marker marker-${r.tier}` +
                       (state.firstLoad && r.tier === "T1" ? " first-load" : "");
      // 28x28 transparent wrapper gives fingers a real tap target while the
      // inner span keeps the tier-specific 9–14px visual size.
      const icon = L.divIcon({
        className: "marker-hit",
        html: `<span class="${innerCls}"></span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const m = L.marker([r.lat, r.lng], { icon });
      m.on("click", () => openDrawer(r.household_id));
      state.markerLayer.addLayer(m);
    });
    if (state.firstLoad) {
      const pins = state.visibleSet.filter(r => r.lat && r.lng);
      if (pins.length >= 2) {
        const lats = pins.map(p => p.lat), lngs = pins.map(p => p.lng);
        state.map.fitBounds(
          [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]],
          { padding: [40, 40], maxZoom: 16 }
        );
      }
    }
    state.firstLoad = false;
    $("#visibleCount").textContent = `${state.visibleSet.length.toLocaleString()} households visible`;
  }

  // ── List view ───────────────────────────────────────────────────────
  // Single-column comparator. Multi-level sort lives in compareSorted below,
  // which calls this for each level until one returns non-zero.
  function cmpOne(a, b, col, dir) {
    const sgn = dir === "desc" ? -1 : 1;
    let av, bv;
    if (col === "tier") {
      // Sort the "Lead" column by user-priority rank (T1 > T2 > T3), not
      // alphabetically. Tiebreak on evidence_score (highest first) so the
      // default "strongest lead at the top" works after a single click —
      // only as the LAST resort, after any user-added sort levels.
      av = TIER_RANK[a.tier] ?? 99;
      bv = TIER_RANK[b.tier] ?? 99;
      if (av !== bv) return (av - bv) * sgn;
      return ((b.evidence_score ?? -Infinity) - (a.evidence_score ?? -Infinity)) * sgn;
    }
    if (col === "parent_1" || col === "parent_2") {
      const idx = col === "parent_1" ? 0 : 1;
      av = parentFirstName(a, idx).toUpperCase();
      bv = parentFirstName(b, idx).toUpperCase();
      // Empty parent names sort last regardless of direction
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      if (av < bv) return -1 * sgn;
      if (av > bv) return  1 * sgn;
      return 0;
    }
    if (col === "senior_score") {
      av = (a.count_17_18_voters ?? 0) * 10 + (a.count_19_20_voters ?? 0);
      bv = (b.count_17_18_voters ?? 0) * 10 + (b.count_19_20_voters ?? 0);
    } else {
      av = a[col]; bv = b[col];
    }
    if (typeof av === "string" || typeof bv === "string") {
      av = (av || "").toString().toUpperCase();
      bv = (bv || "").toString().toUpperCase();
      if (av < bv) return -1 * sgn;
      if (av > bv) return  1 * sgn;
      return 0;
    }
    av = av ?? -Infinity;
    bv = bv ?? -Infinity;
    return (av - bv) * sgn;
  }
  function compareSorted(a, b) {
    for (const { col, dir } of state.sort) {
      const c = cmpOne(a, b, col, dir);
      if (c !== 0) return c;
    }
    return 0;
  }
  // Sensible default direction for a freshly-clicked column. Names ascend
  // (A→Z); numbers and lead-tier descend so the strongest values land first.
  function defaultDir(col) {
    return (col === "display_name" || col === "situs_address" || col === "tier"
            || col === "parent_1" || col === "parent_2") ? "asc" : "desc";
  }

  // Public-facing names. Internal tier codes (T1, T2, T3, TX) stay in the DB;
  // this map is the single source of truth for what the user sees.
  const TIER_LABEL = {
    T1: "Confirmed Senior",
    T2: "Likely Senior — Parent Pattern",
    T3: "Recent Grad",
  };
  // Numeric rank shown in the "Lead" badge column. T3 is off-thesis adjacent;
  // its "Adj." label keeps it off the senior ladder rather than implying rank-3.
  const TIER_BADGE = { T1: "1", T2: "2", T3: "Adj." };
  // Sort/visual rank — drives table sort-by-Lead, sidebar order, marker size,
  // and heatmap weight. T3 stays last as an adjacent category.
  const TIER_RANK = { T1: 1, T2: 2, T3: 3 };
  // Identity passthrough — kept so callers below remain stable. Vendor-name
  // sanitisation used to live here; the migration that retired the vendor
  // also stripped its text from why_sentence at the source.
  const sanitizeText = s => (s == null ? "" : String(s));

  // Owner names in the parcel data are "LASTNAME FIRSTNAME [MIDDLE]" all caps.
  // Tables stay last-first (faster to scan a sorted column); modals flip to
  // "Firstname Lastname" so the agent reads it the way she'd say it aloud.
  const INST_TOKENS = /\b(LLC|TRUST|TRUSTEE|INC|CORP|FOUNDATION|BANK|ESTATE|ATTN|C\/O|ESQ)\b/i;
  const titleCase = s => String(s || "").toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  function flipOwnerName(s, isInstitutional) {
    if (!s) return "";
    const trimmed = String(s).trim();
    if (isInstitutional || INST_TOKENS.test(trimmed)) return titleCase(trimmed);
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return titleCase(trimmed);
    const last = parts[0];
    const rest = parts.slice(1).join(" ");
    return `${titleCase(rest)} ${titleCase(last)}`;
  }
  // Anchor: today, with the same June-30 cutoff used by recompute_tiers so the
  // age she sees in the modal matches the age that drove the tier assignment.
  function ageFromBirthYear(by) {
    if (!by) return null;
    const now = new Date();
    const beforeCutoff = (now.getMonth() + 1 < 6) || (now.getMonth() + 1 === 6 && now.getDate() < 30);
    return now.getFullYear() - Number(by) - (beforeCutoff ? 1 : 0);
  }

  // Most family trusts ("SOUTH FAMILY REVOCABLE TRUST", "JOHNSON FAMILY LLC")
  // are held for the benefit of the parents who actually live there. When the
  // parcel's legal owner is an entity but adult voters are registered at the
  // address, treat those voters as the de-facto owners and demote the entity
  // name to a small "Legal title" disclosure.
  function isInstitutionalOwner(r) {
    return !!r && r.institutional_owner === true;
  }
  function hasResidentMatch(r) {
    return Array.isArray(r?.resident_names) && r.resident_names.length > 0;
  }
  // Effective owner names for display. Returns:
  //   { primary: "Firstname Lastname", all: ["Firstname Lastname", ...],
  //     legalTitleNote: string|null, isResolvedEntity: bool }
  function effectiveOwners(r) {
    const inst = isInstitutionalOwner(r);
    if (inst && hasResidentMatch(r)) {
      return {
        primary: r.resident_names[0],
        all: r.resident_names.slice(),
        legalTitleNote: titleCase(r.display_name || ""),
        isResolvedEntity: true,
      };
    }
    if (inst) {
      // Unresolved entity — no voter at address. Show the entity name; agent
      // will see the "needs research" caveat in the modal.
      return {
        primary: titleCase(r.display_name || "Entity-owned (no resident on file)"),
        all: (r.owner_names || []).map(n => flipOwnerName(n, true)),
        legalTitleNote: null,
        isResolvedEntity: false,
      };
    }
    // Natural-person owner — flip "LASTNAME FIRSTNAME" → "Firstname Lastname".
    return {
      primary: flipOwnerName(r.display_name, false),
      all: (r.owner_names || []).map(n => flipOwnerName(n, false)),
      legalTitleNote: null,
      isResolvedEntity: false,
    };
  }
  // Last-first format for the table column, derived from a "Firstname Lastname"
  // resident_names entry. Splits on the LAST whitespace so multi-word given
  // names ("Mary Beth Heginbotham") become "Heginbotham Mary Beth".
  function lastFirstFromFirstLast(name) {
    if (!name) return "";
    const s = String(name).trim();
    const i = s.lastIndexOf(" ");
    if (i <= 0) return s;
    return `${s.slice(i + 1)} ${s.slice(0, i)}`;
  }
  // First-name only for the parent columns. Skips middle initials.
  //
  // Source priority: resident_names (voter file, eldest first) > owner_names
  // (parcel title). The parcel often records only owner1, so most households
  // have NULL for owner_names[1] — the voter file is what fills in Parent 2.
  function parentFirstName(r, idx) {
    if (hasResidentMatch(r) && r.resident_names[idx]) {
      const parts = String(r.resident_names[idx]).trim().split(/\s+/);
      return parts[0] || "";
    }
    const raw = (r.owner_names || [])[idx];
    if (!raw) return "";
    const parts = String(raw).trim().split(/\s+/);
    if (parts.length < 2) return "";
    return titleCase(parts[1]);  // second token = first name; drops middle/suffix
  }

  // Surname only for the Owner column — Parent 1 already shows the first name,
  // so duplicating it in Owner just bloats the row.
  function surnameFor(r) {
    if (hasResidentMatch(r)) {
      const n = r.resident_names[0];
      const i = String(n).lastIndexOf(" ");
      return i > 0 ? n.slice(i + 1) : n;
    }
    if (isInstitutionalOwner(r)) return null;  // unresolved entity — caller falls back
    const raw = (r.owner_names || [])[0] || r.display_name || "";
    const parts = String(raw).trim().split(/\s+/);
    return parts.length ? titleCase(parts[0]) : "";
  }

  function tableOwnerCell(r) {
    // Unresolved entity: keep the entity treatment so the agent sees the
    // legal-title oddity directly in the row (these are mostly hidden by the
    // default filter, but visible when she opts in).
    if (isInstitutionalOwner(r) && !hasResidentMatch(r)) {
      return `<span class="muted">${escape(titleCase(r.display_name || ""))}</span><span class="owner-entity-tag" title="Entity-owned, no resident on voter file.">entity</span>`;
    }
    const surname = surnameFor(r) || "—";
    if (isInstitutionalOwner(r)) {
      // Resolved entity — surname comes from the voter at the address.
      return `${escape(surname)}<span class="owner-derived" title="Owner is an entity (${escape(r.display_name || "")}); surname taken from the voter file at this address.">ⓘ</span>`;
    }
    return escape(surname);
  }

  function drawList() {
    const sorted = state.visibleSet.slice().sort(compareSorted);
    state.listOrder = sorted;     // ordered by current sort, used for shift-click range
    const body = $("#hhTableBody");
    if (!sorted.length) {
      body.innerHTML = `<tr><td colspan="11" class="muted small" style="padding:24px;text-align:center">No households match the current filters.</td></tr>`;
    } else {
      body.innerHTML = sorted.map((r, i) => {
        const checked = state.selectedIds.has(r.household_id);
        const tagsForRow = (state.tagsByHh.get(r.household_id) || [])
          .map(t => `<span class="row-tag-chip">${escape(t.name)}</span>`).join("");
        const p1 = parentFirstName(r, 0);
        const p2 = parentFirstName(r, 1);
        return `
        <tr data-id="${r.household_id}" data-idx="${i}" class="${checked ? "selected" : ""}">
          <td class="check-col"><input type="checkbox" class="row-cb" ${checked ? "checked" : ""}></td>
          <td><span class="tier-badge ${r.tier}" title="${escape(TIER_LABEL[r.tier] || "")}">${escape(TIER_BADGE[r.tier] || r.tier)}</span></td>
          <td class="owner">${tableOwnerCell(r)}</td>
          <td>${escape(p1)}</td>
          <td>${escape(p2)}</td>
          <td class="addr">${escape(r.situs_address || "—")}</td>
          <td class="num">${r.market_value != null ? "$" + Math.round(r.market_value).toLocaleString() : "—"}</td>
          <td class="num">${r.years_owned ?? "—"}</td>
          <td class="num">${r.adult_count ?? "—"}</td>
          <td class="num">${r.count_17_18_voters ? r.count_17_18_voters : (r.count_19_20_voters ? "·" + r.count_19_20_voters : "—")}</td>
          <td class="tags-col">${tagsForRow}</td>
        </tr>`;
      }).join("");
    }
    $$("#hhTable thead th[data-sort]").forEach(th => {
      th.classList.remove("sorted-asc","sorted-desc");
      th.removeAttribute("data-sort-level");
      const idx = state.sort.findIndex(l => l.col === th.dataset.sort);
      if (idx >= 0) {
        th.classList.add(state.sort[idx].dir === "asc" ? "sorted-asc" : "sorted-desc");
        if (state.sort.length > 1) th.setAttribute("data-sort-level", String(idx + 1));
      }
    });
    const sortLabelMap = {
      senior_score: "senior signal",
      tier: "lead",
      display_name: "owner",
      parent_1: "parent 1",
      parent_2: "parent 2",
      situs_address: "address",
    };
    const sortDescr = state.sort
      .map(l => `${sortLabelMap[l.col] || l.col.replace(/_/g, " ")} (${l.dir})`)
      .join(", then ");
    $("#listToolbar").textContent = `${sorted.length.toLocaleString()} households · sorted by ${sortDescr}`;
    $("#visibleCount").textContent = `${sorted.length.toLocaleString()} households visible`;
    refreshSelectionUI();
  }

  function refreshSelectionUI() {
    const n = state.selectedIds.size;
    $("#selectionCount").textContent = n ? `${n} selected` : "";
    $("#tagSelectionBtn").disabled = n === 0;
    $("#clearSelectionBtn").disabled = n === 0;
    // Header checkbox state — checked if every visible row is selected
    const allChecked = state.listOrder?.length && state.listOrder.every(r => state.selectedIds.has(r.household_id));
    const someChecked = state.listOrder?.some(r => state.selectedIds.has(r.household_id));
    const cb = $("#selectAllCb");
    if (cb) {
      cb.checked = !!allChecked;
      cb.indeterminate = !!someChecked && !allChecked;
    }
  }

  function toggleSelect(hid, on) {
    if (on) state.selectedIds.add(hid); else state.selectedIds.delete(hid);
    const tr = document.querySelector(`#hhTableBody tr[data-id="${hid}"]`);
    if (tr) {
      tr.classList.toggle("selected", on);
      const cb = tr.querySelector(".row-cb");
      if (cb) cb.checked = on;
    }
  }

  function clearSelection() {
    state.selectedIds.clear();
    $$("#hhTableBody tr.selected").forEach(tr => tr.classList.remove("selected"));
    $$("#hhTableBody .row-cb").forEach(cb => cb.checked = false);
    state.lastClickedIdx = -1;
    refreshSelectionUI();
  }

  function drawSavedTags() {
    const list = $("#tagList");
    if (!list) return;
    list.innerHTML = state.tags.length ? state.tags.map(t => `
      <div class="saved-row ${state.activeTagFilter === t.id ? "active" : ""}" data-id="${t.id}">
        <span class="name">${escape(t.name)}</span>
        <span class="tag-count">${(t.household_ids || []).length}</span>
        <button class="apply" title="Filter to this tag">filter</button>
        <button class="export" title="Export this tag…">export ▾</button>
        <button class="del" title="Delete tag">×</button>
        <div class="tag-export-menu" hidden>
          <button class="btn ghost block" data-tag-export="csv">Plain CSV</button>
          <button class="btn ghost block" data-tag-export="xlsx">Excel (.xlsx)</button>
          <button class="btn ghost block" data-tag-export="mymaps">Google Maps (mymaps.google.com) (CSV)</button>
          <button class="btn ghost block" data-tag-export="avery5160">Avery 5160 (30/sheet)</button>
          <button class="btn ghost block" data-tag-export="avery5161">Avery 5161 (20/sheet)</button>
          <button class="btn ghost block" data-tag-export="avery5163">Avery 5163 (10/sheet)</button>
          <button class="btn ghost block" data-tag-export="avery5164">Avery 5164 (6/sheet doorhang)</button>
        </div>
      </div>`).join("") : `<div class="muted small">No tags yet. Multiselect rows in List view, then "Tag selection".</div>`;
    $$("#tagList .apply").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.closest(".saved-row").dataset.id;
        state.activeTagFilter = state.activeTagFilter === id ? null : id;
        drawSavedTags();
        render();
        toast(state.activeTagFilter ? "Filtered to tag" : "Tag filter cleared");
      });
    });
    $$("#tagList .export").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = btn.closest(".saved-row");
        const menu = row.querySelector(".tag-export-menu");
        // Close any other open per-tag export menus.
        $$("#tagList .tag-export-menu").forEach(m => { if (m !== menu) m.hidden = true; });
        menu.hidden = !menu.hidden;
      });
    });
    $$("#tagList [data-tag-export]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const row = btn.closest(".saved-row");
        const id = row.dataset.id;
        const kind = btn.dataset.tagExport;
        const tag = state.tags.find(t => t.id === id);
        if (!tag) return;
        const set = householdsForTag(id);
        runExportFor(kind, set, `tag-${tag.name}`);
        row.querySelector(".tag-export-menu").hidden = true;
      });
    });
    $$("#tagList .del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.closest(".saved-row").dataset.id;
        const tag = state.tags.find(t => t.id === id);
        if (!confirm(`Delete tag "${tag?.name}"? Households keep their other tags.`)) return;
        const { error } = await supabase.from("tags").delete().eq("id", id);
        if (error) { toast(error.message); return; }
        state.tags = state.tags.filter(t => t.id !== id);
        if (state.activeTagFilter === id) state.activeTagFilter = null;
        rebuildTagsByHh();
        drawSavedTags();
        render();
        toast("Tag deleted");
      });
    });
  }

  function openTagModal() {
    if (!state.selectedIds.size) return;
    const selectedArr = Array.from(state.selectedIds);
    const existing = state.tags.map(t => `
      <button class="chip" data-tag-id="${t.id}">
        ${escape(t.name)} <span class="muted small">(${(t.household_ids || []).length})</span>
      </button>`).join("");
    $("#tagModalBody").innerHTML = `
      <p class="muted small">Apply an existing tag to ${selectedArr.length} selected household${selectedArr.length === 1 ? "" : "s"}, or create a new one.</p>
      <label>New tag
        <input type="text" id="newTagName" placeholder="e.g. Spring 2026, Old church friends, Follow up">
      </label>
      <div class="actions"><button class="btn primary" id="createTagBtn">Create + apply</button></div>
      ${state.tags.length ? `<h3 style="margin-top:14px">Existing tags</h3>
      <div class="tag-modal-existing">${existing}</div>` : ""}
    `;
    $("#tagModal").hidden = false;
    $("#newTagName").focus();
    $("#createTagBtn").addEventListener("click", async () => {
      const name = $("#newTagName").value.trim();
      if (!name) { toast("Name required"); return; }
      if (state.tags.find(t => t.name.toLowerCase() === name.toLowerCase())) {
        toast(`Tag "${name}" exists — click it instead`); return;
      }
      const { data, error } = await supabase.from("tags").insert({
        user_id: state.user.id, name, household_ids: selectedArr,
      }).select().single();
      if (error) { toast(error.message); return; }
      state.tags.push(data);
      rebuildTagsByHh();
      drawSavedTags();
      $("#tagModal").hidden = true;
      toast(`Tagged ${selectedArr.length} as "${name}"`);
      drawList();
    });
    $$(".tag-modal-existing .chip").forEach(b => {
      b.addEventListener("click", async () => {
        const id = b.dataset.tagId;
        const tag = state.tags.find(t => t.id === id);
        if (!tag) return;
        const merged = Array.from(new Set([...(tag.household_ids || []), ...selectedArr]));
        const added = merged.length - (tag.household_ids || []).length;
        const { data, error } = await supabase.from("tags")
          .update({ household_ids: merged }).eq("id", id).select().single();
        if (error) { toast(error.message); return; }
        Object.assign(tag, data);
        rebuildTagsByHh();
        drawSavedTags();
        $("#tagModal").hidden = true;
        toast(added > 0 ? `Added ${added} to "${tag.name}"` : `Already in "${tag.name}"`);
        drawList();
      });
    });
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    $("#map").hidden = (mode !== "map");
    $("#listView").hidden = (mode !== "list");
    $$(".view-toggle .vt").forEach(b => {
      const on = b.dataset.view === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (mode === "map" && state.map) {
      // Leaflet needs a nudge after being unhidden so it re-measures.
      setTimeout(() => state.map.invalidateSize(), 30);
    }
    render();
  }

  // ── Drawer ──────────────────────────────────────────────────────────
  let drawerHouseholdId = null;
  $("#closeDrawer").addEventListener("click", () => { $("#drawer").hidden = true; drawerHouseholdId = null; });

  // Verdict + basis lines for the modal banner. Per-tier two-sentence
  // statement that re-onboards the user every time the drawer opens —
  // she is not expected to remember any tier taxonomy between opens.
  const TIER_BANNER = {
    T1: {
      verdict: "A high-school senior lives here.",
      basisFn: r => `A 17- or 18-year-old is registered to vote at this address${r.count_17_18_voters > 1 ? ` (${r.count_17_18_voters} on file)` : ""}.`,
    },
    T2: {
      verdict: "A high-school senior likely lives here — inferred.",
      basisFn: r => `Two parent-age adults (42–63) own this home and have lived here ${r.years_owned ?? "8+"} years — the textbook profile of a senior's parents — but no kid voter at this address confirms it.`,
    },
    T3: {
      verdict: "A recent high-school grad is registered here.",
      basisFn: r => `A 19- or 20-year-old is registered to vote at this address${r.count_19_20_voters > 1 ? ` (${r.count_19_20_voters} on file)` : ""}. The student has likely already graduated and may have left the home.`,
      eyebrow: "Adjacent — recent grad",
    },
  };

  // Glyph in the banner — color comes from the per-tier .banner--tX class.
  const TIER_GLYPH = { T1: "●", T2: "●", T3: "◇" };

  // Per-tier "what we couldn't verify" caveat. Empty for T1 (verified).
  const TIER_CAVEAT = {
    T1: "",
    T2: "No kid is registered to vote at this address. This is a pattern-based inference — strong, but unverified.",
    T3: "Their kid is age 19–20 and may have already left home. This isn't a current senior — it's an adjacent lead.",
  };

  // User-facing evidence prose (≤ 3 lines). Replaces the engineer-style
  // ✓/—/· derivation list. Sentences carry their own meaning, so the
  // user doesn't have to recall a lexicon every modal open.
  function evidenceForUser(r) {
    const items = [];
    const v17 = r.count_17_18_voters ?? 0;
    const v19 = r.count_19_20_voters ?? 0;
    const adults4263 = r.adult_42_63_count ?? 0;
    const yrs = r.years_owned;

    if (v17 > 0) {
      items.push(["yes", `A 17- or 18-year-old is registered to vote at this address${v17 > 1 ? ` (${v17} on file)` : ""}.`]);
    }
    if (v19 > 0 && r.tier === "T3") {
      items.push(["yes", `A 19- or 20-year-old is registered to vote here${v19 > 1 ? ` (${v19} on file)` : ""}.`]);
    }
    if (adults4263 >= 2) {
      items.push(["yes", `${adults4263} parent-age adults (42–63) are registered here.`]);
    }
    if (yrs != null && yrs >= 8) {
      items.push(["yes", `The owners have lived here ${yrs} years.`]);
    }
    if (r.owner_voter_surname_match === true
        || (r.owner_voter_surname_match === false
            && (r.owner_voter_review === "owner_lives_here" || r.owner_voter_review === "trust_or_llc"))) {
      items.push(["yes", "The owner's surname matches a voter at this address."]);
    }
    return items.slice(0, 3);
  }

  // Engineer-only predicate list, retained for the debug disclosure.
  function derivationForDebug(r) {
    const checks = [];
    const v17 = r.count_17_18_voters ?? 0;
    const v19 = r.count_19_20_voters ?? 0;
    const adults4263 = r.adult_42_63_count ?? 0;
    const yrs = r.years_owned;

    if (r.tier === "T1") {
      checks.push(["✓", `Voter file shows ${v17} resident${v17 === 1 ? "" : "s"} age 17–18`]);
    }
    if (r.tier === "T2") {
      checks.push([adults4263 >= 2 ? "✓" : "—",
        `${adults4263} parent-age (42–63) adult${adults4263 === 1 ? "" : "s"} at address — need ≥ 2`]);
      checks.push([(yrs ?? 0) >= 8 ? "✓" : "—",
        `${yrs ?? "?"} years owned — need ≥ 8`]);
      checks.push([r.mailing_same_as_situs ? "✓" : "—", "Owner-occupied"]);
      checks.push([r.institutional_owner ? "—" : "✓", "Non-institutional owner"]);
      if (v17 === 0) checks.push(["·", "No 17–18 voter at this address (would be T1)"]);
      if (r.owner_voter_review === "absentee_or_rental") {
        checks.push(["—", "Reviewed: not owner-occupied (would otherwise be T2)"]);
      }
    }
    if (r.tier === "T3") {
      checks.push(["✓", `Voter file shows ${v19} resident${v19 === 1 ? "" : "s"} age 19–20`]);
      if (v17 === 0) checks.push(["·", "No 17–18 voter at this address (would be T1)"]);
    }
    return checks;
  }

  async function openDrawer(id) {
    const r = state.targets.find(x => x.household_id === id);
    if (!r) return;
    drawerHouseholdId = id;
    state._closeSidebar?.();

    // Drawer head: identity-only. Pin dot + owner name (resident-substituted
    // for entity-owned) + address. The adjacent-pill renders only for T3.
    const tierKey = r.tier;
    const isAdjacent = tierKey === "T3";
    const eff = effectiveOwners(r);
    // Up to two names in the head ("John South & Mary South"); the rest live
    // in the Household roster section below.
    const headPrimary = eff.all.slice(0, 2).join(" & ") || eff.primary || "Unknown owner";
    $("#dTier").innerHTML = isAdjacent
      ? `<span class="adjacent-pill">Adjacent — recent grad</span>`
      : "";
    $("#dName").innerHTML = `<span class="pin-preview ${tierKey} dName-dot"></span>${escape(headPrimary)}`;
    const addrLine = `${r.situs_address || "—"}${r.situs_city ? ", " + r.situs_city : ""} ${r.situs_zip || ""}`;
    const legalTitleHtml = eff.legalTitleNote
      ? `<div class="muted small legal-title">Legal title: ${escape(eff.legalTitleNote)}</div>`
      : (isInstitutionalOwner(r) && !hasResidentMatch(r)
          ? `<div class="muted small legal-title legal-title-unresolved">Entity-owned · no resident on voter file</div>`
          : "");
    $("#dAddr").innerHTML = `${escape(addrLine)}${legalTitleHtml}`;

    // Conviction banner — verdict + basis. The whole modal pivots on this.
    const cls = tierKey.toLowerCase();
    const banner = TIER_BANNER[tierKey] || { verdict: "Lead.", basisFn: () => "" };
    const eyebrow = banner.eyebrow
      ? `<span class="banner-eyebrow">${escape(banner.eyebrow)}</span>`
      : "";
    const bannerHtml = `
      <div class="banner banner--${cls}">
        <span class="banner-glyph">${TIER_GLYPH[tierKey] || "●"}</span>
        <div class="banner-text">
          ${eyebrow}
          <div class="banner-verdict">${escape(banner.verdict)}</div>
          <div class="banner-basis">${escape(banner.basisFn(r))}</div>
        </div>
      </div>`;

    // Why we think this — up to 3 prose sentences.
    const evidenceItems = evidenceForUser(r);
    const evidenceHtml = evidenceItems.length ? `
      <div class="section-h">Why we think this</div>
      <ul class="evidence-list">
        ${evidenceItems.map(([mark, txt]) =>
          `<li><span class="ev-mark ${mark === "yes" ? "" : "ev-context"}">${mark === "yes" ? "✓" : "·"}</span><span>${escape(txt)}</span></li>`
        ).join("")}
      </ul>` : "";

    // What we couldn't verify — conditional caveat block.
    const caveat = TIER_CAVEAT[tierKey];
    const caveatHtml = caveat ? `
      <div class="section-h">What we couldn't verify</div>
      <div class="caveat-block">${escape(caveat)}</div>` : "";

    // Property facts — reordered, trimmed. No raw voter counts, no DZ row.
    const facts = [
      ["Years at this address", r.years_owned == null ? "unknown" : `${r.years_owned} years`],
      ["Owner lives here", r.mailing_same_as_situs ? "yes" : "no"],
      ["Adults at address", r.adult_count ?? 0],
      ["Year built", r.year_built ?? "—"],
      ["Square feet", r.sqft ? r.sqft.toLocaleString() : "—"],
      [`<span title="County-assessed market value from the Summit County fiscal office. Reflects the most recent reappraisal, not a current real-estate appraisal or asking price; actual sale prices typically run higher.">Market value (est.)</span>`, fmt$(r.market_value), true],
    ];

    // Owners on record — rendered as "Firstname Lastname" (table stays
    // last-first; modal flips for natural reading). When the legal owner is
    // an entity, treat the resident voters as the owners and add a small
    // "Legal title" line for full disclosure.
    const ownerSubLabel = eff.isResolvedEntity ? "Owners (residents on voter file)" : "Owners on record";
    const ownerList = eff.all.length
      ? eff.all.map(o => `<div class="muted small">${escape(o)}</div>`).join("")
      : `<div class="muted small">—</div>`;

    // Engineer-only debug disclosure (collapsed by default).
    const debugChecks = derivationForDebug(r).map(([mark, txt]) =>
      `${mark}  ${txt}`
    ).join("\n");
    const debugBody = [
      `Tier code: ${tierKey}`,
      `Lead score: ${r.evidence_score ?? "—"}`,
      `Surname match: ${r.owner_voter_surname_match === true ? "yes" : r.owner_voter_surname_match === false ? "no" : "unknown"}`,
      `Surname review: ${r.owner_voter_review || "—"}`,
      `17–18 voters: ${r.count_17_18_voters ?? 0}`,
      `19–20 voters: ${r.count_19_20_voters ?? 0}`,
      ``,
      `Derivation:`,
      debugChecks,
    ].join("\n");

    $("#drawerBody").innerHTML = `
      ${bannerHtml}

      <div class="section-h">Household</div>
      <div class="hh-roster">
        <div class="hh-roster-sub muted small">${escape(ownerSubLabel)}</div>
        <div class="hh-roster-list">${ownerList}</div>
        ${eff.legalTitleNote ? `<div class="muted small legal-title-roster">Legal title on parcel: ${escape(eff.legalTitleNote)}</div>` : ""}
        <div class="hh-roster-sub muted small" style="margin-top:8px">Registered to vote at this address</div>
        <div class="hh-roster-list" id="dVoterList"><div class="muted small">Loading…</div></div>
      </div>

      ${evidenceHtml}
      ${caveatHtml}

      <div class="section-h">About the property</div>
      ${facts.map(([k,v,raw]) => `<div class="fact"><span class="k">${raw ? k : escape(k)}</span><span>${escape(String(v))}</span></div>`).join("")}

      <details class="drawer-debug">
        <summary>Show internals (debug)</summary>
        <pre class="drawer-debug-body">${escape(debugBody)}</pre>
      </details>
    `;
    $("#drawer").hidden = false;

    // Fetch voter roster for this address. Render asynchronously — drawer is
    // already up; voter list fills in as soon as the query returns.
    if (r.address_key) {
      const myReqId = drawerHouseholdId;
      supabase.from("voter_records")
        .select("first_name,last_name,birth_year,party")
        .eq("address_key", r.address_key)
        .then(({ data, error }) => {
          // Drawer might have been closed or another row opened — bail.
          if (drawerHouseholdId !== myReqId) return;
          const slot = $("#dVoterList");
          if (!slot) return;
          if (error || !data) { slot.innerHTML = `<div class="muted small">—</div>`; return; }
          if (!data.length) { slot.innerHTML = `<div class="muted small">No voter on file at this address.</div>`; return; }
          // Sort eldest first; pin senior-age (17–18) and recent-grad-age (19–20)
          // at the bottom so the parents read first, but tag them so they pop.
          const rows = data.map(v => {
            const age = ageFromBirthYear(v.birth_year);
            const name = `${titleCase(v.first_name || "")} ${titleCase(v.last_name || "")}`.trim();
            return { name, age, party: v.party };
          }).sort((a, b) => (b.age ?? -1) - (a.age ?? -1));
          slot.innerHTML = rows.map(v => {
            const tag = v.age != null && v.age >= 17 && v.age <= 18 ? ` <span class="voter-tag voter-tag-senior">senior</span>`
                      : v.age != null && v.age >= 19 && v.age <= 20 ? ` <span class="voter-tag voter-tag-grad">recent grad</span>`
                      : "";
            const ageStr = v.age != null ? `<span class="voter-age muted small">age ${v.age}</span>` : "";
            return `<div class="voter-row"><span>${escape(v.name)}</span>${tag}${ageStr}</div>`;
          }).join("");
        });
    } else {
      const slot = $("#dVoterList");
      if (slot) slot.innerHTML = `<div class="muted small">—</div>`;
    }

    // Review-mode panel: render below the banner when the dev pass is active
    // and this household is an unreviewed owner-voter surname mismatch.
    if (state.review.enabled && r.owner_voter_surname_match === false) {
      renderReviewPanel(r);
    }
  }

  // ── Surname-mismatch review (dev only) ──────────────────────────────
  // One-time pass to classify the ~343 households where the parcel owner's
  // surname does not match any voter at the address. Classifications are
  // staged in localStorage; "Export SQL" emits a single UPDATE batch the
  // user pastes into the Supabase SQL editor. Gated on dev_review=1.
  const REVIEW_KEY = "hhsp_review_classifications_v1";
  const REVIEW_OPTIONS = [
    { code: "owner_lives_here",   label: "Owner lives here",        hint: "Title is in a different surname (maiden, hyphenated) but the family is in residence" },
    { code: "trust_or_llc",       label: "Trust / LLC",             hint: "Title in a trust or LLC; the resident family is the beneficiary" },
    { code: "absentee_or_rental", label: "Absentee / rental",       hint: "Owner does not live there; voters are tenants" },
    { code: "unclear",            label: "Unclear",                  hint: "Couldn't determine from available data" },
  ];

  function loadReviewMap() {
    try { return JSON.parse(localStorage.getItem(REVIEW_KEY) || "{}") || {}; }
    catch { return {}; }
  }
  function saveReviewMap(m) {
    localStorage.setItem(REVIEW_KEY, JSON.stringify(m));
  }
  function reviewIsDev() {
    try { return localStorage.getItem("dev_review") === "1"; } catch { return false; }
  }
  function reviewMismatchTargets() {
    return state.targets.filter(r => r.owner_voter_surname_match === false);
  }
  function refreshReviewProgress() {
    const total = reviewMismatchTargets().length;
    const m = loadReviewMap();
    const done = Object.keys(m).length;
    const slot = $("#reviewProgress");
    if (slot) slot.textContent = `${done} of ${total} classified${total ? ` (${Math.round(100*done/total)}%)` : ""}`;
  }
  function startReview() {
    const all = reviewMismatchTargets();
    if (!all.length) { toast("No surname mismatches to review."); return; }
    const m = loadReviewMap();
    // Build worklist: tier+score order, unclassified first.
    const ordered = all.slice().sort((a, b) => {
      const ar = TIER_RANK[a.tier] ?? 99, br = TIER_RANK[b.tier] ?? 99;
      if (ar !== br) return ar - br;
      return (b.evidence_score ?? -Infinity) - (a.evidence_score ?? -Infinity);
    });
    const pending = ordered.filter(r => !m[r.household_id]);
    const next = pending[0] || ordered[0];
    state.review.enabled = true;
    state.review.worklist = ordered.map(r => r.household_id);
    state.review.cursor = state.review.worklist.indexOf(next.household_id);
    state._closeSidebar?.();
    openDrawer(next.household_id);
  }
  function recordReviewClassification(hhId, code) {
    const m = loadReviewMap();
    m[hhId] = code;
    saveReviewMap(m);
    refreshReviewProgress();
    advanceReview();
  }
  function advanceReview() {
    const wl = state.review.worklist;
    if (!wl.length) return;
    const m = loadReviewMap();
    // Step forward to the next unclassified entry; wrap around once.
    const start = state.review.cursor;
    for (let step = 1; step <= wl.length; step++) {
      const idx = (start + step) % wl.length;
      if (!m[wl[idx]]) { state.review.cursor = idx; openDrawer(wl[idx]); return; }
    }
    // All done.
    $("#drawer").hidden = true;
    toast("All mismatches classified. Click Export SQL to emit the UPDATE batch.");
  }
  function reviewExportSql() {
    const m = loadReviewMap();
    const entries = Object.entries(m);
    if (!entries.length) { toast("No classifications to export."); return; }
    const lines = [
      `-- Surname-mismatch review classifications (${entries.length} rows).`,
      `-- Generated ${new Date().toISOString()} by the dev review tool.`,
      `-- Paste into the Supabase SQL editor and run; then re-run recompute_tiers().`,
      ``,
      `BEGIN;`,
      ...entries.map(([hh, code]) =>
        `UPDATE households SET owner_voter_review = '${code}' WHERE id = '${hh}';`),
      `SELECT recompute_tiers(CURRENT_DATE);`,
      `COMMIT;`,
      ``,
    ];
    const text = lines.join("\n");
    const today = new Date().toISOString().slice(0, 10);
    downloadCsv(`surname-review-${today}.sql`, text);
  }
  function renderReviewPanel(r) {
    const m = loadReviewMap();
    const existing = m[r.household_id];
    const ownerSurname = r.surname_key
      ? titleCase(r.surname_key)
      : "—";
    const idx = state.review.worklist.indexOf(r.household_id);
    const total = state.review.worklist.length;
    const pos = idx >= 0 ? `${idx + 1} of ${total}` : "—";

    const buttons = REVIEW_OPTIONS.map(opt => `
      <button class="btn ${existing === opt.code ? "primary" : ""}" data-review-classify="${opt.code}" title="${escape(opt.hint)}">${escape(opt.label)}</button>`).join("");

    const html = `
      <div class="review-banner">
        <strong>Review mode</strong> · ${escape(pos)}${existing ? ` · already classified: ${escape(existing)}` : ""}
      </div>
      <div class="section-h">Surname-mismatch classification</div>
      <div class="review-pair">
        <span class="k">Parcel owner surname</span><span class="v">${escape(ownerSurname)}</span>
        <span class="k">Voters at this address</span><span class="v" id="dReviewVoterSurnames">loading…</span>
      </div>
      <div class="review-actions">${buttons}</div>
      <div class="review-actions">
        <button class="btn ghost" id="reviewSkipBtn">Skip (don't classify)</button>
        <button class="btn ghost" id="reviewPrevBtn">← Previous</button>
      </div>
    `;
    // Inject panel right after the banner so it's the first thing the eye lands on.
    const body = $("#drawerBody");
    const panel = document.createElement("div");
    panel.id = "dReviewPanel";
    panel.innerHTML = html;
    body.insertBefore(panel, body.firstChild.nextSibling);

    // Wire buttons
    panel.querySelectorAll("[data-review-classify]").forEach(btn => {
      btn.addEventListener("click", () => {
        recordReviewClassification(r.household_id, btn.dataset.reviewClassify);
      });
    });
    $("#reviewSkipBtn").addEventListener("click", () => advanceReview());
    $("#reviewPrevBtn").addEventListener("click", () => {
      const wl = state.review.worklist;
      const start = state.review.cursor;
      for (let step = 1; step <= wl.length; step++) {
        const i = (start - step + wl.length) % wl.length;
        state.review.cursor = i;
        openDrawer(wl[i]);
        return;
      }
    });

    // Fill in the voter surnames once the existing voter-roster query returns.
    // openDrawer kicked that off; here we observe the #dVoterList children.
    const surnameSlot = $("#dReviewVoterSurnames");
    if (!surnameSlot) return;
    const fillSurnames = () => {
      const list = $("#dVoterList");
      if (!list) return false;
      const rows = Array.from(list.querySelectorAll(".voter-row span:first-child"));
      if (!rows.length) return false;
      const surnames = Array.from(new Set(rows.map(s => {
        const txt = (s.textContent || "").trim();
        const i = txt.lastIndexOf(" ");
        return i > 0 ? txt.slice(i + 1) : txt;
      }).filter(Boolean)));
      surnameSlot.textContent = surnames.length ? surnames.join(", ") : "—";
      return true;
    };
    if (!fillSurnames()) {
      const obs = new MutationObserver(() => { if (fillSurnames()) obs.disconnect(); });
      const list = $("#dVoterList");
      if (list) obs.observe(list, { childList: true, subtree: true });
    }
  }

  // ── UI bindings ─────────────────────────────────────────────────────
  function bindUI() {
    // Mobile filters drawer (off-canvas sidebar)
    const sidebar = $("#sidebar");
    const backdrop = $("#sidebarBackdrop");
    const filtersToggleBtn = $("#filtersToggleBtn");
    const openSidebar = () => {
      sidebar.classList.add("open");
      backdrop.classList.add("show");
      filtersToggleBtn.setAttribute("aria-expanded", "true");
    };
    const closeSidebar = () => {
      sidebar.classList.remove("open");
      backdrop.classList.remove("show");
      filtersToggleBtn.setAttribute("aria-expanded", "false");
    };
    filtersToggleBtn.addEventListener("click", () => {
      sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
    });
    backdrop.addEventListener("click", closeSidebar);
    state._closeSidebar = closeSidebar;

    // Tabs
    $$(".sidebar-tabs .tab").forEach(t => t.addEventListener("click", () => {
      $$(".sidebar-tabs .tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      $$(".tab-pane").forEach(p => p.hidden = (p.dataset.pane !== t.dataset.tab));
    }));

    // Tier toggles
    $$("[data-tier]").forEach(cb => {
      cb.addEventListener("change", () => {
        state.filters.tiers[cb.dataset.tier] = cb.checked;
        render();
        persistVisibleTiers();
      });
    });

    // Property filters
    const numberInputs = ["filterMinValue", "filterMaxValue", "filterMinYears", "filterMaxYears",
                          "filterMinSqft", "filterMaxSqft", "filterMinYearBuilt", "filterMaxYearBuilt"];
    const fieldMap = {
      filterMinValue: "minValue", filterMaxValue: "maxValue",
      filterMinYears: "minYears", filterMaxYears: "maxYears",
      filterMinSqft: "minSqft", filterMaxSqft: "maxSqft",
      filterMinYearBuilt: "minYearBuilt", filterMaxYearBuilt: "maxYearBuilt",
    };
    numberInputs.forEach(id => {
      $("#" + id).addEventListener("input", () => {
        const v = $("#" + id).value;
        state.filters[fieldMap[id]] = v === "" ? null : Number(v);
        debouncedRender();
      });
    });

    $("#filterAdultCount").addEventListener("change", () => {
      state.filters.adultCount = $("#filterAdultCount").value; render();
    });
    $("#filterMailing").addEventListener("change", () => {
      state.filters.mailingMode = $("#filterMailing").value; render();
    });
    const entitiesCb = $("#filterIncludeEntities");
    if (entitiesCb) {
      entitiesCb.addEventListener("change", () => {
        state.filters.includeUnresolvedEntities = entitiesCb.checked;
        if (state.prefs && state.user) {
          state.prefs.include_unresolved_entities = entitiesCb.checked;
          supabase.from("user_preferences")
            .update({ include_unresolved_entities: entitiesCb.checked })
            .eq("user_id", state.user.id);
        }
        render();
      });
    }
    $("#filterSearch").addEventListener("input", () => {
      state.filters.search = $("#filterSearch").value.trim().toLowerCase();
      debouncedRender();
    });
    // Cohort chips
    $$(".chip").forEach(c => c.addEventListener("click", () => {
      const k = c.dataset.cohort;
      if (state.filters.cohorts.has(k)) state.filters.cohorts.delete(k);
      else state.filters.cohorts.add(k);
      c.classList.toggle("active");
      // The "Recent grads" cohort filters to has_19_20_voter, which by
      // construction lives only in T3. Clicking it while T3 is off would
      // silently produce zero results — so auto-enable T3 (an explicit
      // user signal of intent) and persist.
      if (k === "recent_grads" && state.filters.cohorts.has(k) && !state.filters.tiers.T3) {
        state.filters.tiers.T3 = true;
        const cb = $('[data-tier="T3"]'); if (cb) cb.checked = true;
        persistVisibleTiers();
        toast("Turned on Recent grad — adjacent");
      }
      render();
    }));

    // Adjacent-leads first-run banner buttons
    const introEnable = $("#adjacentIntroEnable");
    const introDismiss = $("#adjacentIntroDismiss");
    if (introEnable) introEnable.addEventListener("click", () => {
      state.filters.tiers.T3 = true;
      const cb = $('[data-tier="T3"]'); if (cb) cb.checked = true;
      persistVisibleTiers();
      dismissAdjacentIntro();
      render();
      toast("Turned on Recent grad — adjacent");
    });
    if (introDismiss) introDismiss.addEventListener("click", () => dismissAdjacentIntro());

    // Map layers
    $("#layerHeatmap").addEventListener("change", () => drawMap());

    // Draw controls
    $("#drawPolygonBtn").addEventListener("click", () => {
      if (!state.map.hasLayer(state.drawControl)) state.map.addControl(state.drawControl);
      new L.Draw.Polygon(state.map, state.drawControl.options.draw.polygon).enable();
    });
    $("#drawRectangleBtn").addEventListener("click", () => {
      if (!state.map.hasLayer(state.drawControl)) state.map.addControl(state.drawControl);
      new L.Draw.Rectangle(state.map, state.drawControl.options.draw.rectangle).enable();
    });
    $("#clearDrawBtn").addEventListener("click", () => {
      state.drawLayer.clearLayers();
      state.filters.drawnArea = null;
      render();
    });

    // Save area
    let saveAreaUI = false;
    document.addEventListener("keydown", async (e) => {
      // Cmd/Ctrl+S — save current drawn area
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && state.filters.drawnArea) {
        e.preventDefault();
        const name = prompt("Name this area:");
        if (!name) return;
        const { data, error } = await supabase.from("saved_areas")
          .insert({ user_id: state.user.id, name, geometry_geojson: state.filters.drawnArea })
          .select().single();
        if (error) { toast(error.message); return; }
        state.savedAreas.push(data);
        drawSavedAreas();
        toast("Area saved");
      }
    });

    // Export menu
    $("#exportMenuBtn").addEventListener("click", () => {
      const m = $("#exportMenu");
      m.hidden = !m.hidden;
    });
    $$("#exportMenu [data-export]").forEach(b => {
      b.addEventListener("click", () => {
        runExport(b.dataset.export);
        $("#exportMenu").hidden = true;
      });
    });

    // View toggle (Map | List)
    $$(".view-toggle .vt").forEach(b => b.addEventListener("click", () => setViewMode(b.dataset.view)));

    // Table sort. Plain click sets the primary sort (replacing the list);
    // shift-click appends a secondary/tertiary level or toggles the direction
    // of an existing level. Multiple levels apply hierarchically: ties at
    // level N are broken by level N+1.
    $$("#hhTable thead th.sortable").forEach(th => {
      th.addEventListener("click", (e) => {
        const col = th.dataset.sort;
        const existing = state.sort.findIndex(l => l.col === col);
        if (e.shiftKey) {
          if (existing >= 0) {
            state.sort[existing].dir = state.sort[existing].dir === "asc" ? "desc" : "asc";
          } else {
            state.sort.push({ col, dir: defaultDir(col) });
          }
        } else {
          if (state.sort.length === 1 && state.sort[0].col === col) {
            state.sort[0].dir = state.sort[0].dir === "asc" ? "desc" : "asc";
          } else {
            state.sort = [{ col, dir: defaultDir(col) }];
          }
        }
        drawList();
      });
    });

    // Row click → drawer; checkbox click → select (with shift-range)
    $("#hhTableBody").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-id]");
      if (!tr) return;
      const hid = tr.dataset.id;
      const idx = parseInt(tr.dataset.idx, 10);
      if (e.target.classList.contains("row-cb") || e.target.classList.contains("check-col")) {
        // Don't open drawer; treat as selection toggle
        e.stopPropagation();
        const cb = tr.querySelector(".row-cb");
        const wantOn = e.target === cb ? cb.checked : !state.selectedIds.has(hid);
        if (e.shiftKey && state.lastClickedIdx >= 0) {
          const [lo, hi] = [Math.min(state.lastClickedIdx, idx), Math.max(state.lastClickedIdx, idx)];
          for (let i = lo; i <= hi; i++) {
            const r = state.listOrder[i]; if (r) toggleSelect(r.household_id, wantOn);
          }
        } else {
          toggleSelect(hid, wantOn);
        }
        state.lastClickedIdx = idx;
        refreshSelectionUI();
        return;
      }
      openDrawer(hid);
    });

    // Header select-all (visible)
    $("#selectAllCb").addEventListener("change", () => {
      const on = $("#selectAllCb").checked;
      (state.listOrder || []).forEach(r => toggleSelect(r.household_id, on));
      refreshSelectionUI();
    });

    // Selection toolbar
    $("#tagSelectionBtn").addEventListener("click", openTagModal);
    $("#clearSelectionBtn").addEventListener("click", clearSelection);
    $("#closeTagModal").addEventListener("click", () => $("#tagModal").hidden = true);

    // Esc closes drawer / settings / tag modal / mobile sidebar
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#tagModal").hidden) { $("#tagModal").hidden = true; return; }
      if (!$("#drawer").hidden) { $("#drawer").hidden = true; return; }
      if (!$("#settingsModal").hidden) { $("#settingsModal").hidden = true; return; }
      if ($("#sidebar").classList.contains("open")) { state._closeSidebar?.(); return; }
    });

    // Surname-mismatch review tool — dev only, gated on localStorage.dev_review.
    if (reviewIsDev()) {
      const section = $("#reviewSection");
      if (section) section.hidden = false;
      refreshReviewProgress();
      $("#reviewStartBtn")?.addEventListener("click", () => startReview());
      $("#reviewExportBtn")?.addEventListener("click", () => reviewExportSql());
      $("#reviewClearBtn")?.addEventListener("click", () => {
        if (!confirm("Discard all local classifications? They have not been written to the database.")) return;
        localStorage.removeItem(REVIEW_KEY);
        refreshReviewProgress();
        toast("Local classifications cleared.");
      });
    }
  }

  let renderT;
  function debouncedRender() {
    clearTimeout(renderT);
    renderT = setTimeout(render, 120);
  }

  function persistVisibleTiers() {
    const visible = Object.entries(state.filters.tiers).filter(([_,v]) => v).map(([k]) => k);
    supabase.from("user_preferences")
      .update({ default_visible_tiers: visible })
      .eq("user_id", state.user.id);
  }

  // ── Render ──────────────────────────────────────────────────────────
  function render() {
    state.visibleSet = state.targets.filter(passesFilters);
    if (state.viewMode === "list") drawList();
    else drawMap();
  }

  // ── Exports ─────────────────────────────────────────────────────────
  // [field, header, optional value-transform(r)]. The transform runs against
  // the row, not the field, so we can derive synthetic columns (e.g. the
  // public lead name) from the internal tier code.
  const PLAIN_COLS = [
    ["tier", "Lead", r => TIER_LABEL[r.tier] || ""],
    ["evidence_score", "Lead score"],
    ["display_name", "Owner"],
    ["situs_address", "Address"],
    ["situs_city", "City"],
    ["situs_zip", "Zip"],
    ["years_owned", "Yrs owned"],
    ["market_value", "Value"],
    ["sqft", "Sqft"],
    ["year_built", "Built"],
    ["mailing_same_as_situs", "Owner lives here"],
    ["count_17_18_voters", "Senior-age voter count"],
    ["count_19_20_voters", "Recent-grad-age voter count"],
    ["adult_count", "Adults at address"],
    ["why_sentence", "Why", r => sanitizeText(r.why_sentence)],
    ["lat", "Lat"],
    ["lng", "Lng"],
  ];

  function colValue(r, c) {
    if (c.length >= 3 && typeof c[2] === "function") return c[2](r);
    return r[c[0]];
  }

  function runExport(kind) {
    runExportFor(kind, state.visibleSet, "hudson-hs-parents");
  }

  // Export-by-tag uses this with the tag's households and a name-prefixed file.
  function runExportFor(kind, set, prefix) {
    if (!set || !set.length) { toast("Nothing to export"); return; }
    const today = new Date().toISOString().slice(0, 10);
    const stem = (prefix || "export").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "export";
    if (kind === "csv") return downloadCsv(`${stem}-${today}.csv`, plainCsv(set));
    if (kind === "xlsx") return downloadXlsx(`${stem}-${today}.xlsx`, set);
    if (kind === "mymaps") return downloadCsv(`${stem}-mymaps-${today}.csv`, googleMyMapsCsv(set));
    if (kind === "avery5160") return downloadCsv(`${stem}-avery-5160-${today}.csv`, averyCsv(set, "5160"));
    if (kind === "avery5161") return downloadCsv(`${stem}-avery-5161-${today}.csv`, averyCsv(set, "5161"));
    if (kind === "avery5163") return downloadCsv(`${stem}-avery-5163-${today}.csv`, averyCsv(set, "5163"));
    if (kind === "avery5164") return downloadCsv(`${stem}-avery-5164-${today}.csv`, averyCsv(set, "5164"));
  }

  // Resolve a tag's stored household_ids to live row objects (preserves the
  // tier filter being applied — exporting a tag of households that no longer
  // exist or have been TX-classed would 404 silently).
  function householdsForTag(tagId) {
    const tag = state.tags.find(t => t.id === tagId);
    if (!tag) return [];
    const wanted = new Set(tag.household_ids || []);
    if (!wanted.size) return [];
    const byId = new Map(state.targets.map(r => [r.household_id, r]));
    return Array.from(wanted).map(id => byId.get(id)).filter(Boolean);
  }

  function downloadXlsx(filename, set) {
    if (!window.XLSX) { toast("Excel library not loaded — try again in a moment"); return; }
    const aoa = [PLAIN_COLS.map(c => c[1])];
    set.forEach(r => aoa.push(PLAIN_COLS.map(c => {
      const v = colValue(r, c);
      if (v == null) return "";
      if (Array.isArray(v)) return v.join("; ");
      if (typeof v === "boolean") return v ? "yes" : "no";
      return v;
    })));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Households");
    XLSX.writeFile(wb, filename);
    toast(`${filename} downloaded`);
  }

  function csvEscape(v) {
    if (v == null) return "";
    const s = Array.isArray(v) ? v.join("; ") : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${filename} downloaded`);
  }

  function plainCsv(set) {
    const head = PLAIN_COLS.map(c => c[1]).join(",");
    const body = set.map(r => PLAIN_COLS.map(c => csvEscape(colValue(r, c))).join(",")).join("\n");
    return head + "\n" + body;
  }

  function googleMyMapsCsv(set) {
    // Schema Google My Maps imports cleanly: lat, lng, Name, Description.
    const head = "Latitude,Longitude,Name,Lead,Description";
    const body = set.filter(r => r.lat && r.lng).map(r => {
      const desc = [
        sanitizeText(r.why_sentence),
        `${r.years_owned ?? "?"} yrs at this address`,
        `Value ${fmt$(r.market_value)}`,
        `${r.adult_count ?? 0} adults at address`,
      ].filter(Boolean).join(" — ");
      const leadName = TIER_LABEL[r.tier] || "";
      return [r.lat, r.lng, r.display_name || r.situs_address || "household", leadName, desc].map(csvEscape).join(",");
    }).join("\n");
    return head + "\n" + body;
  }

  function averyCsv(set, sheet) {
    // Standard Avery mail-merge fields. Word/Pages mail-merge maps these to label boxes.
    const head = "FullName,Address,Address2,City,State,Zip";
    const body = set.map(r => {
      const fullName = r.display_name || (r.owner_names && r.owner_names[0]) || "Resident";
      return [fullName, r.situs_address || "", "", r.situs_city || "", "OH", r.situs_zip || ""].map(csvEscape).join(",");
    }).join("\n");
    return head + "\n" + body;
  }

  // ── Settings modal ──────────────────────────────────────────────────
  function openSettings() {
    const p = state.prefs || {};
    $("#settingsBody").innerHTML = `
      <label>Email digest cadence
        <select id="setCadence">
          ${["off","on_demand","daily","weekdays","weekly_monday"].map(c =>
            `<option value="${c}" ${p.email_cadence===c?"selected":""}>${c.replace("_"," ")}</option>`).join("")}
        </select>
      </label>
      <label>Email send hour (24h, your local time)
        <input type="number" id="setHour" min="0" max="23" value="${p.email_send_hour_local ?? 7}">
      </label>
      <label>Default cluster size
        <input type="number" id="setClusterSize" min="10" max="60" value="${p.default_cluster_target_size ?? 22}">
      </label>
      <label>Default basemap
        <select id="setBasemap">
          ${["light","street","satellite"].map(b =>
            `<option value="${b}" ${p.default_basemap===b?"selected":""}>${b}</option>`).join("")}
        </select>
      </label>
      <div class="actions">
        <button class="btn" id="settingsCancel">Cancel</button>
        <button class="btn primary" id="settingsSave">Save</button>
      </div>
    `;
    $("#settingsModal").hidden = false;
    $("#settingsCancel").addEventListener("click", () => $("#settingsModal").hidden = true);
    $("#settingsSave").addEventListener("click", async () => {
      const updates = {
        email_cadence: $("#setCadence").value,
        email_send_hour_local: parseInt($("#setHour").value, 10),
        default_cluster_target_size: parseInt($("#setClusterSize").value, 10) || 22,
        default_basemap: $("#setBasemap").value,
      };
      const { error } = await supabase.from("user_preferences").update(updates).eq("user_id", state.user.id);
      if (error) { toast("Save failed: " + error.message); return; }
      Object.assign(state.prefs, updates);
      $("#settingsModal").hidden = true;
      setBasemap(state.prefs.default_basemap);
      toast("Settings saved");
    });
  }

  start();
})();
