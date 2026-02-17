import { NextResponse } from "next/server";
import { requireAppUser, requireSameOrigin } from "@/lib/api/guards";
import { clearAuthLog, getAuthLog } from "@/lib/auth/authLog";

export async function GET() {
  if (process.env.AUTH_LOG_ENABLED !== "true") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const { response } = await requireAppUser();
  if (response) return response;

  return NextResponse.json(getAuthLog(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function DELETE(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  if (process.env.AUTH_LOG_ENABLED !== "true") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const { response } = await requireAppUser();
  if (response) return response;

  clearAuthLog();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
