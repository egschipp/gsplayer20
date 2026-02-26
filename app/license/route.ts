import { NextResponse } from "next/server";

export const runtime = "nodejs";

const LICENSE_TEXT = "GSPlayer20 - proprietary use.";

function withNoStoreHeaders(res: NextResponse) {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET() {
  return withNoStoreHeaders(
    new NextResponse(LICENSE_TEXT, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  );
}

export async function HEAD() {
  return withNoStoreHeaders(new NextResponse(null, { status: 200 }));
}
