[English](../en/operations.md) | 日本語

<a id="thriftyrelay-operations"></a>
# ThriftyRelayの運用

コマンドは、ThriftyRelayをインストールしたユーザーで、同じタスクストアを使って実行します。
初回のインストールとdoctorのチェック表は[セットアップ](setup.md)を参照してください。

<a id="daily-lifecycle"></a>
## 日常の操作

目的に合うコマンドを選んで実行します。
停止や再起動の前に、実行中のタスク、結果不明のタスク、実行ロックを確認してください。
Codexジョブのキャンセルは、ThriftyRelayの停止とは別の操作です。

| 操作 | コマンド |
| --- | --- |
| 起動 | `thriftyrelay start` |
| 稼働状態の概要 | `thriftyrelay status` |
| 詳細な確認結果と集計 | `thriftyrelay doctor` |
| 詳細をJSONで取得 | `thriftyrelay status --json`または`thriftyrelay doctor --json` |
| 停止 | `thriftyrelay stop` |
| 保存済みの方式で再起動 | `thriftyrelay restart` |

診断は読み取り専用で、WARNだけなら終了コードは0です。
タスクストアの書き込みを保護したWindowsの再起動には、[Windows MCPの制御](#windows-mcp-control)を使ってください。

<a id="windows-task-mode"></a>
### Windowsのタスクモード

- `start`は`ThriftyRelay MCP`と保存済みランチャーを使います。
- `stop`はタスクと、所有権を確認したトンネルの待ち受けプロセスツリーを止めます。
- `restart`はそれらを停止してから、タスクを起動します。

<a id="windows-foreground-mode"></a>
### Windowsのフォアグラウンドモード

- `start`は起動したターミナルで動きます。
- 停止するときは、そのターミナルでCtrl+Cを押します。
- 別のターミナルの`stop`や`restart`は所有権を取得できません。
- ターミナルを閉じると子孫プロセスが残る場合があります。

<a id="linux-and-macos-manual-mode"></a>
### LinuxとmacOSのマニュアルモード

- `start`はバックグラウンドで起動し、`start --foreground`は同じターミナルで動きます。
- `stop`と`restart`は記録済みの所有するプロセスグループを使い、別のターミナルで起動したものも止めます。
- `restart --foreground`は記録済みのThriftyRelayを止め、同じターミナルに起動し直します。
- 起動中または稼働中のものがあれば、その状態を報告して重複起動を防ぎます。
- バックグラウンド実行はターミナルを閉じても続きます。
  ログアウトや再起動では止まる場合があります。
- setupはsystemdやlaunchdの設定を追加しません。

<a id="windows-mcp-control"></a>
## Windows MCPの制御

実行中の作業が終わり、再起動が承認されてから進めます。

~~~powershell
thriftyrelay mcp check
thriftyrelay mcp restart
thriftyrelay mcp check
~~~

1. `mcp:check`でローカルの状態を読み取り専用で確認します。
2. 確認に成功したら`mcp:restart`を実行します。
3. もう一度`mcp:check`でタスクとプロセスを確認します。

次の状態では再起動を拒否します。

- 実行中または結果不明の実行
- メンテナンスロック
- スコープ付きリースやブリッジ
- ロックされた受付ゲート
- スコープ付きレジストリの証拠を取得できない

ロックは残し、監査が必要な結果不明の実行には[復旧](recovery.md)を使ってください。

コントローラーは、次の項目を検証します。

- スケジュールタスクのアクション
- ランチャー
- トンネル
- MCP
- Desktop Commander
- 親子関係
- プロセスの起動ID
- ポート8080の待ち受けプロセス

破壊的な操作の前にIDを再確認してPID再利用のリスクを減らし、起動後には安定した管理状態を確認します。
孤立プロセスの後片付けは、特定済みの管理対象プロセスに限定されます。
追加の`node`、`codex`、コンソールのプロセスは管理対象外です。
失敗としても扱わず、自動停止もしません。

`MCP_PROCESS_IDENTITY_UNAVAILABLE`は、実行ファイルやコマンドのハッシュが欠けていることを示します。
この場合は破壊的な操作を中止してください。
インストール環境が要求する場合は、管理者としてPowerShellを明示的に開き、読み取り専用のチェックを繰り返します。
自動的な昇格、チェックの迂回、コマンドラインの露出、未分類プロセスの終了は行わないでください。
最高権限で登録されたタスクを非昇格のまま操作する方法は、まだ検証されていません。

<a id="powershell-requests"></a>
### PowerShellリクエスト

コントローラーは、チェックや再起動の呼び出しごとに1つのWindows PowerShell 5.1プロセスを使い、その標準入力からフレーム形式のリクエストを送ります。
リクエストの送信が失敗した場合や接続が切れた場合、副作用が不明なときは自動的に再送しません。

<a id="state-and-logs"></a>
## 状態とログ

| 項目 | Windows | Linux | macOS |
| --- | --- | --- | --- |
| 設定 | `%APPDATA%\ThriftyRelay\config.json` | `${XDG_CONFIG_HOME:-$HOME/.config}/ThriftyRelay/config.json` | `~/Library/Application Support/ThriftyRelay/config.json` |
| デフォルトのタスクストア | `%LOCALAPPDATA%\ThriftyRelay\tasks` | `${XDG_STATE_HOME:-~/.local/state}/thriftyrelay/tasks` | `~/Library/Application Support/ThriftyRelay/tasks` |
| 一時作業領域 | `%LOCALAPPDATA%\ThriftyRelay\temp` | `${XDG_CACHE_HOME:-$HOME/.cache}/thriftyrelay/temp` | `~/Library/Caches/ThriftyRelay/temp` |
| ランチャー | `%LOCALAPPDATA%\ThriftyRelay\Start-ThriftyRelay.ps1` | なし。手動起動のThriftyRelay | なし。手動起動のThriftyRelay |
| タスクのランチャーログ | `%LOCALAPPDATA%\ThriftyRelay\logs\remote.log` | 該当なし | 該当なし |
| 稼働状態の保存ディレクトリ | POSIXスーパーバイザーの状態なし | `${XDG_STATE_HOME:-$HOME/.local/state}/thriftyrelay` | `~/Library/Application Support/ThriftyRelay` |

Linuxが`XDG_STATE_HOME`を尊重するのは、それが絶対パスの場合だけです。
それ以外は`$HOME/.local/state`を使います。

<a id="posix-runtime-state"></a>
### POSIXの稼働状態

POSIXのディレクトリには`runtime.json`、短命な`runtime.lock`、バックグラウンド用の`runtime.log`が入ります。
`runtime.lock`には再取得ガードが付くことがあります。
`runtime.log`はデフォルトで5 MiBに達すると`runtime.log.1`へローテーションします。

フォアグラウンドの出力はそのターミナル内にとどまります。
フォアグラウンドの状態レコードが標準のログパスを示すことはあります。
フォアグラウンドのログファイルは、そのレコードとは別です。

ディレクトリと状態の検証では、所有権、アクセス権、ファイル種別、パスの同一性を確認します。
拒否を回避するために状態を手動で置き換えたり、アクセス権を広げたりしないでください。

<a id="task-store"></a>
### タスクストア

タスクストアは稼働状態とは別です。
場所はThriftyRelayの`THRIFTYRELAY_TASK_DIR`から決まります。
セットアップは`taskDirectory`を保存し、起動したMCPプロセスに渡します。

タスクストアには、タスクレコード、`active.lock`と`maintenance.lock`、スコープ付きレジストリの状態、`codex/requests`の重複防止記録、会話、`codex/reviews`、`codex/recovery`の監査記録が入ります。
これらのレコードはまとめて保持してください。
空のタスクストアに置き換えると、新しい重複排除スコープになります。
永続化と保持の詳細は[アーキテクチャ](architecture.md)を参照してください。

<a id="temporary-work-area"></a>
### 一時作業領域

タスクストアと作業ディレクトリとは別の領域です。
場所は`THRIFTYRELAY_TEMP_WORKSPACE`、保存済みの`tempWorkspace`、OSのデフォルトの順で決まります。

`scratch: true`のタスクは、自身のIDを名前にしたサブディレクトリを使います。
成功時は削除し、失敗時は[一時データの保持規則](admission.md#scratch-retention)に従って残します。
`scratch_roots`の登録や保持データの削除前に、[受付](admission.md#temporary-work-area-and-scratch_roots)を確認してください。

<a id="uninstall"></a>
## アンインストール

削除対象をプレビューで確認してから、削除を実行します。

~~~sh
thriftyrelay uninstall --dry-run
thriftyrelay uninstall
~~~

ThriftyRelayを停止できない場合や、その所有権を確認できない場合、コマンドは続行を拒否します。
記録済みのThriftyRelayがまだ実行中の可能性がある間は、設定や資格情報を削除しません。
計画を確認したうえでの非対話実行には`--yes`を使ってください。

| 削除されるもの | 保持されるもの |
| --- | --- |
| 実行中のThriftyRelayと、POSIXの状態ファイルおよびログファイル。 | タスクストアと、そのリクエスト、ロック、復旧、会話のレコード。 |
| `ThriftyRelay MCP`のWindowsタスク。 | Codexの認証とセッション。上書きされた`CODEX_HOME`も含みます。 |
| Windowsの資格情報マネージャー、Linux Secret Service、macOSキーチェーンにあるトンネル用APIキー。 | 管理者が登録した受付ポリシー。登録がある場合のみ。 |
| `config.json`、ランチャー、そのログ、空の製品所有ディレクトリ。 | 無関係なツールと、その資格情報。 |
| | 一時作業領域と、保持されている一時データ。 |
| | 共有親ディレクトリ内の無関係なファイル。 |

| 失敗と状態 | 次の操作 |
| --- | --- |
| 資格情報ストアの失敗 | 報告された原因を解決します。設定の削除はまだ始まっていません。 |
| `UNINSTALL_INCOMPLETE` | ファイル削除の失敗を調べます。一部の削除は済んでいる場合があります。 |
| POSIXの`UNINSTALL_RUNTIME_REPLACED` | 新しく起動したThriftyRelayを確認します。その状態とキーは保持されます。 |
| Windowsタスクは停止中だが`/readyz`は応答する | 先に`thriftyrelay stop`を実行します。実行中のタスクに結び付けられないポート所有者は、アンインストールでは終了できません。 |

報告された原因を解決してから再実行してください。
タスクストアと受付ポリシーの削除には、別にレビューした操作を使います。

<a id="environment-variables"></a>
## 環境変数

| ThriftyRelayの入力 | 目的 |
| --- | --- |
| `THRIFTYRELAY_TASK_DIR` | 参加する書き込み側が共有するタスクストア。 |
| `THRIFTYRELAY_TEMP_WORKSPACE` | 一時作業の正確なルート。保存された`tempWorkspace`とプラットフォームのデフォルトより優先されます。 |
| `THRIFTYRELAY_TEMP_DIR` | `THRIFTYRELAY_TEMP_WORKSPACE`と`tempWorkspace`が未設定の場合に、プラットフォームのデフォルトを上書きします。 |
| `THRIFTYRELAY_CODEX_WORKSPACE` | Codexの受付で許可する作業ディレクトリ。実体パスの完全一致が必要です。存在しない場合はCodexへの委任が無効になります。 |
| `CODEX_HOME` | 上書きされている場合の、既存のCodex認証とセッションの場所。 |
| `THRIFTYRELAY_RUNTIME_KEY` | 一時的な資格情報ソースの上書き。[キーの扱い](setup.md#temporary-runtime-key)を参照してください。 |
| `THRIFTYRELAY_TEST_ROOT` | 実タスクストアとは別の、テスト成果物専用の絶対パス領域。 |

<a id="display-language"></a>
## 表示言語

言語の確認には`thriftyrelay lang`を使います。
保存には`thriftyrelay lang ja`または`thriftyrelay lang en`を使います。
`--lang ja`と`--lang en`は、CLI、MCP制御、ガイド付き復旧コマンドの表示言語を上書きします。
言語の解決順は、明示的な上書き、保存値、OSロケール、英語です。

<a id="update-and-restart-cautions"></a>
<a id="updates-and-restarts"></a>
## 更新と再起動

このチェックアウトは実MCPの起動元でもあります。
既存のプロセスには読み込み済みのコードが残り、新しいワーカーは変更したファイルをすぐに読む場合があります。

1. ソースや依存関係を変更する前に、作業を完了するか安全にキャンセルし、保持された結果不明の記録を確認します。
2. クローンで`git pull`を実行してから`npm ci`を実行します。
   リンクした`thriftyrelay`コマンドは、入れ直さなくても更新後の内容で動きます。
3. 差分、ソースと依存関係のバージョン、対象を絞った検証結果を確認します。
4. デプロイ後に再起動します。
   Windowsでは、該当する場合に[Windows MCPの制御](#windows-mcp-control)を使います。
5. ホストを再接続するか、ツール定義を更新します。
6. ChatGPTから`health`を呼び、意図したタスクとカードの動作を確認します。

同じタスクストアで動かす実装バージョンは1つに揃えてください。
起動後にハッシュ対象のソースが変わると、`health`は`source=changed-restart-required`を返し、書き込む可能性のある依頼を拒否します。
文書はソースハッシュの対象外なので、再起動は不要です。

<a id="troubleshooting"></a>
## トラブルシューティング

| 観測 | 意味と次の操作 |
| --- | --- |
| `STOPPED_IDLE` | 意図的なマニュアルまたはフォアグラウンドの停止、あるいは待機中のオンデマンドタスクです。必要になったら起動してください。 |
| `LOCAL_ENDPOINT_UNVERIFIED` | ループバックのエンドポイントが応答しましたが、ThriftyRelay所有者との結び付きが十分ではありません。Windowsでは保護付きのチェックを使ってください。HTTPだけで所有権を推測しないでください。 |
| `LOCAL_RUNTIME_STOPPED` | 設定されたログオンタスクのThriftyRelayが停止しています。タスクとランチャーのログを確認してください。 |
| `LOCAL_ENDPOINT_IN_USE` | ポート8080が使用されています。所有者を特定してください。ポート番号だけでプロセスを終了しないでください。 |
| `RUNTIME_DEPENDENCY_MISSING` | 起動時の所有権証明には、Linuxでは`ss`、macOSでは`lsof`のインストールまたは復元が必要です。記録済みグループの停止は、これらがなくても動作することがあります。 |
| `RUNTIME_OWNER_MISMATCH`、`RUNTIME_OWNER_UNKNOWN` | プロセスや待ち受けプロセスの所有権が一致しない、または確立できません。状態を保持して調査し、置き換わったプロセスにシグナルを送らないでください。 |
| `RUNTIME_STATE_STALE`、`RUNTIME_FAILED` | 記録された状態が観測と競合しているか、起動に失敗しています。再試行の前に、保存されたエラーとバックグラウンドのログを確認してください。 |
| `RUNTIME_STATE_INSECURE` | 状態のパス、所有者、アクセス権、ファイル種別の検証に失敗しました。意図したユーザーのパスを確認し、検証を迂回しないでください。 |
| `CREDENTIAL_BACKEND_UNAVAILABLE` | セットアップがPOSIXのストアを使えません。セッションのバックエンドを復元するか、意図的に一時的なキーソースを使ってください。平文の代替保存は行いません。 |
| `CREDENTIAL_BACKEND_ERROR`、`CREDENTIAL_UNCONFIGURED` | doctorが資格情報ソースを問い合わせできないか、キーが存在しません。意図したユーザーとセッションで実行し、資格情報のセットアップをやり直してください。 |
| `CONFIG_MODE_INVALID` | Windowsでは`manual`を使えません。POSIXでは`manual`が必須です。実行中の作業を確認したうえで再設定してください。 |
| `POLICY_UNREGISTERED` | WARNです。管理者による登録がないため、受付の強制が無効です。[受付](admission.md)を参照してください。 |
| `POLICY_UNVERIFIED` | WARNです。ポリシーの検証に失敗しました。サーバーは未登録として扱わず、受付をブロックします。登録されたポリシーを調査してください。 |
| `MCP_PROCESS_IDENTITY_UNAVAILABLE` | 再起動を中断します。管理者としてPowerShellを開き、`thriftyrelay mcp check`を再実行してください。 |
| 結果不明の実行、または保持されたスコープ付きリース | 状態を保持し、[復旧](recovery.md)に従ってください。 |
| `CODEX_CHATGPT_AUTH_REQUIRED` | アダプターがファイルベースで要求するChatGPT認証の条件が満たされていません。セットアップの確認は認証テストではありません。 |
| `CODEX_QUOTA_APPROVAL_REQUIRED`、`CODEX_QUOTA_BLOCKED`、`CODEX_QUOTA_UNAVAILABLE` | [設定](settings.md#quota-thresholds)の承認、ブロック、利用不可に関する、それぞれ別の規則に従ってください。 |
| ホストがまだ古いツールを表示する | 承認された再起動と、ホストの再接続またはスキーマ更新を確認してください。ローカルの準備完了だけでは、既存の会話は更新されません。 |

結果不明の実行や保持されたスコープ付きリースがある場合は、次の操作を行わないでください。

- 書き込みの再実行
- ロックの削除
- 未解決の状態を迂回するための再起動

セキュリティに関わる報告には、キー、タスクレコード、生のプロセスデータを投稿するのではなく、[セキュリティポリシー](security.md)を使ってください。
