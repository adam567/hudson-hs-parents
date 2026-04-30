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
    savedRecipes: [],
    tags: [],             // [{id, name, household_ids:[...], notes, created_at, updated_at}]
    tagsByHh: new Map(),  // household_id -> [tag objects]
    selectedIds: new Set(),
    activeTagFilter: null,   // tag id, when filtering by a tag
    lastClickedIdx: -1,
    filters: {
      tiers: { T1: true, T2: true, T3: true, T4: false, T5: false },
      cohorts: new Set(),
      minValue: null, maxValue: null,
      minYears: null, maxYears: null,
      minSqft: null, maxSqft: null,
      minYearBuilt: null, maxYearBuilt: null,
      adultCount: "",
      mailingMode: "",
      search: "",
      drawnArea: null,           // {type:'Polygon', coordinates:[[[lng,lat],...]]}
    },
    map: null,
    markerLayer: null,
    heatLayer: null,
    drawLayer: null,
    drawControl: null,
    clusterLayer: null,
    visibleSet: [],
    firstLoad: true,
    viewMode: "map",          // "map" | "list"
    sort: { col: "display_name", dir: "asc" },
  };

  // ── Auth ────────────────────────────────────────────────────────────
  async function doSignIn() {
    $("#authErr").textContent = "";
    const email = $("#email").value.trim();
    const password = $("#password").value;
    if (!email || !password) { $("#authErr").textContent = "Email and password required."; return; }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { $("#authErr").textContent = error.message; return; }
    await onSignedIn();
  }
  $("#signInBtn").addEventListener("click", doSignIn);
  $("#password").addEventListener("keydown", (e) => { if (e.key === "Enter") doSignIn(); });
  $("#email").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#password").focus(); });
  $("#signOutBtn").addEventListener("click", async () => {
    await supabase.auth.signOut(); location.reload();
  });

  async function start() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) await onSignedIn();
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
      ["T1","T2","T3","T4","T5"].forEach(t => state.filters.tiers[t] = enabled.has(t));
      $$("#sidebar [data-tier]").forEach(el => {
        el.checked = enabled.has(el.dataset.tier);
      });
    }
    if (state.prefs?.default_basemap) {
      $("#basemapSelect").value = state.prefs.default_basemap;
    }
    if (state.prefs?.default_cluster_target_size) {
      $("#clusterTargetSize").value = state.prefs.default_cluster_target_size;
    }
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
      supabase.from("saved_filter_recipes").select("*").order("name"),
      supabase.from("saved_areas").select("*").order("name"),
      supabase.from("tags").select("*").order("name"),
    ]);
    if (results[0].error) toast("targets: " + results[0].error.message);
    else state.targets = (results[0].data || []).filter(r => r.tier && r.tier !== "TX");
    state.savedRecipes = results[1].data || [];
    state.savedAreas = results[2].data || [];
    state.tags = results[3].data || [];
    rebuildTagsByHh();
    drawTierCounts();
    drawSavedRecipes();
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
    const counts = { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 };
    state.targets.forEach(r => { if (counts[r.tier] != null) counts[r.tier]++; });
    Object.entries(counts).forEach(([t, n]) => {
      const el = $(`[data-count="${t}"]`);
      if (el) el.textContent = n;
    });
  }

  function drawSavedRecipes() {
    const list = $("#savedRecipeList");
    list.innerHTML = state.savedRecipes.map(r => `
      <div class="saved-row" data-id="${r.id}">
        <span class="name">${escape(r.name)}</span>
        <button class="apply" title="Apply">apply</button>
        <button class="del" title="Delete">×</button>
      </div>`).join("") || `<div class="muted small">No saved recipes yet.</div>`;
    $$("#savedRecipeList .apply").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.closest(".saved-row").dataset.id;
        const rec = state.savedRecipes.find(r => r.id === id);
        if (rec) applyFilterRecipe(rec.filter_state);
      });
    });
    $$("#savedRecipeList .del").forEach(btn => {
      btn.addEventListener("click", async () => {
        const id = btn.closest(".saved-row").dataset.id;
        if (!confirm("Delete this recipe?")) return;
        await supabase.from("saved_filter_recipes").delete().eq("id", id);
        state.savedRecipes = state.savedRecipes.filter(r => r.id !== id);
        drawSavedRecipes();
      });
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
      younger_siblings: () => r.tier === "T4",
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
      dz_voter: () => r.datazapp_hit && (r.has_17_18_voter || r.has_19_20_voter),
      dz_only: () => r.datazapp_hit && !r.has_17_18_voter && !r.has_19_20_voter,
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

  function applyFilterRecipe(s) {
    if (!s) return;
    Object.assign(state.filters, s);
    state.filters.cohorts = new Set(s.cohorts || []);
    syncFilterUI();
    render();
    toast("Recipe applied");
  }

  function applyDrawnArea(geo) {
    state.filters.drawnArea = geo;
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

  function snapshotFilterState() {
    return { ...state.filters, cohorts: Array.from(state.filters.cohorts), drawnArea: null };
  }

  // ── Map ──────────────────────────────────────────────────────────────
  const BASEMAPS = {
    light: { url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", attribution: "© CARTO © OpenStreetMap" },
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
    state.map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(startCenter, startZoom);
    setBasemap(state.prefs?.default_basemap || "light");
    state.markerLayer = L.layerGroup().addTo(state.map);
    state.drawLayer = new L.FeatureGroup().addTo(state.map);
    state.clusterLayer = L.layerGroup().addTo(state.map);

    // Save viewport on moveend (debounced)
    let saveT;
    state.map.on("moveend", () => {
      clearTimeout(saveT);
      saveT = setTimeout(persistViewport, 800);
    });

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
        .filter(r => r.lat && r.lng)
        .map(r => {
          const w = r.tier === "T1" ? 1.0 : r.tier === "T2" ? 0.7 : r.tier === "T3" ? 0.5 : r.tier === "T4" ? 0.3 : 0.15;
          return [r.lat, r.lng, w];
        });
      state.heatLayer = L.heatLayer(heatData, { radius: 24, blur: 18 }).addTo(state.map);
    }
    state.visibleSet.forEach(r => {
      if (!r.lat || !r.lng) return;
      const cls = `lead-marker marker-${r.tier}` +
                  (state.firstLoad && r.tier === "T1" ? " first-load" : "");
      const icon = L.divIcon({ className: cls, iconSize: null });
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
  function compareRows(a, b, col, dir) {
    const sgn = dir === "desc" ? -1 : 1;
    let av, bv;
    if (col === "senior_score") {
      av = (a.count_17_18_voters ?? 0) * 10 + (a.count_19_20_voters ?? 0);
      bv = (b.count_17_18_voters ?? 0) * 10 + (b.count_19_20_voters ?? 0);
    } else if (col === "datazapp_hit") {
      av = a.datazapp_hit ? 1 : 0;
      bv = b.datazapp_hit ? 1 : 0;
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

  const TIER_LABEL = { T1: "Current senior", T2: "Recent grad", T3: "Likely senior",
                       T4: "Younger-sibling keeper", T5: "Weak inference" };

  function drawList() {
    const sorted = state.visibleSet.slice().sort((a, b) => compareRows(a, b, state.sort.col, state.sort.dir));
    state.listOrder = sorted;     // ordered by current sort, used for shift-click range
    const body = $("#hhTableBody");
    if (!sorted.length) {
      body.innerHTML = `<tr><td colspan="10" class="muted small" style="padding:24px;text-align:center">No households match the current filters.</td></tr>`;
    } else {
      body.innerHTML = sorted.map((r, i) => {
        const checked = state.selectedIds.has(r.household_id);
        const tagsForRow = (state.tagsByHh.get(r.household_id) || [])
          .map(t => `<span class="row-tag-chip">${escape(t.name)}</span>`).join("");
        return `
        <tr data-id="${r.household_id}" data-idx="${i}" class="${checked ? "selected" : ""}">
          <td class="check-col"><input type="checkbox" class="row-cb" ${checked ? "checked" : ""}></td>
          <td class="owner">${escape(r.display_name || "—")}</td>
          <td class="addr">${escape(r.situs_address || "—")}</td>
          <td><span class="tier-badge ${r.tier}" title="${TIER_LABEL[r.tier] || ""}">${r.tier}</span></td>
          <td class="num">${r.market_value != null ? "$" + Math.round(r.market_value).toLocaleString() : "—"}</td>
          <td class="num">${r.years_owned ?? "—"}</td>
          <td class="num">${r.adult_count ?? "—"}</td>
          <td class="num">${r.count_17_18_voters ? r.count_17_18_voters : (r.count_19_20_voters ? "·" + r.count_19_20_voters : "—")}</td>
          <td class="num">${r.datazapp_hit ? "✓" : ""}</td>
          <td class="tags-col">${tagsForRow}</td>
        </tr>`;
      }).join("");
    }
    $$("#hhTable thead th[data-sort]").forEach(th => {
      th.classList.remove("sorted-asc","sorted-desc");
      if (th.dataset.sort === state.sort.col) th.classList.add(state.sort.dir === "asc" ? "sorted-asc" : "sorted-desc");
    });
    $("#listToolbar").textContent = `${sorted.length.toLocaleString()} households · sorted by ${state.sort.col === "senior_score" ? "senior signal" : state.sort.col.replace(/_/g," ")} (${state.sort.dir})`;
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
        <button class="del" title="Delete tag">×</button>
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

  function openDrawer(id) {
    const r = state.targets.find(x => x.household_id === id);
    if (!r) return;
    drawerHouseholdId = id;
    const tierLabel = TIER_LABEL[r.tier] || r.tier;
    $("#dTier").innerHTML = `<span class="pin-preview ${r.tier}"></span> Tier ${r.tier} · ${tierLabel} · ${r.evidence_score}`;
    $("#dName").textContent = r.display_name || "Unknown owner";
    $("#dAddr").textContent = `${r.situs_address || "—"}${r.situs_city ? ", " + r.situs_city : ""} ${r.situs_zip || ""}`;

    const chips = (r.evidence_chips || []).map(c =>
      `<span class="ev-chip ${c.warn ? "warn" : ""}">${escape(c.t)}</span>`).join("");

    const facts = [
      ["Years owned", r.years_owned ?? "unknown"],
      ["Market value", fmt$(r.market_value)],
      ["Sqft", r.sqft ? r.sqft.toLocaleString() : "—"],
      ["Year built", r.year_built ?? "—"],
      ["Owner-occupied", r.mailing_same_as_situs ? "yes" : "no"],
      ["Adults at address", r.adult_count ?? 0],
      ["17–18 voters", r.count_17_18_voters ?? 0],
      ["19–20 voters", r.count_19_20_voters ?? 0],
      ["Datazapp match", r.datazapp_hit ? "yes" : "no"],
    ];

    const ownerList = (r.owner_names || []).map(o => `<div class="muted small">${escape(o)}</div>`).join("");

    $("#drawerBody").innerHTML = `
      ${r.why_sentence ? `<div class="why-sentence">${escape(r.why_sentence)}</div>` : ""}
      <div class="evidence-chips">${chips}</div>

      <div class="section-h">Facts</div>
      ${facts.map(([k,v]) => `<div class="fact"><span class="k">${k}</span><span>${escape(String(v))}</span></div>`).join("")}

      <div class="section-h">Owners</div>
      ${ownerList || "<div class='muted small'>—</div>"}
    `;
    $("#drawer").hidden = false;
  }

  // ── UI bindings ─────────────────────────────────────────────────────
  function bindUI() {
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
      render();
    }));

    // Map layers
    $("#layerHeatmap").addEventListener("change", () => drawMap());
    $("#basemapSelect").addEventListener("change", () => {
      setBasemap($("#basemapSelect").value);
      supabase.from("user_preferences")
        .update({ default_basemap: $("#basemapSelect").value })
        .eq("user_id", state.user.id);
    });

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

    // Recipes
    $("#saveRecipeBtn").addEventListener("click", async () => {
      const name = $("#recipeName").value.trim();
      if (!name) { toast("Name the recipe"); return; }
      const { data, error } = await supabase.from("saved_filter_recipes")
        .insert({ user_id: state.user.id, name, filter_state: snapshotFilterState() })
        .select().single();
      if (error) { toast(error.message); return; }
      $("#recipeName").value = "";
      state.savedRecipes.push(data);
      drawSavedRecipes();
      toast("Recipe saved");
    });

    // Cluster suggestions
    $("#suggestPocketsBtn").addEventListener("click", suggestPockets);
    $("#clearPocketsBtn").addEventListener("click", () => {
      state.clusterLayer.clearLayers();
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

    // Settings
    $("#settingsBtn").addEventListener("click", openSettings);
    $("#closeSettings").addEventListener("click", () => $("#settingsModal").hidden = true);

    // View toggle (Map | List)
    $$(".view-toggle .vt").forEach(b => b.addEventListener("click", () => setViewMode(b.dataset.view)));

    // Table sort
    $$("#hhTable thead th.sortable").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        if (state.sort.col === col) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        else { state.sort.col = col; state.sort.dir = (col === "display_name" || col === "situs_address" || col === "tier") ? "asc" : "desc"; }
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

    // Esc closes drawer / settings / tag modal
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#tagModal").hidden) { $("#tagModal").hidden = true; return; }
      if (!$("#drawer").hidden) { $("#drawer").hidden = true; return; }
      if (!$("#settingsModal").hidden) { $("#settingsModal").hidden = true; return; }
    });
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

  // ── Cluster suggestions (DBSCAN-lite) ───────────────────────────────
  function suggestPockets() {
    state.clusterLayer.clearLayers();
    const target = parseInt($("#clusterTargetSize").value, 10) || 22;
    const points = state.visibleSet.filter(r => r.lat && r.lng);
    if (points.length < 5) { toast("Not enough points to cluster"); return; }

    // Greedy density-driven grouping by spatial proximity, target N per cluster.
    const used = new Set();
    const clusters = [];
    while (used.size < points.length) {
      const seed = points.find(p => !used.has(p.household_id));
      if (!seed) break;
      const sorted = points
        .filter(p => !used.has(p.household_id))
        .map(p => ({ p, d: dist(seed, p) }))
        .sort((a, b) => a.d - b.d);
      const member = sorted.slice(0, target).map(x => x.p);
      member.forEach(m => used.add(m.household_id));
      clusters.push(member);
    }

    clusters.forEach((cluster, idx) => {
      // Convex hull (Andrew monotone chain)
      const pts = cluster.map(c => [c.lng, c.lat]);
      const hull = convexHull(pts);
      if (hull.length < 3) return;
      const ll = hull.map(([lng, lat]) => [lat, lng]);
      const t1 = cluster.filter(c => c.tier === "T1").length;
      const t2 = cluster.filter(c => c.tier === "T2").length;
      const t3 = cluster.filter(c => c.tier === "T3").length;
      const score = cluster.reduce((s, c) => s + (c.evidence_score || 0), 0);
      const opacity = Math.min(0.25, 0.05 + score / 5000);
      const poly = L.polygon(ll, {
        color: "#6b4f2a", weight: 1.5, fillOpacity: opacity, fillColor: "#6b4f2a",
        className: "cluster-poly",
      });
      poly.bindTooltip(
        `<strong>Cluster ${idx + 1}</strong><br>${cluster.length} doors · T1: ${t1} · T2: ${t2} · T3: ${t3}`,
        { sticky: true, className: "cluster-label" }
      );
      poly.addTo(state.clusterLayer);
    });
    toast(`${clusters.length} pocket${clusters.length === 1 ? "" : "s"} suggested`);
  }
  function dist(a, b) {
    const dx = a.lat - b.lat, dy = a.lng - b.lng;
    return Math.sqrt(dx*dx + dy*dy);
  }
  function convexHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (O, A, B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  // ── Exports ─────────────────────────────────────────────────────────
  function runExport(kind) {
    const set = state.visibleSet;
    if (!set.length) { toast("Nothing visible to export"); return; }
    const today = new Date().toISOString().slice(0, 10);
    if (kind === "csv") return downloadCsv(`hudson-hs-parents-${today}.csv`, plainCsv(set));
    if (kind === "mymaps") return downloadCsv(`hudson-hs-parents-mymaps-${today}.csv`, googleMyMapsCsv(set));
    if (kind === "avery5160") return downloadCsv(`avery-5160-${today}.csv`, averyCsv(set, "5160"));
    if (kind === "avery5161") return downloadCsv(`avery-5161-${today}.csv`, averyCsv(set, "5161"));
    if (kind === "avery5163") return downloadCsv(`avery-5163-${today}.csv`, averyCsv(set, "5163"));
    if (kind === "avery5164") return downloadCsv(`avery-5164-${today}.csv`, averyCsv(set, "5164"));
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
    const cols = [
      ["tier","Tier"],["evidence_score","Score"],["display_name","Owner"],
      ["situs_address","Address"],["situs_city","City"],["situs_zip","Zip"],
      ["years_owned","Yrs owned"],["market_value","Value"],["sqft","Sqft"],
      ["year_built","Built"],["mailing_same_as_situs","Owner-occupied"],
      ["count_17_18_voters","17-18 voters"],["count_19_20_voters","19-20 voters"],
      ["adult_count","Adults"],["datazapp_hit","Datazapp"],
      ["why_sentence","Why"],["lat","Lat"],["lng","Lng"],
    ];
    const head = cols.map(c => c[1]).join(",");
    const body = set.map(r => cols.map(c => csvEscape(r[c[0]])).join(",")).join("\n");
    return head + "\n" + body;
  }

  function googleMyMapsCsv(set) {
    // Schema Google My Maps imports cleanly: lat, lng, Name, Description.
    const head = "Latitude,Longitude,Name,Tier,Description";
    const body = set.filter(r => r.lat && r.lng).map(r => {
      const desc = [
        r.why_sentence,
        `${r.years_owned ?? "?"} yrs owned`,
        `Value ${fmt$(r.market_value)}`,
        `${r.adult_count ?? 0} adults · ${r.count_17_18_voters ?? 0} senior voters`,
      ].filter(Boolean).join(" — ");
      return [r.lat, r.lng, r.display_name || r.situs_address || "household", r.tier, desc].map(csvEscape).join(",");
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
