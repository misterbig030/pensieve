"use client";

import { Component, type ReactNode } from "react";
import { ModelCallsPanel } from "@/components/pensieve/ModelCallsPanel";
import { useAdminMode, writeAdminMode } from "@/lib/adminMode";
import { STORAGE_KEY, clearModelCalls, useModelCalls } from "@/lib/modelCalls";

/**
 * The dock sits on every page, so a fault inside the panel must never take the page with it: this boundary renders
 * nothing instead and says in the console how to recover.
 */
class DockBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[admin dock] the model-calls panel failed to render and is hidden. To recover, run sessionStorage.removeItem("${STORAGE_KEY}") and reload.`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The admin's switch and the tab's store, joined: the panel renders when the switch is on, from the shared list. */
export function ModelCallsDock() {
  const on = useAdminMode();
  const calls = useModelCalls();
  if (!on) return null;
  return (
    <DockBoundary>
      <ModelCallsPanel calls={calls} onClear={clearModelCalls} onClose={() => writeAdminMode(false)} />
    </DockBoundary>
  );
}
