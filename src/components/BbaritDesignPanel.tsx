import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { domToPng } from 'modern-screenshot';
import {
  Loader2, ArrowUp, Plus, Monitor, Tablet, Smartphone, MessageSquarePlus,
  RefreshCw, ExternalLink, LayoutGrid, ZoomIn, ZoomOut, Maximize2, Trash2, X,
  ImageDown, Paperclip, Image as ImageIcon, FolderOpen, Clapperboard, FileText, Disc,
  MousePointer2, StickyNote as StickyNoteIcon, Sparkles, Wand2, Zap, Palette, Blocks, MoreHorizontal, Columns3,
} from 'lucide-react';
import { useDesignAgent } from './useDesignAgent';
import {
  CANVAS_SCRIPT, CSS_TO_KEY, InspectorPanel, StickyNote, loadNotes,
  type InspectedElement, type DomTreeNode, type PendingEdit,
} from './DesignPencilTools';
import {
  FRAME_W, FRAME_H, FRAME_GAP, emptyPenDoc, frameOf, parsePenDoc, penDocPath, penId, penNodeBBox, serializePenDoc,
  syncFrames, translatePenNode,
  type PenAnnotation, type PenDoc, type PenFrameNode, type PenNode, type PenNodePatch, type PenNoteNode,
  type PenShapeNode,
} from './DesignPenDoc';
import { PenToolbar, PenStyleBar, PenShapeView, PenDraftView, PenDraftPath, type PenAlign, type PenTool } from './DesignPenCanvas';
import { vNodeBBox } from './vector/VectorDoc';
import { VectorRootView } from './vector/VectorRenderer';
import { subscribePanelInject, takePanelInject } from './panelInject';
import { makeLook, BrandMark, ChatRow, Thinking, ModelChip, type BbaritLook } from './bbaritLook';

// BBARIT Design — an agentic design studio in the Claude Design mold:
// narrow chat rail on the left, a large preview surface on the right with
// version tabs, device widths, a pannable canvas for variations, and
// click-to-comment pins. The agent follows the Claude Design workflow
// (clarify → build → verify → summarize extremely briefly) and its file
// discipline (descriptive names, v2 copies, minimal targeted edits).

export interface BbaritDesignPanelProps {
  projectRoot: string;
  theme: { bg: string; text: string; accent?: string };
  onOpenFile?: (path: string) => void;
}

interface DesignSession {
  id: string;
  title: string;
  dir: string;
  createdAt: number;
  preset?: string;
}

interface CommentItem {
  n: number;
  selector: string;
  tag: string;
  snippet: string;
  note: string;
}

interface PendingAttachment {
  id: number;
  name: string;
  b64: string;
  preview: string;
}

const MAX_SESSIONS = 40;
const DEVICES = [
  { key: 'full' as const, label: 'Desktop', icon: Monitor, width: null },
  { key: 'tablet' as const, label: 'Tablet', icon: Tablet, width: 768 },
  { key: 'mobile' as const, label: 'Mobile', icon: Smartphone, width: 390 },
];

const DESIGN_SYSTEM_PROMPT = `당신은 사용자를 매니저로 삼아 일하는 전문 디자이너입니다. HTML이 도구이고, 매체는 과제마다 다릅니다 — 슬라이드 디자이너, UX 디자이너, 프로토타이퍼, 애니메이터 등 그 분야 전문가로 임하세요. 웹페이지를 만드는 게 아니라면 웹 디자인 관습(히어로+3칼럼 등)을 답습하지 마세요. 내부 구현은 언급하지 않습니다.

[워크플로]
1. 질문: 완전히 새로운 작업이 모호하면 도구를 쓰지 말고 확인 질문만 하고 턴을 끝내세요 — 출발점(브랜드/디자인 시스템 유무), 시안 개수와 탐색 축(레이아웃/비주얼/카피), 분위기. 작은 수정·후속 요청이면 질문 없이 바로 진행합니다.
2. 탐색: 제공된 리소스(디자인 시스템, 코드, 이미지)를 전부 읽으세요. 스크린샷보다 코드가 진실입니다.
3. 제작: 모든 파일은 반드시 지정된 세션 폴더 안에만 저장합니다.
4. 검증: browser 도구로 file:// 경로를 열어 스크린샷·콘솔로 실제 렌더링을 확인하고, 깨진 부분을 고친 뒤 끝내세요.
5. 요약: 극도로 짧게 — 한두 문장, 주의사항과 다음 단계만. 채팅 패널이 좁으니 마크다운 표 금지, 불릿 남발 금지, 이모지 금지.

[파일 규칙]
- 브라우저에서 바로 열리는 완전 독립형 단일 .html (<!DOCTYPE html>로 시작, 외부 CDN 금지, CSS/JS/이미지 전부 인라인 — 이미지는 data URL로).
- 파일명은 주제 기반 설명적 이름으로: 'Landing Page.html', '온보딩 시안.html', '빠릿 에이전트 쇼츠.mp4' (공백 허용). draft/output/video/final/untitled/result 같은 일반명 금지 — 렌더·변환·병합 산출물도 예외 없이 주제로 명명하세요.
- 대규모 수정은 사본으로: 기존 파일을 복사해 '이름 v2.html'로 편집하고 원본을 보존하세요.
- 시안 여러 개를 요청받으면 서로 뚜렷이 다른 방향으로 각각 별도 파일에 저장하세요 ('이름 A.html', '이름 B.html'…) — 화면의 캔버스에 나란히 펼쳐집니다.
- 작은 수정 규율: 문구·색·요소 하나를 바꿔달라면 그것만 edit로 최소 변경하세요. 지목되지 않은 레이아웃/여백/폰트/크기/색은 그대로 두고, 요청받지 않은 "개선"은 하지 말고 완료 후 제안만 하세요.

[이미지 산출물]
- 포스터·카드뉴스·배너·썸네일·SNS 게시물처럼 최종 산출물이 '이미지'인 작업은 루트 컨테이너에 정확한 픽셀 크기를 고정하세요 (인스타 피드 1080×1350, 정방형 1080×1080, 스토리 1080×1920, 유튜브 썸네일 1280×720 등 용도에 맞게). html,body{margin:0}으로 두고 스크롤되는 웹페이지 형태로 만들지 마세요. 완성된 HTML은 앱이 같은 이름의 .png 이미지로 자동 저장해 사용자에게 전달합니다.
- 실사 사진·일러스트가 꼭 필요하면 generate_image 도구(OpenAI 키 필요)로 세션 폴더에 생성한 뒤 base64로 인코딩해(bash: base64 -i 파일) data URL로 임베드하세요. 키가 없으면 CSS 그래픽·패턴·타이포그래피 중심으로 해결하고 어설픈 대체 사진은 넣지 않습니다.
- 사용자가 첨부한 이미지는 프롬프트에 "경로"로 인용됩니다. 반드시 직접 확인하고, 디자인에 쓸 로고·자산이면 data URL로 임베드하며, 참고 시안이면 스타일 방향으로만 참고하세요.

[영상 산출물]
- 영상(쇼츠·모션그래픽·인트로·프로모·슬라이드 영상)을 요청받으면 먼저 bbarit-video 스킬을 read하고 HyperFrames로 제작하세요. bash로:
  1) npx -y hyperframes@latest init "<세션폴더>/video" --non-interactive — 사용자가 준 영상/오디오가 있으면 --video/--audio 옵션으로 포함
  2) 생성된 index.html·compositions/ 예제 구조를 먼저 읽고 그 형식 그대로 장면을 편집 (스킬의 규칙 엄수)
  3) npx -y hyperframes@latest lint 로 검사 후 npx -y hyperframes@latest render --quality standard --output "<세션폴더>/<주제 기반 이름>.mp4"
- 완성 .mp4는 반드시 세션 폴더 바로 아래에, 주제 기반 파일명으로 두세요 (예: '빠릿터미널 소개 쇼츠.mp4' — draft.mp4 금지). 화면에 자동으로 나타나고 사용자가 내장 영상 에디터로 이어서 편집·병합할 수 있습니다.
- 기존 영상 여러 개를 합쳐달라는 요청은 ffmpeg로 처리하세요 (동일 코덱·해상도면 concat demuxer, 다르면 scale+concat filter). 결과도 세션 폴더에 저장합니다.
- 렌더 실패 시 npx -y hyperframes@latest doctor 로 환경(Chrome/FFmpeg)을 점검하세요.

[오피스 산출물]
- 슬라이드 덱을 편집 가능한 PPTX 파일로도 달라고 하면 pptx 도구로 세션 폴더에 .pptx를 생성하세요 (각 슬라이드를 addText/addShape/addImage로 재구성, 화면 캡처 임베드 금지).

[콘텐츠 규율]
- 채움용 더미 콘텐츠 금지 — 모든 요소가 자리를 증명해야 합니다. 내용을 지어내지 말고, 섹션·카피 추가가 필요해 보이면 먼저 물어보세요.
- AI 티 나는 관습 금지: 과한 그라디언트, 이모지(브랜드가 쓰는 경우 제외), 둥근모서리+왼쪽 색 보더 카드, Inter/Roboto 남용, "X가 아니라 Y다"식 극적 제목.
- 색은 주어진 브랜드/디자인 시스템을 따르고, 없으면 oklch로 조화로운 팔레트를 구성하거나 대담한 미학 방향 하나(극단적 미니멀, 맥시멀, 에디토리얼, 레트로퓨처 등)에 전념하세요 — 매번 같은 선택으로 수렴하지 말 것.
- 형제 요소 배치는 flex/grid + gap. 한글: word-break: keep-all; overflow-wrap: break-word; line-height 1.4 이상, 여백 안에서 잘림 없이.
- 슬라이드 덱은 1920×1080, 슬라이드마다 <section>, 키보드 ←/→ 내비 내장, 본문 최소 24px, 제목 48px 이상.
- 타사의 고유 UI·브랜드 복제 요청은 거절하고 오리지널 디자인을 도우세요.\n- 사용자가 쓰는 언어로 응답하세요.`;

function sessionsKey(root: string) {
  return `claude-design-sessions:${(root || 'global').replace(/\/$/, '')}`;
}
function loadSessions(root: string): DesignSession[] {
  try {
    const raw = localStorage.getItem(sessionsKey(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is DesignSession =>
      typeof s?.id === 'string' && typeof s?.dir === 'string' && typeof s?.createdAt === 'number'
    ).slice(0, MAX_SESSIONS);
  } catch { return []; }
}
function saveSessions(root: string, items: DesignSession[]) {
  try { localStorage.setItem(sessionsKey(root), JSON.stringify(items.slice(0, MAX_SESSIONS))); } catch { /* quota */ }
}

// Injected into the single-file preview: comment pins, element inspection
// (layers + properties), and live style/text edits — see DesignPencilTools.
function withPinScript(html: string): string {
  if (!html) return '';
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${CANVAS_SCRIPT}</body>`);
  return html + CANVAS_SCRIPT;
}

function fileLabel(path: string) {
  return (path.split('/').pop() || path).replace(/\.html?$/i, '');
}

// Told to every agent run so it can read AND write the canvas — the same
// two-way design-file access pencil.dev gives agents over .pen files.
function penPromptLine(dir: string, designSystem?: string) {
  const ds = designSystem?.trim();
  return `[캔버스 디자인 파일] ${penDocPath(dir)} — 캔버스의 프레임 배치와 주석(도형·화살표·프리핸드 패스·텍스트·이미지·메모)이 담긴 JSON입니다. 캔버스 상태가 필요하면 read하고, 사용자 캔버스에 주석을 남기고 싶으면 nodes 배열에 {"id","type":"rect|ellipse|arrow|path|text|image|note",...} 항목을 추가하세요(앱이 자동 반영, 좌표는 px, 프레임 폭 ${FRAME_W}px, image의 file은 세션 폴더 기준 상대경로). 디자인 HTML 자체는 이 파일에 넣지 마세요.${ds ? `\n[디자인 시스템] ${ds} — 모든 시안이 이 디자인 시스템/브랜드 지침을 따라야 합니다. 파일 경로가 포함되어 있으면 반드시 read하세요.` : ''}`;
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const HTML_RE = /\.html?$/i;
const IMG_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
const VID_RE = /\.(mp4|webm|mov)$/i;
const OFFICE_RE = /\.(pptx|docx|xlsx|pdf)$/i;
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

// Specialist agent presets — each one narrows the designer into a purpose-built
// agent (extra system rules + an input hint). 'design' is the generalist.
interface DesignPreset {
  key: string;
  label: string;
  desc: string;
  hint: string;
  system: string;
}

const PRESETS: DesignPreset[] = [
  { key: 'design', label: 'Designer', desc: 'Anything visual — pick a specialist below or just ask', hint: '', system: '' },
  {
    key: 'shorts', label: 'Shorts Video', desc: '15–60s vertical MP4 with captions', hint: 'Shorts video — describe the topic, mood, and key message…',
    system: '[전문 모드: 쇼츠 영상 생성기]\n- 산출물은 1080×1920 세로 MP4입니다. 시작 전에 bbarit-video 스킬을 read하고 그대로 따르세요.\n- 15~60초, 훅(0~2초)→전개→마무리 구조. 큰 타이포, 캡션 필수, 장면 전환 규칙 엄수.\n- 렌더된 .mp4를 세션 폴더 바로 아래에 저장하세요.',
  },
  {
    key: 'advideo', label: 'Ad Video', desc: '15–30s product/brand commercial MP4', hint: 'Ad video — product, audience, and one key selling point…',
    system: '[전문 모드: 광고 영상 생성기]\n- 산출물은 15~30초 광고 MP4입니다 (송출처에 맞게 1920×1080 또는 1080×1920 — 불명확하면 질문). 시작 전에 bbarit-video 스킬을 read하고 그대로 따르세요.\n- 광고 구조: 문제 제기 훅(0~3초) → 제품/서비스 등장 → 핵심 혜택 1가지를 크게 → 디테일·소셜프루프 → 강한 CTA(로고+슬로건) 마무리.\n- 브랜드 색·로고가 첨부되면 그대로 쓰고, 없으면 제품 성격에 맞는 프리미엄 팔레트 하나에 전념. 카피는 짧고 단정적으로 — 과장 문구·이모지 금지.\n- 사용자가 제품 영상·사진을 첨부하면 컴포지션의 미디어 클립으로 통합하세요. 렌더된 .mp4는 세션 폴더 바로 아래 저장.',
  },
  {
    key: 'comic', label: '4-Cut Comic', desc: 'Four-panel comic strip image', hint: '4-cut comic — describe the story or situation…',
    system: '[전문 모드: 4컷만화]\n- 산출물은 세로 4컷 만화 1장(1080×2160, 컷당 1080×540)입니다.\n- 기승전결 구조, 마지막 컷에 펀치라인. 말풍선·효과선은 CSS로, 인물·배경은 generate_image(키 있으면) 또는 단순하고 일관된 CSS/SVG 일러스트로 — 컷 간 캐릭터 생김새가 반드시 일관돼야 합니다.\n- 대사는 짧게, 컷 번호를 달지 마세요.',
  },
  {
    key: 'cardnews', label: 'Card News', desc: 'Instagram carousel, one file per card', hint: 'Card news — topic and how many cards…',
    system: '[전문 모드: 카드뉴스]\n- 산출물은 인스타그램 1080×1350 카드 시리즈 — 카드마다 별도 HTML 파일("주제 1.html", "주제 2.html"…)로 저장해 캔버스에 나란히 펼쳐지게 하세요.\n- 1장: 표지(강한 훅) / 중간: 1카드 1메시지 / 마지막: 요약+CTA. 모든 카드가 같은 디자인 시스템을 공유해야 합니다.',
  },
  {
    key: 'slides', label: 'PowerPoint', desc: 'HTML deck + editable .pptx', hint: 'Presentation — topic, audience, and slide count…',
    system: '[전문 모드: 파워포인트 발표자료]\n- 먼저 1920×1080 HTML 덱(슬라이드마다 <section>, ←/→ 내비 내장)을 만들고, 이어서 pptx 도구로 편집 가능한 .pptx를 같은 세션 폴더에 생성하세요 (각 슬라이드를 addText/addShape/addImage로 재구성).\n- 슬라이드에 글을 욱여넣지 말 것 — 표·다이어그램·인용·큰 숫자로 시각적 리듬을 만드세요.',
  },
  {
    key: 'poster', label: 'Poster', desc: 'Bold fixed-size poster → PNG', hint: 'Poster — subject, copy, and size…',
    system: '[전문 모드: 포스터]\n- 고정 픽셀 캔버스의 이미지 산출물(용도에 맞는 크기 선택). 타이포그래피 중심의 대담한 레이아웃 하나에 전념하세요.',
  },
  {
    key: 'thumbnail', label: 'Thumbnail', desc: 'YouTube 1280×720, high CTR', hint: 'Thumbnail — video title and vibe…',
    system: '[전문 모드: 유튜브 썸네일]\n- 1280×720 고정. 3단어 이내 초대형 타이포, 강한 대비, 모바일에서도 읽히는 크기. 시안 2~3개를 별도 파일로.',
  },
  {
    key: 'landing', label: 'Landing Page', desc: 'Responsive product page', hint: 'Landing page — product or service…',
    system: '[전문 모드: 랜딩 페이지]\n- 반응형 웹페이지. 실제 카피를 쓰되 사실을 지어내지 말고, 콘텐츠가 부족하면 먼저 물어보세요.',
  },
  {
    key: 'logo', label: 'Logo', desc: '3 distinct directions, crisp SVG', hint: 'Logo — brand name and personality…',
    system: '[전문 모드: 로고]\n- 시안 3개를 서로 다른 방향(워드마크/심볼/엠블럼)으로 각각 별도 파일에. SVG로 그려 어떤 크기에도 선명하게, 단색 버전을 함께 보여주세요.',
  },
];

function dirOf(path: string) {
  return path.slice(0, path.lastIndexOf('/'));
}

// One-click remix directions: each chip commits the active design to one
// aesthetic, no typing needed.
const STYLE_DIRECTIONS = [
  { key: 'minimal', label: 'Ultra Minimal', desc: 'Extreme whitespace, typography-first, restrained monochrome' },
  { key: 'editorial', label: 'Editorial', desc: 'Magazine grid, serif headlines, strong hierarchy' },
  { key: 'luxury', label: 'Luxury', desc: 'Deep tones, metallic accents, high-end print density' },
  { key: 'retrofuture', label: 'Retro-Future', desc: 'Neon, grids and chrome — the future the 80s imagined' },
  { key: 'brutalist', label: 'Brutalist', desc: 'Exposed structure, raw contrast, monospace' },
  { key: 'playful', label: 'Playful Pop', desc: 'Bold primaries, big shapes, joyful rhythm' },
  { key: 'dark', label: 'Dark Premium', desc: 'Dark canvas with one high-contrast accent color' },
  { key: 'handcraft', label: 'Handcraft', desc: 'Hand-drawn textures, paper feel, organic shapes' },
];

// Built-in component blueprints: one click asks the agent to add the section
// to the active design, matched to its existing visual language.
const BUILTIN_COMPONENTS = [
  { key: 'navbar', label: 'Navbar', desc: 'Logo, links, CTA button' },
  { key: 'hero', label: 'Hero', desc: 'Headline, subcopy, primary CTA' },
  { key: 'features', label: 'Feature Grid', desc: '3–4 benefit cards' },
  { key: 'stats', label: 'Stats Row', desc: 'Big numbers with labels' },
  { key: 'testimonial', label: 'Testimonials', desc: 'Quotes with names and roles' },
  { key: 'pricing', label: 'Pricing Table', desc: '2–3 tiers, one highlighted' },
  { key: 'faq', label: 'FAQ', desc: 'Expandable question list' },
  { key: 'cta', label: 'CTA Banner', desc: 'Full-width closing call to action' },
  { key: 'footer', label: 'Footer', desc: 'Links, social, copyright' },
  { key: 'gallery', label: 'Gallery', desc: 'Grid of visuals' },
  { key: 'form', label: 'Contact Form', desc: 'Inputs, labels, submit' },
  { key: 'badges', label: 'Badge Set', desc: 'Pills, tags, status chips' },
];

// The design's natural pixel size. scrollWidth alone is wrong in both
// directions: it clamps to the viewport for overflow:hidden posters that are
// BIGGER than it, and it floors at the viewport for fixed-size content that is
// SMALLER than it (a 400×400 badge in a 1280px iframe reports 1280). So trust
// the body children's boxes and only fall back to scroll metrics when the page
// genuinely overflows (a scrolling landing page) or has no element children.
export function measureDesignSize(doc: Document): { w: number; h: number } {
  const de = doc.documentElement;
  let cw = 0;
  let ch = 0;
  for (const c of Array.from(doc.body.children)) {
    const r = c.getBoundingClientRect();
    cw = Math.max(cw, Math.ceil(r.right), Math.ceil(r.width));
    ch = Math.max(ch, Math.ceil(r.bottom), Math.ceil(r.height));
  }
  let w = cw > 0 ? cw : de.scrollWidth;
  let h = ch > 0 ? ch : de.scrollHeight;
  if (de.scrollWidth > de.clientWidth) w = Math.max(w, de.scrollWidth, doc.body.scrollWidth);
  if (de.scrollHeight > de.clientHeight) h = Math.max(h, de.scrollHeight, doc.body.scrollHeight);
  return { w: Math.min(Math.max(w, 100), 4096), h: Math.min(Math.max(h, 100), 8192) };
}

// Session HTML may reference images the agent saved next to it. srcDoc has no
// base URL, so rewrite relative src/href to the Tauri asset protocol.
export function resolveRelativeAssets(html: string, dir: string): string {
  if (!html) return '';
  return html.replace(/(src|href)=("|')(?!https?:|data:|blob:|asset:|#|\/\/)([^"']+)\2/gi, (m, attr, q, rel) => {
    if (!IMG_RE.test(rel) && !/\.(mp4|webm|woff2?|ttf|otf)(\?|$)/i.test(rel)) return m;
    const abs = rel.startsWith('/') ? rel : `${dir}/${rel}`;
    return `${attr}=${q}${convertFileSrc(abs)}${q}`;
  });
}

// Render a self-contained design HTML in an offscreen same-origin iframe and
// rasterize it to a PNG data URL at the design's natural size (2x).
async function rasterizeHtml(html: string, dir: string): Promise<string> {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.style.cssText = 'position:fixed;left:-12000px;top:0;width:1280px;height:800px;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(frame);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('render timeout')), 20000);
      frame.onload = () => { clearTimeout(t); resolve(); };
      frame.srcdoc = resolveRelativeAssets(html, dir);
    });
    const doc = frame.contentDocument;
    if (!doc?.documentElement || !doc.body) throw new Error('preview did not render');
    await (doc as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.catch(() => {});
    await Promise.all(Array.from(doc.images).filter((i) => !i.complete)
      .map((i) => new Promise((r) => { i.onload = i.onerror = () => r(null); })));
    const measure = () => measureDesignSize(doc);
    let { w, h } = measure();
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    await new Promise((r) => setTimeout(r, 400));
    ({ w, h } = measure());
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    return await domToPng(doc.documentElement, { width: w, height: h, scale: 2 });
  } finally {
    frame.remove();
  }
}

export function BbaritDesignPanel({ projectRoot, theme, onOpenFile }: BbaritDesignPanelProps) {
  const agent = useDesignAgent(projectRoot, 'bbarit-design');
  const L = useMemo(() => makeLook(theme), [theme]);
  const [input, setInput] = useState('');
  const [sessions, setSessions] = useState<DesignSession[]>(() => loadSessions(projectRoot));
  const [activeSessionId, setActiveSessionId] = useState<string | null>(() => loadSessions(projectRoot)[0]?.id ?? null);
  const [files, setFiles] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [htmlByPath, setHtmlByPath] = useState<Record<string, string>>({});
  const [device, setDevice] = useState<'full' | 'tablet' | 'mobile'>('full');
  const [canvasMode, setCanvasMode] = useState(false);
  const [pan, setPan] = useState({ x: 36, y: 36 });
  const [zoom, setZoom] = useState(0.35);
  const [dragging, setDragging] = useState(false);
  const [commentMode, setCommentMode] = useState(false);
  const [comments, setComments] = useState<Record<string, CommentItem[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [exporting, setExporting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [presetKey, setPresetKey] = useState('design');
  // Simple mode by default: only the everyday actions show. Pro reveals the
  // full pencil toolset (inspect, notes, variations, comments, components).
  const [proMode, setProMode] = useState(() => localStorage.getItem('bbarit-design-pro') === '1');
  const togglePro = useCallback(() => {
    setProMode((v) => {
      try { localStorage.setItem('bbarit-design-pro', v ? '0' : '1'); } catch { /* quota */ }
      return !v;
    });
  }, []);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [pvZoom, setPvZoom] = useState<'fit' | number>('fit');
  const [contentSize, setContentSize] = useState<{ w: number; h: number } | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);
  // Pencil-style tooling: element inspector (layers + properties) and
  // sticky-note prompt blocks on the variations canvas.
  const [inspectMode, setInspectMode] = useState(false);
  const [inspected, setInspected] = useState<InspectedElement | null>(null);
  const [domTree, setDomTree] = useState<DomTreeNode | null>(null);
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([]);
  // .pen design doc (pencil.dev-style): canvas nodes persisted to the session
  // folder so the design agent reads & writes the same canvas the user sees.
  const [penDoc, setPenDoc] = useState<PenDoc | null>(null);
  const [tool, setTool] = useState<PenTool>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [draftPath, setDraftPath] = useState<number[][] | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const penDocDiskRef = useRef('');
  const penDocDirRef = useRef<string | null>(null);
  // Draw geometry lives in refs (state only mirrors it for painting) so the
  // commit on pointerup never depends on render timing.
  const drawRef = useRef<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const drawPathRef = useRef<number[][] | null>(null);
  const marqueeRef = useRef<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const frameDragRef = useRef<{ name: string; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const moveSnapRef = useRef<Map<string, PenNode>>(new Map());
  // Direct manipulation: double-click a canvas frame to edit the design
  // itself — element selection, drag-to-move, inline text — inside the frame.
  const [editFrame, setEditFrame] = useState<string | null>(null);
  const editFrameRef = useRef<HTMLIFrameElement | null>(null);
  // Measured natural page height per file: canvas frames stretch to the full
  // document so long pages are visible (and markable) below the fold.
  const [frameHeights, setFrameHeights] = useState<Record<string, number>>({});

  const measureFrame = useCallback((path: string, el: HTMLIFrameElement) => {
    window.setTimeout(() => {
      try {
        const doc = el.contentDocument;
        if (!el.isConnected || !doc?.body || !doc.documentElement) return;
        const { h } = measureDesignSize(doc);
        const next = Math.min(Math.max(h, FRAME_H), 8192);
        setFrameHeights((prev) => (Math.abs((prev[path] ?? 0) - next) <= 4 ? prev : { ...prev, [path]: next }));
      } catch { /* sandboxed */ }
    }, 300);
  }, []);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const attachIdRef = useRef(1);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pvContainerRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId) || null;
  const pathComments = activePath ? (comments[activePath] || []) : [];
  const busy = agent.busy;
  const activeKind = !activePath ? null
    : IMG_RE.test(activePath) ? 'image' as const
    : VID_RE.test(activePath) ? 'video' as const
    : 'html' as const;
  const activeIsImage = activeKind === 'image';

  // ── Canvas history: snapshot-based undo/redo. Continuous gestures (drags,
  // note typing) share an op key so they collapse into one undo step; the op
  // key resets on pointerup, making the next drag a fresh entry. ──
  const penDocLiveRef = useRef<PenDoc | null>(null);
  useEffect(() => { penDocLiveRef.current = penDoc; }, [penDoc]);
  const historyRef = useRef<{ past: string[]; future: string[]; lastOp: string }>({ past: [], future: [], lastOp: '' });

  const beginOp = useCallback((opKey: string) => {
    const doc = penDocLiveRef.current;
    if (!doc) return;
    const h = historyRef.current;
    if (opKey && h.lastOp === opKey) return;
    h.lastOp = opKey;
    const snap = serializePenDoc(doc);
    if (h.past[h.past.length - 1] === snap) return;
    h.past.push(snap);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
  }, []);

  const undo = useCallback(() => {
    const doc = penDocLiveRef.current;
    const h = historyRef.current;
    const snap = h.past.pop();
    if (!snap || !doc) return;
    h.future.push(serializePenDoc(doc));
    if (h.future.length > 100) h.future.shift();
    h.lastOp = '';
    setPenDoc(parsePenDoc(snap));
    setSelectedIds([]);
  }, []);

  const redo = useCallback(() => {
    const doc = penDocLiveRef.current;
    const h = historyRef.current;
    const snap = h.future.pop();
    if (!snap || !doc) return;
    h.past.push(serializePenDoc(doc));
    if (h.past.length > 100) h.past.shift();
    h.lastOp = '';
    setPenDoc(parsePenDoc(snap));
    setSelectedIds([]);
  }, []);

  // ── .pen doc: load per session (migrating legacy localStorage notes once),
  // save debounced, and adopt agent edits straight from disk ──
  useEffect(() => {
    setPenDoc(null); setSelectedIds([]); setEditingTextId(null); setDraft(null); setDraftPath(null); setMarquee(null); setTool('select');
    setFrameHeights({});
    historyRef.current = { past: [], future: [], lastOp: '' };
    penDocDiskRef.current = '';
    penDocDirRef.current = activeSession?.dir ?? null;
    if (!activeSession) return;
    const { dir, id: sid } = activeSession;
    let cancelled = false;
    void (async () => {
      let doc = emptyPenDoc();
      try {
        const raw = await invoke<string>('read_file', { path: penDocPath(dir) });
        penDocDiskRef.current = raw;
        doc = parsePenDoc(raw);
      } catch {
        doc.nodes = loadNotes(sid).map((n) => ({ id: n.id, type: 'note' as const, x: n.x, y: n.y, text: n.text }));
      }
      if (!cancelled && penDocDirRef.current === dir) setPenDoc(doc);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.dir, activeSession?.id]);

  useEffect(() => {
    if (!penDoc || !activeSession || penDocDirRef.current !== activeSession.dir) return;
    const json = serializePenDoc(penDoc);
    if (json === penDocDiskRef.current) return;
    const dir = activeSession.dir;
    const t = setTimeout(() => {
      penDocDiskRef.current = json;
      void invoke('write_file', { path: penDocPath(dir), content: json }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [penDoc, activeSession]);

  const reloadPenDoc = useCallback(async (dir: string) => {
    try {
      const raw = await invoke<string>('read_file', { path: penDocPath(dir) });
      if (raw !== penDocDiskRef.current && penDocDirRef.current === dir) {
        beginOp('');
        penDocDiskRef.current = raw;
        setPenDoc(parsePenDoc(raw));
      }
    } catch { /* not created yet */ }
  }, [beginOp]);

  const patchNode = useCallback((id: string, patch: PenNodePatch) => {
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.map((n) => n.id === id ? { ...n, ...patch } as PenNode : n) } : prev);
  }, []);
  const removeNode = useCallback((id: string) => {
    beginOp('');
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.filter((n) => n.id !== id) } : prev);
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }, [beginOp]);
  const addNode = useCallback((node: PenNode) => {
    beginOp('');
    setPenDoc((prev) => prev ? { ...prev, nodes: [...prev.nodes, node].slice(-400) } : prev);
  }, [beginOp]);
  const moveFrame = useCallback((name: string, x: number, y: number) => {
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.map((n) => n.type === 'frame' && n.file === name ? { ...n, x, y } : n) } : prev);
  }, []);

  // ── Multi-selection: body drags move every selected node together from a
  // snapshot taken at grab, so deltas never compound ──
  const onNodeDragStart = useCallback((id: string, additive: boolean) => {
    const doc = penDocLiveRef.current;
    if (!doc) return;
    setSelectedIds((prev) => {
      const next = additive
        ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
        : (prev.includes(id) ? prev : [id]);
      const sel = new Set(next);
      moveSnapRef.current = new Map(doc.nodes.filter((n) => sel.has(n.id)).map((n) => [n.id, n]));
      return next;
    });
    beginOp(`move-${id}`);
  }, [beginOp]);

  const onNodesMoveBy = useCallback((dx: number, dy: number) => {
    const snap = moveSnapRef.current;
    if (snap.size === 0) return;
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.map((n) => {
      const s = snap.get(n.id);
      return s ? translatePenNode(s, dx, dy) : n;
    }) } : prev);
  }, []);

  const removeSelected = useCallback(() => {
    if (selectedIds.length === 0) return;
    beginOp('');
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.filter((n) => !selectedIds.includes(n.id) || n.type === 'frame') } : prev);
    setSelectedIds([]);
  }, [selectedIds, beginOp]);

  const duplicateSelected = useCallback(() => {
    const doc = penDocLiveRef.current;
    if (!doc || selectedIds.length === 0) return;
    const clones = doc.nodes
      .filter((n) => selectedIds.includes(n.id) && n.type !== 'frame')
      .map((n) => ({ ...translatePenNode(n, 24, 24), id: penId(n.type[0]) }));
    if (clones.length === 0) return;
    beginOp('');
    setPenDoc((prev) => prev ? { ...prev, nodes: [...prev.nodes, ...clones].slice(-400) } : prev);
    setSelectedIds(clones.map((c) => c.id));
  }, [selectedIds, beginOp]);

  const alignSelected = useCallback((kind: PenAlign) => {
    const doc = penDocLiveRef.current;
    if (!doc) return;
    const boxes = doc.nodes
      .filter((n) => selectedIds.includes(n.id) && n.type !== 'frame')
      .map((n) => ({ n, b: penNodeBBox(n) }));
    if (boxes.length < 2) return;
    const minX = Math.min(...boxes.map(({ b }) => b.x));
    const maxX = Math.max(...boxes.map(({ b }) => b.x + b.w));
    const minY = Math.min(...boxes.map(({ b }) => b.y));
    const maxY = Math.max(...boxes.map(({ b }) => b.y + b.h));
    const moved = new Map<string, PenNode>();
    for (const { n, b } of boxes) {
      let dx = 0;
      let dy = 0;
      if (kind === 'left') dx = minX - b.x;
      else if (kind === 'right') dx = maxX - (b.x + b.w);
      else if (kind === 'hcenter') dx = (minX + maxX) / 2 - (b.x + b.w / 2);
      else if (kind === 'top') dy = minY - b.y;
      else if (kind === 'bottom') dy = maxY - (b.y + b.h);
      else dy = (minY + maxY) / 2 - (b.y + b.h / 2);
      if (dx || dy) moved.set(n.id, translatePenNode(n, dx, dy));
    }
    if (moved.size === 0) return;
    beginOp('');
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.map((n) => moved.get(n.id) ?? n) } : prev);
  }, [selectedIds, beginOp]);

  // Z-order: annotations render in .pen node order, so front/back is an
  // array reorder (frames render on their own layer and are unaffected).
  const reorderSelected = useCallback((where: 'front' | 'back') => {
    const doc = penDocLiveRef.current;
    if (!doc || selectedIds.length === 0) return;
    const sel = new Set(selectedIds);
    const picked = doc.nodes.filter((n) => sel.has(n.id) && n.type !== 'frame');
    if (picked.length === 0) return;
    beginOp('');
    setPenDoc((prev) => {
      if (!prev) return prev;
      const rest = prev.nodes.filter((n) => !sel.has(n.id) || n.type === 'frame');
      return { ...prev, nodes: where === 'front' ? [...rest, ...picked] : [...picked, ...rest] };
    });
  }, [selectedIds, beginOp]);

  const noteNodes = useMemo(() => (penDoc?.nodes.filter((n): n is PenNoteNode => n.type === 'note') ?? []), [penDoc]);
  const shapeNodes = useMemo(
    () => (penDoc?.nodes.filter((n): n is PenAnnotation =>
      n.type === 'rect' || n.type === 'ellipse' || n.type === 'arrow' || n.type === 'text' || n.type === 'path' || n.type === 'image') ?? []),
    [penDoc],
  );
  const selectedNodes = useMemo(() => (penDoc?.nodes ?? []).filter((n) => selectedIds.includes(n.id)), [penDoc, selectedIds]);

  // ── Zoom-to-fit: frame the .pen content whenever the canvas opens, so a
  // stale pan/zoom never greets the user with an empty viewport ──
  const canvasElRef = useRef<HTMLDivElement>(null);
  const [fitTick, setFitTick] = useState(0);

  const fitCanvas = useCallback(() => {
    const el = canvasElRef.current;
    if (!el) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (x1: number, y1: number, x2: number, y2: number) => {
      minX = Math.min(minX, x1); minY = Math.min(minY, y1);
      maxX = Math.max(maxX, x2); maxY = Math.max(maxY, y2);
    };
    for (const n of penDoc?.nodes ?? []) {
      const b = penNodeBBox(n);
      if (n.type === 'frame') {
        const h = (activeSession ? frameHeights[`${activeSession.dir}/${n.file}`] : undefined) ?? FRAME_H;
        grow(b.x, b.y - 54, b.x + b.w, b.y + h + 54);
      } else {
        grow(b.x, b.y, b.x + b.w, b.y + b.h);
      }
    }
    for (const r of penDoc?.scene?.roots ?? []) {
      const b = vNodeBBox(r);
      grow(b.x, b.y - 54, b.x + b.w, b.y + b.h + 54);
    }
    if (!Number.isFinite(minX)) { setZoom(0.35); setPan({ x: 36, y: 36 }); return; }
    const r = el.getBoundingClientRect();
    const z = Math.min(1, Math.max(0.12, Math.min((r.width - 90) / (maxX - minX), (r.height - 90) / (maxY - minY))));
    setZoom(z);
    setPan({ x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z });
  }, [penDoc, frameHeights, activeSession]);

  const requestCanvasFit = useCallback(() => {
    setCanvasMode(true);
    setFitTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!canvasMode) return;
    // Waits a beat so the canvas div and freshly synced frames are in place.
    const t = setTimeout(fitCanvas, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasMode, fitTick]);

  // Canvas keyboard shortcuts (pencil-style): V/D/R/O/A/T/N pick tools,
  // ⌫ deletes, ⌘Z/⇧⌘Z undo/redo, ⌘D duplicates.
  useEffect(() => {
    if (!canvasMode) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
      if (mod || e.altKey) return;
      if (k === 'v') setTool('select');
      else if (k === 'd') setTool('draw');
      else if (k === 'r') setTool('rect');
      else if (k === 'o') setTool('ellipse');
      else if (k === 'a') setTool('arrow');
      else if (k === 't') setTool('text');
      else if (k === 'n') setTool('note');
      else if (e.key === ']' && selectedIds.length > 0) { e.preventDefault(); reorderSelected('front'); }
      else if (e.key === '[' && selectedIds.length > 0) { e.preventDefault(); reorderSelected('back'); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) { e.preventDefault(); removeSelected(); }
      else if (e.key === 'Escape') { setEditFrame(null); setSelectedIds([]); setEditingTextId(null); setTool('select'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canvasMode, selectedIds, removeSelected, duplicateSelected, reorderSelected, undo, redo]);

  // A finished pointer gesture closes the current history op, so the next
  // drag or keystroke burst becomes its own undo step.
  useEffect(() => {
    if (!canvasMode) return;
    const up = () => { historyRef.current.lastOp = ''; };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [canvasMode]);

  // Paste an image from the clipboard (including bitmaps copied out of Figma)
  // straight onto the canvas: saved under the session's assets/, added as an
  // image node at the viewport center.
  useEffect(() => {
    if (!canvasMode || !activeSession) return;
    const dir = activeSession.dir;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (!file) return;
      e.preventDefault();
      const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const b64 = url.split(',')[1];
        if (!b64) return;
        const img = new Image();
        img.onload = () => {
          void (async () => {
            const name = `assets/canvas-${Date.now().toString(36)}.${ext}`;
            await invoke('create_directory', { path: `${dir}/assets` }).catch(() => {});
            try { await invoke('write_file_base64', { path: `${dir}/${name}`, base64Data: b64 }); } catch { return; }
            const scale = Math.min(1, 900 / Math.max(img.naturalWidth, 1));
            const w = Math.max(24, Math.round(img.naturalWidth * scale));
            const h = Math.max(24, Math.round(img.naturalHeight * scale));
            const r = canvasElRef.current?.getBoundingClientRect();
            const cx = r ? (r.width / 2 - pan.x) / zoom : 0;
            const cy = r ? (r.height / 2 - pan.y) / zoom : 0;
            const id = penId('i');
            addNode({ id, type: 'image', file: name, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h });
            setSelectedIds([id]);
          })();
        };
        img.src = url;
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [canvasMode, activeSession, pan, zoom, addNode]);

  // sessionsRoot travels with the sessions state so the save effect only
  // writes once `sessions` was loaded for the current projectRoot — otherwise
  // a projectRoot change clobbers the new root's storage with the old list.
  const [sessionsRoot, setSessionsRoot] = useState(projectRoot);
  useEffect(() => {
    const items = loadSessions(projectRoot);
    setSessions(items);
    setSessionsRoot(projectRoot);
    setActiveSessionId(items[0]?.id ?? null);
    setActivePath(null);
    setFiles([]);
  }, [projectRoot]);

  useEffect(() => {
    if (sessionsRoot !== projectRoot) return;
    saveSessions(projectRoot, sessions);
  }, [projectRoot, sessionsRoot, sessions]);

  // History thumbnails: lazily find one image per session (prefer the PNG
  // export). '' marks a scanned session with nothing to show yet; the active
  // session is re-scanned so fresh exports show up.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const s of sessions) {
        if (thumbs[s.id] !== undefined && s.id !== activeSessionId) continue;
        try {
          const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>('read_directory', { path: s.dir });
          const imgs = entries.filter((e) => !e.is_dir && IMG_RE.test(e.name)).map((e) => e.path);
          const png = imgs.find((p) => /\.png$/i.test(p)) ?? imgs[0] ?? '';
          if (!cancelled) setThumbs((prev) => (prev[s.id] === png ? prev : { ...prev, [s.id]: png }));
        } catch {
          if (!cancelled) setThumbs((prev) => (prev[s.id] === '' ? prev : { ...prev, [s.id]: '' }));
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, activeSessionId, busy]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [agent.log.length, agent.activity]);

  // Prompt box grows with its content (min 3 lines, capped) — covers typing,
  // programmatic injects, and the reset after send.
  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(240, Math.max(66, el.scrollHeight))}px`;
  }, [input]);

  const refreshFiles = useCallback(async (dir: string | null): Promise<string[]> => {
    if (!dir) { setFiles([]); return []; }
    try {
      const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>('read_directory', { path: dir });
      const list = entries
        .filter((e) => !e.is_dir && (HTML_RE.test(e.name) || IMG_RE.test(e.name) || VID_RE.test(e.name) || OFFICE_RE.test(e.name)))
        .map((e) => e.path)
        .sort((a, b) => a.localeCompare(b));
      setFiles(list);
      return list;
    } catch {
      setFiles([]);
      return [];
    }
  }, []);

  const loadHtml = useCallback(async (paths: string[]) => {
    const next: Record<string, string> = {};
    await Promise.all(paths.filter((p) => HTML_RE.test(p)).map(async (p) => {
      try { next[p] = await invoke<string>('read_file', { path: p }); } catch { /* still streaming */ }
    }));
    setHtmlByPath((prev) => ({ ...prev, ...next }));
    return next;
  }, []);

  // Export a design HTML to a sibling PNG at its natural size.
  const exportPng = useCallback(async (path: string, html?: string): Promise<string> => {
    const source = html ?? await invoke<string>('read_file', { path });
    if (!source) throw new Error('empty file');
    const dataUrl = await rasterizeHtml(source, dirOf(path));
    const out = path.replace(HTML_RE, '.png');
    await invoke('write_file_base64', { path: out, base64Data: dataUrl.split(',')[1] || '' });
    return out;
  }, []);

  const exportPngNoted = useCallback(async (paths: string[], htmlMap?: Record<string, string>) => {
    if (paths.length === 0) return;
    setExporting(true);
    try {
      for (const p of paths) {
        try {
          const out = await exportPng(p, htmlMap?.[p]);
          agent.note('sys', `🖼 ${out.split('/').pop()} saved`);
        } catch (e) {
          agent.note('sys', `⚠ PNG export failed (${fileLabel(p)}): ${e instanceof Error ? e.message : e}`);
        }
      }
    } finally {
      setExporting(false);
    }
  }, [exportPng, agent]);

  useEffect(() => {
    void (async () => {
      const list = await refreshFiles(activeSession?.dir ?? null);
      await loadHtml(list);
      setActivePath((prev) => (prev && list.includes(prev) ? prev : list[0] ?? null));
    })();
  }, [activeSession?.dir, refreshFiles, loadHtml]);

  // Live paint: while the agent works, keep re-reading the session so the
  // design shows up as it streams into the file.
  useEffect(() => {
    if (!busy || !activeSession) return;
    const t = setInterval(() => {
      void (async () => {
        const list = await refreshFiles(activeSession.dir);
        await loadHtml(list);
        await reloadPenDoc(activeSession.dir);
        setActivePath((prev) => (prev && list.includes(prev) ? prev : list[list.length - 1] ?? null));
      })();
    }, 1300);
    return () => clearInterval(t);
  }, [busy, activeSession, refreshFiles, loadHtml, reloadPenDoc]);

  // Receive pin picks, inspected elements, and DOM trees from the preview iframe.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data || {};
      if (d.__cd === 'picked' && activePath) {
        setComments((prev) => {
          const list = prev[activePath] || [];
          if (list.some((c) => c.n === d.n)) return prev;
          return { ...prev, [activePath]: [...list, { n: d.n, selector: String(d.selector || ''), tag: String(d.tag || ''), snippet: String(d.text || ''), note: '' }] };
        });
      } else if (d.__cd === 'inspected') {
        setInspected({
          selector: String(d.selector || ''), tag: String(d.tag || ''), text: String(d.text || ''),
          direct: !!d.direct, styles: (d.styles && typeof d.styles === 'object') ? d.styles : {},
        });
      } else if (d.__cd === 'tree') {
        setDomTree(d.root ?? null);
      } else if (d.__cd === 'moved') {
        const id = `${d.selector}|move`;
        setPendingEdits((prev) => [...prev.filter((x) => x.id !== id),
          { id, selector: String(d.selector || ''), tag: String(d.tag || ''), kind: 'move', value: `${d.dx || 0},${d.dy || 0}` }]);
      } else if (d.__cd === 'text-inline') {
        const id = `${d.selector}|text|text`;
        setPendingEdits((prev) => [...prev.filter((x) => x.id !== id),
          { id, selector: String(d.selector || ''), tag: String(d.tag || ''), kind: 'text', value: String(d.text || '') }]);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [activePath]);

  const postToPreview = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);
  // Inspect messages go to whichever surface is live: the canvas frame being
  // edited, or the single preview.
  const postInspect = useCallback((msg: Record<string, unknown>) => {
    if (editFrame) editFrameRef.current?.contentWindow?.postMessage(msg, '*');
    else iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, [editFrame]);

  useEffect(() => { postToPreview({ __cd: 'enable', on: commentMode }); }, [commentMode, postToPreview]);
  useEffect(() => { postToPreview({ __cd: 'inspect-enable', on: inspectMode }); }, [inspectMode, postToPreview]);
  useEffect(() => {
    if (!inspectMode) { setInspected(null); setDomTree(null); return; }
    const t = setTimeout(() => postToPreview({ __cd: 'get-tree' }), 300);
    return () => clearTimeout(t);
  }, [inspectMode, activePath, postToPreview]);
  // Switching files or sessions drops any un-applied live edits (they only
  // existed inside the previous iframe).
  useEffect(() => { setPendingEdits([]); setInspected(null); }, [activePath, activeSessionId]);
  useEffect(() => { if (!canvasMode) setEditFrame(null); }, [canvasMode]);
  useEffect(() => { setEditFrame(null); }, [activeSessionId]);
  useEffect(() => {
    setInspected(null); setDomTree(null); setPendingEdits([]);
    if (editFrame) {
      const t = setTimeout(() => {
        editFrameRef.current?.contentWindow?.postMessage({ __cd: 'inspect-enable', on: true }, '*');
        editFrameRef.current?.contentWindow?.postMessage({ __cd: 'get-tree' }, '*');
      }, 350);
      return () => clearTimeout(t);
    }
  }, [editFrame]);

  const inspectorSelect = useCallback((sel: string) => {
    postInspect({ __cd: 'select', selector: sel });
  }, [postInspect]);

  const inspectorEdit = useCallback((kind: 'style' | 'text', prop: string | undefined, value: string) => {
    if (!inspected) return;
    if (kind === 'style' && prop) postInspect({ __cd: 'set-style', selector: inspected.selector, prop, value });
    else if (kind === 'text') postInspect({ __cd: 'set-text', selector: inspected.selector, text: value });
    setPendingEdits((prev) => {
      const id = `${inspected.selector}|${kind}|${prop || 'text'}`;
      const next = prev.filter((e) => e.id !== id);
      return [...next, { id, selector: inspected.selector, tag: inspected.tag, kind, prop, value }];
    });
    if (kind === 'style' && prop) {
      setInspected((prev) => prev ? { ...prev, styles: { ...prev.styles, [CSS_TO_KEY[prop] || prop]: value } } : prev);
    }
  }, [inspected, postInspect]);

  // Land the previewed live edits in the actual file through the agent — the
  // same one-way canvas→code hand-off pencil.dev uses.
  const applyPendingEdits = useCallback(async () => {
    if (!activePath || busy || pendingEdits.length === 0) return;
    setError(null);
    const items = pendingEdits.map((e) => e.kind === 'text'
      ? `- 요소 (${e.selector}) → 텍스트를 "${e.value}" 로 변경`
      : e.kind === 'move'
        ? `- 요소 (${e.selector}) → 현재 위치에서 x ${e.value.split(',')[0]}px, y ${e.value.split(',')[1]}px 이동 (미리보기는 transform이었지만 실제 코드는 레이아웃 맥락에 맞게 margin·position·flex 순서/정렬로 자연스럽게 반영)`
        : `- 요소 (${e.selector}) → CSS ${e.prop}: ${e.value}`).join('\n');
    agent.note('you', `Apply ${pendingEdits.length} canvas edit${pendingEdits.length > 1 ? 's' : ''}`);
    const result = await agent.run(`${DESIGN_SYSTEM_PROMPT}

[작업] ${activePath} 파일을 read 한 뒤, 아래 캔버스 편집 내역을 그대로 반영하세요. 각 항목은 이미 미리보기에서 확정된 변경이므로 질문 없이 적용합니다. 인라인 style 속성보다 기존 CSS 규칙/클래스를 수정하는 쪽을 우선하되, 다른 요소에 영향을 주면 안 됩니다. 지목되지 않은 부분은 그대로 두고 edit로 최소 변경만 하세요.

[캔버스 편집 내역]
${items}`);
    if (!result.ok) { setError(result.error || 'The edit did not finish.'); return; }
    setPendingEdits([]);
    await loadHtml([activePath]);
    agent.note('sys', '✓ canvas edits applied');
    await exportPngNoted([activePath]);
  }, [activePath, busy, pendingEdits, agent, loadHtml, exportPngNoted]);

  const discardPendingEdits = useCallback(() => {
    setPendingEdits([]);
    // Re-render the preview from the untouched source html.
    setHtmlByPath((prev) => ({ ...prev }));
    if (activePath) void loadHtml([activePath]);
  }, [activePath, loadHtml]);

  // ── Apply Marks: hand every canvas annotation to the agent in one click.
  // Each mark is attributed to the frame it sits on (with frame-relative px
  // coordinates); on success the instructional marks are cleared (undo-able),
  // while pasted reference images stay. ──
  const markCount = useMemo(
    () => shapeNodes.filter((n) => n.type !== 'image').length,
    [shapeNodes],
  );

  const applyAnnotations = useCallback(async () => {
    const doc = penDocLiveRef.current;
    const session = activeSession;
    if (!doc || !session || busy) return;
    const marks = doc.nodes.filter((n): n is PenAnnotation =>
      n.type === 'rect' || n.type === 'ellipse' || n.type === 'arrow' || n.type === 'path' || n.type === 'text' || n.type === 'image');
    const instr = marks.filter((m) => m.type !== 'image');
    if (instr.length === 0) return;
    setError(null);
    const frames = doc.nodes.filter((n): n is PenFrameNode => n.type === 'frame');
    const frameFor = (m: PenAnnotation): PenFrameNode | null => {
      const b = penNodeBBox(m);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      let best: PenFrameNode | null = null;
      let bestDist = Infinity;
      for (const f of frames) {
        const fh = frameHeights[`${session.dir}/${f.file}`] ?? FRAME_H;
        const dx = Math.max(f.x - cx, 0, cx - (f.x + FRAME_W));
        const dy = Math.max(f.y - cy, 0, cy - (f.y + fh));
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) { bestDist = dist; best = f; }
      }
      return bestDist <= 400 ? best : null;
    };
    const describe = (m: PenAnnotation, f: PenFrameNode | null): string => {
      const b = penNodeBBox(m);
      const ox = f?.x ?? 0;
      const oy = f?.y ?? 0;
      const at = `(${Math.round(b.x - ox)},${Math.round(b.y - oy)})`;
      const size = `${Math.round(b.w)}×${Math.round(b.h)}`;
      switch (m.type) {
        case 'text': return `- 텍스트 메모 ${at}: "${m.text}"`;
        case 'arrow': return `- 화살표 (${Math.round(m.x - ox)},${Math.round(m.y - oy)}) → (${Math.round(m.x2 - ox)},${Math.round(m.y2 - oy)}) — 화살촉이 가리키는 요소가 대상`;
        case 'rect': return `- 사각형 마크 ${at} 크기 ${size} — 이 영역이 대상`;
        case 'ellipse': return `- 원형 마크 ${at} 크기 ${size} — 이 영역이 대상`;
        case 'path': return `- 프리핸드 마크 ${at} 크기 ${size} — 이 부근이 대상`;
        case 'image': return `- 참고 이미지 "${session.dir}/${m.file}" ${at} — 반드시 직접 확인하고 스타일 참고`;
      }
    };
    const byFrame = new Map<string, string[]>();
    const global: string[] = [];
    for (const m of marks) {
      const f = frameFor(m);
      if (f) byFrame.set(f.file, [...(byFrame.get(f.file) ?? []), describe(m, f)]);
      else global.push(describe(m, null));
    }
    const sections = [...byFrame.entries()]
      .map(([file, list]) => `[대상 파일] ${session.dir}/${file} (좌표는 이 디자인 문서 좌상단 기준 px, 뷰포트 폭 ${FRAME_W}px)\n${list.join('\n')}`)
      .join('\n\n');
    agent.note('you', `Apply ${instr.length} canvas mark${instr.length > 1 ? 's' : ''}`);
    const result = await agent.run(`${DESIGN_SYSTEM_PROMPT}

[세션 폴더] ${session.dir}
${penPromptLine(session.dir, doc.meta?.designSystem)}
[작업] 사용자가 캔버스의 시안 위에 그린 마크(주석)를 해당 디자인 파일에 반영하세요. 텍스트 메모는 지시 내용이고, 도형·화살표·프리핸드는 대상 위치를 지목합니다. 메모 없이 위치만 지목된 마크는 근처 메모·문맥으로 의도를 판단하되, 의도가 불확실하면 그 마크는 건너뛰고 마지막 요약에서 물어보세요. 각 파일을 read한 뒤 edit로 최소 변경만 하고, 지목되지 않은 부분은 그대로 두세요.

${sections}${global.length > 0 ? `\n\n[특정 시안 밖의 마크 — 캔버스 전역 좌표]\n${global.join('\n')}` : ''}`);
    if (!result.ok) { setError(result.error || 'Applying the marks did not finish.'); return; }
    await reloadPenDoc(session.dir);
    const instrIds = new Set(instr.map((m) => m.id));
    beginOp('');
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.filter((n) => !instrIds.has(n.id)) } : prev);
    setSelectedIds([]);
    const touched = [...byFrame.keys()].map((f) => `${session.dir}/${f}`).filter((p) => HTML_RE.test(p));
    const htmlMap = await loadHtml(touched);
    agent.note('sys', '✓ canvas marks applied');
    await exportPngNoted(touched, htmlMap);
    await refreshFiles(session.dir);
  }, [activeSession, busy, frameHeights, agent, beginOp, reloadPenDoc, loadHtml, exportPngNoted, refreshFiles]);

  // ── One-click runs (딸깍): Enhance polishes the active design, Remix
  // re-interprets it in a chosen aesthetic — both save copies, no typing ──
  const runOneClick = useCallback(async (noteLabel: string, task: string, alsoExport: string[] = []): Promise<boolean> => {
    const session = activeSession;
    if (!session || !activePath || !HTML_RE.test(activePath) || busy) return false;
    setError(null);
    agent.note('you', noteLabel);
    const before = new Set(files);
    const result = await agent.run(`${DESIGN_SYSTEM_PROMPT}

[세션 폴더] ${session.dir}
${penPromptLine(session.dir, penDoc?.meta?.designSystem)}
${task}`);
    if (!result.ok) { setError(result.error || 'The run did not finish.'); return false; }
    const list = await refreshFiles(session.dir);
    const htmlMap = await loadHtml(list);
    await reloadPenDoc(session.dir);
    const fresh = list.filter((p) => !before.has(p) && HTML_RE.test(p));
    if (fresh.length > 0) setActivePath(fresh[fresh.length - 1]);
    agent.note('sys', fresh.length > 0 ? `✓ ${fresh.map(fileLabel).join(', ')}` : '✓ done');
    const exports = [...new Set([...fresh, ...alsoExport.filter((p) => HTML_RE.test(p) && list.includes(p))])];
    await exportPngNoted(exports, htmlMap);
    if (exports.length > 0) await refreshFiles(session.dir);
    return true;
  }, [activeSession, activePath, busy, files, penDoc, agent, refreshFiles, loadHtml, reloadPenDoc, exportPngNoted]);

  const enhanceActive = useCallback(() => {
    if (!activePath) return Promise.resolve();
    return runOneClick(`✨ Enhance ${fileLabel(activePath)}`,
      `[작업] ${activePath} 를 read 한 뒤, 콘텐츠와 레이아웃 구조는 그대로 유지하면서 시각적 완성도를 프로 수준으로 끌어올린 사본을 "${fileLabel(activePath)} Enhanced.html" 로 저장하세요. 다듬을 것: 타이포 스케일과 행간의 수직 리듬, 간격의 일관성(8px 그리드), 색 조화와 대비 위계, 디테일(그림자 깊이, 보더, 여백, 정렬). 요소를 추가·삭제하거나 카피를 바꾸지 말고, 원본은 건드리지 마세요.`);
  }, [activePath, runOneClick]);

  const remixActive = useCallback((style: typeof STYLE_DIRECTIONS[number]) => {
    if (!activePath) return Promise.resolve();
    return runOneClick(`🎨 Remix — ${style.label}`,
      `[작업] ${activePath} 를 read 한 뒤, 콘텐츠(카피·정보)는 유지하고 "${style.label}" 방향(${style.desc})으로 완전히 재해석한 시안을 "${fileLabel(activePath)} — ${style.label}.html" 로 저장하세요. 어중간하게 섞지 말고 그 미학 하나에 전념하세요. 원본은 건드리지 마세요.`);
  }, [activePath, runOneClick]);

  const [remixOpen, setRemixOpen] = useState(false);
  useEffect(() => {
    if (!remixOpen) return;
    const close = () => setRemixOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [remixOpen]);

  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => setMoreOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [moreOpen]);

  // ── Components (pencil-style): a built-in library plus session components
  // extracted from designs, both inserted with one click and matched to the
  // active design's visual language ──
  const [customComponents, setCustomComponents] = useState<string[]>([]);
  const [compOpen, setCompOpen] = useState(false);
  useEffect(() => {
    if (!compOpen) return;
    const close = () => setCompOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [compOpen]);

  const scanComponents = useCallback(async (dir: string | null) => {
    if (!dir) { setCustomComponents([]); return; }
    try {
      const entries = await invoke<Array<{ name: string; path: string; is_dir: boolean }>>('read_directory', { path: `${dir}/components` });
      setCustomComponents(entries.filter((e) => !e.is_dir && HTML_RE.test(e.name)).map((e) => e.path).sort());
    } catch { setCustomComponents([]); }
  }, []);

  useEffect(() => {
    void scanComponents(activeSession?.dir ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.dir]);

  const insertComponent = useCallback((label: string, desc: string, srcPath?: string) => {
    if (!activePath) return Promise.resolve(false);
    // Session components are inserted as INSTANCES: marker comments make them
    // findable later so "Sync Instances" can re-apply component changes while
    // keeping local overrides — pencil's component/instance model, in HTML.
    const src = srcPath
      ? `\n[컴포넌트 소스] ${srcPath} — 이 파일을 read해서 스니펫을 가져오되, 대상 디자인의 팔레트·타이포·간격에 맞게 조정해 통합하세요. 삽입한 블록은 반드시 <!-- @component:${fileLabel(srcPath)} --> 와 <!-- /@component:${fileLabel(srcPath)} --> 주석으로 감싸 인스턴스로 표시하세요.`
      : '';
    return runOneClick(`⬒ Insert ${label}`,
      `[작업] ${activePath} 를 read 한 뒤, "${label}" 컴포넌트(${desc})를 이 디자인에 추가하세요. 기존 디자인의 색·타이포·간격 체계를 그대로 따라 자연스럽게 어울려야 합니다. 역할에 맞는 위치(navbar는 최상단, footer는 최하단, 그 외는 문맥상 자연스러운 곳)에 additive로 삽입하고, 기존 요소는 수정하지 마세요.${src}`,
      [activePath]);
  }, [activePath, runOneClick]);

  // Re-apply each session component's current source to every instance
  // (marker-wrapped block) across the session, preserving local overrides.
  const syncInstances = useCallback(() => {
    const session = activeSession;
    if (!session || customComponents.length === 0) return Promise.resolve(false);
    return runOneClick('⟳ Sync component instances',
      `[작업] 세션 폴더의 모든 HTML 디자인 파일에서 <!-- @component:이름 --> … <!-- /@component:이름 --> 마커로 감싸인 컴포넌트 인스턴스를 찾으세요 (grep 활용). 각 인스턴스를 해당 컴포넌트 소스(${customComponents.map((p) => `"${p}"`).join(', ')})의 현재 구조·스타일로 갱신하되, 인스턴스의 로컬 오버라이드(바뀐 텍스트·이미지·링크)는 보존하세요. 마커는 유지하고, 마커 밖은 건드리지 마세요. 인스턴스가 없는 파일은 건너뛰고, 마지막에 갱신한 파일 목록만 짧게 보고하세요.`,
      files.filter((p) => HTML_RE.test(p)));
  }, [activeSession, customComponents, files, runOneClick]);

  // Full automation in one run: the agent explores variations, judges them,
  // and polishes the winner — no user steps in between.
  const autoPilot = useCallback(() => {
    if (!activePath) return Promise.resolve(false);
    return runOneClick(`⚡ Auto Pilot — ${fileLabel(activePath)}`,
      `[작업 — 자동 파이프라인] ${activePath} 를 기준으로 순서대로 진행하세요: (1) 뚜렷이 다른 방향의 변형 시안 3개를 "${fileLabel(activePath)} A.html", "${fileLabel(activePath)} B.html", "${fileLabel(activePath)} C.html" 로 생성, (2) 원본 포함 4개를 스스로 평가해 가장 완성도 높은 방향 하나를 선택, (3) 선택한 시안을 프로 수준으로 다듬어 "${fileLabel(activePath)} Final.html" 로 저장, (4) 마지막 요약에 어떤 방향을 왜 선택했는지 한 문장으로. 원본은 건드리지 마세요.`);
  }, [activePath, runOneClick]);

  // Auto-layout (lite): tidy all frames into one clean row and refit.
  const tidyFrames = useCallback(() => {
    const doc = penDocLiveRef.current;
    if (!doc) return;
    const frames = doc.nodes.filter((n): n is PenFrameNode => n.type === 'frame')
      .sort((a, b) => a.x - b.x || a.y - b.y);
    if (frames.length === 0) return;
    beginOp('');
    const pos = new Map<string, number>();
    let x = 0;
    for (const f of frames) { pos.set(f.id, x); x += FRAME_W + FRAME_GAP; }
    setPenDoc((prev) => prev ? { ...prev, nodes: prev.nodes.map((n) =>
      n.type === 'frame' && pos.has(n.id) ? { ...n, x: pos.get(n.id) ?? n.x, y: 0 } : n) } : prev);
    setFitTick((t) => t + 1);
  }, [beginOp]);

  const componentizeSelection = useCallback(async () => {
    const doc = penDocLiveRef.current;
    const session = activeSession;
    if (!doc || !session || busy || selectedIds.length !== 1) return;
    const mark = doc.nodes.find((n): n is PenShapeNode => n.id === selectedIds[0] && n.type === 'rect');
    if (!mark) return;
    const frames = doc.nodes.filter((n): n is PenFrameNode => n.type === 'frame');
    const cx = mark.x + mark.w / 2;
    const cy = mark.y + mark.h / 2;
    const frame = frames.find((f) => {
      const fh = frameHeights[`${session.dir}/${f.file}`] ?? FRAME_H;
      return cx >= f.x && cx <= f.x + FRAME_W && cy >= f.y && cy <= f.y + fh;
    });
    if (!frame) { setError('Draw the rectangle over a design frame first.'); return; }
    const rel = { x: Math.round(mark.x - frame.x), y: Math.round(mark.y - frame.y), w: Math.round(mark.w), h: Math.round(mark.h) };
    const ok = await runOneClick(`⬒ Componentize ${fileLabel(frame.file)}`,
      `[작업] ${session.dir}/${frame.file} 를 read 한 뒤, 문서 좌상단 기준 영역 (x:${rel.x}, y:${rel.y}, w:${rel.w}, h:${rel.h}) px 를 덮고 있는 섹션/요소를 찾아, 단독으로 재사용 가능한 완전 독립 HTML 스니펫(필요한 CSS 인라인 포함)으로 추출해 "${session.dir}/components/<역할 기반 이름>.html" 로 저장하세요 (components 폴더가 없으면 생성). 원본 파일은 수정하지 마세요.`);
    if (ok) {
      removeNode(mark.id);
      await scanComponents(session.dir);
    }
  }, [activeSession, busy, selectedIds, frameHeights, runOneClick, removeNode, scanComponents]);

  // ── Sticky-note prompt blocks on the variations canvas (stored in the .pen doc) ──
  const addNote = useCallback(() => {
    if (!activeSession || !penDoc) return;
    setCanvasMode(true);
    // Drop the note near the current viewport origin in canvas coordinates.
    const x = (-pan.x + 60) / zoom;
    const y = (-pan.y + 60) / zoom;
    addNode({ id: penId('n'), type: 'note', x, y, text: '' });
  }, [activeSession, penDoc, pan, zoom, addNode]);

  const runNote = useCallback(async (noteId: string) => {
    const n = noteNodes.find((x) => x.id === noteId);
    const session = activeSession;
    if (!n || !n.text.trim() || !session || busy) return;
    setError(null);
    agent.note('you', `▶ ${n.text.trim().slice(0, 120)}`);
    const before = new Set(files);
    const context = files.length > 0
      ? `\n[세션의 기존 파일]\n${files.map((p) => `- ${p}`).join('\n')}\n작은 수정이면 해당 파일을 edit로 최소 변경하고, 새 방향이면 새 파일로 작업하세요.`
      : '';
    const result = await agent.run(`${DESIGN_SYSTEM_PROMPT}

[세션 폴더] ${session.dir}
${penPromptLine(session.dir, penDoc?.meta?.designSystem)}
${context}
[요청 — 캔버스의 프롬프트 블록] ${n.text.trim()}`);
    if (!result.ok) { setError(result.error || 'The prompt block did not finish.'); return; }
    const list = await refreshFiles(session.dir);
    const htmlMap = await loadHtml(list);
    await reloadPenDoc(session.dir);
    const fresh = list.filter((p) => !before.has(p) && HTML_RE.test(p));
    if (fresh.length > 0) setActivePath(fresh[fresh.length - 1]);
    agent.note('sys', '✓ prompt block done');
    await exportPngNoted(fresh, htmlMap);
    if (fresh.length > 0) await refreshFiles(session.dir);
  }, [noteNodes, penDoc, activeSession, busy, files, agent, refreshFiles, loadHtml, reloadPenDoc, exportPngNoted]);

  // Pencil-style "variations": spin the active design into 3 distinct
  // directions, spread side by side on the canvas.
  const makeVariations = useCallback(async () => {
    const session = activeSession;
    if (!session || !activePath || !HTML_RE.test(activePath) || busy) return;
    setError(null);
    agent.note('you', `Variations of ${fileLabel(activePath)}`);
    const before = new Set(files);
    const result = await agent.run(`${DESIGN_SYSTEM_PROMPT}

[세션 폴더] ${session.dir}
${penPromptLine(session.dir, penDoc?.meta?.designSystem)}
[작업] ${activePath} 파일을 read 한 뒤, 이 디자인의 변형 시안 3개를 서로 뚜렷이 다른 방향(레이아웃/비주얼/타이포 축)으로 만들어 각각 별도 파일("${fileLabel(activePath)} A.html", "${fileLabel(activePath)} B.html", "${fileLabel(activePath)} C.html")로 저장하세요. 원본은 건드리지 마세요. 콘텐츠(카피·정보)는 유지하고 표현만 바꿉니다.`);
    if (!result.ok) { setError(result.error || 'Variations did not finish.'); return; }
    const list = await refreshFiles(session.dir);
    const htmlMap = await loadHtml(list);
    await reloadPenDoc(session.dir);
    const fresh = list.filter((p) => !before.has(p) && HTML_RE.test(p));
    if (fresh.length >= 2) requestCanvasFit();
    agent.note('sys', `✓ ${fresh.length} variation${fresh.length === 1 ? '' : 's'}`);
    await exportPngNoted(fresh, htmlMap);
    if (fresh.length > 0) await refreshFiles(session.dir);
  }, [activeSession, activePath, busy, files, penDoc, agent, refreshFiles, loadHtml, reloadPenDoc, requestCanvasFit, exportPngNoted]);

  // Agent bridge: the gateway secretary / bbarit-ctl reach the canvas through
  // the app command bus (design.canvas) via this window-scoped API. `status`
  // hands external agents the session dir and .pen path for direct node edits.
  useEffect(() => {
    const api: Record<string, () => unknown> = {
      status: () => ({
        sessionDir: activeSession?.dir ?? null,
        penDocPath: activeSession ? penDocPath(activeSession.dir) : null,
        files,
        activePath,
        busy,
        canvasMode,
      }),
      reload: () => { void (async () => { const list = await refreshFiles(activeSession?.dir ?? null); await loadHtml(list); if (activeSession) await reloadPenDoc(activeSession.dir); })(); return 'reloading'; },
      enhance: () => { void enhanceActive(); return 'enhance started'; },
      variations: () => { void makeVariations(); return 'variations started'; },
      tidy: () => { setCanvasMode(true); tidyFrames(); return 'tidied'; },
      syncInstances: () => { void syncInstances(); return 'sync started'; },
      autopilot: () => { void autoPilot(); return 'auto pilot started'; },
    };
    (window as unknown as { __bbaritDesignPanel?: Record<string, () => unknown> }).__bbaritDesignPanel = api;
    return () => {
      const w = window as unknown as { __bbaritDesignPanel?: Record<string, () => unknown> };
      if (w.__bbaritDesignPanel === api) delete w.__bbaritDesignPanel;
    };
  }, [activeSession, files, activePath, busy, canvasMode, refreshFiles, loadHtml, reloadPenDoc, enhanceActive, makeVariations, tidyFrames, syncInstances, autoPilot]);

  // ── Preview zoom: measure the design's natural size and fit it to the pane ──
  const measurePreview = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body || !doc.documentElement) return;
    const { w, h } = measureDesignSize(doc);
    if (w > 0 && h > 0) setContentSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  useEffect(() => { setContentSize(null); setPvZoom('fit'); }, [activePath]);

  useEffect(() => {
    if (canvasMode || activeKind !== 'html') return;
    const t = setTimeout(measurePreview, 350);
    return () => clearTimeout(t);
  }, [device, activePath, htmlByPath, canvasMode, activeKind, measurePreview]);

  useEffect(() => {
    const el = pvContainerRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvasMode, activeKind, files.length]);

  // Sessions live INSIDE the current codebase so designs are versioned with
  // the project (pencil.dev model) — user decision 2026-07-08. Directly under
  // the project root since the makeke layer was dropped (2026-07-10); old
  // sessions keep working via their absolute dirs stored in localStorage.
  const newSessionDir = useCallback(async () => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = `${projectRoot.replace(/\/$/, '')}/bbarit-design/${ts}`;
    await invoke('create_directory', { path: dir }).catch(() => {});
    return dir;
  }, [projectRoot]);

  // macOS interactive screen recording: user picks an area, stops via the
  // system menu-bar button; the .mov lands in the session and previews inline.
  const recordScreen = useCallback(async () => {
    if (recording) return;
    let session = activeSession;
    if (!session) {
      const dir = await newSessionDir();
      session = { id: `cd-${Date.now()}`, title: 'Screen recording', dir, createdAt: Date.now() };
      setSessions((prev) => [session!, ...prev].slice(0, MAX_SESSIONS));
      setActiveSessionId(session.id);
    }
    const out = `${session.dir}/recording-${Date.now().toString(36)}.mov`;
    setRecording(true);
    agent.note('sys', '🎥 Drag an area to record — stop with the ⏹ button in the macOS menu bar.');
    try {
      await invoke('capture_screen_video', { path: out });
      const list = await refreshFiles(session.dir);
      await loadHtml(list);
      setActivePath(out);
      agent.note('sys', `🎥 ${out.split('/').pop()} saved — open it in the video editor to trim, merge, or export MP4.`);
    } catch (e) {
      agent.note('sys', `⚠ recording: ${e}`);
    } finally {
      setRecording(false);
    }
  }, [recording, activeSession, newSessionDir, agent, refreshFiles, loadHtml]);

  const revealActive = useCallback(() => {
    if (!activePath) return;
    const png = activePath.replace(HTML_RE, '.png');
    const target = HTML_RE.test(activePath) && files.includes(png) ? png : activePath;
    void invoke('reveal_in_explorer', { path: target }).catch(() => {});
  }, [activePath, files]);

  const send = useCallback(async () => {
    const req = input.trim();
    if (!req) return;
    if (busy) return;
    setError(null);

    const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0];
    let session = activeSession;
    const isNew = !session;
    if (!session) {
      const dir = await newSessionDir();
      session = { id: `cd-${Date.now()}`, title: req.slice(0, 60), dir, createdAt: Date.now(), preset: preset.key };
      setSessions((prev) => [session!, ...prev].slice(0, MAX_SESSIONS));
      setActiveSessionId(session.id);
    }

    agent.note('you', attachments.length > 0 ? `${req}  (📎 ${attachments.length})` : req);
    setInput('');

    // Persist pending attachments into the session so the agent can see them
    // (quoted image paths become vision inputs via extract_image_attachments).
    let attachNote = '';
    if (attachments.length > 0) {
      const assetsDir = `${session.dir}/assets`;
      await invoke('create_directory', { path: assetsDir }).catch(() => {});
      const saved: string[] = [];
      for (const a of attachments) {
        const safe = a.name.replace(/[\\/:*?"<>|]/g, '_') || 'image.png';
        const p = `${assetsDir}/${a.id}-${safe}`;
        try { await invoke('write_file_base64', { path: p, base64Data: a.b64 }); saved.push(p); } catch { /* skip */ }
      }
      if (saved.length > 0) attachNote = `\n[사용자 첨부 파일 ${saved.length}개 — 이미지는 반드시 직접 확인하고, 영상은 ffmpeg/HyperFrames로 다루세요] ${saved.map((p) => `"${p}"`).join(' ')}`;
      setAttachments([]);
    }

    const existing = isNew ? [] : files;
    const context = existing.length > 0
      ? `\n[세션의 기존 파일]\n${existing.map((p) => `- ${p}`).join('\n')}\n[현재 보고 있는 파일] ${activePath || existing[0]}\n이어지는 요청입니다. 작은 수정이면 해당 파일을 edit로 최소 변경하고, 새 방향이면 v2 복사본이나 새 파일로 작업하세요.`
      : '';
    const before = new Set(existing);
    const result = await agent.run(`${DESIGN_SYSTEM_PROMPT}
${preset.system ? `\n${preset.system}\n` : ''}
[세션 폴더] ${session.dir}
${penPromptLine(session.dir, penDoc?.meta?.designSystem)}
${context}${attachNote}
[요청] ${req}`);
    if (!result.ok) {
      setError(result.error || 'The design agent did not finish.');
      agent.note('sys', `⚠ ${result.error || 'no result'}`);
      return;
    }
    const list = await refreshFiles(session.dir);
    const htmlMap = await loadHtml(list);
    await reloadPenDoc(session.dir);
    const fresh = list.filter((p) => !before.has(p));
    const freshHtml = fresh.filter((p) => HTML_RE.test(p));
    const previewable = fresh.filter((p) => !OFFICE_RE.test(p));
    const pick = freshHtml[freshHtml.length - 1] ?? previewable[previewable.length - 1];
    if (pick) setActivePath(pick);
    else if (!activePath && list.length > 0) setActivePath(list.find((p) => HTML_RE.test(p)) ?? list[0]);
    if (freshHtml.length >= 2) requestCanvasFit();
    agent.note('sys', list.length > 0 ? `✓ ${list.length} file${list.length > 1 ? 's' : ''}` : '✓ done');
    await exportPngNoted(freshHtml, htmlMap);
    if (freshHtml.length > 0) await refreshFiles(session.dir);
  }, [input, busy, activeSession, newSessionDir, files, activePath, attachments, presetKey, penDoc, agent, refreshFiles, loadHtml, reloadPenDoc, requestCanvasFit, exportPngNoted]);

  // Prompt hand-off from the gateway UI command bus (design.open with a prompt):
  // fill the input, then auto-run once React has flushed it into `send`.
  const pendingSendRef = useRef(false);
  useEffect(() => subscribePanelInject('design', () => {
    const p = takePanelInject('design');
    if (p && p.trim()) { setInput(p); pendingSendRef.current = true; }
  }), []);
  useEffect(() => {
    if (pendingSendRef.current && input.trim() && !busy) {
      pendingSendRef.current = false;
      void send();
    }
  }, [input, busy, send]);

  const applyComments = useCallback(async () => {
    if (!activePath || busy) return;
    const list = pathComments.filter((c) => c.note.trim());
    if (list.length === 0) { setError('Write a note on at least one pin first.'); return; }
    setError(null);
    const items = list.map((c) => `- 요소 #${c.n} (${c.selector}${c.snippet ? `, 현재 텍스트: "${c.snippet}"` : ''}) → ${c.note.trim()}`).join('\n');
    agent.note('you', `Apply ${list.length} pinned comment${list.length > 1 ? 's' : ''}`);
    const result = await agent.run(`${DESIGN_SYSTEM_PROMPT}

[작업] ${activePath} 파일을 read 한 뒤, 아래 각 코멘트를 해당 요소에만 반영하세요. 지목되지 않은 레이아웃·색·폰트·간격은 그대로 두고 edit로 최소 변경만 하세요. 끝나면 browser로 file://${activePath} 를 열어 렌더링을 확인하세요.

[요소별 코멘트]
${items}`);
    if (!result.ok) { setError(result.error || 'The edit did not finish.'); return; }
    if (activePath) setComments((prev) => ({ ...prev, [activePath]: [] }));
    postToPreview({ __cd: 'clear' });
    await loadHtml([activePath]);
    agent.note('sys', '✓ comments applied');
    await exportPngNoted([activePath]);
  }, [activePath, busy, pathComments, agent, postToPreview, loadHtml, exportPngNoted]);

  const addAttachmentFiles = useCallback((incoming: FileList | File[]) => {
    for (const f of Array.from(incoming)) {
      const isImage = f.type.startsWith('image/');
      const isVideo = f.type.startsWith('video/');
      if (!isImage && !isVideo) continue;
      if (f.size > ATTACH_MAX_BYTES) {
        setError(`${f.name}: too large (max 25 MB) — type its file path in the chat instead.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const b64 = url.split(',')[1];
        if (!b64) return;
        setAttachments((prev) => prev.length >= 8 ? prev : [...prev, {
          id: attachIdRef.current++,
          name: f.name || `pasted-${Date.now()}.png`,
          b64,
          preview: isImage ? url : '',
        }]);
      };
      reader.readAsDataURL(f);
    }
  }, []);

  const newSession = useCallback(() => {
    if (busy) return;
    setActiveSessionId(null);
    setActivePath(null);
    setFiles([]);
    setCanvasMode(false);
    agent.clearLog();
  }, [busy, agent]);

  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) { setActiveSessionId(null); setActivePath(null); setFiles([]); }
  }, [activeSessionId]);

  // ── Canvas panning + drawing (tool-dependent) ──
  const canvasPoint = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom };
  }, [pan, zoom]);

  const onCanvasDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const capture = () => { try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ } };
    if (tool !== 'select' && penDoc) {
      const p = canvasPoint(e);
      if (tool === 'text') {
        const id = penId('t');
        addNode({ id, type: 'text', x: p.x, y: p.y, w: 420, text: 'Text', color: '#111111', size: 36, weight: 700 });
        setSelectedIds([id]); setEditingTextId(id); setTool('select');
        return;
      }
      if (tool === 'note') {
        addNode({ id: penId('n'), type: 'note', x: p.x, y: p.y, text: '' });
        setTool('select');
        return;
      }
      if (tool === 'draw') {
        drawPathRef.current = [[p.x, p.y]];
        setDraftPath(drawPathRef.current);
      } else {
        drawRef.current = { x: p.x, y: p.y, x2: p.x, y2: p.y };
        setDraft(drawRef.current);
      }
      capture();
      return;
    }
    if (e.shiftKey) {
      const p = canvasPoint(e);
      marqueeRef.current = { x: p.x, y: p.y, x2: p.x, y2: p.y };
      setMarquee(marqueeRef.current);
      capture();
      return;
    }
    setSelectedIds([]);
    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, [tool, penDoc, canvasPoint, addNode, pan]);
  const onCanvasMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (drawPathRef.current) {
      const p = canvasPoint(e);
      const pts = drawPathRef.current;
      const last = pts[pts.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.5 && pts.length < 1500) {
        drawPathRef.current = [...pts, [p.x, p.y]];
        setDraftPath(drawPathRef.current);
      }
      return;
    }
    if (drawRef.current) {
      const p = canvasPoint(e);
      drawRef.current = { ...drawRef.current, x2: p.x, y2: p.y };
      setDraft(drawRef.current);
      return;
    }
    if (marqueeRef.current) {
      const p = canvasPoint(e);
      marqueeRef.current = { ...marqueeRef.current, x2: p.x, y2: p.y };
      setMarquee(marqueeRef.current);
      return;
    }
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) });
  }, [canvasPoint]);
  const onCanvasUp = useCallback(() => {
    if (drawPathRef.current) {
      const pts = drawPathRef.current.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]);
      drawPathRef.current = null;
      setDraftPath(null);
      if (pts.length >= 2) {
        const id = penId('p');
        addNode({ id, type: 'path', points: pts, stroke: '#DE2A44' });
        setSelectedIds([id]);
      }
      // The pencil stays armed for the next stroke — Esc or V leaves it.
      return;
    }
    if (drawRef.current) {
      const { x, y, x2, y2 } = drawRef.current;
      drawRef.current = null;
      setDraft(null);
      const w = Math.abs(x2 - x);
      const h = Math.abs(y2 - y);
      let id: string | null = null;
      if (tool === 'arrow') {
        id = penId('a');
        const tiny = Math.hypot(x2 - x, y2 - y) < 8;
        addNode({ id, type: 'arrow', x, y, x2: tiny ? x + 220 : x2, y2: tiny ? y : y2, stroke: '#DE2A44' });
      } else if (tool === 'rect' || tool === 'ellipse') {
        id = penId(tool === 'rect' ? 'r' : 'e');
        addNode({ id, type: tool, x: Math.min(x, x2), y: Math.min(y, y2),
          w: w < 8 ? 280 : Math.max(24, w), h: h < 8 ? 180 : Math.max(24, h),
          stroke: '#DE2A44', fill: 'transparent' });
      }
      setSelectedIds(id ? [id] : []);
      setTool('select');
      return;
    }
    if (marqueeRef.current) {
      const { x, y, x2, y2 } = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      const rx = Math.min(x, x2);
      const ry = Math.min(y, y2);
      const rw = Math.abs(x2 - x);
      const rh = Math.abs(y2 - y);
      const doc = penDocLiveRef.current;
      const hits = (doc?.nodes ?? [])
        .filter((n) => n.type !== 'frame' && n.type !== 'note')
        .filter((n) => {
          const b = penNodeBBox(n);
          return b.x < rx + rw && b.x + b.w > rx && b.y < ry + rh && b.y + b.h > ry;
        })
        .map((n) => n.id);
      setSelectedIds(hits);
      return;
    }
    dragRef.current = null;
    setDragging(false);
  }, [tool, addNode]);
  const onCanvasWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey) setZoom((z) => Math.min(1.4, Math.max(0.12, z * (e.deltaY > 0 ? 0.92 : 1.08))));
    else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  }, []);

  const activeHtml = activePath && activeKind === 'html' ? (htmlByPath[activePath] || '') : '';
  const singleSrcDoc = useMemo(
    () => (activePath && activeHtml ? withPinScript(resolveRelativeAssets(activeHtml, dirOf(activePath))) : ''),
    [activeHtml, activePath],
  );
  const deviceWidth = DEVICES.find((d) => d.key === device)?.width ?? null;
  const natW = deviceWidth ?? contentSize?.w ?? null;
  const natH = contentSize?.h ?? null;
  const fitScale = useMemo(() => {
    if (!containerSize || !natW || !natH) return 1;
    const availW = Math.max(100, containerSize.w - 36);
    const availH = Math.max(100, containerSize.h - 36);
    // Tall pages fit by width and scroll; poster-shaped designs fit entirely.
    const s = natH <= natW * 1.6 ? Math.min(availW / natW, availH / natH) : availW / natW;
    return Math.min(1, s);
  }, [containerSize, natW, natH]);
  const pvScale = pvZoom === 'fit' ? fitScale : pvZoom;
  // Auto-exported PNGs mirror an HTML sibling — keep the tab bar to one chip
  // per design and let standalone images (agent-generated) show up on their own.
  const visibleFiles = useMemo(() => {
    const htmlBases = new Set(files.filter((p) => HTML_RE.test(p)).map((p) => p.replace(HTML_RE, '')));
    return files.filter((p) => HTML_RE.test(p) || !htmlBases.has(p.replace(IMG_RE, '')));
  }, [files]);

  // Keep one frame node in the .pen doc per canvas file (names, not absolute
  // paths, so the doc stays portable if the session folder moves).
  const canvasFileNames = useMemo(() => visibleFiles.map((p) => p.split('/').pop() || p), [visibleFiles]);
  useEffect(() => {
    if (!penDoc) return;
    const synced = syncFrames(penDoc, canvasFileNames);
    if (synced !== penDoc) setPenDoc(synced);
  }, [penDoc, canvasFileNames]);

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, background: L.bg, color: L.ink, fontFamily: L.sans }}>
      {/* ── Left: Claude chat rail ── */}
      <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${L.border}`, minHeight: 0, background: L.bg }}>
        <div style={{ padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 9, borderBottom: `1px solid ${L.borderSoft}` }}>
          <BrandMark size={17} />
          <span style={{ fontFamily: L.serif, fontSize: 15.5, fontWeight: 600, letterSpacing: '-0.01em' }}>BBARIT Design</span>
          <ModelChip model={agent.model} onCycle={agent.cycleModel} L={L} />
          <button type="button" onClick={newSession} disabled={busy} title="New design session"
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 999,
              border: `1px solid ${L.border}`, background: L.card, color: L.soft, fontSize: 11.5, fontWeight: 600,
              cursor: busy ? 'not-allowed' : 'pointer' }}>
            <Plus size={12} /> New
          </button>
        </div>

        <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
          {agent.log.length === 0 && (
            <div style={{ marginTop: 40, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <BrandMark size={26} />
              <div style={{ fontFamily: L.serif, fontSize: 17, color: L.soft }}>What should we design?</div>
              <div style={{ fontSize: 12, color: L.muted, lineHeight: 1.7, maxWidth: 250 }}>
                Posters, landing pages, slides, banners, videos —<br />
                ask for several options and they spread across the canvas.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, width: '100%', maxWidth: 296, marginTop: 4 }}>
                {PRESETS.filter((p) => p.key !== 'design').map((p) => (
                  <button key={p.key} type="button"
                    onClick={() => setPresetKey(p.key)}
                    style={{ padding: '8px 10px', borderRadius: 10, textAlign: 'left', cursor: 'pointer',
                      border: `1px solid ${presetKey === p.key ? L.accent : L.border}`, background: L.card }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, color: L.ink }}>{p.label}</div>
                    <div style={{ fontSize: 10, color: L.muted, marginTop: 2, lineHeight: 1.4 }}>{p.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {agent.log.map((l) => <ChatRow key={l.id} entry={l} L={L} />)}
          {busy && <Thinking L={L} label={agent.activity || 'Designing…'} />}
        </div>

        <div style={{ padding: 12 }}>
          {error && (
            <div style={{ fontSize: 11, color: L.accentDeep, display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
              <X size={12} /> {error}
            </div>
          )}
          <div
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) addAttachmentFiles(e.dataTransfer.files); }}
            style={{ background: L.card, border: `1px solid ${L.border}`, borderRadius: 16, boxShadow: '0 1px 3px rgba(0,0,0,.06)', padding: '10px 12px 8px' }}>
            {attachments.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {attachments.map((a) => (
                  <div key={a.id} title={a.name}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, border: `1px solid ${L.border}`, borderRadius: 8, padding: '3px 6px 3px 3px', background: L.bg }}>
                    {a.preview ? (
                      <img src={a.preview} alt={a.name} style={{ width: 26, height: 26, objectFit: 'cover', borderRadius: 5, display: 'block' }} />
                    ) : (
                      <span style={{ width: 26, height: 26, borderRadius: 5, background: L.bubble, display: 'flex', alignItems: 'center', justifyContent: 'center', color: L.soft }}>
                        <Clapperboard size={13} />
                      </span>
                    )}
                    <span style={{ fontSize: 10.5, color: L.soft, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                    <button type="button" title="Remove"
                      onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      style={{ border: 0, background: 'transparent', color: L.faint, cursor: 'pointer', display: 'flex', padding: 0 }}>
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea ref={promptRef} value={input} onChange={(e) => setInput(e.target.value)} rows={3}
              placeholder={(PRESETS.find((p) => p.key === presetKey)?.hint) || 'Describe your design… (paste or drop images)'}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
              onPaste={(e) => {
                const imgs = Array.from(e.clipboardData?.items || [])
                  .filter((i) => i.kind === 'file' && (i.type.startsWith('image/') || i.type.startsWith('video/')))
                  .map((i) => i.getAsFile())
                  .filter((f): f is File => !!f);
                if (imgs.length > 0) { e.preventDefault(); addAttachmentFiles(imgs); }
              }}
              style={{ width: '100%', border: 0, outline: 'none', resize: 'none', background: 'transparent',
                fontSize: 13, lineHeight: 1.5, fontFamily: L.sans, color: L.ink, boxSizing: 'border-box',
                minHeight: 66, maxHeight: 240, overflowY: 'auto' }} />
            {activeSession && penDoc && (
              <input value={penDoc.meta?.designSystem ?? ''}
                onChange={(e) => { beginOp('ds'); setPenDoc((prev) => prev ? { ...prev, meta: { ...prev.meta, designSystem: e.target.value } } : prev); }}
                placeholder="Design system — brand, tokens, component file paths (guides every run)"
                title="Stored in design.pen.json and handed to the agent on every run"
                style={{ width: '100%', border: 0, borderTop: `1px dashed ${L.borderSoft}`, marginTop: 6, paddingTop: 6,
                  outline: 'none', background: 'transparent', fontSize: 10.5, color: L.soft, boxSizing: 'border-box' }} />
            )}
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 4, gap: 6 }}>
              <input ref={fileInputRef} type="file" accept="image/*,video/*" multiple style={{ display: 'none' }}
                onChange={(e) => { if (e.target.files?.length) addAttachmentFiles(e.target.files); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} title="Attach images or videos (brand assets, references, clips to merge)"
                style={{ width: 26, height: 26, borderRadius: 999, border: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'transparent', color: attachments.length > 0 ? L.accent : L.faint, cursor: 'pointer' }}>
                <Paperclip size={14} />
              </button>
              <select value={presetKey} onChange={(e) => setPresetKey(e.target.value)}
                title="Specialist agent"
                style={{ border: `1px solid ${L.border}`, borderRadius: 999, background: L.bg, color: presetKey !== 'design' ? L.accentDeep : L.soft,
                  fontSize: 10.5, fontWeight: 600, padding: '3px 6px', outline: 'none', maxWidth: 118 }}>
                {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
              <span style={{ fontSize: 10.5, color: L.faint }}>{activeSession ? 'Continues this session' : 'Starts a new session'}</span>
              <button type="button" onClick={() => void send()} disabled={!input.trim() || busy} title="Send"
                style={{ marginLeft: 'auto', width: 28, height: 28, borderRadius: 999, border: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: !input.trim() || busy ? L.borderSoft : L.accent, color: !input.trim() || busy ? L.faint : '#fff',
                  cursor: !input.trim() || busy ? 'not-allowed' : 'pointer' }}>
                {busy ? <Loader2 size={14} className="spin" /> : <ArrowUp size={15} />}
              </button>
            </div>
          </div>
        </div>

        {sessions.length > 0 && (
          <div style={{ borderTop: `1px solid ${L.borderSoft}`, padding: '9px 12px', maxHeight: 210, overflowY: 'auto' }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: L.faint, marginBottom: 6, letterSpacing: '0.05em' }}>
              History ({sessions.length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sessions.map((s) => {
                const presetLabel = PRESETS.find((p) => p.key === s.preset)?.label;
                const thumb = thumbs[s.id];
                return (
                  <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button type="button" title={s.title}
                      onClick={() => { setActiveSessionId(s.id); setCanvasMode(false); setPresetKey(s.preset || 'design'); agent.clearLog(); }}
                      style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '5px 7px',
                        borderRadius: 9, cursor: 'pointer', minWidth: 0, border: 0,
                        background: activeSessionId === s.id ? L.bubble : 'transparent' }}>
                      {thumb ? (
                        <img src={convertFileSrc(thumb)} alt=""
                          style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 6, flexShrink: 0,
                            border: `1px solid ${L.borderSoft}`, background: '#fff' }} />
                      ) : (
                        <span style={{ width: 34, height: 34, borderRadius: 6, flexShrink: 0, background: L.bubble,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', color: L.faint }}>
                          <ImageIcon size={13} />
                        </span>
                      )}
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: activeSessionId === s.id ? L.ink : L.soft,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {s.title || 'Design'}
                        </span>
                        <span style={{ fontSize: 9.5, color: L.faint, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {timeAgo(s.createdAt)}{presetLabel && presetLabel !== 'Designer' ? ` · ${presetLabel}` : ''}
                        </span>
                      </span>
                    </button>
                    <button type="button" onClick={() => deleteSession(s.id)} title="Delete session"
                      style={{ border: 0, background: 'transparent', color: L.faint, cursor: 'pointer', display: 'flex', padding: 2 }}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ── Right: preview surface ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderBottom: `1px solid ${L.border}`, background: L.bg, flexWrap: 'wrap' }}>
          {visibleFiles.map((p) => (
            <button key={p} type="button"
              onClick={() => { if (OFFICE_RE.test(p)) { onOpenFile?.(p); return; } setActivePath(p); setCommentMode(false); }}
              title={OFFICE_RE.test(p) ? `${p} — opens in the editor` : p}
              style={{ padding: '5px 12px', borderRadius: 999, cursor: 'pointer', fontSize: 11.5, fontWeight: 600, maxWidth: 180,
                display: 'flex', alignItems: 'center', gap: 4,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                border: `1px solid ${activePath === p ? L.borderSoft : 'transparent'}`,
                background: activePath === p ? L.card : 'transparent',
                boxShadow: activePath === p ? '0 1px 3px rgba(0,0,0,.08)' : 'none',
                color: activePath === p ? L.ink : L.muted }}>
              {IMG_RE.test(p) && <ImageIcon size={11} style={{ flexShrink: 0 }} />}
              {VID_RE.test(p) && <Clapperboard size={11} style={{ flexShrink: 0 }} />}
              {OFFICE_RE.test(p) && <FileText size={11} style={{ flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{fileLabel(p)}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {!canvasMode && DEVICES.map((d) => {
            const Icon = d.icon;
            return (
              <button key={d.key} type="button" onClick={() => setDevice(d.key)} title={d.label}
                style={{ width: 28, height: 26, borderRadius: 7, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: 0, background: device === d.key ? L.bubble : 'transparent', color: device === d.key ? L.ink : L.muted }}>
                <Icon size={13} />
              </button>
            );
          })}
          {!canvasMode && activePath && activeKind !== 'video' && (
            <>
              <span style={{ width: 1, height: 16, background: L.border, margin: '0 3px' }} />
              <CanvasBtn L={L} onClick={() => setPvZoom(Math.max(0.1, pvScale * 0.85))} icon={<ZoomOut size={13} />} />
              <button type="button" title="Reset to 100%" onClick={() => setPvZoom(1)}
                style={{ border: 0, background: 'transparent', color: L.muted, fontSize: 10.5, cursor: 'pointer', minWidth: 36, textAlign: 'center' }}>
                {Math.round(pvScale * 100)}%
              </button>
              <CanvasBtn L={L} onClick={() => setPvZoom(Math.min(2, pvScale * 1.18))} icon={<ZoomIn size={13} />} />
              <HeaderBtn L={L} onClick={() => setPvZoom('fit')} active={pvZoom === 'fit'} icon={<Maximize2 size={13} />} label="Fit" />
            </>
          )}
          <span style={{ width: 1, height: 16, background: L.border, margin: '0 3px' }} />
          <HeaderBtn L={L} onClick={() => setCanvasMode((v) => !v)} active={canvasMode} disabled={visibleFiles.length === 0} icon={<LayoutGrid size={13} />} label="Canvas" />
          {proMode && (
            <HeaderBtn L={L} onClick={() => { setInspectMode((v) => !v); setCommentMode(false); }} active={inspectMode}
              disabled={!activePath || canvasMode || activeKind !== 'html'} icon={<MousePointer2 size={13} />} label="Inspect" />
          )}
          {proMode && (
            <HeaderBtn L={L} onClick={addNote} disabled={!activeSession}
              icon={<StickyNoteIcon size={13} />} label="Note" />
          )}
          <HeaderBtn L={L} onClick={() => void enhanceActive()} disabled={!activePath || activeKind !== 'html' || busy}
            icon={<Zap size={13} />} label="Enhance" />
          <span style={{ position: 'relative', display: 'inline-flex' }} onPointerDown={(e) => e.stopPropagation()}>
            <HeaderBtn L={L} onClick={() => setRemixOpen((v) => !v)} active={remixOpen}
              disabled={!activePath || activeKind !== 'html' || busy}
              icon={<Palette size={13} />} label="Remix" />
            {remixOpen && (
              <div style={{ position: 'absolute', top: '115%', right: 0, zIndex: 60, width: 240, padding: 6,
                background: L.card, backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                border: `1px solid ${L.border}`, borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,.28)' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: L.faint, padding: '4px 8px', letterSpacing: '0.05em' }}>
                  ONE-CLICK RESTYLE
                </div>
                {STYLE_DIRECTIONS.map((s) => (
                  <button key={s.key} type="button"
                    onClick={() => { setRemixOpen(false); void remixActive(s); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', borderRadius: 8,
                      border: 0, background: 'transparent', cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = L.bubble; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                    <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: L.ink }}>{s.label}</span>
                    <span style={{ display: 'block', fontSize: 10, color: L.muted, marginTop: 1, lineHeight: 1.35 }}>{s.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
          <span style={{ position: 'relative', display: proMode ? 'inline-flex' : 'none' }} onPointerDown={(e) => e.stopPropagation()}>
            <HeaderBtn L={L}
              onClick={() => { setCompOpen((v) => !v); if (!compOpen) void scanComponents(activeSession?.dir ?? null); }}
              active={compOpen} disabled={!activePath || activeKind !== 'html' || busy}
              icon={<Blocks size={13} />} label="Components" />
            {compOpen && (
              <div style={{ position: 'absolute', top: '115%', right: 0, zIndex: 60, width: 250, padding: 6, maxHeight: 420, overflowY: 'auto',
                background: L.card, backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                border: `1px solid ${L.border}`, borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,.28)' }}>
                {customComponents.length > 0 && (
                  <>
                    <button type="button"
                      onClick={() => { setCompOpen(false); void syncInstances(); }}
                      style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', borderRadius: 8,
                        border: 0, background: 'transparent', cursor: 'pointer' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = L.bubble; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                      <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: L.accentDeep }}>⟳ Sync Instances</span>
                      <span style={{ display: 'block', fontSize: 10, color: L.muted, marginTop: 1 }}>Update every marked instance from its component, keeping overrides</span>
                    </button>
                    <div style={{ fontSize: 10, fontWeight: 700, color: L.faint, padding: '4px 8px', letterSpacing: '0.05em' }}>
                      THIS SESSION
                    </div>
                    {customComponents.map((p) => (
                      <button key={p} type="button"
                        onClick={() => { setCompOpen(false); void insertComponent(fileLabel(p), 'session component', p); }}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', borderRadius: 8,
                          border: 0, background: 'transparent', cursor: 'pointer' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = L.bubble; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                        <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: L.ink }}>{fileLabel(p)}</span>
                        <span style={{ display: 'block', fontSize: 10, color: L.muted, marginTop: 1 }}>Extracted from this session</span>
                      </button>
                    ))}
                  </>
                )}
                <div style={{ fontSize: 10, fontWeight: 700, color: L.faint, padding: '4px 8px', letterSpacing: '0.05em' }}>
                  LIBRARY — INSERT INTO ACTIVE DESIGN
                </div>
                {BUILTIN_COMPONENTS.map((c) => (
                  <button key={c.key} type="button"
                    onClick={() => { setCompOpen(false); void insertComponent(c.label, c.desc); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 8px', borderRadius: 8,
                      border: 0, background: 'transparent', cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = L.bubble; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                    <span style={{ display: 'block', fontSize: 11.5, fontWeight: 700, color: L.ink }}>{c.label}</span>
                    <span style={{ display: 'block', fontSize: 10, color: L.muted, marginTop: 1 }}>{c.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </span>
          {proMode && (
            <HeaderBtn L={L} onClick={() => void makeVariations()} disabled={!activePath || activeKind !== 'html' || busy}
              icon={<Sparkles size={13} />} label="Variations" />
          )}
          {(proMode || markCount > 0) && (
            <HeaderBtn L={L} onClick={() => void applyAnnotations()} disabled={markCount === 0 || busy}
              icon={<Wand2 size={13} />} label={markCount > 0 ? `Apply Marks (${markCount})` : 'Apply Marks'} />
          )}
          {proMode && (
            <HeaderBtn L={L} onClick={() => { setCommentMode((v) => !v); setInspectMode(false); }} active={commentMode} disabled={!activePath || canvasMode || activeIsImage} icon={<MessageSquarePlus size={13} />} label="Comment" />
          )}
          <span style={{ position: 'relative', display: 'inline-flex' }} onPointerDown={(e) => e.stopPropagation()}>
            <HeaderBtn L={L} onClick={() => setMoreOpen((v) => !v)} active={moreOpen}
              icon={<MoreHorizontal size={13} />} label="More" />
            {moreOpen && (
              <div style={{ position: 'absolute', top: '115%', right: 0, zIndex: 60, width: 190, padding: 6,
                background: L.card, backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                border: `1px solid ${L.border}`, borderRadius: 12, boxShadow: '0 6px 24px rgba(0,0,0,.28)' }}>
                {[
                  { key: 'autopilot', icon: <Zap size={13} color={L.accent} />, label: 'Auto Pilot (explore → pick → polish)',
                    disabled: !activePath || activeKind !== 'html' || busy, run: () => void autoPilot() },
                  { key: 'png', icon: exporting ? <Loader2 size={13} className="spin" /> : <ImageDown size={13} />, label: 'Export PNG',
                    disabled: !activePath || activeKind !== 'html' || exporting || busy,
                    run: () => { if (!activePath) return; void (async () => { setError(null); await exportPngNoted([activePath]); await refreshFiles(activeSession?.dir ?? null); })(); } },
                  { key: 'record', icon: <Disc size={13} color={L.accent} />, label: recording ? 'Recording…' : 'Record screen',
                    disabled: recording, run: () => void recordScreen() },
                  { key: 'reveal', icon: <FolderOpen size={13} />, label: 'Reveal in Finder', disabled: !activePath, run: revealActive },
                  { key: 'refresh', icon: <RefreshCw size={13} />, label: 'Refresh files', disabled: !activeSession,
                    run: () => { void (async () => { const list = await refreshFiles(activeSession?.dir ?? null); await loadHtml(list); if (activeSession) await reloadPenDoc(activeSession.dir); })(); } },
                  { key: 'editor', icon: <ExternalLink size={13} />, label: 'Open in editor', disabled: !activePath,
                    run: () => { if (activePath) onOpenFile?.(activePath); } },
                ].map((m) => (
                  <button key={m.key} type="button" disabled={m.disabled}
                    onClick={() => { setMoreOpen(false); m.run(); }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 8px',
                      borderRadius: 8, border: 0, background: 'transparent', cursor: m.disabled ? 'not-allowed' : 'pointer',
                      color: m.disabled ? L.faint : L.ink, fontSize: 11.5, fontWeight: 600 }}
                    onMouseEnter={(e) => { if (!m.disabled) e.currentTarget.style.background = L.bubble; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                    {m.icon} {m.label}
                  </button>
                ))}
              </div>
            )}
          </span>
          <button type="button" onClick={togglePro}
            title={proMode ? 'Hide the full pencil toolset' : 'Show the full pencil toolset (Inspect, Notes, Variations, Comments, Components)'}
            style={{ padding: '4px 9px', borderRadius: 999, fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
              border: `1px solid ${proMode ? L.accent : L.border}`,
              background: proMode ? L.accent : 'transparent', color: proMode ? '#fff' : L.muted }}>
            Pro
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, position: 'relative', background: L.canvas, minWidth: 0, overflow: 'hidden' }}>
            {visibleFiles.length === 0 ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, color: L.muted, fontSize: 13 }}>
                <BrandMark size={30} />
                <span style={{ fontFamily: L.serif, fontSize: 15 }}>Your design paints here live</span>
              </div>
            ) : canvasMode ? (
              <div ref={canvasElRef} onPointerDown={onCanvasDown} onPointerMove={onCanvasMove} onPointerUp={onCanvasUp} onPointerLeave={onCanvasUp} onWheel={onCanvasWheel}
                style={{ position: 'absolute', inset: 0, touchAction: 'none',
                  cursor: dragging ? 'grabbing' : tool === 'select' ? 'grab' : 'crosshair' }}>
                <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0', position: 'absolute' }}>
                  {noteNodes.map((n) => (
                    <StickyNote key={n.id} note={n} zoom={zoom} busy={busy} L={L}
                      onChange={(text) => { beginOp(`ntext-${n.id}`); patchNode(n.id, { text }); }}
                      onMove={(x, y) => { beginOp(`nmove-${n.id}`); patchNode(n.id, { x, y }); }}
                      onRun={() => void runNote(n.id)}
                      onDelete={() => removeNode(n.id)} />
                  ))}
                  {shapeNodes.map((n) => (
                    <PenShapeView key={n.id} node={n} zoom={zoom} tool={tool} selected={selectedIds.includes(n.id)}
                      editing={editingTextId === n.id} assetBase={activeSession?.dir ?? ''} L={L}
                      onDragStart={(additive) => onNodeDragStart(n.id, additive)}
                      onMoveBy={onNodesMoveBy}
                      onPatch={(patch) => patchNode(n.id, patch)}
                      onEditText={() => setEditingTextId(n.id)}
                      onEditDone={(text) => { beginOp(''); setEditingTextId(null); patchNode(n.id, { text: text.trim() || 'Text' }); }} />
                  ))}
                  {penDoc?.scene?.roots.map((r) => (
                    <VectorRootView key={r.id} node={r} scene={penDoc.scene!} assetBase={activeSession?.dir ?? ''}
                      label={r.name || r.id} muted={L.muted} />
                  ))}
                  {draft && <PenDraftView tool={tool} x={draft.x} y={draft.y} x2={draft.x2} y2={draft.y2} />}
                  {draftPath && <PenDraftPath points={draftPath} />}
                  {marquee && <PenDraftView tool="marquee" x={marquee.x} y={marquee.y} x2={marquee.x2} y2={marquee.y2} />}
                  {visibleFiles.map((p, i) => {
                    const frameName = p.split('/').pop() || p;
                    const pos = frameOf(penDoc, frameName, i);
                    return (
                    <div key={p} style={{ position: 'absolute', left: pos.x, top: pos.y, width: FRAME_W }}>
                      <div
                        onPointerDown={(e) => {
                          if (tool !== 'select') return;
                          e.stopPropagation();
                          beginOp(`frame-${frameName}`);
                          frameDragRef.current = { name: frameName, sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
                          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          const d = frameDragRef.current;
                          if (!d || d.name !== frameName) return;
                          moveFrame(frameName, d.ox + (e.clientX - d.sx) / zoom, d.oy + (e.clientY - d.sy) / zoom);
                        }}
                        onPointerUp={() => { frameDragRef.current = null; }}
                        style={{ fontSize: 30, color: L.muted, marginBottom: 12, fontWeight: 600, fontFamily: L.sans,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', userSelect: 'none',
                          cursor: tool === 'select' ? 'grab' : 'default' }}>{fileLabel(p)}</div>
                      <div style={{ width: FRAME_W, height: frameHeights[p] ?? FRAME_H, background: '#fff', borderRadius: 4, overflow: 'hidden', position: 'relative',
                        boxShadow: '0 2px 14px rgba(0,0,0,.12)',
                        outline: editFrame === p ? '5px solid #2B6EF2' : activePath === p ? `5px solid ${L.accent}` : 'none' }}>
                        {IMG_RE.test(p) ? (
                          <img src={convertFileSrc(p)} alt={fileLabel(p)}
                            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none' }} />
                        ) : VID_RE.test(p) ? (
                          <video src={convertFileSrc(p)} muted preload="metadata"
                            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', pointerEvents: 'none', background: '#000' }} />
                        ) : OFFICE_RE.test(p) ? (
                          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 18, color: '#666' }}>
                            <FileText size={64} />
                            <span style={{ fontSize: 28 }}>{fileLabel(p)}</span>
                          </div>
                        ) : editFrame === p ? (
                          <iframe title={fileLabel(p)} ref={editFrameRef}
                            srcDoc={withPinScript(resolveRelativeAssets(htmlByPath[p] || '', dirOf(p)))}
                            sandbox="allow-scripts allow-same-origin"
                            onLoad={(e) => {
                              measureFrame(p, e.currentTarget);
                              const w = e.currentTarget.contentWindow;
                              setTimeout(() => { w?.postMessage({ __cd: 'inspect-enable', on: true }, '*'); w?.postMessage({ __cd: 'get-tree' }, '*'); }, 250);
                            }}
                            style={{ width: '100%', height: '100%', border: 0, display: 'block', pointerEvents: 'auto' }} />
                        ) : (
                          <iframe title={fileLabel(p)} srcDoc={resolveRelativeAssets(htmlByPath[p] || '', dirOf(p))}
                            sandbox="allow-scripts allow-same-origin"
                            onLoad={(e) => measureFrame(p, e.currentTarget)}
                            style={{ width: '100%', height: '100%', border: 0, display: 'block', pointerEvents: 'none' }} />
                        )}
                        {editFrame !== p && (
                        <div style={{ position: 'absolute', inset: 0, pointerEvents: tool === 'select' ? 'auto' : 'none' }}
                          onClick={() => setActivePath(p)}
                          onDoubleClick={() => { if (HTML_RE.test(p)) { setActivePath(p); setEditFrame(p); } else { setActivePath(p); setCanvasMode(false); } }} />
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
                <PenToolbar tool={tool} onTool={(t) => { setTool(t); setSelectedIds([]); }} onUndo={undo} onRedo={redo} L={L} />
                {editFrame && (
                  <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 19,
                    background: '#2B6EF2', color: '#fff', fontSize: 11, fontWeight: 600, padding: '4px 12px',
                    borderRadius: 999, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
                    Editing {fileLabel(editFrame)} — click to select, drag to move, double-click text · Esc exits
                  </div>
                )}
                {selectedNodes.length > 0 && (
                  <PenStyleBar nodes={selectedNodes} L={L}
                    onChange={(patch) => { if (selectedNodes.length === 1) { beginOp(''); patchNode(selectedNodes[0].id, patch); } }}
                    onAlign={alignSelected}
                    onOrder={reorderSelected}
                    onDuplicate={duplicateSelected}
                    onComponentize={selectedNodes.length === 1 && selectedNodes[0].type === 'rect' && !busy
                      ? () => void componentizeSelection() : undefined}
                    onDelete={removeSelected} />
                )}
                <div style={{ position: 'absolute', right: 12, bottom: 12, display: 'flex', gap: 4, background: L.card, border: `1px solid ${L.border}`, borderRadius: 999, padding: 4, boxShadow: '0 2px 8px rgba(0,0,0,.10)' }}>
                  <CanvasBtn L={L} onClick={() => setZoom((z) => Math.max(0.12, z * 0.85))} icon={<ZoomOut size={13} />} />
                  <span style={{ alignSelf: 'center', fontSize: 10.5, color: L.muted, minWidth: 34, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
                  <CanvasBtn L={L} onClick={() => setZoom((z) => Math.min(1.4, z * 1.18))} icon={<ZoomIn size={13} />} />
                  <CanvasBtn L={L} onClick={fitCanvas} icon={<Maximize2 size={13} />} />
                  <CanvasBtn L={L} onClick={tidyFrames} icon={<Columns3 size={13} />} />
                </div>
              </div>
            ) : activeIsImage && activePath ? (
              <div ref={pvContainerRef} style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: 18, boxSizing: 'border-box' }}>
                <div style={{ minHeight: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                  <img src={convertFileSrc(activePath)} alt={fileLabel(activePath)}
                    onLoad={(e) => {
                      const img = e.currentTarget;
                      if (img.naturalWidth && img.naturalHeight) setContentSize({ w: img.naturalWidth, h: img.naturalHeight });
                    }}
                    style={{ width: contentSize ? contentSize.w * pvScale : undefined,
                      maxWidth: contentSize ? undefined : '100%', maxHeight: contentSize ? undefined : '100%',
                      boxShadow: '0 2px 14px rgba(0,0,0,.12)', borderRadius: 4, flexShrink: 0 }} />
                </div>
              </div>
            ) : activeKind === 'video' && activePath ? (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}>
                <video key={activePath} controls src={convertFileSrc(activePath)}
                  style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 6, background: '#000', boxShadow: '0 2px 14px rgba(0,0,0,.2)' }} />
              </div>
            ) : contentSize && natW && natH ? (
              <div ref={pvContainerRef} style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: 18, boxSizing: 'border-box' }}>
                <div style={{ minHeight: '100%', display: 'flex', justifyContent: 'center', alignItems: natH * pvScale < (containerSize?.h ?? 0) - 36 ? 'center' : 'flex-start' }}>
                  <div style={{ width: natW * pvScale, height: natH * pvScale, flexShrink: 0, position: 'relative' }}>
                    <iframe ref={iframeRef} title="bbarit-design-preview" srcDoc={singleSrcDoc}
                      sandbox="allow-scripts allow-same-origin"
                      onLoad={() => { postToPreview({ __cd: 'enable', on: commentMode }); postToPreview({ __cd: 'inspect-enable', on: inspectMode }); if (inspectMode) setTimeout(() => postToPreview({ __cd: 'get-tree' }), 250); setTimeout(measurePreview, 250); }}
                      style={{ width: natW, height: natH, transform: `scale(${pvScale})`, transformOrigin: '0 0',
                        border: 0, display: 'block', background: '#fff', boxShadow: '0 2px 14px rgba(0,0,0,.12)' }} />
                  </div>
                </div>
              </div>
            ) : (
              <div ref={pvContainerRef} style={{ position: 'absolute', inset: 0, overflow: 'auto', display: 'flex', justifyContent: 'center', padding: 0 }}>
                <div style={{ width: '100%', flexShrink: 0, background: '#fff', overflow: 'hidden' }}>
                  <iframe ref={iframeRef} title="bbarit-design-preview" srcDoc={singleSrcDoc}
                    sandbox="allow-scripts allow-same-origin"
                    onLoad={() => { postToPreview({ __cd: 'enable', on: commentMode }); postToPreview({ __cd: 'inspect-enable', on: inspectMode }); if (inspectMode) setTimeout(() => postToPreview({ __cd: 'get-tree' }), 250); setTimeout(measurePreview, 250); }}
                    style={{ width: '100%', height: '100%', border: 0, display: 'block' }} />
                </div>
              </div>
            )}
            {commentMode && !canvasMode && (
              <div style={{ position: 'absolute', top: 10, left: 10, background: L.accent, color: '#fff', fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 999, pointerEvents: 'none' }}>
                Click any element to pin a comment
              </div>
            )}
            {inspectMode && !canvasMode && (
              <div style={{ position: 'absolute', top: 10, left: 10, background: '#2B6EF2', color: '#fff', fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 999, pointerEvents: 'none' }}>
                Click any element to inspect &amp; edit
              </div>
            )}
          </div>

          {/* Inspector side panel: layers tree + live property editing —
              for the single preview (Inspect) and the canvas frame being edited */}
          {((inspectMode && activePath && !canvasMode && activeKind === 'html') || (canvasMode && !!editFrame)) && (
            <InspectorPanel L={L} tree={domTree} selected={inspected} busy={busy} pendingEdits={pendingEdits}
              onSelect={inspectorSelect} onEdit={inspectorEdit}
              onRefreshTree={() => postInspect({ __cd: 'get-tree' })}
              onApply={() => void applyPendingEdits()} onDiscard={discardPendingEdits}
              onClose={() => { setInspectMode(false); setEditFrame(null); }} />
          )}

          {/* Comment side panel */}
          {!inspectMode && (commentMode || pathComments.length > 0) && activePath && !canvasMode && (
            <div style={{ width: 250, flexShrink: 0, borderLeft: `1px solid ${L.border}`, background: L.bg, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ padding: '10px 12px', borderBottom: `1px solid ${L.borderSoft}`, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: L.soft }}>
                <MessageSquarePlus size={13} color={L.accent} /> Comments {pathComments.length > 0 ? `(${pathComments.length})` : ''}
                {pathComments.length > 0 && (
                  <button type="button" title="Clear all"
                    onClick={() => { if (activePath) setComments((prev) => ({ ...prev, [activePath]: [] })); postToPreview({ __cd: 'clear' }); }}
                    style={{ marginLeft: 'auto', background: 'transparent', border: 0, cursor: 'pointer', color: L.faint, display: 'flex' }}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
                {pathComments.length === 0 && (
                  <div style={{ fontSize: 11.5, color: L.muted, lineHeight: 1.6 }}>
                    Click elements in the preview to pin comments, write what to change, then apply. Only the pinned elements are touched.
                  </div>
                )}
                {pathComments.map((c) => (
                  <div key={c.n} style={{ border: `1px solid ${L.border}`, borderRadius: 10, padding: 8, background: L.card }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                      <span style={{ width: 18, height: 18, borderRadius: 9, background: L.accent, color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{c.n}</span>
                      <span style={{ fontSize: 10.5, color: L.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.selector}>{c.tag}{c.snippet ? ` · ${c.snippet}` : ''}</span>
                    </div>
                    <input type="text" value={c.note}
                      onChange={(e) => setComments((prev) => ({ ...prev, [activePath]: (prev[activePath] || []).map((x) => x.n === c.n ? { ...x, note: e.target.value } : x) }))}
                      placeholder="What should change…"
                      onKeyDown={(e) => { if (e.key === 'Enter') void applyComments(); }}
                      style={{ width: '100%', background: L.bg, color: L.ink, border: `1px solid ${L.border}`, borderRadius: 7, padding: '5px 8px', fontSize: 11.5, boxSizing: 'border-box', outline: 'none' }} />
                  </div>
                ))}
              </div>
              <button type="button" onClick={() => void applyComments()} disabled={busy || pathComments.filter((c) => c.note.trim()).length === 0}
                style={{ margin: 10, padding: 9, borderRadius: 10, border: 0,
                  cursor: busy || pathComments.filter((c) => c.note.trim()).length === 0 ? 'not-allowed' : 'pointer',
                  background: busy || pathComments.filter((c) => c.note.trim()).length === 0 ? L.borderSoft : L.accent,
                  color: busy || pathComments.filter((c) => c.note.trim()).length === 0 ? L.faint : '#fff',
                  fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
                {busy ? <Loader2 size={13} className="spin" /> : null} Apply {pathComments.filter((c) => c.note.trim()).length || ''} comment{pathComments.filter((c) => c.note.trim()).length === 1 ? '' : 's'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function HeaderBtn({ L, onClick, icon, label, active, disabled }: { L: BbaritLook; onClick: () => void; icon: React.ReactNode; label: string; active?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer', border: 0,
        background: active ? L.accent : 'transparent',
        color: active ? '#fff' : disabled ? L.faint : L.soft }}>
      {icon} {label}
    </button>
  );
}

function CanvasBtn({ L, onClick, icon }: { L: BbaritLook; onClick: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      style={{ width: 26, height: 26, borderRadius: 999, border: 0, background: 'transparent', color: L.soft, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {icon}
    </button>
  );
}
