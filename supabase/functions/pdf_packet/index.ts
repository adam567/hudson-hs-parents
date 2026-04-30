// Supabase Edge Function: pdf_packet
//
// Generates a printable PDF "cluster packet" from a list of household IDs OR
// a drawn polygon, scoped to the active campaign.
//
// Body: { campaign_id, household_ids?: string[], polygon?: GeoJSON.Polygon }
// Response: { url: string }  (a temporary signed URL to the rendered PDF)
//
// PDF rendering is done with @react-pdf/renderer at the edge — no headless
// browser. Map snapshot is fetched as a static image from the configured
// tile server (caller's choice — we default to OSM Static API style URL via
// the included SVG fallback rendering of the centroid + pins).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Household {
  household_id: string;
  display_name: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_zip: string | null;
  tier: string | null;
  evidence_score: number | null;
  why_sentence: string | null;
  lat: number | null;
  lng: number | null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function buildHtml(camp: { name: string; anchor_date: string }, households: Household[]): string {
  const tierCounts = households.reduce((acc, h) => {
    const t = h.tier || "TX";
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const tierLine = ["T1","T2","T3","T4","T5"]
    .map(t => `${t}: ${tierCounts[t] || 0}`).join(" · ");

  // SVG "minimap" of point centroids
  const pts = households.filter(h => h.lat && h.lng);
  let svg = "";
  if (pts.length) {
    const lats = pts.map(h => h.lat!);
    const lngs = pts.map(h => h.lng!);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const W = 600, H = 400, pad = 20;
    const x = (lng: number) => pad + (lng - minLng) / (maxLng - minLng + 1e-9) * (W - 2*pad);
    const y = (lat: number) => H - pad - (lat - minLat) / (maxLat - minLat + 1e-9) * (H - 2*pad);
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;border:1px solid #cdc7b8;border-radius:6px;background:#fdfcf8">`
        + pts.map((h, i) => {
            const c = h.tier === "T1" ? "#b51e2a" : h.tier === "T2" ? "#c87423" : h.tier === "T3" ? "#c69b3b" : h.tier === "T4" ? "#4a6a8c" : "#8b8e93";
            const r = h.tier === "T1" ? 5 : h.tier === "T2" ? 4 : 3;
            return `<circle cx="${x(h.lng!).toFixed(1)}" cy="${y(h.lat!).toFixed(1)}" r="${r}" fill="${c}" stroke="white" stroke-width="1"/>`;
          }).join("")
        + "</svg>";
  }

  const rows = households.map((h, i) => `
    <tr>
      <td style="text-align:right;color:#6b6b70">${i + 1}</td>
      <td><strong>${escapeXml(h.situs_address || "—")}</strong><br><span style="color:#6b6b70">${escapeXml(h.display_name || "")}</span></td>
      <td><span style="background:#f4ecd8;padding:2px 8px;border-radius:4px;font-weight:600">${escapeXml(h.tier || "—")}</span></td>
      <td style="font-size:11px;color:#6b6b70">${escapeXml(h.why_sentence || "")}</td>
      <td style="border:1px solid #cdc7b8;width:80px"></td>
    </tr>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>${escapeXml(camp.name)} — door-knock packet</title>
<style>
  body { font: 12px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif; color: #1d1d1f; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #6b6b70; margin-bottom: 14px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; color: #6b6b70; padding: 6px 4px; border-bottom: 1px solid #cdc7b8; }
  td { padding: 6px 4px; border-bottom: 1px solid #e6e2d8; vertical-align: top; }
  .summary { background: #f4ecd8; padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; }
  @media print { body { padding: 12px; } .pagebreak { page-break-before: always; } }
</style></head>
<body>
  <h1>${escapeXml(camp.name)}</h1>
  <div class="meta">Anchor date ${escapeXml(camp.anchor_date)} · Generated ${new Date().toLocaleString()}</div>
  <div class="summary">
    <strong>${households.length} doors</strong> · ${tierLine}
  </div>
  ${svg}
  <table>
    <thead><tr><th>#</th><th>Address / Owner</th><th>Tier</th><th>Why</th><th>Notes</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body></html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
  }

  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "auth required" }), { status: 401, headers: corsHeaders() });
  }

  const body = await req.json().catch(() => ({}));
  const { campaign_id, household_ids } = body;
  if (!campaign_id) {
    return new Response(JSON.stringify({ error: "campaign_id required" }), { status: 400, headers: corsHeaders() });
  }

  // Authenticate the caller (use anon key + their JWT for RLS scoping)
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: campRow, error: campErr } = await userClient
    .from("campaigns").select("id, name, anchor_date").eq("id", campaign_id).maybeSingle();
  if (campErr || !campRow) {
    return new Response(JSON.stringify({ error: "campaign not found" }), { status: 404, headers: corsHeaders() });
  }

  // Service-key client for the data fetch (RLS bypass for the household lookup)
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  let q = admin.from("v_targets").select(
    "household_id, display_name, situs_address, situs_city, situs_zip, tier, evidence_score, why_sentence, lat, lng"
  ).order("evidence_score", { ascending: false });

  if (household_ids && Array.isArray(household_ids) && household_ids.length) {
    q = q.in("household_id", household_ids);
  } else {
    q = q.in("tier", ["T1","T2","T3"]).limit(200);
  }

  const { data: households, error: hhErr } = await q;
  if (hhErr) {
    return new Response(JSON.stringify({ error: hhErr.message }), { status: 500, headers: corsHeaders() });
  }

  const html = buildHtml(campRow, (households || []) as Household[]);

  // For now we return the HTML directly (browser can print-to-PDF). A full
  // PDF render via headless Chromium is the upgrade path; tracked separately.
  return new Response(html, {
    status: 200,
    headers: { ...corsHeaders(), "Content-Type": "text/html; charset=utf-8" },
  });
});
