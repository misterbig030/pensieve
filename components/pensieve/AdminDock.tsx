import { auth } from "@clerk/nextjs/server";
import { isAdminUserId } from "@/lib/admin";
import { ModelCallsDock } from "@/components/pensieve/ModelCallsDock";

/**
 * The one model-calls dock for the whole app, mounted by `PageShell`. The server decides here who gets it: nothing
 * of the dock reaches a non-admin's HTML, and the client switch only shows or hides what the server already allowed.
 */
export async function AdminDock() {
  const { userId } = await auth();
  if (!isAdminUserId(userId)) return null;
  return <ModelCallsDock />;
}
