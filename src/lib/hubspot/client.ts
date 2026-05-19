import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const BASE_URL = "https://api.hubapi.com";

// Lightweight in-memory TTL cache so repeat page loads/preset switching don't
// trigger new HubSpot queries. Node process is persistent on Railway so this
// speeds things up across users too.
const HUBSPOT_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
type CacheEntry = { expires: number; promise: Promise<any> };
const _hsCache = new Map<string, CacheEntry>();

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = _hsCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise as Promise<T>;
  const promise = fn().catch((err) => {
    _hsCache.delete(key);
    throw err;
  });
  _hsCache.set(key, { expires: Date.now() + ttlMs, promise });
  return promise;
}

/** Invalidate all HubSpot funnel cache, call from Refresh / after sync. */
export function clearHubSpotCache() {
  _hsCache.clear();
}

interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
}

interface SearchResponse {
  total: number;
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

/** Stored config for how this business counts leads */
export interface HubSpotFilterConfig {
  atmProperty: string;              // e.g. "agreed_to_meet_date___test_"
  leadSourceProperty: string;       // e.g. "lead_source"
  leadSourceValue: string;          // e.g. "Inbound"
  excludeSegmentProperty: string;   // e.g. "number_of_employees__segmented_"
  excludeSegmentValues: string[];   // e.g. ["1-10"] (micro SMB)
  sqlStatuses: string[];            // e.g. ["SQL", "OPEN_DEAL"]
  sqlStages: string[];              // e.g. ["opportunity", "customer"]
  mqlProperty: string;              // e.g. "mql"
  mqlValue: string;                 // e.g. "true"
}

const DEFAULT_CONFIG: HubSpotFilterConfig = {
  atmProperty: "agreed_to_meet_date___test_",
  leadSourceProperty: "lead_source",
  leadSourceValue: "Inbound",
  excludeSegmentProperty: "number_of_employees__segmented_",
  excludeSegmentValues: ["1-10"],
  sqlStatuses: ["SQL", "OPEN_DEAL"],
  sqlStages: ["salesqualifiedlead", "opportunity", "customer"],
  mqlProperty: "mql",
  mqlValue: "true",
};

/** Load filter config from DB, fall back to defaults */
async function getFilterConfig(): Promise<HubSpotFilterConfig> {
  try {
    const row = await db.get<{
      atm_property: string;
      sql_classification: string;
      mql_definition: string;
      lead_source_property?: string;
      lead_source_value?: string;
      exclude_segment_property?: string;
      exclude_segment_values?: string;
    }>(sql`SELECT * FROM hubspot_config WHERE id = 1`);

    if (row) {
      return {
        atmProperty: row.atm_property || DEFAULT_CONFIG.atmProperty,
        leadSourceProperty: row.lead_source_property || DEFAULT_CONFIG.leadSourceProperty,
        leadSourceValue: row.lead_source_value || DEFAULT_CONFIG.leadSourceValue,
        excludeSegmentProperty: row.exclude_segment_property || DEFAULT_CONFIG.excludeSegmentProperty,
        excludeSegmentValues: row.exclude_segment_values ? row.exclude_segment_values.split(",") : DEFAULT_CONFIG.excludeSegmentValues,
        sqlStatuses: DEFAULT_CONFIG.sqlStatuses,
        sqlStages: DEFAULT_CONFIG.sqlStages,
        mqlProperty: DEFAULT_CONFIG.mqlProperty,
        mqlValue: DEFAULT_CONFIG.mqlValue,
      };
    }
  } catch {
    // table may not exist
  }
  return DEFAULT_CONFIG;
}

/** Get the API key: env var first, then DB fallback */
async function getApiKey(): Promise<string> {
  if (process.env.HUBSPOT_API_KEY) return process.env.HUBSPOT_API_KEY;
  try {
    const row = await db.get<{ api_key: string }>(sql`SELECT api_key FROM hubspot_config WHERE id = 1`);
    if (row?.api_key) return row.api_key;
  } catch {
    // table may not exist yet
  }
  throw new Error("HUBSPOT_API_KEY not configured");
}

async function hubspotFetch(path: string, options?: RequestInit): Promise<any> {
  const apiKey = await getApiKey();
  // Retry on 5xx + 429, HubSpot rate-limits bursts, and parallel slice
  // queries easily trip that. Without retry, one 429 loses a whole month.
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...options?.headers,
      },
    });
    if (res.ok) return res.json();
    const body = await res.text();
    if (res.status >= 500 || res.status === 429) {
      lastErr = new Error(`HubSpot API error ${res.status}: ${body}`);
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      continue;
    }
    throw new Error(`HubSpot API error ${res.status}: ${body}`);
  }
  throw lastErr || new Error("HubSpot API retry limit exceeded");
}

/** HS returns company date properties as "YYYY-MM-DD" strings OR millisecond timestamps, handle both. */
function parseCompanyDate(val: string | null | undefined): string {
  if (!val) return "";
  if (val.includes("-")) return val.slice(0, 10);
  const n = parseInt(val, 10);
  if (!n || isNaN(n)) return "";
  return new Date(n).toISOString().split("T")[0];
}

// Company-level property internal names for Obol's HS portal (verified 2026-04-20).
// These drive the native "Inbounds YTD Monthly Leads By Tier" report and are the
// source of truth for ATM counts. Do NOT change without re-verifying property names
// against /crm/v3/properties/companies.
const COMPANY_ATM_PROP = "willing_to_meet";            // label: "Agreed to Meet Date"
const COMPANY_LEAD_SOURCE_PROP = "lead_source__cloned_"; // label: "Lead Source " (trailing space)
const COMPANY_TIER_PROP = "tier";
const COMPANY_TIER_ALLOWLIST = ["SMB", "Mid-Market", "Enterprise"];

// Deal-level filters for SQL count, mirrors native "SQLs Monthly (No rejects)" report.
// Pipeline ID + property name verified via /api/hubspot/sql-debug on 2026-04-20.
const SQL_PIPELINE_ID = "1704584404";               // "Obol Sales Funnel (NEW)"
const SQL_REJECT_PROP = "demo_accept_reject";
const SQL_REJECT_VALUE = "Reject (Unqualified)";

/** Query deals matching the native "SQLs Monthly (No rejects)" report filter set. */
async function getSQLDealsInRange(fromTs: number, toTs: number): Promise<Array<{
  id: string;
  name: string;
  createdate: string;
  stage: string;
  companyId?: string;
}>> {
  const baseFilters = [
    { propertyName: "pipeline", operator: "EQ", value: SQL_PIPELINE_ID },
    { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
    { propertyName: "createdate", operator: "LTE", value: String(toTs) },
  ];
  const searchBody = {
    filterGroups: [
      { filters: [...baseFilters, { propertyName: SQL_REJECT_PROP, operator: "NEQ", value: SQL_REJECT_VALUE }] },
      { filters: [...baseFilters, { propertyName: SQL_REJECT_PROP, operator: "NOT_HAS_PROPERTY" }] },
    ],
    properties: ["dealname", "createdate", "pipeline", "dealstage"],
    limit: 100,
  };
  const rawDeals: any[] = [];
  let after: string | undefined;
  do {
    const r = await hubspotFetch("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({ ...searchBody, ...(after ? { after } : {}) }),
    });
    rawDeals.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  // Dedupe (a deal could theoretically match both filter groups)
  const unique = Array.from(new Map(rawDeals.map(d => [d.id, d])).values());

  // Fetch deal→company associations
  const dealToCompany = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    try {
      const assoc = await hubspotFetch("/crm/v4/associations/deals/companies/batch/read", {
        method: "POST",
        body: JSON.stringify({ inputs: batch.map(d => ({ id: d.id })) }),
      });
      for (const r of (assoc.results || [])) {
        const dId = String(r.from?.id || "");
        const cId = String(r.to?.[0]?.toObjectId || "");
        if (dId && cId) dealToCompany.set(dId, cId);
      }
    } catch (err) {
      console.error("Deal→company assoc lookup failed (non-fatal):", err);
    }
  }

  return unique.map(d => ({
    id: String(d.id),
    name: d.properties?.dealname || "",
    createdate: (d.properties?.createdate || "").slice(0, 10),
    stage: d.properties?.dealstage || "",
    companyId: dealToCompany.get(String(d.id)),
  }));
}

/**
 * Lightweight variant, only returns daily ATM + SQL deal counts (no contacts, no MQL).
 * Used by Executive View which doesn't need per-contact attribution.
 * Drops contact-association lookups and MQL query, typically 5-10x faster than full getLeadsFunnel.
 */
export async function getLeadsFunnelLite(
  fromDate: string,
  toDate: string,
): Promise<{
  dailyATM: { date: string; atm: number }[];
  dailySQLDeals: { date: string; sqlDeals: number }[];
  dailyMQLs: { date: string; mqls: number }[];
  totalATM: number;
  totalSQLs: number;
  totalMQLs: number;
}> {
  return cached(`lite:${fromDate}:${toDate}`, HUBSPOT_CACHE_TTL_MS, () =>
    _getLeadsFunnelLiteUncached(fromDate, toDate),
  );
}

async function _getLeadsFunnelLiteUncached(
  fromDate: string,
  toDate: string,
) {
  // Chunk the requested window into month-sized slices, run slices in parallel,
  // and merge. Single-shot 6-month queries intermittently timed out on Railway
  // and the whole Executive view fell back to 0s across every month. Monthly
  // slices run in < 1s each and bubble up partial data if one slice fails.
  const slices: Array<[string, string]> = [];
  const start = new Date(fromDate + "T00:00:00Z");
  const end = new Date(toDate + "T23:59:59Z");
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cur <= end) {
    const sliceStart = cur < start ? start : cur;
    const nextMonth = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const sliceEnd = nextMonth > end ? end : new Date(nextMonth.getTime() - 1);
    slices.push([
      sliceStart.toISOString().slice(0, 10),
      sliceEnd.toISOString().slice(0, 10),
    ]);
    cur = nextMonth;
  }

  // Run each leg (ATM companies + SQL deals + MQL contacts) as its own
  // independent promise per slice, so a failure on one leg doesn't lose
  // the other legs' data for that month.
  const allAtmDates: string[] = [];
  const allSqlDates: string[] = [];
  const allMqlDates: string[] = [];
  await Promise.all(
    slices.flatMap(([sliceFrom, sliceTo]) => [
      _fetchLiteATM(sliceFrom, sliceTo)
        .then((d) => { allAtmDates.push(...d); })
        .catch((err) => {
          console.error(`[hubspot-lite] ATM slice ${sliceFrom}→${sliceTo} failed:`, err);
        }),
      _fetchLiteSQL(sliceFrom, sliceTo)
        .then((d) => { allSqlDates.push(...d); })
        .catch((err) => {
          console.error(`[hubspot-lite] SQL slice ${sliceFrom}→${sliceTo} failed:`, err);
        }),
      _fetchLiteMQL(sliceFrom, sliceTo)
        .then((d) => { allMqlDates.push(...d); })
        .catch((err) => {
          console.error(`[hubspot-lite] MQL slice ${sliceFrom}→${sliceTo} failed:`, err);
        }),
    ]),
  );

  const atmMap = new Map<string, number>();
  for (const d of allAtmDates) atmMap.set(d, (atmMap.get(d) || 0) + 1);
  const dailyATM = Array.from(atmMap.entries())
    .map(([date, atm]) => ({ date, atm }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sqlMap = new Map<string, number>();
  for (const d of allSqlDates) sqlMap.set(d, (sqlMap.get(d) || 0) + 1);
  const dailySQLDeals = Array.from(sqlMap.entries())
    .map(([date, sqlDeals]) => ({ date, sqlDeals }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const mqlMap = new Map<string, number>();
  for (const d of allMqlDates) mqlMap.set(d, (mqlMap.get(d) || 0) + 1);
  const dailyMQLs = Array.from(mqlMap.entries())
    .map(([date, mqls]) => ({ date, mqls }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    dailyATM,
    dailySQLDeals,
    dailyMQLs,
    totalATM: allAtmDates.length,
    totalSQLs: allSqlDates.length,
    totalMQLs: allMqlDates.length,
  };
}

// Closed-won stage IDs across ALL Obol pipelines. Orly's call (2026-04-20):
// include PLG Live + Upsell Completed, "at end of the day we should include
// data". PLG Lost is the only explicit exclusion.
const CLOSED_WON_STAGE_IDS = [
  "270845155",  // Closed Won (Obol Sales Pipeline LEGACY)
  "1735129325", // Closed Won (Micro SMB Sales Pipeline)
  "2626624699", // Closed Won (Upsell Pipeline)
  "4704358635", // Upsell Completed (PLG)
  "4666719467", // Live (PLG), treated as revenue-generating
];
// Stages explicitly NOT counted as revenue.
const CLOSED_WON_EXCLUDE = new Set<string>(["4562277596"]); // PLG Lost

/**
 * ROAS data: pulls closed-won deals whose close date is in the range and
 * returns {totalRevenue, wonCount, dealsByUtm}. We use `closedate` so revenue
 * is booked to the period it actually closed, not when the deal was created.
 *
 * Per-campaign attribution: for each won deal we look up the associated
 * company's primary contact utm_campaign (via a second contact-search call
 * that filters associatedcompanyid IN the won companies). Falls back to
 * hs_analytics_source_data_2 if utm_campaign is blank.
 */
export async function getClosedWonRevenue(
  fromDate: string,
  toDate: string,
): Promise<{
  totalRevenue: number;
  wonCount: number;
  revenueByUtm: Array<{ campaign: string; revenue: number; deals: number }>;
}> {
  return cached(`won:${fromDate}:${toDate}`, HUBSPOT_CACHE_TTL_MS, () =>
    _getClosedWonRevenueUncached(fromDate, toDate),
  );
}

async function _getClosedWonRevenueUncached(fromDate: string, toDate: string) {
  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();
  const wonStages = CLOSED_WON_STAGE_IDS.filter(id => !CLOSED_WON_EXCLUDE.has(id));

  // Pull deals closed in the range that landed in any closed-won stage.
  const dealSearchBody = {
    filterGroups: [{
      filters: [
        { propertyName: "closedate", operator: "GTE", value: String(fromTs) },
        { propertyName: "closedate", operator: "LTE", value: String(toTs) },
        { propertyName: "dealstage", operator: "IN", values: wonStages },
      ],
    }],
    properties: ["amount", "closedate", "dealstage", "pipeline"],
    limit: 100,
  };

  const deals: Array<{ id: string; properties: Record<string, string | null> }> = [];
  let after: string | undefined;
  do {
    const r = await hubspotFetch("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({ ...dealSearchBody, ...(after ? { after } : {}) }),
    });
    deals.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);

  const totalRevenue = deals.reduce(
    (s, d) => s + (parseFloat(d.properties.amount || "0") || 0),
    0,
  );
  const wonCount = deals.length;

  // Per-deal utm attribution via deal → company → primary contact.
  // Batch the company associations for efficiency.
  const dealIds = deals.map(d => d.id);
  const dealAmount = new Map(
    deals.map(d => [d.id, parseFloat(d.properties.amount || "0") || 0] as const),
  );

  const dealToCompany = new Map<string, string>();
  if (dealIds.length > 0) {
    for (let i = 0; i < dealIds.length; i += 100) {
      const chunk = dealIds.slice(i, i + 100);
      const r = await hubspotFetch(
        "/crm/v4/associations/deals/companies/batch/read",
        {
          method: "POST",
          body: JSON.stringify({ inputs: chunk.map(id => ({ id })) }),
        },
      ).catch(() => ({ results: [] as any[] }));
      for (const row of r.results || []) {
        const firstCompany = row.to?.[0]?.toObjectId;
        if (firstCompany) dealToCompany.set(row.from?.id || row._from?.id, String(firstCompany));
      }
    }
  }

  // Now pull utm_campaign per company via contacts search filtered by associated company.
  const companyIds = Array.from(new Set(dealToCompany.values()));
  const companyToUtm = new Map<string, string>();
  for (let i = 0; i < companyIds.length; i += 100) {
    const chunk = companyIds.slice(i, i + 100);
    const r = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        filterGroups: [{
          filters: [
            { propertyName: "associatedcompanyid", operator: "IN", values: chunk },
          ],
        }],
        properties: [
          "hs_analytics_source_data_2",
          "hs_analytics_last_touch_converting_campaign",
          "hs_analytics_first_touch_converting_campaign",
          "associatedcompanyid",
          "createdate",
        ],
        limit: 100,
        sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      }),
    }).catch(() => ({ results: [] as any[] }));
    for (const c of r.results || []) {
      const cid = c.properties.associatedcompanyid;
      if (!cid || companyToUtm.has(cid)) continue;
      const a = (c.properties.hs_analytics_source_data_2 || "").trim();
      const b = (c.properties.hs_analytics_last_touch_converting_campaign || "").trim();
      const d = (c.properties.hs_analytics_first_touch_converting_campaign || "").trim();
      companyToUtm.set(cid, a || b || d || "(unattributed)");
    }
  }

  const revenueByCampaign = new Map<string, { revenue: number; deals: number }>();
  for (const [dealId, amount] of dealAmount) {
    const companyId = dealToCompany.get(dealId);
    const campaign = (companyId && companyToUtm.get(companyId)) || "(no utm)";
    const agg = revenueByCampaign.get(campaign) ?? { revenue: 0, deals: 0 };
    agg.revenue += amount;
    agg.deals += 1;
    revenueByCampaign.set(campaign, agg);
  }

  const revenueByUtm = Array.from(revenueByCampaign.entries())
    .map(([campaign, v]) => ({ campaign, revenue: Math.round(v.revenue * 100) / 100, deals: v.deals }))
    .sort((a, b) => b.revenue - a.revenue);

  return { totalRevenue: Math.round(totalRevenue * 100) / 100, wonCount, revenueByUtm };
}

/**
 * Lean attribution query: returns ATM lead counts grouped by the contact's
 * best-available campaign label. Used to compute per-campaign CPL by joining
 * against Meta campaign spend.
 *
 * NOTE: Orly's HubSpot does NOT have `utm_campaign` as a contact property
 * (confirmed via schema inspection 2026-04-20). HS stores the Meta campaign
 * name on `hs_analytics_source_data_2` for PAID_SOCIAL contacts, usually
 * lowercased but otherwise matching the Meta campaign name verbatim.
 * Fallbacks: hs_analytics_last_touch_converting_campaign → first_touch.
 *
 * Deduped per company (so one contact per company counts once, matching the
 * native "ATM by company" methodology).
 */
export async function getATMLeadsByCampaign(
  fromDate: string,
  toDate: string,
): Promise<Array<{ campaign: string; count: number }>> {
  return cached(`byCampaign:${fromDate}:${toDate}`, HUBSPOT_CACHE_TTL_MS, () =>
    _getATMLeadsByCampaignUncached(fromDate, toDate),
  );
}

async function _getATMLeadsByCampaignUncached(fromDate: string, toDate: string) {
  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();

  // Pull ATM contacts directly, single search, no association fan-out.
  // Requested properties must all exist in HS or the whole search 400s.
  const contactSearchBody = {
    filterGroups: [{
      filters: [
        { propertyName: "agreed_to_meet_date___test_", operator: "GTE", value: String(fromTs) },
        { propertyName: "agreed_to_meet_date___test_", operator: "LTE", value: String(toTs) },
      ],
    }],
    properties: [
      "hs_analytics_source_data_2",
      "hs_analytics_last_touch_converting_campaign",
      "hs_analytics_first_touch_converting_campaign",
      "agreed_to_meet_date___test_",
      "associatedcompanyid",
    ],
    limit: 100,
  };

  const contacts: Array<{ id: string; properties: Record<string, string | null> }> = [];
  let after: string | undefined;
  do {
    const r = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({ ...contactSearchBody, ...(after ? { after } : {}) }),
    });
    contacts.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);

  // Dedupe by company, pick one contact per company (earliest ATM date wins).
  const byCompany = new Map<string, { contactId: string; campaign: string; atm: number }>();
  for (const c of contacts) {
    const companyId = c.properties.associatedcompanyid || c.id;
    const a = (c.properties.hs_analytics_source_data_2 || "").trim();
    const b = (c.properties.hs_analytics_last_touch_converting_campaign || "").trim();
    const d = (c.properties.hs_analytics_first_touch_converting_campaign || "").trim();
    const campaign = a || b || d || "(unattributed)";
    const atmRaw = c.properties.agreed_to_meet_date___test_;
    const atm = atmRaw ? new Date(atmRaw).getTime() : 0;
    const existing = byCompany.get(companyId);
    if (!existing || atm < existing.atm) {
      byCompany.set(companyId, { contactId: c.id, campaign, atm });
    }
  }

  const counts = new Map<string, number>();
  for (const { campaign } of byCompany.values()) {
    counts.set(campaign, (counts.get(campaign) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([campaign, count]) => ({ campaign, count }))
    .sort((a, b) => b.count - a.count);
}

async function _fetchLiteATM(fromDate: string, toDate: string): Promise<string[]> {
  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();
  // Match native HubSpot "Inbounds YTD Monthly Leads By Tier" report EXACTLY:
  // willing_to_meet in range AND lead_source = Inbound AND tier ∈ allowlist.
  // Dropping tier/lead_source here previously inflated Executive to 65 for a
  // window where Leads & Analytics correctly showed 51 (because the full
  // getLeadsFunnel path applies all 3 filters). Crisis on 2026-04-20.
  const companySearchBody = {
    filterGroups: [{
      filters: [
        { propertyName: COMPANY_ATM_PROP, operator: "GTE", value: String(fromTs) },
        { propertyName: COMPANY_ATM_PROP, operator: "LTE", value: String(toTs) },
        { propertyName: COMPANY_LEAD_SOURCE_PROP, operator: "EQ", value: "Inbound" },
        { propertyName: COMPANY_TIER_PROP, operator: "IN", values: COMPANY_TIER_ALLOWLIST },
      ],
    }],
    properties: [COMPANY_ATM_PROP],
    limit: 100,
  };
  const dates: string[] = [];
  let after: string | undefined;
  do {
    const r = await hubspotFetch("/crm/v3/objects/companies/search", {
      method: "POST",
      body: JSON.stringify({ ...companySearchBody, ...(after ? { after } : {}) }),
    });
    for (const c of (r.results || [])) {
      const raw = c.properties?.[COMPANY_ATM_PROP];
      const d = parseCompanyDate(raw);
      if (d) dates.push(d);
    }
    after = r.paging?.next?.after;
  } while (after);
  return dates;
}

/**
 * Lite MQL fetch. Counts contacts whose hs_lifecyclestage_marketingqualifiedlead_date
 * (the date the contact became an MQL) falls in [fromDate, toDate]. This matches
 * the HubSpot native "MQLs by month" report exactly — every contact that ever
 * reached MQL stage during the window is counted, whether they later progressed
 * to SQL/Customer or not. Switching off createdate (which only catches contacts
 * created AND tagged MQL in the same window) was the audit fix on 2026-05-19.
 */
const MQL_BECAME_DATE_PROP = "hs_lifecyclestage_marketingqualifiedlead_date";

async function _fetchLiteMQL(fromDate: string, toDate: string): Promise<string[]> {
  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();
  const searchBody = {
    filterGroups: [{
      filters: [
        { propertyName: MQL_BECAME_DATE_PROP, operator: "GTE", value: String(fromTs) },
        { propertyName: MQL_BECAME_DATE_PROP, operator: "LTE", value: String(toTs) },
      ],
    }],
    properties: [MQL_BECAME_DATE_PROP],
    limit: 100,
  };
  const raw: any[] = [];
  let after: string | undefined;
  do {
    const r = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({ ...searchBody, ...(after ? { after } : {}) }),
    });
    raw.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  // HubSpot returns datetime values as either ms-timestamp strings or ISO strings.
  // Normalise to YYYY-MM-DD via parseCompanyDate which already handles both.
  const dates: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const value = c.properties?.[MQL_BECAME_DATE_PROP];
    const d = parseCompanyDate(value);
    if (d) dates.push(d);
  }
  return dates;
}

async function _fetchLiteSQL(fromDate: string, toDate: string): Promise<string[]> {
  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();
  const baseFilters = [
    { propertyName: "pipeline", operator: "EQ", value: SQL_PIPELINE_ID },
    { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
    { propertyName: "createdate", operator: "LTE", value: String(toTs) },
  ];
  const searchBody = {
    filterGroups: [
      { filters: [...baseFilters, { propertyName: SQL_REJECT_PROP, operator: "NEQ", value: SQL_REJECT_VALUE }] },
      { filters: [...baseFilters, { propertyName: SQL_REJECT_PROP, operator: "NOT_HAS_PROPERTY" }] },
    ],
    properties: ["createdate"],
    limit: 100,
  };
  const raw: any[] = [];
  let after: string | undefined;
  do {
    const r = await hubspotFetch("/crm/v3/objects/deals/search", {
      method: "POST",
      body: JSON.stringify({ ...searchBody, ...(after ? { after } : {}) }),
    });
    raw.push(...(r.results || []));
    after = r.paging?.next?.after;
  } while (after);
  return Array.from(new Map(raw.map(d => [d.id, (d.properties?.createdate || "").slice(0, 10)])).values())
    .filter(Boolean);
}

/**
 * Config-driven lead funnel. Matches HubSpot's native "Inbounds YTD Monthly Leads By Tier"
 * report exactly by querying Companies (primary) with the same 3 filters:
 *   - Company.willing_to_meet (ATM date) in [from, to]
 *   - Company.lead_source__cloned_ = Inbound
 *   - Company.tier ∈ {SMB, Mid-Market, Enterprise}
 *
 * For each matching company, the earliest associated contact supplies
 * attribution (UTMs, source, ad). SQL/MQL classifications come from contact-level
 * lifecycle and lead status.
 */
export async function getLeadsFunnel(
  fromDate: string,
  toDate: string,
): Promise<{
  dailyATM: { date: string; atm: number; sqls: number; contacts: Array<{ id: string; name: string; email: string; company: string; stage: string; leadStatus: string; date: string; tier: string; segment: string; leadSource: string; type: "atm" | "sql" }> }[];
  dailyMQLs: { date: string; mqls: number; contacts: Array<{ id: string; name: string; email: string; company: string; stage: string; date: string; type: "mql" }> }[];
  dailySQLDeals: { date: string; sqlDeals: number }[];
  totalATM: number;
  totalSQLs: number;
  totalMQLs: number;
}> {
  return cached(`full:${fromDate}:${toDate}`, HUBSPOT_CACHE_TTL_MS, () =>
    _getLeadsFunnelUncached(fromDate, toDate),
  );
}

async function _getLeadsFunnelUncached(fromDate: string, toDate: string) {
  const config = await getFilterConfig();
  const fromTs = new Date(fromDate + "T00:00:00Z").getTime();
  const toTs = new Date(toDate + "T23:59:59Z").getTime();

  // === ATM: query Companies directly (matches native "Inbounds YTD Monthly Leads By Tier" report) ===
  const companySearchBody = {
    filterGroups: [{
      filters: [
        { propertyName: COMPANY_ATM_PROP, operator: "GTE", value: String(fromTs) },
        { propertyName: COMPANY_ATM_PROP, operator: "LTE", value: String(toTs) },
        { propertyName: COMPANY_LEAD_SOURCE_PROP, operator: "EQ", value: "Inbound" },
        { propertyName: COMPANY_TIER_PROP, operator: "IN", values: COMPANY_TIER_ALLOWLIST },
      ],
    }],
    properties: ["name", COMPANY_TIER_PROP, COMPANY_LEAD_SOURCE_PROP, COMPANY_ATM_PROP, "domain", "lifecyclestage", "hs_lead_status"],
    limit: 100,
  };

  const atmCompanies: Array<{ id: string; properties: Record<string, string | null> }> = [];
  let compAfter: string | undefined;
  do {
    const r = await hubspotFetch("/crm/v3/objects/companies/search", {
      method: "POST",
      body: JSON.stringify({ ...companySearchBody, ...(compAfter ? { after: compAfter } : {}) }),
    });
    atmCompanies.push(...(r.results || []));
    compAfter = r.paging?.next?.after;
  } while (compAfter);
  console.log(`[hubspot] ATM companies matching native report filters (${fromDate}→${toDate}): ${atmCompanies.length}`);

  // For each matching company, fetch associated contacts for attribution (UTMs, ad, source)
  // and lifecycle/lead status (to classify SQL vs ATM).
  // Query SQL deals in the same range, native "SQLs Monthly" is a Deals-primary report.
  // Build a set of company IDs that have at least one SQL deal, and the total deal count.
  const sqlDeals = await getSQLDealsInRange(fromTs, toTs);
  const sqlCompanyIds = new Set(sqlDeals.map(d => d.companyId).filter(Boolean) as string[]);
  console.log(`[hubspot] SQL deals matching native report (${fromDate}→${toDate}): ${sqlDeals.length}`);

  const companyToContacts = new Map<string, HubSpotContact[]>();
  const contactDetails = new Map<string, HubSpotContact>();
  try {
    for (let i = 0; i < atmCompanies.length; i += 100) {
      const batch = atmCompanies.slice(i, i + 100);
      const assocData = await hubspotFetch("/crm/v4/associations/companies/contacts/batch/read", {
        method: "POST",
        body: JSON.stringify({ inputs: batch.map(c => ({ id: c.id })) }),
      });
      const contactIdsForCompanies = new Map<string, string[]>();
      const allContactIds = new Set<string>();
      for (const r of (assocData.results || [])) {
        const companyId = String(r.from?.id || "");
        const cids = (r.to || []).map((t: any) => String(t.toObjectId)).filter(Boolean);
        if (companyId && cids.length) {
          contactIdsForCompanies.set(companyId, cids);
          cids.forEach((cid: string) => allContactIds.add(cid));
        }
      }
      // Batch fetch contact details (UTMs + lifecycle + status)
      const contactIdArr = Array.from(allContactIds);
      for (let j = 0; j < contactIdArr.length; j += 100) {
        const compBatch = contactIdArr.slice(j, j + 100);
        const contactData = await hubspotFetch("/crm/v3/objects/contacts/batch/read", {
          method: "POST",
          body: JSON.stringify({
            inputs: compBatch.map(id => ({ id })),
            properties: [
              "firstname", "lastname", "email", "lifecyclestage",
              "hs_lead_status", "hs_analytics_source", "hs_analytics_source_data_1",
              "hs_analytics_source_data_2",
              // NOTE: utm_* properties do NOT exist on Obol's HubSpot contact
              // schema (verified 2026-04-20). Requesting them 400s the WHOLE
              // batch/read and silently loses attribution for every contact.
              // Use hs_analytics_{first,last}_touch_converting_campaign for
              // the Meta-campaign label instead.
              "hs_analytics_first_touch_converting_campaign",
              "hs_analytics_last_touch_converting_campaign",
              "hs_predictivescoringtier",
              config.atmProperty, "createdate",
            ],
          }),
        });
        for (const c of (contactData.results || [])) {
          contactDetails.set(String(c.id), c);
        }
      }
      for (const [companyId, cids] of contactIdsForCompanies.entries()) {
        const contacts = cids.map(cid => contactDetails.get(cid)).filter(Boolean) as HubSpotContact[];
        companyToContacts.set(companyId, contacts);
      }
    }
  } catch (err) {
    console.error("Company → contacts lookup failed (attribution data will be partial):", err);
  }

  // Query 2: MQLs (optional, non-fatal)
  let mqlContacts: HubSpotContact[] = [];
  try {
    const mqlFilters: any[] = [
      { propertyName: "createdate", operator: "GTE", value: String(fromTs) },
      { propertyName: "createdate", operator: "LTE", value: String(toTs) },
    ];
    mqlContacts = await paginateHubSpotSearch({
      filterGroups: [
        { filters: [...mqlFilters, { propertyName: "lifecyclestage", operator: "EQ", value: "lead" }] },
        { filters: [...mqlFilters, { propertyName: "lifecyclestage", operator: "EQ", value: "marketingqualifiedlead" }] },
      ],
      properties: ["firstname", "lastname", "email", "lifecyclestage", "createdate", config.atmProperty, "company", config.excludeSegmentProperty, config.leadSourceProperty, "hs_analytics_source", "hs_analytics_source_data_1", "hs_analytics_source_data_2", "hs_lead_status"],
    });
  } catch (err) {
    console.error("MQL query failed (non-fatal):", err);
  }

  // Collect contact IDs across all matching companies so we can dedupe MQLs against them.
  // Any contact belonging to a matched ATM company is NOT counted as an MQL.
  const atmContactIds = new Set<string>();
  for (const contacts of companyToContacts.values()) {
    for (const c of contacts) atmContactIds.add(c.id);
  }

  // Filter MQLs: exclude contacts already attached to an ATM company, contacts
  // with their own ATM date, and any duplicate contact IDs (HS can return the
  // same contact across multiple filter-group matches, e.g. lifecycle = lead
  // AND lifecycle = marketingqualifiedlead would double count the same person).
  const seenMqlIds = new Set<string>();
  const pureMQLs = mqlContacts.filter(c => {
    if (atmContactIds.has(c.id)) return false;
    if (seenMqlIds.has(c.id)) return false;
    const atm = c.properties[config.atmProperty];
    if (atm && atm !== "" && atm !== "null") return false;
    seenMqlIds.add(c.id);
    return true;
  });

  // Group ATM by Company.willing_to_meet date. One entry per company (not per contact).
  // Attribution (UTMs/source/ad) comes from the earliest associated contact.
  const atmDateMap = new Map<string, { atm: number; sqls: number; contacts: Array<any> }>();
  for (const company of atmCompanies) {
    const atmRaw = company.properties[COMPANY_ATM_PROP] || "";
    const dateStr = parseCompanyDate(atmRaw);
    if (!dateStr) continue;

    const contacts = companyToContacts.get(company.id) || [];
    // Pick the earliest-created contact as the representative for attribution
    const primary = contacts.slice().sort((a, b) => {
      const aT = parseInt(a.properties.createdate || "0", 10) || 0;
      const bT = parseInt(b.properties.createdate || "0", 10) || 0;
      return aT - bT;
    })[0];

    // SQL = company has at least one deal in "Obol Sales Funnel (NEW)" pipeline
    // created in range that isn't rejected. Matches native "SQLs Monthly (No rejects)" report.
    const isSQL = sqlCompanyIds.has(company.id);

    const tier = company.properties[COMPANY_TIER_PROP] || "";
    const leadSource = company.properties[COMPANY_LEAD_SOURCE_PROP] || "";
    const companyName = company.properties.name || primary?.properties.company || "";

    if (!atmDateMap.has(dateStr)) atmDateMap.set(dateStr, { atm: 0, sqls: 0, contacts: [] });
    const day = atmDateMap.get(dateStr)!;
    day.atm++;
    if (isSQL) day.sqls++;

    const campaignLabel =
      primary?.properties.hs_analytics_source_data_2 ||
      primary?.properties.hs_analytics_last_touch_converting_campaign ||
      primary?.properties.hs_analytics_first_touch_converting_campaign ||
      "";
    day.contacts.push({
      id: primary?.id || company.id,
      name: primary ? `${primary.properties.firstname || ""} ${primary.properties.lastname || ""}`.trim() : "",
      email: primary?.properties.email || "",
      company: companyName,
      stage: primary?.properties.lifecyclestage || "",
      leadStatus: primary?.properties.hs_lead_status || "",
      date: dateStr,
      tier,
      segment: "",
      leadSource,
      type: isSQL ? "sql" as const : "atm" as const,
      source: primary?.properties.hs_analytics_source || "",
      sourcePlatform: primary?.properties.hs_analytics_source_data_1 || "",
      campaign: campaignLabel,
      adset: "",
      ad: "",
    });
  }

  // Group MQLs by create date
  const mqlDateMap = new Map<string, { mqls: number; contacts: Array<any> }>();
  for (const contact of pureMQLs) {
    const createDate = contact.properties.createdate;
    if (!createDate) continue;
    const parsed = new Date(createDate);
    if (isNaN(parsed.getTime())) continue;
    const dateStr = parsed.toISOString().split("T")[0];

    if (!mqlDateMap.has(dateStr)) mqlDateMap.set(dateStr, { mqls: 0, contacts: [] });
    const day = mqlDateMap.get(dateStr)!;
    day.mqls++;
    const campaignLabelM =
      contact.properties.hs_analytics_source_data_2 ||
      contact.properties.hs_analytics_last_touch_converting_campaign ||
      contact.properties.hs_analytics_first_touch_converting_campaign ||
      "";
    day.contacts.push({
      id: contact.id,
      name: `${contact.properties.firstname || ""} ${contact.properties.lastname || ""}`.trim(),
      email: contact.properties.email || "",
      company: contact.properties.company || "",
      stage: contact.properties.lifecyclestage || "",
      date: dateStr,
      type: "mql" as const,
      source: contact.properties.hs_analytics_source || "",
      sourcePlatform: contact.properties.hs_analytics_source_data_1 || "",
      campaign: campaignLabelM,
      adset: "",
      ad: "",
    });
  }

  const dailyATM = Array.from(atmDateMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const dailyMQLs = Array.from(mqlDateMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Daily SQL deals bucketed by their OWN createdate (not tied to ATM companies).
  // This matches the native "SQLs Monthly" report's grouping and keeps totals in sync.
  const sqlByDate = new Map<string, number>();
  for (const d of sqlDeals) {
    if (!d.createdate) continue;
    sqlByDate.set(d.createdate, (sqlByDate.get(d.createdate) || 0) + 1);
  }
  const dailySQLDeals = Array.from(sqlByDate.entries())
    .map(([date, sqlDeals]) => ({ date, sqlDeals }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    dailyATM, dailyMQLs, dailySQLDeals,
    totalATM: dailyATM.reduce((s, d) => s + d.atm, 0),
    // totalSQLs = count of deals in "Obol Sales Funnel (NEW)" pipeline created in range
    // (matches native "SQLs Monthly (No rejects)" report). Not derived from dailyATM because
    // SQL deals can exist without a matching ATM company in the same period and vice versa.
    totalSQLs: sqlDeals.length,
    totalMQLs: dailyMQLs.reduce((s, d) => s + d.mqls, 0),
  };
}

/** Paginate through HubSpot CRM search results */
async function paginateHubSpotSearch(searchBody: {
  filterGroups: any[];
  properties: string[];
}): Promise<HubSpotContact[]> {
  const allContacts: HubSpotContact[] = [];
  let after: string | undefined;
  do {
    const body = { ...searchBody, limit: 100, ...(after ? { after } : {}) };
    const data: SearchResponse = await hubspotFetch("/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify(body),
    });
    allContacts.push(...data.results);
    after = data.paging?.next?.after;
  } while (after);
  return allContacts;
}

/** Check if HubSpot is configured and accessible */
export async function checkHubSpotConnection(): Promise<{ connected: boolean; error?: string }> {
  try {
    await getApiKey();
    await hubspotFetch("/crm/v3/objects/contacts?limit=1");
    return { connected: true };
  } catch (err: any) {
    return { connected: false, error: err.message };
  }
}
