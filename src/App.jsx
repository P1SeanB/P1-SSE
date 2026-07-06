import React, { useState } from 'react';
import { useAuth, loginUrl } from './auth/useAuth.js';
import { useRates } from './lib/useRates.js';
import { AppStateProvider } from './store/AppState.jsx';
import QuoteBuilder from './tabs/QuoteBuilder/QuoteBuilder.jsx';
import SlaCreator from './tabs/SlaCreator/SlaCreator.jsx';
import MonitoringContracts from './tabs/MonitoringContracts/MonitoringContracts.jsx';

const TABS = [
  { id: 'sse', label: 'Quote Builder', Component: QuoteBuilder },
  { id: 'sla', label: 'SLA Creator', Component: SlaCreator },
  { id: 'mc', label: 'Monitoring Contracts', Component: MonitoringContracts },
];

export default function App() {
  const { user, loading: authLoading } = useAuth();
  const { rates, loading: ratesLoading, error: ratesError } = useRates(!!user);
  const [activeTab, setActiveTab] = useState('sse');

  if (authLoading) return <div className="p1-boot">Checking sign-in...</div>;

  if (!user) {
    return (
      <div className="p1-boot">
        <p>Sign-in required.</p>
        <a href={loginUrl()}>Sign in with Microsoft</a>
      </div>
    );
  }

  if (ratesLoading) return <div className="p1-boot">Loading rates...</div>;
  if (ratesError) return <div className="p1-boot p1-boot-error">{ratesError}</div>;

  const Active = TABS.find((t) => t.id === activeTab)?.Component;

  return (
    <AppStateProvider>
    <div className="p1-app">
      <header className="p1-header">
        <div className="p1-logo">
          <span className="p1-logo-dot" />P1-SSE
        </div>
        <nav className="p1-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={'view-tab' + (activeTab === t.id ? ' active' : '')}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="p1-main">
        <Active rates={rates} user={user} />
      </main>
    </div>
    </AppStateProvider>
  );
}
