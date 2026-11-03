import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "@base-ui/react/menu";

vi.mock("@clerk/nextjs", () => ({ useUser: () => ({ user: null }), useClerk: () => ({ signOut() {} }) }));

const { AdminItem } = await import("./AccountMenu");

describe("AdminItem", () => {
  it("is a checkbox item of the menu, so the keyboard can reach and toggle it", () => {
    const html = renderToStaticMarkup(createElement(Menu.Root, { defaultOpen: true }, createElement(AdminItem)));
    expect(html).toMatch(/role="menuitemcheckbox"[^>]*aria-checked="false"/);
    expect(html).toContain("Admin");
    expect(html).not.toContain("<input");
  });
});
