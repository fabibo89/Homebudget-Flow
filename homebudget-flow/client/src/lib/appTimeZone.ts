/** Entspricht APP_TIMEZONE auf dem Server (via /api/auth/me). */

const FALLBACK = 'Europe/Berlin';

let _tz = FALLBACK;

export function setAppTimeZone(tz: string | undefined | null): void {
  _tz = tz && String(tz).trim() ? String(tz).trim() : FALLBACK;
}

export function resetAppTimeZone(): void {
  _tz = FALLBACK;
}

export function getAppTimeZone(): string {
  return _tz;
}

/** Kalendertag „heute“ in der App-Zeitzone als YYYY-MM-DD. */
export function todayIsoInAppTimezone(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: getAppTimeZone() });
}

/** Ein `Date` als Kalendertag YYYY-MM-DD in der App-Zeitzone (für Diagramm-Achsen u. ä.). */
export function isoDateInAppTimezone(d: Date): string {
  return d.toLocaleDateString('sv-SE', { timeZone: getAppTimeZone() });
}
