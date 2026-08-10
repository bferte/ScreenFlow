import { createHash } from 'node:crypto'

/**
 * Digs the human-readable reason out of a provider's error body.
 *
 * Lives here, free of Electron and network imports, so the shape-walking can be
 * asserted in a plain Node test — it is exactly the kind of code that fails
 * silently and is never noticed until an error message turns out to be useless.
 */
export function extractProviderMessage(text: string): string {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // HTML from a proxy or gateway; the raw snippet is still the best clue.
    return text.slice(0, 300).trim()
  }

  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): string | null => {
    if (depth > 4 || node === null || typeof node !== 'object' || seen.has(node)) return null
    seen.add(node)

    // Some providers wrap failures in a list (`{"errors":[{...}]}`), so array
    // elements have to be descended into, not just named keys.
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string' && item) return item
        const found = walk(item, depth + 1)
        if (found) return found
      }
      return null
    }

    const obj = node as Record<string, unknown>
    for (const key of ['message', 'error_message', 'msg']) {
      if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
    }
    for (const key of ['error', 'detail', 'errors', 'data']) {
      const child = obj[key]
      if (typeof child === 'string' && child) return child
      const found = walk(child, depth + 1)
      if (found) return found
    }
    return null
  }

  return walk(json, 0) ?? text.slice(0, 300).trim()
}

/**
 * Content-addressed key for a synthesised line.
 *
 * Note what is *absent*: timeline position, volume, block id. A voiceover
 * block's placement cannot influence its cache key, which is what makes
 * dragging a block structurally incapable of triggering an API call.
 *
 * Kept in its own module, free of Electron and network imports, so the
 * property can be asserted in a plain Node test rather than assumed.
 */
export function cacheKey(provider: string, model: string, voice: string, text: string) {
  return createHash('sha256')
    .update(`${provider}|${model}|${voice}|${text}`)
    .digest('hex')
    .slice(0, 32)
}
