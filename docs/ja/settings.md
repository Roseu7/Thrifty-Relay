[English](../en/settings.md) | 日本語

<a id="settings-reference"></a>
# 設定リファレンス

[ターミナルの編集画面](#terminal-tui)、[CLIコマンド](#non-interactive-commands)、ChatGPTから開く[設定ビュー](#optional-mcp-apps-view)でユーザー設定を変更します。
セットアップ、資格情報、パス、受付ポリシーの登録、復旧は別の操作です。

設定は、資格情報を含まない1つの[設定ファイル](operations.md#state-and-logs)に保存します。
setupも同じファイルに`tempWorkspace`を保存しますが、設定UIではこのパスを変更できません。
定義は[src/config.mjs](../../src/config.mjs)と[src/cli/settings.mjs](../../src/cli/settings.mjs)にあります。

<a id="saved-values"></a>
## 保存される値

| フィールド | 指定できる値 | デフォルトまたは初期の動作 |
| --- | --- | --- |
| `language` | `ja`、`en` | 未設定時はOSロケールを使い、解決できない場合は `en` です。 |
| `baseModel` | 下の表にあるモデルと推論の強さの組 | `gpt-6-luna/max` |
| `upperModel` | 対応する組、または `disabled` | `gpt-6.1-sol/medium` |
| `maxCodexAgents` | 1〜5の整数 | 3 |
| `reviewPolicy` | `conditional`、`always`、`manual` | `conditional` |
| `fiveHourLimitPercent` | 0〜100の整数 | 10 |
| `weeklyLimitPercent` | 0〜100の整数 | 10 |
| `fiveHourLimitAction` | `warn`、`block` | `warn` |
| `weeklyLimitAction` | `warn`、`block` | `warn` |

対応するモデルと推論の強さの組は次のとおりです。

| モデル | 推論の強さ |
| --- | --- |
| `gpt-6-luna` | `medium`、`high`、`max` |
| `gpt-6.1-sol` | `medium`、`high` |
| `gpt-6.1-terra` | `medium`、`high`、`xhigh`、`max` |

古い設定ファイルに項目がない場合はデフォルトが使われ、読み取り時にファイルは書き換えられません。
上位モデルのデフォルトが変わっても、明示的に保存された `gpt-6.1-sol/high` は選ばれたままです。
保存は設定をアトミックに更新し、無関係な資格情報を含まないフィールドを保持します。
不正な値と未知の設定キーは拒否されます。

<a id="terminal-tui"></a>
## ターミナルTUI

~~~sh
thriftyrelay settings
~~~

ターミナルの入力と出力が必要です。

| 操作 | キー |
| --- | --- |
| 項目と選択肢の移動 | ↑/↓ |
| 選択肢を開く、値を保存 | Enter |
| 保存せずに戻る | Esc |
| メイン画面から終了 | Escまたは`q` |
| しきい値の編集 | 0〜100の整数を入力。Ctrl+Uで入力を消去。 |

- 推奨値は現在の値と異なる場合だけ括弧で表示します。
  言語には推奨値を表示しません。
- レビューとしきい値動作の説明は編集画面に表示します。
- 数値のエラーは入力欄の下に表示し、次のキー入力で消えます。

ANSIに対応していないターミナルでは、番号メニューを使います。
項目の番号を選び、選択肢またはパーセントの数値を入力します。
数値を入力せずにEnterを押すと、項目のメニューへ戻ります。

<a id="non-interactive-commands"></a>
## 非対話コマンド

~~~sh
thriftyrelay settings show
thriftyrelay settings show --json
thriftyrelay settings set maxCodexAgents 3
thriftyrelay settings set fiveHourLimitPercent 25
thriftyrelay settings set weeklyLimitPercent 10
thriftyrelay settings set fiveHourLimitAction warn
thriftyrelay settings set weeklyLimitAction block
~~~

`set` コマンドが受け付けるのは `maxCodexAgents` と、上に示した利用枠のフィールド名だけです。
`baseModel`、`upperModel`、`reviewPolicy` にここで使える設定コマンドはありません。
これらのフィールドにはTUIまたは設定ビューを使ってください。
言語は `thriftyrelay lang ja` または `thriftyrelay lang en` で保存します。
利用枠のパーセントは、パーセント記号も先頭のゼロも付けない0から100までの10進整数です。

`settings show --json` は、ロケールに依存しない `settings`、`sources`、`recommended`、`options` を返します。
パーセントの選択肢は `{ "min": 0, "max": 100, "step": 1 }` です。
MCPの設定ビューは、ローカライズされたラベルと選択肢のデータを受け取ります。

`--lang ja` または `--lang en` は、保存せずにコマンドの表示言語を選びます。
通常の言語解決順は、明示的な上書き、保存された言語、OSロケール、英語です。
`settings show` は、保存された言語がない場合の解決を表示の上書きとは独立に行います。
翻訳された見出しは表示言語だけを反映し、保存言語は変わりません。

<a id="quota-thresholds"></a>
## 利用枠のしきい値

新しいCodexリクエストは、タスクの予約前に5時間枠と週間枠の両方を読み取ります。
しきい値以下になると設定した動作が適用され、両方の枠が該当した場合は停止が優先されます。
承認された警告の再試行は、実行開始の直前に両方の枠を再度読み取ります。

| 結果 | コード | 必要な操作 |
| --- | --- | --- |
| `warn` のしきい値に達した | `CODEX_QUOTA_APPROVAL_REQUIRED` | 5時間枠と週間枠の残量、しきい値、リセット時刻を示し、利用者の明示的な承認を得てください。ワーカーはまだ起動していません。 |
| `block` のしきい値に達した | `CODEX_QUOTA_BLOCKED` | 自動的に実行も再試行もしないでください。承認でblockを上書きすることはできません。 |
| どちらかの枠が利用できない | `CODEX_QUOTA_UNAVAILABLE` | 設定された動作に関係なく、自動的に実行も再試行もしないでください。 |
| 利用枠の設定を読み取れない | `CODEX_QUOTA_CONFIG_UNAVAILABLE` | 設定の読み取りエラーを解消してから、新しい依頼を送ってください。 |

警告のあとに続行する手順は次のとおりです。

1. 利用者から明示的な承認を得ます。
2. 同じ`request_id`と、変更していないタスクの意図を再送します。
3. `quota_warning_approved=true`と、発行された`quota_approval_token`だけを追加します。

トークンはその意図とリクエストIDに結び付きます。
プロンプト、レポート、ログには含めないでください。
保存される承認フラグは、ChatGPTが利用者の同意を確認したという記録です。
しきい値を0%にしても、残量0%では発動します。

利用枠はプラン上限のスナップショットで、SDKのトークン使用量やAPIの課金とは別です。
完了後の利用枠は別に取得するため、そのデータが欠けてもタスクは完了のままです。
結果の証拠は[アーキテクチャ](architecture.md)、承認と再試行の流れは[作業依頼](orchestration.md)を参照してください。

<a id="optional-mcp-apps-view"></a>
## 任意のMCP Appsビュー

設定を開くか表示するようChatGPTに明示的に依頼すると、ChatGPTは `open_settings` を呼び出せます。
対応するホストは `ui://thriftyrelay/settings-v2.html` を読み込みます。
それ以外のホストは、同じ設定を読めるテキストとして受け取り、ターミナルコマンドで編集できます。
通常の `health`、`remote_task`、`remote_inspect` の呼び出しでは、このビューは開きません。

このビューはMCP Appsブリッジを使って、アプリ専用の `settings_update` に変更を送信します。
受け付けるのは設定フィールドだけで、ペイロードに資格情報、起動設定、トンネル設定、ファイルシステムのパス、システム管理、ロックの復旧は含まれません。
ブラウザのローカルストレージには設定を保存しません。
描画と実際の操作はホストに依存します。
承認されたソースのデプロイ後は、[運用](operations.md#update-and-restart-cautions)に記載されたガード付きの再起動とホストのスキーマ更新を使ってください。

<a id="what-settings-control"></a>
## 設定が制御する範囲

`baseModel` と `upperModel` は、ChatGPTが指定できる2つの役割で使うモデルと推論の強さを決めます。
普段の作業は `base`、切り替えが必要なときは `upper` です。
設定は依頼を受け付けたときに読むので、変更は次の依頼から反映され、実行中のタスクには影響しません。
役割を指定しない新しいCodexの会話は基本モデルを使い、継続ではその会話が最後に使ったモデルと推論の強さを引き継ぎます。
`upperModel=disabled` のときは、上位モデルの依頼を `CODEX_UPPER_MODEL_DISABLED` で拒否します。

`reviewPolicy` はChatGPTへの指針です。
`conditional` はタスクに応じてレビューし、`always` は完了したコード変更のレビューを求め、`manual` は依頼されたときだけレビューを求めます。

`maxCodexAgents` は、共有タスクストアで新たに受け付ける明示的なスコープ付きリースの数を制限します。
変更しても既存のリースは終了しません。
`write_scopes` を省略した場合は従来のグローバル排他が維持され、`expected_files` は受付を許可しません。
書き込みスコープは宣言であり、OSのサンドボックスではありません。
スコープ付き並行実行のライブ展開は、独立した統合テストが済むまでブロックされたままです。
完全な契約は[受付](admission.md)、保持された結果不明のリースは[復旧](recovery.md)を参照してください。
