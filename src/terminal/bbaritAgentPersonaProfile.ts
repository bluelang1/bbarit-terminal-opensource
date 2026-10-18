export interface BbaritPersonaEntry {
  id: string;
  division: string;
  name: string;
  emoji: string;
  description?: string;
  path?: string;
}

export interface BbaritPersonaProfile {
  id: string;
  name: string;
  face: string;
  job: string;
  division: string;
  description: string;
  stats: {
    build: number;
    review: number;
    design: number;
    safety: number;
    speed: number;
  };
}

const DIVISION_JOB: Record<string, string> = {
  engineering: 'Engineering Specialist',
  design: 'Design Specialist',
  'data-ai': 'AI/Data Specialist',
  'legal-finance': 'Legal/Finance Specialist',
  'real-estate-space': 'Space Specialist',
};

function clampStat(value: number): number {
  return Math.max(48, Math.min(98, Math.round(value)));
}

function hashText(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function personaStats(entry: Pick<BbaritPersonaEntry, 'id' | 'division'>): BbaritPersonaProfile['stats'] {
  const base = hashText(`${entry.division}:${entry.id}`);
  const stats = {
    build: 66 + (base % 23),
    review: 64 + ((base >> 2) % 24),
    design: 60 + ((base >> 4) % 26),
    safety: 62 + ((base >> 6) % 25),
    speed: 65 + ((base >> 8) % 24),
  };
  if (entry.division === 'engineering') stats.build += 8;
  if (entry.division === 'design') stats.design += 12;
  if (entry.division === 'data-ai') stats.build += 6;
  if (entry.id.includes('review') || entry.id.includes('qa')) stats.review += 12;
  if (entry.id.includes('security') || entry.id.includes('contract') || entry.id.includes('legal')) stats.safety += 10;
  if (entry.id.includes('performance') || entry.id.includes('automation')) stats.speed += 8;
  return {
    build: clampStat(stats.build),
    review: clampStat(stats.review),
    design: clampStat(stats.design),
    safety: clampStat(stats.safety),
    speed: clampStat(stats.speed),
  };
}

export function buildBbaritPersonaProfile(entry: BbaritPersonaEntry | undefined, fallbackId = ''): BbaritPersonaProfile | null {
  if (!entry && !fallbackId) return null;
  const id = entry?.id || fallbackId;
  const division = entry?.division || 'custom';
  return {
    id,
    name: entry?.name || id,
    face: entry?.emoji || 'AI',
    job: entry?.name || DIVISION_JOB[division] || 'Specialist',
    division,
    description: entry?.description || DIVISION_JOB[division] || 'Custom BBARIT Agent persona.',
    stats: personaStats({ id, division }),
  };
}

export function findBbaritPersonaProfile(personas: BbaritPersonaEntry[], id: string | undefined): BbaritPersonaProfile | null {
  const clean = (id || '').trim();
  if (!clean) return null;
  return buildBbaritPersonaProfile(personas.find((persona) => persona.id === clean), clean);
}

/** id별 전용 아이콘이 있는 페르소나 (public/persona-avatars/icons/individual/<id>.png) */
const INDIVIDUAL_PERSONA_ICONS = new Set(['anthropologist', 'geographer', 'historian', 'bbarit-secretary']);

const SHEET_ICON_COUNT = 36;

/**
 * 페르소나 아이콘 이미지 URL — 전용 아이콘이 있으면 그걸, 없으면 시트에서
 * id 해시로 결정적으로 하나를 고른다 (같은 페르소나는 항상 같은 아이콘).
 */
export function personaIconUrl(id: string | undefined): string {
  const clean = (id || '').trim();
  if (!clean) return '';
  if (INDIVIDUAL_PERSONA_ICONS.has(clean)) {
    return `/persona-avatars/icons/individual/${clean}.png`;
  }
  const n = (hashText(clean) % SHEET_ICON_COUNT) + 1;
  return `/persona-avatars/icons/sheet-04/bbarit-persona-icon-${String(n).padStart(3, '0')}.png`;
}
