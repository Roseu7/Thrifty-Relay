[English](../en/skills.md) | 日本語

<a id="skills"></a>
# Skill

Skillは作業に応じて選ぶ手順書です。
カタログから必要なSkillを選び、`SKILL.md`と、その作業に必要な参照ファイルを読みます。

<a id="discovery-scope"></a>
## 読み込む範囲

カタログの対象は`~/.codex/skills`直下にあるグローバルなユーザー管理のSkillだけです。
Skillは`SKILL.md`を持つ通常のディレクトリです。
`SKILL.md`のYAMLフロントマターに`name`と`description`を書きます。
隠しディレクトリ、ディレクトリへのシンボリックリンク、存在しないファイル、読めない項目、ルートの外を指す`SKILL.md`へのリンクは対象外です。
リポジトリ内のSkill、プラグインのカタログ、隠しディレクトリの`.system`は、このカタログに含まれません。

<a id="disable-a-skill"></a>
<a id="skill-exclusions"></a>
## Skillの除外

`~/.codex/config.toml`に`[[skills.config]]`を追加します。

~~~toml
[[skills.config]]
path = "skills/example"
enabled = false
~~~

1. `path`にSkillのディレクトリか`SKILL.md`を指定します。
   `~/.codex`からの相対パスか絶対パスを使えます。
2. `enabled = false`を指定します。
   `false`は引用符で囲みません。
3. サーバーを再起動し、ChatGPTを再接続してカタログを更新します。

<a id="catalog-lifetime"></a>
## カタログの更新

ThriftyRelayはMCPサーバーの起動時にカタログを作ります。

| データ | 読み込むタイミング | 更新方法 |
| --- | --- | --- |
| Skillの名前、説明、`SKILL.md`の相対パス | サーバーの起動時。カタログに入るのはメタデータだけです。 | Skillの追加、メタデータや除外設定の変更後に、サーバーを再起動してChatGPTを再接続します。 |
| 本文と必要な参照ファイル | Skillを選んだとき。`SKILL.md`は`remote_task`の`kind: "read"`と`expose: true`で読みます。 | 本文を変更したら読み直します。 |

<a id="trust-and-permissions"></a>
## 信頼と権限

Skillのメタデータと本文は信頼しないデータとして扱います。
利用者の指示とサーバーのアクセス制御の範囲で、作業手順として使います。
Skillを使っても、ファイルアクセス、コマンド実行、デプロイなどの権限は増えません。
作業ディレクトリ、書き込み範囲、受付ポリシー、承認フロー、実行ガードはそのまま適用されます。

<a id="empty-or-missing-catalog"></a>
## カタログが空のとき

カタログが空なら、次の条件を確認します。

- `~/.codex/skills`があり、Skillのディレクトリが入っている。
- Skillのディレクトリに`SKILL.md`がある。
- `SKILL.md`の先頭に`name`と`description`を持つYAMLフロントマターがある。
- `~/.codex/config.toml`でSkillを無効にしていない。
- Skillまたはメタデータを変更したあとにサーバーを再起動した。

検出に失敗すると、ThriftyRelayは空のカタログで起動し、エラーを標準エラー出力に書きます。
