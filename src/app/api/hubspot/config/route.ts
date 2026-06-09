import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

// Ensure table exists with all columns
async function ensureTable() {
  try {
    await db.run(sql`CREATE TABLE IF NOT EXISTS hubspot_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      api_key TEXT NOT NULL DEFAULT '',
      atm_property TEXT NOT NULL DEFAULT 'agreed_to_meet_date___test_',
      sql_classification TEXT NOT NULL DEFAULT 'hs_lead_status_sql',
      mql_definition TEXT NOT NULL DEFAULT 'form_fill',
      lead_source_property TEXT NOT NULL DEFAULT 'lead_source',
      lead_source_value TEXT NOT NULL DEFAULT 'Inbound',
      exclude_segment_property TEXT NOT NULL DEFAULT 'number_of_employees__segmented_',
      exclude_segment_values TEXT NOT NULL DEFAULT '1-10',
      updated_at INTEGER
    )`);
    // Add columns if they don't exist (ALTER TABLE for existing tables)
    for (const col of [
      "lead_source_property TEXT NOT NULL DEFAULT 'lead_source'",
      "lead_source_value TEXT NOT NULL DEFAULT 'Inbound'",
      "exclude_segment_property TEXT NOT NULL DEFAULT 'number_of_employees__segmented_'",
      "exclude_segment_values TEXT NOT NULL DEFAULT '1-10'",
    ]) {
      try { await db.run(sql.raw(`ALTER TABLE hubspot_config ADD COLUMN ${col}`)); } catch { /* already exists */ }
    }
  } catch {
    // table likely already exists
  }
}

export async function GET() {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await ensureTable();
  try {
    const row = await db.get<Record<string, any>>(sql`SELECT * FROM hubspot_config WHERE id = 1`);
    if (!row || !row.api_key) {
      return NextResponse.json({ success: true, config: { hasApiKey: false } });
    }
    return NextResponse.json({
      success: true,
      config: {
        hasApiKey: true,
        apiKey: row.api_key.slice(0, 10) + "..." + row.api_key.slice(-4),
        atmProperty: row.atm_property,
        sqlClassification: row.sql_classification,
        mqlDefinition: row.mql_definition,
        leadSourceProperty: row.lead_source_property || "lead_source",
        leadSourceValue: row.lead_source_value || "Inbound",
        excludeSegmentProperty: row.exclude_segment_property || "number_of_employees__segmented_",
        excludeSegmentValues: row.exclude_segment_values || "1-10",
      },
    });
  } catch {
    return NextResponse.json({ success: true, config: { hasApiKey: false } });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    await ensureTable();
    const body = await req.json();
    const { apiKey, atmProperty, sqlClassification, mqlDefinition,
            leadSourceProperty, leadSourceValue, excludeSegmentProperty, excludeSegmentValues } = body;

    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json({ success: false, error: "API key is required." }, { status: 400 });
    }

    const sqlClass = Array.isArray(sqlClassification) ? sqlClassification.join(",") : (sqlClassification || "hs_lead_status_sql");
    const excludeVals = Array.isArray(excludeSegmentValues) ? excludeSegmentValues.join(",") : (excludeSegmentValues || "");

    const existing = await db.get<{ id: number }>(sql`SELECT id FROM hubspot_config WHERE id = 1`);
    if (existing) {
      await db.run(sql`UPDATE hubspot_config SET
        api_key = ${apiKey},
        atm_property = ${atmProperty || "agreed_to_meet_date___test_"},
        sql_classification = ${sqlClass},
        mql_definition = ${mqlDefinition || "form_fill"},
        lead_source_property = ${leadSourceProperty || "lead_source"},
        lead_source_value = ${leadSourceValue || "Inbound"},
        exclude_segment_property = ${excludeSegmentProperty || "number_of_employees__segmented_"},
        exclude_segment_values = ${excludeVals},
        updated_at = ${Date.now()}
      WHERE id = 1`);
    } else {
      await db.run(sql`INSERT INTO hubspot_config (id, api_key, atm_property, sql_classification, mql_definition, lead_source_property, lead_source_value, exclude_segment_property, exclude_segment_values, updated_at)
        VALUES (1, ${apiKey}, ${atmProperty || "agreed_to_meet_date___test_"}, ${sqlClass}, ${mqlDefinition || "form_fill"}, ${leadSourceProperty || "lead_source"}, ${leadSourceValue || "Inbound"}, ${excludeSegmentProperty || "number_of_employees__segmented_"}, ${excludeVals}, ${Date.now()})`);
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error: `Failed to save: ${message}` }, { status: 500 });
  }
}
