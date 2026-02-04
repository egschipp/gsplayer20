import { NextResponse } from "next/server";
import { clearAuthLog, getAuthLog } from "@/lib/auth/authLog";

export function GET() {
  return NextResponse.json(getAuthLog(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export function DELETE() {
  clearAuthLog();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
