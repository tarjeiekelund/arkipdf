// Versjonsnumre (egen fil, så den kan testes uten nettleser).

/** Sammenligner versjonsnumre som «0.10.1» og «v0.9.0». Positiv når a er nyere. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
