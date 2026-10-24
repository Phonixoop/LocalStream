# LocalStream

Share a local file, video, image, or folder from this Windows PC to your phone over the same Wi‑Fi / LAN.

## Requirements

- Node.js 18+ (no npm install needed — zero dependencies)

## Run

```powershell
cd D:\Repos\LocalStream
npm start
```

Then open **http://127.0.0.1:47821** on this PC.

Default port is **47821** (uncommon). Override if needed:

```powershell
$env:LOCALSTREAM_PORT=51234
npm start
```

## Use

1. On the PC UI, either:
   - Paste an absolute disk path (best for large videos — streams from disk), or
   - Select files / a folder in the browser (uploads into a temporary share).
2. Copy a **LAN** URL (e.g. `http://192.168.x.x:47821/s/.../`).
3. Open that URL on your phone (same network). Folders are browsable; videos support HTTP **Range** streaming.

## Notes

- Keep the PC awake and LocalStream running while the phone is viewing.
- Windows Firewall may prompt on first listen — allow access on private networks.
- Path shares read from disk; browser uploads live under the OS temp folder and are removed when you delete the share.
