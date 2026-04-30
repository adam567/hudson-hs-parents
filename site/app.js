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
    activeCampaign: null,
    campaigns: [],
    targets: [],          // v_targets rows
    knockState: new Map(),// household_id -> {status, cooldown_until, last_outcome, last_note, readiness}
    savedAreas: [],
    savedRecipes: [],
    filters: {
      tiers: { T1: true, T2: true, T3: true, T4: false, T5: false },
      cohorts: new Set(),
      minValue: null, maxValue: null,
      minYears: null, maxYears: null,
      minSqft: null, maxSqft: null,
      minYearBuilt: null, maxYearBuilt: null,
      adultCount: "",
      mailingMode: "",
      knockMode: "ready",
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
  };

  // ── Auth ────────────────────────────────────────────────────────────
  $("#sendCodeBtn").addEventListener("click", async () => {
    $("#authErr").textContent = "";
    const email = $("#email").value.trim();
    if (!email) { $("#authErr").textContent = "Enter your email."; return; }
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) { $("#authErr").textContent = error.message; return; }
    $("#authStep1").hidden = true; $("#authStep2").hidden = false;
    setTimeout(() => $("#otp").focus(), 50);
    toast("Check your inbox for a 6-digit code.");
  });
  $("#verifyBtn").addEventListener("click", async () => {
    $("#authErr").textContent = "";
    const email = $("#email").value.trim();
    const code = $("#otp").value.trim();
    if (!code) { $("#authErr").textContent = "Enter the 6-digit code."; return; }
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) { $("#authErr").textContent = error.message; return; }
    await onSignedIn();
  });
  $("#restartBtn").addEventListener("click", () => {
    $("#authStep1").hidden = false; $("#authStep2").hidden = true;
    $("#otp").value = ""; $("#authErr").textContent = "";
  });
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
    await loadCampaigns();
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
    if (state.prefs?.default_show_knocked_mode) {
      const m = state.prefs.default_show_knocked_mode === "hide" ? "ready"
              : state.prefs.default_show_knocked_mode === "only" ? "knocked" : "all";
      state.filters.knockMode = m;
      const radio = $(`input[name=knockMode][value=${m}]`);
      if (radio) radio.checked = true;
    }
    if (state.prefs?.default_basemap) {
      $("#basemapSelect").value = state.prefs.default_basemap;
    }
    if (state.prefs?.default_cluster_target_size) {
      $("#clusterTargetSize").value = state.prefs.default_cluster_target_size;
    }
  }

  async function loadCampaigns() {
    const { data, error } = await supabase.from("campaigns")
      .select("*").order("started_at", { ascending: false });
    if (error) { toast("campaigns: " + error.message); return; }
    state.campaigns = data || [];
    state.activeCampaign = state.campaigns.find(c => c.is_active) || null;
    if (state.activeCampaign) {
      $("#campaignPill").textContent = state.activeCampaign.name;
      $("#campaignPill").hidden = false;
      $("#offSeasonBanner").hidden = true;
    } else {
      $("#campaignPill").hidden = true;
      $("#offSeasonBanner").hidden = false;
      const last = state.campaigns[0];
      if (last) {
        $("#offSeasonTitle").textContent = "No active campaign";
        $("#offSeasonSub").textContent = ` · last: ${last.name} (${fmtDate(last.started_at)})`;
        $("#resumeCampaignBtn").hidden = false;
      }
    }
  }

  async function markLastSeen() {
    if (!state.prefs) return;
    await supabase.from("user_preferences")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("user_id", state.user.id);
  }

  async function loadEverything() {
    const queries = [
      supabase.from("v_targets").select("*"),
      supabase.from("saved_filter_recipes").select("*").order("name"),
      supabase.from("saved_areas").select("*").order("name"),
    ];
    if (state.activeCampaign) {
      queries.push(supabase.from("v_active_campaign_state")
        .select("*")
        .eq("campaign_id", state.activeCampaign.id));
    }
    const results = await Promise.all(queries);
    if (results[0].error) toast("targets: " + results[0].error.message);
    else state.targets = (results[0].data || []).filter(r => r.tier && r.tier !== "TX");
    state.savedRecipes = results[1].data || [];
    state.savedAreas = results[2].data || [];
    state.knockState = new Map();
    if (results[3]) {
      (results[3].data || []).forEach(s => state.knockState.set(s.household_id, s));
    }
    drawTierCounts();
    drawSavedRecipes();
    drawSavedAreas();
    drawFreshness();
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
    const knockState = state.knockState.get(r.household_id);
    const readiness = knockState?.readiness || "ready";
    if (state.filters.knockMode === "ready") {
      if (readiness !== "ready" || knockState?.status === "knocked") return false;
    } else if (state.filters.knockMode === "knocked") {
      if (knockState?.status !== "knocked") return false;
    }
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
    return true;
  }

  function cohortPasses(r) {
    const cohorts = state.filters.cohorts;
    if (!cohorts.size) return true;
    const knockState = state.knockState.get(r.household_id);
    const checks = {
      younger_siblings: () => r.tier === "T4",
      recent_grads: () => r.has_19_20_voter,
      long_tenure_15: () => (r.years_owned ?? 0) >= 15,
      long_tenure_25: () => (r.years_owned ?? 0) >= 25,
      top_value: () => {
        // Top-quartile gate is server-side; we approximate client-side.
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
      cooldown_expired: () => knockState?.readiness === "ready" && knockState?.status === "knocked",
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
    const radio = $(`input[name=knockMode][value=${state.filters.knockMode}]`);
    if (radio) radio.checked = true;
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
      const knockState = state.knockState.get(r.household_id);
      const isKnocked = knockState?.status === "knocked" && knockState?.readiness !== "ready";
      const cls = `lead-marker marker-${r.tier}` +
                  (state.firstLoad && r.tier === "T1" ? " first-load" : "") +
                  (isKnocked ? " marker-knocked" : "");
      const icon = L.divIcon({ className: cls, iconSize: null });
      const m = L.marker([r.lat, r.lng], { icon });
      m.on("click", () => openDrawer(r.household_id));
      state.markerLayer.addLayer(m);
    });
    state.firstLoad = false;
    $("#visibleCount").textContent = `${state.visibleSet.length.toLocaleString()} households visible`;
  }

  // ── Drawer ──────────────────────────────────────────────────────────
  let drawerHouseholdId = null;
  $("#closeDrawer").addEventListener("click", () => { $("#drawer").hidden = true; drawerHouseholdId = null; });

  function openDrawer(id) {
    const r = state.targets.find(x => x.household_id === id);
    if (!r) return;
    drawerHouseholdId = id;
    const ks = state.knockState.get(id);
    const tierLabel = {T1:"Current senior", T2:"Recent grad", T3:"Likely senior", T4:"Younger-sibling keeper", T5:"Weak inference"}[r.tier] || r.tier;
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

    const knockedUntil = ks?.cooldown_until;
    const knockedSummary = ks?.last_action_at
      ? `Last touch: <strong>${escape(ks.last_outcome || "knocked")}</strong> on ${fmtDate(ks.last_action_at)}` +
        (knockedUntil ? ` · cooling until ${fmtDate(knockedUntil)}` : "")
      : "Not yet knocked.";

    $("#drawerBody").innerHTML = `
      ${r.why_sentence ? `<div class="why-sentence">${escape(r.why_sentence)}</div>` : ""}
      <div class="evidence-chips">${chips}</div>

      <div class="section-h">Facts</div>
      ${facts.map(([k,v]) => `<div class="fact"><span class="k">${k}</span><span>${escape(String(v))}</span></div>`).join("")}

      <div class="section-h">Owners</div>
      ${ownerList || "<div class='muted small'>—</div>"}

      <div class="section-h">Knock</div>
      <div class="muted small">${knockedSummary}</div>
      <div class="outcome-row">
        <button class="btn primary" data-outcome="knocked">Mark knocked</button>
        <button class="btn" data-outcome="no_answer">No answer</button>
        <button class="btn" data-outcome="talked">Talked</button>
        <button class="btn" data-outcome="follow_up">Follow-up requested</button>
        <button class="btn" data-outcome="skip">Skip</button>
      </div>
      <div class="muted small" style="margin-top:8px">Cooldown after knock</div>
      <div class="cooldown-row" id="cooldownRow">
        ${[7,14,30,60,90,null].map(d =>
          `<button class="btn" data-cd="${d ?? 'next'}">${d ? d + ' days' : 'until next signal'}</button>`).join("")}
      </div>
      <textarea id="dNote" rows="3" placeholder="Optional note" style="margin-top:10px">${escape(ks?.last_note || "")}</textarea>
      ${ks?.status === "knocked" ? `<button class="btn ghost" id="resetKnockBtn" style="margin-top:8px">Undo knock</button>` : ""}
    `;
    $("#drawer").hidden = false;

    let cdOverride = state.prefs?.default_cooldown_days ?? 30;
    $$("#cooldownRow .btn").forEach(b => {
      b.addEventListener("click", () => {
        $$("#cooldownRow .btn").forEach(x => x.classList.remove("active"));
        b.classList.add("active");
        const v = b.dataset.cd;
        cdOverride = v === "next" ? null : parseInt(v, 10);
      });
    });
    $$(".outcome-row .btn").forEach(b => {
      b.addEventListener("click", async () => {
        await markKnocked(id, b.dataset.outcome, $("#dNote").value, cdOverride);
      });
    });
    if ($("#resetKnockBtn")) {
      $("#resetKnockBtn").addEventListener("click", async () => {
        await supabase.rpc("reset_knock", { p_household_id: id });
        state.knockState.delete(id);
        toast("Knock reset");
        $("#drawer").hidden = true;
        render();
      });
    }
  }

  async function markKnocked(householdId, outcome, note, cooldownOverride) {
    if (!state.activeCampaign) {
      toast("Start a campaign first");
      return;
    }
    const { error } = await supabase.rpc("mark_knocked", {
      p_household_id: householdId,
      p_outcome: outcome,
      p_note: note || "",
      p_cooldown_days_override: cooldownOverride,
    });
    if (error) { toast("Save failed: " + error.message); return; }
    // Refresh local state
    const { data } = await supabase.from("v_active_campaign_state").select("*")
      .eq("campaign_id", state.activeCampaign.id)
      .eq("household_id", householdId).maybeSingle();
    if (data) state.knockState.set(householdId, data);
    toast(outcome === "knocked" ? "Knocked ✓" : `Marked: ${outcome}`);
    $("#drawer").hidden = true;
    render();
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
    $$("input[name=knockMode]").forEach(r => {
      r.addEventListener("change", () => {
        if (r.checked) { state.filters.knockMode = r.value; render(); }
      });
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

    // Settings + campaign modals
    $("#settingsBtn").addEventListener("click", openSettings);
    $("#closeSettings").addEventListener("click", () => $("#settingsModal").hidden = true);
    $("#startCampaignBtn").addEventListener("click", () => openCampaignModal("start"));
    $("#resumeCampaignBtn").addEventListener("click", () => openCampaignModal("resume"));
    $("#closeCampaignModal").addEventListener("click", () => $("#campaignModal").hidden = true);

    // Esc closes drawer / modals
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (!$("#drawer").hidden) { $("#drawer").hidden = true; return; }
      if (!$("#settingsModal").hidden) { $("#settingsModal").hidden = true; return; }
      if (!$("#campaignModal").hidden) { $("#campaignModal").hidden = true; return; }
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
    drawMap();
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
    if (kind === "pdf") return requestPdfPacket(set);
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

  async function requestPdfPacket(set) {
    if (!state.activeCampaign) { toast("Start a campaign first"); return; }
    toast("Building packet…");
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { toast("Sign in again"); return; }
    const url = `${cfg.SUPABASE_URL}/functions/v1/pdf_packet`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${session.access_token}`,
        "apikey": cfg.SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        campaign_id: state.activeCampaign.id,
        household_ids: set.slice(0, 200).map(r => r.household_id),
        polygon: state.filters.drawnArea || null,
      }),
    });
    if (!r.ok) { toast("Packet failed: " + r.status); return; }
    const html = await r.text();
    // Open in a new window and trigger print dialog. User saves as PDF.
    const w = window.open("", "_blank");
    if (!w) { toast("Pop-up blocked — allow pop-ups for this site"); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 600);
    toast("Packet ready — print or save as PDF");
  }

  // ── Settings modal ──────────────────────────────────────────────────
  function openSettings() {
    const p = state.prefs || {};
    $("#settingsBody").innerHTML = `
      <label>Default cooldown after knock (days)
        <input type="number" id="setCooldown" min="1" max="365" value="${p.default_cooldown_days ?? 30}">
      </label>
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
      <label>Show knocked households on map by default
        <select id="setShowKnocked">
          <option value="hide" ${p.default_show_knocked_mode==="hide"?"selected":""}>Hide</option>
          <option value="show" ${p.default_show_knocked_mode==="show"?"selected":""}>Show</option>
          <option value="only" ${p.default_show_knocked_mode==="only"?"selected":""}>Show only knocked</option>
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
        default_cooldown_days: parseInt($("#setCooldown").value, 10) || 30,
        email_cadence: $("#setCadence").value,
        email_send_hour_local: parseInt($("#setHour").value, 10),
        default_cluster_target_size: parseInt($("#setClusterSize").value, 10) || 22,
        default_basemap: $("#setBasemap").value,
        default_show_knocked_mode: $("#setShowKnocked").value,
      };
      const { error } = await supabase.from("user_preferences").update(updates).eq("user_id", state.user.id);
      if (error) { toast("Save failed: " + error.message); return; }
      Object.assign(state.prefs, updates);
      $("#settingsModal").hidden = true;
      setBasemap(state.prefs.default_basemap);
      toast("Settings saved");
    });
  }

  // ── Campaign modal ──────────────────────────────────────────────────
  function openCampaignModal(mode) {
    const today = new Date();
    const defaultName = `Spring ${today.getFullYear()}`;
    $("#campaignModalTitle").textContent = mode === "resume" ? "Resume campaign" : "Start a campaign";
    const previous = state.campaigns.map(c => `
      <div class="saved-row" data-id="${c.id}">
        <span class="name">${escape(c.name)}</span>
        <span class="muted small">${escape(c.season_type)} · ${fmtDate(c.started_at)} ${c.is_active ? "· active" : ""}</span>
        ${!c.is_active ? `<button class="apply">activate</button>` : ""}
      </div>`).join("");

    $("#campaignBody").innerHTML = `
      <p class="muted small">A campaign scopes knock-tracking, cooldowns, and exports. Anchor date is what we use to compute voter ages.</p>
      <label>Campaign name
        <input type="text" id="campaignName" value="${escape(defaultName)}">
      </label>
      <label>Season type
        <select id="campaignSeason">
          <option value="spring">Spring</option>
          <option value="fall">Fall</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label>Anchor date
        <input type="date" id="campaignAnchor" value="${today.toISOString().slice(0,10)}">
      </label>
      <label>School-year label (optional)
        <input type="text" id="campaignSchoolYear" placeholder="2025–2026">
      </label>
      <div class="actions">
        <button class="btn" id="campaignCancel">Cancel</button>
        <button class="btn primary" id="campaignCreate">Start</button>
      </div>
      <h3 style="margin-top:18px">Past campaigns</h3>
      <div class="saved-list">${previous || "<div class='muted small'>None yet.</div>"}</div>
    `;
    $("#campaignModal").hidden = false;
    $("#campaignCancel").addEventListener("click", () => $("#campaignModal").hidden = true);
    $("#campaignCreate").addEventListener("click", async () => {
      const name = $("#campaignName").value.trim();
      const season = $("#campaignSeason").value;
      const anchor = $("#campaignAnchor").value;
      const sy = $("#campaignSchoolYear").value.trim() || null;
      if (!name || !anchor) { toast("Name + anchor date required"); return; }
      // Deactivate any currently-active
      await supabase.from("campaigns").update({ is_active: false }).eq("user_id", state.user.id).eq("is_active", true);
      const { data, error } = await supabase.from("campaigns").insert({
        user_id: state.user.id, name, season_type: season,
        anchor_date: anchor, school_year_label: sy, is_active: true,
      }).select().single();
      if (error) { toast(error.message); return; }
      await supabase.from("user_preferences").update({ default_campaign_id: data.id }).eq("user_id", state.user.id);
      $("#campaignModal").hidden = true;
      await loadCampaigns();
      await loadEverything();
      render();
      toast(`Campaign "${name}" started`);
    });
    $$("#campaignBody .apply").forEach(b => b.addEventListener("click", async () => {
      const id = b.closest(".saved-row").dataset.id;
      await supabase.from("campaigns").update({ is_active: false }).eq("user_id", state.user.id).eq("is_active", true);
      await supabase.from("campaigns").update({ is_active: true }).eq("id", id);
      $("#campaignModal").hidden = true;
      await loadCampaigns();
      await loadEverything();
      render();
    }));
  }

  start();
})();
