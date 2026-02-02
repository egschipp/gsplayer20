import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";

export async function GET() {
  const pkgPath = path.join(process.cwd(), "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string; name?: string };
  return NextResponse.json({
    name: pkg.name ?? "app",
    version: pkg.version ?? "0.0.0",
  });
}
