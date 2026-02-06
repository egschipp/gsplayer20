import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/api/guards";
import { clearAuthLog, getAuthLog } from "@/lib/auth/authLog";

export function GET() {
  if (process.env.AUTH_LOG_ENABLED !== "true") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json(getAuthLog(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export function DELETE(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  if (process.env.AUTH_LOG_ENABLED !== "true") {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  clearAuthLog();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
