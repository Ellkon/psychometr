import { RuleFileSchema } from '@psychometr/shared';
import { compileRuleEngine, type RuleEngine } from '../domain/rules.js';

/**
 * Synthetic rules for tests only. They are not clinical content and never go into
 * content/rules. The source id reuses a real registered source to satisfy the loader.
 */
export const SYNTHETIC_RULE_ID = 'test_phq9_threshold';
export const SYNTHETIC_DRAFT_ID = 'test_draft_always';

function thresholdTable(field: string, threshold: number, trueOutput = 'true') {
  return {
    contentType: 'application/vnd.gorules.decision',
    nodes: [
      { id: 'in', name: 'request', type: 'inputNode', position: { x: 0, y: 0 } },
      {
        id: 'table',
        name: 'threshold',
        type: 'decisionTableNode',
        position: { x: 200, y: 0 },
        content: {
          hitPolicy: 'first',
          inputs: [{ id: 'i1', name: field, field }],
          outputs: [{ id: 'o1', name: 'triggered', field: 'triggered' }],
          rules: [
            { _id: 'r1', i1: `>= ${String(threshold)}`, o1: trueOutput },
            { _id: 'r2', i1: '', o1: 'false' },
          ],
        },
      },
      { id: 'out', name: 'response', type: 'outputNode', position: { x: 400, y: 0 } },
    ],
    edges: [
      { id: 'e1', sourceId: 'in', targetId: 'table', type: 'edge' },
      { id: 'e2', sourceId: 'table', targetId: 'out', type: 'edge' },
    ],
  };
}

/** trueOutput is a ZEN expression; '"yes"' makes the rule return a non-boolean (fail-closed test). */
export function syntheticRuleFile(trueOutput = 'true') {
  return RuleFileSchema.parse({
    note: 'СИНТЕТИЧЕСКИЕ ПРАВИЛА ДЛЯ ТЕСТОВ. Не клинический контент.',
    rules: [
      {
        id: SYNTHETIC_RULE_ID,
        version: '0.0.1',
        status: 'active',
        severity: 'warning',
        source_id: 'pogosova-phq-2014',
        source_location: 'тестовый фрагмент',
        message: 'Тестовое сообщение о пороге PHQ-9.',
        suggested_action: 'Тестовое действие: проверить анкету.',
        reviewed_at: '2026-10-23',
        decision: thresholdTable('phq9_total', 10, trueOutput),
      },
      {
        id: SYNTHETIC_DRAFT_ID,
        version: '0.0.1',
        status: 'draft',
        severity: 'info',
        source_id: 'pogosova-phq-2014',
        source_location: 'тестовый фрагмент',
        message: 'Черновик не должен срабатывать.',
        suggested_action: 'Не применять.',
        reviewed_at: null,
        decision: thresholdTable('phq9_total', 0),
      },
    ],
  });
}

export function syntheticRuleEngine(trueOutput = 'true'): RuleEngine {
  return compileRuleEngine(new Set(['pogosova-phq-2014']), [
    { category: 'safety', file: syntheticRuleFile(trueOutput) },
  ]);
}
