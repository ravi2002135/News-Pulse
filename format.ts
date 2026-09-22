/**
 * Colour is the load-bearing signal in this interface: hue means *source*, so
 * a bar's ticks show at a glance which outlets covered a story and when. The
 * palette is assigned deterministically from the sorted source list, so a given
 * outlet keeps the same hue across reloads and across every component.
 */
const PALETTE = [
  '#1F6FB2', // signal blue
  '#A63D40', // brick
  '#3F7A56', // moss
  '#7A5AA3', // iris
  '#B07B16', // ochre
  '#2C7C8C', // teal
];

export function sourceColors(sources: string[]): Record<string, string> {
  const sorted = [...new Set(sources)].sort((a, b) => a.localeCompare(b));
  return Object.fromEntries(sorted.map((s, i) => [s, PALETTE[i % PALETTE.length]]));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Axis labels: show the weekday only when the tick crosses into a new day. */
export function axisLabel(iso: string, previous?: string): string {
  const d = new Date(iso);
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const newDay = !previous || new Date(previous).getDate() !== d.getDate();
  if (!newDay) return hhmm;
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${weekday} ${d.getDate()}`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(iso: string): string {
  const diffMinutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const hours = Math.round(diffMinutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function duration(hours: number): string {
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)} hr`;
  return `${Math.round(hours / 24)} days`;
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
