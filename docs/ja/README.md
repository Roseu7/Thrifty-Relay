# ThriftyRelay

ThriftyRelayは、ChatGPTから手元のPCのCodexへコーディング作業を渡すローカルMCPサーバーです。
CodexはChatGPTのサインインで動き、APIの従量課金なしでプランのCodex利用枠を使います。

[English](../../README.md) | 日本語

ThriftyRelayはRoseuが保守しており、OpenAIとは関係ありません。
npmパッケージは公開していないので、下の手順でクローンからインストールします。
1.0より前は、マイナーリリースでも互換性のない変更が入ることがあります。更新前に[更新履歴](changelog.md)を確認してください。

- 新しい依頼の前に5時間枠と週間枠を確認します。
  デフォルトでは、どちらかの残量がしきい値以下になるとChatGPTが承認を求めます。
- Codexの依頼をリクエストIDで記録し、同じ内容の再送には元のタスクを返します。
- 結果が不明な書き込みを、確認と復旧のために保持します。

<a id="how-it-works"></a>
## 仕組み

1. ChatGPTが作業を計画し、OpenAIのトンネル経由でThriftyRelayのMCPツールを呼び出します。
2. 手元のPCの`tunnel-client`が、呼び出しをローカルのThriftyRelayサーバーに渡します。
3. ThriftyRelayは受付を確認し、Codexの作業なら利用枠も確認してから実行します。
   コーディング作業はCodexが、ファイルの読み取りやコマンドはThriftyRelayが直接実行します。
4. ThriftyRelayは依頼を記録し、変更されたファイルとコマンドの出力を返します。
5. ChatGPTがその内容を確認し、作業が終わったかを判断します。

## 必要なもの

- Node.js 22以降、npm、Git
- ChatGPTアカウントでのCodex CLIサインイン
- OpenAIのトンネルID、そのトンネル用APIキー、`tunnel-client`の実行ファイル
- LinuxではSecret Serviceに接続できる`secret-tool`と`ss`
- macOSではログインキーチェーンと`lsof`

それぞれの入手先と作業ディレクトリの選び方は[セットアップ](setup.md)にあります。
OSごとの確認状況は[プラットフォームごとの確認状況](setup.md#platform-status)にあります。

## クイックスタート

<a id="install"></a>
### インストール

~~~sh
git clone https://github.com/Roseu7/Thrifty-Relay.git
cd Thrifty-Relay
npm ci
npm install -g .
~~~

`npm install -g .`は`thriftyrelay`コマンドをこのクローンにリンクするので、クローンは移動しないでください。
npmが`thrifty-relay`のインストールスクリプトを許可していないと警告することがありますが、`npm ci`ですでに実行済みです。

setupは、Codexに作業させたいディレクトリで実行します。
setupはそのディレクトリを作業ディレクトリの候補にします。

### Windows

~~~powershell
thriftyrelay setup
~~~

Windowsで導入済みの場合、setupは実行中のタスクを停止して置き換える場合があります。
再実行する前に、[運用ガイド](operations.md#update-and-restart-cautions)の手順で実行中の作業を確認してください。

### LinuxとmacOS

`setup`で設定を保存し、続けて`start`で起動します。

~~~sh
thriftyrelay setup
thriftyrelay start
~~~

`start`はバックグラウンドで起動し、`thriftyrelay stop`で止めます。
起動方式とsetupが確認する内容は[セットアップ](setup.md)にあります。

<a id="connect-chatgpt"></a>
### ChatGPTへの接続

ThriftyRelayを動かしたまま、ChatGPTのWeb版で追加します。

1. [ChatGPTのPlugins](https://chatgpt.com/plugins)を開き、プラスボタンから**Add custom MCP server**を選びます。
2. 名前を`ThriftyRelay`にします。
3. **Connection**で**Tunnel**を選んでトンネルを選択し、**No authentication**を選びます。
4. リスク警告を確認して**Create as a plugin**を選び、プラグインをインストールします。

各手順の詳細、プランとワークスペースの権限、トンネルが表示されないときの確認点は[セットアップ](setup.md#chatgpt-connection)にあります。

## 動作確認

新しい会話でプロンプト欄に`@`を入力して`ThriftyRelay`を選び、`health`の呼び出しを頼みます。
正常なときは、次のような応答が返ります。

~~~text
ThriftyRelay <version>: OK; Windows; file/shell tools available (26 internal tools); build=<build>; source=current; codex=target-configured; writers=coordinated; scratch=configured; enforcement=unregistered
~~~

| 応答 | 意味と次の操作 |
| --- | --- |
| `ThriftyRelay <version>: OK`で始まる | ChatGPTからサーバーに接続できています。 |
| `codex=target-configured` | Codexの作業ディレクトリを設定済みです。下の小さな作業で実行を確認します。 |
| `codex=disabled` | setupでCodexの作業ディレクトリを設定してください。 |
| `source=changed-restart-required` | 起動後にソースが変わっています。依頼の前に[再起動の手順](operations.md#update-and-restart-cautions)に従ってください。 |

続けて、「作業ディレクトリのファイルを一覧して、何のプロジェクトか説明して」のような、何も変更しない小さな作業をCodexに頼みます。

> [!WARNING]
> [受付ポリシー](admission.md)が未登録の場合、CodexはThriftyRelayを実行するアカウントの権限で`danger-full-access`を使います。
> 受付ポリシーがCodexのサンドボックスを選びます。

作業ディレクトリと書き込み範囲は依頼の受付を制御し、サンドボックスはファイルへのアクセスを制御します。
結果が不明な書き込みは、再送せず[復旧手順](recovery.md)に従ってください。

## Skill

起動時のカタログには`~/.codex/skills`のグローバルなSkillが載ります。
選び方、`enabled = false`による無効化、既存の権限の範囲で信頼しないデータとして扱う方法は[Skill](skills.md)にあります。

## ドキュメント

| 目的 | ガイド |
| --- | --- |
| 導入と接続 | [セットアップ](setup.md) |
| 起動、停止、更新、アンインストール | [運用](operations.md) |
| モデルと利用枠の動作を選ぶ | [設定](settings.md) |
| Codexへ依頼して結果を確認する | [委任](orchestration.md) |
| グローバルなSkillを使う | [Skill](skills.md) |
| アクセス権と書き込み範囲を設定する | [受付](admission.md) |
| 結果不明の実行を調べる | [復旧](recovery.md) |
| 文書で使う用語を確かめる | [用語](architecture.md#terms) |
| 実装を理解して開発する | [アーキテクチャ](architecture.md)、[セットアップの設計記録](setup-doctor-design.md)、[貢献ガイド](contributing.md) |
| 更新と配布条件を確認する | [更新履歴](changelog.md)、[セキュリティポリシー](security.md)、[第三者ライセンス](third-party-notices.md)、[ライセンス](../../LICENSE) |

## 開発

`npm ci`、`node scripts/check-syntax.mjs`、`npm test`でオフラインの確認を実行します。
分野ごとのテストは[貢献ガイド](contributing.md)にあります。

## 貢献

不具合報告、文書の修正、範囲を絞った変更を歓迎します。
脆弱性は[セキュリティポリシー](security.md)の手順で非公開に報告してください。
変更内容は[更新履歴](changelog.md)にあります。

## ライセンス

ThriftyRelayは[MIT License](../../LICENSE)で公開しています。
依存パッケージのライセンスは[第三者ライセンス](third-party-notices.md)にあります。
