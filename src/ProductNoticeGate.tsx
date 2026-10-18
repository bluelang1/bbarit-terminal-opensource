import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Bell, ExternalLink, X } from 'lucide-react'
import {
  fetchProductNotices,
  openBbaritUrl,
  type ProductNotice,
  type ProductNoticeTone,
} from './productNotices'

const PRODUCT_CODE = 'terminal'
const DISMISSED_PREFIX = `bbarit-product-notice-dismissed:${PRODUCT_CODE}:`

interface Props {
  children: ReactNode
}

function noticeKey(notice: ProductNotice) {
  return `${DISMISSED_PREFIX}${notice.id}`
}

function isDismissed(notice: ProductNotice) {
  try {
    return localStorage.getItem(noticeKey(notice)) === '1'
  } catch {
    return false
  }
}

function markDismissed(notice: ProductNotice) {
  try {
    localStorage.setItem(noticeKey(notice), '1')
  } catch {
    // Storage can be unavailable in unusual webview states. Closing should still work.
  }
}

// Tool windows (/thread, /chat, /scrum, …) must not repeat the notice modal —
// dismissal state is shared via localStorage, so it would pop in every window.
const IS_MAIN_WINDOW = ['/', '/index.html', '/harness'].includes(window.location.pathname)

export function ProductNoticeGate({ children }: Props) {
  const [notices, setNotices] = useState<ProductNotice[]>([])

  useEffect(() => {
    if (!IS_MAIN_WINDOW) return
    let cancelled = false

    fetchProductNotices(PRODUCT_CODE)
      .then((items) => {
        if (cancelled) return
        setNotices(items.filter((notice) => !isDismissed(notice)))
      })
      .catch((err) => {
        console.warn('[notices] failed to load product notices:', err)
        if (!cancelled) setNotices([])
      })

    return () => {
      cancelled = true
    }
  }, [])

  const currentNotice = notices[0] || null

  const closeNotice = () => {
    if (!currentNotice) return
    markDismissed(currentNotice)
    setNotices((prev) => prev.filter((notice) => notice.id !== currentNotice.id))
  }

  const openNoticeLink = () => {
    const url = currentNotice?.cta_url?.trim()
    if (!url) return
    void openBbaritUrl(url).catch(() => {})
  }

  return (
    <>
      {children}
      {currentNotice && (
        <div style={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="product-notice-title">
          <div style={{ ...styles.card, ...toneStyle[currentNotice.tone] }}>
            <div style={styles.header}>
              <div style={styles.titleWrap}>
                <Bell size={18} strokeWidth={2.5} />
                <p id="product-notice-title" style={styles.title}>{currentNotice.title}</p>
              </div>
              <button type="button" title="Dismiss notice" aria-label="Dismiss notice" onClick={closeNotice} style={styles.iconButton}>
                <X size={18} />
              </button>
            </div>

            <p style={styles.label}>BBARIT TERMINAL NOTICE</p>
            <p style={styles.body}>{currentNotice.body}</p>

            <div style={styles.actions}>
              {currentNotice.cta_url && currentNotice.cta_label && (
                <button type="button" onClick={openNoticeLink} style={styles.linkButton}>
                  <ExternalLink size={16} />
                  {currentNotice.cta_label}
                </button>
              )}
              <button type="button" onClick={closeNotice} style={styles.primaryButton}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const toneStyle: Record<ProductNoticeTone, CSSProperties> = {
  info: { background: '#f0f9ff', borderColor: '#0ea5e9', color: '#0f172a' },
  success: { background: '#ecfdf5', borderColor: '#10b981', color: '#0f172a' },
  warning: { background: '#fffbeb', borderColor: '#f59e0b', color: '#0f172a' },
  danger: { background: '#fff1f2', borderColor: '#E11D48', color: '#0f172a' },
}

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 2147483647,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: 'rgba(15, 23, 42, 0.58)',
    fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  },
  card: {
    width: 'min(520px, 100%)',
    border: '3px solid #111827',
    borderRadius: 'var(--brutal-radius)',
    boxShadow: '6px 6px 0 #000',
    padding: 22,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 16,
  },
  titleWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: 18,
    lineHeight: 1.35,
    fontWeight: 900,
    wordBreak: 'keep-all',
  },
  iconButton: {
    width: 32,
    height: 32,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    border: '2px solid #111827',
    borderRadius: 'var(--brutal-radius)',
    background: '#fff',
    color: '#111827',
    cursor: 'pointer',
  },
  label: {
    margin: '14px 0 0',
    fontSize: 11,
    lineHeight: 1.4,
    fontWeight: 900,
    letterSpacing: 1.2,
    color: '#E11D48',
  },
  body: {
    margin: '10px 0 0',
    fontSize: 14,
    lineHeight: 1.7,
    fontWeight: 700,
    color: '#334155',
    whiteSpace: 'pre-wrap',
    wordBreak: 'keep-all',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 20,
    flexWrap: 'wrap',
  },
  linkButton: {
    minHeight: 40,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 14px',
    border: '2px solid #111827',
    borderRadius: 'var(--brutal-radius)',
    background: '#fff',
    color: '#111827',
    fontSize: 13,
    fontWeight: 900,
    cursor: 'pointer',
  },
  primaryButton: {
    minHeight: 40,
    padding: '0 18px',
    border: '2px solid #111827',
    borderRadius: 'var(--brutal-radius)',
    background: '#E11D48',
    color: '#fff',
    fontSize: 13,
    fontWeight: 900,
    cursor: 'pointer',
  },
}
