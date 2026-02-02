import NextAuth from "next-auth";
import { getAuthOptions } from "@/lib/auth/options";

export default NextAuth(getAuthOptions());
