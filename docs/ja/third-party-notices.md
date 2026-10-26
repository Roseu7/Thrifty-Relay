[English](../../THIRD_PARTY_NOTICES.md) | 日本語

# 第三者ライセンス

ThriftyRelayのソースには[MIT License](../../LICENSE)が適用されます。
配布する場合は、配布物に含まれる依存関係とバイナリのライセンス文書と通知も添付してください。

## 実行時の直接依存

表は`package-lock.json`の解決済みバージョンと、パッケージのメタデータにあるライセンス識別子を示します。
対応するライセンス本文は、インストールされたパッケージに含まれます。

| パッケージ | 解決済みバージョン | ライセンス |
| --- | --- | --- |
| `@jitl/quickjs-wasmfile-release-sync` | `0.32.0` | MIT |
| `@modelcontextprotocol/sdk` | `1.32.2` | MIT |
| `@openai/codex-sdk` | `0.162.1` | Apache-2.0 |
| `@wonderwhy-er/desktop-commander` | `0.2.52` | MIT |
| `quickjs-emscripten-core` | `0.32.0` | MIT |
| `zod` | `4.6.7` | MIT |

## 開発時の直接依存

| パッケージ | 解決済みバージョン | ライセンス |
| --- | --- | --- |
| `@modelcontextprotocol/ext-apps` | `1.7.5` | MIT |
| `esbuild` | `0.25.12` | MIT |

開発用の依存関係も、生成した配布物へコードが含まれる場合があります。
設定画面のビルドは、`ui/settings.mjs`とその読み込み先を`src/mcp/settings-app.html`へまとめます。
ビルドの`legalComments: "none"`は、生成HTMLからライセンスのコメントを除去します。
配布前に、HTMLと実際に含まれた依存関係を確認してください。

## Apache-2.0のCodex SDK

`@openai/codex-sdk`のApache License 2.0本文は、`node_modules/@openai/codex-sdk/LICENSE`にあります。
対象OS向けのCLIとネイティブ依存関係に含まれるNOTICEファイルも確認してください。

再配布では[Apache License 2.0の第4条](https://www.apache.org/licenses/LICENSE-2.0)を確認します。
該当するライセンス、著作権表示、帰属表示、NOTICEを保持し、必要な箇所には変更を明示してください。
依存関係には各パッケージのライセンスが適用されるため、対応するライセンス本文を配布物に含めます。

## 間接依存と生成物

表の対象は直接依存です。
配布時の確認には、間接依存、OS別の追加バイナリ、組み込みのWebAssemblyやネイティブコード、その通知も含めます。

`package-lock.json`の依存関係と、対象OSにインストールされたパッケージのライセンスとNOTICEを確認してください。
Windows、Linux、macOSの配布物は、それぞれ個別に確認します。
生成したHTML、アーカイブ、コピーしたバイナリなど、実際の配布物も対象です。

## 外部のtunnel-client

setupは利用者が用意した`tunnel-client`を使います。
ダウンロードと同梱は行いません。
使用するバイナリのバージョンと入手元を確認し、その配布物に付属するライセンス文書と通知を保持します。
対応する[上流のリリース](https://github.com/openai/tunnel-client/releases)、[ライセンス](https://github.com/openai/tunnel-client/blob/master/LICENSE)、[NOTICE](https://github.com/openai/tunnel-client/blob/master/NOTICE)と、実際の配布資料を照合してください。

## 更新手順

このリポジトリにはライセンス通知を自動生成する専用スクリプトはありません。
依存関係を変更した場合は、開発用のチェックアウトで`npm ci`を実行し、次の手順で更新します。

1. `package.json`の`dependencies`と`devDependencies`を列挙します。
2. インストールした各パッケージの`version`と`license`を読み、`package-lock.json`の解決済み項目と比較します。
   `npm ls --depth=0`でも一覧を照合します。
3. 間接依存とOS別の配布物も含め、ライセンスとNOTICEの本文を読みます。
4. 直接依存の表を更新し、実際の配布物に帰属表示が保持または別添されているか確認します。
5. 外部バイナリは個別に確認し、対応するライセンス文書と通知を配布物に保持します。
