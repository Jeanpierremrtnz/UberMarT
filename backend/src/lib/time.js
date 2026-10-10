export const EC_TIMEZONE = 'America/Guayaquil';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: EC_TIMEZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Día ISO (1=lunes..7=domingo) y minutos desde medianoche en hora de Ecuador. */
export function ecuadorLocalTime(date = new Date()) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    isoWeekday: WEEKDAYS[parts.weekday],
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** "07:15" o "07:15:00" -> 435 */
export function parseClock(value) {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9])?$/.exec(String(value));
  if (!m) throw new Error(`Hora inválida: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
