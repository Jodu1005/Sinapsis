export interface ParsedJsonlLine {
  raw: string
  value: unknown
}

export class LfJsonlParser {
  private trailing = ''

  push(chunk: string): ParsedJsonlLine[] {
    const input = this.trailing + chunk
    const frames = input.split('\n')
    this.trailing = frames.pop() ?? ''

    return frames.filter((frame) => frame.length > 0).map((frame) => {
      const raw = frame.endsWith('\r') ? frame.slice(0, -1) : frame
      try {
        return { raw, value: JSON.parse(raw) }
      } catch {
        return { raw, value: undefined }
      }
    })
  }
}
