import { NextRequest, NextResponse } from "next/server";
import { getSessionOrPublic } from "@/lib/sessionOrPublic";
import { db } from "@/lib/db";
import { teamInvites } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** "@obol.app", domain-wide invite, matches any email at that domain. */
function validDomain(value: string) {
  return /^@[^\s@]+\.[^\s@]+$/.test(value);
}

/** GET: list team invites */
export async function GET() {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const invites = await db
    .select()
    .from(teamInvites)
    .orderBy(desc(teamInvites.invitedAt))
    .all();
  return NextResponse.json({ invites });
}

/** POST: invite a teammate by email */
export async function POST(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").toLowerCase().trim();

  if (!validEmail(email) && !validDomain(email)) {
    return NextResponse.json(
      { error: "Enter an email (teammate@obol.app) or a whole domain (@obol.app)" },
      { status: 400 }
    );
  }

  const inviterEmail = session.email || null;

  await db
    .insert(teamInvites)
    .values({ email, invitedBy: inviterEmail })
    .onConflictDoUpdate({
      target: teamInvites.email,
      set: { invitedBy: inviterEmail },
    })
    .run();

  return NextResponse.json({ ok: true, email });
}

/** DELETE: revoke an invite */
export async function DELETE(req: NextRequest) {
  const session = await getSessionOrPublic();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const email = (searchParams.get("email") || "").toLowerCase().trim();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  await db.delete(teamInvites).where(eq(teamInvites.email, email)).run();
  return NextResponse.json({ ok: true });
}
