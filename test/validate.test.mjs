// §6 の各規則に、通る例と落ちる例を1つ以上ずつ
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadData } from '../scripts/lib/data.mjs';
import { validate, isValidPhone, hasStandaloneOfficial } from '../scripts/validate.mjs';

const TODAY = '2026-10-23';
const BASE = loadData();
const SAMPLE_INCIDENTS = JSON.parse(readFileSync(new URL('./fixtures/incidents.sample.json', import.meta.url), 'utf8'));

function data(edit) {
  const d = structuredClone(BASE);
  edit?.(d);
  return d;
}
const svc = (d, id) => d.services.find((s) => s.id === id);

function expectOk(d, msg) {
  const { errors } = validate(d, { today: TODAY });
  assert.deepEqual(errors, [], msg);
}
function expectError(d, pattern) {
  const { errors } = validate(d, { today: TODAY });
  assert.ok(errors.some((e) => pattern.test(e)), `次の誤りが出るはず: ${pattern}\n実際: ${errors.join('\n') || '（誤りなし）'}`);
}

test('いまのデータは誤り 0 件', () => expectOk(data()));

// §6-1 URL
test('§6-1 公式ドメイン（とサブドメイン）の URL は通る', () => {
  expectOk(data((d) => { svc(d, 'mufg').official_notices[0].url = 'https://www.bk.mufg.jp/some/page.html'; }));
});
test('§6-1 公式ドメイン外の URL は落ちる', () => {
  expectError(data((d) => { svc(d, 'mufg').official_notices[0].url = 'https://bk-mufg.example.com/'; }), /official_notices\[0\]\.url: .* official_domains/);
});
test('§6-1 https: でない URL は落ちる', () => {
  expectError(data((d) => { svc(d, 'mufg').official_top.url = 'http://www.bk.mufg.jp/'; }), /official_top\.url: https: の URL/);
  expectError(data((d) => { svc(d, 'mufg').official_alternatives[0].url = 'javascript:alert(1)'; }), /official_alternatives\[0\]\.url: https: の URL/);
});
test('§6-1 報道の URL は出典（type: "press"）にだけ使える', () => {
  expectOk(data((d) => { d.incidents = structuredClone(SAMPLE_INCIDENTS); }));
  expectError(data((d) => { svc(d, 'sagawa').official_notices[0].url = 'https://ecnomikata.com/ecnews/51852/'; }), /sagawa\]\.official_notices\[0\]\.url/);
  expectError(data((d) => {
    d.incidents = structuredClone(SAMPLE_INCIDENTS);
    d.incidents[0].sources[0].url = 'https://ecnomikata.com/ecnews/51852/'; // 報道の URL を official と称する
  }), /incidents\[test-ongoing-sagawa\]\.sources\[0\]\.url/);
});
test('§6-1 公式ドメインが未確認のサービスには URL を載せられない', () => {
  expectError(data((d) => { svc(d, 'jal').official_top = { url: 'https://www.jal.co.jp/', label: null, verified: true, note: null }; }), /jal\]\.official_top\.url: 公式ドメインが未確認/);
});
test('§6-1 パスつきの許可（委託先）はそのパスの下だけ', () => {
  expectOk(data((d) => { svc(d, 'ekinet').official_notices[0].url = 'https://secure.okbiz.jp/eki-net/faq/show/1'; }));
  expectError(data((d) => { svc(d, 'ekinet').official_notices[0].url = 'https://secure.okbiz.jp/other/faq/show/1'; }), /ekinet\]\.official_notices\[0\]\.url/);
});

// §6-2 形
test('§6-2 必須の項目が無いと落ちる', () => {
  expectError(data((d) => { delete svc(d, 'mufg').verified_at; }), /mufg\]: 必須の項目 "verified_at"/);
});
test('§6-2 型が違うと落ちる', () => {
  expectError(data((d) => { svc(d, 'mufg').mostly_unverified = 'no'; }), /mufg\]\.mostly_unverified: true か false/);
  expectError(data((d) => { svc(d, 'mufg').notes = 'メモ'; }), /mufg\]\.notes: 配列/);
});
test('§6-2 id の重複は落ちる', () => {
  expectError(data((d) => { d.services.push(structuredClone(svc(d, 'mufg'))); }), /services: id "mufg" が重複/);
});
test('§6-2 知らないカテゴリは落ちる', () => {
  expectError(data((d) => { svc(d, 'mufg').category = 'casino'; }), /知らないカテゴリ "casino"/);
});
test('§6-2 知らない項目（書き間違い）は落ちる', () => {
  expectError(data((d) => { svc(d, 'mufg').verifed_at = '2026-10-23'; }), /知らない項目 "verifed_at"/);
});
test('§6-2 電話窓口の有無と電話番号が食い違うと落ちる', () => {
  expectError(data((d) => { svc(d, 'mufg').phone_desk = 'none'; }), /"none" なのに電話番号があります/);
  expectError(data((d) => { svc(d, 'sagawa').phone_desk = 'listed'; }), /"listed" なのに電話番号がありません/);
});
test('§6-2 公式ではないドメインが公式ドメインと重なると落ちる', () => {
  expectError(data((d) => { svc(d, 'mizuho').not_official[0].domain = 'www.mizuhobank.co.jp'; }), /official_domains と重なっています/);
});

// §6-3 公式の出典
test('§6-3 公式発表の出典がある障害は通る', () => {
  expectOk(data((d) => { d.incidents = structuredClone(SAMPLE_INCIDENTS); }));
});
test('§6-3 公式発表の出典が無い障害（報道だけ）は落ちる', () => {
  expectError(data((d) => {
    d.incidents = structuredClone(SAMPLE_INCIDENTS);
    d.incidents[0].sources = d.incidents[0].sources.filter((s) => s.type !== 'official');
  }), /公式発表の出典（type: "official"）が1つもありません/);
});
test('§6-3 出典が空の障害は落ちる', () => {
  expectError(data((d) => {
    d.incidents = structuredClone(SAMPLE_INCIDENTS);
    d.incidents[0].sources = [];
  }), /出典を1つ以上/);
});

// §6-4 確認日
test('§6-4 確認日から180日以内なら警告なし', () => {
  const { warnings } = validate(data(), { today: '2027-04-21' }); // 180日後
  assert.deepEqual(warnings, []);
});
test('§6-4 確認日から180日を過ぎると警告（失敗にはしない）', () => {
  const { errors, warnings } = validate(data(), { today: '2027-04-22' }); // 181日後
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 30);
  assert.match(warnings[0], /180日を過ぎています/);
});

// §6-5 電話番号
test('§6-5 電話番号の形', () => {
  for (const ok of ['0120-543-555', '0570-00-5490', '03-5638-5171', '06-4960-9866', '0120-23-28-86', '0120-794889', '0077-7046', '151', '#9110', '188']) {
    assert.ok(isValidPhone(ok), ok);
  }
  for (const bad of ['０１２０-５４３-５５５', '0120－543－555', '0120 543 555', '(0120)543-555', '0120543555', '0120-5', '+81-120-543-555', '']) {
    assert.ok(!isValidPhone(bad), bad);
  }
  expectError(data((d) => { svc(d, 'mufg').official_alternatives[0].phones[0].number = '０１２０-５４３-５５５'; }), /電話番号の形が違います/);
});

// §6-6 「公式」を単独で使わない
test('§6-6 「公式」の使い方', () => {
  for (const ok of ['三菱UFJ銀行が使えないときの公式情報と代わりの手段', '公式発表', '公式サイトへ', 'とまったらナビ（非公式）', 'いま公式に発表されている障害', '公式のお知らせ']) {
    assert.ok(!hasStandaloneOfficial(ok), ok);
  }
  for (const bad of ['【公式】とまったらナビ', 'とまったらナビ公式', '公式とまったらナビ', '公式・とまったらナビ']) {
    assert.ok(hasStandaloneOfficial(bad), bad);
  }
  expectError(data((d) => { d.site.name = 'とまったらナビ公式'; }), /site\.name: 「公式」を単独で使わないでください/);
  expectError(data((d) => { d.content[0].meta.title = '【公式】このサイトについて'; }), /の title: 「公式」を単独で/);
});
