# Warm Visual Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved warm/editorial color palette and serif heading font across the whole Pensieve app via global CSS tokens, plus round the button component into a pill shape.

**Architecture:** This is a pure styling change — no new pages, no data model, no business logic. It touches `app/globals.css` (design tokens), `components/ui/button.tsx` (pill shape), and adds a `font-heading` class to the existing `<h1>` elements across 5 page files. All pages already consume the shared `--background`/`--card`/`--primary`/etc. tokens via Tailwind's `@theme inline` mapping, so most of the visual change is automatic once the token values change.

**Tech Stack:** Tailwind CSS v4 (`@theme inline` token mapping), shadcn/ui (base-ui flavor).

## Global Constraints

- Light-mode tokens only — this app has no dark mode toggle wired up; the `.dark` class block in `globals.css` is currently unused dead code from the shadcn scaffold and is out of scope to change or remove.
- No component file should have its `data-slot`/structural markup changed — only class strings (rounding, color token usage) and CSS variable values.
- Every existing page must still render with no new TypeScript errors (`npx tsc --noEmit` clean) after the change.

---

### Task 1: Apply warm theme tokens, heading font, and pill buttons

**Files:**
- Modify: `app/globals.css`
- Modify: `components/ui/button.tsx`
- Modify: `app/dashboard/page.tsx:21`
- Modify: `app/tracks/[id]/page.tsx:25`
- Modify: `app/tracks/[id]/adjust/page.tsx:11`
- Modify: `app/tracks/[id]/day/[dayIndex]/page.tsx:36`
- Modify: `app/tracks/new/page.tsx:51,59`

**Interfaces:** None — this task has no exported functions/types. It only changes CSS custom property values and Tailwind utility class strings.

- [ ] **Step 1: Replace the `:root` color tokens in `app/globals.css` with the warm palette**

Replace the existing `:root { ... }` block's color-related lines (keep `--radius`, `--chart-*`, and `--sidebar-*` lines unchanged since charts/sidebar aren't used anywhere in this app yet) with:

```css
  --background: #F4EFE4;
  --foreground: #2E2A22;
  --card: #FBF6EC;
  --card-foreground: #2E2A22;
  --popover: #FBF6EC;
  --popover-foreground: #2E2A22;
  --primary: #C0674A;
  --primary-foreground: #FBF3E9;
  --secondary: #F0E3CB;
  --secondary-foreground: #2E2A22;
  --muted: #F0E3CB;
  --muted-foreground: #6B6555;
  --accent: #F0E3CB;
  --accent-foreground: #2E2A22;
  --destructive: oklch(0.577 0.245 27.325);
  --border: #E7DCC5;
  --input: #E7DCC5;
  --ring: #C0674A;
```

(`--destructive` is left as the original oklch red — it's only used for error states, which aren't part of this palette change.)

- [ ] **Step 2: Add a serif heading font variable and wire it into the `@theme inline` mapping**

In the `:root` block, add one new line (anywhere among the other custom properties):

```css
  --font-serif-heading: Georgia, 'Noto Serif SC', serif;
```

In the `@theme inline { ... }` block near the top of the file, change this existing line:

```css
  --font-heading: var(--font-sans);
```

to:

```css
  --font-heading: var(--font-serif-heading);
```

This makes Tailwind generate a `font-heading` utility class that resolves to the serif stack.

- [ ] **Step 3: Add `font-heading` to every page's `<h1>`**

In each of these 5 files, change the `<h1>` element's `className` from `"text-xl font-semibold"` to `"text-xl font-heading font-semibold"` (keep every other class and the element's text content exactly as it is — this is a className-only edit):

- `app/dashboard/page.tsx:21`
- `app/tracks/[id]/page.tsx:25`
- `app/tracks/[id]/adjust/page.tsx:11`
- `app/tracks/[id]/day/[dayIndex]/page.tsx:36`
- `app/tracks/new/page.tsx:51` and `app/tracks/new/page.tsx:59` (two separate `<h1>` elements in this file — both get the class added)

- [ ] **Step 4: Make the default button shape a pill**

Read `components/ui/button.tsx` first to see the current full file (the base class string and every size variant use `rounded-lg` or a `rounded-[min(var(--radius-md),Npx)]` expression). Change every `rounded-lg` and every `rounded-[min(var(--radius-md),Npx)]` occurrence in this file to `rounded-full`, including inside the `in-data-[slot=button-group]:rounded-lg` modifier segments (those become `in-data-[slot=button-group]:rounded-full`). Do not change anything else in the file (icon sizes, padding, colors, variant names) — this is a rounding-only edit across all size variants so every button (default, xs, sm, icon) is consistently a pill regardless of which size a page uses.

- [ ] **Step 5: Verify the app still compiles**

Run: `npx tsc --noEmit`
Expected: no errors (this is a CSS + className change, should not affect types, but confirms nothing was accidentally broken while editing the `.tsx` files).

- [ ] **Step 6: Visual check**

Run `npm run dev`, and view at least the sign-in page (`/sign-in`, doesn't require auth) to confirm the warm background/card colors and serif-free UI chrome are visually applied (the sign-in page itself is a Clerk-hosted component and won't pick up the serif heading, but the page background around it should show the new `--background` color). If you have browser automation available, take a screenshot; otherwise ask the human partner to check `/dashboard`, `/tracks/new`, and a track detail page in their own browser after signing in, since those are the pages with the `<h1>` serif heading and the visible button/card styling this task changed.

- [ ] **Step 7: Commit**

```bash
git add app/globals.css components/ui/button.tsx app/dashboard/page.tsx app/tracks/[id]/page.tsx app/tracks/[id]/adjust/page.tsx "app/tracks/[id]/day/[dayIndex]/page.tsx" app/tracks/new/page.tsx
git commit -m "style: apply warm editorial visual theme across the app"
```

---

## Self-Review Notes

- **Spec coverage:** design doc's token table (background/card/foreground/muted-foreground/primary/primary-foreground/border/muted) is fully covered by Step 1; serif heading font by Step 2-3; pill buttons by Step 4; card rounding and badge pill-shape were already satisfied by the existing `rounded-xl`/`rounded-4xl` classes in `card.tsx`/`badge.tsx` and need no change (verified by reading those files during planning — noted here instead of adding a no-op step).
- **No placeholders:** every step names exact files, exact class strings, and exact CSS values.
- **Scope:** single task, no new abstractions, no dependency changes.
