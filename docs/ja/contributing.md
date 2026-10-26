[English](../../CONTRIBUTING.md) | 日本語

# ThriftyRelayへの貢献

再現手順付きの不具合報告、文書の修正、回帰テスト、未確認のプラットフォームでの結果、小さなコード変更を歓迎します。
ThriftyRelayはRoseuが保守しています。
問題はGitHubのissueで報告し、変更はpull requestで提出してください。
セキュリティの問題は公開issueではなく、[セキュリティポリシー](security.md)の手順で報告してください。

## 作業を始める前に

動作、依存関係、対応プラットフォーム、セキュリティ境界に関わる大きな変更は、先にissueを開いて範囲を合わせてください。
小さな文書の修正はpull requestに直接送れます。

キー、トンネルID、タスク記録、セッションデータ、プロセスの環境変数、個人データをissue、pull request、テスト用フィクスチャに入れないでください。
偽の値と分離したタスクストアを使ってください。

## 開発環境の準備

Node.js 22以降とnpmを使います。

~~~sh
npm ci
node scripts/check-syntax.mjs
~~~

オフラインのテストはテスト用フィクスチャを使うため、実際のCodexサインインやタスクストアは不要です。
ThriftyRelay自体の実行には[セットアップ](setup.md)に書かれた資格情報とツールが必要です。
文書の作業にsetupの実行は不要です。

編集しているチェックアウトからThriftyRelayを実行している場合、実行中のサーバーは読み込み済みのコードを使い続け、新しく起動したワーカーは変更を読み込みます。
実行中の作業を確認したあと、[運用](operations.md#update-and-restart-cautions)の手順で再起動してください。

## テストの選び方

変更した範囲を対象とするテストを実行してください。
毎回すべてのテストを実行する必要はありません。
スクリプトは[package.json](../../package.json)に定義されています。

| 範囲 | コマンド |
| --- | --- |
| 構文とロケールの整合性 | `node scripts/check-syntax.mjs` |
| 読み込むすべてのモジュールがソースハッシュに入っているか | `node tests/test-source-build.mjs` |
| CLI、setup、doctor、設定、アンインストール | `npm run test:cli` |
| OSアダプター | `npm run test:platform` |
| Codexアダプターとテスト用フィクスチャでのモデル選択 | `npm run test:codex` |
| 実行ガード | `npm run test:stability` |
| テスト用フィクスチャでのリレー統合 | `npm run test:relay` |
| ローカルMCP制御と復旧の安全性 | `npm run test:local-ops` |
| オフラインの使用量と枠の計算 | `npm run test:usage`、`npm run test:quota` |
| アクセス制御 | `npm run test:access` |
| 受付 | `npm run test:admission` |
| 承認期間 | `npm run test:approval` |
| 承認待ち | `npm run test:approval-pending` |
| ポリシーの登録 | `npm run test:policy-install` |
| 承認ゲート | `npm run test:approval-gate` |
| 拒否 | `npm run test:approval-decline` |
| 一時作業領域 | `npm run test:scratch` |
| スコープ付きリースと復旧のテスト用フィクスチャ | `node tests/test-scope-leases.mjs`、`node tests/test-scoped-recovery.mjs`、`node tests/test-scoped-adapter.mjs` |
| POSIXの実行環境と状態 | POSIXでは`node tests/test-runtime-posix.mjs`、`node tests/test-runtime-state.mjs` |
| Linuxの実行環境の統合 | Linuxでは`node tests/test-runtime-background.mjs`、`node tests/test-runtime-foreground.mjs`、`node tests/test-setup-posix.mjs` |
| LinuxのSecret Service | `npm run test:secret-service`と、その分離したセッションバスとキーリングの前提条件 |

`npm test`は標準のオフラインスイートを実行します。
`npm run test:async`と`npm run test:code`は現在Windows PowerShellが必要です。
`npm run test:live`は実際のモデルを呼び出し、Codexの利用枠を使います。
ほかのスクリプトからもCIからも実行されないため、意図するときだけ実行してください。

[CIワークフロー](../../.github/workflows/ci.yml)は`main`へのpushとpull requestで実行され、手動でも開始できます。
Node.js 22を使い、リポジトリの権限は読み取り専用で、資格情報は使いません。

| OS | OS固有の確認 |
| --- | --- |
| Windows 2025 | PowerShellに依存するスイート。 |
| Ubuntu | POSIXの状態と実行環境、バックグラウンドとフォアグラウンド、setup、Secret Serviceの統合。 |
| macOS | POSIXの状態と実行環境。 |

CIはChatGPTや実際のモデルなしで実行するため、成功した実行が対象とするのはオフラインの動作だけです。
トンネルと実際のCodexの動作はローカルで確認する必要があります。

### テスト成果物と保持

テスト実行プログラムはデフォルトで`.test-artifacts`に、または`THRIFTYRELAY_TEST_ROOT`の絶対パスに書き込みます。
空のディレクトリ、または以前に作成したディレクトリを受け付け、ほかの内容があるディレクトリは拒否します。
実際のタスクストア、プロジェクトのデータ、Codexのセッション、共有キャッシュを指定しないでください。

| 上限 | 環境変数 | デフォルト |
| --- | --- | --- |
| サイズ | `THRIFTY_TEST_MAX_BYTES` | 256 MiB |
| 経過時間 | `THRIFTY_TEST_MAX_AGE_HOURS` | 168時間 |

上限は実行の前後に確認し、実行中の書き込みは制限しません。
プロセスが停止した成功実行のデータだけを削除し、各実行の小さな記録を残します。

次のものは経過時間やサイズにかかわらず保持します。

- 失敗した実行、リンクされた領域、所有者が動作中または不明な領域
- 有効なロックとメンテナンスロック、未完了または不明なタスク
- リクエストの重複防止記録、会話、監査記録

`npm run test:sweep`は、この規則で削除できる成功実行のデータを整理します。
実行ロックの解放には復旧手順を使ってください。

## 文書

対象の話題を扱う文書と、その翻訳を更新します。
詳しい手順をREADMEに重複させず、[英語の索引](../en/README.md)か[日本語README](README.md)からリンクしてください。

| 内容 | 英語の原本 | 日本語版 |
| --- | --- | --- |
| プロジェクトの概要 | `README.md` | `docs/ja/README.md` |
| 各ガイド | `docs/en/<topic>.md` | `docs/ja/<topic>.md` |
| 貢献ガイド | `CONTRIBUTING.md` | `docs/ja/contributing.md` |
| セキュリティ | `SECURITY.md` | `docs/ja/security.md` |
| 更新履歴 | `CHANGELOG.md` | `docs/ja/changelog.md` |

各ガイドのファイル名を揃え、先頭に言語切り替えを置きます。
`docs/README.md`が言語の選択ページです。
主な変更は、タグ付きリリースまで両方の更新履歴のUnreleased見出しに記載します。
英語索引の貢献ガイド、セキュリティ、第三者ライセンスは、ルートの本文へ直接リンクします。

### 文章の書き方

- 結果または次の操作を先に書き、必要な理由だけを短く添えます。
- 手順を簡潔にします。
  順序のある操作は番号付きリスト、長い条件は箇条書き、値や比較は表にします。
- 外部の利用者に向けて書き、作業ログやコーディングエージェントへの指示を残しません。
- 同じ主張は1回だけ書きます。
  変わり得る固定の件数、重ねた否定、太字の警告を避けます。
- 日本語は1行に1文で書き、ダッシュ、中黒の並列、補足の括弧を避けます。
- 日英で意味、条件、手順を揃えます。

提出前に次を確認します。

1. オプション、コード、パス、デフォルトを現在のソースと照合します。
2. 見出しを移動または変更した場合は、相対リンクとアンカーを確認します。
3. `node scripts/check-syntax.mjs`と`git diff --check`を実行します。

文書はソースハッシュの対象外なので、再起動なしで次の読み込みから反映されます。
`src/source-build.mjs`に載っているファイルを変えると、再起動まで読み取りと検索以外の`remote_task`を`REMOTE_SOURCE_CHANGED_RESTART_REQUIRED`で拒否します。

## コード

実行経路は1つに保ち、失敗を明示的に報告し、変更を絞ってください。
要求の重複排除、結果が不明な実行の保持、プロセスの同一性確認、ロックを解放する前の監査記録の書き込み、資格情報の除去を維持してください。
テストは内部構造ではなく、利用者に関係する動作と重要な失敗の境界を確認してください。
具体的な必要がない限り新しい依存関係と抽象化を避け、追加または更新するときはライセンスを確認してください。

`ui/settings.mjs`または`ui/settings.html`を変更したら、`npm run build:settings-ui`を実行して`src/mcp/settings-app.html`を再生成し、結果をコミットしてください。
生成されるファイルは依存関係のコードを含むため、[依存関係のライセンス通知](../../THIRD_PARTY_NOTICES.md)も確認してください。

## Pull request

Pull requestのテンプレートには、この確認項目が入っています。
不具合報告のフォームでは、コミット、プラットフォーム、コマンド、再現手順、診断コードを入力します。

- 問題と変更後の動作を書き、差分をその範囲に収めてください。
- 所有する文書を更新し、記述が変わる場合は両方のREADMEも更新してください。
- 実行した確認、そのプラットフォーム、実行できなかったことを列挙してください。
- 予期しないファイルの変更や失敗したテストに触れてください。
- 秘密情報と実際のタスクストアの記録を差分と説明に含めないでください。
- 依存関係が変わるときは[依存関係のライセンス通知](../../THIRD_PARTY_NOTICES.md)を更新してください。

## ライセンス

貢献すると、その貢献がプロジェクトの[MIT License](../../LICENSE)でライセンスされることに同意したものとみなされます。
依存関係はそれぞれのライセンスを維持します。
