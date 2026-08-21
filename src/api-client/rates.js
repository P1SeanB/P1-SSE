// Replaces the old Supabase `app_rates` read with the SWA-authenticated /api/rates function.
export async function fetchRates() {
  const res = await fetch('/api/rates');
  if (!res.ok) {
    throw new Error('Failed to load rates (' + res.status + ')');
  }
  return res.json();
}
