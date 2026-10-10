BRASS+ updated bundle

Files: index.html, server.js, package.json

Changes in this build:
- Morning-practice personal attendance stays local; a per-member attendance total is sent to the group member record so Morning King can rank members.
- Shared deletion endpoint supports goals, practices, issues, lessons, songs, posts, recommendations and voices, with server tombstones preventing deleted entries from returning on sync.
- Lesson reflections use the swipe card class and display registrant.
- Shared practice/issue cards show registrant when available.

Before deployment: back up current GitHub files and your server data. Replace index.html and server.js together, commit, and wait for Render to become Live. Browser/device and live multi-member testing has not been performed; older records without registrant may display 未設定. Render's data persistence depends on its storage configuration.
