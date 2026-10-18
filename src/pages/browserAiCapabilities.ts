// Single source of truth for BBARIT Browser's AI capabilities.
//
// Nine iterations added tools across several files; there was no one place that
// answered "what can this AI browser do?". This registry is that place — used for
// the in-app onboarding/help surface, the agent's browser_help tool, and to keep the
// user-facing capability list from drifting out of sync with what actually ships.
//
// D1: This is DOCUMENTATION metadata, deliberately decoupled from the executable
//     TOOL_SPEC. Reason: the tool schema is for the model; this is for humans and for
//     the agent to explain itself. Keeping them separate lets each read naturally.
//     A test asserts every capability with a `tool` names a real, unique tool id.

export type CapabilityGroup = 'understand' | 'act' | 'create' | 'memory' | 'resilience';

export interface AiCapability {
  id: string;
  group: CapabilityGroup;
  title: string;
  titleKo: string;
  summary: string;
  summaryKo: string;
  tool?: string;      // backing agent tool id, if any
  example: string;    // a natural-language ask that triggers it
}

export const AI_CAPABILITIES: AiCapability[] = [
  // understand
  { id: 'omnibox', group: 'understand', title: 'AI omnibox', titleKo: 'AI 옴니박스',
    summary: 'The address bar routes URLs to navigation, keywords to search, and questions to the AI agent.',
    summaryKo: '주소창이 URL은 이동, 검색어는 검색, 질문은 AI 에이전트로 자동 분기합니다.',
    example: 'summarize this page' },
  { id: 'read-text', group: 'understand', title: 'Readable content', titleKo: '본문 읽기',
    summary: 'Extract the main article text (nav/ads/scripts stripped) for summarizing, analyzing, or translating.',
    summaryKo: '광고·내비 제거한 본문 텍스트를 추출해 요약·분석·번역에 사용합니다.',
    tool: 'browser_text', example: 'translate this article to Korean' },
  { id: 'vision', group: 'understand', title: 'Visual understanding', titleKo: '시각 이해',
    summary: 'Screenshot the page and have a vision model describe layout, overlaps, broken images and CTAs.',
    summaryKo: '페이지를 캡처해 비전 모델이 레이아웃·겹침·깨진 이미지·CTA를 설명합니다.',
    tool: 'browser_see', example: 'does the checkout button look right?' },
  { id: 'translate', group: 'understand', title: 'Translate page', titleKo: '페이지 번역',
    summary: 'Translate the page\'s readable content into any target language (handles long pages by chunking).',
    summaryKo: '페이지 본문을 원하는 언어로 번역합니다(긴 페이지는 청크 분할 처리).',
    tool: 'browser_translate', example: 'translate this page to Korean' },
  { id: 'extract', group: 'understand', title: 'Extract data', titleKo: '데이터 추출',
    summary: 'Pull tables and repeated item lists into clean records — optionally mapped onto a named field SCHEMA (title/price/rating) with type coercion.',
    summaryKo: '표·반복 항목을 구조화 레코드로 추출하고, 원하는 필드 스키마(제목/가격/평점)에 맞춰 타입까지 정규화합니다.',
    tool: 'browser_extract', example: 'extract title, price, rating for each product' },
  { id: 'links', group: 'understand', title: 'Link map', titleKo: '링크 지도',
    summary: 'Map and classify the page\'s links (internal/external/download/social) and navigate to one by description.',
    summaryKo: '페이지 링크를 분류(내부/외부/다운로드/소셜)하고 설명으로 원하는 링크로 이동합니다.',
    tool: 'browser_links', example: 'go to the pricing page' },
  { id: 'page-qa', group: 'understand', title: 'Ask this page', titleKo: '페이지 질의응답',
    summary: 'Answer questions grounded in the current page first, with cited visible evidence and explicit uncertainty.',
    summaryKo: '현재 페이지 근거를 우선 사용해 질문에 답하고, 보이는 증거와 불확실한 부분을 함께 표시합니다.',
    example: 'what does this page say about refunds?' },
  { id: 'design-skill', group: 'create', title: 'Design → CSS tokens', titleKo: '디자인 → CSS 토큰',
    summary: 'Reverse-engineer only the DESIGN into a reusable CSS design-token skill (palette, type scale, radii, shadows, spacing).',
    summaryKo: '디자인만 역공학해 재사용 가능한 CSS 디자인 토큰(팔레트·타이포·라운드·섀도·간격)으로 만듭니다.',
    tool: 'browser_design_skill', example: 'make a CSS theme from this site\'s design' },
  { id: 'reverse', group: 'understand', title: 'Reverse-engineer', titleKo: '역공학',
    summary: 'Extract the tech stack, design tokens, layout outline and observed API endpoints of any page.',
    summaryKo: '페이지의 기술 스택·디자인 토큰·레이아웃·관찰된 API 엔드포인트를 추출합니다.',
    tool: 'browser_reverse_engineer', example: 'how is this site built?' },
  { id: 'a11y', group: 'understand', title: 'Accessibility audit', titleKo: '접근성 감사',
    summary: 'Score the page against common WCAG failures (alts, labels, heading order, landmarks, lang, link text, color contrast) with fixes.',
    summaryKo: '흔한 WCAG 실패(alt·레이블·헤딩순서·랜드마크·lang·링크텍스트·색상대비)를 점수화하고 수정안을 제시합니다.',
    tool: 'browser_a11y', example: 'is this page accessible?' },
  { id: 'perf', group: 'understand', title: 'Performance audit', titleKo: '성능 감사',
    summary: 'Score page speed (TTFB, FCP, load, payload, requests) and list the heaviest/slowest resources with fixes.',
    summaryKo: '페이지 속도(TTFB·FCP·로드·페이로드·요청수)를 점수화하고 무거운/느린 리소스와 개선안을 제시합니다.',
    tool: 'browser_perf', example: 'why is this page slow?' },
  { id: 'audit', group: 'understand', title: 'Full health audit', titleKo: '종합 건강 감사',
    summary: 'Run accessibility + performance together and return one combined health score (A–F) with top issues across axes.',
    summaryKo: '접근성+성능을 한 번에 실행해 종합 건강 점수(A–F)와 축별 상위 이슈를 냅니다.',
    tool: 'browser_audit', example: 'is this page healthy overall?' },
  { id: 'check-access', group: 'resilience', title: 'Block detection', titleKo: '차단 감지',
    summary: 'Recognize Cloudflare/captcha/403/rate-limit/geo/login walls and advise how to get past them.',
    summaryKo: 'Cloudflare·캡차·403·레이트리밋·지역·로그인 차단을 인식하고 통과 방법을 안내합니다.',
    tool: 'browser_check_access', example: 'why is this page blocked?' },
  { id: 'consent', group: 'resilience', title: 'Consent auto-dismiss', titleKo: '동의 배너 처리',
    summary: 'Detect a cookie/GDPR consent banner and dismiss it (prefers reject/necessary-only) to reach the content.',
    summaryKo: '쿠키/GDPR 동의 배너를 감지해 콘텐츠에 닿도록 처리합니다(거부/필수만 우선).',
    tool: 'browser_consent', example: 'dismiss the cookie banner' },
  { id: 'block-recovery', group: 'resilience', title: 'Auto block recovery', titleKo: '자동 차단 복구',
    summary: 'On navigation, self-clearing walls (Cloudflare/JS challenge, rate limit) are auto-waited and reloaded before giving up.',
    summaryKo: '내비게이션 시 스스로 풀리는 차단(Cloudflare/JS 챌린지, 레이트리밋)을 자동으로 대기·재시도합니다.',
    example: '(automatic on navigate)' },
  { id: 'redact', group: 'resilience', title: 'Secret redaction', titleKo: '민감정보 마스킹',
    summary: 'Automatically masks secrets (cards, API keys, JWTs, credentials) in page/network content before it enters the AI context.',
    summaryKo: '페이지·네트워크 내용이 AI 컨텍스트로 들어가기 전에 비밀정보(카드·API키·JWT·자격증명)를 자동 마스킹합니다.',
    example: '(automatic on every observation)' },
  { id: 'diagnose', group: 'resilience', title: 'Self-diagnostics', titleKo: '자가 진단',
    summary: 'Diagnose built-in browser health (native runtime, control session, errors) and return troubleshooting steps when something is broken.',
    summaryKo: '내장 브라우저 상태(네이티브 런타임·제어 세션·오류)를 진단하고 문제 해결 단계를 제시합니다.',
    tool: 'browser_diagnose', example: 'the browser seems broken, what is wrong?' },
  // act
  { id: 'wait-for', group: 'act', title: 'Wait for content', titleKo: '콘텐츠 대기',
    summary: 'Wait until a condition holds (text appears/disappears, count reached, URL changes) before acting on dynamic pages.',
    summaryKo: '동적 페이지에서 조건(텍스트 등장/사라짐·개수·URL변경)이 충족될 때까지 기다린 뒤 진행합니다.',
    tool: 'browser_wait_for', example: 'wait until the results load' },
  { id: 'press-key', group: 'act', title: 'Press key', titleKo: '키 입력',
    summary: 'Press a key or shortcut (Enter, Escape, Tab, Ctrl+A, arrows) on the focused element.',
    summaryKo: '포커스된 요소에 키/단축키(Enter·Escape·Tab·Ctrl+A·방향키)를 누릅니다.',
    tool: 'browser_press_key', example: 'press Enter to submit' },
  { id: 'select', group: 'act', title: 'Dropdown select', titleKo: '드롭다운 선택',
    summary: 'Choose an option in a native <select> by its visible label ("Large", "대한민국").',
    summaryKo: 'native <select> 드롭다운에서 보이는 라벨로 옵션을 선택합니다.',
    tool: 'browser_select', example: 'select Large in the size dropdown' },
  { id: 'find-click', group: 'act', title: 'Click by description', titleKo: '설명으로 클릭',
    summary: 'Click an element by natural-language description ("the login button") instead of a CSS selector.',
    summaryKo: '"로그인 버튼" 같은 설명으로 요소를 찾아 클릭합니다(CSS 셀렉터 불필요).',
    tool: 'browser_find_click', example: 'click the add to cart button' },
  { id: 'action-plan', group: 'act', title: 'Action planning', titleKo: '브라우저 작업 계획',
    summary: 'Before acting, draft a step-by-step browser plan with target controls, risks, and checkpoints for human review.',
    summaryKo: '실행 전에 클릭/입력 대상, 위험, 확인 지점을 포함한 브라우저 작업 계획을 먼저 작성합니다.',
    example: 'plan how to cancel this subscription safely' },
  { id: 'fill-form', group: 'act', title: 'Auto form-fill', titleKo: '자동 폼 입력',
    summary: 'Match a values object to the right fields by identity and fill a form in one pass (never submits).',
    summaryKo: '값 객체를 필드 정체성으로 매칭해 폼을 한 번에 채웁니다(제출은 안 함).',
    tool: 'browser_fill_form', example: 'fill the contact form with my details' },
  { id: 'form-helper', group: 'act', title: 'Form helper', titleKo: '폼 작성 보조',
    summary: 'Explain required fields, validation issues, privacy risks, and safe draft values without submitting.',
    summaryKo: '제출 없이 필수 필드·검증 이슈·개인정보 위험·안전한 초안 값을 설명합니다.',
    example: 'help me fill this form, but do not submit it' },
  { id: 'load-more', group: 'act', title: 'Load more', titleKo: '더보기 로딩',
    summary: 'Auto-load a paginated list (load-more button, next-page, or infinite scroll) until it stops growing, so extraction sees the full list.',
    summaryKo: '페이지네이션(더보기·다음·무한스크롤)을 자동 로딩해 전체 목록을 추출할 수 있게 합니다.',
    tool: 'browser_load_more', example: 'load all the search results' },
  { id: 'batch', group: 'act', title: 'Multi-page batch', titleKo: '멀티페이지 배치',
    summary: 'Visit many URLs and produce one comparison report of SEO/structure metrics.',
    summaryKo: '여러 URL을 방문해 SEO·구조 메트릭 비교 리포트를 하나로 만듭니다.',
    tool: 'browser_batch', example: 'compare these 5 competitor pages' },
  { id: 'tab-compare', group: 'understand', title: 'Compare tabs', titleKo: '탭 비교',
    summary: 'Use the current tab plus mentioned tabs as context and compare purpose, claims, UX, pricing, and gaps.',
    summaryKo: '현재 탭과 멘션한 탭을 함께 문맥으로 넣어 목적·주장·UX·가격·빈틈을 비교합니다.',
    example: 'compare this page with the two tabs I mentioned' },
  // create
  { id: 'export', group: 'create', title: 'Export data', titleKo: '데이터 내보내기',
    summary: 'Extract the page data and save it to the project as CSV or JSON.',
    summaryKo: '페이지 데이터를 추출해 프로젝트에 CSV/JSON 파일로 저장합니다.',
    tool: 'browser_export', example: 'save these products as CSV' },
  { id: 'scaffold', group: 'create', title: 'Clone to files', titleKo: '사이트 클론 생성',
    summary: 'Write a runnable starter (HTML/CSS with sampled tokens, API map, README) into the project.',
    summaryKo: '실행 가능한 시작 코드(디자인 토큰 반영 HTML/CSS, API 맵, README)를 프로젝트에 생성합니다.',
    tool: 'browser_scaffold_clone', example: 'clone this landing page into my project' },
  { id: 'shop-check', group: 'create', title: 'Shop check', titleKo: '구매 판단 보조',
    summary: 'Evaluate price sanity, review consensus, red flags, alternatives, and whether to buy now or wait.',
    summaryKo: '가격 타당성·리뷰 흐름·위험 신호·대안·지금 살지 기다릴지를 점검합니다.',
    example: 'is this laptop a good deal?' },
  { id: 'research-brief', group: 'create', title: 'Research brief', titleKo: '리서치 브리프',
    summary: 'Turn the current page and mentioned tabs into a brief with evidence, contradictions, open questions, and next actions.',
    summaryKo: '현재 페이지와 멘션 탭을 근거·모순·남은 질문·다음 액션이 있는 리서치 브리프로 정리합니다.',
    example: 'make a research brief from these tabs' },
  // memory
  { id: 'watch', group: 'memory', title: 'Change watch', titleKo: '변경 감지',
    summary: 'Snapshot a page\'s key values and report what changed since last time (price up/down %, items appeared/gone).',
    summaryKo: '페이지 핵심 값을 스냅샷하고 지난번 대비 변경(가격 등락 %, 항목 추가/삭제)을 리포트합니다.',
    tool: 'browser_watch', example: 'did the price on this page change?' },
  { id: 'history', group: 'memory', title: 'Smart history', titleKo: '스마트 히스토리',
    summary: 'Frecency-ranked, auto-categorized cross-session history with fuzzy recall and bookmarks.',
    summaryKo: 'frecency 랭킹·자동 분류된 세션 간 히스토리와 퍼지 검색·북마크를 제공합니다.',
    tool: 'browser_history', example: 'find that pricing page I visited last week' },
  { id: 'session', group: 'resilience', title: 'Session recovery', titleKo: '세션 복원',
    summary: 'Restores your last page after a restart, so you never lose your place.',
    summaryKo: '재시작 후 마지막 페이지를 복원해 작업 위치를 잃지 않습니다.',
    example: '(automatic on restart)' },
];

export const GROUP_LABEL: Record<CapabilityGroup, { en: string; ko: string }> = {
  understand: { en: 'Understand', ko: '이해' },
  act: { en: 'Act', ko: '조작' },
  create: { en: 'Create', ko: '생성' },
  memory: { en: 'Memory', ko: '기억' },
  resilience: { en: 'Resilience', ko: '견고성' },
};

export function capabilitiesByGroup(): Array<{ group: CapabilityGroup; items: AiCapability[] }> {
  const order: CapabilityGroup[] = ['understand', 'act', 'create', 'memory', 'resilience'];
  return order
    .map((group) => ({ group, items: AI_CAPABILITIES.filter((c) => c.group === group) }))
    .filter((g) => g.items.length > 0);
}

// Compact help text for the agent's browser_help tool / onboarding tooltip.
export function formatCapabilities(ko = false): string {
  const lines: string[] = [ko ? 'BBARIT AI 브라우저 기능:' : 'BBARIT AI Browser capabilities:'];
  for (const { group, items } of capabilitiesByGroup()) {
    lines.push('', `## ${ko ? GROUP_LABEL[group].ko : GROUP_LABEL[group].en}`);
    for (const c of items) {
      const title = ko ? c.titleKo : c.title;
      const summary = ko ? c.summaryKo : c.summary;
      lines.push(`- ${title}${c.tool ? ` (${c.tool})` : ''}: ${summary} — e.g. "${c.example}"`);
    }
  }
  return lines.join('\n');
}
