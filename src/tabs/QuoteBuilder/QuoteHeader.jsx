import React, { useRef, useState } from 'react';

// Quote header actions — the legacy's hdr-* buttons and the .p1est import.
//
// Clear-all and clear-systems are DESTRUCTIVE and were one-click in the legacy
// (onclick="clearForm()"). Losing an hour of estimating to a misplaced click is a
// real failure mode, so both confirm. That is a deliberate departure: everything
// else here is ported as-is, and this is the one place where matching the legacy
// exactly would preserve a hazard rather than a behaviour.

export default function QuoteHeader({ onClearAll, onClearSystems, onPrint, onImport }) {
  const fileRef = useRef(null);
  const [confirming, setConfirming] = useState('');

  const ask = (what, run) => {
    if (confirming === what) {
      setConfirming('');
      run();
    } else {
      setConfirming(what);
      // Reverts on its own, so a half-pressed confirmation does not sit armed
      // waiting for an unrelated click later.
      setTimeout(() => setConfirming((c) => (c === what ? '' : c)), 4000);
    }
  };

  const pick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        onImport(JSON.parse(String(reader.result)));
      } catch {
        // A .p1est is JSON. Anything else is almost always the wrong file rather
        // than a corrupt one, so say which.
        alert('That file could not be read as an estimate. Choose a .p1est file exported from this tool.');
      }
    };
    reader.readAsText(file);
    // Cleared so re-picking the same file fires change again.
    e.target.value = '';
  };

  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.8rem' }}>
      <button type="button" onClick={onPrint}>Customer quote</button>

      <button type="button" onClick={() => fileRef.current?.click()}>Import .p1est</button>
      {/* The team has months of estimates on OneDrive; being able to open them is the
          biggest single reason to adopt this tool over the old page. */}
      <input ref={fileRef} type="file" accept=".p1est,application/json"
        onChange={pick} style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />

      <span style={{ marginLeft: 'auto' }} />

      <button type="button" onClick={() => ask('systems', onClearSystems)}
        aria-live="polite">
        {confirming === 'systems' ? 'Clear systems — click again' : 'Clear systems'}
      </button>
      <button type="button" onClick={() => ask('all', onClearAll)}
        aria-live="polite">
        {confirming === 'all' ? 'Clear everything — click again' : 'Clear all'}
      </button>
    </div>
  );
}
