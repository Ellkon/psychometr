import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { selectIcd10 } from './icd10.mjs';

test('keeps current codable rubrics sorted by code', () => {
  const entries = selectIcd10([
    { MKB_CODE: 'V', MKB_NAME: 'ПСИХИЧЕСКИЕ РАССТРОЙСТВА', ACTUAL: 1 },
    { MKB_CODE: 'F30-F39', MKB_NAME: 'Расстройства настроения', ACTUAL: 1 },
    { MKB_CODE: 'F41.1', MKB_NAME: ' Генерализованное  тревожное расстройство ', ACTUAL: 1 },
    { MKB_CODE: 'F32', MKB_NAME: 'Депрессивный эпизод', ACTUAL: 1 },
    { MKB_CODE: 'F32.1', MKB_NAME: 'Депрессивный эпизод средней степени', ACTUAL: 1 },
    { MKB_CODE: 'R50.0', MKB_NAME: 'Лихорадка с ознобом', ACTUAL: 0 },
  ]);
  assert.deepEqual(entries, [
    { code: 'F32', name: 'Депрессивный эпизод' },
    { code: 'F32.1', name: 'Депрессивный эпизод средней степени' },
    { code: 'F41.1', name: 'Генерализованное тревожное расстройство' },
  ]);
});

test('fails on a duplicate current code', () => {
  assert.throws(() =>
    selectIcd10([
      { MKB_CODE: 'F32', MKB_NAME: 'a', ACTUAL: 1 },
      { MKB_CODE: 'F32', MKB_NAME: 'b', ACTUAL: 1 },
    ]),
  );
});
