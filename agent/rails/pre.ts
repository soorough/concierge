import { getDb } from '../../store/db.js';
import type { Customer } from '../../store/session.js';
import type { PreRailResult } from './types.js';

const STOP = /^\s*(stop|unsubscribe|cancel|end|quit|optout|opt out)\s*!?\s*$/i;
const START = /^\s*(start|unstop|subscribe)\s*!?\s*$/i;
const HELP = /^\s*(help|info)\s*!?\s*$/i;

const CONFIRM_STOP =
  'You have been unsubscribed and will not receive further messages. Reply START to resume.';
const CONFIRM_START = 'You are resubscribed. Reply STOP at any time to opt out.';
const HELP_TEXT =
  'This is an automated shopping assistant. Reply STOP to unsubscribe. For anything else, contact the store directly.';

/**
 * Rails that run before any model call. Compliance obligations get exact strings, not
 * probabilistic ones — an opt-out confirmation is a legal artifact, not a generation.
 */
export function runPreRails(customer: Customer, text: string): PreRailResult {
  const db = getDb();

  if (STOP.test(text)) {
    db.prepare('update customer set opted_out_at = ? where id = ?').run(Date.now(), customer.id);
    return {
      halt: true,
      reply: CONFIRM_STOP,
      events: [{ level: 'block', code: 'OPT_OUT', detail: 'STOP keyword — no model call' }],
    };
  }

  if (START.test(text)) {
    db.prepare('update customer set opted_out_at = null where id = ?').run(customer.id);
    return {
      halt: true,
      reply: CONFIRM_START,
      events: [{ level: 'pass', code: 'OPT_IN', detail: 'START keyword — no model call' }],
    };
  }

  if (HELP.test(text)) {
    return {
      halt: true,
      reply: HELP_TEXT,
      events: [{ level: 'pass', code: 'HELP', detail: 'fixed support string — no model call' }],
    };
  }

  if (customer.opted_out_at) {
    return {
      halt: true,
      reply: null,
      events: [{ level: 'block', code: 'OPTED_OUT', detail: 'customer opted out — dropped silently' }],
    };
  }

  return { halt: false };
}
