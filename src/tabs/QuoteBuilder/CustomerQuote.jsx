import React from 'react';
import { money } from '../../lib/format.js';
import { printableRentalLines } from '../../lib/rental.js';

// The customer's proposal — legacy generateCustomerQuote (index.html:8915-9135).
//
// This is the only thing in the app a customer ever sees, so it says what they are
// buying and what it costs, and nothing about margin, cost or markup. Every internal
// figure on the Margin & RMR panel is deliberately absent.
//
// TWO RULES CAME FROM SEAN'S CHANGE OF 14 SEP 2026 (main af1427c), and they are the
// reason a subcontractor or a rental was invisible on a monitoring quote before:
//
//   1. THE ONE-TIME BOX APPEARS WHENEVER THERE IS ONE-TIME WORK, not only when there
//      are material lines (:8915-8920). An RMR quote whose only one-time cost was a
//      subcontractor or a lift printed nothing at all — the work was quoted, priced
//      and then left off the page the customer signs.
//
//   2. THE HEADINGS CHANGE when there are no material lines (:9075-9086):
//      "Installation Labor/Materials — One-Time" becomes "One-Time Costs", and
//      "One-Time Labor/Material Total" becomes "One-Time Total". Naming a section
//      after materials it does not contain is how a reader decides the number is
//      wrong.

function Line({ name, amount, indent }) {
  return (
    <div className="cq-line" style={indent ? { paddingLeft: '1rem' } : undefined}>
      <span>{name}</span>
      <span className="cq-amt">{money(amount)}</span>
    </div>
  );
}

function Group({ title, children }) {
  return (
    <>
      <div className="cq-group">{title}</div>
      {children}
    </>
  );
}

export default function CustomerQuote({
  customer, site, details, systemType, siteType,
  quote, monthlyBilled, work, charges, onClose,
}) {
  const oneTime = work.totals(charges);
  const materials = work.priced.filter((i) => i.type === 'material');
  const labour = work.priced.filter((i) => i.type === 'labor');
  const rentalLines = printableRentalLines(work.rentalTotals);
  const subLines = work.tmSub.lines.filter((l) => l.billTo !== 'internal' && l.cost > 0);

  // Rule 1. Not `materials.length > 0`.
  const hasOneTime = materials.length > 0 || labour.length > 0
    || subLines.length > 0 || rentalLines.length > 0 || oneTime.total > 0;

  // Rule 2.
  const heading = materials.length > 0 ? 'Installation Labor/Materials — One-Time' : 'One-Time Costs';
  const totalLabel = materials.length > 0 ? 'One-Time Labor/Material Total' : 'One-Time Total';

  const recurring = monthlyBilled > 0;

  return (
    <div className="cq-backdrop" role="dialog" aria-modal="true" aria-label="Customer quote">
      <div className="cq-sheet">
        <div className="cq-actions">
          <button type="button" onClick={() => window.print()}>Print / Save as PDF</button>
          <button type="button" onClick={onClose}>Close</button>
        </div>

        <div className="cq-doc" id="customer-quote">
          <header className="cq-head">
            <div>
              <div className="cq-brand">Point 1</div>
              <div className="cq-sub">Service &amp; Monitoring Proposal</div>
            </div>
            <div className="cq-meta">
              {details.estimateNumber && <div>Estimate #{details.estimateNumber}</div>}
              <div>{new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
              {details.estimatorName && <div>{details.estimatorName}</div>}
              {details.estimatorEmail && <div>{details.estimatorEmail}</div>}
            </div>
          </header>

          <section className="cq-party">
            <div>
              <div className="cq-group">Prepared for</div>
              <div>{customer.companyName || '—'}</div>
              {customer.contactName && <div>{customer.contactName}</div>}
              {customer.phone && <div>{customer.phone}</div>}
              {customer.email && <div>{customer.email}</div>}
            </div>
            <div>
              <div className="cq-group">Site</div>
              <div>{site.address || '—'}</div>
              <div>{[site.city, site.state, site.zip].filter(Boolean).join(', ')}</div>
              {systemType && <div style={{ marginTop: '0.4rem' }}>{systemType}{siteType ? ` · ${siteType}` : ''}</div>}
            </div>
          </section>

          {details.agreementName && <h2 className="cq-title">{details.agreementName}</h2>}

          {recurring && (
            <section className="cq-box">
              <div className="cq-box-head">Monitoring &amp; Services — Monthly</div>
              <Line name="Monthly service rate" amount={monthlyBilled} />
              <div className="cq-total">
                <span>Annual</span>
                <span className="cq-amt">{money(monthlyBilled * 12)}</span>
              </div>
            </section>
          )}

          {hasOneTime && (
            <section className="cq-box">
              <div className="cq-box-head">{heading}</div>

              {labour.length > 0 && (
                <Group title="Labor">
                  {labour.map((l, i) => (
                    <Line key={i} indent name={`${l.desc}${l.hrs ? ` (${l.hrs} hrs)` : ''}`} amount={l.totalSell} />
                  ))}
                </Group>
              )}

              {materials.length > 0 && (
                <Group title="Materials">
                  {materials.map((m, i) => (
                    <Line key={i} indent name={`${m.desc}${m.qty ? ` (${m.qty} ${m.unit})` : ''}`} amount={m.totalSell} />
                  ))}
                </Group>
              )}

              {/* A subcontracted line billed internally is absorbed, not charged, so it
                  must not appear on something the customer signs. */}
              {subLines.length > 0 && (
                <Group title="Point 1 Provided LSP/Subcontractor">
                  {subLines.map((l, i) => (
                    <Line key={i} indent name={l.desc || 'Subcontracted work'} amount={l.billed} />
                  ))}
                </Group>
              )}

              {rentalLines.length > 0 && (
                <Group title="Rental Equipment">
                  {rentalLines.map((l, i) => (
                    <Line key={i} indent
                      name={`${l.desc || 'Rental Equipment'}${l.qty ? ` (${l.qty} × ${l.unit})` : ''}`}
                      amount={l.billed} />
                  ))}
                  {work.rentalTotals.delivery > 0 && (
                    <Line indent name="Pickup / drop-off" amount={work.rentalTotals.deliveryBilled} />
                  )}
                </Group>
              )}

              {oneTime.shippingBilled > 0 && <Line name="Shipping &amp; handling" amount={oneTime.shippingBilled} />}
              {oneTime.materialTax > 0 && <Line name="Sales tax (materials)" amount={oneTime.materialTax} />}

              <div className="cq-total">
                <span>{totalLabel}</span>
                <span className="cq-amt">{money(oneTime.total)}</span>
              </div>
            </section>
          )}

          {quote?.rmrEff > 0 && !recurring && (
            <section className="cq-box">
              <div className="cq-box-head">Monitoring &amp; Services — Monthly</div>
              <Line name="Recommended monthly rate" amount={quote.rmrEff} />
            </section>
          )}

          <footer className="cq-foot">
            <p>
              Pricing is valid for 30 days from the date above. Monthly service begins on system
              acceptance. One-time charges are invoiced on completion unless otherwise agreed.
            </p>
            {details.billing?.address && (
              <p>
                Billing: {details.billing.address},{' '}
                {[details.billing.city, details.billing.state, details.billing.zip].filter(Boolean).join(', ')}
              </p>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}
