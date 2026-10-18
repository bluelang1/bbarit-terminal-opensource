/**
 * GenerateNoteModal.tsx
 *
 * AI-powered note generator modal.
 * Supports two modes:
 *   - Global: saves to ~/Documents/octo-notes/
 *   - Project: saves to {project.workDir}/docs/
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor } from '@tauri-apps/api/window';
import { OctoX } from '../octoIcons';
import { Send, Globe } from 'lucide-react';
import { aiChat, getAiTagProvider } from './ollamaTagging';
import { useTranslation } from '../i18n';
import './GenerateNoteModal.css';

interface ProjectInfo {
  id: string;
  displayName: string;
  workDir: string;
  icon: string;
}

interface GenerateNoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  projects: ProjectInfo[];
  globalNotesDir: string | null;
  activeProjectId: string | null;
  onNoteCreated: (path: string) => void;
}

type ChatEntry =
  | { type: 'user'; topic: string }
  | { type: 'status'; msg: string }
  | { type: 'result'; path: string; fileName: string }
  | { type: 'research'; msg: string }
  | { type: 'error'; msg: string };

// ── Topic Presets ──
interface PresetCategory {
  label: string;
  icon: string;
  topics: string[];
}

const TOPIC_PRESETS: PresetCategory[] = [
  // ══════════════════════════════════════
  //  분석 (Analysis)
  // ══════════════════════════════════════
  {
    label: '요구사항 분석',
    icon: '🔍',
    topics: [
      '요구사항 정의서(SRS) 작성 가이드',
      '사용자 스토리와 유스케이스 다이어그램',
      '기능 요구사항 vs 비기능 요구사항 분류법',
      '이해관계자 분석과 요구사항 도출',
      '프로토타이핑으로 요구사항 검증하기',
      '우선순위 결정 기법 (MoSCoW, RICE, Kano)',
      '경쟁 제품 분석 프레임워크',
      '기술 타당성 분석 (Feasibility Study) 작성',
      'AS-IS / TO-BE 분석 기법',
    ],
  },
  {
    label: '시스템 분석',
    icon: '📊',
    topics: [
      '시스템 컨텍스트 다이어그램 작성',
      '데이터 흐름도(DFD) 설계 기법',
      'ERD(Entity-Relationship Diagram) 작성법',
      '도메인 모델링과 유비쿼터스 언어 정의',
      '기존 시스템 역공학(Reverse Engineering) 방법',
      '성능 병목 분석과 프로파일링 기법',
      '리스크 분석과 완화 전략 수립',
      '기술 스택 선정 기준과 비교 분석',
      '시스템 규모 산정(Capacity Planning)',
      'PoC(Proof of Concept) 계획서 작성',
    ],
  },
  // ══════════════════════════════════════
  //  설계 (Design)
  // ══════════════════════════════════════
  {
    label: '아키텍처 설계',
    icon: '🏗️',
    topics: [
      '시스템 아키텍처 설계 문서(SAD) 작성',
      'C4 모델로 아키텍처 시각화하기',
      'Microservices vs Monolith 아키텍처 선택 기준',
      '이벤트 드리븐 아키텍처(EDA) 설계',
      '클린 아키텍처 레이어 분리 전략',
      '헥사고날 아키텍처 (포트와 어댑터)',
      'CQRS와 이벤트 소싱 패턴',
      '확장성을 고려한 수평/수직 확장 설계',
      '고가용성(HA) 아키텍처 패턴',
      '멀티테넌시 아키텍처 설계',
    ],
  },
  {
    label: 'API 설계',
    icon: '🔌',
    topics: [
      'REST API 설계 원칙과 리소스 모델링',
      'GraphQL 스키마 설계와 리졸버 패턴',
      'gRPC와 Protocol Buffers 가이드',
      'OpenAPI(Swagger) 스펙 작성',
      'API 버전 관리 전략 비교',
      'API 에러 응답 표준 설계 (RFC 7807)',
      'API Rate Limiting과 쓰로틀링 설계',
      'WebSocket과 SSE 실시간 통신 설계',
      'API Gateway 아키텍처 설계',
      'BFF(Backend for Frontend) 패턴 설계',
    ],
  },
  {
    label: 'DB 설계',
    icon: '🗄️',
    topics: [
      '데이터베이스 스키마 설계 베스트 프랙티스',
      '정규화(1NF~BCNF)와 비정규화 전략',
      '인덱스 설계와 쿼리 최적화 전략',
      'NoSQL 데이터 모델링 (MongoDB, DynamoDB)',
      '데이터베이스 샤딩 전략과 구현',
      '캐싱 레이어 설계 (Redis, Memcached)',
      '마이그레이션 전략과 스키마 버전 관리',
      '트랜잭션 격리 수준과 동시성 제어',
      '데이터 파이프라인과 ETL 설계',
      '이벤트 저장소와 로그 기반 아키텍처',
    ],
  },
  {
    label: '디자인 패턴',
    icon: '🧩',
    topics: [
      'SOLID 원칙 실전 적용 사례',
      '생성 패턴: Factory, Builder, Singleton',
      '구조 패턴: Adapter, Decorator, Proxy',
      '행동 패턴: Strategy, Observer, Command',
      'Repository 패턴과 데이터 접근 추상화',
      'SAGA 패턴으로 분산 트랜잭션 관리',
      'Circuit Breaker 패턴과 장애 격리',
      'Strangler Fig 레거시 마이그레이션 패턴',
      'DDD(도메인 주도 설계) 핵심 개념과 구현',
      '의존성 주입(DI)과 IoC 컨테이너',
    ],
  },
  // ══════════════════════════════════════
  //  개발 (Development)
  // ══════════════════════════════════════
  {
    label: '코딩 표준',
    icon: '📝',
    topics: [
      '코딩 컨벤션과 스타일 가이드 작성법',
      '코드 리뷰 체크리스트와 프로세스',
      '리팩토링 기법과 코드 스멜 식별',
      '에러 핸들링 전략과 안티패턴',
      '로깅 표준과 구조화된 로그 설계',
      '환경 변수와 설정 관리 전략',
      '의미 있는 네이밍 컨벤션 가이드',
      '기술 부채 측정과 상환 계획',
      '코드 문서화 (JSDoc, rustdoc, docstring)',
      'Git 커밋 메시지 컨벤션 (Conventional Commits)',
    ],
  },
  {
    label: 'Git & 브랜칭',
    icon: '🌿',
    topics: [
      'Git Flow vs Trunk-based 브랜칭 전략',
      'Git rebase vs merge 활용 가이드',
      'Git hooks로 워크플로 자동화',
      'PR(Pull Request) 코드 리뷰 프로세스',
      'Git cherry-pick과 bisect 디버깅',
      'Git 대용량 파일 관리 (Git LFS)',
      'Monorepo 관리 전략 (Nx, Turborepo)',
      'Git 충돌 해결과 rebase 전략',
      'Git worktree로 병렬 작업 관리',
      'Release 브랜치와 태깅 전략',
    ],
  },
  {
    label: '프론트엔드 개발',
    icon: '⚛️',
    topics: [
      'React 컴포넌트 설계 원칙과 패턴',
      'React 상태 관리 전략 비교 (Zustand, Jotai, Redux)',
      '웹 성능 최적화 (Core Web Vitals)',
      '접근성(a11y) 구현 가이드 (WCAG)',
      '디자인 시스템과 컴포넌트 라이브러리 구축',
      '반응형 디자인과 모바일 퍼스트 전략',
      'SSR/SSG/ISR 렌더링 전략 비교',
      'Web API 활용 (Service Worker, WebSocket)',
      '프론트엔드 에러 추적과 모니터링',
      'Micro Frontend 아키텍처 설계',
    ],
  },
  {
    label: '백엔드 개발',
    icon: '🖥️',
    topics: [
      'RESTful 서비스 구현 베스트 프랙티스',
      '인증/인가 시스템 구현 (JWT, OAuth, Session)',
      '미들웨어 설계와 요청 파이프라인',
      '비동기 처리와 메시지 큐 통합',
      '파일 업로드/다운로드 처리 전략',
      '서버리스 함수 설계와 Cold Start 최적화',
      '배치 작업과 스케줄러 구현',
      'WebSocket 서버 구현과 연결 관리',
      'API 응답 캐싱 전략 구현',
      '멀티 데이터소스 통합 패턴',
    ],
  },
  // ══════════════════════════════════════
  //  테스트 (Testing)
  // ══════════════════════════════════════
  {
    label: '테스트 전략',
    icon: '🧪',
    topics: [
      '테스트 계획서(Test Plan) 작성 가이드',
      'TDD(테스트 주도 개발) 실전 가이드',
      '테스트 피라미드와 적절한 테스트 비율',
      '단위 테스트 작성 원칙과 패턴',
      '통합 테스트 범위와 설계 전략',
      'E2E 테스트 자동화 (Playwright, Cypress)',
      '테스트 더블 (Mock, Stub, Spy) 활용법',
      '성능 테스트와 부하 테스트 (k6, Artillery)',
      '보안 테스트 자동화 (SAST, DAST)',
      '카오스 엔지니어링으로 장애 내성 검증',
    ],
  },
  {
    label: 'QA & 품질',
    icon: '✅',
    topics: [
      'QA 프로세스 수립과 체크리스트',
      '결함 추적과 버그 리포트 작성법',
      '회귀 테스트 전략과 자동화',
      '코드 커버리지 분석과 목표 설정',
      '계약 테스트(Contract Testing) 도입',
      'Property-Based Testing 활용',
      'A/B 테스트 설계와 통계적 유의성',
      '크로스 브라우저/크로스 플랫폼 테스트',
      '접근성 테스트 자동화',
      '릴리스 체크리스트와 Go/No-Go 기준',
    ],
  },
  // ══════════════════════════════════════
  //  배포 & CI/CD
  // ══════════════════════════════════════
  {
    label: 'CI/CD 파이프라인',
    icon: '🔧',
    topics: [
      'CI/CD 파이프라인 설계 원칙',
      'GitHub Actions 워크플로 실전 구성',
      'GitLab CI/CD 파이프라인 구축',
      '멀티 스테이지 빌드와 아티팩트 관리',
      '자동화된 코드 품질 게이트 설정',
      '시맨틱 버저닝과 자동 릴리즈 노트',
      '환경별 설정 관리 (dev, staging, prod)',
      '빌드 캐싱과 파이프라인 속도 최적화',
      'Feature Flag 기반 점진적 배포',
      'Monorepo CI/CD 전략',
    ],
  },
  {
    label: '배포 전략',
    icon: '🚀',
    topics: [
      '블루-그린 배포 전략과 구현',
      '카나리 배포와 점진적 롤아웃',
      '롤링 업데이트와 롤백 전략',
      'Docker 컨테이너화 베스트 프랙티스',
      'Kubernetes 배포 (Deployment, Service, Ingress)',
      'Helm 차트 작성과 패키지 관리',
      'Infrastructure as Code (Terraform, Pulumi)',
      'GitOps 워크플로와 ArgoCD',
      'CDN 설정과 정적 리소스 배포',
      '데이터베이스 마이그레이션 배포 전략',
    ],
  },
  // ══════════════════════════════════════
  //  운영 & 유지보수
  // ══════════════════════════════════════
  {
    label: '모니터링 & 관찰성',
    icon: '📈',
    topics: [
      '모니터링 시스템 설계 (Prometheus, Grafana)',
      '로그 수집과 분석 (ELK, Loki)',
      '분산 추적(Distributed Tracing) 구현',
      'SLO/SLI/SLA 정의와 에러 예산',
      '알림(Alerting) 전략과 임계값 설정',
      'APM(Application Performance Monitoring) 도입',
      'Health Check와 Readiness/Liveness Probe',
      '사용자 행동 분석 (Analytics) 설계',
      '비용 모니터링과 클라우드 비용 최적화',
      'Dashboard 설계 베스트 프랙티스',
    ],
  },
  {
    label: '인시던트 관리',
    icon: '🚨',
    topics: [
      '인시던트 대응 프로세스 수립',
      '포스트모템(Postmortem) 작성 가이드',
      '온콜(On-Call) 로테이션 설계',
      '장애 등급 분류와 에스컬레이션 정책',
      '장애 대응 런북(Runbook) 작성법',
      'SRE(Site Reliability Engineering) 핵심 원칙',
      '자동 복구(Self-Healing) 시스템 설계',
      '재해 복구(DR) 계획과 RTO/RPO 설정',
      '데이터 백업과 복원 전략',
      '서비스 점검(Maintenance Window) 계획',
    ],
  },
  {
    label: '유지보수 계획',
    icon: '🔨',
    topics: [
      '기술 부채 관리 전략과 상환 계획',
      '레거시 시스템 현대화 로드맵',
      '의존성 업데이트와 보안 패치 전략',
      'EOL(End of Life) 마이그레이션 계획',
      '성능 최적화 주기와 프로파일링',
      '코드 오너십과 지식 이전 계획',
      '서비스 운영 핸드북(Operational Handbook)',
      '자동화된 유지보수 태스크 설계',
      '용량 계획(Capacity Planning)과 확장 전략',
      '서비스 종료(Sunset) 절차와 데이터 처리',
    ],
  },
  // ══════════════════════════════════════
  //  보안 (Security)
  // ══════════════════════════════════════
  {
    label: '보안 설계',
    icon: '🔒',
    topics: [
      'OWASP Top 10 취약점 대응 가이드',
      '인증/인가 아키텍처 설계 (OAuth, OIDC, JWT)',
      'Zero Trust 보안 모델 설계',
      'API 보안 설계 (Rate Limiting, CORS, CSP)',
      '데이터 암호화 전략 (전송 중, 저장 중)',
      '시크릿 관리 (Vault, AWS Secrets Manager)',
      'RBAC/ABAC 접근 제어 모델 설계',
      'DevSecOps 파이프라인 구축',
      '컨테이너와 클라우드 보안 강화',
      '보안 감사와 취약점 관리 프로세스',
    ],
  },
  {
    label: '개인정보 & 컴플라이언스',
    icon: '🛡️',
    topics: [
      'GDPR 개발자 대응 가이드',
      '개인정보보호법 기술적 조치 체크리스트',
      '데이터 마스킹과 익명화 기법',
      '동의 관리 시스템(CMP) 구현',
      '데이터 보존 정책과 삭제 자동화',
      '보안 사고 대응 계획서 작성',
      '침투 테스트와 버그 바운티 프로그램',
      '공급망 보안과 소프트웨어 BOM(SBOM)',
      'SOC 2 / ISO 27001 인증 준비',
      '서드파티 보안 평가와 벤더 관리',
    ],
  },
  // ══════════════════════════════════════
  //  방법론 (Methodology)
  // ══════════════════════════════════════
  {
    label: '애자일 방법론',
    icon: '🔄',
    topics: [
      'Scrum 프레임워크 도입 가이드',
      'Kanban 보드 설계와 WIP 제한 전략',
      '스프린트 플래닝과 스토리 포인트 추정',
      '데일리 스탠드업과 회고 운영법',
      '사용자 스토리 작성법 (INVEST 원칙)',
      'Shape Up: 6주 사이클 프로덕트 개발',
      'OKR/KPI 기반 개발팀 성과 측정',
      'Definition of Done(DoD) 기준 수립',
      '기술 스파이크로 불확실성 줄이기',
      '에픽, 스토리, 태스크 분할 기법',
    ],
  },
  {
    label: '프로젝트 관리',
    icon: '📋',
    topics: [
      '프로젝트 킥오프 미팅 진행 가이드',
      '기술 의사결정 기록(ADR) 작성법',
      'RFC 문화로 설계 결정 문서화하기',
      '프로젝트 일정 추정과 리스크 관리',
      '기술 로드맵 수립과 스테이크홀더 소통',
      '코드 오너십과 팀 토폴로지(Team Topologies)',
      '원격 팀의 비동기 커뮤니케이션 전략',
      '온보딩 문서와 팀 핸드북 작성',
      '데드라인 관리와 스코프 조정 기법',
      '프로젝트 회고와 교훈 문서화',
    ],
  },
  // ══════════════════════════════════════
  //  사업화 & 비즈니스
  // ══════════════════════════════════════
  {
    label: '사업화 전략',
    icon: '💰',
    topics: [
      '사업계획서(Business Plan) 작성 가이드',
      '린 스타트업 방법론과 MVP 구축',
      '제품-시장 적합성(PMF) 검증 방법',
      'SaaS 비즈니스 모델과 가격 책정 전략',
      '오픈소스 사업화 전략 (Open Core, Cloud)',
      'API-as-a-Product 비즈니스 설계',
      '유닛 이코노믹스(Unit Economics) 분석',
      '구독 경제 핵심 지표 (MRR, Churn, LTV, CAC)',
      'Indie Hacker: 1인 개발자 수익화 전략',
      '사이드 프로젝트를 사업으로 전환하기',
    ],
  },
  {
    label: '투자 & 성장',
    icon: '📈',
    topics: [
      'VC 피치덱 작성법과 스토리텔링',
      '시드/시리즈 A 펀드레이징 전략',
      '투자 텀시트 핵심 조항 이해',
      '부트스트래핑 vs 벤처 투자 장단점',
      '정부 R&D 과제와 지원금 활용',
      'PLG(Product-Led Growth) 전략',
      '개발자 대상 마케팅(DevRel) 전략',
      'SEO와 콘텐츠 마케팅으로 유기적 성장',
      '프로덕트 헌트 런칭 전략',
      'Exit 전략: M&A, IPO 준비',
    ],
  },
  {
    label: '제품 관리',
    icon: '📦',
    topics: [
      'PRD(제품 요구사항 문서) 작성 가이드',
      '사용자 리서치와 페르소나 정의',
      '제품 로드맵 수립과 우선순위 결정',
      '데이터 기반 의사결정 (A/B 테스트)',
      '사용자 여정 맵(User Journey Map)',
      'AARRR 퍼널과 North Star Metric',
      '기능 플래그 기반 점진적 출시',
      '고객 피드백 루프와 이터레이션',
      '제품 분석 대시보드 설계',
      '경쟁사 분석과 포지셔닝 전략',
    ],
  },
  // ══════════════════════════════════════
  //  아이디어 & 혁신
  // ══════════════════════════════════════
  {
    label: '아이디어 발상',
    icon: '💡',
    topics: [
      '문제 발견 프레임워크 (Jobs-to-be-Done)',
      '디자인 씽킹 프로세스 실전 가이드',
      'SCAMPER 기법으로 아이디어 변형하기',
      'Blue Ocean 전략: 경쟁 없는 시장 찾기',
      '아이디어 검증: 48시간 MVP 실험',
      '사용자 인터뷰로 진짜 문제 찾기',
      '크로스 인더스트리 이노베이션 기법',
      '기존 도구/서비스의 개선 기회 발견',
      '기술 트렌드 기반 사업 기회 분석',
      '프로토타입 기반 빠른 가설 검증',
    ],
  },
  {
    label: 'AI 활용 전략',
    icon: '🤖',
    topics: [
      'AI 제품 기능 설계 패턴',
      'LLM 프롬프트 엔지니어링 실전 가이드',
      'RAG(검색 증강 생성) 시스템 구축',
      'AI 에이전트 아키텍처 설계',
      'AI 코딩 어시스턴트 효과적 활용법',
      'AI 비용 최적화 (모델 선택, 캐싱, 배칭)',
      'AI 기반 워크플로 자동화 설계',
      'AI 제품 평가와 품질 메트릭',
      'AI 윤리와 책임 있는 AI 개발',
      'AI 스타트업 아이디어 검증 프레임워크',
    ],
  },
  // ══════════════════════════════════════
  //  법률 & 규제
  // ══════════════════════════════════════
  {
    label: '법률 & 라이선스',
    icon: '⚖️',
    topics: [
      '오픈소스 라이선스 비교 (MIT, Apache, GPL)',
      '이용약관과 개인정보처리방침 작성법',
      '소프트웨어 특허와 지적재산권 보호',
      'SaaS 서비스 계약서 핵심 조항',
      '프리랜서/외주 계약서 작성 가이드',
      'AI 규제 동향과 개발자 대응',
      '전자상거래법과 온라인 서비스 규제',
      '데이터 지역화(Data Residency) 대응',
      '저작권과 Fair Use: 코드와 콘텐츠',
      '기술 스타트업 법인 설립 체크리스트',
    ],
  },
];

const NOTE_SYSTEM_PROMPT = `Write a well-structured markdown note about the given topic.
Include:
- A clear # title
- Brief overview
- Key concepts with ## sections
- Code examples if relevant
Write in the same language as the topic. Be concise but thorough.`;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s가-힣ぁ-んァ-ヶ一-龥a-zA-Z0-9-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'untitled';
}

export default function GenerateNoteModal({
  isOpen,
  onClose,
  projects,
  globalNotesDir,
  activeProjectId,
  onNoteCreated,
}: GenerateNoteModalProps) {
  const { t: tr } = useTranslation();
  const [mode, setMode] = useState<'global' | 'project'>('project');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [topic, setTopic] = useState('');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showPresets, setShowPresets] = useState(true);
  const [expandedPresetCat, setExpandedPresetCat] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries]);

  // Reset only when modal opens (isOpen transitions to true)
  const prevIsOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      setEntries([]);
      setTopic('');
      setIsGenerating(false);
      setClosing(false);
      setShowPresets(true);
      setExpandedPresetCat(null);
      // Default to active project if available
      if (activeProjectId && projects.some(p => p.id === activeProjectId)) {
        setSelectedProjectId(activeProjectId);
        setMode('project');
      } else if (projects.length > 0) {
        setSelectedProjectId(projects[0].id);
        setMode('project');
      } else {
        setMode('global');
      }
      setTimeout(() => inputRef.current?.focus(), 100);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, activeProjectId, projects]);

  const addEntry = useCallback((entry: ChatEntry) => {
    setEntries(prev => [...prev, entry]);
  }, []);

  const getSaveDir = useCallback((): string | null => {
    if (mode === 'global') return globalNotesDir;
    const proj = projects.find(p => p.id === selectedProjectId);
    if (!proj) return null;
    return `${proj.workDir}/docs`;
  }, [mode, globalNotesDir, projects, selectedProjectId]);

  const handleGenerate = useCallback(async (overrideTopic?: string) => {
    const t = (overrideTopic ?? topic).trim();
    if (!t || isGenerating) return;

    const saveDir = getSaveDir();
    if (!saveDir) {
      addEntry({ type: 'error', msg: mode === 'global' ? tr('notes.gen.globalDirNotReady') : tr('notes.gen.noProjectSelected') });
      return;
    }

    setTopic('');
    setIsGenerating(true);
    addEntry({ type: 'user', topic: t });
    addEntry({ type: 'status', msg: tr('notes.gen.generating') });

    try {
      // Ensure save directory exists
      await invoke('create_directory', { path: saveDir }).catch(() => {});

      // Generate note via AI
      const content = await aiChat(NOTE_SYSTEM_PROMPT, t);

      if (!content.trim()) {
        addEntry({ type: 'error', msg: tr('notes.gen.emptyResponse') });
        setIsGenerating(false);
        return;
      }

      // Save file
      const slug = slugify(t);
      const fileName = `${slug}.md`;
      const filePath = `${saveDir}/${fileName}`;

      // Check if file exists, add suffix if needed
      let finalPath = filePath;
      let finalName = fileName;
      try {
        await invoke<string>('read_file', { path: filePath });
        // File exists, add timestamp suffix
        const suffix = Date.now().toString(36);
        finalName = `${slug}-${suffix}.md`;
        finalPath = `${saveDir}/${finalName}`;
      } catch {
        // File doesn't exist, use original path
      }

      await invoke('write_file', { path: finalPath, content });

      // Remove the "Generating..." status
      setEntries(prev => prev.filter(e => !(e.type === 'status' && e.msg === tr('notes.gen.generating'))));
      addEntry({ type: 'result', path: finalPath, fileName: finalName });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Remove the "Generating..." status
      setEntries(prev => prev.filter(e => !(e.type === 'status' && e.msg === tr('notes.gen.generating'))));
      addEntry({ type: 'error', msg });
    }

    setIsGenerating(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [topic, isGenerating, getSaveDir, mode, addEntry]);

  // ── 웹 자료 조사 ──
  const [isResearching, setIsResearching] = useState(false);
  const researchTermIdRef = useRef<string | null>(null);

  const handleResearch = useCallback(async (overrideTopic?: string) => {
    const t = (overrideTopic ?? topic).trim();
    if (!t || isResearching || isGenerating) return;

    const provider = await getAiTagProvider();
    if (provider === 'ollama') {
      addEntry({ type: 'error', msg: tr('notes.gen.ollamaNoWebSearch') });
      return;
    }

    const saveDir = getSaveDir();
    if (!saveDir) {
      addEntry({ type: 'error', msg: mode === 'global' ? tr('notes.gen.globalDirNotReady') : tr('notes.gen.noProjectSelected') });
      return;
    }

    setTopic('');
    setIsResearching(true);
    addEntry({ type: 'user', topic: tr('notes.gen.webResearchPrefix').replace('{topic}', t) });
    addEntry({ type: 'status', msg: tr('notes.gen.researchStarting') });

    const ts = Date.now();
    const termId = `research-${ts}`;
    researchTermIdRef.current = termId;
    const slug = slugify(t);
    const outputFile = `${saveDir}/${slug}-research.md`;
    const cliStart = provider === 'kimi' ? 'kimi --yolo'
      : provider === 'deepseek' ? 'deepseek --yolo'
      : 'codex --full-auto';

    const researchPrompt = [
      `You are a thorough research assistant. Your job is to investigate a topic and save a comprehensive report.`,
      ``,
      `=== RESEARCH TOPIC ===`,
      `"${t}"`,
      ``,
      `=== INSTRUCTIONS ===`,
      `1. Search the web AGGRESSIVELY using every method available:`,
      `   - Search in English (primary — most research is in English)`,
      `   - Search in Korean (한국어로도 검색)`,
      `   - Search academic papers (arxiv, Google Scholar, ACM, IEEE)`,
      `   - Search blog posts, tutorials, official docs`,
      `   - Search GitHub repos and READMEs`,
      `   - Try multiple different search queries and keyword variations`,
      ``,
      `2. For EACH valuable source you find:`,
      `   - Read it thoroughly`,
      `   - Extract key ideas, methods, results, and practical takeaways`,
      `   - Note the URL and title`,
      ``,
      `3. Compile ALL findings into a single comprehensive markdown report:`,
      `   - Start with # title`,
      `   - Organize by theme/subtopic, not by source`,
      `   - Include practical applications and actionable insights`,
      `   - Add a references section with all URLs`,
      `   - Write in Korean (기술 용어는 영문 그대로)`,
      ``,
      `4. Save the report to: ${outputFile}`,
      `   Use: cat << 'REPORT_EOF' > ${outputFile}`,
      `   <your report>`,
      `   REPORT_EOF`,
      ``,
      `5. Keep searching until you feel you've covered the topic thoroughly.`,
      `   More sources = better. Aim for at least 10-15 sources.`,
      ``,
      `=== QUALITY BAR ===`,
      `The report should be detailed enough that someone reading it has a comprehensive`,
      `understanding of the topic WITHOUT needing to visit the original sources.`,
      `Think of it as a literature review + practical guide combined.`,
    ].join('\n');

    try {
      // 프롬프트 파일 저장
      const promptFile = `/tmp/octo-research-prompt-${ts}.txt`;
      await invoke('write_file', { path: promptFile, content: researchPrompt });
      await invoke('create_directory', { path: saveDir }).catch(() => {});

      // 셸 생성
      const proj = projects.find(p => p.id === selectedProjectId);
      const workDirForShell = proj?.workDir || '';
      await invoke('create_shell', { terminalId: termId, rows: 30, cols: 100, workDir: workDirForShell });

      // 터미널 윈도우 열기
      const winLabel = `research-${ts.toString(36)}`;
      const params = new URLSearchParams({
        terminalId: termId,
        label: tr('notes.gen.researchWindowTitle').replace('{topic}', t.slice(0, 30)),
        cliType: 'shell',
        isLeader: '0',
        projectId: selectedProjectId || '',
      });
      if (workDirForShell) params.set('workDir', workDirForShell);
      params.set('task', t.slice(0, 150));

      let winW = 520, winH = 420;
      let x = 100, y = 100;
      try {
        const mon = await currentMonitor();
        if (mon) {
          const sw = mon.size.width / mon.scaleFactor;
          const sh = mon.size.height / mon.scaleFactor;
          x = Math.max(0, sw - winW - 40);
          y = Math.max(0, sh - winH - 80);
        }
      } catch {}

      const url = `/agent-terminal?${params.toString()}`;
      new WebviewWindow(winLabel, { url, title: tr('notes.gen.researchWindowTitle').replace('{topic}', t.slice(0, 30)), width: winW, height: winH, x: Math.round(x), y: Math.round(y), resizable: true, decorations: true });
      await new Promise(r => setTimeout(r, 600));

      // PTY 준비 대기
      for (let w = 0; w < 20; w++) {
        await new Promise(r => setTimeout(r, 500));
        const alive = await invoke<boolean>('check_pty_alive', { terminalId: termId }).catch(() => false);
        if (alive) break;
      }

      // CLI 시작
      const writeAndSubmit = async (text: string) => {
        await invoke('write_to_pty', { terminalId: termId, data: text }).catch(() => {});
        await new Promise(r => setTimeout(r, 500));
        await invoke('write_to_pty', { terminalId: termId, data: '\r' }).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        await invoke('write_to_pty', { terminalId: termId, data: '\r' }).catch(() => {});
      };

      await writeAndSubmit(cliStart);
      await new Promise(r => setTimeout(r, 8000));
      await writeAndSubmit(`Read the instructions in ${promptFile} and follow them. Start researching immediately.`);

      // 프롬프트 파일 정리 (15초 후)
      setTimeout(() => { invoke('delete_path', { path: promptFile }).catch(() => {}); }, 15000);

      // 완료 폴링 (최대 10분)
      const deadline = Date.now() + 600000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10000));
        const alive = await invoke<boolean>('check_pty_alive', { terminalId: termId }).catch(() => false);
        if (!alive) break;
        try {
          const content = await invoke<string>('read_file', { path: outputFile });
          if (content && content.trim().length > 200) break;
        } catch {}
      }

      // 결과 확인
      try {
        const content = await invoke<string>('read_file', { path: outputFile });
        if (content && content.trim().length > 50) {
          setEntries(prev => prev.filter(e => !(e.type === 'status')));
          addEntry({ type: 'result', path: outputFile, fileName: outputFile.split('/').pop() || 'research.md' });
        } else {
          setEntries(prev => prev.filter(e => !(e.type === 'status')));
          addEntry({ type: 'research', msg: tr('notes.gen.researchOpenWillSave') });
        }
      } catch {
        setEntries(prev => prev.filter(e => !(e.type === 'status')));
        addEntry({ type: 'research', msg: tr('notes.gen.researchOpenInProgress') });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setEntries(prev => prev.filter(e => !(e.type === 'status')));
      addEntry({ type: 'error', msg });
    } finally {
      setIsResearching(false);
      researchTermIdRef.current = null;
    }
  }, [topic, isResearching, isGenerating, getSaveDir, mode, addEntry, projects, selectedProjectId]);

  const handleClose = useCallback(() => {
    if (isGenerating) return;
    setClosing(true);
    setTimeout(() => onClose(), 180);
  }, [isGenerating, onClose]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const selectedProject = projects.find(p => p.id === selectedProjectId);

  return (
    <div
      className={`genote-overlay ${closing ? 'closing' : ''}`}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="genote-modal">
        {/* Header */}
        <div className="genote-header">
          <span className="genote-header-icon">&#x1F4DD;</span>
          <span className="genote-header-title">{tr('notes.gen.title')}</span>
          <button className="genote-header-close" onClick={handleClose} title={tr('common.close')}>
            <OctoX size={14} />
          </button>
        </div>

        {/* Mode + Project Selector */}
        <div className="genote-controls">
          <div className="genote-mode-toggle">
            <button
              className={`genote-mode-btn ${mode === 'global' ? 'active' : ''}`}
              onClick={() => setMode('global')}
              disabled={!globalNotesDir}
            >
              {tr('notes.gen.global')}
            </button>
            <button
              className={`genote-mode-btn ${mode === 'project' ? 'active' : ''}`}
              onClick={() => setMode('project')}
              disabled={projects.length === 0}
            >
              {tr('notes.gen.project')}
            </button>
          </div>

          {mode === 'project' && (
            <select
              className="genote-project-select"
              value={selectedProjectId}
              onChange={e => setSelectedProjectId(e.target.value)}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.icon} {p.displayName}
                </option>
              ))}
            </select>
          )}

          <div className="genote-save-path">
            {mode === 'global'
              ? globalNotesDir ?? '...'
              : selectedProject ? `${selectedProject.workDir}/docs/` : '...'
            }
          </div>
        </div>

        {/* Chat Area */}
        <div className="genote-chat-area">
          {entries.length === 0 && showPresets && (
            <div className="genote-presets">
              <div className="genote-presets-header">
                <span>{tr('notes.gen.presetsHint')}</span>
                <button className="genote-presets-close" onClick={() => setShowPresets(false)}>
                  <OctoX size={10} />
                </button>
              </div>
              <div className="genote-presets-grid">
                {TOPIC_PRESETS.map(cat => {
                  const isExpanded = expandedPresetCat === cat.label;
                  return (
                    <div key={cat.label} className="genote-preset-cat">
                      <button
                        className={`genote-preset-cat-btn ${isExpanded ? 'active' : ''}`}
                        onClick={() => setExpandedPresetCat(isExpanded ? null : cat.label)}
                      >
                        <span>{cat.icon}</span>
                        <span>{cat.label}</span>
                      </button>
                      {isExpanded && (
                        <div className="genote-preset-topics">
                          {cat.topics.map(t => (
                            <button
                              key={t}
                              className="genote-preset-topic"
                              onClick={() => {
                                void handleGenerate(t);
                              }}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {entries.length === 0 && !showPresets && (
            <div className="genote-empty">
              <span>{tr('notes.gen.emptyHint')}</span>
              <button className="genote-show-presets" onClick={() => setShowPresets(true)}>
                {tr('notes.gen.showPresets')}
              </button>
            </div>
          )}
          {entries.map((entry, i) => {
            switch (entry.type) {
              case 'user':
                return (
                  <div key={i} className="genote-chat-user">
                    <span className="genote-chat-user-icon">&gt;</span>
                    {entry.topic}
                  </div>
                );
              case 'status':
                return (
                  <div key={i} className="genote-chat-status">
                    <span className="genote-spinner" />
                    {entry.msg}
                  </div>
                );
              case 'result':
                return (
                  <div key={i} className="genote-chat-result">
                    <span className="genote-result-check">&#x2713;</span>
                    <button
                      className="genote-result-link"
                      onClick={() => onNoteCreated(entry.path)}
                    >
                      {entry.fileName}
                    </button>
                  </div>
                );
              case 'research':
                return (
                  <div key={i} className="genote-chat-research">
                    <Globe size={13} />
                    {entry.msg}
                  </div>
                );
              case 'error':
                return (
                  <div key={i} className="genote-chat-error">
                    &#x2717; {entry.msg}
                  </div>
                );
            }
          })}
          <div ref={chatEndRef} />
        </div>

        {/* Input Bar */}
        <div className="genote-input-bar">
          <input
            ref={inputRef}
            className="genote-input"
            type="text"
            placeholder={tr('notes.gen.inputPlaceholder')}
            value={topic}
            onChange={e => setTopic(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleGenerate(); }}
            disabled={isGenerating || isResearching}
          />
          <button
            className="genote-research-btn"
            onClick={() => void handleResearch()}
            disabled={isResearching || isGenerating || !topic.trim()}
            title={tr('notes.gen.researchBtnTitle')}
          >
            <Globe size={15} />
          </button>
          <button
            className="genote-send-btn"
            onClick={() => void handleGenerate()}
            disabled={isGenerating || isResearching || !topic.trim()}
            title={tr('notes.gen.generateBtnTitle')}
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
