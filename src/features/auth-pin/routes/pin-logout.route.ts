import { NextResponse } from "next/server";
import { requireSameOrigin } from "@/lib/api/guards";
import { runPinLogoutAction } from "@/src/features/auth-pin/actions/pin-logout.action";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const originCheck = requireSameOrigin(req);
  if (originCheck) return originCheck;

  const result = runPinLogoutAction();
  const response = NextResponse.json(result.body, {
    status: result.status,
  });

  response.cookies.set(result.clearCookie.name, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
