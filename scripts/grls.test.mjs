import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  decodeXmlText,
  dosageForms,
  readFirstSheet,
  readZip,
  selectPsychotropics,
} from './grls.mjs';

/** Minimal ZIP writer for fixtures: deflated entries, no CRC check on read. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = deflateRawSync(Buffer.from(content));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, data);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const shared = ['Сертралин', 'Золофт®', 'психоаналептики; антидепрессанты', 'Ибупрофен'];
const sharedXml = `<sst>${shared.map((text) => `<si><t>${text}</t></si>`).join('')}</sst>`;
const cell = (ref, value) => `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const sheetXml = `<worksheet><sheetData>
<row r="1">${cell('D1', 'Государственный реестр')}</row>
<row r="2">${cell('C2', 'Номер')}${cell('D2', 'Дата регистрации')}</row>
<row r="3">${cell('C3', 'ЛП-001')}${cell('D3', '15.03.2023')}${cell('G3', 'АО &quot;Фарм&quot;')}<c r="I3" t="s"><v>1</v></c><c r="J3" t="s"><v>0</v></c>${cell('K3', 'таблетки, 50 мг, 14 шт. - блистеры; субстанция-порошок, ~, 1 кг')}<c r="N3" t="s"><v>2</v></c></row>
<row r="4">${cell('C4', 'ЛП-002')}${cell('D4', '01.01.2020')}${cell('I4', 'Сертралин-Х')}<c r="J4" t="s"><v>0</v></c>${cell('K4', 'таблетки, 100 мг, 30 шт.')}</row>
<row r="5">${cell('C5', 'ЛП-003')}${cell('D5', '01.01.2020')}${cell('E5', '01.01.2021')}${cell('I5', 'Старый')}<c r="J5" t="s"><v>0</v></c>${cell('K5', 'таблетки, 25 мг')}</row>
<row r="6">${cell('C6', 'ЛП-004')}${cell('D6', '01.01.2020')}${cell('I6', 'Нурофен')}<c r="J6" t="s"><v>3</v></c>${cell('K6', 'таблетки, 200 мг')}</row>
</sheetData></worksheet>`;

test('reads a ZIP member and decodes OOXML escapes', () => {
  const members = readZip(zip({ 'a.txt': 'привет' }));
  assert.equal(members.get('a.txt')().toString('utf8'), 'привет');
  assert.equal(decodeXmlText('A &amp; B_x000D_&#1072;'), 'A & B\rа');
});

test('selects active registrations of antidepressant INNs, including rows without a group', () => {
  const xlsx = zip({ 'xl/sharedStrings.xml': sharedXml, 'xl/worksheets/sheet1.xml': sheetXml });
  const products = selectPsychotropics(readFirstSheet(xlsx), '2026-10-23');
  assert.deepEqual(
    products.map((product) => product.reg_number),
    ['ЛП-001', 'ЛП-002'],
  );
  assert.deepEqual(products[0], {
    reg_number: 'ЛП-001',
    trade_name: 'Золофт®',
    inn: 'Сертралин',
    dosage_forms: ['таблетки, 50 мг'],
    holder: 'АО "Фарм"',
    registered_on: '2023-03-15',
  });
});

test('strips packaging and prescription notes from release forms', () => {
  assert.deepEqual(
    dosageForms(' - По рецепту; таблетки, покрытые оболочкой, 10 мг, 28 шт. - блистеры (2)'),
    ['таблетки, покрытые оболочкой, 10 мг'],
  );
});
