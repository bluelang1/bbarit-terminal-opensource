import type { Skill } from './types';
import { invoke, isTauri } from '@tauri-apps/api/core';

export type RemoteSkillPackManifest = {
  schemaVersion: string;
  generatedAt?: string;
  packs: RemoteSkillPackEntry[];
};

export type RemoteSkillPackEntry = {
  name: string;
  version: string;
  description?: string;
  url: string;
  sourceUrl?: string;
  checksumSha256?: string;
  skillCount?: number;
  skills?: Skill[];
};

export const EMBEDDED_OFFICIAL_MANIFEST_URL = 'octo://official/manifest';

/* ────────────────────────────────────────────────────────────
 *  EMBEDDED OFFICIAL SKILL PACKS
 *  30 packs · 200+ skills
 * ──────────────────────────────────────────────────────────── */
const S = (s: Omit<Skill, 'builtIn'>): Skill => ({ ...s, builtIn: false });

const EMBEDDED_OFFICIAL_PACKS: Record<string, Skill[]> = {

  /* ═══════════════════  1. Next.js Landing  ═══════════════════ */
  'nextjs-landing-v1': [
    S({ id: 'motion-stagger-reveal', name: 'Motion Stagger Reveal', description: 'Add staged reveal animation to cards using lightweight JS timing.', emoji: '🎬', command: 'Implement staggered reveal animations for card grids with performant requestAnimationFrame timing.', cliType: 'claude', category: 'frontend', tags: ['animation', 'performance', 'landing'] }),
    S({ id: 'nextjs-landing-hero-blueprint', name: 'Next.js Landing Hero Blueprint', description: 'Create a production-ready hero section with CTA, proof points, and responsive layout.', emoji: '🚀', command: 'Design and implement a responsive Next.js hero section with strong CTA and conversion-focused copy.', cliType: 'codex', category: 'frontend', tags: ['nextjs', 'landing', 'ui', 'conversion'] }),
    S({ id: 'nextjs-pricing-table', name: 'Next.js Pricing Table', description: 'Build a responsive pricing comparison table with toggle billing and feature highlights.', emoji: '💰', command: 'Create a production-ready pricing table component with monthly/yearly toggle, feature comparison rows, recommended tier highlight, and responsive card layout for Next.js.', cliType: 'claude', category: 'frontend', tags: ['nextjs', 'pricing', 'landing', 'saas'] }),
    S({ id: 'nextjs-testimonial-carousel', name: 'Testimonial Carousel', description: 'Auto-playing testimonial slider with avatar, rating, and smooth transitions.', emoji: '💬', command: 'Implement a testimonial carousel with auto-play, avatar images, star ratings, company logos, and accessible keyboard navigation for Next.js landing pages.', cliType: 'codex', category: 'frontend', tags: ['nextjs', 'landing', 'social-proof'] }),
    S({ id: 'nextjs-feature-grid', name: 'Feature Grid Section', description: 'Icon-based feature grid with hover effects and responsive columns.', emoji: '🔲', command: 'Build a responsive feature grid section with icon cards, hover elevation effects, description text, and auto-adjusting columns (1→2→3→4) for Next.js marketing pages.', cliType: 'claude', category: 'frontend', tags: ['nextjs', 'landing', 'features'] }),
    S({ id: 'nextjs-faq-accordion', name: 'FAQ Accordion', description: 'Accessible FAQ section with smooth expand/collapse animations.', emoji: '❓', command: 'Create an accessible FAQ accordion component with smooth height transitions, keyboard navigation, aria attributes, and schema.org FAQ structured data for SEO.', cliType: 'codex', category: 'frontend', tags: ['nextjs', 'landing', 'seo', 'a11y'] }),
  ],

  /* ═══════════════════  2. Design Core  ═══════════════════ */
  'design-core-v1': [
    S({ id: 'design-system-foundation-checklist', name: 'Design System Foundation Checklist', description: 'Build a practical plan for spacing, typography, and component hierarchy.', emoji: '🧭', command: 'Create a design system foundation checklist including token strategy, spacing scale, typography rules, and component priorities.', cliType: 'claude', category: 'docs', tags: ['design-system', 'tokens', 'ui', 'planning'] }),
    S({ id: 'figma-to-nextjs-handoff', name: 'Figma to Next.js Handoff', description: 'Generate implementation notes that map design artifacts to Next.js components.', emoji: '🧩', command: 'Produce an implementation handoff mapping each key Figma frame to reusable Next.js components and CSS variables.', cliType: 'codex', category: 'frontend', tags: ['figma', 'handoff', 'nextjs', 'design'] }),
    S({ id: 'color-palette-generator', name: 'Color Palette Generator', description: 'Generate accessible color palette with semantic tokens and contrast ratios.', emoji: '🎨', command: 'Generate a complete color palette system with primary, secondary, neutral, success, warning, error scales (50-950), ensure WCAG AA contrast ratios, and output as CSS custom properties and design tokens JSON.', cliType: 'claude', category: 'frontend', tags: ['design', 'color', 'accessibility', 'tokens'] }),
    S({ id: 'typography-scale-system', name: 'Typography Scale System', description: 'Create a modular typography scale with responsive fluid sizing.', emoji: '🔤', command: 'Design a modular typography scale using clamp() for fluid sizing, define heading/body/caption levels, set line-heights, letter-spacing, and font-weight mappings. Output as CSS custom properties with fallback px values.', cliType: 'claude', category: 'frontend', tags: ['design', 'typography', 'responsive', 'tokens'] }),
    S({ id: 'spacing-grid-system', name: 'Spacing & Grid System', description: 'Define a consistent spacing scale and responsive grid framework.', emoji: '📐', command: 'Create a spacing scale (4px base) with named tokens (xs through 3xl), responsive grid system with 12/16 columns, gutter and margin definitions, and breakpoint-aware container widths.', cliType: 'claude', category: 'frontend', tags: ['design', 'spacing', 'grid', 'layout'] }),
    S({ id: 'icon-system-guidelines', name: 'Icon System Guidelines', description: 'Establish icon design rules covering size, stroke, grid, and naming conventions.', emoji: '🖼️', command: 'Define an icon system with grid size (24px), stroke width conventions, optical alignment rules, size variants (16/20/24/32), naming taxonomy, and integration with React component patterns.', cliType: 'claude', category: 'docs', tags: ['design', 'icons', 'guidelines'] }),
  ],

  /* ═══════════════════  3. Vercel Platform  ═══════════════════ */
  'vercel-platform-v1': [
    S({ id: 'vercel-deploy-config', name: 'Vercel Deploy Config', description: 'Generate optimal vercel.json with rewrites, headers, and caching rules.', emoji: '▲', command: 'Generate a production-ready vercel.json configuration with optimal caching headers for static assets (1 year), security headers (X-Frame-Options, CSP, HSTS), rewrites for SPA/API proxy, and environment variable mappings.', cliType: 'claude', category: 'cloud', tags: ['vercel', 'deploy', 'config', 'headers'] }),
    S({ id: 'vercel-edge-function', name: 'Vercel Edge Function', description: 'Scaffold an Edge Function with geo-routing, A/B testing, or auth middleware.', emoji: '⚡', command: 'Create a Vercel Edge Function (middleware.ts) that implements geo-based routing, A/B testing via cookies, authentication token validation, and rate limiting using the Edge Runtime API.', cliType: 'codex', category: 'cloud', tags: ['vercel', 'edge', 'middleware', 'serverless'] }),
    S({ id: 'vercel-og-image', name: 'Vercel OG Image', description: 'Dynamic Open Graph image generation using @vercel/og.', emoji: '🖼️', command: 'Implement a dynamic OG image API route using @vercel/og (ImageResponse) with custom fonts, gradient backgrounds, title/description parameters, and proper caching headers for social media previews.', cliType: 'codex', category: 'frontend', tags: ['vercel', 'og-image', 'seo', 'social'] }),
    S({ id: 'vercel-cron-job', name: 'Vercel Cron Job', description: 'Set up scheduled serverless functions with vercel.json cron config.', emoji: '⏰', command: 'Configure Vercel Cron Jobs in vercel.json and implement corresponding API route handlers for scheduled tasks like data sync, cache invalidation, email digests, and health checks with proper error handling and logging.', cliType: 'claude', category: 'cloud', tags: ['vercel', 'cron', 'serverless', 'automation'] }),
    S({ id: 'vercel-analytics-setup', name: 'Vercel Analytics & Speed Insights', description: 'Integrate Vercel Analytics and Speed Insights for Web Vitals monitoring.', emoji: '📊', command: 'Set up Vercel Analytics and Speed Insights in a Next.js app: install @vercel/analytics and @vercel/speed-insights, add components to root layout, configure custom events for conversion tracking, and set up audience segments.', cliType: 'claude', category: 'frontend', tags: ['vercel', 'analytics', 'web-vitals', 'monitoring'] }),
    S({ id: 'vercel-isr-config', name: 'Vercel ISR Strategy', description: 'Implement Incremental Static Regeneration with on-demand revalidation.', emoji: '🔄', command: 'Implement ISR (Incremental Static Regeneration) with time-based revalidation, on-demand revalidation API route with secret token, tag-based revalidation, fallback loading states, and error handling for stale content serving.', cliType: 'codex', category: 'frontend', tags: ['vercel', 'isr', 'nextjs', 'caching'] }),
    S({ id: 'vercel-blob-storage', name: 'Vercel Blob Storage', description: 'File upload and management with @vercel/blob.', emoji: '📦', command: 'Implement file upload with @vercel/blob: create upload API route with size/type validation, client-side upload with progress tracking, list/delete operations, and presigned URL generation for direct client uploads.', cliType: 'codex', category: 'cloud', tags: ['vercel', 'blob', 'storage', 'upload'] }),
    S({ id: 'vercel-kv-cache', name: 'Vercel KV Cache', description: 'Redis-compatible caching with @vercel/kv for session and rate limiting.', emoji: '🗄️', command: 'Set up Vercel KV (Redis) for session management, API rate limiting with sliding window, feature flags, and distributed caching with TTL. Include helper functions and middleware patterns.', cliType: 'codex', category: 'cloud', tags: ['vercel', 'kv', 'redis', 'caching'] }),
    S({ id: 'vercel-postgres-drizzle', name: 'Vercel Postgres + Drizzle', description: 'Type-safe database layer with Vercel Postgres and Drizzle ORM.', emoji: '🐘', command: 'Set up Vercel Postgres with Drizzle ORM: define schema with relations, create migration scripts, implement type-safe queries with joins, pagination, and full-text search. Include connection pooling setup for serverless.', cliType: 'codex', category: 'db', tags: ['vercel', 'postgres', 'drizzle', 'orm'] }),
  ],

  /* ═══════════════════  4. Next.js Advanced  ═══════════════════ */
  'nextjs-advanced-v1': [
    S({ id: 'nextjs-app-router-layout', name: 'App Router Layout System', description: 'Nested layouts with parallel routes, intercepting routes, and error boundaries.', emoji: '🗂️', command: 'Design a Next.js App Router layout system with root layout, nested group layouts, parallel routes (@modal), intercepting routes (..), loading.tsx skeletons, error.tsx boundaries, and not-found.tsx pages.', cliType: 'claude', category: 'frontend', tags: ['nextjs', 'app-router', 'layout', 'routing'] }),
    S({ id: 'nextjs-server-components', name: 'React Server Components', description: 'Implement RSC patterns with streaming, suspense, and selective hydration.', emoji: '🌊', command: 'Implement React Server Components patterns: async server components with data fetching, streaming with Suspense boundaries, selective client hydration with "use client" directive, server actions for mutations, and proper composition of server/client components.', cliType: 'claude', category: 'react', tags: ['nextjs', 'rsc', 'streaming', 'suspense'] }),
    S({ id: 'nextjs-server-actions', name: 'Server Actions', description: 'Type-safe server actions with form validation and optimistic updates.', emoji: '🎯', command: 'Create type-safe Next.js Server Actions with Zod validation, useActionState for form handling, useOptimisticAction for instant UI feedback, error boundaries, revalidatePath/revalidateTag integration, and progressive enhancement.', cliType: 'codex', category: 'frontend', tags: ['nextjs', 'server-actions', 'forms', 'validation'] }),
    S({ id: 'nextjs-middleware-chain', name: 'Middleware Chain', description: 'Composable middleware with auth, i18n, rate limiting, and logging.', emoji: '🔗', command: 'Build a composable Next.js middleware chain that handles authentication checks, locale detection/redirect, rate limiting, request logging, A/B testing, and maintenance mode with proper matcher configuration.', cliType: 'codex', category: 'frontend', tags: ['nextjs', 'middleware', 'auth', 'i18n'] }),
    S({ id: 'nextjs-caching-strategy', name: 'Next.js Caching Strategy', description: 'Full caching strategy covering fetch, route, data, and full-route cache.', emoji: '💾', command: 'Design a comprehensive Next.js caching strategy: fetch cache with revalidate options, unstable_cache for database queries, route segment config (dynamic/force-static), generateStaticParams for static generation, and cache tag management.', cliType: 'claude', category: 'performance', tags: ['nextjs', 'caching', 'isr', 'performance'] }),
    S({ id: 'nextjs-auth-nextauth', name: 'NextAuth.js v5 Setup', description: 'Complete authentication with NextAuth.js v5, OAuth, credentials, and RBAC.', emoji: '🔐', command: 'Set up NextAuth.js v5 (Auth.js) with GitHub/Google OAuth providers, credentials provider with bcrypt, JWT/session callbacks, role-based access control middleware, protected API routes, and client-side useSession patterns.', cliType: 'codex', category: 'security', tags: ['nextjs', 'auth', 'oauth', 'rbac'] }),
    S({ id: 'nextjs-i18n-setup', name: 'Next.js i18n Setup', description: 'Internationalization with App Router, middleware detection, and namespaced translations.', emoji: '🌍', command: 'Implement Next.js internationalization: locale detection middleware, [locale] dynamic route segment, server-side dictionary loading, client-side useTranslation hook, language switcher component, and SEO hreflang tags.', cliType: 'codex', category: 'frontend', tags: ['nextjs', 'i18n', 'localization', 'seo'] }),
  ],

  /* ═══════════════════  5. React Patterns  ═══════════════════ */
  'react-patterns-v1': [
    S({ id: 'react-compound-component', name: 'Compound Component Pattern', description: 'Build flexible compound components with implicit state sharing.', emoji: '🧱', command: 'Implement the compound component pattern in React: create a parent component with Context, child sub-components that consume shared state, flexible composition API (like <Select><Select.Option>), and TypeScript generics for type safety.', cliType: 'claude', category: 'react', tags: ['react', 'patterns', 'compound', 'composition'] }),
    S({ id: 'react-custom-hooks', name: 'Custom Hooks Collection', description: 'Reusable hooks for debounce, intersection observer, media query, and localStorage.', emoji: '🪝', command: 'Create a collection of production-ready React hooks: useDebounce, useThrottle, useIntersectionObserver, useMediaQuery, useLocalStorage, useClickOutside, usePrevious, useEventListener, useIsomorphicLayoutEffect, and useCopyToClipboard with full TypeScript types.', cliType: 'codex', category: 'react', tags: ['react', 'hooks', 'utilities', 'typescript'] }),
    S({ id: 'react-render-props', name: 'Render Props & HOC', description: 'Implement render props and higher-order component patterns with TypeScript.', emoji: '🔁', command: 'Implement render props pattern and higher-order components in React with TypeScript: create a Fetch component with render prop, mouse tracker, withAuth HOC, withLoading HOC, and show when to use each pattern vs hooks.', cliType: 'claude', category: 'react', tags: ['react', 'patterns', 'render-props', 'hoc'] }),
    S({ id: 'react-state-machines', name: 'State Machine Pattern', description: 'Model complex UI states with finite state machines using useReducer.', emoji: '🤖', command: 'Implement state machine patterns in React using useReducer: model form wizard states, async data fetching states (idle→loading→success→error), multi-step checkout flow, and provide a generic useStateMachine hook with TypeScript discriminated unions.', cliType: 'claude', category: 'react', tags: ['react', 'state-machine', 'reducer', 'patterns'] }),
    S({ id: 'react-error-boundary', name: 'Error Boundary System', description: 'Hierarchical error boundaries with fallback UI, retry, and error reporting.', emoji: '🛡️', command: 'Build an error boundary system: generic ErrorBoundary class component, useErrorHandler hook, fallback UI with retry button, error reporting integration, scoped boundaries per feature, and Suspense + ErrorBoundary composition.', cliType: 'codex', category: 'react', tags: ['react', 'error-boundary', 'error-handling', 'resilience'] }),
    S({ id: 'react-virtualized-list', name: 'Virtualized List', description: 'High-performance virtualized list and grid for large datasets.', emoji: '📜', command: 'Implement virtualized scrolling with react-window or @tanstack/virtual: fixed-size list, variable-size list with dynamic measurement, virtualized grid, infinite scroll with data fetching, and proper keyboard navigation.', cliType: 'codex', category: 'react', tags: ['react', 'virtualization', 'performance', 'list'] }),
    S({ id: 'react-context-optimization', name: 'Context Optimization', description: 'Prevent unnecessary re-renders with context splitting and memoization.', emoji: '⚡', command: 'Optimize React Context performance: split contexts by update frequency, use useMemo for value stabilization, implement context selectors pattern, zustand-style subscribe pattern, and demonstrate with before/after React DevTools profiler comparison.', cliType: 'claude', category: 'react', tags: ['react', 'context', 'performance', 'optimization'] }),
  ],

  /* ═══════════════════  6. TypeScript Advanced  ═══════════════════ */
  'typescript-advanced-v1': [
    S({ id: 'ts-branded-types', name: 'Branded Types', description: 'Compile-time type safety with branded/nominal types for IDs and units.', emoji: '🏷️', command: 'Implement branded types in TypeScript: create Brand<T, B> utility, branded UserId/OrderId to prevent mixing, unit types (Pixels, Rem, Milliseconds), validated email/URL types, and runtime validators that return branded types.', cliType: 'claude', category: 'dev', tags: ['typescript', 'types', 'branded', 'safety'] }),
    S({ id: 'ts-utility-types', name: 'Advanced Utility Types', description: 'Build custom utility types: DeepPartial, DeepReadonly, PathOf, and more.', emoji: '🔧', command: 'Create advanced TypeScript utility types: DeepPartial<T>, DeepReadonly<T>, DeepRequired<T>, PathOf<T> for dot-notation paths, ValueAt<T, P>, Prettify<T>, StrictOmit<T, K>, MergeDeep<A, B>, TupleToUnion, and UnionToIntersection.', cliType: 'claude', category: 'dev', tags: ['typescript', 'utility-types', 'generics', 'advanced'] }),
    S({ id: 'ts-type-guards', name: 'Type Guards & Narrowing', description: 'Exhaustive type guards, assertion functions, and discriminated unions.', emoji: '🔍', command: 'Implement TypeScript type narrowing patterns: is/assert type guard functions, discriminated union pattern for API responses, exhaustive switch with never, satisfies operator usage, and template literal type narrowing.', cliType: 'claude', category: 'dev', tags: ['typescript', 'type-guards', 'narrowing', 'patterns'] }),
    S({ id: 'ts-generic-patterns', name: 'Generic Patterns', description: 'Builder pattern, factory pattern, and generic constraints with TypeScript.', emoji: '🏗️', command: 'Implement TypeScript generic patterns: builder pattern with method chaining, generic factory with type inference, conditional types for API response handling, mapped types for form state, and generic event emitter with type-safe listeners.', cliType: 'claude', category: 'dev', tags: ['typescript', 'generics', 'patterns', 'builder'] }),
    S({ id: 'ts-zod-schemas', name: 'Zod Schema Library', description: 'Type-safe runtime validation schemas for API, forms, and config.', emoji: '✅', command: 'Build a Zod schema library: API request/response schemas, form validation with custom error messages, environment variable parsing, configuration file validation, and shared schemas between frontend and backend with z.infer type extraction.', cliType: 'codex', category: 'dev', tags: ['typescript', 'zod', 'validation', 'schema'] }),
    S({ id: 'ts-strict-config', name: 'TypeScript Strict Config', description: 'Maximal TypeScript strictness with ESLint type-aware rules.', emoji: '🔒', command: 'Configure maximum TypeScript strictness: tsconfig.json with all strict flags, ESLint typescript-eslint strict-type-checked rules, no-explicit-any ban, consistent-type-imports, naming-convention rules, and path aliases setup.', cliType: 'claude', category: 'dev', tags: ['typescript', 'config', 'eslint', 'strict'] }),
  ],

  /* ═══════════════════  7. Tailwind CSS  ═══════════════════ */
  'tailwind-css-v1': [
    S({ id: 'tailwind-custom-theme', name: 'Tailwind Custom Theme', description: 'Extended Tailwind theme with brand colors, fonts, animations, and plugins.', emoji: '🎨', command: 'Create a comprehensive Tailwind CSS custom theme: extend colors with brand palette (50-950), custom font families with font-feature-settings, animation keyframes (fadeIn, slideUp, pulse, shimmer), custom spacing scale, container queries plugin, and typography plugin config.', cliType: 'claude', category: 'frontend', tags: ['tailwind', 'theme', 'config', 'design'] }),
    S({ id: 'tailwind-component-recipes', name: 'Tailwind Component Recipes', description: 'Ready-to-use Tailwind patterns for buttons, cards, modals, and navigation.', emoji: '🧁', command: 'Build Tailwind CSS component recipes: button variants (primary/secondary/ghost/danger with sizes), card with hover effects, modal/dialog overlay, responsive navbar with mobile menu, dropdown menu, toast notification, badge variants, and avatar with status indicator.', cliType: 'codex', category: 'frontend', tags: ['tailwind', 'components', 'ui', 'recipes'] }),
    S({ id: 'tailwind-dark-mode', name: 'Tailwind Dark Mode System', description: 'Complete dark mode with system preference detection and manual toggle.', emoji: '🌙', command: 'Implement Tailwind dark mode: class-based strategy with system preference detection, localStorage persistence, smooth color transitions, dark: variant usage patterns, CSS custom properties bridge for dynamic theming, and ThemeProvider React component.', cliType: 'codex', category: 'frontend', tags: ['tailwind', 'dark-mode', 'theme', 'accessibility'] }),
    S({ id: 'tailwind-responsive-patterns', name: 'Tailwind Responsive Patterns', description: 'Mobile-first responsive layouts with container queries and fluid typography.', emoji: '📱', command: 'Create responsive Tailwind patterns: mobile-first breakpoint strategies, container queries with @container, fluid typography with clamp(), responsive grid layouts (1→2→3→4 cols), aspect-ratio utilities, and responsive spacing with custom screen breakpoints.', cliType: 'claude', category: 'frontend', tags: ['tailwind', 'responsive', 'mobile-first', 'layout'] }),
    S({ id: 'tailwind-animation-library', name: 'Tailwind Animation Library', description: 'Custom animation utilities and keyframe presets for micro-interactions.', emoji: '✨', command: 'Build a Tailwind animation library: entrance animations (fade, slide, scale, blur), exit animations, skeleton loading shimmer, progress bar, scroll-triggered reveals, stagger children, hover micro-interactions, and spring-based motion with custom cubic-bezier.', cliType: 'codex', category: 'frontend', tags: ['tailwind', 'animation', 'motion', 'micro-interactions'] }),
  ],

  /* ═══════════════════  8. CSS Advanced  ═══════════════════ */
  'css-advanced-v1': [
    S({ id: 'css-grid-layouts', name: 'CSS Grid Layout Patterns', description: 'Complex grid layouts: magazine, dashboard, holy grail, and masonry.', emoji: '📰', command: 'Implement advanced CSS Grid layouts: magazine-style asymmetric grid, dashboard with sidebar, holy grail layout, masonry with grid-template-rows, auto-fit/auto-fill responsive grid, subgrid patterns, and named grid areas with media query transitions.', cliType: 'claude', category: 'frontend', tags: ['css', 'grid', 'layout', 'responsive'] }),
    S({ id: 'css-container-queries', name: 'Container Queries', description: 'Component-level responsive design with @container and container query units.', emoji: '📦', command: 'Implement CSS Container Queries: container-type setup, @container breakpoints for component-level responsiveness, container query units (cqw/cqh), style queries for theme variants, and practical patterns for cards, sidebars, and navigation that adapt to parent size.', cliType: 'claude', category: 'frontend', tags: ['css', 'container-queries', 'responsive', 'modern'] }),
    S({ id: 'css-custom-properties', name: 'CSS Custom Properties System', description: 'Dynamic theming with CSS variables, cascading overrides, and calculations.', emoji: '🎯', command: 'Build a CSS custom properties system: global token variables, component-scoped overrides, calc() compositions, theme switching with class toggling, @property typed custom properties with animation, and fallback strategies for older browsers.', cliType: 'claude', category: 'frontend', tags: ['css', 'custom-properties', 'variables', 'theming'] }),
    S({ id: 'css-scroll-animations', name: 'Scroll-Driven Animations', description: 'CSS scroll-linked animations with scroll-timeline and view-timeline.', emoji: '📜', command: 'Implement CSS scroll-driven animations: scroll() timeline for progress indicators, view() timeline for reveal-on-scroll effects, animation-range for precise trigger points, parallax effects, sticky header transitions, and progressive enhancement fallbacks.', cliType: 'claude', category: 'frontend', tags: ['css', 'scroll', 'animation', 'modern'] }),
    S({ id: 'css-has-selector', name: 'CSS :has() Patterns', description: 'Parent selection patterns with :has() for form states, validation, and layout.', emoji: '🎯', command: 'Implement CSS :has() selector patterns: form validation styling (:has(:invalid)), conditional layouts based on child content, quantity queries (:has(:nth-child)), sibling-aware styling, and responsive navigation patterns using :has().', cliType: 'claude', category: 'frontend', tags: ['css', 'has-selector', 'modern', 'patterns'] }),
  ],

  /* ═══════════════════  9. UI/UX Design  ═══════════════════ */
  'ui-ux-design-v1': [
    S({ id: 'design-accessibility-audit', name: 'Accessibility Audit', description: 'WCAG 2.2 compliance audit with automated and manual testing checklist.', emoji: '♿', command: 'Conduct a WCAG 2.2 accessibility audit: check color contrast ratios (AA/AAA), keyboard navigation flow, screen reader landmarks and ARIA, focus management, motion preferences (prefers-reduced-motion), touch target sizes, and generate a prioritized remediation plan.', cliType: 'claude', category: 'docs', tags: ['design', 'accessibility', 'wcag', 'audit'] }),
    S({ id: 'design-responsive-breakpoints', name: 'Responsive Breakpoint Strategy', description: 'Define breakpoint system with device analytics and content-first approach.', emoji: '📏', command: 'Design a responsive breakpoint strategy: content-first breakpoint definitions, device analytics-informed sizes, mobile/tablet/desktop/wide layouts, touch vs pointer media queries, container query integration, and testing matrix across common device sizes.', cliType: 'claude', category: 'docs', tags: ['design', 'responsive', 'breakpoints', 'strategy'] }),
    S({ id: 'design-micro-interactions', name: 'Micro-Interaction Design', description: 'Design micro-interactions for buttons, toggles, inputs, and loading states.', emoji: '✨', command: 'Design micro-interaction specifications for: button hover/press/loading states, toggle switch with spring animation, input focus/error/success transitions, skeleton loading shimmer, pull-to-refresh, swipe-to-delete, and tooltip appear/dismiss. Include timing curves and duration guidelines.', cliType: 'claude', category: 'frontend', tags: ['design', 'micro-interactions', 'animation', 'ux'] }),
    S({ id: 'design-empty-states', name: 'Empty State Design', description: 'Design engaging empty states for onboarding, no results, and error scenarios.', emoji: '🫧', command: 'Design empty state patterns for: first-use onboarding with action prompts, no search results with suggestions, error states with recovery options, empty lists with creation CTAs, offline state, and permission required state. Include illustration guidelines and copy best practices.', cliType: 'claude', category: 'docs', tags: ['design', 'empty-states', 'ux', 'onboarding'] }),
    S({ id: 'design-form-ux', name: 'Form UX Best Practices', description: 'Optimize form design with inline validation, smart defaults, and progressive disclosure.', emoji: '📝', command: 'Design form UX patterns: inline validation timing (on blur vs change), error message placement, smart default values, progressive disclosure for complex forms, multi-step wizard with progress indicator, autofill-friendly markup, and mobile keyboard optimization (inputmode).', cliType: 'claude', category: 'docs', tags: ['design', 'forms', 'ux', 'validation'] }),
    S({ id: 'design-loading-patterns', name: 'Loading State Patterns', description: 'Skeleton screens, optimistic UI, progressive loading, and shimmer effects.', emoji: '⏳', command: 'Design loading state patterns: skeleton screens matching content layout, optimistic updates with rollback, progressive image loading (blur-up, LQIP), content placeholder animations, perceived performance tricks, and loading state hierarchy (instant→skeleton→spinner→progress).', cliType: 'claude', category: 'frontend', tags: ['design', 'loading', 'skeleton', 'ux'] }),
    S({ id: 'design-notification-system', name: 'Notification System Design', description: 'Toast, banner, badge, and push notification UX patterns.', emoji: '🔔', command: 'Design a notification system: toast placement and stacking, auto-dismiss timing by type, banner alerts for system-wide messages, badge counters, push notification opt-in flow, notification center with read/unread states, and do-not-disturb integration.', cliType: 'claude', category: 'docs', tags: ['design', 'notifications', 'toast', 'ux'] }),
  ],

  /* ═══════════════════  10. Figma & Design Tools  ═══════════════════ */
  'figma-design-v1': [
    S({ id: 'figma-auto-layout', name: 'Figma Auto Layout Mastery', description: 'Advanced auto layout with responsive components, wrap, and min/max constraints.', emoji: '📐', command: 'Create a Figma auto layout guide: responsive card with fill/hug, wrap layout for tag lists, nested auto layouts for complex forms, min/max width constraints, absolute positioning within auto layout, and responsive breakpoint frame patterns.', cliType: 'claude', category: 'docs', tags: ['figma', 'auto-layout', 'responsive', 'design'] }),
    S({ id: 'figma-variables-tokens', name: 'Figma Variables & Tokens', description: 'Set up Figma variables for colors, spacing, typography, and mode switching.', emoji: '🎨', command: 'Design a Figma variables system: color collections with light/dark modes, spacing scale variables, typography variables, radius and shadow variables, component property bindings, mode switching setup, and Token Studio sync strategy.', cliType: 'claude', category: 'docs', tags: ['figma', 'variables', 'tokens', 'design-system'] }),
    S({ id: 'figma-component-architecture', name: 'Figma Component Architecture', description: 'Build scalable component library with variants, slots, and nested instances.', emoji: '🧩', command: 'Architect a Figma component library: atomic design hierarchy, component variants with boolean/enum properties, slot patterns with instance swap, nested component composition, component documentation, and publishing/versioning strategy.', cliType: 'claude', category: 'docs', tags: ['figma', 'components', 'design-system', 'architecture'] }),
    S({ id: 'figma-prototype-flows', name: 'Figma Prototype Flows', description: 'Interactive prototypes with smart animate, variables, and conditional logic.', emoji: '🎬', command: 'Build Figma prototype flows: smart animate transitions between states, variable-driven interactive components (counters, toggles), conditional navigation with expressions, scroll behaviors, video/audio integration, and user testing prototype preparation.', cliType: 'claude', category: 'docs', tags: ['figma', 'prototype', 'interaction', 'ux'] }),
    S({ id: 'figma-dev-mode', name: 'Figma Dev Mode Guide', description: 'Maximize Figma Dev Mode for code generation, inspection, and handoff.', emoji: '👨‍💻', command: 'Create a Figma Dev Mode workflow: code generation settings for React/CSS, annotation best practices, component documentation for devs, ready-for-dev status workflow, VS Code plugin setup, and mapping between Figma tokens and CSS custom properties.', cliType: 'claude', category: 'docs', tags: ['figma', 'dev-mode', 'handoff', 'workflow'] }),
  ],

  /* ═══════════════════  11. Animation & Motion  ═══════════════════ */
  'animation-motion-v1': [
    S({ id: 'framer-motion-patterns', name: 'Framer Motion Patterns', description: 'Layout animations, shared transitions, gestures, and scroll-triggered effects.', emoji: '🎭', command: 'Implement Framer Motion patterns: AnimatePresence for mount/unmount, layout animations for reordering, shared layout transitions between pages, gesture handlers (drag, hover, tap), scroll-triggered animations with useInView, stagger children with variants, and spring physics configuration.', cliType: 'codex', category: 'frontend', tags: ['framer-motion', 'animation', 'react', 'motion'] }),
    S({ id: 'gsap-scroll-animation', name: 'GSAP ScrollTrigger', description: 'Scroll-driven animations with pinning, scrubbing, and parallax using GSAP.', emoji: '🎬', command: 'Implement GSAP ScrollTrigger animations: pin sections during scroll, scrub-linked timeline, parallax depth layers, horizontal scroll section, text reveal with SplitText, and responsive breakpoint animations with gsap.matchMedia().', cliType: 'codex', category: 'frontend', tags: ['gsap', 'scroll', 'animation', 'parallax'] }),
    S({ id: 'lottie-integration', name: 'Lottie Animation Integration', description: 'Integrate Lottie animations with React, lazy loading, and interaction triggers.', emoji: '🎞️', command: 'Integrate Lottie animations in React: lottie-react setup with lazy loading, play/pause/loop controls, interactive animations triggered by scroll/hover/click, light version for performance, dynamic color theming, and responsive sizing strategies.', cliType: 'codex', category: 'frontend', tags: ['lottie', 'animation', 'react', 'performance'] }),
    S({ id: 'page-transition-system', name: 'Page Transition System', description: 'Smooth page transitions with shared element animation and preloading.', emoji: '🔄', command: 'Build a page transition system: fade/slide/scale transitions between routes, shared element transitions (View Transitions API), exit animations before navigation, route-based transition selection, preload on hover, and loading progress during transitions.', cliType: 'codex', category: 'frontend', tags: ['animation', 'transitions', 'routing', 'ux'] }),
    S({ id: 'svg-animation', name: 'SVG Animation Toolkit', description: 'SVG path drawing, morphing, and SMIL/CSS/JS animation techniques.', emoji: '✏️', command: 'Create SVG animation toolkit: stroke-dasharray path drawing effect, path morphing between shapes, SVG filter animations (blur, glow), SMIL vs CSS vs JS animation comparison, animated logo/icon patterns, and performance optimization for complex SVG scenes.', cliType: 'claude', category: 'frontend', tags: ['svg', 'animation', 'motion', 'graphics'] }),
  ],

  /* ═══════════════════  12. shadcn/ui + Radix  ═══════════════════ */
  'shadcn-radix-v1': [
    S({ id: 'shadcn-setup', name: 'shadcn/ui Project Setup', description: 'Initialize shadcn/ui with custom theme, path aliases, and component structure.', emoji: '🎨', command: 'Set up shadcn/ui in a Next.js project: initialize with CLI, configure components.json with custom paths, set up theme with CSS variables, install core components (Button, Dialog, Form, Table, Toast), and create a shared component barrel file.', cliType: 'codex', category: 'frontend', tags: ['shadcn', 'radix', 'ui', 'setup'] }),
    S({ id: 'shadcn-form-builder', name: 'shadcn Form Builder', description: 'Complex forms with react-hook-form, Zod validation, and shadcn components.', emoji: '📝', command: 'Build complex forms using shadcn/ui + react-hook-form + Zod: multi-step wizard form, nested field arrays, conditional fields, file upload with preview, combobox with async search, date range picker, and server-side validation error mapping.', cliType: 'codex', category: 'frontend', tags: ['shadcn', 'forms', 'zod', 'react-hook-form'] }),
    S({ id: 'shadcn-data-table', name: 'shadcn Data Table', description: 'Full-featured data table with sorting, filtering, pagination, and row selection.', emoji: '📊', command: 'Build a shadcn/ui data table with TanStack Table: column sorting, multi-column filtering, server-side pagination, row selection with bulk actions, column visibility toggle, resizable columns, sticky header, and CSV export functionality.', cliType: 'codex', category: 'frontend', tags: ['shadcn', 'table', 'tanstack', 'data'] }),
    S({ id: 'shadcn-dashboard', name: 'shadcn Dashboard Layout', description: 'Admin dashboard with sidebar navigation, breadcrumbs, and responsive layout.', emoji: '📋', command: 'Build a shadcn/ui admin dashboard: collapsible sidebar with icon-only mode, breadcrumb navigation, command palette (⌘K), responsive sheet sidebar for mobile, user dropdown menu, notification popover, and settings dialog.', cliType: 'codex', category: 'frontend', tags: ['shadcn', 'dashboard', 'admin', 'layout'] }),
    S({ id: 'radix-custom-component', name: 'Radix Custom Component', description: 'Build custom headless components with Radix Primitives and custom styling.', emoji: '🔧', command: 'Create custom components with Radix Primitives: composable Select with search, multi-select with tags, tree view with keyboard navigation, color picker with Popover, stepper component, and accessible tooltip with arrow.', cliType: 'codex', category: 'frontend', tags: ['radix', 'headless', 'a11y', 'components'] }),
  ],

  /* ═══════════════════  13. State Management  ═══════════════════ */
  'state-management-v1': [
    S({ id: 'zustand-store-patterns', name: 'Zustand Store Patterns', description: 'Scalable Zustand stores with slices, middleware, persistence, and devtools.', emoji: '🐻', command: 'Build Zustand store patterns: slice pattern for modular stores, immer middleware for immutable updates, persist middleware with storage adapters, subscribeWithSelector for granular subscriptions, devtools integration, and computed/derived state patterns.', cliType: 'claude', category: 'react', tags: ['zustand', 'state', 'react', 'patterns'] }),
    S({ id: 'tanstack-query-setup', name: 'TanStack Query Setup', description: 'Data fetching with caching, optimistic updates, infinite scroll, and prefetching.', emoji: '🔄', command: 'Set up TanStack Query (React Query): QueryClient configuration, custom query hooks with type safety, optimistic updates with mutation rollback, infinite scroll with useInfiniteQuery, prefetching strategies, cache invalidation patterns, and placeholder/initial data.', cliType: 'codex', category: 'react', tags: ['tanstack-query', 'data-fetching', 'caching', 'react'] }),
    S({ id: 'jotai-atomic-state', name: 'Jotai Atomic State', description: 'Atomic state management with derived atoms, async atoms, and persistence.', emoji: '⚛️', command: 'Implement Jotai atomic state: primitive atoms, derived atoms with get/set, async atoms for API calls, atom family for parameterized state, atomWithStorage for persistence, atomWithObservable for RxJS integration, and provider-less usage patterns.', cliType: 'claude', category: 'react', tags: ['jotai', 'atomic', 'state', 'react'] }),
    S({ id: 'redux-toolkit-modern', name: 'Redux Toolkit Modern', description: 'Modern Redux with createSlice, RTK Query, and listener middleware.', emoji: '🔴', command: 'Set up modern Redux Toolkit: createSlice with immer, createAsyncThunk for side effects, RTK Query for API caching, createEntityAdapter for normalized state, listenerMiddleware for complex logic, and TypeScript integration with typed hooks.', cliType: 'codex', category: 'react', tags: ['redux', 'rtk', 'state', 'react'] }),
    S({ id: 'form-state-management', name: 'Form State Management', description: 'Compare react-hook-form, Formik, and native form handling patterns.', emoji: '📋', command: 'Compare form state management approaches: react-hook-form with uncontrolled inputs and Zod, Formik with Yup validation, native React form handling with useActionState, cross-field validation, dynamic field arrays, and performance comparison.', cliType: 'claude', category: 'react', tags: ['forms', 'state', 'validation', 'comparison'] }),
  ],

  /* ═══════════════════  14. Node.js Backend  ═══════════════════ */
  'node-backend-v1': [
    S({ id: 'express-api-scaffold', name: 'Express API Scaffold', description: 'Production Express API with middleware, error handling, validation, and logging.', emoji: '🚂', command: 'Scaffold a production Express.js API: project structure with router separation, helmet/cors/compression middleware, Zod request validation middleware, centralized error handler with error classes, structured logging with pino, graceful shutdown, and health check endpoint.', cliType: 'codex', category: 'node', tags: ['express', 'api', 'node', 'backend'] }),
    S({ id: 'fastify-api-scaffold', name: 'Fastify API Scaffold', description: 'High-performance Fastify API with schema validation, plugins, and Swagger.', emoji: '🏎️', command: 'Scaffold a Fastify API: plugin architecture with dependency injection, JSON Schema validation with TypeBox, auto-generated Swagger/OpenAPI docs, JWT authentication plugin, rate limiting, request logging, and TypeScript-first route definitions.', cliType: 'codex', category: 'node', tags: ['fastify', 'api', 'node', 'performance'] }),
    S({ id: 'node-websocket-server', name: 'WebSocket Server', description: 'Real-time WebSocket server with rooms, authentication, and reconnection.', emoji: '🔌', command: 'Build a WebSocket server with ws or Socket.IO: connection authentication, room-based broadcasting, heartbeat/ping-pong, automatic reconnection handling, message queue for offline clients, binary data support, and horizontal scaling with Redis adapter.', cliType: 'codex', category: 'node', tags: ['websocket', 'realtime', 'node', 'socket'] }),
    S({ id: 'node-queue-worker', name: 'Queue Worker System', description: 'Background job processing with BullMQ, retries, and concurrency control.', emoji: '📬', command: 'Implement a job queue system with BullMQ: define typed jobs with processors, retry strategies with exponential backoff, concurrency control, priority queues, scheduled/recurring jobs, dead letter queue, progress reporting, and admin dashboard setup.', cliType: 'codex', category: 'node', tags: ['queue', 'bullmq', 'worker', 'background-jobs'] }),
    S({ id: 'node-stream-processing', name: 'Stream Processing', description: 'Node.js streams for file upload, CSV parsing, and data transformation pipelines.', emoji: '🌊', command: 'Implement Node.js stream patterns: readable/writable/transform streams, pipeline() for error handling, multipart file upload streaming, CSV parsing with back-pressure, NDJSON streaming, server-sent events, and memory-efficient large file processing.', cliType: 'claude', category: 'node', tags: ['streams', 'node', 'performance', 'data'] }),
    S({ id: 'node-auth-jwt', name: 'JWT Auth System', description: 'Complete JWT authentication with refresh tokens, rotation, and blacklisting.', emoji: '🔑', command: 'Implement JWT auth: access/refresh token pair, httpOnly secure cookies, token rotation on refresh, Redis blacklist for revocation, role-based middleware, rate limiting on auth endpoints, and password reset flow with email verification.', cliType: 'codex', category: 'security', tags: ['jwt', 'auth', 'node', 'security'] }),
  ],

  /* ═══════════════════  15. Database Mastery  ═══════════════════ */
  'database-mastery-v1': [
    S({ id: 'prisma-schema-design', name: 'Prisma Schema Design', description: 'Type-safe database schema with relations, indexes, and seed scripts.', emoji: '💎', command: 'Design a Prisma schema: user/org/role models with relations, composite indexes for query performance, enum types, JSON fields, @@unique constraints, soft delete pattern, audit timestamps, seed script with faker data, and migration workflow.', cliType: 'codex', category: 'db', tags: ['prisma', 'schema', 'orm', 'database'] }),
    S({ id: 'sql-query-optimization', name: 'SQL Query Optimization', description: 'Analyze and optimize slow queries with EXPLAIN, indexing, and query rewriting.', emoji: '🔍', command: 'Optimize SQL queries: EXPLAIN ANALYZE reading guide, index selection strategy (B-tree, GIN, GiST), covering indexes, partial indexes, query rewriting for N+1 elimination, window functions for analytics, CTE optimization, and connection pool tuning.', cliType: 'claude', category: 'db', tags: ['sql', 'optimization', 'indexing', 'performance'] }),
    S({ id: 'database-migration-strategy', name: 'Database Migration Strategy', description: 'Zero-downtime migration patterns with expand/contract and data backfills.', emoji: '🔄', command: 'Design zero-downtime migration strategy: expand/contract pattern, backward-compatible column additions, data backfill with batching, index creation CONCURRENTLY, foreign key validation, rollback procedures, and migration testing in staging.', cliType: 'claude', category: 'migration', tags: ['database', 'migration', 'zero-downtime', 'strategy'] }),
    S({ id: 'redis-caching-patterns', name: 'Redis Caching Patterns', description: 'Cache-aside, write-through, pub/sub, and session management with Redis.', emoji: '🗄️', command: 'Implement Redis patterns: cache-aside with TTL, write-through cache, cache invalidation strategies, pub/sub for real-time features, sorted sets for leaderboards, HyperLogLog for unique counts, Redis Streams for event sourcing, and session storage with sliding expiry.', cliType: 'claude', category: 'db', tags: ['redis', 'caching', 'patterns', 'performance'] }),
    S({ id: 'mongodb-aggregation', name: 'MongoDB Aggregation Pipeline', description: 'Complex aggregation pipelines with lookup, facets, and time-series.', emoji: '🍃', command: 'Build MongoDB aggregation pipelines: $lookup for joins, $facet for multi-output, $bucket for histograms, $graphLookup for hierarchies, time-series collections, text search with scoring, change streams for real-time, and Atlas Search integration.', cliType: 'claude', category: 'db', tags: ['mongodb', 'aggregation', 'nosql', 'analytics'] }),
    S({ id: 'supabase-fullstack', name: 'Supabase Full-Stack Setup', description: 'Supabase with RLS, real-time subscriptions, storage, and edge functions.', emoji: '⚡', command: 'Set up Supabase full-stack: Row Level Security policies, real-time subscription channels, storage buckets with access policies, Edge Functions for server logic, database functions/triggers, generated TypeScript types, and auth with social providers.', cliType: 'codex', category: 'db', tags: ['supabase', 'realtime', 'auth', 'postgres'] }),
  ],

  /* ═══════════════════  16. GraphQL & API  ═══════════════════ */
  'graphql-api-v1': [
    S({ id: 'graphql-schema-design', name: 'GraphQL Schema Design', description: 'Relay-compliant schema with connections, interfaces, and custom scalars.', emoji: '🔮', command: 'Design a GraphQL schema: Relay connection pattern for pagination, interface types for polymorphism, custom scalars (DateTime, JSON, URL), input validation directives, schema-first vs code-first comparison, and federation-ready type ownership.', cliType: 'claude', category: 'api', tags: ['graphql', 'schema', 'relay', 'api-design'] }),
    S({ id: 'graphql-resolver-patterns', name: 'GraphQL Resolver Patterns', description: 'DataLoader for N+1, auth directives, and error handling in resolvers.', emoji: '🔧', command: 'Implement GraphQL resolver patterns: DataLoader for N+1 prevention, field-level auth directives, resolver composition/middleware, error handling with custom error codes, cursor-based pagination resolver, subscription resolvers, and caching with @cacheControl.', cliType: 'codex', category: 'api', tags: ['graphql', 'resolver', 'dataloader', 'auth'] }),
    S({ id: 'rest-api-design', name: 'REST API Design Guide', description: 'RESTful API design with OpenAPI spec, versioning, and HATEOAS.', emoji: '📡', command: 'Design a REST API: OpenAPI 3.1 specification, resource naming conventions, HTTP method semantics, pagination (cursor/offset), filtering and sorting query params, API versioning strategies, error response format (RFC 7807), rate limit headers, and HATEOAS links.', cliType: 'claude', category: 'api', tags: ['rest', 'api-design', 'openapi', 'http'] }),
    S({ id: 'trpc-fullstack', name: 'tRPC Full-Stack Setup', description: 'End-to-end type-safe API with tRPC, Zod, and React Query integration.', emoji: '🔗', command: 'Set up tRPC full-stack: router definition with input/output schemas, context with auth, middleware chain, subscription support, React Query integration with trpc.useQuery/useMutation, optimistic updates, error handling, and batching configuration.', cliType: 'codex', category: 'api', tags: ['trpc', 'typesafe', 'react', 'fullstack'] }),
    S({ id: 'api-rate-limiting', name: 'API Rate Limiting', description: 'Token bucket, sliding window, and tiered rate limiting implementation.', emoji: '🚦', command: 'Implement API rate limiting: token bucket algorithm, sliding window counter with Redis, tiered limits by API key/plan, rate limit response headers (X-RateLimit-*), retry-after guidance, distributed rate limiting across instances, and graceful degradation under load.', cliType: 'codex', category: 'api', tags: ['rate-limiting', 'api', 'security', 'redis'] }),
  ],

  /* ═══════════════════  17. AWS Cloud  ═══════════════════ */
  'aws-cloud-v1': [
    S({ id: 'aws-lambda-patterns', name: 'AWS Lambda Patterns', description: 'Lambda with API Gateway, layers, cold start optimization, and event sources.', emoji: '☁️', command: 'Implement AWS Lambda patterns: API Gateway integration with proxy, Lambda Layers for shared code, cold start mitigation (provisioned concurrency, SnapStart), SQS/SNS event sources, Step Functions orchestration, and structured logging with CloudWatch Insights.', cliType: 'claude', category: 'cloud', tags: ['aws', 'lambda', 'serverless', 'api-gateway'] }),
    S({ id: 'aws-cdk-infrastructure', name: 'AWS CDK Infrastructure', description: 'Infrastructure as Code with CDK for VPC, ECS, RDS, and CloudFront.', emoji: '🏗️', command: 'Build AWS CDK stacks: VPC with public/private subnets, ECS Fargate service with ALB, RDS Aurora Serverless, CloudFront distribution with S3 origin, secrets in SSM Parameter Store, IAM roles with least-privilege, and multi-stack deployment pipeline.', cliType: 'codex', category: 'cloud', tags: ['aws', 'cdk', 'iac', 'infrastructure'] }),
    S({ id: 'aws-s3-cloudfront', name: 'S3 + CloudFront Setup', description: 'Static hosting with S3, CloudFront CDN, custom domain, and cache invalidation.', emoji: '🌐', command: 'Set up S3 + CloudFront: S3 bucket with OAC (Origin Access Control), CloudFront distribution with custom error pages, custom domain with ACM certificate, cache behaviors for different paths, Lambda@Edge for redirects/headers, and automated cache invalidation on deploy.', cliType: 'claude', category: 'cloud', tags: ['aws', 's3', 'cloudfront', 'cdn'] }),
    S({ id: 'aws-dynamodb-patterns', name: 'DynamoDB Design Patterns', description: 'Single-table design, GSI overloading, and access pattern modeling.', emoji: '⚡', command: 'Design DynamoDB patterns: single-table design methodology, partition key strategies, GSI overloading for multiple access patterns, sparse indexes, TTL for expiration, DynamoDB Streams for event processing, and transaction patterns for consistency.', cliType: 'claude', category: 'db', tags: ['aws', 'dynamodb', 'nosql', 'design'] }),
    S({ id: 'aws-iam-security', name: 'AWS IAM Best Practices', description: 'IAM policies, roles, and security boundaries for production workloads.', emoji: '🔐', command: 'Implement AWS IAM best practices: least-privilege policy writing, service-linked roles, cross-account access patterns, SCP for organization guardrails, permission boundaries, condition keys for fine-grained access, and IAM Access Analyzer for policy validation.', cliType: 'claude', category: 'security', tags: ['aws', 'iam', 'security', 'policies'] }),
  ],

  /* ═══════════════════  18. Docker & Kubernetes  ═══════════════════ */
  'docker-k8s-v1': [
    S({ id: 'dockerfile-best-practices', name: 'Dockerfile Best Practices', description: 'Multi-stage builds, layer caching, security hardening, and size optimization.', emoji: '🐳', command: 'Write optimized Dockerfiles: multi-stage builds for Node/Python/Rust, layer caching strategies, non-root user setup, .dockerignore for context size, health check instructions, secret mounting (--mount=type=secret), distroless/alpine base images, and build arg patterns.', cliType: 'claude', category: 'docker', tags: ['docker', 'dockerfile', 'optimization', 'security'] }),
    S({ id: 'docker-compose-dev', name: 'Docker Compose Dev Stack', description: 'Development environment with app, DB, Redis, and hot reload.', emoji: '🐙', command: 'Create Docker Compose dev stack: app service with hot reload volume mount, PostgreSQL with init scripts, Redis for caching, Mailhog for email testing, MinIO for S3-compatible storage, named volumes for data persistence, and health check dependencies.', cliType: 'codex', category: 'docker', tags: ['docker-compose', 'dev', 'local', 'stack'] }),
    S({ id: 'k8s-deployment-manifests', name: 'Kubernetes Deployment', description: 'Production K8s manifests with HPA, PDB, resource limits, and health probes.', emoji: '☸️', command: 'Create Kubernetes deployment manifests: Deployment with rolling update strategy, HPA (Horizontal Pod Autoscaler), PodDisruptionBudget, resource requests/limits, liveness/readiness/startup probes, ConfigMap/Secret references, and ServiceAccount with RBAC.', cliType: 'codex', category: 'k8s', tags: ['kubernetes', 'deployment', 'production', 'manifests'] }),
    S({ id: 'k8s-helm-chart', name: 'Helm Chart Template', description: 'Reusable Helm chart with values, templates, and environment overrides.', emoji: '⛵', command: 'Create a Helm chart: Chart.yaml with dependencies, values.yaml with sensible defaults, deployment/service/ingress templates, _helpers.tpl for shared logic, environment-specific value overrides (dev/staging/prod), and chart testing with helm test.', cliType: 'codex', category: 'k8s', tags: ['helm', 'kubernetes', 'templates', 'packaging'] }),
    S({ id: 'k8s-ingress-networking', name: 'K8s Ingress & Networking', description: 'Ingress with TLS, path routing, rate limiting, and network policies.', emoji: '🌐', command: 'Configure Kubernetes networking: Ingress with TLS termination (cert-manager), path-based routing to services, nginx annotations for rate limiting/proxy settings, NetworkPolicy for pod isolation, Service types (ClusterIP/NodePort/LoadBalancer), and DNS configuration.', cliType: 'claude', category: 'k8s', tags: ['kubernetes', 'ingress', 'networking', 'tls'] }),
  ],

  /* ═══════════════════  19. CI/CD Pipelines  ═══════════════════ */
  'cicd-pipelines-v1': [
    S({ id: 'github-actions-workflow', name: 'GitHub Actions Workflow', description: 'Complete CI/CD with test, build, deploy, and release automation.', emoji: '🔄', command: 'Create GitHub Actions workflows: CI pipeline (lint, type-check, test, build), CD pipeline (preview deploys on PR, production on main), matrix builds for multiple Node versions, artifact caching, concurrency groups, and reusable workflow templates.', cliType: 'codex', category: 'cicd', tags: ['github-actions', 'ci', 'cd', 'automation'] }),
    S({ id: 'github-actions-release', name: 'GitHub Release Automation', description: 'Automated releases with changelog generation and asset publishing.', emoji: '📦', command: 'Automate GitHub releases: semantic-release or changesets integration, auto-generated changelog from conventional commits, GitHub Release creation with assets, npm publish, Docker image push to GHCR, and Slack/Discord notification on release.', cliType: 'codex', category: 'cicd', tags: ['github-actions', 'release', 'changelog', 'automation'] }),
    S({ id: 'preview-deploy-pipeline', name: 'Preview Deploy Pipeline', description: 'Per-PR preview deployments with URL comment and cleanup.', emoji: '👀', command: 'Build preview deploy pipeline: trigger on PR open/sync, deploy to unique URL (pr-{number}.preview.app), post deploy URL as PR comment, run E2E tests against preview, auto-cleanup on PR close, and environment protection rules.', cliType: 'codex', category: 'cicd', tags: ['preview', 'deploy', 'pr', 'automation'] }),
    S({ id: 'monorepo-ci', name: 'Monorepo CI Pipeline', description: 'Efficient monorepo CI with affected detection, caching, and parallel jobs.', emoji: '🏢', command: 'Build monorepo CI: Turborepo/Nx affected package detection, remote caching for build artifacts, parallel job matrix per changed package, shared lint/test configurations, dependency graph-aware build order, and selective deployment based on changes.', cliType: 'codex', category: 'cicd', tags: ['monorepo', 'ci', 'turborepo', 'caching'] }),
    S({ id: 'docker-ci-pipeline', name: 'Docker CI Pipeline', description: 'Build, scan, and push Docker images with multi-platform support.', emoji: '🐳', command: 'Create Docker CI pipeline: multi-platform build (linux/amd64, linux/arm64) with buildx, layer caching with GitHub Actions cache, vulnerability scanning with Trivy/Snyk, image signing with cosign, push to multiple registries (GHCR, ECR), and semantic version tagging.', cliType: 'codex', category: 'cicd', tags: ['docker', 'ci', 'multi-platform', 'security'] }),
  ],

  /* ═══════════════════  20. Security Hardening  ═══════════════════ */
  'security-hardening-v1': [
    S({ id: 'owasp-top10-audit', name: 'OWASP Top 10 Audit', description: 'Check codebase against OWASP Top 10 vulnerabilities with remediation.', emoji: '🛡️', command: 'Audit code against OWASP Top 10: injection (SQL/NoSQL/Command), broken auth, sensitive data exposure, XXE, broken access control, security misconfiguration, XSS, insecure deserialization, vulnerable dependencies, and insufficient logging. Provide specific remediation for each finding.', cliType: 'claude', category: 'security', tags: ['owasp', 'audit', 'vulnerabilities', 'security'] }),
    S({ id: 'csp-security-headers', name: 'Security Headers Config', description: 'Configure CSP, HSTS, X-Frame-Options, and other security headers.', emoji: '🔒', command: 'Configure security headers: Content-Security-Policy with nonce-based inline scripts, Strict-Transport-Security with preload, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy for API access control, and CORS configuration with proper origins.', cliType: 'claude', category: 'security', tags: ['csp', 'headers', 'https', 'security'] }),
    S({ id: 'auth-security-checklist', name: 'Auth Security Checklist', description: 'Authentication and authorization security review checklist.', emoji: '🔐', command: 'Review auth security: password hashing (bcrypt/argon2 with proper cost), session management (httpOnly, secure, sameSite cookies), CSRF protection, rate limiting on login, account lockout policy, MFA implementation, OAuth state parameter, and token storage best practices.', cliType: 'claude', category: 'security', tags: ['auth', 'security', 'checklist', 'best-practices'] }),
    S({ id: 'dependency-vulnerability-scan', name: 'Dependency Vulnerability Scan', description: 'Audit npm/pip/cargo dependencies for known vulnerabilities.', emoji: '🔍', command: 'Scan dependencies for vulnerabilities: npm audit with fix strategy, Snyk/Socket.dev integration, license compliance checking, supply chain attack prevention (lockfile-lint), dependency update strategy (Renovate/Dependabot config), and SBOM generation.', cliType: 'claude', category: 'security', tags: ['dependencies', 'audit', 'supply-chain', 'security'] }),
    S({ id: 'secrets-management', name: 'Secrets Management', description: 'Secure secrets handling with environment variables, vaults, and rotation.', emoji: '🗝️', command: 'Implement secrets management: .env file patterns with validation, git-secrets pre-commit hook, cloud secret managers (AWS SSM, GCP Secret Manager), runtime secret injection, secret rotation strategy, and detecting accidentally committed secrets with truffleHog/gitleaks.', cliType: 'claude', category: 'security', tags: ['secrets', 'vault', 'environment', 'security'] }),
  ],

  /* ═══════════════════  21. Testing Excellence  ═══════════════════ */
  'testing-excellence-v1': [
    S({ id: 'vitest-setup', name: 'Vitest Test Setup', description: 'Complete Vitest configuration with coverage, mocking, and snapshot testing.', emoji: '🧪', command: 'Set up Vitest: vite.config with test configuration, jsdom/happy-dom environment, coverage with v8/istanbul, setup files for global mocks, custom matchers, snapshot serializers, concurrent test execution, and watch mode configuration.', cliType: 'codex', category: 'testing', tags: ['vitest', 'testing', 'coverage', 'setup'] }),
    S({ id: 'playwright-e2e', name: 'Playwright E2E Testing', description: 'End-to-end testing with Playwright including visual regression and API mocking.', emoji: '🎭', command: 'Set up Playwright E2E: project configuration for multiple browsers, page object model pattern, API mocking with route handlers, visual regression with screenshot comparison, authentication state reuse, parallel test execution, CI integration, and HTML reporter setup.', cliType: 'codex', category: 'testing', tags: ['playwright', 'e2e', 'visual-regression', 'testing'] }),
    S({ id: 'react-testing-library', name: 'React Testing Library Patterns', description: 'Component testing with RTL following testing best practices.', emoji: '🔬', command: 'Write React tests with Testing Library: render with providers wrapper, user-event for realistic interactions, findBy for async content, testing form submissions, mocking API calls with MSW, testing custom hooks with renderHook, accessible queries (getByRole), and avoiding implementation details.', cliType: 'claude', category: 'testing', tags: ['rtl', 'react-testing', 'msw', 'best-practices'] }),
    S({ id: 'msw-api-mocking', name: 'MSW API Mocking', description: 'Mock Service Worker for API mocking in tests and development.', emoji: '🎯', command: 'Set up MSW (Mock Service Worker): REST and GraphQL handlers, request matching patterns, response composition, error scenario simulation, network delay simulation, handler overrides per test, browser service worker for development, and integration with Vitest/Playwright.', cliType: 'codex', category: 'testing', tags: ['msw', 'mocking', 'api', 'testing'] }),
    S({ id: 'testing-strategy-guide', name: 'Testing Strategy Guide', description: 'Define testing pyramid, coverage targets, and test organization patterns.', emoji: '📊', command: 'Design a testing strategy: testing trophy/pyramid distribution, unit vs integration vs E2E test boundaries, coverage targets by component type, test naming conventions, test data factories with @faker-js, snapshot testing guidelines, and flaky test prevention.', cliType: 'claude', category: 'testing', tags: ['strategy', 'testing', 'coverage', 'best-practices'] }),
  ],

  /* ═══════════════════  22. Performance Optimization  ═══════════════════ */
  'performance-optimization-v1': [
    S({ id: 'web-vitals-optimization', name: 'Core Web Vitals Optimization', description: 'Optimize LCP, FID/INP, and CLS for perfect Lighthouse scores.', emoji: '📈', command: 'Optimize Core Web Vitals: LCP (preload critical resources, optimize images, reduce server response), INP (break long tasks, yield to main thread, optimize event handlers), CLS (explicit dimensions, font loading strategy, dynamic content placeholders), and measurement with web-vitals library.', cliType: 'claude', category: 'performance', tags: ['web-vitals', 'lcp', 'cls', 'lighthouse'] }),
    S({ id: 'bundle-size-optimization', name: 'Bundle Size Optimization', description: 'Analyze and reduce JavaScript bundle size with code splitting and tree shaking.', emoji: '📦', command: 'Optimize bundle size: webpack-bundle-analyzer / vite-bundle-visualizer audit, code splitting with dynamic imports, tree shaking verification, replacing heavy dependencies (moment→dayjs, lodash→lodash-es), lazy loading routes and components, and module/nomodule differential serving.', cliType: 'claude', category: 'performance', tags: ['bundle', 'code-splitting', 'tree-shaking', 'optimization'] }),
    S({ id: 'image-optimization', name: 'Image Optimization Pipeline', description: 'Automated image optimization with formats, sizing, lazy loading, and CDN.', emoji: '🖼️', command: 'Build image optimization pipeline: next/image or sharp-based processing, WebP/AVIF format generation, responsive srcset with art direction, lazy loading with blur placeholder, priority hints for LCP images, SVG optimization with SVGO, and CDN-based image transformation.', cliType: 'codex', category: 'performance', tags: ['images', 'optimization', 'webp', 'responsive'] }),
    S({ id: 'caching-strategy', name: 'Caching Strategy', description: 'Multi-layer caching with browser, CDN, API, and database cache.', emoji: '💾', command: 'Design multi-layer caching: browser cache with Cache-Control headers, service worker cache strategies (cache-first, stale-while-revalidate), CDN edge caching rules, API response caching with ETags, database query caching with Redis, and cache invalidation patterns.', cliType: 'claude', category: 'performance', tags: ['caching', 'cdn', 'service-worker', 'optimization'] }),
    S({ id: 'react-performance', name: 'React Performance Audit', description: 'Profile and optimize React rendering with memo, useMemo, and concurrent features.', emoji: '⚡', command: 'Audit React performance: React DevTools Profiler usage, unnecessary re-render identification, React.memo with custom comparator, useMemo/useCallback appropriate usage, list virtualization, code splitting with React.lazy, useTransition for non-urgent updates, and React Compiler readiness.', cliType: 'claude', category: 'react', tags: ['react', 'performance', 'profiling', 'optimization'] }),
  ],

  /* ═══════════════════  23. Mobile Development  ═══════════════════ */
  'mobile-dev-v1': [
    S({ id: 'react-native-setup', name: 'React Native Project Setup', description: 'Production React Native with navigation, state, theming, and native modules.', emoji: '📱', command: 'Set up React Native project: Expo or bare workflow decision, React Navigation with typed routes, Zustand/Jotai for state, NativeWind/Tamagui for styling, safe area handling, responsive dimensions, dark mode support, and native module linking setup.', cliType: 'codex', category: 'mobile', tags: ['react-native', 'mobile', 'setup', 'navigation'] }),
    S({ id: 'rn-performance', name: 'React Native Performance', description: 'Optimize React Native with Flashlist, Hermes, and native driver animations.', emoji: '🏎️', command: 'Optimize React Native performance: FlashList for large lists, Hermes engine optimization, native driver animations with Reanimated, image caching with FastImage, memo and callback optimization, bridge reduction strategies, and Flipper profiling setup.', cliType: 'claude', category: 'mobile', tags: ['react-native', 'performance', 'optimization', 'animation'] }),
    S({ id: 'expo-features', name: 'Expo Platform Features', description: 'Expo SDK features: push notifications, camera, location, and OTA updates.', emoji: '🚀', command: 'Implement Expo features: push notifications with Expo Notifications, camera with expo-camera, location tracking with expo-location, file system access, secure storage with expo-secure-store, OTA updates with expo-updates, and EAS Build/Submit configuration.', cliType: 'codex', category: 'mobile', tags: ['expo', 'mobile', 'notifications', 'ota'] }),
    S({ id: 'mobile-app-store', name: 'App Store Submission', description: 'App Store and Play Store submission checklist and optimization.', emoji: '🏪', command: 'Prepare app store submission: iOS App Store Connect metadata, Android Play Console listing, screenshot generation for all device sizes, app preview video, privacy policy and data safety, age rating questionnaire, in-app purchase setup, and TestFlight/internal testing track.', cliType: 'claude', category: 'mobile', tags: ['app-store', 'play-store', 'submission', 'metadata'] }),
    S({ id: 'pwa-setup', name: 'PWA Setup', description: 'Progressive Web App with offline support, install prompt, and push notifications.', emoji: '📲', command: 'Set up PWA: Web App Manifest with icons and shortcuts, Workbox service worker with caching strategies, offline fallback page, background sync for queued actions, install prompt handling, push notification with VAPID, and Lighthouse PWA audit pass.', cliType: 'codex', category: 'frontend', tags: ['pwa', 'offline', 'service-worker', 'mobile'] }),
  ],

  /* ═══════════════════  24. AI/ML Engineering  ═══════════════════ */
  'ai-ml-engineering-v1': [
    S({ id: 'rag-pipeline', name: 'RAG Pipeline', description: 'Retrieval-Augmented Generation with embeddings, vector DB, and reranking.', emoji: '🤖', command: 'Build a RAG pipeline: document chunking strategies (recursive, semantic), embedding generation (OpenAI/local), vector storage (Pinecone/Chroma/pgvector), hybrid search (semantic + keyword), reranking with cross-encoder, context window management, and citation extraction.', cliType: 'claude', category: 'ai', tags: ['rag', 'embeddings', 'vector-db', 'llm'] }),
    S({ id: 'prompt-engineering', name: 'Prompt Engineering Library', description: 'Reusable prompt templates with few-shot, chain-of-thought, and structured output.', emoji: '💬', command: 'Create prompt engineering patterns: few-shot prompt templates, chain-of-thought reasoning, structured output with JSON mode, system prompt best practices, prompt chaining for complex tasks, eval framework for prompt quality, and prompt versioning/testing strategy.', cliType: 'claude', category: 'ai', tags: ['prompts', 'llm', 'templates', 'engineering'] }),
    S({ id: 'ai-streaming-chat', name: 'AI Streaming Chat', description: 'Build streaming AI chat interface with markdown rendering and tool use.', emoji: '💭', command: 'Build streaming AI chat: SSE/WebSocket streaming from OpenAI/Anthropic API, token-by-token rendering, markdown/code block parsing, tool use/function calling UI, conversation history management, retry with exponential backoff, and rate limiting on client side.', cliType: 'codex', category: 'ai', tags: ['ai', 'streaming', 'chat', 'llm'] }),
    S({ id: 'ai-agent-framework', name: 'AI Agent Framework', description: 'Build an AI agent with tool use, memory, and planning capabilities.', emoji: '🕵️', command: 'Build an AI agent framework: tool definition with JSON schema, ReAct loop (Reason→Act→Observe), memory management (short-term buffer, long-term vector store), planning with task decomposition, error recovery, and sandboxed code execution for code interpreter.', cliType: 'claude', category: 'ai', tags: ['agent', 'tools', 'memory', 'planning'] }),
    S({ id: 'ai-evaluation', name: 'AI/LLM Evaluation', description: 'Evaluate LLM outputs with automated metrics, human eval, and A/B testing.', emoji: '📊', command: 'Build LLM evaluation system: automated metrics (BLEU, ROUGE, BERTScore), factual consistency checking, rubric-based human evaluation framework, A/B testing infrastructure, regression test suite for prompts, cost/latency monitoring, and eval dataset curation.', cliType: 'claude', category: 'ai', tags: ['evaluation', 'metrics', 'llm', 'testing'] }),
    S({ id: 'openai-api-patterns', name: 'OpenAI API Patterns', description: 'Production patterns for OpenAI API: batching, caching, fallbacks, and cost control.', emoji: '🧠', command: 'Implement OpenAI API patterns: batch API for cost reduction, semantic caching with embeddings, model fallback chain (GPT-4→3.5→local), structured output with response_format, function calling with Zod schemas, token counting and budget management, and retry with backoff.', cliType: 'codex', category: 'ai', tags: ['openai', 'api', 'patterns', 'production'] }),
  ],

  /* ═══════════════════  25. Monorepo & Build  ═══════════════════ */
  'monorepo-build-v1': [
    S({ id: 'turborepo-setup', name: 'Turborepo Setup', description: 'Configure Turborepo with task pipelines, remote caching, and workspace dependencies.', emoji: '🔥', command: 'Set up Turborepo monorepo: turbo.json pipeline configuration, workspace package structure (apps/packages), shared tsconfig and eslint configs, remote caching with Vercel, workspace dependency management, and task orchestration with proper inputs/outputs.', cliType: 'codex', category: 'dev', tags: ['turborepo', 'monorepo', 'build', 'caching'] }),
    S({ id: 'pnpm-workspace', name: 'pnpm Workspace Config', description: 'pnpm workspace with shared dependencies, protocols, and publish workflow.', emoji: '📦', command: 'Configure pnpm workspace: pnpm-workspace.yaml setup, shared dependencies with catalog protocol, workspace: protocol for internal packages, .npmrc configuration, changesets for versioning, publish workflow, and lockfile maintenance strategy.', cliType: 'claude', category: 'dev', tags: ['pnpm', 'workspace', 'monorepo', 'dependencies'] }),
    S({ id: 'vite-config-advanced', name: 'Vite Advanced Config', description: 'Advanced Vite configuration with plugins, optimization, and environment handling.', emoji: '⚡', command: 'Configure advanced Vite: plugin chain (React, SVG, PWA), build optimization (rollupOptions, manualChunks), environment-specific configs, proxy setup for API, module federation, SSR configuration, library mode for packages, and custom HMR handling.', cliType: 'codex', category: 'dev', tags: ['vite', 'config', 'build', 'optimization'] }),
    S({ id: 'eslint-prettier-config', name: 'ESLint + Prettier Config', description: 'Comprehensive linting setup with ESLint flat config and Prettier integration.', emoji: '📏', command: 'Configure ESLint flat config with Prettier: typescript-eslint strict rules, React/JSX rules, import sorting, naming conventions, custom rules for project patterns, Prettier integration with eslint-config-prettier, lint-staged with husky, and VS Code settings.', cliType: 'codex', category: 'dev', tags: ['eslint', 'prettier', 'linting', 'config'] }),
    S({ id: 'package-publishing', name: 'npm Package Publishing', description: 'Publish npm packages with TypeScript, dual ESM/CJS, and automated releases.', emoji: '📤', command: 'Set up npm package publishing: tsup for dual ESM/CJS builds, package.json exports field, TypeScript declarations generation, changesets for versioning, GitHub Actions publish workflow, provenance statements, and README badge automation.', cliType: 'codex', category: 'dev', tags: ['npm', 'publishing', 'esm', 'typescript'] }),
  ],

  /* ═══════════════════  26. Python Full-Stack  ═══════════════════ */
  'python-fullstack-v1': [
    S({ id: 'fastapi-scaffold', name: 'FastAPI Project Scaffold', description: 'Production FastAPI with SQLAlchemy, Pydantic, and async patterns.', emoji: '🐍', command: 'Scaffold FastAPI project: app structure with routers, SQLAlchemy async ORM with Alembic migrations, Pydantic v2 schemas with validation, dependency injection, JWT authentication, CORS middleware, OpenAPI customization, and structured logging.', cliType: 'codex', category: 'python', tags: ['fastapi', 'python', 'api', 'async'] }),
    S({ id: 'python-data-pipeline', name: 'Python Data Pipeline', description: 'ETL pipeline with pandas, data validation, and scheduled processing.', emoji: '📊', command: 'Build a Python data pipeline: pandas/polars for data transformation, Pydantic for data validation, concurrent processing with asyncio, CSV/JSON/Parquet format handling, error logging and retry logic, scheduling with APScheduler, and memory-efficient chunked processing.', cliType: 'codex', category: 'python', tags: ['python', 'data', 'etl', 'pipeline'] }),
    S({ id: 'python-testing', name: 'Python Testing with pytest', description: 'Comprehensive pytest setup with fixtures, parametrize, and coverage.', emoji: '🧪', command: 'Set up Python testing: pytest configuration, fixtures with scope management, parametrize for data-driven tests, mock with unittest.mock, httpx for async API testing, factory_boy for test data, coverage configuration, and conftest.py organization patterns.', cliType: 'codex', category: 'python', tags: ['python', 'pytest', 'testing', 'fixtures'] }),
    S({ id: 'python-cli-tool', name: 'Python CLI Tool', description: 'Build CLI with click/typer, rich output, and configuration management.', emoji: '⌨️', command: 'Build a Python CLI tool with typer: command groups and subcommands, rich console output with tables and progress bars, configuration file handling (TOML/YAML), environment variable integration, shell completion, error handling with helpful messages, and packaging with entry_points.', cliType: 'codex', category: 'python', tags: ['python', 'cli', 'typer', 'rich'] }),
    S({ id: 'django-rest-api', name: 'Django REST API', description: 'Django REST Framework with serializers, viewsets, and authentication.', emoji: '🎸', command: 'Build Django REST API: model design with migrations, DRF serializers with nested relations, ViewSet with custom actions, token/session/JWT authentication, permissions and throttling, filtering/searching/ordering, pagination, and API documentation with drf-spectacular.', cliType: 'codex', category: 'python', tags: ['django', 'drf', 'python', 'api'] }),
  ],

  /* ═══════════════════  27. Rust Systems  ═══════════════════ */
  'rust-systems-v1': [
    S({ id: 'rust-error-handling', name: 'Rust Error Handling', description: 'Idiomatic error handling with thiserror, anyhow, and custom error types.', emoji: '🦀', command: 'Implement Rust error handling: custom error enums with thiserror, anyhow for application errors, error conversion with From trait, Result type aliases, error context with .context(), error chain display, and structured error logging with tracing.', cliType: 'claude', category: 'rust', tags: ['rust', 'error-handling', 'thiserror', 'anyhow'] }),
    S({ id: 'rust-async-patterns', name: 'Rust Async Patterns', description: 'Async Rust with tokio: tasks, channels, select, and cancellation.', emoji: '⚡', command: 'Implement async Rust patterns with tokio: spawning tasks, mpsc/oneshot channels, tokio::select! for racing futures, graceful shutdown with CancellationToken, async streams, connection pooling, timeout patterns, and structured concurrency with JoinSet.', cliType: 'claude', category: 'rust', tags: ['rust', 'async', 'tokio', 'concurrency'] }),
    S({ id: 'rust-cli-app', name: 'Rust CLI Application', description: 'Build CLI with clap, colored output, progress bars, and config files.', emoji: '⌨️', command: 'Build Rust CLI with clap: derive-based argument parsing, subcommands, colored output with owo-colors, progress bars with indicatif, configuration with config crate, structured logging with tracing-subscriber, and cross-platform binary distribution.', cliType: 'codex', category: 'rust', tags: ['rust', 'cli', 'clap', 'tools'] }),
    S({ id: 'rust-web-api', name: 'Rust Web API with Axum', description: 'High-performance web API with Axum, SQLx, and tower middleware.', emoji: '🌐', command: 'Build Rust web API with Axum: router with extractors, tower middleware stack (CORS, logging, auth), SQLx for async database access, request validation with validator, structured JSON errors, graceful shutdown, and OpenAPI generation with utoipa.', cliType: 'codex', category: 'rust', tags: ['rust', 'axum', 'web', 'api'] }),
    S({ id: 'rust-wasm', name: 'Rust WebAssembly', description: 'Compile Rust to WASM for high-performance web computation.', emoji: '🕸️', command: 'Build Rust WASM module: wasm-pack setup, wasm-bindgen for JS interop, web-sys DOM access, shared memory with SharedArrayBuffer, parallel computation with rayon-wasm, bundle size optimization with wee_alloc, and integration with React/Next.js.', cliType: 'codex', category: 'rust', tags: ['rust', 'wasm', 'webassembly', 'performance'] }),
  ],

  /* ═══════════════════  28. Go Backend  ═══════════════════ */
  'go-backend-v1': [
    S({ id: 'go-api-scaffold', name: 'Go API Scaffold', description: 'Production Go API with chi/gin, middleware, and structured logging.', emoji: '🐹', command: 'Scaffold Go API: project layout (cmd/internal/pkg), chi or gin router with middleware chain, structured logging with slog, configuration with viper, database with sqlx, graceful shutdown, health check endpoints, and Makefile with build/test/lint targets.', cliType: 'codex', category: 'go', tags: ['go', 'api', 'chi', 'backend'] }),
    S({ id: 'go-concurrency', name: 'Go Concurrency Patterns', description: 'Goroutines, channels, worker pools, and context cancellation.', emoji: '🔀', command: 'Implement Go concurrency patterns: worker pool with buffered channels, fan-out/fan-in pipeline, context-based cancellation and timeout, errgroup for parallel tasks with error collection, rate limiting with time.Ticker, and mutex vs channel selection guide.', cliType: 'claude', category: 'go', tags: ['go', 'concurrency', 'goroutines', 'channels'] }),
    S({ id: 'go-grpc-service', name: 'Go gRPC Service', description: 'gRPC service with protobuf, streaming, interceptors, and health checks.', emoji: '📡', command: 'Build Go gRPC service: protobuf schema definition, code generation with buf, unary and streaming RPCs, interceptors for auth/logging/recovery, gRPC health checking protocol, reflection for debugging, and gRPC-Gateway for REST compatibility.', cliType: 'codex', category: 'go', tags: ['go', 'grpc', 'protobuf', 'microservices'] }),
    S({ id: 'go-testing', name: 'Go Testing Patterns', description: 'Table-driven tests, mocks, integration tests, and benchmarks.', emoji: '🧪', command: 'Implement Go testing: table-driven tests with subtests, testify assertions, mock generation with mockery, httptest for API testing, testcontainers for integration tests, benchmarks with b.ReportAllocs(), fuzz testing, and test coverage reporting.', cliType: 'claude', category: 'go', tags: ['go', 'testing', 'mocks', 'benchmarks'] }),
    S({ id: 'go-microservice', name: 'Go Microservice', description: 'Production microservice with service discovery, tracing, and circuit breaker.', emoji: '🔧', command: 'Build Go microservice: OpenTelemetry distributed tracing, Prometheus metrics exposition, circuit breaker with sony/gobreaker, service discovery patterns, health check probes, structured error handling, and Docker multi-stage build with scratch base.', cliType: 'codex', category: 'go', tags: ['go', 'microservice', 'observability', 'resilience'] }),
  ],

  /* ═══════════════════  29. SEO & Web  ═══════════════════ */
  'seo-web-v1': [
    S({ id: 'seo-meta-tags', name: 'SEO Meta Tags', description: 'Complete meta tags with Open Graph, Twitter Cards, and structured data.', emoji: '🔍', command: 'Implement SEO meta tags: title/description best practices, canonical URLs, Open Graph tags for social sharing, Twitter Card meta tags, JSON-LD structured data (Article, Product, FAQ, BreadcrumbList), robots meta directives, and dynamic meta generation in Next.js.', cliType: 'claude', category: 'frontend', tags: ['seo', 'meta', 'open-graph', 'structured-data'] }),
    S({ id: 'seo-sitemap', name: 'Dynamic Sitemap', description: 'Auto-generated XML sitemap with priority, changefreq, and i18n alternates.', emoji: '🗺️', command: 'Generate dynamic XML sitemap: auto-discover pages from file system and CMS, priority and changefreq rules, lastmod from git/CMS timestamps, hreflang alternates for i18n, image sitemap extension, video sitemap, sitemap index for large sites, and robots.txt configuration.', cliType: 'codex', category: 'frontend', tags: ['seo', 'sitemap', 'xml', 'automation'] }),
    S({ id: 'seo-performance', name: 'SEO Performance Audit', description: 'Technical SEO audit covering crawlability, indexing, and page speed.', emoji: '📊', command: 'Conduct technical SEO audit: crawlability (robots.txt, canonical, noindex), page speed (Core Web Vitals, resource hints), mobile-friendliness, internal linking structure, redirect chains, duplicate content detection, and generate actionable improvement report.', cliType: 'claude', category: 'docs', tags: ['seo', 'audit', 'performance', 'technical'] }),
    S({ id: 'analytics-setup', name: 'Analytics Setup', description: 'Set up GA4, conversion tracking, and privacy-compliant analytics.', emoji: '📈', command: 'Set up web analytics: Google Analytics 4 with GTM, custom events for user interactions, conversion tracking for key actions, cookie consent integration (GDPR/CCPA), server-side tagging for accuracy, UTM parameter handling, and privacy-first alternatives (Plausible, Fathom).', cliType: 'claude', category: 'frontend', tags: ['analytics', 'ga4', 'tracking', 'privacy'] }),
    S({ id: 'web-font-optimization', name: 'Web Font Optimization', description: 'Optimize web fonts for performance with subsetting, preloading, and fallbacks.', emoji: '🔤', command: 'Optimize web fonts: font subsetting with glyphhanger, preload critical fonts, font-display: swap/optional strategy, variable fonts for weight range, next/font optimization in Next.js, system font stack fallback, size-adjust for CLS prevention, and self-hosting vs CDN comparison.', cliType: 'claude', category: 'performance', tags: ['fonts', 'optimization', 'performance', 'web'] }),
  ],

  /* ═══════════════════  30. Architecture  ═══════════════════ */
  'architecture-v1': [
    S({ id: 'clean-architecture', name: 'Clean Architecture', description: 'Implement clean architecture with dependency inversion and use cases.', emoji: '🏛️', command: 'Implement clean architecture: domain entities with business rules, use case interactors, repository interfaces, dependency injection setup, adapter/gateway implementations, presentation layer separation, and clear dependency direction (domain ← application ← infrastructure).', cliType: 'claude', category: 'architecture', tags: ['clean-architecture', 'ddd', 'solid', 'patterns'] }),
    S({ id: 'event-driven-architecture', name: 'Event-Driven Architecture', description: 'Design event-driven system with event bus, CQRS, and event sourcing.', emoji: '📬', command: 'Design event-driven architecture: domain events definition, event bus/broker patterns, CQRS read/write model separation, event sourcing with event store, saga/process manager for long-running workflows, idempotent event handlers, and eventual consistency strategies.', cliType: 'claude', category: 'architecture', tags: ['events', 'cqrs', 'event-sourcing', 'patterns'] }),
    S({ id: 'microservices-patterns', name: 'Microservices Patterns', description: 'Key microservices patterns: API gateway, service mesh, and circuit breaker.', emoji: '🔀', command: 'Implement microservices patterns: API gateway with routing and aggregation, service discovery and load balancing, circuit breaker for fault tolerance, saga pattern for distributed transactions, event-driven communication, sidecar pattern, and strangler fig migration from monolith.', cliType: 'claude', category: 'architecture', tags: ['microservices', 'patterns', 'distributed', 'resilience'] }),
    S({ id: 'ddd-tactical-patterns', name: 'DDD Tactical Patterns', description: 'Domain-Driven Design with aggregates, value objects, and repositories.', emoji: '📐', command: 'Implement DDD tactical patterns: aggregate root with invariant enforcement, value objects with equality semantics, domain events from aggregates, repository pattern with specification, domain service for cross-aggregate logic, factory pattern for complex creation, and bounded context mapping.', cliType: 'claude', category: 'architecture', tags: ['ddd', 'aggregates', 'domain', 'patterns'] }),
    S({ id: 'system-design-template', name: 'System Design Template', description: 'Structured template for system design with capacity planning and trade-offs.', emoji: '📋', command: 'Create system design document: requirements gathering (functional/non-functional), capacity estimation (QPS, storage, bandwidth), high-level architecture diagram, API design, data model, detailed component design, scalability plan, monitoring strategy, and trade-off analysis.', cliType: 'claude', category: 'architecture', tags: ['system-design', 'scalability', 'planning', 'template'] }),
  ],
};

const EMBEDDED_OFFICIAL_MANIFEST: RemoteSkillPackManifest = {
  schemaVersion: '1.0.0',
  generatedAt: '2026-02-28T12:00:00.000Z',
  packs: [
    { name: 'nextjs-landing', version: '1.1.0', description: 'Next.js landing pages · Hero, pricing, testimonials, FAQ, and more', url: 'octo://official/packs/nextjs-landing-v1', skillCount: 6 },
    { name: 'design-core', version: '1.1.0', description: 'Design system foundations · Color, typography, spacing, icons', url: 'octo://official/packs/design-core-v1', skillCount: 6 },
    { name: 'vercel-platform', version: '1.0.0', description: 'Vercel platform · Edge, Blob, KV, Postgres, Cron, OG images', url: 'octo://official/packs/vercel-platform-v1', skillCount: 9 },
    { name: 'nextjs-advanced', version: '1.0.0', description: 'Next.js advanced · App Router, RSC, Server Actions, caching, Auth, i18n', url: 'octo://official/packs/nextjs-advanced-v1', skillCount: 7 },
    { name: 'react-patterns', version: '1.0.0', description: 'React patterns · Compound, Hooks, State Machine, Error Boundary', url: 'octo://official/packs/react-patterns-v1', skillCount: 7 },
    { name: 'typescript-advanced', version: '1.0.0', description: 'TypeScript advanced · Branded, Utility, Generic, Zod, Strict config', url: 'octo://official/packs/typescript-advanced-v1', skillCount: 6 },
    { name: 'tailwind-css', version: '1.0.0', description: 'Tailwind CSS · Theme, components, dark mode, responsive, animation', url: 'octo://official/packs/tailwind-css-v1', skillCount: 5 },
    { name: 'css-advanced', version: '1.0.0', description: 'CSS advanced · Grid, Container Query, Custom Properties, Scroll, :has()', url: 'octo://official/packs/css-advanced-v1', skillCount: 5 },
    { name: 'ui-ux-design', version: '1.0.0', description: 'UI/UX design · Accessibility, responsive, micro-interactions, forms, loading, notifications', url: 'octo://official/packs/ui-ux-design-v1', skillCount: 7 },
    { name: 'figma-design', version: '1.0.0', description: 'Figma · Auto Layout, Variables, components, prototypes, Dev Mode', url: 'octo://official/packs/figma-design-v1', skillCount: 5 },
    { name: 'animation-motion', version: '1.0.0', description: 'Animation · Framer Motion, GSAP, Lottie, Page Transition, SVG', url: 'octo://official/packs/animation-motion-v1', skillCount: 5 },
    { name: 'shadcn-radix', version: '1.0.0', description: 'shadcn/ui + Radix · Setup, forms, tables, dashboards, custom components', url: 'octo://official/packs/shadcn-radix-v1', skillCount: 5 },
    { name: 'state-management', version: '1.0.0', description: 'State management · Zustand, TanStack Query, Jotai, Redux Toolkit, Form', url: 'octo://official/packs/state-management-v1', skillCount: 5 },
    { name: 'node-backend', version: '1.0.0', description: 'Node.js backend · Express, Fastify, WebSocket, Queue, Stream, JWT', url: 'octo://official/packs/node-backend-v1', skillCount: 6 },
    { name: 'database-mastery', version: '1.0.0', description: 'DB mastery · Prisma, SQL optimization, Migration, Redis, MongoDB, Supabase', url: 'octo://official/packs/database-mastery-v1', skillCount: 6 },
    { name: 'graphql-api', version: '1.0.0', description: 'API design · GraphQL, REST, tRPC, Rate Limiting', url: 'octo://official/packs/graphql-api-v1', skillCount: 5 },
    { name: 'aws-cloud', version: '1.0.0', description: 'AWS cloud · Lambda, CDK, S3+CloudFront, DynamoDB, IAM', url: 'octo://official/packs/aws-cloud-v1', skillCount: 5 },
    { name: 'docker-k8s', version: '1.0.0', description: 'Docker & K8s · Dockerfile, Compose, deployment, Helm, Ingress', url: 'octo://official/packs/docker-k8s-v1', skillCount: 5 },
    { name: 'cicd-pipelines', version: '1.0.0', description: 'CI/CD · GitHub Actions, release automation, Preview Deploy, monorepo, Docker CI', url: 'octo://official/packs/cicd-pipelines-v1', skillCount: 5 },
    { name: 'security-hardening', version: '1.0.0', description: 'Security hardening · OWASP, CSP, Auth, dependency scanning, Secrets management', url: 'octo://official/packs/security-hardening-v1', skillCount: 5 },
    { name: 'testing-excellence', version: '1.0.0', description: 'Testing · Vitest, Playwright, RTL, MSW, strategy guide', url: 'octo://official/packs/testing-excellence-v1', skillCount: 5 },
    { name: 'performance-optimization', version: '1.0.0', description: 'Performance · Web Vitals, bundles, images, caching, React optimization', url: 'octo://official/packs/performance-optimization-v1', skillCount: 5 },
    { name: 'mobile-dev', version: '1.0.0', description: 'Mobile · React Native, Expo, store submission, PWA', url: 'octo://official/packs/mobile-dev-v1', skillCount: 5 },
    { name: 'ai-ml-engineering', version: '1.0.0', description: 'AI/ML · RAG, prompts, streaming chat, agents, evaluation, OpenAI', url: 'octo://official/packs/ai-ml-engineering-v1', skillCount: 6 },
    { name: 'monorepo-build', version: '1.0.0', description: 'Monorepo · Turborepo, pnpm, Vite, ESLint, npm publishing', url: 'octo://official/packs/monorepo-build-v1', skillCount: 5 },
    { name: 'python-fullstack', version: '1.0.0', description: 'Python · FastAPI, data pipelines, pytest, CLI, Django', url: 'octo://official/packs/python-fullstack-v1', skillCount: 5 },
    { name: 'rust-systems', version: '1.0.0', description: 'Rust · Error handling, Async, CLI, Axum API, WASM', url: 'octo://official/packs/rust-systems-v1', skillCount: 5 },
    { name: 'go-backend', version: '1.0.0', description: 'Go · API, concurrency, gRPC, testing, microservices', url: 'octo://official/packs/go-backend-v1', skillCount: 5 },
    { name: 'seo-web', version: '1.0.0', description: 'SEO · Meta tags, sitemap, performance audit, Analytics, font optimization', url: 'octo://official/packs/seo-web-v1', skillCount: 5 },
    { name: 'architecture', version: '1.0.0', description: 'Architecture · Clean, event-driven, microservices, DDD, system design', url: 'octo://official/packs/architecture-v1', skillCount: 5 },
  ],
};

function readEmbeddedPayload(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === EMBEDDED_OFFICIAL_MANIFEST_URL) {
    return JSON.stringify(EMBEDDED_OFFICIAL_MANIFEST);
  }
  const prefix = 'octo://official/packs/';
  if (!trimmed.startsWith(prefix)) return null;
  const key = trimmed.slice(prefix.length);
  const skills = EMBEDDED_OFFICIAL_PACKS[key];
  if (!skills) return null;
  return JSON.stringify({ skills });
}

function normalizeRemoteUrl(url: string): string {
  const raw = url.trim();
  try {
    const parsed = new URL(raw);
    if (parsed.hostname === 'github.com') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      // github.com/{owner}/{repo}/blob/{branch}/{path...} -> raw.githubusercontent.com/{owner}/{repo}/{branch}/{path...}
      if (parts.length >= 5 && parts[2] === 'blob') {
        const owner = parts[0];
        const repo = parts[1];
        const branch = parts[3];
        const path = parts.slice(4).join('/');
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
      }
    }
  } catch {
    // keep input as-is
  }
  return raw;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(hash));
}

type HttpResponseOutput = {
  status: number;
  body: string;
  truncated?: boolean;
};

async function fetchText(url: string): Promise<string> {
  const embedded = readEmbeddedPayload(url);
  if (embedded !== null) return embedded;

  const normalizedUrl = normalizeRemoteUrl(url);
  try {
    const res = await fetch(normalizedUrl, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} (${normalizedUrl})`);
    }
    return await res.text();
  } catch (err) {
    if (!isTauri()) {
      throw err;
    }
    const isHttpUrl = /^https?:\/\//i.test(normalizedUrl);
    if (!isHttpUrl) {
      throw err;
    }
    const res = await invoke<HttpResponseOutput>('http_request', {
      input: {
        method: 'GET',
        url: normalizedUrl,
        headers: {},
        body: null,
        timeout_ms: 30_000,
      },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} (${normalizedUrl})`);
    }
    if (res.truncated) {
      throw new Error('Remote payload is too large (truncated by backend proxy)');
    }
    return res.body;
  }
}

export async function loadRemoteSkillManifest(url: string): Promise<RemoteSkillPackManifest> {
  const raw = await fetchText(url);
  const data = JSON.parse(raw) as RemoteSkillPackManifest;
  if (!data || !Array.isArray(data.packs)) {
    throw new Error('Invalid manifest format');
  }
  // Merge embedded official packs so Studio always shows them
  const existingNames = new Set(data.packs.map((p) => p.name));
  for (const ep of EMBEDDED_OFFICIAL_MANIFEST.packs) {
    if (existingNames.has(ep.name)) continue;
    const packKey = ep.url.replace('octo://official/packs/', '');
    const skills = EMBEDDED_OFFICIAL_PACKS[packKey];
    data.packs.push({ ...ep, skills: skills || undefined });
  }
  return data;
}

export async function loadRemoteSkillPack(entry: RemoteSkillPackEntry): Promise<Skill[]> {
  if (Array.isArray(entry.skills)) {
    return entry.skills as Skill[];
  }
  const raw = await fetchText(entry.url);
  if (entry.checksumSha256) {
    const digest = await sha256Hex(raw);
    if (digest.toLowerCase() !== entry.checksumSha256.toLowerCase()) {
      throw new Error(`Checksum mismatch for ${entry.name}@${entry.version}`);
    }
  }
  const parsed = JSON.parse(raw);
  const skills = Array.isArray(parsed) ? parsed : parsed?.skills;
  if (!Array.isArray(skills)) {
    throw new Error(`Invalid pack format for ${entry.name}@${entry.version}`);
  }
  return skills as Skill[];
}

/* ────────────────────────────────────────────────────────────
 *  GitHub Repo URL helpers
 * ──────────────────────────────────────────────────────────── */

/** Check if a URL is a GitHub repo root (not a file) */
export function isGithubRepoUrl(url: string): boolean {
  return /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/i.test(url.trim());
}

/** Parse owner/repo from a GitHub URL */
export function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Filter packs from an existing manifest that match a GitHub repo URL.
 */
export function filterPacksByRepo(
  packs: RemoteSkillPackEntry[],
  repoUrl: string,
): RemoteSkillPackEntry[] {
  const parsed = parseGithubRepoUrl(repoUrl);
  if (!parsed) return [];
  const needle = `github.com/${parsed.owner}/${parsed.repo}`.toLowerCase();
  return packs.filter(
    (p) =>
      p.url?.toLowerCase().includes(needle) ||
      p.sourceUrl?.toLowerCase().includes(needle),
  );
}

/** Extract first paragraph from SKILL.md as description */
function extractSkillDescription(md: string): string {
  const lines = md.split('\n').map((l) => l.trim());
  let i = 0;
  // Skip title lines (# ...)
  while (i < lines.length && (lines[i].startsWith('#') || !lines[i])) i++;
  // Take first non-empty paragraph
  const descLines: string[] = [];
  while (i < lines.length && lines[i] && !lines[i].startsWith('#')) {
    descLines.push(lines[i]);
    i++;
  }
  return descLines.join(' ').slice(0, 300);
}

/**
 * Crawl a GitHub repo for SKILL.md files and build a manifest.
 * Uses the Git Trees API (1 call) + raw.githubusercontent.com for each SKILL.md.
 */
export async function crawlGithubRepoSkills(
  repoUrl: string,
  onProgress?: (done: number, total: number) => void,
): Promise<RemoteSkillPackManifest> {
  const parsed = parseGithubRepoUrl(repoUrl);
  if (!parsed) throw new Error('Not a GitHub repository URL');
  const { owner, repo } = parsed;

  // Try main, then master
  type TreeEntry = { path: string; type: string };
  let treeEntries: TreeEntry[] | null = null;
  let branch = 'main';
  for (const b of ['main', 'master']) {
    try {
      const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${b}?recursive=1`;
      const treeRaw = await fetchText(treeUrl);
      const treeData = JSON.parse(treeRaw) as { tree?: TreeEntry[] };
      if (treeData.tree?.length) {
        treeEntries = treeData.tree;
        branch = b;
        break;
      }
    } catch { /* try next branch */ }
  }

  if (!treeEntries) throw new Error(`Could not read repository tree for ${owner}/${repo}`);

  const skillPaths = treeEntries
    .filter((item) => item.type === 'blob' && /SKILL\.md$/i.test(item.path))
    .map((item) => item.path);

  if (skillPaths.length === 0) {
    return { schemaVersion: 'github-crawl', packs: [] };
  }

  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  const skills: Skill[] = [];
  const batchSize = 10;

  for (let i = 0; i < skillPaths.length; i += batchSize) {
    const batch = skillPaths.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(async (path) => {
        const content = await fetchText(`${rawBase}/${path}`);
        const parts = path.split('/');
        const skillName =
          parts.length >= 2
            ? parts[parts.length - 2]
            : path.replace(/\/SKILL\.md$/i, '').replace(/\//g, '-');
        const description = extractSkillDescription(content);
        return {
          id: `web-${owner}-${repo}-${skillName}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
          name: skillName,
          description: description || `${owner}/${repo} — ${skillName}`,
          emoji: '📄',
          command: `Apply the "${skillName}" skill from ${owner}/${repo}.\nSource: ${rawBase}/${path}\nContext: ${description || skillName}\nUse it on this codebase and return concrete file-level changes.`,
          cliType: 'claude' as const,
          category: 'docs' as const,
          tags: ['web', repo, skillName, 'skills-hub'],
          builtIn: false,
        } satisfies Skill;
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') skills.push(r.value);
    }
    onProgress?.(Math.min(i + batchSize, skillPaths.length), skillPaths.length);
  }

  const pack: RemoteSkillPackEntry = {
    name: `${owner}-${repo}`,
    version: new Date().toISOString().slice(0, 10),
    description: `${owner}/${repo} public skills collection (${skills.length} skills)`,
    url: repoUrl,
    sourceUrl: repoUrl,
    skillCount: skills.length,
    skills,
  };
  return { schemaVersion: 'github-crawl', packs: [pack] };
}
