import { describe, expect, it } from 'vitest';
import { CLARIFICATION_FACTS } from '@psychometr/shared';
import { FACT_LABEL, formatFact } from './cards.js';

describe('formatFact', () => {
  it('shows unknown as missing data, not as a negative answer', () => {
    expect(formatFact('unknown')).toBe('не указано, уточнить');
    expect(formatFact('unknown')).not.toBe('нет');
  });
  it('shows booleans and numbers in Russian or as plain numbers', () => {
    expect(formatFact(true)).toBe('да');
    expect(formatFact(false)).toBe('нет');
    expect(formatFact(14)).toBe('14');
  });
  it('labels every clarification fact', () => {
    for (const fact of CLARIFICATION_FACTS) {
      expect(FACT_LABEL.get(fact.key)).toBe(fact.label);
    }
  });
});
