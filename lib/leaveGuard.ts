/** What the guard needs from `window` and `document`, so tests can pass small fakes. */
interface Listens {
  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions): void;
}

interface Anchor {
  href: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

interface Click {
  target: unknown;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * The link a click follows away from this page in this tab, or null when the page stays: not a link, a new tab or
 * window (modifier or middle click, `target="_blank"`), a download, a jump within the page, or a click already handled.
 */
function leavingLink(event: Click, here: string): Anchor | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target as { closest?: (selector: string) => Anchor | null } | null;
  const anchor = typeof target?.closest === "function" ? target.closest("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download")) return null;
  const opensElsewhere = anchor.getAttribute("target");
  if (opensElsewhere && opensElsewhere !== "_self") return null;
  const to = new URL(anchor.href, here);
  const from = new URL(here);
  if (to.origin === from.origin && to.pathname === from.pathname && to.search === from.search) return null;
  return anchor;
}

/**
 * Asks before the page is left while it holds unsaved work. Closing, reloading or typing a new address gets the
 * browser's own prompt (`beforeunload`); an in-app link never fires that, so a capture-phase click listener asks with
 * `confirmLeave` first and, when the learner stays, stops the click before the router sees it. The back button is not
 * covered: the router has already moved by the time it could ask. Returns the function that removes the guard.
 */
export function installLeaveGuard(win: Listens & { location: { href: string } }, doc: Listens, confirmLeave: () => boolean): () => void {
  const onBeforeUnload = (event: Event) => {
    event.preventDefault();
    // Older browsers show the prompt only when returnValue is set.
    (event as BeforeUnloadEvent).returnValue = "";
  };
  const onClick = (event: Event) => {
    if (!leavingLink(event as unknown as Click, win.location.href) || confirmLeave()) return;
    event.preventDefault();
    event.stopPropagation();
  };
  win.addEventListener("beforeunload", onBeforeUnload);
  doc.addEventListener("click", onClick, true);
  return () => {
    win.removeEventListener("beforeunload", onBeforeUnload);
    doc.removeEventListener("click", onClick, true);
  };
}
