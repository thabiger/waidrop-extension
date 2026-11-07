# Icons

`icon.svg` is the source artwork. The PNG sizes used by the manifest are:

- `icon16.png`
- `icon48.png`
- `icon128.png`

Regenerate them with:

```sh
rsvg-convert -w 16 -h 16 icons/icon.svg -o icons/icon16.png
rsvg-convert -w 48 -h 48 icons/icon.svg -o icons/icon48.png
rsvg-convert -w 128 -h 128 icons/icon.svg -o icons/icon128.png
```
