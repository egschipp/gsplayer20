import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/api/guards";

export const runtime = "nodejs";

const COOKIE_NAME = "gs_pin";

export async function POST(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
