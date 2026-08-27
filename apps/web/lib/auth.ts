import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

import { env } from "./env";

/**
 * Google sign-in restricted to the agency.
 *
 * This is an internal tool holding client brand data and API budgets, so the
 * allow-list is enforced in `signIn` rather than left to whoever finds the URL.
 * With neither ALLOWED_EMAIL_DOMAINS nor ALLOWED_EMAILS set, sign-in is refused
 * outright — an open door is never the safe default, even briefly.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  pages: { signIn: "/signin" },
  session: { strategy: "jwt" },
  callbacks: {
    signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      if (!email) return false;

      const domains = env.allowedEmailDomains;
      const emails = env.allowedEmails;

      if (domains.length === 0 && emails.length === 0) return false;
      if (emails.includes(email)) return true;

      const domain = email.split("@")[1];
      return Boolean(domain && domains.includes(domain));
    },
  },
});

export type SessionUser = { email: string; name?: string | null; image?: string | null };

/**
 * Resolves the signed-in user, or null. `AUTH_DISABLED=true` short-circuits to
 * a stub identity for local development against a throwaway database.
 */
export async function currentUser(): Promise<SessionUser | null> {
  if (env.authDisabled) {
    return { email: "dev@localhost", name: "Local Dev" };
  }
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;
  return {
    email,
    name: session.user?.name ?? null,
    image: session.user?.image ?? null,
  };
}

/** Throws when unauthenticated — use in route handlers and server actions. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}
