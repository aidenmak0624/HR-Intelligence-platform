# Showcase Media

Feature demo clips recorded with Playwright (`scripts/record_showcase.js`).

| Clip | Feature | Role |
|------|---------|------|
| `chat` | Conversational HR chat — agent routing, confidence badge, reasoning | Employee |
| `leave` | Leave request — calendar range picker, confirm modal, history update | Employee |
| `directory` | Employee directory — live search, grid/list/org-chart views | HR Admin |
| `documents` | Document center — templates, drag-drop upload with progress | HR Admin |
| `analytics` | Analytics dashboard — stat tiles, charts, department filter | HR Admin |
| `workflows` | Approval workflow — pending card → confirm modal → approved toast | Manager |
| `routing` | Multi-agent routing — 3 questions, 3 agent badges (LEAVE/BENEFITS/POLICY) | Employee |
| `pii` | PII protection — SSN/phone/email masked on screen, GDPR/CCPA refs | HR Admin |
| `overview` | Hero overview — UI login → dashboard → chat Q&A → leave → benefits | (UI login) |
| `rag` | RAG grounding — GDPR retention answer cites policy doc + source chips | Employee |
| `benefits` | Benefits enrollment — browse plans → one-click enroll → coverage updates | Employee |
| `reject` | Rejection flow — reject with written reason → timeline shows Rejected | Manager |

`reasoning.png` — still of the expanded View Reasoning panel (POLICY AGENT, confidence 85%).
`rag_citations.png` — still of the RAG-grounded answer with source chips.

The `rag` clip requires an ingested index: `python scripts/build_rag_index.py` (baked into
the Docker image at build time; locally it populates `./chromadb_hr`).

Note: the `workflows` clip approves leave request id 1; to re-record it, reset first:
`sqlite3 hr_platform.db "UPDATE leave_requests SET status='pending' WHERE id=1;"`

Each clip exists as an optimized GIF (README embedding, ≤3.5 MB) and an MP4
(high quality). Raw `.webm` recordings live in `raw/` (not committed).

## Regenerating

```bash
# 1. Start the server against the local SQLite DB
DATABASE_URL="sqlite:///$(pwd)/hr_platform.db" python run.py

# 2. Record all clips (or pass clip names to record a subset)
node scripts/record_showcase.js
node scripts/record_showcase.js chat leave

# 3. Convert to GIF + MP4
cd docs/showcase/media
for f in chat leave directory documents analytics; do
  ffmpeg -y -i raw/$f.webm -vf "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5" $f.gif
  ffmpeg -y -i raw/$f.webm -c:v libx264 -crf 23 -preset slow -movflags +faststart -pix_fmt yuv420p $f.mp4
done
```
