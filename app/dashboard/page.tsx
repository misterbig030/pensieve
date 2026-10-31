import { redirect } from "next/navigation";

/** The home moved to `/`; old links and bookmarks land there. */
export default function DashboardPage() {
  redirect("/");
}
