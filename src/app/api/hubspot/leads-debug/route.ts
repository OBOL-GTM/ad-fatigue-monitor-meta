import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE_URL = "https://api.hubapi.com";

interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
}

interface SearchResponse {
  total: number;
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

// Same defaults as lib/hubspot/client.ts, keep in sync
const ATM_PROPERTY = "agreed_to_meet_date___test_";
const SQL_STATUSES = ["SQL", "OPEN_DEAL"];
const SQL_STAGES = ["opportunity", "customer"];
const VALID_TIERS = new Set(["smb", "midmarket", "enterprise"]);

const normalizeTier = (t: string) => t.toLowerCase().replace(/[_\s-]/g, "");

/** HS returns date properties as "YYYY-MM-DD" strings OR millisecond timestamps, handle both. */
function parseAtmDate(val: string | null | undefined): string {
  if (!val) return "";
  if (val.includes("-")) return val.slice(0, 10);
  const n = parseInt(val, 10);
  if (!n || isNaN(n)) return "";
  return new Date(n).toISOString().split("T")[0];
}

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

async function paginate(apiKey: string, body: any): Promise<HubSpotContact[]> {
  const all: HubSpotContact[] = [];
  let after: string | undefined;
  do {
    const r: SearchResponse = await hubspotFetch("/crm/v3/objects/contacts/search", apiKey, {
      method: "POST",
      body: JSON.stringify({ ...body, limit: 100, ...(after ? { after } : {}) }),
    });
    all.push(...r.results);
    after = r.paging?.next?.after;
  } while (after);
  return all;
}

/**
 * Diagnostic endpoint, mirrors getLeadsFunnel's ATM filter chain and returns
 * per-company detail so the result set can be diff'd against HubSpot's native
 * "Inbound Leads By Tier" report. Permanent tool, hit this whenever counts drift.
 *
 * Usage: /api/hubspot/leads-debug?from=YYYY-MM-DD&to=YYYY-MM-DD
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

  // 1) Pull ATM contacts in range
  const atmContacts = await paginate(apiKey, {
    filterGroups: [{
      filters: [
        { propertyName: ATM_PROPERTY, operator: "GTE", value: String(fromTs) },
        { propertyName: ATM_PROPERTY, operator: "LTE", value: String(toTs) },
      ],
    }],
    properties: [
      "firstname", "lastname", "email", "lifecyclestage",
      ATM_PROPERTY, "hs_lead_status", "company",
      "hs_analytics_source",
      // Contact-level attribution fields, native report may filter on one of these
      "lead_source", "inbound_outbound", "qualified_lead",
      "hs_latest_source", "hs_analytics_source_data_1",
      "createdate",
    ],
  });

  // 2) Lookup company associations + tier + lead_source
  const contactToCompany = new Map<string, string>();
  const companyProps = new Map<string, { tier: string; leadSource: string; name: string }>();

  for (let i = 0; i < atmContacts.length; i += 100) {
    const batch = atmContacts.slice(i, i + 100);
    const assocData = await hubspotFetch("/crm/v4/associations/contacts/companies/batch/read", apiKey, {
      method: "POST",
      body: JSON.stringify({ inputs: batch.map(c => ({ id: c.id })) }),
    });
    const companyIds = new Set<string>();
    for (const r of (assocData.results || [])) {
      const cId = String(r.from?.id || "");
      const coId = String(r.to?.[0]?.toObjectId || "");
      if (cId && coId) {
        contactToCompany.set(cId, coId);
        companyIds.add(coId);
      }
    }
    if (companyIds.size) {
      const compData = await hubspotFetch("/crm/v3/objects/companies/batch/read", apiKey, {
        method: "POST",
        body: JSON.stringify({
          inputs: Array.from(companyIds).map(id => ({ id })),
          properties: ["name", "tier", "lead_source", "hs_lead_source"],
        }),
      });
      for (const comp of (compData.results || [])) {
        companyProps.set(String(comp.id), {
          tier: comp.properties?.tier || "",
          leadSource: comp.properties?.lead_source || comp.properties?.hs_lead_source || "",
          name: comp.properties?.name || "",
        });
      }
    }
  }

  // 3) Build per-contact decision log
  const contactDecisions = atmContacts.map(c => {
    const companyId = contactToCompany.get(c.id) || "";
    const co = companyProps.get(companyId);
    const tier = co?.tier || "";
    const companyLeadSource = (co?.leadSource || "").toLowerCase().trim();
    const companyName = co?.name || c.properties.company || "";
    const stage = c.properties.lifecyclestage || "";
    const leadStatus = c.properties.hs_lead_status || "";
    const wasReTiered = SQL_STAGES.includes(stage) || SQL_STATUSES.includes(leadStatus);
    const normalizedTier = normalizeTier(tier);
    const tierValid = VALID_TIERS.has(normalizedTier);

    // Mirror exact filter logic from client.ts
    let keep = false;
    let dropReason = "";
    if (!companyId) {
      dropReason = "no_company_association";
    } else if (wasReTiered) {
      keep = true;
    } else if (!tierValid) {
      dropReason = `tier_not_valid (${tier || "empty"})`;
    } else if (companyLeadSource && companyLeadSource !== "inbound") {
      dropReason = `company_lead_source=${companyLeadSource}`;
    } else {
      keep = true;
    }

    return {
      contactId: c.id,
      companyId,
      company: companyName,
      name: `${c.properties.firstname || ""} ${c.properties.lastname || ""}`.trim(),
      email: c.properties.email || "",
      tier,
      companyLeadSource: co?.leadSource || "",
      // Contact-level lead_source + related attribution fields (native report may use one of these)
      contactLeadSource: c.properties.lead_source || "",
      inboundOutbound: c.properties.inbound_outbound || "",
      qualifiedLead: c.properties.qualified_lead || "",
      latestSource: c.properties.hs_latest_source || "",
      analyticsSource: c.properties.hs_analytics_source || "",
      analyticsSourceData1: c.properties.hs_analytics_source_data_1 || "",
      lifecycle: stage,
      leadStatus,
      wasReTiered,
      atmDate: parseAtmDate(c.properties[ATM_PROPERTY]),
      createdate: parseAtmDate(c.properties.createdate),
      keep,
      dropReason,
    };
  });

  // 4) Dedupe kept contacts by company (earliest ATM wins)
  const byCompany = new Map<string, typeof contactDecisions[number]>();
  for (const d of contactDecisions) {
    if (!d.keep) continue;
    const existing = byCompany.get(d.companyId);
    if (!existing || d.atmDate < existing.atmDate) {
      byCompany.set(d.companyId, d);
    }
  }
  const uniqueCompanies = Array.from(byCompany.values())
    .sort((a, b) => a.company.localeCompare(b.company));

  return NextResponse.json({
    range: { from: fromDate, to: toDate },
    counts: {
      rawAtmContacts: atmContacts.length,
      keptContacts: contactDecisions.filter(d => d.keep).length,
      uniqueCompanies: uniqueCompanies.length,
    },
    uniqueCompanies,
    droppedContacts: contactDecisions
      .filter(d => !d.keep)
      .map(d => ({
        company: d.company,
        name: d.name,
        tier: d.tier,
        companyLeadSource: d.companyLeadSource,
        lifecycle: d.lifecycle,
        leadStatus: d.leadStatus,
        dropReason: d.dropReason,
      })),
  });
}
