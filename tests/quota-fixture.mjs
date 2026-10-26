export async function fixtureQuotaReader() {
  return {
    status: "ok",
    checked_at: "2026-10-18T00:00:00.000Z",
    five_hour: { remaining_percent: 100, resets_at: "2026-10-18T05:00:00.000Z" },
    weekly: { remaining_percent: 100, resets_at: "2026-10-25T00:00:00.000Z" },
  };
}
