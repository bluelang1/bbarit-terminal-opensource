// Getting-started guide + What's new (/guide tool window, label `tool-guide`).
// The main window owns progress and the spotlight; this page only renders and
// emits guide-* events to `main` (spec: docs/superpowers/specs/2026-11-08-onboarding-guide-design.md).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { ArrowRight, Check, ExternalLink, Minus, MousePointerClick, RefreshCw, RotateCcw, Shield, Sparkles, Wrench, BookOpen, Gift } from 'lucide-react';
import CHANGELOG_KO from '../../CHANGELOG.md?raw';
import CHANGELOG_EN from '../../CHANGELOG.en.md?raw';
import { useTranslation, type TranslationKey } from '../i18n';
import { kvGetJSON } from '../hooks/useKV';
import { RELEASE_REPO_MAC } from '../config/endpoints';
import {
  inlineTokens,
  localizedSections,
  olderSections,
  parseChangelog,
  sectionsToShow,
  type ChangeKind,
  type ChangelogSection,
} from '../guide/changelog';
import {
  GUIDE_PROGRESS_KEY,
  doneCount,
  isGuideStepId,
  normalizeProgress,
  visibleSteps,
  type GuideProgress,
  type GuideStep,
  type GuideStepId,
} from '../guide/steps';
import { StepIllustration } from '../guide/illustrations';
import './GuidePage.css';

type Mode = 'start' | 'whatsnew';

export interface GuideNavigate {
  mode: Mode;
  step?: GuideStepId;
  from?: string | null;
}

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
const RELEASES_URL = `https://github.com/${RELEASE_REPO_MAC}/releases`;
// Korean is the source of truth; other languages read the English mirror and
// fall back to the Korean section for a version it lacks.
const KO_SECTIONS = parseChangelog(CHANGELOG_KO);
let enSections: ChangelogSection[] | null = null;
function sectionsFor(locale: string): ChangelogSection[] {
  if (locale === 'ko') return KO_SECTIONS;
  enSections ??= localizedSections(parseChangelog(CHANGELOG_EN), KO_SECTIONS);
  return enSections;
}
const OLDER_LIMIT = 8;

const KIND_META: Record<ChangeKind, { key: TranslationKey; Icon: typeof Sparkles }> = {
  added: { key: 'guide.kind.added', Icon: Sparkles },
  changed: { key: 'guide.kind.changed', Icon: RefreshCw },
  fixed: { key: 'guide.kind.fixed', Icon: Wrench },
  removed: { key: 'guide.kind.removed', Icon: Minus },
  security: { key: 'guide.kind.security', Icon: Shield },
};
const KIND_ORDER: ChangeKind[] = ['added', 'changed', 'fixed', 'removed', 'security'];

function readQuery(): GuideNavigate {
  const q = new URLSearchParams(window.location.search);
  const mode: Mode = q.get('mode') === 'whatsnew' ? 'whatsnew' : 'start';
  const step = q.get('step');
  return { mode, step: isGuideStepId(step) ? step : undefined, from: q.get('from') || null };
}

function toMain(event: string, payload?: unknown) {
  if (!isTauri()) return;
  void emitTo('main', event, payload).catch(() => {});
}

async function openExternal(url: string) {
  try {
    await invoke('plugin:shell|open', { path: url });
  } catch {
    try { window.open(url, '_blank', 'noopener,noreferrer'); } catch { /* ignore */ }
  }
}

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

function firstOpenStep(steps: GuideStep[], progress: GuideProgress): GuideStepId {
  return (steps.find(s => progress[s.id] == null) ?? steps[0]).id;
}

export default function GuidePage() {
  const { t, locale } = useTranslation();
  const steps = useMemo(() => visibleSteps(IS_MAC), []);
  const initial = useMemo(() => readQuery(), []);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [from, setFrom] = useState<string | null>(initial.from ?? null);
  const [current, setCurrent] = useState<GuideStepId | null>(initial.step ?? null);
  const [progress, setProgress] = useState<GuideProgress>({});
  const [version, setVersion] = useState<string | null>(null);
  // Hold the start view until saved progress is read, so it opens on the first
  // unfinished step instead of flashing step 1.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('guide-page-root');
    return () => document.documentElement.classList.remove('guide-page-root');
  }, []);

  useEffect(() => {
    let alive = true;
    kvGetJSON<unknown>(GUIDE_PROGRESS_KEY, {}).then((raw) => {
      if (!alive) return;
      const p = normalizeProgress(raw);
      setProgress(prev => ({ ...p, ...prev }));
      setCurrent(c => c ?? firstOpenStep(steps, p));
    }).catch(() => {}).finally(() => { if (alive) setLoaded(true); });
    if (isTauri()) {
      getVersion().then(v => { if (alive) setVersion(v); }).catch(() => {});
    }
    return () => { alive = false; };
  }, [steps]);

  useEffect(() => {
    if (!isTauri()) return;
    const offs = [
      listen<{ progress?: unknown }>('guide-progress', (e) => {
        setProgress(normalizeProgress(e.payload?.progress));
      }),
      listen<GuideNavigate>('guide-navigate', (e) => {
        const nav = e.payload;
        if (!nav) return;
        setMode(nav.mode === 'whatsnew' ? 'whatsnew' : 'start');
        if (nav.mode === 'whatsnew') setFrom(nav.from ?? null);
        if (isGuideStepId(nav.step)) setCurrent(nav.step);
      }),
    ];
    return () => { offs.forEach(p => { void p.then(off => off()).catch(() => {}); }); };
  }, []);

  useEffect(() => {
    document.title = mode === 'whatsnew' ? t('guide.menu.whatsnew') : t('guide.title');
  }, [mode, t]);

  const close = useCallback(() => {
    if (isTauri()) void getCurrentWebviewWindow().close().catch(() => {});
    else window.close();
  }, []);

  return (
    <div className="guide-page">
      {mode === 'start' ? (!loaded ? null : (
        <StartView
          steps={steps}
          current={current ?? firstOpenStep(steps, progress)}
          progress={progress}
          onSelect={setCurrent}
          onNext={(id) => {
            setProgress(p => (p[id] != null ? p : { ...p, [id]: Date.now() }));
            toMain('guide-next', { stepId: id });
            const i = steps.findIndex(s => s.id === id);
            if (i >= 0 && i < steps.length - 1) setCurrent(steps[i + 1].id);
          }}
          onTry={(step) => {
            if (step.action) toMain('guide-action', { stepId: step.id });
            else if (step.target) toMain('guide-spotlight', { stepId: step.id });
          }}
          onReset={() => {
            setProgress({});
            setCurrent(steps[0].id);
            toMain('guide-reset');
          }}
          onFinish={close}
          onWhatsNew={() => { setFrom(null); setMode('whatsnew'); }}
          t={t}
        />
      )) : (
        <WhatsNewView
          locale={locale}
          version={version}
          from={from}
          onOpenGuide={() => setMode('start')}
          t={t}
        />
      )}
    </div>
  );
}

type TFn = (key: TranslationKey, fallback?: string) => string;

function StartView(props: {
  steps: GuideStep[];
  current: GuideStepId;
  progress: GuideProgress;
  onSelect: (id: GuideStepId) => void;
  onNext: (id: GuideStepId) => void;
  onTry: (step: GuideStep) => void;
  onReset: () => void;
  onFinish: () => void;
  onWhatsNew: () => void;
  t: TFn;
}) {
  const { steps, current, progress, t } = props;
  const index = Math.max(0, steps.findIndex(s => s.id === current));
  const step = steps[index];
  const done = doneCount(progress, steps);
  const total = steps.length;
  const isLast = index === total - 1;
  const canTry = !!(step.target || step.action);
  const k = (suffix: string) => `guide.step.${step.id}.${suffix}` as TranslationKey;

  return (
    <div className="guide-start">
      <aside className="guide-side">
        <div className="guide-brand">
          <span className="guide-brand-mark"><BookOpen size={16} /></span>
          <div>
            <h1>{t('guide.title')}</h1>
            <p>{fill(t('guide.subtitle'), { total })}</p>
          </div>
        </div>

        <div className="guide-progress" aria-label={fill(t('guide.progress'), { done, total })}>
          <div className="guide-progress-label">
            <span>{done === total ? t('guide.allDone') : fill(t('guide.progress'), { done, total })}</span>
            <span className="guide-progress-pct">{Math.round((done / total) * 100)}%</span>
          </div>
          <div className="guide-progress-track">
            <div className="guide-progress-fill" style={{ width: `${(done / total) * 100}%` }} />
          </div>
        </div>

        <ol className="guide-steps">
          {steps.map((s, i) => {
            const isDone = progress[s.id] != null;
            const isCurrent = s.id === current;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={`guide-step${isCurrent ? ' is-current' : ''}${isDone ? ' is-done' : ''}`}
                  onClick={() => props.onSelect(s.id)}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  <span className="guide-step-marker">{isDone ? <Check size={13} strokeWidth={3} /> : i + 1}</span>
                  <span className="guide-step-title">{t(s.titleKey as TranslationKey)}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="guide-side-foot">
          <button type="button" className="guide-link" onClick={props.onWhatsNew}>
            <Gift size={14} /> {t('guide.seeWhatsNew')}
          </button>
          <button type="button" className="guide-link guide-link-quiet" onClick={props.onReset}>
            <RotateCcw size={12} /> {t('guide.reset')}
          </button>
        </div>
      </aside>

      <main className="guide-main">
        <div className="guide-stage" key={step.id}>
          <div className="guide-illustration">
            <StepIllustration id={step.id} />
          </div>
          <div className="guide-copy">
            <div className="guide-eyebrow">
              {fill(t('guide.stepNumber'), { n: index + 1 })}
              {progress[step.id] != null && <span className="guide-done-pill"><Check size={11} strokeWidth={3} /> {t('guide.doneBadge')}</span>}
            </div>
            <h2>{t(step.titleKey as TranslationKey)}</h2>
            <p className="guide-body">{t(step.bodyKey as TranslationKey)}</p>
            {!canTry && <p className="guide-hint">{t(k('hint'))}</p>}
          </div>
          <div className="guide-actions">
            {canTry ? (
              <button type="button" className="guide-btn guide-btn-secondary" onClick={() => props.onTry(step)}>
                <MousePointerClick size={15} /> {t('guide.tryIt')}
              </button>
            ) : <span />}
            {isLast ? (
              <button type="button" className="guide-btn guide-btn-primary" onClick={() => { props.onNext(step.id); props.onFinish(); }}>
                <Check size={15} /> {t('guide.finish')}
              </button>
            ) : (
              <button type="button" className="guide-btn guide-btn-primary" onClick={() => props.onNext(step.id)}>
                {t('guide.next')} <ArrowRight size={15} />
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineTokens(text).map((tok, i) =>
        tok.kind === 'bold' ? <strong key={i}>{tok.text}</strong>
          : tok.kind === 'code' ? <code key={i}>{tok.text}</code>
            : <span key={i}>{tok.text}</span>,
      )}
    </>
  );
}

function SectionCards({ section, t, showHeading }: { section: ChangelogSection; t: TFn; showHeading: boolean }) {
  const groups = [...section.groups].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return (
    <section className="wn-section">
      {showHeading && (
        <h3 className="wn-version">
          <span>{section.version}</span>
          {section.date && <time>{section.date}</time>}
        </h3>
      )}
      {groups.map((g) => {
        const meta = KIND_META[g.kind];
        const Icon = meta.Icon;
        return (
          <div key={g.kind} className={`wn-card wn-${g.kind}`}>
            <div className="wn-card-head">
              <span className="wn-kind-icon"><Icon size={14} /></span>
              <span className="wn-kind-label">{t(meta.key)}</span>
            </div>
            <ul>
              {g.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

function WhatsNewView({ locale, version, from, onOpenGuide, t }: {
  locale: string;
  version: string | null;
  from: string | null;
  onOpenGuide: () => void;
  t: TFn;
}) {
  // Outside Tauri (or before getVersion answers) treat the newest release as current.
  const all = useMemo(() => sectionsFor(locale), [locale]);
  const current = version ?? all[0]?.version ?? '0.0.0';
  const shown = useMemo(() => sectionsToShow(all, from, current), [all, from, current]);
  const older = useMemo(() => olderSections(all, shown, OLDER_LIMIT, current), [all, shown, current]);
  const headVersion = shown[0]?.version ?? current;

  return (
    <div className="wn">
      <header className="wn-header">
        <span className="wn-badge"><Sparkles size={18} /></span>
        <div>
          <h1>{fill(t('guide.whatsnew.title'), { version: headVersion })}</h1>
          <p>{t('guide.whatsnew.subtitle')}</p>
        </div>
      </header>

      <div className="wn-body">
        {shown.length === 0 && <div className="wn-empty">{t('guide.whatsnew.empty')}</div>}
        {shown.map((s) => <SectionCards key={s.version} section={s} t={t} showHeading={shown.length > 1} />)}

        {older.length > 0 && (
          <details className="wn-older">
            <summary>{t('guide.whatsnew.older')}</summary>
            {older.map((s) => <SectionCards key={s.version} section={s} t={t} showHeading />)}
          </details>
        )}
      </div>

      <footer className="wn-footer">
        <button type="button" className="guide-link" onClick={() => { void openExternal(RELEASES_URL); }}>
          <ExternalLink size={14} /> {t('guide.whatsnew.allReleases')}
        </button>
        <button type="button" className="guide-btn guide-btn-primary" onClick={onOpenGuide}>
          <BookOpen size={15} /> {t('guide.whatsnew.openGuide')}
        </button>
      </footer>
    </div>
  );
}
