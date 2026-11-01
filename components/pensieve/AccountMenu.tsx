"use client";

import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { Menu } from "@base-ui/react/menu";
import { useAdminMode, writeAdminMode } from "@/lib/adminMode";
import { cn } from "@/lib/utils";

const itemClass = "flex w-full cursor-default items-center rounded-lg px-2.5 py-1.5 text-[13px] outline-none select-none data-highlighted:bg-accent-100";

function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "?" : parts.slice(0, 2).map((p) => p[0].toUpperCase()).join("");
}

/**
 * The staff-only admin switch, a checkbox item of the menu so arrow keys reach it and Enter or Space flips it. The menu
 * stays open so the switch is seen to move. The server never trusts its state on its own.
 */
export function AdminItem() {
  const on = useAdminMode();
  return (
    <Menu.CheckboxItem
      checked={on}
      onCheckedChange={writeAdminMode}
      closeOnClick={false}
      className="group flex px-1.5 py-1 outline-none select-none"
    >
      <span
        className={cn(
          "inline-flex cursor-pointer items-center gap-2 rounded-full py-1.5 pr-1.5 pl-3 text-[12.5px] font-semibold group-data-highlighted:ring-2 group-data-highlighted:ring-ring/50",
          on ? "border border-primary bg-accent-100 text-accent-700" : "border border-dashed border-neutral-400 text-neutral-700",
        )}
      >
        Admin
        <span className={cn("relative block h-5 w-9 rounded-full transition-colors", on ? "bg-primary" : "bg-neutral-400")}>
          <span className={cn("absolute top-0.5 left-0.5 block size-4 rounded-full bg-background transition-transform", on && "translate-x-4")} />
        </span>
      </span>
    </Menu.CheckboxItem>
  );
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
            {admin && <AdminItem />}
            <Menu.Item className={itemClass} onClick={() => void signOut({ redirectUrl: "/sign-in" })}>
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
