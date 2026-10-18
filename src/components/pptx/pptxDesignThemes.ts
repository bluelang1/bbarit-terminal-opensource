import type { Slide, SlideElement } from './types';

export interface PptxDesignTheme {
  id: string;
  label: string;
  description: string;
  bgColor: string;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  surfaceAltColor: string;
  textColor: string;
  mutedTextColor: string;
  fontFamily: string;
}

export const PPTX_DESIGN_THEMES: PptxDesignTheme[] = [
  {
    id: 'executive-ink',
    label: 'Executive Ink',
    description: 'High-contrast boardroom pages with crisp blue accents.',
    bgColor: '#f8fafc',
    primaryColor: '#0f172a',
    accentColor: '#2563eb',
    surfaceColor: '#dbeafe',
    surfaceAltColor: '#e2e8f0',
    textColor: '#111827',
    mutedTextColor: '#475569',
    fontFamily: 'system-ui',
  },
  {
    id: 'startup-signal',
    label: 'Startup Signal',
    description: 'Punchy green and cyan for product demos and momentum updates.',
    bgColor: '#061512',
    primaryColor: '#14b8a6',
    accentColor: '#84cc16',
    surfaceColor: '#12312b',
    surfaceAltColor: '#1e3a34',
    textColor: '#ecfeff',
    mutedTextColor: '#a7f3d0',
    fontFamily: 'system-ui',
  },
  {
    id: 'editorial-red',
    label: 'Editorial Red',
    description: 'Magazine-like contrast for bold narratives and launches.',
    bgColor: '#fff7ed',
    primaryColor: '#7f1d1d',
    accentColor: '#dc2626',
    surfaceColor: '#fed7aa',
    surfaceAltColor: '#fecaca',
    textColor: '#1f2937',
    mutedTextColor: '#6b7280',
    fontFamily: 'Serif',
  },
  {
    id: 'data-lab',
    label: 'Data Lab',
    description: 'Calm analytical palette for dashboards, KPIs, and research.',
    bgColor: '#eef2ff',
    primaryColor: '#312e81',
    accentColor: '#0891b2',
    surfaceColor: '#c7d2fe',
    surfaceAltColor: '#cffafe',
    textColor: '#172554',
    mutedTextColor: '#475569',
    fontFamily: 'Nanum Gothic',
  },
  {
    id: 'studio-mono',
    label: 'Studio Mono',
    description: 'Minimal black and white pages for portfolios and critique.',
    bgColor: '#fafafa',
    primaryColor: '#18181b',
    accentColor: '#71717a',
    surfaceColor: '#e4e4e7',
    surfaceAltColor: '#f4f4f5',
    textColor: '#09090b',
    mutedTextColor: '#52525b',
    fontFamily: 'Monospace',
  },
  {
    id: 'market-sunrise',
    label: 'Market Sunrise',
    description: 'Warm coral, teal, and ivory for campaign stories and GTM plans.',
    bgColor: '#fffaf0',
    primaryColor: '#164e63',
    accentColor: '#f97316',
    surfaceColor: '#ccfbf1',
    surfaceAltColor: '#fed7aa',
    textColor: '#111827',
    mutedTextColor: '#64748b',
    fontFamily: 'system-ui',
  },
  {
    id: 'research-paper',
    label: 'Research Paper',
    description: 'Editorial research pages with restrained graphite and emerald signals.',
    bgColor: '#f7f7f2',
    primaryColor: '#1f2937',
    accentColor: '#059669',
    surfaceColor: '#e5e7eb',
    surfaceAltColor: '#d1fae5',
    textColor: '#111827',
    mutedTextColor: '#4b5563',
    fontFamily: 'Serif',
  },
  {
    id: 'sales-contrast',
    label: 'Sales Contrast',
    description: 'Direct commercial pages with black, white, and decisive amber.',
    bgColor: '#ffffff',
    primaryColor: '#111827',
    accentColor: '#f59e0b',
    surfaceColor: '#f3f4f6',
    surfaceAltColor: '#fef3c7',
    textColor: '#111827',
    mutedTextColor: '#6b7280',
    fontFamily: 'system-ui',
  },
  {
    id: 'portfolio-gallery',
    label: 'Portfolio Gallery',
    description: 'Clean gallery-style pages for case studies, work samples, and critique.',
    bgColor: '#f5f5f4',
    primaryColor: '#292524',
    accentColor: '#0d9488',
    surfaceColor: '#e7e5e4',
    surfaceAltColor: '#ccfbf1',
    textColor: '#1c1917',
    mutedTextColor: '#57534e',
    fontFamily: 'system-ui',
  },
  {
    id: 'architecture-blueprint',
    label: 'Architecture Blueprint',
    description: 'Technical architecture pages with blueprint cyan, white surfaces, and precise labels.',
    bgColor: '#f1f5f9',
    primaryColor: '#075985',
    accentColor: '#ef4444',
    surfaceColor: '#e0f2fe',
    surfaceAltColor: '#ffffff',
    textColor: '#0f172a',
    mutedTextColor: '#475569',
    fontFamily: 'Monospace',
  },
  {
    id: 'investor-copper',
    label: 'Investor Copper',
    description: 'Premium investor update styling with copper signals, graphite text, and clean data blocks.',
    bgColor: '#fff7ed',
    primaryColor: '#27272a',
    accentColor: '#b45309',
    surfaceColor: '#fed7aa',
    surfaceAltColor: '#fef3c7',
    textColor: '#18181b',
    mutedTextColor: '#57534e',
    fontFamily: 'system-ui',
  },
  {
    id: 'keynote-spectrum',
    label: 'Keynote Spectrum',
    description: 'Large-stage keynote styling with charcoal, electric cyan, and editorial color blocks.',
    bgColor: '#0a0f1f',
    primaryColor: '#22d3ee',
    accentColor: '#f43f5e',
    surfaceColor: '#172554',
    surfaceAltColor: '#312e81',
    textColor: '#f8fafc',
    mutedTextColor: '#bae6fd',
    fontFamily: 'system-ui',
  },
  {
    id: 'finance-terminal',
    label: 'Finance Terminal',
    description: 'CFO-ready pages with slate text, green variance signals, and quiet reporting surfaces.',
    bgColor: '#f8fafc',
    primaryColor: '#102a43',
    accentColor: '#16a34a',
    surfaceColor: '#dbeafe',
    surfaceAltColor: '#dcfce7',
    textColor: '#111827',
    mutedTextColor: '#52616b',
    fontFamily: 'system-ui',
  },
  {
    id: 'customer-aurora',
    label: 'Customer Aurora',
    description: 'Customer-facing QBR pages with teal confidence, rose attention markers, and clean account cards.',
    bgColor: '#fff7f3',
    primaryColor: '#0f766e',
    accentColor: '#e11d48',
    surfaceColor: '#ccfbf1',
    surfaceAltColor: '#ffe4e6',
    textColor: '#1f2937',
    mutedTextColor: '#64748b',
    fontFamily: 'system-ui',
  },
  {
    id: 'product-prism',
    label: 'Product Prism',
    description: 'Product strategy pages with indigo structure, orange launch signals, and roadmap-friendly blocks.',
    bgColor: '#f8fafc',
    primaryColor: '#4338ca',
    accentColor: '#f97316',
    surfaceColor: '#e0e7ff',
    surfaceAltColor: '#ffedd5',
    textColor: '#111827',
    mutedTextColor: '#475569',
    fontFamily: 'system-ui',
  },
  {
    id: 'legal-graphite',
    label: 'Legal Graphite',
    description: 'Matter-ready legal pages with graphite structure, crimson risk markers, and evidence tables.',
    bgColor: '#f9fafb',
    primaryColor: '#1f2937',
    accentColor: '#be123c',
    surfaceColor: '#e5e7eb',
    surfaceAltColor: '#ffe4e6',
    textColor: '#111827',
    mutedTextColor: '#4b5563',
    fontFamily: 'Serif',
  },
  {
    id: 'clinical-clear',
    label: 'Clinical Clear',
    description: 'Healthcare and research pages with clean teal, blue confidence, and safety-callout surfaces.',
    bgColor: '#f0fdfa',
    primaryColor: '#0f766e',
    accentColor: '#2563eb',
    surfaceColor: '#ccfbf1',
    surfaceAltColor: '#dbeafe',
    textColor: '#134e4a',
    mutedTextColor: '#475569',
    fontFamily: 'system-ui',
  },
  {
    id: 'townhall-lime',
    label: 'Town Hall Lime',
    description: 'Internal all-hands pages with charcoal structure, lime momentum, and clear commitment blocks.',
    bgColor: '#f7fee7',
    primaryColor: '#1a2e05',
    accentColor: '#65a30d',
    surfaceColor: '#d9f99d',
    surfaceAltColor: '#e2e8f0',
    textColor: '#111827',
    mutedTextColor: '#4b5563',
    fontFamily: 'system-ui',
  },
  {
    id: 'event-signal',
    label: 'Event Signal',
    description: 'Sponsorship and event pitch pages with night contrast, magenta energy, and bright value blocks.',
    bgColor: '#0f1020',
    primaryColor: '#f472b6',
    accentColor: '#22d3ee',
    surfaceColor: '#1e293b',
    surfaceAltColor: '#312e81',
    textColor: '#f8fafc',
    mutedTextColor: '#bae6fd',
    fontFamily: 'system-ui',
  },
];

export function getPptxDesignTheme(themeId: string): PptxDesignTheme {
  return PPTX_DESIGN_THEMES.find((theme) => theme.id === themeId) || PPTX_DESIGN_THEMES[0];
}

function isTitleLikeText(el: SlideElement): boolean {
  return el.type === 'text' && ((el.fontSize || 0) >= 24 || Boolean(el.bold) || el.y <= 18);
}

function themeElement(el: SlideElement, theme: PptxDesignTheme, visualIndex: number): SlideElement {
  if (el.type === 'image') return { ...el };
  if (el.type === 'line') {
    return { ...el, borderColor: theme.accentColor };
  }
  if (el.type === 'text') {
    return {
      ...el,
      fontFamily: theme.fontFamily,
      fontColor: isTitleLikeText(el) ? theme.primaryColor : theme.textColor,
    };
  }

  const shapeColors = [theme.surfaceColor, theme.surfaceAltColor, theme.primaryColor, theme.accentColor];
  const fillColor = shapeColors[visualIndex % shapeColors.length];
  const isDarkFill = fillColor === theme.primaryColor;
  return {
    ...el,
    fillColor,
    borderColor: el.borderWidth ? theme.accentColor : el.borderColor,
    fontFamily: theme.fontFamily,
    fontColor: isDarkFill ? theme.bgColor : theme.textColor,
  };
}

export function applyDesignThemeToSlide(slide: Slide, theme: PptxDesignTheme): Slide {
  let visualIndex = 0;
  const elements = slide.elements.map((el) => {
    const next = themeElement(el, theme, visualIndex);
    if (el.type !== 'text' && el.type !== 'image' && el.type !== 'line') visualIndex += 1;
    return next;
  });
  return {
    ...slide,
    bgColor: theme.bgColor,
    elements,
  };
}

export function applyDesignThemeToSlides(slides: Slide[], theme: PptxDesignTheme): Slide[] {
  return slides.map((slide) => applyDesignThemeToSlide(slide, theme));
}
