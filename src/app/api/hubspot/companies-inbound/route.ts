import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_URL = "https://api.hubapi.com";

async function hubspotFetch(path: string, apiKey: string, options?: RequestInit) {
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
    throw new Error(`HubSpot API error ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Matches the native HubSpot "Inbounds YTD Monthly Leads By Tier" report exactly:
 * - Data source: Companies (primary)
 * - Filter: Company.agreed_to_meet_date in [from, to]
 * - Filter: Company.lead_source = Inbound
 * - Filter: Company.tier ∈ {Mid-Market, Enterprise, SMB}
 *
 * First run: discovers property internal names. Then tries the filtered search.
 *
 * Usage: /api/hubspot/companies-inbound?from=YYYY-MM-DD&to=YYYY-MM-DD
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
    return NextResponse.json({ error: "from and to query params required (YYYY-MM-DD)" }, { status: 400 });
  }

  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();

  // Step 1: discover company property internal names for "lead source" and "agreed to meet date"
  const propsData = await hubspotFetch("/crm/v3/properties/companies", apiKey);
  const candidateProps = (propsData.results || [])
    .filter((p: any) => {
      const n = (p.name || "").toLowerCase();
      const l = (p.label || "").toLowerCase();
      return n.includes("lead") || n.includes("source") || n.includes("meet") || n.includes("tier")
          || l.includes("lead") || l.includes("source") || l.includes("meet") || l.includes("tier");
    })
    .map((p: any) => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType }));

  // Known property internal names for Obol's HubSpot portal (confirmed 2026-04-20):
  //   "Agreed to Meet Date" (company) → willing_to_meet  (yes, the label is "Agreed to Meet Date"
  //     even though the internal name is willing_to_meet, HS lets you rename labels)
  //   "Lead Source " (company, note trailing space in label) → lead_source__cloned_
  //   "Tier" (company) → tier
  const atmProp = "willing_to_meet";
  const leadSourceProp = "lead_source__cloned_";
  const tierProp = "tier";

  // Step 2: query companies with the three filters
  const searchBody = {
    filterGroups: [{
      filters: [
        { propertyName: atmProp, operator: "GTE", value: String(fromTs) },
        { propertyName: atmProp, operator: "LTE", value: String(toTs) },
        { propertyName: leadSourceProp, operator: "EQ", value: "Inbound" },
        { propertyName: tierProp, operator: "IN", values: ["Mid-Market", "Enterprise", "SMB"] },
      ],
    }],
    properties: ["name", tierProp, leadSourceProp, atmProp, "domain", "industry", "createdate"],
    limit: 100,
  };

  const allCompanies: any[] = [];
  let after: string | undefined;
  let searchError: string | null = null;
  try {
    do {
      const r = await hubspotFetch("/crm/v3/objects/companies/search", apiKey, {
        method: "POST",
        body: JSON.stringify({ ...searchBody, ...(after ? { after } : {}) }),
      });
      allCompanies.push(...(r.results || []));
      after = r.paging?.next?.after;
    } while (after);
  } catch (err: any) {
    searchError = err.message;
  }

  const companies = allCompanies
    .map(c => ({
      id: c.id,
      name: c.properties?.name || "",
      domain: c.properties?.domain || "",
      tier: c.properties?.[tierProp] || "",
      leadSource: c.properties?.[leadSourceProp] || "",
      atmRaw: c.properties?.[atmProp] || "",
      atmDate: parseAtmDate(c.properties?.[atmProp]),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({
    range: { from: fromDate, to: toDate },
    propertyNamesUsed: { atmProp, leadSourceProp, tierProp },
    candidatePropsFound: candidateProps,
    searchError,
    count: companies.length,
    companies,
  });
}

function parseAtmDate(val: string | null | undefined): string {
  if (!val) return "";
  if (val.includes("-")) return val.slice(0, 10);
  const n = parseInt(val, 10);
  if (!n || isNaN(n)) return "";
  return new Date(n).toISOString().split("T")[0];
}
