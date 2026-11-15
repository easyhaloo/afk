const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function lexicalTerms(value: string): string[] {
  const normalized = value.toLowerCase();
  const identifier = /[\p{Script=Latin}\p{N}_]+(?:[./:-][\p{Script=Latin}\p{N}_]+)*/gu;
  const identifiers = normalized.match(identifier) ?? [];
  const words = [...segmenter.segment(normalized.replace(identifier, ' '))]
    .filter(part => part.isWordLike).map(part => part.segment);
  return [...identifiers, ...words];
}
