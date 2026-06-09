import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { db } from "@/lib/db";
import { shareTokens } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

/** GET: list share links (active first) */
export async function GET() {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const tokens = await db
    .select()
    .from(shareTokens)
    .orderBy(desc(shareTokens.createdAt))
    .all();
  return NextResponse.json({ tokens });
}

/** POST: create a new share link */
export async function POST(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const label = String(body.label || "").trim().slice(0, 80) || null;

  // 24 hex chars, URL-safe and collision-resistant enough for an internal share link.
  const token = randomBytes(12).toString("hex");
  const createdBy = session.email || null;

  await db
    .insert(shareTokens)
    .values({ token, label, createdBy })
    .run();

  return NextResponse.json({ ok: true, token });
}

/** DELETE: revoke a share link (marks revoked_at; token becomes unusable) */
export async function DELETE(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const token = (searchParams.get("token") || "").trim();
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  await db
    .update(shareTokens)
    .set({ revokedAt: Date.now() })
    .where(eq(shareTokens.token, token))
    .run();
  return NextResponse.json({ ok: true });
}
