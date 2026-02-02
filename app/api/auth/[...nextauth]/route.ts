import NextAuth from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return NextAuth(getAuthOptions())(req);
}

export async function POST(req: Request) {
  return NextAuth(getAuthOptions())(req);
}
