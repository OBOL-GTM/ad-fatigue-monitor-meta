import { NextResponse } from "next/server";
import { createRawDbClient } from "@/lib/db";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const client = createRawDbClient();

  const results: string[] = [];

  const columns = [
    { name: "image_url", sql: "ALTER TABLE ads ADD COLUMN image_url TEXT" },
    { name: "ad_body", sql: "ALTER TABLE ads ADD COLUMN ad_body TEXT" },
    { name: "ad_headline", sql: "ALTER TABLE ads ADD COLUMN ad_headline TEXT" },
    { name: "ad_link_url", sql: "ALTER TABLE ads ADD COLUMN ad_link_url TEXT" },
  ];

  for (const col of columns) {
    try {
      await client.execute(col.sql);
      results.push(`Added ${col.name}`);
    } catch (e: any) {
      if (e.message?.includes("duplicate column")) {
        results.push(`${col.name} already exists`);
      } else {
        results.push(`${col.name} error: ${e.message}`);
      }
    }
  }

  return NextResponse.json({ results });
}
