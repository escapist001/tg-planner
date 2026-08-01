import { describe, it, expect } from 'vitest'
import worker from '../src/index.js'

describe('worker', () => {
  it('отвечает на любой запрос', async () => {
    const res = await worker.fetch(new Request('https://x/'), {}, {})
    expect(res.status).toBe(200)
  })
})
