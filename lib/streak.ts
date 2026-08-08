// Known limitation: day boundaries here are UTC-based (see toISOString
// below), not the user's local calendar day. For a user in a non-UTC
// timezone, a check-in made late at night or early in the morning local
// time may be attributed to the "wrong" day, which can under- or
// over-count the streak near midnight UTC. This is acceptable for a
// single-user MVP that doesn't store a timezone preference; a proper fix
// would require adding a user timezone column and threading it through
// wherever `completedAt` is generated/queried, which is out of scope here.
function toDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function computeStreak(completedDates: Date[], today: Date = new Date()): number {
  if (completedDates.length === 0) return 0;

  const dayKeys = new Set(completedDates.map(toDayKey));
  const todayKey = toDayKey(today);

  const cursor = new Date(today);
  if (!dayKeys.has(todayKey)) {
    // No check-in today yet — the streak can still be "alive" if yesterday
    // has one; start counting from yesterday instead.
    cursor.setDate(cursor.getDate() - 1);
    if (!dayKeys.has(toDayKey(cursor))) {
      return 0;
    }
  }

  let streak = 0;
  while (dayKeys.has(toDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}
