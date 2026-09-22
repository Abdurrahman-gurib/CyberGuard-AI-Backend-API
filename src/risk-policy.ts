// Deterministic risk policy (dissertation §4.8 / §4.9).
// score = likelihood x impact; bands: 1-4 low, 5-9 medium, 10-16 high, 17-25 critical.
// An impact rating of 5 always triggers a consequence review flag (rule R02),
// regardless of the product.

export type Band = 'low' | 'medium' | 'high' | 'critical';

export function validateRating(value: any, field: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new Error(`${field} must be an integer between 1 and 5`);
  }
  return n;
}

export function calculateScore(likelihood: number, impact: number): number {
  return likelihood * impact;
}

export function calculateBand(score: number): Band {
  if (score >= 17) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

export function requiresConsequenceReview(impact: number): boolean {
  return impact === 5;
}

// Rule R03: an approved high or critical risk requires immediate treatment.
export function defaultPriorityForBand(band: Band): 'immediate' | 'scheduled' | 'longer_term' {
  if (band === 'high' || band === 'critical') return 'immediate';
  if (band === 'medium') return 'scheduled';
  return 'longer_term';
}
