# Vendored asset provenance

This manifest records the exact upstream source of every third-party asset copied into the
repository. Commit links are immutable. SHA-256 values identify the bytes distributed by this
repository after the recorded transformation, if any.

## IBM Plex Sans variable roman

- Local file: `public/fonts/ibm-plex-sans.woff2`
- Upstream project: <https://github.com/IBM/plex>
- Upstream revision: [`bf260093582f04622aacc1e9f9ca604d7ccd0c42`](https://github.com/IBM/plex/tree/bf260093582f04622aacc1e9f9ca604d7ccd0c42)
- Upstream path: `packages/plex-sans-variable/fonts/complete/woff2/IBM Plex Sans Var-Roman.woff2`
- SHA-256: `e978248b6b56da9e372975322a98dd9a51135d1b375e32ed6d5ca69f3aab792d`
- Transformation: renamed only, byte-identical to the file at the upstream revision
- License: SIL Open Font License 1.1, reproduced in `THIRD_PARTY_NOTICES.md`

## IBM Plex Sans variable italic

- Local file: `public/fonts/ibm-plex-sans-italic.woff2`
- Upstream project: <https://github.com/IBM/plex>
- Upstream revision: [`bf260093582f04622aacc1e9f9ca604d7ccd0c42`](https://github.com/IBM/plex/tree/bf260093582f04622aacc1e9f9ca604d7ccd0c42)
- Upstream path: `packages/plex-sans-variable/fonts/complete/woff2/IBM Plex Sans Var-Italic.woff2`
- SHA-256: `57c2e5e2d0a16054e83315a312d2d5d0166e4a6f5b27dbed28d7d9d05b5e4292`
- Transformation: renamed only, byte-identical to the file at the upstream revision
- License: SIL Open Font License 1.1, reproduced in `THIRD_PARTY_NOTICES.md`

## JetBrains Mono variable roman

- Local file: `public/fonts/jetbrains-mono.woff2`
- Upstream project: <https://github.com/JetBrains/JetBrainsMono>
- Upstream revision: [`19371302b95d218af43299bce79ddbddd0bc364d`](https://github.com/JetBrains/JetBrainsMono/tree/19371302b95d218af43299bce79ddbddd0bc364d)
- Upstream path: `fonts/webfonts/JetBrainsMono[wght].woff2`
- SHA-256: `31ec365b93e4bad6f202ce23352a56d01ca4462b2afc782ed2cf6fa42ca9ac0e`
- Transformation: renamed only, byte-identical to the file at the upstream revision
- License: SIL Open Font License 1.1, reproduced in `THIRD_PARTY_NOTICES.md`

## Space Grotesk bold

- Local file: `public/fonts/space-grotesk.woff2`
- Upstream project: <https://github.com/floriankarsten/space-grotesk>
- Upstream revision: [`03507d024a01282884232081fc6011c09ff4e849`](https://github.com/floriankarsten/space-grotesk/tree/03507d024a01282884232081fc6011c09ff4e849)
- Upstream path: `fonts/woff2/static/SpaceGrotesk-Bold.woff2`
- SHA-256: `06d705cebbab916f0c0fe82b6c6f4cae06aa07fd6f5ee078421206040326ef63`
- Transformation: renamed only, byte-identical to the file at the upstream revision
- License: SIL Open Font License 1.1, reproduced in `THIRD_PARTY_NOTICES.md`

## Lucide file icon

- Local use: `FILE_ICON` in `public/ledger.html`
- Upstream project: <https://github.com/lucide-icons/lucide>
- Upstream revision: [`dce50dd0c9d6d55dde2a8880732bbe2acc6ba29e`](https://github.com/lucide-icons/lucide/tree/dce50dd0c9d6d55dde2a8880732bbe2acc6ba29e)
- Upstream path: `icons/file.svg`
- Upstream file SHA-256: `499039795d7412d67664ff79d2eb6b7412e746b24c18c8fd8aba383c24ddada0`
- Transformation: removed `xmlns`, `width`, and `height`; serialized the two path elements into
  the existing JavaScript string; retained the upstream view box, fill, stroke, stroke width,
  line cap, line join, and path data; added `aria-hidden="true"`
- License: ISC, reproduced in `THIRD_PARTY_NOTICES.md`

## Verification

Clone or download each upstream revision, then compare the font hashes above with:

```sh
sha256sum public/fonts/*.woff2
```

The four local results must equal the recorded upstream-file hashes. For the icon, inspect the
recorded transformation against `icons/file.svg` at the pinned Lucide revision.
