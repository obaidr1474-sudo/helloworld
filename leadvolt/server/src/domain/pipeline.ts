export const STAGES = ['new', 'contacted', 'meeting', 'site_visit', 'eoi', 'booked', 'lost'] as const;
export type Stage = (typeof STAGES)[number];

/** Funnel bucket per stage: 0 lead, 1 prospect, 2 opportunity, 3 booked, -1 closed lost. */
export const FUNNEL_BUCKET: Record<Stage, number> = { new: 0, contacted: 1, meeting: 1, site_visit: 2, eoi: 2, booked: 3, lost: -1 };

export type TaskType = 'call' | 'whatsapp' | 'meeting' | 'site_visit' | 'follow_up' | 'document' | 'custom';

export interface Disposition {
  key: string;
  label: string;
  stage: Stage;
  subStatuses: string[];
  requiresNextAction?: boolean;
  allowsNextAction?: boolean;
  requiresDealValue?: boolean;
  isLost?: boolean;
  taskType?: TaskType;
}

export const DISPOSITIONS: Disposition[] = [
  { key: 'callback', label: 'Callback', stage: 'contacted', subStatuses: ['Follow-up', 'Not reachable', 'Busy', 'WhatsApp sent'], requiresNextAction: true, taskType: 'call' },
  { key: 'meeting', label: 'Meeting', stage: 'meeting', subStatuses: ['Office', 'Online', 'Meeting done', 'Meeting not done'], requiresNextAction: true, taskType: 'meeting' },
  { key: 'site_visit', label: 'Site visit', stage: 'site_visit', subStatuses: ['Scheduled', 'Rescheduled', 'Visit done', 'Visit not done'], requiresNextAction: true, taskType: 'site_visit' },
  { key: 'eoi', label: 'EOI', stage: 'eoi', subStatuses: ['EOI received', 'Token paid'], requiresNextAction:true,taskType:'follow_up' },
  { key: 'booked', label: 'Booked', stage: 'booked', subStatuses: ['Pending approval', 'Approved', 'Invoiced'], requiresDealValue: true },
  { key: 'not_interested', label: 'Not interested', stage: 'lost', subStatuses: ['Budget mismatch', 'Location mismatch', 'Bought elsewhere', 'Just browsing', 'Timeline too far'], isLost: true },
  { key: 'drop', label: 'Drop', stage: 'lost', subStatuses: ['Invalid number', 'Duplicate', 'Agent / broker', 'Spam'], isLost: true },
];

export const dispositionByKey = (k: string) => DISPOSITIONS.find((d) => d.key === k);

/** Allowed stage transitions. Re-opening a lost lead is allowed (re-enquiry, recycled leads). */
const TRANSITIONS: Record<Stage, Stage[]> = {
  new: ['contacted', 'meeting', 'site_visit', 'eoi', 'booked', 'lost'],
  contacted: ['contacted', 'meeting', 'site_visit', 'eoi', 'booked', 'lost'],
  meeting: ['contacted', 'meeting', 'site_visit', 'eoi', 'booked', 'lost'],
  site_visit: ['contacted', 'meeting', 'site_visit', 'eoi', 'booked', 'lost'],
  eoi: ['contacted', 'meeting', 'site_visit', 'eoi', 'booked', 'lost'],
  booked: ['booked', 'lost'],
  lost: ['new', 'contacted', 'meeting', 'site_visit', 'lost'],
};

export function canTransition(from: Stage, to: Stage) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface DispositionInput {
  disposition: string;
  subStatus?: string;
  nextActionAt?: string | null;
  dealValue?: number | null;
}

/** Returns a user-facing error message or null when valid. */
export function validateDisposition(current: Stage, input: DispositionInput, now = new Date()): string | null {
  const d = dispositionByKey(input.disposition);
  if (!d) return `Unknown status "${input.disposition}".`;
  if (!canTransition(current, d.stage)) return `A ${current.replace('_', ' ')} lead cannot move to ${d.label}.`;
  if (input.subStatus && !d.subStatuses.includes(input.subStatus)) return `"${input.subStatus}" is not a valid option for ${d.label}.`;
  if(input.nextActionAt && Number.isNaN(new Date(input.nextActionAt).getTime())) return 'The next action date is not valid.';
  if (d.requiresNextAction) {
    if (!input.nextActionAt) return 'Set the next action date and time. Every active lead needs one.';
    const t = new Date(input.nextActionAt);
    if (Number.isNaN(t.getTime())) return 'The next action date is not valid.';
    if (t.getTime() < now.getTime() - 60_000) return 'The next action is in the past. Pick a future time.';
  }
  if (d.isLost && !input.subStatus) return 'Choose a reason for closing this lead.';
  if (d.requiresDealValue && !(Number(input.dealValue) > 0)) return 'Enter the deal value to mark this lead as booked.';
  return null;
}

export const isActiveStage = (s: Stage) => s !== 'lost' && s !== 'booked';
