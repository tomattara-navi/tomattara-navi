# とまったらナビ（仮称・非公式）

銀行・交通・宅配・通販・携帯電話などのサービスが止まったときに、「**いま何が止まっていて、代わりにどこで何ができるか**」を1か所にまとめる非公式の案内板です。

> このサイトは各社とは無関係の非公式の案内です。最新・正確な情報は必ず各社の公式発表で確かめてください。

- 公開先: https://tomattara-navi.github.io/tomattara-navi/ （GitHub Pages）
- 計画書・仕様: [docs/PLAN.md](docs/PLAN.md)

## やること・やらないこと

- 各社の公式のお知らせ・公式の代わりの窓口へのリンクと、事実の短いまとめ
- 障害に便乗した偽サイト・偽 SMS への注意（当サイトが確認した公式ドメインの一覧）
- 止まったサービスの機能そのもの（買う・送金・予約）は作らない。入力欄・Cookie・解析・広告・外部の読み込みは一切置かない

## 使い方（Node 22 だけで動きます。npm の依存はありません）

```sh
node scripts/validate.mjs   # データの検査（docs/PLAN.md §6）
node --test                 # 試験
node scripts/build.mjs      # dist/ に静的な HTML を生成
node test/mutation_check.mjs  # 検算: わざと壊した版で検査が落ちることを確かめる
```

生成したページは `dist/index.html` をブラウザで開けば確かめられます（リンクはすべて相対パス）。

## データの更新のしかた

データの更新は **Pull Request** で行います。必ず各社の公式ページを開いて確かめてから書きます。

| ファイル | 中身 |
|---|---|
| `data/services.json` | 見張る対象のサービス（docs/PLAN.md 付録A）。形は `data/schema/services.schema.json` |
| `data/incidents.json` | 人が**公式発表を確かめて**登録する障害。`sources` に `type: "official"` が1つも無いと検査で落ちる |
| `data/past_cases.json` | 「過去の事例」のページ（報道で伝えられた事例・出典つき） |
| `data/categories.json` | カテゴリ |
| `data/site.json` | サイト名・公開 URL・説明と、Google Search Console の確認コード（`google_site_verification`。トップの `<head>` に meta で出す。使わないなら `null`） |
| `data/links.json` | サービス以外でリンクしてよい先（気象庁・このリポジトリ） |
| `data/consultation.json` | 「偽サイトに注意」のページの相談先 |
| `content/*.html` | 固定ページの本文（about・免責・プライバシー・bot・偽サイト注意・ガイド） |

決まりごと（検査で機械的に確かめます）:

- URL は `https:` で、そのサービスの `official_domains`（とサブドメイン）に一致するものだけ。短縮 URL は使わない
- 調べて無かったものは `null`、調べられなかったものは `"unverified"`（画面では「未確認」）。**推測で埋めない**
- 電話番号は半角数字とハイフン（`0120-123-456`）。電話番号には根拠のページと受付時間（不明なら `"unverified"`）を付ける
- `verified_at` から180日を過ぎると警告が出て、画面に「要再確認」と出る
- 見出し・名称に「公式」を単独で使わない（「公式発表」「公式サイト」などは可）
- 作業の内部の呼び名（`session1`・`Opus` など）を書かない。`verified_by` は「運営者が公式ページで確認」のように書く

障害の登録の例（`data/incidents.json`）:

```json
{
  "id": "2026-10-15-cmoa",
  "service_id": "cmoa",
  "title": "電子書籍の購入・閲覧が停止（運営発表）",
  "status": "ongoing",
  "started_at": "2026-10-15T11:35+09:00",
  "resolved_at": null,
  "summary": "自分の言葉で2〜3文",
  "what_you_can_do": ["会社が案内した代わりの手段"],
  "sources": [{ "url": "https://（公式発表の URL）", "type": "official" }],
  "updated_at": "2026-10-21"
}
```

`status` が `resolved` になって30日を過ぎたものは、トップから外れて「過去の事例」のページに移ります。

## 連絡

- 訂正・削除の依頼、障害情報の追加: [Issues](https://github.com/tomattara-navi/tomattara-navi/issues/new/choose)（個人情報は書かないでください）
- セキュリティの問題: [SECURITY.md](SECURITY.md)

## ライセンス

コードは MIT、`data/` は CC BY 4.0。くわしくは [LICENSE](LICENSE)。

`assets/og.png` は、このリポジトリのために作った文字だけの画像です（IPA ゴシックで描画）。
