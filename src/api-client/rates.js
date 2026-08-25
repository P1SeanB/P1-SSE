// Replaces the old Supabase `app_rates` read with the SWA-authenticated /api/rates function.
import { shapeRates } from './shape-rates.js';

export async function fetchRates() {
  const res = await fetch('/api/rates');
  if (!res.ok) {
    throw new Error('Failed to load rates (' + res.status + ')');
  }
  // SHAPED HERE, not by the callers. The API speaks PostgreSQL column names and the
  // pricing code speaks the legacy config's names; translating at this one seam is
  // what stops a component quietly reading `labor.OverheadRate` off an object that
  // only has `overhead_rate` and falling back to a development default.
  // See shape-rates.js for what that cost before it existed.
  return shapeRates(await res.json());
}
