import { describe, expect, it, vi } from "vitest";
import { installLeaveGuard } from "./leaveGuard";

type Listener = (event: never) => void;

/** A window or document that records its listeners, so a test can fire them. */
function target() {
  const listeners = new Map<string, { fn: Listener; capture: boolean }[]>();
  return {
    listeners,
    addEventListener: (type: string, fn: Listener, options?: boolean | AddEventListenerOptions) =>
      listeners.set(type, [...(listeners.get(type) ?? []), { fn, capture: options === true || (typeof options === "object" && !!options.capture) }]),
    removeEventListener: (type: string, fn: Listener) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l.fn !== fn)),
    fire: (type: string, event: object) => (listeners.get(type) ?? []).forEach((l) => l.fn(event as never)),
  };
}

const PAGE = "http://localhost:3001/tracks/new";

function link(href: string, attrs: Record<string, string> = {}) {
  const anchor = { href: new URL(href, PAGE).href, getAttribute: (name: string) => attrs[name] ?? null, hasAttribute: (name: string) => name in attrs };
  return { closest: (selector: string) => (selector === "a[href]" ? anchor : null) };
}

function click(on: object, overrides: Record<string, unknown> = {}) {
  return { target: on, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides };
}

function setup(answer: boolean) {
  const win = { ...target(), location: { href: PAGE } };
  const doc = target();
  const confirmLeave = vi.fn(() => answer);
  const remove = installLeaveGuard(win, doc, confirmLeave);
  return { win, doc, confirmLeave, remove };
}

describe("installLeaveGuard", () => {
  it("asks the browser to confirm closing, reloading or leaving the tab", () => {
    const { win } = setup(true);
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    win.fire("beforeunload", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe("");
  });

  it("asks before an in-app link leaves the page, and stops it when the learner stays", () => {
    const { doc, confirmLeave } = setup(false);
    expect(doc.listeners.get("click")?.[0].capture).toBe(true);
    const event = click(link("/dashboard"));
    doc.fire("click", event);
    expect(confirmLeave).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("lets the link through when the learner chooses to leave", () => {
    const { doc, confirmLeave } = setup(true);
    const event = click(link("/settings"));
    doc.fire("click", event);
    expect(confirmLeave).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("does not ask for clicks that keep this page open", () => {
    const { doc, confirmLeave } = setup(false);
    const kept = [
      click({ closest: () => null }),
      click(link("https://bytebytego.com/books"), {}),
      click(link("/dashboard", { target: "_blank" })),
      click(link("/notes.pdf", { download: "" })),
      click(link("#materials")),
      click(link("/dashboard"), { metaKey: true }),
      click(link("/dashboard"), { ctrlKey: true }),
      click(link("/dashboard"), { shiftKey: true }),
      click(link("/dashboard"), { button: 1 }),
      click(link("/dashboard"), { defaultPrevented: true }),
    ];
    for (const event of kept) doc.fire("click", event);
    // An external link in this tab still leaves the page, so it is the one click here that asks.
    expect(confirmLeave).toHaveBeenCalledTimes(1);
    expect(kept.filter((e) => e.preventDefault.mock.calls.length > 0)).toEqual([kept[1]]);
  });

  it("removes both listeners when the draft is saved or the page closes", () => {
    const { win, doc, remove } = setup(false);
    remove();
    expect(win.listeners.get("beforeunload")).toEqual([]);
    expect(doc.listeners.get("click")).toEqual([]);
  });
});
