import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { currentUser, signIn } from "@/lib/auth";

export default async function SignInPage() {
  if (await currentUser()) redirect("/");

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-accent/60 via-background to-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg">SEO Article Generator</CardTitle>
          <CardDescription>
            Sign in with your agency Google account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <Button type="submit" className="w-full">
              Continue with Google
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
