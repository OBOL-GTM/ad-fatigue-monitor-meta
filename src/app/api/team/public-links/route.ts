import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { db } from "@/lib/db";
import { publicLinks } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

/** GET: list public links */
export async function GET() {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const tokens = await db
    .select()
    .from(publicLinks)
    .orderBy(desc(publicLinks.createdAt))
    .all();
  return NextResponse.json({ tokens });
}

/** POST: create a new public view-only link */
export async function POST(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const label = String(body.label || "").trim().slice(0, 80) || null;

  // 16 bytes = 32 hex chars, longer than share_tokens since this is totally open.
  const token = randomBytes(16).toString("hex");
  const createdBy = session.email || null;

  await db
    .insert(publicLinks)
    .values({ token, label, createdBy })
    .run();

  return NextResponse.json({ ok: true, token });
}

/** DELETE: revoke a public link */
export async function DELETE(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const token = (searchParams.get("token") || "").trim();
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  await db
    .update(publicLinks)
    .set({ revokedAt: Date.now() })
    .where(eq(publicLinks.token, token))
    .run();
  return NextResponse.json({ ok: true });
}
