// The service worker's replay of submissions queued offline (swReplay.ts).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { replayKeepingUnanswered, type ReplayQueue } from './swReplay'

type Entry = { request: Request }

function queueOf(urls: string[]): ReplayQueue & { entries: Entry[] } {
  const entries: Entry[] = urls.map((url) => ({ request: new Request(url, { method: 'POST', body: '{}' }) }))
  return {
    entries,
    shiftRequest: async () => entries.shift(),
    unshiftRequest: async (entry) => { entries.unshift(entry) },
  }
}

/** Answers each URL with the status it names (`.../503`), or fails to connect for `.../offline`. */
function serverAnswering(sent: string[]) {
  return vi.fn(async (request: Request) => {
    sent.push(request.url)
    const last = request.url.split('/').pop() ?? ''
    if (last === 'offline') throw new TypeError('Failed to fetch')
    return new Response(null, { status: Number(last) })
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('replayKeepingUnanswered', () => {
  it('removes what the server answered, accepted or refused', async () => {
    const sent: string[] = []
    vi.stubGlobal('fetch', serverAnswering(sent))
    const queue = queueOf(['https://f.example/a/201', 'https://f.example/b/400', 'https://f.example/c/500'])
    await replayKeepingUnanswered({ queue })
    expect(queue.entries).toEqual([])
    expect(sent).toHaveLength(3)
  })

  for (const unanswered of ['503', '502', '504', '408', '429', 'offline']) {
    it(`keeps a submission the server did not take in (${unanswered}), in its place, and stops there`, async () => {
      const sent: string[] = []
      vi.stubGlobal('fetch', serverAnswering(sent))
      const queue = queueOf(['https://f.example/a/201', `https://f.example/b/${unanswered}`, 'https://f.example/c/201'])
      // Workbox reads a rejection as "try this sync again later".
      await expect(replayKeepingUnanswered({ queue })).rejects.toThrow(/kept for the next try/)
      expect(queue.entries.map((e) => e.request.url)).toEqual([`https://f.example/b/${unanswered}`, 'https://f.example/c/201'])
      expect(sent).toEqual(['https://f.example/a/201', `https://f.example/b/${unanswered}`])
    })
  }

  it('works from its own source text alone, as the service worker gets it', async () => {
    const rebuilt = new Function(`return (${replayKeepingUnanswered.toString()})`)() as typeof replayKeepingUnanswered
    const sent: string[] = []
    vi.stubGlobal('fetch', serverAnswering(sent))
    const queue = queueOf(['https://f.example/a/201', 'https://f.example/b/503'])
    await expect(rebuilt({ queue })).rejects.toThrow()
    expect(queue.entries.map((e) => e.request.url)).toEqual(['https://f.example/b/503'])
  })

  it('is the replay of both submission queues the service worker keeps', () => {
    const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')
    for (const name of ['formSubmissionQueue', 'publicFormSubmissionQueue']) {
      const at = config.indexOf(`name: '${name}'`)
      expect(at, name).toBeGreaterThan(-1)
      const options = config.slice(at, config.indexOf('},', config.indexOf('options:', at)) + 2)
      expect(options, name).toMatch(/onSync: replayKeepingUnanswered/)
    }
  })
})
