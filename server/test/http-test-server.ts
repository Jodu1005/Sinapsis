import { createServer, type RequestListener } from 'node:http'

export async function startHttpTestServer(requestListener: RequestListener): Promise<{
  baseUrl: string
  close: () => Promise<void>
}> {
  const server = createServer(requestListener)

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Expected the test server to bind to a TCP port.')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
