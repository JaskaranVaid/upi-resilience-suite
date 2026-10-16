/** 97.5th percentile of the standard normal: two-sided 95% intervals. */
const Z95 = 1.959963984540054;

/**
 * Wilson score interval for x successes out of n (Newcombe 1998a, method 3). Unlike the textbook
 * p ± z·SE it stays inside [0, 1] and behaves at small n and at 0% or 100%. Null when n = 0.
 */
export function wilsonInterval(x: number, n: number, z = Z95): [number, number] | null {
  if (n === 0) return null;
  const p = x / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface DifferenceInterval {
  /** p1 − p2. */
  difference: number;
  low: number;
  high: number;
}

/**
 * 95% interval for the difference of two independent proportions, p1 − p2, by Newcombe's hybrid
 * score method (1998b, method 10): it combines the two Wilson intervals and keeps good coverage for
 * the small samples a canary produces. Null unless both groups have observations.
 */
export function differenceInterval(x1: number, n1: number, x2: number, n2: number, z = Z95): DifferenceInterval | null {
  const a = wilsonInterval(x1, n1, z);
  const b = wilsonInterval(x2, n2, z);
  if (!a || !b) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const d = p1 - p2;
  return {
    difference: d,
    low: d - Math.sqrt((p1 - a[0]) ** 2 + (b[1] - p2) ** 2),
    high: d + Math.sqrt((a[1] - p1) ** 2 + (p2 - b[0]) ** 2),
  };
}
