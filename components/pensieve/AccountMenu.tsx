"use client";

import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { Menu } from "@base-ui/react/menu";
import { AdminToggle } from "@/components/pensieve/AdminToggle";

const itemClass = "flex w-full cursor-default items-center rounded-lg px-2.5 py-1.5 text-[13px] outline-none select-none data-highlighted:bg-accent-100";

function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "?" : parts.slice(0, 2).map((p) => p[0].toUpperCase()).join("");
}

/** The avatar at the right of the top bar: settings, the admin switch for staff, and sign out. */
export function AccountMenu({ admin }: { admin: boolean }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="Account" className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent-200 text-[11px] font-semibold text-accent-800 outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {user?.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a 28px avatar from Clerk's CDN; next/image would need its host configured
          <img src={user.imageUrl} alt="" className="size-full object-cover" />
        ) : (
          initials(user?.fullName)
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={8} className="isolate z-50">
          <Menu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            <Menu.LinkItem className={itemClass} render={<Link href="/settings" />}>
              Settings
            </Menu.LinkItem>
            {admin && (
              <Menu.Item closeOnClick={false} className="flex px-1.5 py-1 outline-none">
                <AdminToggle />
              </Menu.Item>
            )}
            <Menu.Item className={itemClass} onClick={() => void signOut({ redirectUrl: "/sign-in" })}>
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
