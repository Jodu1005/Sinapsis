const capabilityRules: ReadonlyArray<readonly [string, RegExp]> = [
  ['frontend', /(?:react|css|\bui\b|界面)/i],
  ['test', /(?:\btest\b|测试|vitest)/i],
  ['backend', /(?:\bapi\b|schema|数据库)/i],
  ['review', /(?:\breview\b|审查)/i],
]

export function inferCapabilityTags(text: string): string[] {
  const tags = capabilityRules
    .filter(([, pattern]) => pattern.test(text))
    .map(([tag]) => tag)

  return tags.length > 0 ? tags : ['general']
}
