import { invoke, isTauri } from '@tauri-apps/api/core'

const API_BASE = 'https://bbarit.com'
const PRODUCT_CODE = 'terminal'

function debugLog(msg: string) {
  console.log(msg)
  if (!isTauri()) return
  invoke('debug_log', { message: msg }).catch(() => {})
}

type HttpResponseOutput = {
  status: number
  body: string
  truncated?: boolean
}

export type ProductNoticeTone = 'info' | 'success' | 'warning' | 'danger'

export interface ProductNotice {
  id: number
  target_product?: 'all' | 'terminal' | 'captures'
  title: string
  body: string
  tone: ProductNoticeTone
  cta_label?: string | null
  cta_url?: string | null
  is_pinned?: boolean
  starts_at?: string | null
  ends_at?: string | null
  updated_at?: string | null
}

export async function openBbaritUrl(pathOrUrl: string): Promise<void> {
  const path = pathOrUrl.trim()
  if (!path) return
  const url = path.startsWith('http://') || path.startsWith('https://')
    ? path
    : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`
  if (isTauri()) {
    await invoke('plugin:shell|open', { path: url })
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function fetchProductNotices(productCode = PRODUCT_CODE): Promise<ProductNotice[]> {
  if (!isTauri()) return []
  try {
    const url = `${API_BASE}/api/products/notices?product_code=${encodeURIComponent(productCode)}`
    const readJson = async () => {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        })
        return {
          status: res.status,
          ok: res.ok,
          text: await res.text(),
        }
      } catch (err) {
        debugLog(`[notices] fetchProductNotices: browser fetch failed; using backend proxy ${err}`)
        const res = await invoke<HttpResponseOutput>('http_request', {
          input: {
            method: 'GET',
            url,
            headers: { Accept: 'application/json' },
            body: null,
            timeout_ms: 10_000,
          },
        })
        return {
          status: res.status,
          ok: res.status >= 200 && res.status < 300,
          text: res.body,
        }
      }
    }

    const response = await readJson()
    const data = JSON.parse(response.text) as {
      ok?: boolean
      data?: Array<Omit<ProductNotice, 'id'> & { id: number | string }>
      error?: string
    }

    if (!response.ok || !data.ok || !Array.isArray(data.data)) {
      debugLog(`[notices] fetchProductNotices: failed status=${response.status} error=${data.error || ''}`)
      return []
    }

    return data.data
      .map((notice) => ({ ...notice, id: Number(notice.id) }))
      .filter((notice) => Number.isFinite(notice.id) && notice.title && notice.body)
  } catch (err) {
    debugLog(`[notices] fetchProductNotices: EXCEPTION ${err}`)
    return []
  }
}
