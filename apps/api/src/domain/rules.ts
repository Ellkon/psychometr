/* eslint-disable security/detect-non-literal-fs-filename -- Rules directory is deployment-only; file names come from readdir, never from request input. */
/**
 * Decision-table rule engine (FR-4.1–4.3). Rules are JSON in content/rules, evaluated by
 * GoRules ZEN on the server. The engine never writes clinical text itself: a card shows
 * the rule's message, its source and the facts it was evaluated on.
 *
 * Fail-closed: a rule that returns no boolean `triggered` aborts the evaluation, so a broken
 * rule is visible instead of silently not firing.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ZenEngine, type ZenDecision } from '@gorules/zen-engine';
import {
  RuleFileSchema,
  SourcesFileSchema,
  type Rule,
  type RuleFactValue,
  type RuleFile,
} from '@psychometr/shared';

export type Facts = Record<string, RuleFactValue>;

const UNKNOWN = 'unknown';

export interface ScoreSnapshot {
  readonly score: number;
  readonly bandLabel: string;
  readonly safetySignal: boolean;
}

/**
 * Facts for rules. Missing data is "unknown" (FR-4.7), so a rule must test for it explicitly
 * and can never read a missing value as false.
 */
export function buildFacts(latest: ReadonlyMap<string, ScoreSnapshot>): Facts {
  const phq9 = latest.get('phq9');
  const gad7 = latest.get('gad7');
  return {
    phq9_total: phq9?.score ?? UNKNOWN,
    phq9_band: phq9?.bandLabel ?? UNKNOWN,
    phq9_item9_positive: phq9?.safetySignal ?? UNKNOWN,
    gad7_total: gad7?.score ?? UNKNOWN,
    gad7_band: gad7?.bandLabel ?? UNKNOWN,
    pregnancy: UNKNOWN,
    renal_function: UNKNOWN,
    hepatic_function: UNKNOWN,
    concomitant_medications: UNKNOWN,
  };
}

export interface CompiledRule {
  readonly rule: Rule;
  /** File name without extension: "routing", "safety", "adherence". */
  readonly category: string;
  /** Present only for active rules; drafts are validated but never evaluated. */
  readonly decision: ZenDecision | null;
}

export class RuleEngine {
  constructor(private readonly compiled: readonly CompiledRule[]) {}

  get all(): readonly CompiledRule[] {
    return this.compiled;
  }

  activeCount(category: string): number {
    return this.compiled.filter(
      (item) => item.category === category && item.rule.status === 'active',
    ).length;
  }

  /** Routing is "active" only when at least one routing rule has clinical agreement. */
  routingStatus(): 'active' | 'pending_clinical_agreement' {
    return this.activeCount('routing') > 0 ? 'active' : 'pending_clinical_agreement';
  }

  /** Returns the active rules whose decision table sets `triggered` to true. */
  async evaluate(facts: Facts): Promise<CompiledRule[]> {
    const triggered: CompiledRule[] = [];
    for (const item of this.compiled) {
      if (!item.decision) continue;
      const response = await item.decision.evaluate(facts);
      const result = response.result as Record<string, unknown>;
      if (typeof result['triggered'] !== 'boolean') {
        throw new Error(`Правило ${item.rule.id} не вернуло логическое поле triggered`);
      }
      if (result['triggered']) triggered.push(item);
    }
    return triggered;
  }
}

export interface RuleFileInput {
  readonly category: string;
  readonly file: RuleFile;
}

/** Compiles validated rule files. Rejects duplicate ids and rules citing unknown sources. */
export function compileRuleEngine(
  sourceIds: ReadonlySet<string>,
  files: readonly RuleFileInput[],
): RuleEngine {
  const zen = new ZenEngine();
  const seen = new Set<string>();
  const compiled: CompiledRule[] = [];
  for (const { category, file } of files) {
    for (const rule of file.rules) {
      if (seen.has(rule.id)) throw new Error(`Повторный идентификатор правила ${rule.id}`);
      seen.add(rule.id);
      if (!sourceIds.has(rule.source_id)) {
        throw new Error(`Правило ${rule.id} ссылается на неизвестный источник ${rule.source_id}`);
      }
      const decision = rule.status === 'active' ? zen.createDecision(rule.decision) : null;
      compiled.push({ rule, category, decision });
    }
  }
  return new RuleEngine(compiled);
}

/** Loads and validates content/rules/*.json and sources.json from a content directory. */
export async function loadRuleEngine(contentDir: string): Promise<RuleEngine> {
  const sources = SourcesFileSchema.parse(
    JSON.parse(await readFile(path.join(contentDir, 'sources.json'), 'utf8')),
  );
  const rulesDir = path.join(contentDir, 'rules');
  const names = (await readdir(rulesDir)).filter((name) => name.endsWith('.json')).sort();
  const files: RuleFileInput[] = [];
  for (const name of names) {
    const file = RuleFileSchema.parse(
      JSON.parse(await readFile(path.join(rulesDir, name), 'utf8')),
    );
    files.push({ category: name.replace(/\.json$/, ''), file });
  }
  const requirementOnly = new Set(
    sources.sources.filter((source) => source.kind === 'project_requirement').map((s) => s.id),
  );
  for (const { file } of files)
    for (const rule of file.rules)
      if (rule.status === 'active' && requirementOnly.has(rule.source_id))
        throw new Error(`Правило ${rule.id} активно, но опирается только на требование ТЗ`);
  return compileRuleEngine(new Set(sources.sources.map((source) => source.id)), files);
}
