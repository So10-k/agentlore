const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  magenta: paint('35'),
  cyan: paint('36'),
};

export function human(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}

export const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

export function bar(frac, width = 20) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return c.cyan('█'.repeat(n)) + c.dim('░'.repeat(width - n));
}

const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
export const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - visible(s)));
export const padStart = (s, w) => ' '.repeat(Math.max(0, w - visible(s))) + s;

export function truncate(s, w) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > w ? s.slice(0, w - 1) + '…' : s;
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Single-quote a string for POSIX shells.
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
