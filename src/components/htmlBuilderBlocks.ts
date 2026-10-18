/**
 * htmlBuilderBlocks.ts
 *
 * Block library for the HTML builder mode of HtmlDesignEditor.
 * Every block is self-contained HTML with inline styles — no external CSS,
 * JS, or image dependencies — so inserted markup renders identically anywhere
 * the exported file is opened.
 */

export interface BuilderBlock {
  id: string;
  name: string;
  description: string;
  html: string;
}

export interface BuilderBlockCategory {
  id: string;
  name: string;
  blocks: BuilderBlock[];
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans KR',sans-serif`;

/** Inline SVG placeholder so image blocks never depend on the network. */
export function placeholderImage(width: number, height: number, label = 'Image'): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'><rect width='100%' height='100%' fill='#e2e8f0'/><text x='50%' y='50%' fill='#94a3b8' font-family='sans-serif' font-size='20' text-anchor='middle' dominant-baseline='middle'>${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Remove every builder-only artifact (selection markers, hover markers,
 * inline-edit flags, injected builder stylesheets) from a DOM subtree so the
 * serialized document is clean HTML. Mutates `root` in place.
 */
export function cleanBuilderMarkup(root: Element): void {
  root.querySelectorAll('[data-bbarit-builder]').forEach((el) => el.remove());
  root.querySelectorAll('[data-bbarit-selected],[data-bbarit-hover],[data-bbarit-editing]').forEach((el) => {
    if (el.hasAttribute('data-bbarit-editing')) el.removeAttribute('contenteditable');
    el.removeAttribute('data-bbarit-selected');
    el.removeAttribute('data-bbarit-hover');
    el.removeAttribute('data-bbarit-editing');
  });
}

/** Minimal valid page used when the builder opens an empty document. */
export const EMPTY_PAGE_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>New Page</title>
</head>
<body style="margin:0;font-family:${FONT};color:#1e293b;background:#ffffff;">
</body>
</html>`;

const heading: BuilderBlock = {
  id: 'heading',
  name: 'Heading',
  description: 'H2 section heading',
  html: `<h2 style="font-family:${FONT};font-size:32px;font-weight:700;color:#0f172a;margin:24px 0 12px;">섹션 제목</h2>`,
};

const paragraph: BuilderBlock = {
  id: 'paragraph',
  name: 'Text',
  description: 'Paragraph text',
  html: `<p style="font-family:${FONT};font-size:16px;line-height:1.7;color:#475569;margin:0 0 16px;">여기에 본문 내용을 입력하세요. 더블클릭하면 바로 편집할 수 있습니다.</p>`,
};

const button: BuilderBlock = {
  id: 'button',
  name: 'Button',
  description: 'Link button',
  html: `<a href="#" style="display:inline-block;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;background:#3b82f6;padding:12px 28px;border-radius:8px;text-decoration:none;margin:8px 0;">시작하기</a>`,
};

const image: BuilderBlock = {
  id: 'image',
  name: 'Image',
  description: 'Placeholder image',
  html: `<img src="${placeholderImage(800, 450)}" alt="이미지 설명" style="display:block;max-width:100%;height:auto;border-radius:12px;margin:16px 0;">`,
};

const divider: BuilderBlock = {
  id: 'divider',
  name: 'Divider',
  description: 'Horizontal rule',
  html: `<hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0;">`,
};

const spacer: BuilderBlock = {
  id: 'spacer',
  name: 'Spacer',
  description: '48px vertical space',
  html: `<div style="height:48px;" aria-hidden="true"></div>`,
};

const columns2: BuilderBlock = {
  id: 'columns-2',
  name: '2 Columns',
  description: 'Two-column layout',
  html: `<div style="display:flex;flex-wrap:wrap;gap:24px;margin:16px 0;">
  <div style="flex:1 1 280px;font-family:${FONT};font-size:15px;line-height:1.7;color:#475569;">왼쪽 컬럼 내용</div>
  <div style="flex:1 1 280px;font-family:${FONT};font-size:15px;line-height:1.7;color:#475569;">오른쪽 컬럼 내용</div>
</div>`,
};

const columns3: BuilderBlock = {
  id: 'columns-3',
  name: '3 Columns',
  description: 'Three-column layout',
  html: `<div style="display:flex;flex-wrap:wrap;gap:24px;margin:16px 0;">
  <div style="flex:1 1 200px;font-family:${FONT};font-size:15px;line-height:1.7;color:#475569;">첫 번째 컬럼</div>
  <div style="flex:1 1 200px;font-family:${FONT};font-size:15px;line-height:1.7;color:#475569;">두 번째 컬럼</div>
  <div style="flex:1 1 200px;font-family:${FONT};font-size:15px;line-height:1.7;color:#475569;">세 번째 컬럼</div>
</div>`,
};

const navbar: BuilderBlock = {
  id: 'navbar',
  name: 'Navbar',
  description: 'Logo + menu top bar',
  html: `<header style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 32px;font-family:${FONT};border-bottom:1px solid #e2e8f0;background:#ffffff;">
  <strong style="font-size:18px;color:#0f172a;">브랜드</strong>
  <nav style="display:flex;gap:24px;">
    <a href="#" style="font-size:14px;color:#475569;text-decoration:none;">소개</a>
    <a href="#" style="font-size:14px;color:#475569;text-decoration:none;">기능</a>
    <a href="#" style="font-size:14px;color:#475569;text-decoration:none;">가격</a>
    <a href="#" style="font-size:14px;font-weight:600;color:#3b82f6;text-decoration:none;">시작하기</a>
  </nav>
</header>`,
};

const hero: BuilderBlock = {
  id: 'hero',
  name: 'Hero',
  description: 'Headline + CTA',
  html: `<section style="padding:96px 24px;text-align:center;font-family:${FONT};background:linear-gradient(160deg,#eff6ff 0%,#ffffff 60%);">
  <h1 style="font-size:48px;font-weight:800;line-height:1.2;color:#0f172a;margin:0 auto 20px;max-width:720px;">제품의 핵심 가치를 한 문장으로</h1>
  <p style="font-size:18px;line-height:1.7;color:#475569;margin:0 auto 32px;max-width:560px;">방문자가 3초 안에 이해할 수 있는 설명을 여기에 씁니다. 짧고 구체적일수록 좋습니다.</p>
  <a href="#" style="display:inline-block;font-size:16px;font-weight:600;color:#ffffff;background:#3b82f6;padding:14px 36px;border-radius:10px;text-decoration:none;">무료로 시작하기</a>
</section>`,
};

const features: BuilderBlock = {
  id: 'features',
  name: 'Features',
  description: 'Three feature cards',
  html: `<section style="padding:72px 24px;font-family:${FONT};background:#ffffff;">
  <h2 style="font-size:32px;font-weight:700;color:#0f172a;text-align:center;margin:0 0 40px;">주요 기능</h2>
  <div style="display:flex;flex-wrap:wrap;gap:24px;max-width:1080px;margin:0 auto;">
    <div style="flex:1 1 280px;padding:28px;border:1px solid #e2e8f0;border-radius:14px;background:#f8fafc;">
      <div style="font-size:28px;margin-bottom:12px;">⚡️</div>
      <h3 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">빠른 속도</h3>
      <p style="font-size:14px;line-height:1.7;color:#475569;margin:0;">이 기능이 사용자의 어떤 문제를 해결하는지 설명합니다.</p>
    </div>
    <div style="flex:1 1 280px;padding:28px;border:1px solid #e2e8f0;border-radius:14px;background:#f8fafc;">
      <div style="font-size:28px;margin-bottom:12px;">🔒</div>
      <h3 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">안전한 보안</h3>
      <p style="font-size:14px;line-height:1.7;color:#475569;margin:0;">이 기능이 사용자의 어떤 문제를 해결하는지 설명합니다.</p>
    </div>
    <div style="flex:1 1 280px;padding:28px;border:1px solid #e2e8f0;border-radius:14px;background:#f8fafc;">
      <div style="font-size:28px;margin-bottom:12px;">🧩</div>
      <h3 style="font-size:18px;font-weight:700;color:#0f172a;margin:0 0 8px;">쉬운 연동</h3>
      <p style="font-size:14px;line-height:1.7;color:#475569;margin:0;">이 기능이 사용자의 어떤 문제를 해결하는지 설명합니다.</p>
    </div>
  </div>
</section>`,
};

const stats: BuilderBlock = {
  id: 'stats',
  name: 'Stats',
  description: 'Three metric counters',
  html: `<section style="padding:56px 24px;font-family:${FONT};background:#0f172a;">
  <div style="display:flex;flex-wrap:wrap;gap:32px;max-width:900px;margin:0 auto;text-align:center;">
    <div style="flex:1 1 200px;">
      <div style="font-size:40px;font-weight:800;color:#ffffff;">10,000+</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">사용자</div>
    </div>
    <div style="flex:1 1 200px;">
      <div style="font-size:40px;font-weight:800;color:#ffffff;">99.9%</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">가동률</div>
    </div>
    <div style="flex:1 1 200px;">
      <div style="font-size:40px;font-weight:800;color:#ffffff;">4.9/5</div>
      <div style="font-size:14px;color:#94a3b8;margin-top:6px;">평균 평점</div>
    </div>
  </div>
</section>`,
};

const pricing: BuilderBlock = {
  id: 'pricing',
  name: 'Pricing',
  description: 'Three pricing tiers',
  html: `<section style="padding:72px 24px;font-family:${FONT};background:#f8fafc;">
  <h2 style="font-size:32px;font-weight:700;color:#0f172a;text-align:center;margin:0 0 40px;">가격 안내</h2>
  <div style="display:flex;flex-wrap:wrap;gap:24px;max-width:1080px;margin:0 auto;align-items:stretch;">
    <div style="flex:1 1 280px;padding:32px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;">
      <h3 style="font-size:16px;font-weight:700;color:#475569;margin:0 0 8px;">Free</h3>
      <div style="font-size:36px;font-weight:800;color:#0f172a;margin-bottom:16px;">₩0<span style="font-size:14px;font-weight:500;color:#94a3b8;">/월</span></div>
      <ul style="list-style:none;padding:0;margin:0 0 24px;font-size:14px;line-height:2;color:#475569;">
        <li>✓ 기본 기능</li>
        <li>✓ 프로젝트 1개</li>
      </ul>
      <a href="#" style="display:block;text-align:center;font-size:14px;font-weight:600;color:#3b82f6;border:1px solid #3b82f6;padding:10px 0;border-radius:8px;text-decoration:none;">시작하기</a>
    </div>
    <div style="flex:1 1 280px;padding:32px;border:2px solid #3b82f6;border-radius:14px;background:#ffffff;position:relative;">
      <h3 style="font-size:16px;font-weight:700;color:#3b82f6;margin:0 0 8px;">Pro</h3>
      <div style="font-size:36px;font-weight:800;color:#0f172a;margin-bottom:16px;">₩19,000<span style="font-size:14px;font-weight:500;color:#94a3b8;">/월</span></div>
      <ul style="list-style:none;padding:0;margin:0 0 24px;font-size:14px;line-height:2;color:#475569;">
        <li>✓ 모든 기능</li>
        <li>✓ 무제한 프로젝트</li>
        <li>✓ 우선 지원</li>
      </ul>
      <a href="#" style="display:block;text-align:center;font-size:14px;font-weight:600;color:#ffffff;background:#3b82f6;padding:10px 0;border-radius:8px;text-decoration:none;">Pro 시작하기</a>
    </div>
    <div style="flex:1 1 280px;padding:32px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;">
      <h3 style="font-size:16px;font-weight:700;color:#475569;margin:0 0 8px;">Enterprise</h3>
      <div style="font-size:36px;font-weight:800;color:#0f172a;margin-bottom:16px;">문의</div>
      <ul style="list-style:none;padding:0;margin:0 0 24px;font-size:14px;line-height:2;color:#475569;">
        <li>✓ 맞춤 계약</li>
        <li>✓ 전담 지원</li>
      </ul>
      <a href="#" style="display:block;text-align:center;font-size:14px;font-weight:600;color:#3b82f6;border:1px solid #3b82f6;padding:10px 0;border-radius:8px;text-decoration:none;">문의하기</a>
    </div>
  </div>
</section>`,
};

const testimonial: BuilderBlock = {
  id: 'testimonial',
  name: 'Testimonial',
  description: 'Quote card',
  html: `<section style="padding:72px 24px;font-family:${FONT};background:#ffffff;">
  <blockquote style="max-width:680px;margin:0 auto;text-align:center;">
    <p style="font-size:22px;line-height:1.6;color:#0f172a;font-weight:500;margin:0 0 20px;">"도입 후 작업 시간이 절반으로 줄었습니다. 팀 전체가 만족하며 쓰고 있어요."</p>
    <footer style="font-size:14px;color:#64748b;">— 김민준, ○○스타트업 CTO</footer>
  </blockquote>
</section>`,
};

const cta: BuilderBlock = {
  id: 'cta',
  name: 'CTA Banner',
  description: 'Call-to-action banner',
  html: `<section style="padding:64px 24px;text-align:center;font-family:${FONT};background:#3b82f6;">
  <h2 style="font-size:30px;font-weight:800;color:#ffffff;margin:0 0 12px;">지금 바로 시작해 보세요</h2>
  <p style="font-size:16px;color:#dbeafe;margin:0 0 28px;">신용카드 없이 무료로 시작할 수 있습니다.</p>
  <a href="#" style="display:inline-block;font-size:15px;font-weight:700;color:#3b82f6;background:#ffffff;padding:13px 34px;border-radius:10px;text-decoration:none;">무료 계정 만들기</a>
</section>`,
};

const contactForm: BuilderBlock = {
  id: 'contact-form',
  name: 'Contact Form',
  description: 'Name / email / message',
  html: `<section style="padding:72px 24px;font-family:${FONT};background:#f8fafc;">
  <form style="max-width:520px;margin:0 auto;" action="#" method="post">
    <h2 style="font-size:28px;font-weight:700;color:#0f172a;text-align:center;margin:0 0 28px;">문의하기</h2>
    <label style="display:block;font-size:13px;font-weight:600;color:#334155;margin-bottom:6px;">이름</label>
    <input type="text" name="name" placeholder="홍길동" style="width:100%;box-sizing:border-box;font-size:14px;padding:11px 14px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:16px;background:#ffffff;">
    <label style="display:block;font-size:13px;font-weight:600;color:#334155;margin-bottom:6px;">이메일</label>
    <input type="email" name="email" placeholder="you@example.com" style="width:100%;box-sizing:border-box;font-size:14px;padding:11px 14px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:16px;background:#ffffff;">
    <label style="display:block;font-size:13px;font-weight:600;color:#334155;margin-bottom:6px;">메시지</label>
    <textarea name="message" rows="5" placeholder="내용을 입력하세요" style="width:100%;box-sizing:border-box;font-size:14px;padding:11px 14px;border:1px solid #cbd5e1;border-radius:8px;margin-bottom:20px;background:#ffffff;resize:vertical;"></textarea>
    <button type="submit" style="width:100%;font-size:15px;font-weight:600;color:#ffffff;background:#3b82f6;padding:13px 0;border:none;border-radius:8px;cursor:pointer;">보내기</button>
  </form>
</section>`,
};

const footer: BuilderBlock = {
  id: 'footer',
  name: 'Footer',
  description: 'Bottom info area',
  html: `<footer style="padding:40px 32px;font-family:${FONT};background:#0f172a;">
  <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;max-width:1080px;margin:0 auto;">
    <span style="font-size:14px;color:#94a3b8;">© 2026 브랜드. All rights reserved.</span>
    <nav style="display:flex;gap:20px;">
      <a href="#" style="font-size:13px;color:#94a3b8;text-decoration:none;">이용약관</a>
      <a href="#" style="font-size:13px;color:#94a3b8;text-decoration:none;">개인정보처리방침</a>
      <a href="#" style="font-size:13px;color:#94a3b8;text-decoration:none;">문의</a>
    </nav>
  </div>
</footer>`,
};

const landingTemplate: BuilderBlock = {
  id: 'template-landing',
  name: 'Landing Page',
  description: 'Nav + hero + features + CTA + footer',
  html: [navbar.html, hero.html, features.html, stats.html, cta.html, footer.html]
    .join('\n')
    // A template is one insertable unit so it can be selected/moved as a whole.
    .replace(/^/, '<div>\n')
    .concat('\n</div>'),
};

export const BUILDER_BLOCK_CATEGORIES: BuilderBlockCategory[] = [
  {
    id: 'basics',
    name: 'Basics',
    blocks: [heading, paragraph, button, image, divider, spacer, columns2, columns3],
  },
  {
    id: 'sections',
    name: 'Sections',
    blocks: [navbar, hero, features, stats, pricing, testimonial, cta, contactForm, footer],
  },
  {
    id: 'templates',
    name: 'Templates',
    blocks: [landingTemplate],
  },
];
