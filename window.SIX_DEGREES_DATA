name: Generate daily puzzle

# Runs once a day, plus you can trigger it manually from the Actions tab
# (useful for testing without waiting for the schedule).
on:
  schedule:
    # 06:00 UTC every day. Cron is always UTC on GitHub Actions — adjust
    # this number for your own timezone if you want the puzzle to flip
    # over at a specific local time (e.g. midnight Eastern in winter is
    # 05:00 UTC).
    - cron: "0 6 * * *"
  workflow_dispatch: {}

permissions:
  contents: write # needed to commit puzzle-data.js back to the repo

jobs:
  build-puzzle:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repo
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Generate today's puzzle
        env:
          TMDB_KEY: ${{ secrets.TMDB_KEY }}
        run: node daily-puzzle.js

      - name: Move output to repo root
        run: mv out/puzzle-data.js puzzle-data.js

      - name: Commit and push if it changed
        run: |
          git config user.name "ojm404"
          git config user.email "ojm404@users.noreply.github.com"
          git add puzzle-data.js
          git diff --staged --quiet || git commit -m "Daily puzzle: $(date -u +%Y-%m-%d)"
          git push
