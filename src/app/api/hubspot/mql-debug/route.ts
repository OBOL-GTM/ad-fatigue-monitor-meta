import { NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

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
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no HUBSPOT_API_KEY" }, { status: 500 });

  try {
    const propsRes = await hsFetch("/crm/v3/properties/companies", apiKey, { method: "GET" });
    const allProps: Array<{ name: string; label: string; type: string; fieldType?: string }> = propsRes.results || [];

    const matchesNameOrLabel = (re: RegExp) => (p: { name: string; label?: string }) =>
      re.test(p.name) || re.test(p.label || "");

    const mqlish = allProps.filter(matchesNameOrLabel(/mql/i))
      .map(p => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }));

    // The native chart's X-axis is "Inbound Lead - Monthly" — a date property
    // on Companies. Find candidate "inbound" / "lead" date fields so we can
    // pick the right one for our bucketing.
    const inboundDateish = allProps
      .filter(p => (p.type === "date" || p.type === "datetime"))
      .filter(matchesNameOrLabel(/inbound|lead|qualif/i))
      .map(p => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }));

    const allDateProps = allProps
      .filter(p => (p.type === "date" || p.type === "datetime"))
      .map(p => ({ name: p.name, label: p.label, type: p.type }));

    // Sample 5 recent companies with all candidate date values so we can see
    // which one is actually populated and matches HubSpot's chart bucketing.
    const now = Date.now();
    const sixty = now - 60 * 24 * 60 * 60 * 1000;
    const sampleProperties = [
      "name", "createdate", "lead_source__cloned_", "tier",
      ...mqlish.map(p => p.name),
      ...inboundDateish.map(p => p.name),
    ];
    const sampleRes = await hsFetch("/crm/v3/objects/companies/search", apiKey, {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{
          filters: [
            { propertyName: "createdate", operator: "GTE", value: String(sixty) },
            { propertyName: "createdate", operator: "LTE", value: String(now) },
            { propertyName: "lead_source__cloned_", operator: "EQ", value: "Inbound" },
          ],
        }],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: sampleProperties,
        limit: 5,
      }),
    });

    // Cross-check: count inbound companies in May 2026 using each candidate
    // date field. The one matching HubSpot's 76 is the right one.
    const may1 = Date.UTC(2026, 4, 1);
    const may31 = Date.UTC(2026, 4, 31, 23, 59, 59);
    const dateFieldCounts: Record<string, { total: number | null; error?: string }> = {};
    await Promise.all(
      ["createdate", "hs_lifecyclestage_lead_date", ...inboundDateish.map(p => p.name)].map(async (dateProp) => {
        try {
          const r = await hsFetch("/crm/v3/objects/companies/search", apiKey, {
            method: "POST",
            body: JSON.stringify({
              filterGroups: [{
                filters: [
                  { propertyName: dateProp, operator: "GTE", value: String(may1) },
                  { propertyName: dateProp, operator: "LTE", value: String(may31) },
                  { propertyName: "lead_source__cloned_", operator: "EQ", value: "Inbound" },
                ],
              }],
              properties: ["name"],
              limit: 1,
            }),
          });
          dateFieldCounts[dateProp] = { total: r.total ?? 0 };
        } catch (err) {
          dateFieldCounts[dateProp] = { total: null, error: String(err).slice(0, 200) };
        }
      })
    );

    return NextResponse.json({
      mqlishCompanyProperties: mqlish,
      inboundOrLeadDateCandidates: inboundDateish,
      allDateProperties: allDateProps,
      sampleInboundCompaniesLast60Days: (sampleRes.results || []).map((c: { properties: Record<string, unknown> }) => ({
        name: c.properties.name,
        createdate: c.properties.createdate,
        ...Object.fromEntries([...mqlish, ...inboundDateish].map(p => [p.name, c.properties[p.name]])),
      })),
      totalInboundLast60Days: sampleRes.total,
      may2026InboundCountByDateField: dateFieldCounts,
      hint: "Look at may2026InboundCountByDateField — whichever count matches HubSpot's 76 is the right date property. Send back that key and we'll hardcode it.",
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
