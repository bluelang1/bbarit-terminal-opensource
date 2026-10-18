import type { Skill } from './types';

// Andrej Karpathy-inspired Claude Code guidelines, connected by default.
// Source: https://github.com/multica-ai/andrej-karpathy-skills
//   skills/karpathy-guidelines/SKILL.md
// Four core principles to reduce common LLM coding mistakes: think before
// coding, simplicity first, surgical changes, goal-driven execution.

const SRC = 'https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/skills/karpathy-guidelines/SKILL.md';
const REPO = 'multica-ai/andrej-karpathy-skills';
const TAGS = ['karpathy', 'guidelines', 'curated', 'official-default'];

export const KARPATHY_SKILLS: Skill[] = [
  {
    id: 'karpathy-guidelines',
    name: 'Karpathy Guidelines',
    description: 'LLM 코딩 실수를 줄이는 4대 원칙: 먼저 생각하기 · 단순함 우선 · 외과적 변경 · 목표 기반 실행.',
    emoji: '🧠',
    command: `Apply the Karpathy coding guidelines (${REPO}) to this task. Follow all four core principles:
1. Think Before Coding — surface assumptions and tradeoffs; don't proceed with hidden uncertainty; present multiple valid approaches openly instead of silently picking one.
2. Simplicity First — write the minimum code that solves the problem; nothing speculative; no unnecessary abstractions or edge-case handling that doesn't apply.
3. Surgical Changes — touch only what you must; preserve existing style; only remove code your change rendered unnecessary, not pre-existing dead code.
4. Goal-Driven Execution — define measurable success criteria first, then loop until verified.`,
    cliType: 'claude',
    category: 'official',
    tags: TAGS,
    sourceUrl: SRC,
    sourcePack: 'Karpathy Guidelines',
    priority: 100,
  },
  {
    id: 'karpathy-think-before-coding',
    name: 'Think Before Coding',
    description: '가정과 트레이드오프를 먼저 드러내라. 숨은 불확실성으로 진행하지 말 것. 여러 유효한 접근은 공개하라.',
    emoji: '🤔',
    command: `Before writing any code, follow Karpathy's "Think Before Coding" principle (${REPO}): Don't assume. Don't hide confusion. Surface tradeoffs. When multiple valid approaches exist, present them openly instead of selecting one silently. State your assumptions and open questions explicitly.`,
    cliType: 'claude',
    category: 'architecture',
    tags: TAGS,
    sourceUrl: SRC,
    sourcePack: 'Karpathy Guidelines',
  },
  {
    id: 'karpathy-simplicity-first',
    name: 'Simplicity First',
    description: '문제를 푸는 최소 코드만. 투기적 기능·불필요한 추상화 금지.',
    emoji: '✂️',
    command: `Apply Karpathy's "Simplicity First" principle (${REPO}): write the minimum code that solves the problem, nothing speculative. Avoid speculative features, unnecessary abstractions, or error handling for edge cases that don't apply to the actual requirement.`,
    cliType: 'claude',
    category: 'refactor',
    tags: TAGS,
    sourceUrl: SRC,
    sourcePack: 'Karpathy Guidelines',
  },
  {
    id: 'karpathy-surgical-changes',
    name: 'Surgical Changes',
    description: '꼭 필요한 곳만 건드려라. 기존 스타일 보존, 네가 만든 잔재만 정리.',
    emoji: '🔪',
    command: `Apply Karpathy's "Surgical Changes" principle (${REPO}): touch only what you must, clean up only your own mess. When modifying existing code, preserve its style and only remove code that your specific change rendered unnecessary — not pre-existing dead code.`,
    cliType: 'claude',
    category: 'refactor',
    tags: TAGS,
    sourceUrl: SRC,
    sourcePack: 'Karpathy Guidelines',
  },
  {
    id: 'karpathy-goal-driven-execution',
    name: 'Goal-Driven Execution',
    description: '구현 전에 측정 가능한 성공 기준을 정의하고, 검증될 때까지 반복하라.',
    emoji: '🎯',
    command: `Apply Karpathy's "Goal-Driven Execution" principle (${REPO}): transform requirements into measurable success criteria before implementation. Define success criteria, then loop until verified. For complex tasks, outline discrete steps with verification checks that confirm each is complete.`,
    cliType: 'claude',
    category: 'official',
    tags: TAGS,
    sourceUrl: SRC,
    sourcePack: 'Karpathy Guidelines',
  },
];
