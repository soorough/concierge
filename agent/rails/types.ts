export type RailLevel = 'pass' | 'warn' | 'block';

export type RailEvent = { level: RailLevel; code: string; detail?: string };

export type PreRailResult =
  | { halt: false }
  | { halt: true; reply: string | null; events: RailEvent[] };
