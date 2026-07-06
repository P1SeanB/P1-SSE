export function money(v) {
  return '$' + (Number(v) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pct(v) {
  return Math.round((Number(v) || 0) * 100) + '%';
}

export function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
