## [0.11.1](https://github.com/JuanmanDev/opencode-web/compare/0.11.0...0.11.1) (2026-09-05)

### Bug Fixes

* **docker:** opencode server volumes are writable by the node user ([8209c9d](https://github.com/JuanmanDev/opencode-web/commit/8209c9d0403185bda6ba155734d0d949a23a2e01))

## [0.11.0](https://github.com/JuanmanDev/opencode-web/compare/0.10.0...0.11.0) (2026-09-05)

### Features

* **chat:** message timestamps, real elapsed time and clearer tool errors ([24b5543](https://github.com/JuanmanDev/opencode-web/commit/24b5543d1b5eeb840514ca99cbf89cb0e3501f7c))

### Bug Fixes

* **chat:** never retry mutating requests, so a prompt is not sent twice ([aaf626a](https://github.com/JuanmanDev/opencode-web/commit/aaf626a0c01142fb99a608873643ce3ad42254a2))
* **routing:** malformed project URL renders a 404 instead of a 500 ([58e4095](https://github.com/JuanmanDev/opencode-web/commit/58e4095d61363a9bac8884ab9b9baf6b4678cbfb))
* **server:** redact provider API keys and stop caching failed MCP discovery ([54c459f](https://github.com/JuanmanDev/opencode-web/commit/54c459f94aeb33f717006be8e051cd6b27d4e65b))

## [0.10.0](https://github.com/JuanmanDev/opencode-web/compare/0.9.0...0.10.0) (2026-08-29)

### Features

* **chat:** agent questions UI, /mcp commands, demo MCP-UI server and polish ([64a5b94](https://github.com/JuanmanDev/opencode-web/commit/64a5b94c4f8f5fb89d0a4ec5f4b851e98b05bbd9))
* **chat:** message actions - copy, read aloud, edit-and-resend, fork ([9863ea9](https://github.com/JuanmanDev/opencode-web/commit/9863ea93e4006b8d5a30cfae112904d5b242267c))
* **chat:** pending agent questions replace the prompt box (TUI-style) ([5d4b3c4](https://github.com/JuanmanDev/opencode-web/commit/5d4b3c4291981504e8d83429e9be127da5f06bd5))
* **chat:** recover MCP-UI apps that opencode strips from tool outputs ([27cb8af](https://github.com/JuanmanDev/opencode-web/commit/27cb8af1583a06f4c129ea94252a189c4d2c3918))
* **chat:** render remote-dom MCP components and URL-addressable app viewer ([7df465a](https://github.com/JuanmanDev/opencode-web/commit/7df465a0a23a48957340e5ceef8438815156decb))
* **chat:** retry/continue actions on errors; demo server sends the mcp-ui ready event ([c3c34f8](https://github.com/JuanmanDev/opencode-web/commit/c3c34f8f630bf7364337c09bfe66bcf5b3071039))
* **chat:** shared per-tool mode rows, mcp filter and taller lists ([6cf37b7](https://github.com/JuanmanDev/opencode-web/commit/6cf37b7df5ecad2fe9846f6c9af7ef60321efb70))
* **chat:** shared tri-state MCP control, non-overlapping side panel, open-in-tab ([289e44d](https://github.com/JuanmanDev/opencode-web/commit/289e44d972ec4891bdfac4e7d82ab3e7131dfa7b))
* global search modal, meta MCP tools and persistent server registration ([95dd3a5](https://github.com/JuanmanDev/opencode-web/commit/95dd3a5b80f85ca2744d4143e0799a1c51db66dc))
* MCP Apps (SEP-1865) support end to end ([ee672b0](https://github.com/JuanmanDev/opencode-web/commit/ee672b00897141b5fdcc5db7a836bc53edaec55d))
* mcp-ui load lifecycle, shared presets, compact filter and search everywhere ([39d7025](https://github.com/JuanmanDev/opencode-web/commit/39d7025339377a29ad9c2067248a48e5040d1fec))
* **mcp:** MCP Apps-aware discovery, robust MCP client and full MCP UI e2e coverage ([8542414](https://github.com/JuanmanDev/opencode-web/commit/85424141fb95b4d424d244601e15cc1560f2dc2f))
* **mcp:** tri-state permissions (off/ask/auto), tool modes and shared presets ([1c628b7](https://github.com/JuanmanDev/opencode-web/commit/1c628b7273b791022364f05b96f281851fec4ecd))
* project dashboard, server-side caching and mobile keyboard fixes ([23b678b](https://github.com/JuanmanDev/opencode-web/commit/23b678b58360c1fb864f81fd07160bb6fb51a666))
* **sidebar:** global search button on the collapsed rail ([47ca7dd](https://github.com/JuanmanDev/opencode-web/commit/47ca7dd091d27b6395b721c8816df5e7cc38e133))
* slash commands with autocomplete, shell prefix, mcp sets and global scope ([7b1ed87](https://github.com/JuanmanDev/opencode-web/commit/7b1ed875cad01584d436004ad078514543e772ad))

### Bug Fixes

* **api:** import ocFetch explicitly instead of relying on auto-imports ([b9eb5c3](https://github.com/JuanmanDev/opencode-web/commit/b9eb5c3967d08a035911e23d77135c0e50ab4846))
* **app:** auto-recover from stale route chunks after redeploys ([0437496](https://github.com/JuanmanDev/opencode-web/commit/0437496b8ec0d1d80658d1ce116f3c68ab657c74))
* **chat:** persistent app viewer, deep-link loading and localhost URL rewriting ([4107084](https://github.com/JuanmanDev/opencode-web/commit/4107084dcd2b78be7e42b9795a545f1631567505))
* **chat:** readable question cards and no lock-up on zombie questions ([4443509](https://github.com/JuanmanDev/opencode-web/commit/4443509581f2f6ea6829b742a2eb44385dd7dd17))
* **chat:** serialize MCP Apps postMessage payloads to plain JSON ([e9c8b92](https://github.com/JuanmanDev/opencode-web/commit/e9c8b92ca70b1ca5d5ff494e90ef81f2c55ccaed))
* **dev:** pass host and port with explicit values ([d719fae](https://github.com/JuanmanDev/opencode-web/commit/d719faef22862b54faad833db72a9c31537f04a8))
* **home:** standard content width with full-bleed carousels; question flow testable ([8f1bdc3](https://github.com/JuanmanDev/opencode-web/commit/8f1bdc3467d4f1ec6ef92d0dfe39ec97c88c0733))
* hydration mismatches, iframe sandbox for external MCP apps, webmcp deprecation ([dce6d0f](https://github.com/JuanmanDev/opencode-web/commit/dce6d0fa9d1717b366079ed9696f5be73a1a6ece))

## [0.9.0](https://github.com/JuanmanDev/opencode-web/compare/0.8.0...0.9.0) (2026-08-17)

## [0.8.0](https://github.com/JuanmanDev/opencode-web/compare/0.7.0...0.8.0) (2026-08-17)

## [0.7.0](https://github.com/JuanmanDev/opencode-web/compare/0.6.0...0.7.0) (2026-08-17)

## [0.6.0](https://github.com/JuanmanDev/opencode-web/compare/0.5.1...0.6.0) (2026-08-17)

## [0.5.1](https://github.com/JuanmanDev/opencode-web/compare/0.5.0...0.5.1) (2026-08-17)

## [0.5.0](https://github.com/JuanmanDev/opencode-web/compare/0.4.0...0.5.0) (2026-08-17)

## [0.4.0](https://github.com/JuanmanDev/opencode-web/compare/0.3.0...0.4.0) (2026-08-17)

## [0.3.0](https://github.com/JuanmanDev/opencode-web/compare/0.2.0...0.3.0) (2026-08-17)

## [0.2.0](https://github.com/JuanmanDev/opencode-web/compare/0.1.0...0.2.0) (2026-08-16)
