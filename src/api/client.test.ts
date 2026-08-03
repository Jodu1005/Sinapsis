import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'

describe('ApiClient human capability', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  it('captures the human capability from the URL and only sends it to review-control routes', async () => {
    window.history.replaceState({}, '', '/?humanCapability=secret-capability&channel=alpha')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new ApiClient()
    await client.listDreamRuns()
    await client.listMemoryCandidates('pending')
    await client.getBootstrap()

    expect(window.sessionStorage.getItem('sinapsis:human-capability')).toBe('secret-capability')
    expect(window.location.search).toBe('?channel=alpha')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/dream/runs', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Sinapsis-Human-Capability': 'secret-capability' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/memory-candidates?status=pending', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Sinapsis-Human-Capability': 'secret-capability' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(3, '/api/bootstrap', expect.objectContaining({
      headers: expect.not.objectContaining({ 'X-Sinapsis-Human-Capability': expect.anything() }),
    }))
  })
})
