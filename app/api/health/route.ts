export const runtime = "nodejs";

export async function GET() {
  const missing = [];
  if (!process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET) {
    missing.push("AUTH_SECRET/NEXTAUTH_SECRET");
  }
  if (!process.env.APP_PIN && !process.env.PIN_CODE) {
    missing.push("APP_PIN/PIN_CODE");
  }
  if (!process.env.TOKEN_ENCRYPTION_KEY) {
    missing.push("TOKEN_ENCRYPTION_KEY");
  }
  if (!process.env.SPOTIFY_CLIENT_ID) {
    missing.push("SPOTIFY_CLIENT_ID");
  }
  if (!process.env.SPOTIFY_CLIENT_SECRET) {
    missing.push("SPOTIFY_CLIENT_SECRET");
  }

  if (missing.length) {
    return new Response(`missing env: ${missing.join(", ")}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
