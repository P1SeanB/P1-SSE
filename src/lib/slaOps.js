// SLA operational requirements — the option sets behind the slaops-* section.
//
// Transcribed from legacy/index.html:12790-12812 (the SEL object). These are
// descriptive, not priced: they populate the language of the service agreement — who
// sets up a meeting, how fast someone answers remotely, what happens to spares — and
// they print on the document a customer signs.
//
// Kept as data rather than as markup for the same reason the pricing dropdowns are:
// the legacy built these <select> elements from a config object and the wording is
// contractual. A typo here is a typo in an agreement.
//
// 'Custom' appears in several sets and is meaningful — it means the printed clause
// is written by hand for this customer, so the UI must offer a free-text field
// alongside rather than treating it as just another value.

export const SLA_OPS_OPTIONS = {
  industry: [
    'Commercial', 'Municipality / Government', 'Education', 'Healthcare', 'Industrial',
    'Warehouse', 'Manufacturing', 'Financial', 'Data Center', 'Transportation',
  ],
  criticality: [
    'Standard', 'Business Critical', 'Mission Critical', 'Life Safety',
    'Public Meeting Critical', 'Custom',
  ],
  meetingInclude: [
    'No', 'Yes – Remote Support Only', 'Yes – Technician Standby',
    'Yes – Onsite Technician Coverage', 'Yes – Hybrid Remote / Onsite',
  ],
  scheduleSource: [
    'Customer-provided annual calendar', 'Customer-provided monthly calendar',
    'Recurring schedule', 'Manual entry', 'As requested / quoted separately',
  ],
  frequency: [
    '1 meeting per month', '2 meetings per month', '3 meetings per month',
    '4 meetings per month', 'Custom',
  ],
  duration: ['1 hour', '2 hours', '3 hours', '4 hours', '5 hours', 'Custom'],
  supportWindow: ['Setup only', 'First hour only', 'First two hours', 'Full meeting duration', 'Custom'],
  remoteResp: ['15 minutes', '30 minutes', '45 minutes', '60 minutes', 'Custom'],
  onsiteDispatch: [
    'Not included', 'Immediate dispatch', 'Within 30 minutes', 'Within 45 minutes',
    'Within 60 minutes', 'Custom', 'Quoted separately',
  ],
  remoteHands: [
    'Yes – Customer IT', 'Yes – Customer AV Operator', 'Yes – Third-party operator',
    'No', 'Unknown',
  ],
  remoteMethod: [
    'Phone support', 'Microsoft Teams', 'Zoom', 'VPN', 'TeamViewer', 'ScreenConnect',
    'Crestron remote access', 'Manufacturer portal', 'Other',
  ],
  setupBy: ['Customer', 'Customer IT', 'Third-party AV operator', 'Point 1', 'Shared responsibility', 'Not applicable'],
  checkBy: ['Customer', 'Customer IT', 'Third-party AV operator', 'Point 1', 'Shared responsibility', 'Not applicable'],
  p1Role: [
    'Preventive maintenance only', 'Remote escalation support', 'Technician standby',
    'Onsite operator support', 'Full meeting support', 'Custom',
  ],
  materialStrategy: [
    'Annual material allowance', 'Customer-owned hot spare inventory',
    'Point 1-managed hot spare inventory', 'Hybrid: material allowance + hot spares',
  ],
  auditFreq: ['Quarterly', 'Semi-annual', 'Annual', 'During PM visits', 'Custom'],
};

/** Sets offering 'Custom' need a free-text field beside them to be usable. */
export const allowsCustom = (key) => (SLA_OPS_OPTIONS[key] || []).includes('Custom');

/**
 * The meeting-support block only applies once meeting coverage is included at all —
 * the legacy hides it behind slaops-sec-meeting (:12800). Asking someone for a
 * remote response time on an agreement with no meeting coverage produces answers
 * that then print on the document.
 */
export const meetingCoverageIncluded = (meetingInclude) =>
  Boolean(meetingInclude) && meetingInclude !== 'No';

export const newSlaOps = () => ({
  industry: '', criticality: '', criticalityCustom: '',
  pmObjective: '', opRequirements: [],
  meetingInclude: 'No', scheduleSource: '', meetingTypes: [],
  frequency: '', frequencyCustom: '',
  duration: '', durationCustom: '',
  supportWindow: '', supportWindowCustom: '',
  remoteResp: '', remoteRespCustom: '',
  onsiteDispatch: '', onsiteDispatchCustom: '',
  remoteHands: '', remoteMethod: [],
  setupBy: '', checkBy: '', p1Role: '', p1RoleCustom: '',
  materialStrategy: '', hotSpare: [], auditFreq: '', auditFreqCustom: '',
  customerResponsibilities: [],
});
