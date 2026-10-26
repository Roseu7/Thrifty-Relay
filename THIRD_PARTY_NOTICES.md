# Third-party notices

[日本語](docs/ja/third-party-notices.md) | English

ThriftyRelay's source uses the [MIT License](LICENSE).
When distributing it, include the licenses and notices for the dependencies and binaries in the distributed files.

## Direct runtime dependencies

The tables list exact versions from `package-lock.json` and license identifiers from package metadata.
The corresponding license texts are included in the installed packages.

| Package | Locked version | License |
| --- | --- | --- |
| `@jitl/quickjs-wasmfile-release-sync` | `0.32.0` | MIT |
| `@modelcontextprotocol/sdk` | `1.32.2` | MIT |
| `@openai/codex-sdk` | `0.162.1` | Apache-2.0 |
| `@wonderwhy-er/desktop-commander` | `0.2.52` | MIT |
| `quickjs-emscripten-core` | `0.32.0` | MIT |
| `zod` | `4.6.7` | MIT |

## Direct development dependencies

| Package | Locked version | License |
| --- | --- | --- |
| `@modelcontextprotocol/ext-apps` | `1.7.5` | MIT |
| `esbuild` | `0.25.12` | MIT |

A development dependency can still contribute code to a shipped artifact.
In particular, the settings UI build bundles `ui/settings.mjs` and its imports into `src/mcp/settings-app.html`.
The bundler uses `legalComments: "none"` and removes legal comments from the generated HTML.
Review the built HTML and the dependencies actually included before distribution.

## Apache-2.0 Codex SDK

The installed `@openai/codex-sdk` contains its Apache License 2.0 text at `node_modules/@openai/codex-sdk/LICENSE`.
Also check any NOTICE files included with the SDK's CLI and native dependencies for the target platform.

For redistribution, review [Apache License 2.0, section 4](https://www.apache.org/licenses/LICENSE-2.0).
Preserve the applicable license, copyright, attribution, and NOTICE material, and identify modifications where required.
Each dependency retains its own license; include the applicable texts with the distribution.

## Transitive dependencies and bundled artifacts

The tables cover direct dependencies.
Distribution review also includes transitive packages, optional platform binaries, embedded WebAssembly or native code, and their notices.

Review the resolved tree in `package-lock.json` and the license/NOTICE files in the packages actually installed for each target platform.
Check platform-specific distributions separately for Windows, Linux, and macOS.
Also review generated HTML, archives, copied binaries, and other bundled artifacts rather than relying only on package metadata.

## External tunnel-client binary

Setup uses an operator-provided `tunnel-client` executable and does not download or bundle it.
Identify the external binary's version and origin, then retain the license texts and notices that came with that distribution.
Consult the matching [upstream release](https://github.com/openai/tunnel-client/releases), [license](https://github.com/openai/tunnel-client/blob/master/LICENSE), and [NOTICE](https://github.com/openai/tunnel-client/blob/master/NOTICE), then verify the actual binary's distribution materials.

## Review or regenerate this document

There is no dedicated notice-generation script in this repository.
After an intentional dependency change, install the locked tree with `npm ci` in a suitable development checkout, then:

1. Enumerate `dependencies` and `devDependencies` from `package.json`.
2. Read each installed package's exact `version` and `license`, and compare its resolved entry with `package-lock.json`. Use `npm ls --depth=0` as an inventory cross-check.
3. Read the installed license and NOTICE files, including relevant transitive and platform-specific distributions; do not infer texts from SPDX identifiers alone.
4. Update these direct-dependency tables and review the actual bundled/distributed files for retained or separately supplied attribution.
5. Review external binaries independently and preserve their matching license/notice materials when distributing them.
