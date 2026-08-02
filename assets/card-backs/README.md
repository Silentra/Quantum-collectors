# Pack card-back artwork

Repository-owned faces for pack opening (face-down) and Packs-tab tiles.

| File | Pack name match |
|------|-----------------|
| `standard-pack.webp` | Standard / Basic |
| `premium-pack.webp` | Premium |
| `research-pack.webp` | Research / Scientist |

**Runtime export:** WebP **600×840** (exactly **5:7**), quality ~75–82.

**Corners:** Full rectangular image — do **not** bake rounded or transparent corners. CSS applies `border-radius` + `overflow: hidden`.

**Safe region:** Keep important artwork inside the inner area; CSS clips the outer corners (~0.6rem radius on reveal backs).

Resolved in code by `js/pack-art.js` from pack display name (not Firebase paths). Missing files fall back to the emoji presentation.
