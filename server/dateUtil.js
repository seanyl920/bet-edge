// Local-calendar-day helper, shared by anything that needs "what US date is
// this," not "what UTC date is this." UTC's day boundary lands at 7-8pm US
// Eastern (depending on DST) — the middle of a real evening sports slate —
// so naive `.toISOString().slice(0,10)` reliably gets the wrong day for
// anything after roughly dinnertime. Bit this app twice already: the daily
// parlay's "once per day" rollover, and postmortem grading permanently
// stuck on "not final yet" for evening games (see README's Known-issue
// history). Hardcoded to America/New_York since that's this app's actual
// usage — change DEFAULT_TIMEZONE if you're betting from elsewhere.

const DEFAULT_TIMEZONE = "America/New_York";

/** YYYY-MM-DD for a Date/ISO-string/timestamp, in a specific local timezone — not UTC. */
export function localDateKey(input = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  // en-CA formats as YYYY-MM-DD, which is the ISO order without needing to
  // hand-assemble it from separate year/month/day parts.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
