import { describe, expect, it } from 'vitest';
import { RuleFileSchema, RuleSchema } from '@psychometr/shared';
import {
  syntheticRuleEngine,
  syntheticRuleFile,
  SYNTHETIC_DRAFT_ID,
  SYNTHETIC_RULE_ID,
} from '../testing/rules.js';
import { findContentDir } from './scales.js';
import { buildFacts, compileRuleEngine, loadRuleEngine, type ScoreSnapshot } from './rules.js';

const contentDir = findContentDir();
const sources = new Set([
  'pogosova-phq-2014',
  'kr-457-gtr',
  'zolotareva-gad7-2023',
  'phq-screeners-terms',
]);

describe('product rule content', () => {
  it('loads with no active routing rules, so routing reports pending clinical agreement', async () => {
    const engine = await loadRuleEngine(contentDir);
    expect(engine.all).toHaveLength(0);
    expect(engine.routingStatus()).toBe('pending_clinical_agreement');
    expect(engine.activeCount('routing')).toBe(0);
  });
});

describe('RuleSchema', () => {
  const base = syntheticRuleFile().rules[0];
  it('refuses an active rule without a clinical agreement date', () => {
    expect(base).toBeDefined();
    const result = RuleSchema.safeParse({ ...base, reviewed_at: null });
    expect(result.success).toBe(false);
  });
  it('refuses unknown keys so typos in rule files do not pass silently', () => {
    expect(RuleSchema.safeParse({ ...base, severty: 'warning' }).success).toBe(false);
  });
  it('accepts a draft rule without a date', () => {
    expect(RuleSchema.safeParse({ ...base, status: 'draft', reviewed_at: null }).success).toBe(
      true,
    );
  });
  it('rejects a severity outside info, warning, critical', () => {
    expect(RuleSchema.safeParse({ ...base, severity: 'high' }).success).toBe(false);
  });
  it('accepts an empty routing file that carries a note', () => {
    expect(RuleFileSchema.safeParse({ note: 'pending', rules: [] }).success).toBe(true);
  });
});

describe('compileRuleEngine', () => {
  it('rejects a rule that cites a source missing from sources.json', () => {
    expect(() =>
      compileRuleEngine(new Set(['other-source']), [
        { category: 'safety', file: syntheticRuleFile() },
      ]),
    ).toThrow(/неизвестный источник/);
  });
  it('rejects duplicate rule ids across files', () => {
    expect(() =>
      compileRuleEngine(sources, [
        { category: 'safety', file: syntheticRuleFile() },
        { category: 'routing', file: syntheticRuleFile() },
      ]),
    ).toThrow(/Повторный идентификатор/);
  });
});

describe('buildFacts', () => {
  it('marks every missing value as unknown, never as false', () => {
    const facts = buildFacts(new Map());
    expect(facts['phq9_total']).toBe('unknown');
    expect(facts['phq9_item9_positive']).toBe('unknown');
    expect(facts['pregnancy']).toBe('unknown');
    expect(facts['renal_function']).toBe('unknown');
    expect(facts['hepatic_function']).toBe('unknown');
    expect(facts['concomitant_medications']).toBe('unknown');
  });
  it('copies the latest score and the item-9 flag when present', () => {
    const phq9: ScoreSnapshot = { score: 14, bandLabel: 'Умеренная', safetySignal: true };
    const facts = buildFacts(new Map([['phq9', phq9]]));
    expect(facts['phq9_total']).toBe(14);
    expect(facts['phq9_item9_positive']).toBe(true);
    expect(facts['gad7_total']).toBe('unknown');
  });
});

describe('RuleEngine.evaluate', () => {
  it('fires an active rule when its table says so and skips drafts', async () => {
    const engine = syntheticRuleEngine();
    const fired = await engine.evaluate(
      buildFacts(new Map([['phq9', { score: 12, bandLabel: 'x', safetySignal: false }]])),
    );
    expect(fired.map((item) => item.rule.id)).toEqual([SYNTHETIC_RULE_ID]);
    expect(fired.map((item) => item.rule.id)).not.toContain(SYNTHETIC_DRAFT_ID);
  });
  it('does not fire below the threshold', async () => {
    const engine = syntheticRuleEngine();
    const fired = await engine.evaluate(
      buildFacts(new Map([['phq9', { score: 3, bandLabel: 'x', safetySignal: false }]])),
    );
    expect(fired).toEqual([]);
  });
  it('treats an unknown fact as not triggering a threshold rule, without an error', async () => {
    const engine = syntheticRuleEngine();
    const fired = await engine.evaluate(buildFacts(new Map()));
    expect(fired).toEqual([]);
  });
  it('fails closed when a rule does not return a boolean triggered flag', async () => {
    const engine = syntheticRuleEngine('"yes"');
    await expect(
      engine.evaluate(
        buildFacts(new Map([['phq9', { score: 12, bandLabel: 'x', safetySignal: false }]])),
      ),
    ).rejects.toThrow(/triggered/);
  });
});
