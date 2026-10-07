// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The computer's time zone, or `undefined` when the runtime cannot tell. */
function localTimeZone(): string | undefined {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== "Etc/Unknown" ? zone : undefined;
  } catch {
    return undefined;
  }
}

function format(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone, timeZoneName: "short" } : { timeZone: "UTC" }),
  }).format(date);
}

/**
 * Readable label for a provider timestamp in the computer's local time, always
 * naming the zone (UTC when the local zone cannot be determined), or
 * `undefined` when the value is not unambiguous. Numbers are epoch
 * milliseconds, or seconds below 1e11 (any millisecond value that small
 * predates 1974). Strings must carry an explicit zone so a naive local time is
 * never silently shifted.
 */
export function formatTimestamp(value: unknown): string | undefined {
  const parsed =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? new Date(value < 1e11 ? value * 1000 : value)
      : typeof value === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
        ? new Date(value)
        : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) return undefined;
  const zone = localTimeZone();
  try {
    if (zone) return format(parsed, zone);
  } catch {
    // An unusable zone name falls back to UTC below.
  }
  return `${format(parsed, undefined)} UTC`;
}
