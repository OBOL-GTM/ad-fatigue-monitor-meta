import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_URL = "https://api.hubapi.com";

// Obol's native "SQLs Monthly (No rejects)" report filters (verified 2026-04-20):
//   - Deal.createdate in [from, to]
//   - Deal.demo_accept_reject NOT "Reject (Unqualified)" (or empty)
//   - Deal.pipeline = "Obol Sales Funnel (NEW)"
const PIPELINE_LABEL = "Obol Sales Funnel (NEW)";
const REJECT_VALUE = "Reject (Unqualified)";

async function hubspotFetch(path: string, apiKey: string, options?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options?.headers,
    },
  });
  if (!res.ok) throw new Error(`HubSpot API error ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * SQL diagnostic endpoint. Mirrors native "SQLs Monthly (No rejects)" report on Deals.
 * Discovers pipeline ID + demo_accept_reject property, then queries deals.
 * Usage: /api/hubspot/sql-debug?from=YYYY-MM-DD&to=YYYY-MM-DD
 */
export async function GET(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "HUBSPOT_API_KEY not set" }, { status: 500 });

  const { searchParams } = new URL(req.url);
  const fromDate = searchParams.get("from");
  const toDate = searchParams.get("to");
  if (!fromDate || !toDate) {
    return NextResponse.json({ error: "from and to query params required" }, { status: 400 });
  }

  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();

  // Discover pipeline ID for "Obol Sales Funnel (NEW)"
  const pipelinesData = await hubspotFetch("/crm/v3/pipelines/deals", apiKey);
  const obolPipeline = (pipelinesData.results || []).find((p: any) => p.label === PIPELINE_LABEL);
  const pipelineId = obolPipeline?.id || "";

  // Discover demo_accept_reject property
  const dealProps = await hubspotFetch("/crm/v3/properties/deals", apiKey);
  const rejectProp = (dealProps.results || []).find((p: any) =>
    /demo.?accept.?reject/i.test(p.name) || /demo.?accept.?reject/i.test(p.label || "")
  );
  const rejectPropName = rejectProp?.name || "demo_accept_reject";

  // Relevant candidate properties for diagnostics
  const candidateDealProps = (dealProps.results || [])
    .filter((p: any) => /demo|reject|pipeline|source/i.test(p.name) || /demo|reject|pipeline|source/i.test(p.label || ""))
    .map((p: any) => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }));

  if (!pipelineId) {
    return NextResponse.json({
      error: `Pipeline "${PIPELINE_LABEL}" not found`,
      pipelinesAvailable: (pipelinesData.results || []).map((p: any) => ({ id: p.id, label: p.label })),
      candidateDealProps,
    });
  }

  // Query deals matching the 3 filters.
  // "demo_accept_reject is none of Reject (Unqualified) OR is empty" = two filter groups (OR):
  //   Group A: pipeline=X AND createdate in range AND demo_accept_reject ≠ Reject
  //   Group B: pipeline=X AND createdate in range AND demo_accept_reject is empty
  const baseFilters = [
    { propertyName: "pipeline", operator: "EQ", value: pipelineId },
    { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
    { propertyName: "createdate", operator: "LTE", value: String(toTs) },
  ];

  const searchBody = {
    filterGroups: [
      { filters: [...baseFilters, { propertyName: rejectPropName, operator: "NEQ", value: REJECT_VALUE }] },
      { filters: [...baseFilters, { propertyName: rejectPropName, operator: "NOT_HAS_PROPERTY" }] },
    ],
    properties: ["dealname", "createdate", "pipeline", "dealstage", rejectPropName, "lead_source", "hs_deal_source_id"],
    limit: 100,
  };

  const deals: any[] = [];
  let after: string | undefined;
  let searchError: string | null = null;
  try {
    do {
      const r = await hubspotFetch("/crm/v3/objects/deals/search", apiKey, {
        method: "POST",
        body: JSON.stringify({ ...searchBody, ...(after ? { after } : {}) }),
      });
      deals.push(...(r.results || []));
      after = r.paging?.next?.after;
    } while (after);
  } catch (err: any) {
    searchError = err.message;
  }

  // De-duplicate (a deal matching both filter groups would show twice, shouldn't happen
  // with NEQ + NOT_HAS_PROPERTY but safe to guard against).
  const uniqueDeals = Array.from(new Map(deals.map(d => [d.id, d])).values());

  const rows = uniqueDeals
    .map(d => ({
      id: d.id,
      name: d.properties.dealname || "",
      createdate: (d.properties.createdate || "").slice(0, 10),
      stage: d.properties.dealstage || "",
      demoAcceptReject: d.properties[rejectPropName] || "",
      leadSource: d.properties.lead_source || "",
    }))
    .sort((a, b) => a.createdate.localeCompare(b.createdate));

  return NextResponse.json({
    range: { from: fromDate, to: toDate },
    pipeline: { label: PIPELINE_LABEL, id: pipelineId },
    propertyUsed: { rejectProp: rejectPropName },
    candidateDealProps,
    searchError,
    count: rows.length,
    deals: rows,
  });
}
