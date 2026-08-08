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
