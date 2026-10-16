"use client";

import { ModelCallsPanel } from "@/components/pensieve/ModelCallsPanel";
import { useAdminMode, writeAdminMode } from "@/lib/adminMode";
import { clearModelCalls, useModelCalls } from "@/lib/modelCalls";

/** The admin's switch and the tab's store, joined: the panel renders when the switch is on, from the shared list. */
export function ModelCallsDock() {
  const on = useAdminMode();
  const calls = useModelCalls();
  if (!on) return null;
  return <ModelCallsPanel calls={calls} onClear={clearModelCalls} onClose={() => writeAdminMode(false)} />;
}
