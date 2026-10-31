// Known limitation: day boundaries here are UTC-based (see toISOString
// below), not the user's local calendar day. For a user in a non-UTC
// timezone, a check-in made late at night or early in the morning local
// time may be attributed to the "wrong" day, which can under- or
// over-count the streak near midnight UTC. This is acceptable for a
// single-user MVP that doesn't store a timezone preference; a proper fix
// would require adding a user timezone column and threading it through
// wherever `completedAt` is generated/queried, which is out of scope here.
export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeStreak(completedDates: Date[], today: Date = new Date()): number {
  if (completedDates.length === 0) return 0;

  const dayKeys = new Set(completedDates.map(dayKey));
  const todayKey = dayKey(today);

  const cursor = new Date(today);
  if (!dayKeys.has(todayKey)) {
    // No check-in today yet — the streak can still be "alive" if yesterday
    // has one; start counting from yesterday instead.
    cursor.setDate(cursor.getDate() - 1);
    if (!dayKeys.has(dayKey(cursor))) {
      return 0;
    }
  }

  let streak = 0;
  while (dayKeys.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

const DAY_MS = 86_400_000;

/** The longest run of consecutive UTC days with a check-in, ever. */
export function longestStreak(completedDates: Date[]): number {
  const days = [...new Set(completedDates.map(dayKey))].sort().map((key) => Date.parse(key));
  let longest = 0;
  let run = 0;
  days.forEach((day, i) => {
    run = i > 0 && day - days[i - 1] === DAY_MS ? run + 1 : 1;
    longest = Math.max(longest, run);
  });
  return longest;
}
