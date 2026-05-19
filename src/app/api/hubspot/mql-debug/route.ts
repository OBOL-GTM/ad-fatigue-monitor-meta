import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_URL = "https://api.hubapi.com";

async function hsFetch(path: string, apiKey: string, options?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Diagnostic endpoint for finding Obol's MQL property name on the Companies
 * object. Hit /api/hubspot/mql-debug, look at the JSON, and tell us what the
 * actual internal property name is. Returns:
 *   - all company properties whose name OR label contains "mql"
 *   - 5 most recent inbound companies with ALL "mql-ish" property values
 *   - the picker the lite client would currently use
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no HUBSPOT_API_KEY" }, { status: 500 });

  try {
    const propsRes = await hsFetch("/crm/v3/properties/companies", apiKey, { method: "GET" });
    const allProps: Array<{ name: string; label: string; type: string; fieldType?: string }> = propsRes.results || [];

    const mqlish = allProps.filter(p =>
      /mql/i.test(p.name) || /mql/i.test(p.label || "")
    ).map(p => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }));

    // Recent inbound companies — same filters as _fetchLiteATM, last 30 days,
    // request EVERY mql-ish property so we can see the actual values.
    const now = Date.now();
    const thirty = now - 30 * 24 * 60 * 60 * 1000;
    const sampleRes = await hsFetch("/crm/v3/objects/companies/search", apiKey, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{
          filters: [
            { propertyName: "createdate", operator: "GTE", value: String(thirty) },
            { propertyName: "createdate", operator: "LTE", value: String(now) },
            { propertyName: "lead_source__cloned_", operator: "EQ", value: "Inbound" },
            { propertyName: "tier", operator: "IN", values: ["SMB", "Mid-Market", "Enterprise"] },
          ],
        }],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: [
          "name", "createdate", "lead_source__cloned_", "tier",
          ...mqlish.map(p => p.name),
        ],
        limit: 5,
      }),
    });

    return NextResponse.json({
      mqlishCompanyProperties: mqlish,
      sampleInboundCompaniesLast30Days: (sampleRes.results || []).map((c: { properties: Record<string, unknown> }) => ({
        name: c.properties.name,
        createdate: c.properties.createdate,
        ...Object.fromEntries(mqlish.map(p => [p.name, c.properties[p.name]])),
      })),
      totalInboundLast30Days: sampleRes.total,
      hint: mqlish.length === 0
        ? "No company property has 'mql' in its name or label. The native HubSpot 'MQL distribution' report might be using a different property entirely (e.g., a list-membership filter, or a property on Contacts instead of Companies)."
        : `Pick whichever property in mqlishCompanyProperties holds the Yes/No flag, then tell us the 'name' field — we'll hardcode it.`,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
