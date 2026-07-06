import React, { createContext, useContext, useState } from 'react';

// Cross-tab shared state. In the legacy tool the Quote Builder and Monitoring
// Contracts tabs live-synced customer info + sites through the DOM
// (legacy/index.html "LIVE-SYNCED WITH MONITORING CONTRACTS" note, :1433).
// Here they share one context instead.

const AppStateCtx = createContext(null);

let siteSeq = 1;

export function newSite(partial = {}) {
  return {
    id: 's' + siteSeq++,
    address: '',
    city: '',
    state: '',
    zip: '',
    monthlyRate: '',
    ...partial,
  };
}

export function AppStateProvider({ children }) {
  const [customer, setCustomer] = useState({
    companyName: '',
    contactName: '',
    phone: '',
    email: '',
    billSameAsSite1: true,
    billAddr: '', billCity: '', billState: '', billZip: '',
  });
  // Site 1 is the primary address on the Quote Builder; extra sites are shared.
  const [sites, setSites] = useState([newSite()]);

  const updateCustomer = (patch) => setCustomer((c) => ({ ...c, ...patch }));
  const updateSite = (id, patch) =>
    setSites((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const addSite = () => setSites((list) => [...list, newSite()]);
  const removeSite = (id) => setSites((list) => (list.length > 1 ? list.filter((s) => s.id !== id) : list));

  // Manual quoted monthly = Σ per-site monthly rates (legacy qbQuotedMonthlyTotal)
  const quotedMonthlyTotal = sites.reduce((sum, s) => sum + (parseFloat(s.monthlyRate) || 0), 0);

  const value = {
    customer, updateCustomer,
    sites, updateSite, addSite, removeSite,
    quotedMonthlyTotal,
  };
  return <AppStateCtx.Provider value={value}>{children}</AppStateCtx.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateCtx);
  if (!ctx) throw new Error('useAppState must be used inside <AppStateProvider>');
  return ctx;
}

// US ZIP → city/state autofill, same public API the legacy tool used (:3494)
export async function lookupZip(zip) {
  const clean = (zip || '').replace(/\D/g, '').slice(0, 5);
  if (clean.length < 5) return null;
  try {
    const res = await fetch('https://api.zippopotam.us/us/' + clean);
    if (!res.ok) return null;
    const data = await res.json();
    const place = data.places?.[0];
    if (!place) return null;
    return { city: place['place name'], state: place['state abbreviation'] };
  } catch {
    return null;
  }
}
