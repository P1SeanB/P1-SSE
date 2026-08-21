import { useEffect, useState } from 'react';
import { fetchRates } from '../api-client/rates.js';

// Loads the active RateProfile once the user is authenticated.
// Shape mirrors the old P1_RATES object so calc logic ported from
// legacy/index.html can keep reading the same field names.
export function useRates(enabled) {
  const [rates, setRates] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    fetchRates()
      .then(setRates)
      .catch((e) => setError(e.message || 'Could not load rates.'))
      .finally(() => setLoading(false));
  }, [enabled]);

  return { rates, loading, error };
}
