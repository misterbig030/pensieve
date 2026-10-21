# Study days per week

## Intent

A learner who studies five days a week gets a plan built on five-day weeks. Today every week is seven days, and days
are numbered across the whole plan, so Week 2 starts at Day 8. Because the learner gives their time weekly, the week
is the real unit: a plan is so many weeks long, and each week's days run Day 1 to Day N.

## What the learner sees (decided with the user, mockups in `.superpowers/brainstorm/`)

- **New-track form.** Length is in weeks: presets 1, 4, 8 and 12 weeks plus a custom number (1–52). Under the weekly
  hours, a "Days a week" row of round buttons 1–7 (default 5) with the hint "Your usual. You can pick a different
  number for any single week when you split it." The summary line reads "4 weeks at 6 h a week, over 5 days, is
  about 24 hours, about 1 h 10 min a day."
- **Time card.** The line "6 h a week · part time" adds the days: "6 h a week · 5 days a week · part time". Its Change
  panel gets the same 1–7 row; the hint says it applies to weeks split from now on and split weeks keep their days.
- **Week card.** "Split into days" becomes "Split into [5 ▾] days". The words split into the usual number in one
  click. The 5 is a soft tinted chip with a small chevron, the shape of the card's badges, darker on hover; it opens
  a short list of 1–7 days, each with its time per day ("3 days · 2 h a day", "5 days · usual"). Picking one splits
  this week only; the usual number is unchanged.
- **Day labels.** Days are numbered within their week: Week 2 holds Day 1–Day 5. Outside its week a day reads
  "Week 2 · Day 3".

## Model (builder's calls)

- `tracks.days_per_week` (int, 1–7). Existing tracks get 7, so their plans read as before apart from the numbering.
- `PlanNode.len` stays the unit's length in **study days** and `start`/`end` stay running study-day indices. They are
  internal (ordering, locking, progress) and are no longer shown as "Day 8–14".
- Every week is one week of the learner's time, whatever its day count. Time is measured in weeks:
  a week is 1; a day is 1 / (its week's day count), or 1 / days-per-week at the top level of a one-week plan;
  a month is its weeks (children when planned, otherwise `len / daysPerWeek`). A unit's budget is
  `weeks × hoursPerWeek`. For seven-day plans this reproduces today's budgets, except that a legacy 8-day week now
  budgets one week, not 8/7.
- Plan shape from the length in weeks: 1 week → its days at the top level; 2–10 weeks → weeks; more → months of
  about four weeks (`splitSpans(weeks, 4)`). Each unplanned week is `daysPerWeek` days long. Auto granularity is
  weeks above 8 weeks, days otherwise.
- Splitting a week takes a day count (1–7, default the usual); the week's `len` becomes that count.
- Changing the usual number re-lengths unplanned weeks and unplanned months (completed and locked units keep theirs);
  split weeks keep their days.
- Prompts state the plan in weeks and study days ("6 weeks, 5 study days a week"), list units as "Week 1 (5 study
  days)", and tell the reviser that an unplanned week has the usual number of days. The reviser's lengths are
  normalised the same way: an unplanned week keeps its length or takes the usual number, a month is whole weeks.

- On a saved track a week card is a link to the week's page. Its status row (status, sessions, the split control) sits
  outside that link, so the days list is not a control inside a link.
- Check messages and material uses name a day with its week ("Week 2 · Day 3"), since "Day 3" alone no longer says
  which week. The dashboard and track page count progress as "12 of 90 days complete".

## Not in scope

- Which weekdays are study days. The app shows Day 1 to Day N only.
- Re-splitting a week that is already split.
- Week numbering under months stays positional within the month, as today.
