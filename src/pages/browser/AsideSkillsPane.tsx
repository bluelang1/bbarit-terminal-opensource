/**
 * AsideSkillsPane — 어사이드 스킬/플러그인 갤러리.
 *
 * 세 소스를 하나의 검색 목록으로 합친다(설계 D13/D16 준수 — CEF 밖 React,
 * 즐겨찾기는 kv 영속):
 * - Embedded official packs (skillPackHub, 30 packs / 200+ skills)
 * - Web-curated packs (public/skills-hub/famous-skills-manifest.json)
 * - OpenJarvis built-ins (openJarvisSkills)
 * Run은 스킬 프롬프트를 어사이드 태스크 경로(runAsideTask)로 보낸다 — 민감
 * 태스크 승인 게이트/감사 로그를 그대로 통과한다.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, RefreshCw, Search, Star } from 'lucide-react';
import type { Skill } from '../../skills/types';
import { kvGet, kvSet } from '../../hooks/useKV';

type SkillOrigin = 'browser' | 'official' | 'web' | 'jarvis';
interface AsideSkill { skill: Skill; origin: SkillOrigin; pack: string }

interface Props {
  onRunSkill: (skill: Skill) => void;
}

const FAVS_KEY = 'browser-aside-skill-favs';
const PAGE_SIZE = 60;
const SOURCE_LABEL: Record<SkillOrigin, string> = { browser: 'Browser', official: 'Official', web: 'Web', jarvis: 'Jarvis' };

/** Dia/Sider/Comet식 페이지 스킬 내장 세트 — 어사이드가 페이지 컨텍스트를 자동
 *  접합하므로 프롬프트는 "현재 페이지" 기준으로만 쓴다. */
const B = (id: string, emoji: string, name: string, description: string, command: string): Skill => ({
  id: `browser-${id}`, name, description, emoji, command,
  cliType: 'bbarit', category: 'ai', tags: ['browser', 'page'], builtIn: true,
});
const BROWSER_SKILLS: Skill[] = [
  B('summarize', '📌', 'Summarize Page', 'Key takeaways, statistics, and notable quotes in bullets.', 'Summarize the current page: key takeaways, important statistics, and notable quotes, in concise bullets.'),
  B('tldr', '⚡', 'TL;DR', 'One-paragraph plain-language summary for a busy reader.', 'Give a one-paragraph plain-language TL;DR of the current page for a busy reader.'),
  B('fact-check', '🔍', 'Fact-check', 'Verify the page\'s main claims against web sources.', 'Identify the main factual claims on the current page and verify each against reliable web sources. Give a verdict per claim with links.'),
  B('explain', '💡', 'Explain Simply', 'Explain the page/selection like I\'m a smart beginner.', 'Explain the core concept of the current page (or the selection if provided) like I\'m a smart beginner — include one analogy and one concrete example.'),
  B('key-points', '🗂️', 'Key Points', 'Structured outline of the page (H2/H3 + bullets).', 'Extract a structured outline of the current page: main sections as headings with 2-3 bullet points each.'),
  B('page-qa', '❓', 'Ask This Page', 'Question-answering grounded in the current page evidence.', 'Answer questions about the current page using only the page context first. Cite the section or visible evidence used, and clearly mark uncertainty.'),
  B('action-items', '✅', 'Action Items', 'Extract 3-5 concrete next steps with suggested owners.', 'Extract 3-5 concrete action items from the current page/notes, each with a suggested owner and priority.'),
  B('action-plan', '🧩', 'Action Plan', 'Plan browser steps before clicking, typing, or submitting.', 'Turn the current page goal into a step-by-step browser action plan. Identify likely buttons, fields, risks, and checkpoints before taking any action.'),
  B('proscons', '⚖️', 'Pros & Cons', 'Pros/cons table for the product or decision on this page.', 'Create a pros and cons table for the product, service, or decision described on the current page.'),
  B('compare-tabs', '🆚', 'Compare Tabs', 'Feature-by-feature comparison across mentioned tabs.', 'Compare the products/options across the current page and any mentioned tabs in a feature-by-feature table, then recommend one.'),
  B('research-brief', '🧭', 'Research Brief', 'Evidence, contradictions, open questions, and next actions.', 'Create a research brief from the current page and any mentioned tabs: thesis, supporting evidence, contradictions, open questions, and next actions.'),
  B('link-map', '🗺️', 'Link Map', 'Classify links and find the best next navigation targets.', 'Map the current page links by type (internal, external, download, social), identify the most useful navigation targets, and recommend what to open next.'),
  B('load-all', '⬇️', 'Load Full List', 'Use pagination, load-more, or scrolling before extraction.', 'Load all visible list results on the current page using safe pagination, load-more, or scrolling. Stop when the list no longer grows, then summarize what was loaded.'),
  B('export-data', '📤', 'Export Data', 'Extract repeated records and prepare CSV or JSON.', 'Extract the useful table or repeated-list data from the current page and prepare a CSV or JSON export. If saving to the project is needed, confirm the filename first.'),
  B('watch-changes', '👀', 'Watch Changes', 'Snapshot prices, availability, counts, or key text.', 'Create or compare a change snapshot for this page. Report price, availability, count, or key text changes since the previous snapshot if one exists.'),
  B('dismiss-consent', '🍪', 'Dismiss Consent', 'Handle cookie banners with least data sharing.', 'Detect any cookie or consent banner on the current page and dismiss it using the least data-sharing option, preferring reject or necessary-only when available.'),
  B('form-helper', '📝', 'Form Helper', 'Explain fields, validation, and safe values without submitting.', 'Inspect the current form or checkout page. Explain required fields, likely validation issues, privacy risks, and draft safe field values without submitting.'),
  B('email-draft', '✉️', 'Draft Email', 'Professional email about the current page/context.', 'Draft a professional email about the current page. Ask me for the recipient and purpose if unclear, then produce subject + body.'),
  B('reply-draft', '↩️', 'Draft Reply', 'Contextual reply to the visible thread/message.', 'Read the visible email/message thread on the current page and draft a contextual reply in my voice. Offer a formal and a casual variant.'),
  B('followup', '📅', 'Follow-up Notes', 'Meeting notes → decisions, action items, owners.', 'Turn the notes/thread on the current page into a follow-up message: decisions made, action items with owners, and open questions.'),
  B('linkedin', '💼', 'LinkedIn Post', 'Hook, 3 insights, engagement question, hashtags.', 'Convert the current page into a LinkedIn post: strong hook, 3 insights, an engagement question, and relevant hashtags.'),
  B('thread', '🧵', 'Social Thread', '5-7 post thread with a strong hook.', 'Turn the current article into a 5-7 post social media thread with a strong hook and one idea per post.'),
  B('rewrite', '✏️', 'Rewrite', 'Clearer and tighter, formal + casual variants.', 'Rewrite the selected text (or the page\'s main message): clearer, tighter, same meaning. Provide a formal and a casual variant.'),
  B('translate-ko', '🌐', 'Translate → Korean', 'Translate the page into Korean, preserving tone.', 'Translate the main content of the current page into natural Korean, preserving tone, formatting, and technical terms.'),
  B('translate-en', '🌐', 'Translate → English', 'Translate the page into English, preserving tone.', 'Translate the main content of the current page into natural English, preserving tone, formatting, and technical terms.'),
  B('quiz', '🎓', 'Study Quiz', '5 comprehension questions with answers.', 'Generate 5 comprehension questions (with answers) from the current page for studying.'),
  B('transcript', '🎬', 'Video Summary', 'Transcript-based summary by chapter (YouTube).', 'If the current page is a video (e.g. YouTube), get its transcript or description and summarize it by chapter with timestamps where possible.'),
  B('competitor', '🏢', 'Competitor Analysis', 'Positioning, value prop, strengths/weaknesses.', 'Analyze the company/product on the current page: positioning, value proposition, strengths, weaknesses, and how it compares to its main rivals.'),
  B('shopsmart', '🛒', 'Shop Smart', 'Price sanity, review consensus, red flags, alternatives.', 'Evaluate the product on the current page like a savvy shopper: real price sanity check, review consensus, red flags, and cheaper alternatives.'),
];

async function loadAllSkills(): Promise<AsideSkill[]> {
  const out: AsideSkill[] = [];
  const seen = new Set<string>();
  const push = (skill: Skill, origin: SkillOrigin, pack: string) => {
    const key = `${skill.id}::${skill.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ skill, origin, pack });
  };
  // 페이지 스킬(내장)이 항상 맨 위 — 브라우저에서 가장 자주 쓰는 것들.
  for (const skill of BROWSER_SKILLS) push(skill, 'browser', 'BBARIT Browser');
  // 매니페스트(웹 큐레이션) + 내장 공식 팩 — loadRemoteSkillManifest가 병합한다.
  try {
    const hub = await import('../../skills/skillPackHub');
    const manifest = await hub.loadRemoteSkillManifest('/skills-hub/famous-skills-manifest.json');
    for (const pack of manifest.packs) {
      const official = pack.url?.startsWith('octo://official/');
      const skills = Array.isArray(pack.skills) ? pack.skills : [];
      for (const skill of skills) push(skill, official ? 'official' : 'web', pack.name);
    }
  } catch {
    // 매니페스트 실패 시 내장 팩만이라도.
    try {
      const hub = await import('../../skills/skillPackHub');
      const manifest = await hub.loadRemoteSkillManifest(hub.EMBEDDED_OFFICIAL_MANIFEST_URL).catch(() => null);
      for (const pack of manifest?.packs ?? []) {
        for (const skill of pack.skills ?? []) push(skill, 'official', pack.name);
      }
    } catch { /* 스킬 없이도 패널은 동작 */ }
  }
  try {
    const jarvis = await import('../../skills/openJarvisSkills');
    for (const skill of jarvis.OPENJARVIS_SKILLS) push(skill, 'jarvis', skill.sourcePack || 'OpenJarvis');
  } catch { /* 선택 소스 */ }
  return out;
}

export function AsideSkillsPane({ onRunSkill }: Props) {
  const [items, setItems] = useState<AsideSkill[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'all' | 'favorites' | SkillOrigin>('all');
  const [category, setCategory] = useState('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [favs, setFavs] = useState<string[]>([]);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError('');
    void loadAllSkills()
      .then((skills) => { if (alive) setItems(skills); })
      .catch((e) => { if (alive) { setItems([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { alive = false; };
  }, [reloadNonce]);

  useEffect(() => {
    void kvGet(FAVS_KEY).then((raw) => {
      if (!raw) return;
      try { setFavs(JSON.parse(raw)); } catch { /* 초기값 유지 */ }
    });
  }, []);

  const toggleFav = (id: string) => {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id];
      void kvSet(FAVS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { skill } of items ?? []) counts.set(skill.category, (counts.get(skill.category) || 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [items]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (items ?? []).filter(({ skill, origin }) => {
      if (source === 'favorites') { if (!favs.includes(skill.id)) return false; }
      else if (source !== 'all' && origin !== source) return false;
      if (category !== 'all' && skill.category !== category) return false;
      if (!needle) return true;
      return (
        skill.name.toLowerCase().includes(needle)
        || skill.description.toLowerCase().includes(needle)
        || (skill.tags ?? []).some((tag) => tag.toLowerCase().includes(needle))
        || skill.category.toLowerCase().includes(needle)
      );
    });
  }, [items, query, source, category, favs]);

  const visible = filtered.slice(0, limit);

  return (
    <div className="aside-skills-pane">
      <div className="aside-skills-search">
        <Search size={13} />
        <input
          type="text"
          placeholder={items ? `Search ${items.length.toLocaleString()} skills…` : 'Loading skills…'}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setLimit(PAGE_SIZE); }}
        />
        <button type="button" title="Reload skill sources" onClick={() => setReloadNonce((v) => v + 1)}><RefreshCw size={12} /></button>
      </div>
      <div className="aside-skills-filters">
        {(['all', 'favorites', 'browser', 'official', 'web', 'jarvis'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={source === s ? 'active' : ''}
            onClick={() => { setSource(s); setLimit(PAGE_SIZE); }}
          >{s === 'all' ? 'All' : s === 'favorites' ? `★ ${favs.length}` : SOURCE_LABEL[s]}</button>
        ))}
      </div>
      {categories.length > 1 && (
        <div className="aside-skills-cats">
          <button type="button" className={category === 'all' ? 'active' : ''} onClick={() => { setCategory('all'); setLimit(PAGE_SIZE); }}>all</button>
          {categories.map(([cat, count]) => (
            <button
              key={cat}
              type="button"
              className={category === cat ? 'active' : ''}
              title={`${count} skills`}
              onClick={() => { setCategory(cat); setLimit(PAGE_SIZE); }}
            >{cat}</button>
          ))}
        </div>
      )}
      <div className="aside-skills-list">
        {items === null && <div className="aside-skills-empty"><Loader2 size={14} className="browser-spin" /> Loading skill packs…</div>}
        {items !== null && error && <div className="aside-skills-empty">Failed to load some sources: {error}</div>}
        {items !== null && filtered.length === 0 && !error && <div className="aside-skills-empty">No skills match.</div>}
        {visible.map(({ skill, origin, pack }) => (
          <div key={`${origin}-${skill.id}`} className="aside-skill-row">
            <span className="aside-skill-emoji">{skill.emoji || '🧩'}</span>
            <div className="aside-skill-main">
              <div className="aside-skill-name" title={skill.name}>
                {skill.name}
                <span className={`aside-skill-origin o-${origin}`}>{SOURCE_LABEL[origin]}</span>
              </div>
              <div className="aside-skill-desc" title={`${skill.description}\n\nPack: ${pack}`}>{skill.description}</div>
            </div>
            <button
              type="button"
              className={`aside-skill-fav${favs.includes(skill.id) ? ' on' : ''}`}
              title={favs.includes(skill.id) ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => toggleFav(skill.id)}
            ><Star size={13} /></button>
            <button
              type="button"
              className="aside-skill-run"
              title="Run this skill with BBARIT (opens the chat pane)"
              onClick={() => onRunSkill(skill)}
            ><Play size={12} /> Run</button>
          </div>
        ))}
        {filtered.length > visible.length && (
          <button type="button" className="aside-skills-more" onClick={() => setLimit((v) => v + PAGE_SIZE)}>
            Show more ({(filtered.length - visible.length).toLocaleString()} left)
          </button>
        )}
      </div>
    </div>
  );
}
