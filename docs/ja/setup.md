[English](../en/setup.md) | 日本語

<a id="thriftyrelay-setup"></a>
# ThriftyRelayのセットアップ

Codexに作業させたいディレクトリで、対話できるターミナルからsetupを実行します。
設定を保存し、選んだ起動方式を準備します。

Windowsで導入済みの場合は、先に[実行中の作業を確認](operations.md#update-and-restart-cautions)してください。
setupはランチャーとタスク定義を置き換え、実行中のタスクを止める場合があります。

- [準備](#prerequisites)
- [プラットフォームごとの確認状況](#platform-status)
- [Windowsでのセットアップ](#windows-setup)
- [LinuxとmacOSでのセットアップ](#linux-and-macos-setup)
- [ChatGPTへの接続](#chatgpt-connection)
- [成功の条件](#success-criteria)
- [doctorリファレンス](#doctor-reference)

<a id="prerequisites"></a>
## 準備

Windows、Linux、macOSでNode.js 22以降、npm、Gitを使います。
リポジトリをクローンして依存関係をインストールし、`thriftyrelay`コマンドをリンクします。

~~~sh
git clone https://github.com/Roseu7/Thrifty-Relay.git
cd Thrifty-Relay
npm ci
npm install -g .
~~~

`npm ci`はThriftyRelayをいちばん上のプロジェクトとしてインストールするので、`package.json`の依存関係の上書き指定が効きます。
GitHubのURLやnpmレジストリから直接インストールすると、この指定が効かず、既知の脆弱性がある依存関係の版が入ります。
`npm install -g .`はコマンドをクローンにリンクし、ThriftyRelayは常にクローンから動きます。
クローンは移動しないでください。
npmが`thrifty-relay`のインストールスクリプトを許可していないと警告することがありますが、`npm ci`ですでに実行済みです。
npmのグローバルディレクトリに管理者権限が必要な環境でも、権限が要るのはリンクの手順だけです。
ThriftyRelay自体はrootでは起動しません。

setupの前に、次の項目を用意します。

| 項目 | 用意するもの |
| --- | --- |
| Codexのサインイン | ChatGPTアカウントでCodex CLIにサインインします。[認証の条件](#codex-authentication)も確認してください。 |
| トンネルIDとAPIキー | [トンネル設定](https://platform.openai.com/settings/organization/tunnels)で作成し、そのトンネルへのアクセスをキーに許可します。 |
| トンネル実行ファイル | [tunnel-clientのリリース](https://github.com/openai/tunnel-client/releases)から対応する実行ファイルを入手します。 |
| ChatGPTのワークスペース | カスタムMCPサーバーを追加できる権限を持つChatGPTのWeb版を使います。[ChatGPTへの接続](#chatgpt-connection)を参照してください。 |
| 作業ディレクトリ | 存在する専用ディレクトリの絶対パスを指定します。ファイルシステムのルートとホーム全体は拒否されます。 |
| 一時作業領域 | 別の絶対パスを選ぶか、OSのデフォルトを使います。[一時作業領域](#temporary-work-area)を参照してください。 |

setupはCodexへのサインイン済みかを質問します。
ログインの実行とモデル利用権の確認は対象外です。
必要に応じてトンネル設定とリリースへのリンクを表示するので、トンネルの作成と実行ファイルの入手は別に済ませてください。

<a id="setup-input"></a>
### 入力項目

| 質問 | 入力 |
| --- | --- |
| 表示言語 | `ja`または`en`。 |
| パス | 絶対パス。Enterで表示されたデフォルトを使い、無効なパスはその場で再入力します。 |
| トンネルID | 保存済みのIDがある場合だけ、中間部分を隠してデフォルトを表示します。初回はデフォルトなしです。 |
| はい/いいえ | `y`、`n`、`yes`、`no`を入力します。大文字と小文字は区別せず、デフォルトはありません。 |
| トンネル用APIキー | 非表示の入力欄に入力するか、保存済みのキーの再利用を選びます。 |

Ctrl+Cでsetupをキャンセルできます。

- 進行中の保存や登録が完了してから中止し、次の手順には進みません。
- 保存済みの設定と登録は保持します。
  既存のインストールも残ります。
- このsetupがWindowsタスクを起動した場合は停止を確認し、確認できなければエラーを報告します。

<a id="platform-status"></a>
## プラットフォームごとの確認状況

| プラットフォーム | 起動方式 | CIで確認していること | まだ確認していないこと |
| --- | --- | --- | --- |
| Windows | ログオン時のタスク、手動起動のタスク、foreground | PowerShellを使うものを含む、すべてのオフラインテスト | foregroundのターミナルを閉じたときの後始末と、最上位の権限で動くタスクを管理者権限なしで操作すること |
| Linux | 手動の`start`で、バックグラウンドかforeground | オフラインテスト、ランタイムの統合テスト、実際のSecret Service | [既知の制限](security.md#linux-and-macos)に書いてあること以外はありません |
| macOS | 手動の`start`で、バックグラウンドかforeground | オフラインテストと、POSIXのランタイム状態のテスト | キーチェーンの動作と、実機のMacでの実行 |

CIはChatGPTに接続せず、実際のモデルも使いません。
各テストが確認する内容は[貢献ガイド](contributing.md)にあります。

<a id="windows-setup"></a>
## Windowsでのセットアップ

このチェックアウトから実行します。

~~~powershell
thriftyrelay setup
~~~

1. [入力項目](#setup-input)にある値を入力します。
2. Windowsログオン時に起動するかを選びます。
   起動しない場合は、手動起動用タスクを登録するかを選びます。
3. タスクを使う場合はUACを承認し、ローカルの起動確認を待ちます。

| モード | 起動と寿命 | setupの終わり方 |
| --- | --- | --- |
| `on-login-task` | Windowsのログオンタスクが、ログオン時にそのユーザー向けにThriftyRelayを起動します。 | タスクを起動し、準備完了のチェック後に戻ります。 |
| `on-demand-task` | タスクにログオントリガーはなく、明示的に起動します。 | タスクを起動し、準備完了のチェック後に戻ります。 |
| `foreground` | タスクを登録せずに、setup/startのターミナルで実行します。 | 起動を報告し、アタッチしたままになります。 |

| タスクの設定 | 値 |
| --- | --- |
| 名前 | `ThriftyRelay MCP` |
| ランチャー | `%LOCALAPPDATA%\ThriftyRelay\Start-ThriftyRelay.ps1` |
| 登録 | UACの承認1回。`InteractiveToken`と`HighestAvailable`を使います。 |
| ウィンドウ | 非表示のPowerShell。[状態とログ](operations.md#state-and-logs)で確認します。 |
| APIキーの保存先 | Windows資格情報マネージャー。 |

Windowsでは`mode: "manual"`を使えません。
フォアグラウンドでは、起動したターミナルでCtrl+Cを押して停止してください。
別のターミナルの`stop`は所有権を取得できず、ターミナルを閉じたあとの子孫プロセスのクリーンアップは未確認です。

<a id="linux-and-macos-setup"></a>
## LinuxとmacOSでのセットアップ

想定する非rootユーザーとして実行します。

~~~sh
thriftyrelay setup
~~~

[入力項目](#setup-input)にある値を入力します。
setupは`mode: "manual"`、`taskDirectory`、`tempWorkspace`を保存し、起動は別の操作になります。
POSIXで使えるモードは`manual`だけで、systemdやlaunchdの設定は追加しません。

| OS | APIキーの保存先 | 起動に必要なコマンド |
| --- | --- | --- |
| Linux | D-BusのSecret Serviceと利用可能なキーリングに接続できる`secret-tool`。 | `ss` |
| macOS | `/usr/bin/security`とログインキーチェーン。 | `lsof` |

資格情報の保存に失敗すると、setupは設定を保持し、`CREDENTIAL_BACKEND_UNAVAILABLE`などの原因を報告します。
平文のキーは保存せず、doctorでは保存先のエラーを`CREDENTIAL_BACKEND_ERROR`として表示します。

資格情報を利用できる状態にしてから起動します。

~~~sh
thriftyrelay start
~~~

デフォルトでは、`start`は切り離されたバックグラウンドのスーパーバイザーを起動し、起動が成功した時点で戻ります。
ThriftyRelayをこのターミナルに置く場合は、次のコマンドを使います。

~~~sh
thriftyrelay start --foreground
~~~

- `ss`または`lsof`がないと`RUNTIME_DEPENDENCY_MISSING`になります。
  停止は、ほかの所有権チェックを通れば記録済みのプロセスグループを使えます。
- UID 0での実行は`RUNTIME_AS_ROOT`になります。
- バックグラウンド実行はターミナルを閉じても続きます。
  ログアウトや再起動では止まる場合があります。
- キーチェーンの動作とMac実機での実行は未確認です。

<a id="temporary-runtime-key"></a>
<a id="temporary-tunnel-api-key"></a>
### 一時的なトンネル用APIキー

資格情報バックエンドが使えない場合、運用者のシークレットマネージャーまたは非表示のターミナル入力から、1回の実行に限り`THRIFTYRELAY_RUNTIME_KEY`を渡せます。
プラットフォームの資格情報アダプターは、空でないこの環境変数の値をOSのストアより優先し、永続化しません。
呼び出し側の環境から後で削除してください。
リテラルのキーをシェルの履歴、スクリプト、設定ファイル、リポジトリに書かないでください。
Windowsのスケジュールタスクは保存済みの資格情報マネージャーのエントリを読むため、呼び出し元シェルの一時的な値はタスクの資格情報設定の代わりになりません。

トンネルは子プロセスの環境で`CONTROL_PLANE_API_KEY`としてキーを受け取ります。
設定済みの`scripts/sanitized-mcp.mjs`ブートストラップは、MCPのエントリポイントを読み込む前に、トンネル用APIキーの上書きとトンネルの資格情報を削除します。
ThriftyRelayはキーを設定やトンネルのコマンド引数に入れません。
macOSのキーチェーンへの書き込みでは、`security`コマンドの引数にキーを渡します。
書き込み中は、同じユーザーの別プロセスからこの引数を読み取られる場合があります。
同じユーザーで動くプロセスは、初期環境や資格情報ストアを検査できる場合があります。
この扱いは偶発的な継承を減らしますが、OSのセキュリティ境界ではありません。

<a id="start-stop-restart-and-check"></a>
## 起動、停止、再起動、確認

日常のコマンドとOSごとの動作は、[運用のコマンド表](operations.md#daily-lifecycle)を使ってください。
`--foreground`を受け付けるのはPOSIXの`start`と`restart`だけです。
稼働中のWindows MCPには[Windows MCPの制御](operations.md#windows-mcp-control)を使い、書き込みロックを保護した`mcp:restart`で再起動します。

<a id="chatgpt-connection"></a>
## ChatGPTへの接続

ChatGPTは、OpenAIの[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)を通じて、PC上のThriftyRelayに接続します。
ローカルの`tunnel-client`が外向きのHTTPS接続で要求を取得してMCPサーバーへ渡すため、サーバーは非公開のまま使えます。
ChatGPTのWeb版から、ThriftyRelayをカスタムMCPサーバーとして登録します。
検出とツール呼び出しの間は、ThriftyRelayと`tunnel-client`を動かしたままにします。

1. [ChatGPTのPlugins](https://chatgpt.com/plugins)を開きます。
2. プラスボタンを選び、**Add custom MCP server**を選びます。
3. 名前を`ThriftyRelay`にし、必要なら短い説明を入れます。
4. **Connection**で**Tunnel**を選び、トンネルを選択するか`tunnel_id`を入力します。
5. **No authentication**を選びます。
6. リスク警告を確認し、**I understand and want to continue**を選んでから、**Create as a plugin**を選びます。
7. 検出されたツールとメタデータを確認し、プラグインをインストールして新しい会話を始めます。
8. プロンプト欄で`@`を入力して`ThriftyRelay`を選び、`health`の呼び出しを依頼します。

現行の[OpenAI公式接続ガイド](https://developers.openai.com/plugins/deploy/connect-chatgpt)も、このPluginsの手順を案内しています。

<a id="authentication"></a>
### 認証

ThriftyRelayのMCPサーバーはOAuthを実装していません。
これとは別に、`tunnel-client`はsetupがOSの資格情報ストアへ保存したトンネル用APIキーでOpenAIに認証します。

<a id="access-permissions"></a>
### アクセス権限

カスタムMCP接続とツールの利用可否は、ChatGPTのプラン、[アカウントの権限とワークスペース設定](https://developers.openai.com/api/docs/guides/custom-mcp-server)、機能の提供状況によって変わります。

- [OpenAIヘルプセンター](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt)は、Full MCPの提供対象をBusiness、Enterprise、Eduとし、ProのカスタムMCP接続をread/fetchのみと説明しています。
- 現行の[Plugins接続ガイド](https://developers.openai.com/plugins/deploy/connect-chatgpt)には、認可や確認が必要な書き込み操作のテスト手順があります。

ChatGPT Plusでは、保守者の環境で、ThriftyRelayをプラグインとして追加してツールを使えることを確認しています。
アカウントや機能の提供状況によって異なる場合があるため、接続後に`health`を呼び出し、使う予定の操作を試してください。
カスタムMCPサーバーを追加できない場合は、これらの設定を確認します。

- 管理対象のワークスペースでは、**Create plugins with MCPs**と、プラグインやツールを使う権限を管理者に確認します。
- トンネルが表示されない場合は、対象のChatGPTワークスペースへの関連付けと、Platform組織での操作者のTunnels **Read + Use**権限を確認します。

<a id="legacy-connectors-ui"></a>
### 旧Connectors画面

次の手順は、旧Connectors画面が実際に表示される環境向けの参考です。

1. **Settings > Connectors**を開きます。
2. **Advanced settings**を開き、**Developer mode**を有効にします。
3. **Connectors**に戻って**Create**を選び、同じトンネルIDで**Tunnel**を設定します。

<a id="refresh-tool-definitions"></a>
### ツール定義の更新

再起動後にツール定義が変わった場合は、[ChatGPTのPlugins](https://chatgpt.com/plugins)でプラグインを開き、**Refresh**を選んでから新しい会話を始めます。

<a id="public-distribution"></a>
### 公開配布

Secure MCP Tunnelは、非公開のカスタムMCP接続に使います。
[リモートMCPプラグインの公開申請](https://developers.openai.com/plugins/deploy/submission)には、安定した公開HTTPSのMCPエンドポイントが必要です。
これはリモートMCPプラグインの申請条件であり、ThriftyRelayのソースやnpmパッケージのOSS配布とは別です。

<a id="success-criteria"></a>
## 成功の条件

読み取り専用の診断を実行します。

~~~sh
thriftyrelay status --json
thriftyrelay doctor
~~~

| 確認 | 期待する結果 |
| --- | --- |
| setup | 設定の保存、APIキーへのアクセス、起動方式の準備が済んでいる。POSIXでは別途`start`が必要。 |
| Windowsタスクの起動 | ローカルの`/readyz`が、デフォルトの60秒以内にHTTP 200を返す。 |
| フォアグラウンドの起動 | トンネルの同一性、待ち受けプロセスの所有権、`/readyz`のHTTP 200を確認できる。 |
| Windowsのプロセス確認 | タスクと管理対象プロセスを確認できる。 |
| 意図的に停止したマニュアル、フォアグラウンド、待機中のオンデマンドタスク | `PASS / STOPPED_IDLE`。停止したログオンタスクは別扱いです。 |

Windowsでは`thriftyrelay mcp check`でタスクと管理対象プロセスを確認します。
doctorだけでは、応答があっても`LOCAL_ENDPOINT_UNVERIFIED`になる場合があります。

続けて、[ChatGPTへの接続](#chatgpt-connection)の手順でChatGPTにThriftyRelayを追加します。
ChatGPTにThriftyRelayの`health`ツールを使用するように依頼します。
意図した権限でCodexに小さな作業を頼み、承認が必要ならカードの動作も確認します。

この手順で、ローカルの起動とは別に、ツールの検出、モデルへのアクセス、カードの動作を確認します。

<a id="codex-authentication"></a>
## Codexの認証

[Codexアダプター](../../src/codex/adapter.mjs)は`CODEX_HOME/auth.json`を読みます。
デフォルトは`~/.codex/auth.json`です。

| 条件 | 値 |
| --- | --- |
| 認証方式 | `auth_mode: "chatgpt"` |
| トークン | アクセストークンが必要。 |
| APIキーを含むレコード | 拒否。 |
| キーリングだけのサインイン | ファイルを読むこのチェックとの互換性は未確認。 |

setupはCodexの認証を変更しません。
既存の認証と組織のポリシーを維持し、トークンをこのプロジェクトへコピーしたり、このガイドに合わせて認証情報を変換したりしないでください。

<a id="temporary-work-area"></a>
## 一時作業領域

setupは絶対パスを`tempWorkspace`として保存し、対応するファイルシステムではモード0700でディレクトリを作成します。

| OS | デフォルト |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ThriftyRelay\temp` |
| Linux | `XDG_CACHE_HOME`が絶対パスなら`$XDG_CACHE_HOME/thriftyrelay/temp`。それ以外は`~/.cache/thriftyrelay/temp`。 |
| macOS | `~/Library/Caches/ThriftyRelay/temp` |

次の場所とは分けてください。

- Codexの作業ディレクトリ
- タスクストアと復旧証拠
- 設定と稼働状態の保存ディレクトリ
- インストールディレクトリとソースのチェックアウト

setupは、既存の祖先にあるリンクと未作成の末尾部分を含めた実パスで重なりを判定し、重なる場合は再入力を求めます。
資格情報もこの領域には置かないでください。

<a id="temporary-requests"></a>
### 一時領域での依頼

通常の`remote_task`では、次のように指定します。

1. `scratch: true`を付けて、`<tempWorkspace>/<task_id>/`を作成します。
2. 相対の`path`、`file_path`、`cwd`、パッチのパス、またはコマンド内の`{{scratch}}`を使います。
   これらはタスクのディレクトリ内で解決され、`{{scratch}}/..`を含め、外へ出るパスは拒否されます。
3. 別の場所を指定する場合は絶対パスを使います。
   絶対パスには通常の受付チェックが適用されます。

Codexでは、次のどちらかを絶対パスの`cwd`で指定します。

- 設定した作業ディレクトリの実パスそのもの
- 一時ルートのサブディレクトリ

Codexは`scratch: true`を拒否します。

ここでの通常の読み書きで承認を省くには、管理者が登録済みポリシーの`scratch_roots`に正確なパスを追加し、再登録します。
setupは手順を表示するだけで、登録は行いません。
登録がなければ従来の承認動作が適用されます。
コマンド、コード、ツール呼び出し、Codexには、それぞれの階層とサンドボックスの規則が適用されます。
Codexのサンドボックスは[受付ポリシー](admission.md)が選びます。

成果物は、タスクが成功する前に作業ディレクトリへ移してください。

| タスクの結果 | 整理 |
| --- | --- |
| 成功 | 自身のディレクトリを削除します。 |
| 失敗 | 保護されていないデータを最大7日間保持します。 |
| 実行中、結果不明、復旧証拠 | 整理の対象外です。 |

削除可能なデータには、100件と1 GiBの上限も適用します。
詳しい条件は[受付](admission.md#temporary-work-area-and-scratch_roots)を参照してください。

<a id="doctor-reference"></a>
## doctorリファレンス

doctorは次の確認結果を返します。
`status`はローカルの稼働状態を1〜2行で表示します。
`status --json`と`doctor --json`は詳細な確認結果を返します。
設定と現在の状態を観測するだけで、起動、修復、登録、更新は行いません。

| ID | 確認する内容 | 代表的なコード |
| --- | --- | --- |
| `environment` | Nodeのバージョン、インストール済みのCodex SDK、プラットフォームのネイティブバイナリ。 | `ENV_READY`、`ENV_POSIX_READY`、`ENV_NODE_RECOMMENDED`、`ENV_SDK_MISSING`、`ENV_NATIVE_BINARY_MISSING` |
| `config` | 読み取り可能なJSON、対応するプラットフォームのモード、絶対パスの作業ディレクトリ。 | `CONFIG_READY`、`CONFIG_NOT_INSTALLED`、`CONFIG_INVALID`、`CONFIG_MODE_INVALID`、`CONFIG_INCOMPLETE` |
| `credentials` | 選択した環境またはOSの資格情報の供給元がトンネル用APIキーを渡せるか。 | `CREDENTIAL_REGISTERED`、`CREDENTIAL_UNCONFIGURED`、`CREDENTIAL_BACKEND_ERROR` |
| `startup` | Windowsのタスク定義、または選択したフォアグラウンド/マニュアルモード。 | `STARTUP_TASK_REGISTERED`、`STARTUP_TASK_INVALID`、`STARTUP_FOREGROUND_CONFIGURED`、`STARTUP_MANUAL` |
| `readiness` | ループバックの応答。POSIXでThriftyRelayの実行状態が記録されている場合は、待ち受けプロセスの所有権と状態も確認。 | `STOPPED_IDLE`、`LOCAL_ENDPOINT_UNVERIFIED`、`RUNTIME_RUNNING`、`RUNTIME_FAILED`、`RUNTIME_STATE_STALE` |
| `policy` | 管理者が登録した受付ポリシーを読み取り、検証できるか。 | `PASS / POLICY_REGISTERED`、`WARN / POLICY_UNREGISTERED`、`WARN / POLICY_UNVERIFIED` |

`RUNTIME_OWNER_MISMATCH`はFAILです。
`RUNTIME_OWNER_UNKNOWN`、`RUNTIME_DEPENDENCY_MISSING`、`RUNTIME_IN_TRANSITION`、`LOCAL_READINESS_UNKNOWN`はUNKNOWNです。
所有者の確認に失敗した場合は、プロセスを止める前に調査します。
次の手順は[運用のトラブルシューティング表](operations.md#troubleshooting)で説明しています。

各JSON項目は`id`、`status`、`code`を含み、必要に応じて限定的な`evidence`が付きます。

| 終了コード | 条件 |
| --- | --- |
| `1` | FAILがある。 |
| `2` | FAILがなく、UNKNOWNがある。 |
| `0` | それ以外。WARNだけの場合も含む。 |

診断の終了コードとは別に、ポリシーの適用状態とホストとの接続を確認してください。
ポリシーの登録方法と、その確認結果に対応するサーバーの動作は[受付](admission.md)を参照してください。

設定、タスクストア、ログのパスは[運用](operations.md#state-and-logs)にまとめてあります。
インストールを削除するには、[アンインストール](operations.md#uninstall)のプレビューと保護付きの削除を使ってください。
保存されるユーザー設定は[設定](settings.md)に説明があります。
