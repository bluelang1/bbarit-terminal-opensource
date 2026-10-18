import type { BrokerReviewMode } from './devReviewPair';

export type BrokerUiLanguage = 'en' | 'ko';

export interface BrokerSettingsText {
  title: string;
  desc: string;
  developer: string;
  reviewer: string;
  language: string;
  reviewMode: string;
  reviewModeDesc: string;
  reviewModeOptions: Record<BrokerReviewMode, string>;
  browserReview: string;
  browserReviewDesc: string;
  optionEnglish: string;
  optionKorean: string;
  sameAgentWarning: string;
}

const TEXT: Record<BrokerUiLanguage, BrokerSettingsText> = {
  en: {
    title: 'Broker Agent',
    desc: 'Choose the CLI agents used as developer and reviewer. The broker harness uses this language for status and briefings.',
    developer: 'Developer',
    reviewer: 'Reviewer',
    language: 'Broker language',
    reviewMode: 'Review mode',
    reviewModeDesc: 'Controls whether the reviewer runs and how strict the technical review should be.',
    reviewModeOptions: {
      off: 'Off - skip reviewer',
      light: 'Light',
      normal: 'Normal',
      careful: 'Careful',
      very_careful: 'Very careful',
    },
    browserReview: 'BBARIT Browser test',
    browserReviewDesc: 'When on, reviewers must verify web-facing changes with BBARIT Browser snapshot, screenshot, console, network, and the changed flow before APPROVED.',
    optionEnglish: 'English',
    optionKorean: 'Korean',
    sameAgentWarning: 'Developer and reviewer are the same. Using different agents is recommended.',
  },
  ko: {
    title: '브로커 에이전트',
    desc: '개발자와 리뷰어로 사용할 CLI 에이전트를 고릅니다. 브로커 하네스는 이 언어로 상태와 브리핑을 표시합니다.',
    developer: '개발자',
    reviewer: '리뷰어',
    language: '브로커 언어',
    reviewMode: '리뷰 모드',
    reviewModeDesc: '리뷰어 실행 여부와 기술 검토 강도를 설정합니다.',
    reviewModeOptions: {
      off: '끄기 - 리뷰어 건너뛰기',
      light: '대충',
      normal: '보통',
      careful: '꼼꼼히',
      very_careful: '아주 꼼꼼히',
    },
    browserReview: '빠릿 브라우저 테스트',
    browserReviewDesc: '켜면 웹/프론트/네트워크/사용자 흐름 변경을 리뷰할 때 APPROVED 전에 빠릿 브라우저 snapshot, screenshot, console, network, 변경 흐름 검증이 필수입니다.',
    optionEnglish: '영어',
    optionKorean: '한국어',
    sameAgentWarning: '개발자와 리뷰어가 같습니다. 서로 다른 에이전트를 권장합니다.',
  },
};

export function brokerSettingsText(lang: BrokerUiLanguage): BrokerSettingsText {
  return TEXT[lang] || TEXT.en;
}
