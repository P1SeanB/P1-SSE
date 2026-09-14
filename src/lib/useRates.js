import { useEffect, useState } from 'react';
import { fetchRates } from '../api-client/rates.js';

// Loads the active RateProfile once the user is authenticated.
// Shape mirrors the old P1_RATES object so calc logic ported from
// legacy/index.html can keep reading the same field names.
//
// LOADING IS "NOT SETTLED YET", not a flag someone remembers to set.
//
// It used to be `useState(enabled)`, which captures `enabled` on the FIRST render —
// false, because the user is not known yet. When auth resolved and `enabled` flipped
// true, React rendered once more before the effect ran: loading false, error null,
// rates still null. Every tab was handed `rates = null` for that one frame.
//
// Nothing noticed for months because every read was written `rates?.labor`. The frame
// a plain `rates.adc` was added, the app went blank on load — a white screen from a
// race that had been there all along, in a hook nobody had changed.
export function useRates(enabled) {
  const [state, setState] = useState({ rates: null, error: null, settled: false });

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    setState((s) => (s.settled ? { ...s, settled: false } : s));
    fetchRates()
      .then((rates) => live && setState({ rates, error: null, settled: true }))
      .catch((e) => live && setState({ rates: null, error: e.message || 'Could not load rates.', settled: true }));
    // A tab switch or a sign-out mid-flight must not resolve into a unmounted tree.
    return () => { live = false; };
  }, [enabled]);

  return {
    rates: state.rates,
    // Derived, so there is no window where "not loading" and "no rates" are both true.
    loading: !!enabled && !state.settled,
    error: state.error,
  };
}
