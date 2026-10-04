// Local wall-clock time, and whether it falls inside the night window.

export type LocalTime = { hour: number; minute: number }

/** The time of day at `ms`, in `timeZone` (an IANA name) or else this machine's. */
export const localTime = (ms: number, timeZone?: string): LocalTime => {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(ms)
      const part = (type: string) => Number(parts.find(one => one.type === type)?.value)
      const time = { hour: part('hour') % 24, minute: part('minute') }
      if (Number.isInteger(time.hour) && Number.isInteger(time.minute)) return time
    } catch {
      // not a time zone this runtime knows: use the machine's
    }
  }
  const date = new Date(ms)

  return { hour: date.getHours(), minute: date.getMinutes() }
}

/** Minutes after midnight for "1", "01:00" or "1:30"; undefined for anything else. */
export const minutesOf = (text: string): number | undefined => {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text)
  const hour = Number(match?.[1])
  const minute = Number(match?.[2] ?? 0)

  return match && hour < 24 && minute < 60 ? hour * 60 + minute : undefined
}

/** Whether `time` is in [start, end), a window that may wrap past midnight. */
export const isBetween = (time: LocalTime, start: number, end: number): boolean => {
  const now = time.hour * 60 + time.minute

  return start <= end ? now >= start && now < end : now >= start || now < end
}

/** "05:00" */
export const clockText = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/** "2:41am" */
export const spoken = ({ hour, minute }: LocalTime): string =>
  `${hour % 12 || 12}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`
