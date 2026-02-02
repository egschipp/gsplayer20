import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.redirect("/api/auth/signout");
}
