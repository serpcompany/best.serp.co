import { MEDIA_CACHE_CONTROL } from '@serpdirectory/data-ops/media-keys'
import { describe, expect, it, vi } from 'vitest'
import { type MediaWorkerEnv, runMediaCron, serveLocalMedia } from './worker-media'

const key = 'best.serp.co/listings/example.com/logo/0123456789abcdef.png'
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function bucket(objects: Record<string, Uint8Array> = { [key]: png }): R2Bucket {
  return {
    async get(name) {
      const body = objects[name]
      if (!body) return null
      return {
        body: new Response(body).body as ReadableStream,
        httpEtag: '"etag"',
        httpMetadata: { cacheControl: MEDIA_CACHE_CONTROL, contentType: 'image/png' },
        size: body.byteLength
      }
    },
    async put() {
      return {}
    }
  }
}

const local: MediaWorkerEnv = {
  D1_RUNTIME_ENV: 'local',
  MEDIA: bucket(),
  SITE_ENVIRONMENT: 'local'
}

describe('local media route', () => {
  it('serves a stored key with its type and immutable cache policy', async () => {
    const response = await serveLocalMedia(
      new Request(`http://localhost:8787/_media/${key}`),
      local
    )
    expect(response?.status).toBe(200)
    expect(Object.fromEntries(response?.headers ?? [])).toMatchObject({
      'cache-control': MEDIA_CACHE_CONTROL,
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff'
    })
    expect(new Uint8Array(await (response as Response).arrayBuffer())).toEqual(png)
    const head = await serveLocalMedia(
      new Request(`http://localhost:8787/_media/${key}`, { method: 'HEAD' }),
      local
    )
    expect(head?.status).toBe(200)
  })

  it('answers 404 for a missing object or anything that is not a listing media key', async () => {
    for (const path of [
      `/_media/${key.replace('0123', 'ffff')}`,
      '/_media/serp.co/index.html',
      '/_media/best.serp.co%2Flistings%2F..%2Fsecret.png'
    ]) {
      const response = await serveLocalMedia(new Request(`http://localhost:8787${path}`), local)
      expect(response?.status, path).toBe(404)
    }
    const post = await serveLocalMedia(
      new Request(`http://localhost:8787/_media/${key}`, { method: 'POST' }),
      local
    )
    expect(post?.status).toBe(405)
  })

  it('never answers on staging or in production, or outside /_media', async () => {
    for (const env of [
      { ...local, D1_RUNTIME_ENV: 'staging', SITE_ENVIRONMENT: 'staging' },
      { ...local, D1_RUNTIME_ENV: 'production', SITE_ENVIRONMENT: 'production' },
      { ...local, SITE_ENVIRONMENT: 'production' }
    ]) {
      expect(
        await serveLocalMedia(new Request(`https://best.serp.co/_media/${key}`), env)
      ).toBeNull()
    }
    expect(await serveLocalMedia(new Request('http://localhost:8787/products/'), local)).toBeNull()
  })
})

describe('media cron', () => {
  it('fails closed without its bindings, and logs why', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    expect(await runMediaCron({ D1_RUNTIME_ENV: 'production', MEDIA: bucket() })).toBeNull()
    expect(await runMediaCron({ D1_RUNTIME_ENV: 'other' })).toBeNull()
    expect(info.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toEqual([
      'media_cron_disabled',
      'media_cron_disabled'
    ])
    info.mockRestore()
  })
})
