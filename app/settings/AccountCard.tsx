"use client";

import { useClerk } from "@clerk/nextjs";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function AccountCard({ email }: { email: string | null }) {
  const { signOut } = useClerk();
  // Not useTransition: Clerk redirects in a transition of its own and resolves once it settles, which React holds back until an enclosing async transition ends.
  const [pending, setPending] = useState(false);
  const logOut = () => {
    setPending(true);
    signOut({ redirectUrl: "/sign-in" }).catch(() => setPending(false));
  };

  return (
    <div className="rounded-xl bg-card p-5 text-sm text-card-foreground ring-1 ring-foreground/10">
      <h3 className="font-heading text-[18px]">Account</h3>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2">
        <span>{email ? <>Signed in as {email}</> : "Signed in"}</span>
        <Button variant="secondary" disabled={pending} onClick={logOut}>
          {pending ? "Logging out…" : "Log out"}
        </Button>
      </div>
    </div>
  );
}
