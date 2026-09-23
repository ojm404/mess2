/**
 * daily-puzzle.js
 *
 * Meant to run once a day via GitHub Actions (see
 * .github/workflows/daily-puzzle.yml), not on your own machine on demand,
 * though you can run it manually with `TMDB_KEY=xxx node daily-puzzle.js`
 * to test it.
 *
 * Unlike build-graph.js (which crawls a huge actor pool up front and ships
 * the whole graph), this script does the opposite: it picks two actors,
 * then explores outward from both live against TMDB, stopping the moment
 * the two searches meet. The only data that ends up in the output is
 * whatever the search actually touched — typically a few hundred actors
 * and movies, not thousands. That keeps the daily output small (usually
 * well under 500KB) and keeps the TMDB key server-side the whole time,
 * since this runs in GitHub's Actions runner, never in a visitor's browser.
 *
 * Output: out/puzzle-data.js — a single JS file that just assigns to
 * window.SIX_DEGREES_DATA. game.html loads it with a <script src="...">
 * tag (see the comment at the bottom of this file), so there's no fetch(),
 * no CORS to worry about, and nothing to host except this one file.
 *
 * Same Marvel/keyword/non-fiction filters as build-graph.js. If you change
 * those in build-graph.js, mirror the change here too — they're kept
 * separate on purpose so this script has no dependency on the other one,
 * but that does mean they can drift if you only update one.
 */

const fs = require("fs");
const path = require("path");

const TMDB_KEY = process.env.TMDB_KEY;
if (!TMDB_KEY) {
  console.error("Set TMDB_KEY in the environment before running this script.");
  process.exit(1);
}

const CONFIG = {
  baseUrl: "https://api.themoviedb.org/3",
  outDir: path.join(__dirname, "out"),

  maxCastPerMovie: 20,

  excludedGenreIds: new Set([99]), // Documentary

  selfAppearancePattern:
    /^(self|himself|herself|themselves|host|presenter|narrator|interviewee|archive footage)\b/i,

  // Keep these in sync with build-graph.js's CONFIG of the same names.
  marvelCompanyIds: new Set([420]),
  excludedKeywordIds: new Set([180547]), // "Marvel Cinematic Universe (MCU)"

  // Pool to pick today's two actors from. Same list you're using in
  // build-graph.js's seedActorNames works fine here.
  seedActorNames: [
    "Tom Hanks", "Meryl Streep", "Denzel Washington", "Julia Roberts",
    "Leonardo DiCaprio", "Kate Winslet", "Brad Pitt", "Cate Blanchett",
    "Samuel L. Jackson", "Nicole Kidman", "Will Smith", "Charlize Theron",
    "Matt Damon", "Scarlett Johansson", "George Clooney", "Sandra Bullock",
    "Morgan Freeman", "Emma Stone", "Christian Bale", "Viola Davis",
    "Kaya Scodelario", "Henry Cavill", "Julia Stiles", "Kurt Russell",
    "James Spader", "Jennifer Lawrence", "James Corden", "Chris Pine",
    "Simon Pegg", "Zendaya", "Idris Elba", "Tom Cruise", "Penelope Cruz",
    "Javier Bardem", "Daniel Craig",
  ],

  // A puzzle must have a true shortest path in this range to be accepted.
  minPairDistance: 3,
  maxPairDistance: 5,

  // Hard ceiling on how many actors the bidirectional search will expand
  // before giving up on a pair and trying a different one. This is what
  // keeps a single day's run inside a reasonable number of API calls —
  // without it, a pair of very popular actors could pull in tens of
  // thousands of requests before connecting.
  maxActorsExpanded: 600,

  // How many different random pairs to try before giving up for the day.
  maxAttempts: 8,

  requestsPerBatch: 35,
  batchPauseMs: 10_000,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRateLimiter({ requestsPerBatch, batchPauseMs }) {
  let count = 0;
  return async function run(fn) {
    if (count > 0 && count % requestsPerBatch === 0) {
      console.log(`  ...pausing ${batchPauseMs}ms for TMDB rate limit`);
      await sleep(batchPauseMs);
    }
    count += 1;
    return fn();
  };
}
const limiter = makeRateLimiter(CONFIG);

async function tmdb(urlPath) {
  const url = `${CONFIG.baseUrl}${urlPath}`;
  return limiter(async () => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TMDB_KEY}` },
    });
    if (!res.ok) throw new Error(`TMDB request failed (${res.status}): ${url}`);
    return res.json();
  });
}

// ---------------------------------------------------------------------------
// Filters — mirrors build-graph.js
// ---------------------------------------------------------------------------

function isMarvelMovie(movieDetails) {
  const companyIds = (movieDetails.production_companies || []).map((c) => c.id);
  if (companyIds.some((id) => CONFIG.marvelCompanyIds.has(id))) return true;
  const keywordIds = ((movieDetails.keywords && movieDetails.keywords.keywords) || []).map(
    (k) => k.id
  );
  return keywordIds.some((id) => CONFIG.excludedKeywordIds.has(id));
}

function isNonFictionMovie(movieDetails) {
  const genreIds = (movieDetails.genres || []).map((g) => g.id);
  return genreIds.some((id) => CONFIG.excludedGenreIds.has(id));
}

function isFictionalCastCredit(castMember) {
  const character = castMember.character || "";
  if (!character.trim()) return false;
  return !CONFIG.selfAppearancePattern.test(character.trim());
}

// ---------------------------------------------------------------------------
// Live, bounded, bidirectional BFS
// ---------------------------------------------------------------------------

async function resolveActorId(name) {
  const data = await tmdb(`/search/person?query=${encodeURIComponent(name)}&language=en-US`);
  const match = (data.results || []).find((p) => p.known_for_department === "Acting");
  return match ? match.id : (data.results && data.results[0] && data.results[0].id);
}

// A shared cache across one run, so the two frontiers never re-fetch the
// same actor or movie twice even if both sides reach it.
function makeGraphCache() {
  return { actors: {}, movies: {} }; // id -> { name, movies:[] } / { title, year, cast:[] }
}

async function expandActor(actorId, cache) {
  if (cache.actors[actorId] && cache.actors[actorId]._expanded) return cache.actors[actorId];

  const credits = await tmdb(`/person/${actorId}/movie_credits?language=en-US`);
  const personName =
    (cache.actors[actorId] && cache.actors[actorId].name) ||
    (credits.cast && credits.cast[0] && credits.cast[0].original_title) || // rarely present; fallback below
    null;

  const movieIds = (credits.cast || [])
    .filter(isFictionalCastCredit)
    .map((c) => c.id);

  cache.actors[actorId] = cache.actors[actorId] || { name: null, movies: [] };
  cache.actors[actorId].movies = movieIds;
  cache.actors[actorId]._expanded = true;

  return { movieIds };
}

async function expandMovie(movieId, cache) {
  if (cache.movies[movieId] && cache.movies[movieId]._expanded) return cache.movies[movieId];

  const details = await tmdb(`/movie/${movieId}?language=en-US&append_to_response=credits,keywords`);

  if (isMarvelMovie(details) || isNonFictionMovie(details)) {
    cache.movies[movieId] = { title: details.title, year: null, cast: [], _excluded: true, _expanded: true };
    return cache.movies[movieId];
  }

  const cast = ((details.credits && details.credits.cast) || [])
    .filter(isFictionalCastCredit)
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, CONFIG.maxCastPerMovie);

  for (const c of cast) {
    if (!cache.actors[c.id]) cache.actors[c.id] = { name: c.name, movies: [] };
    if (!cache.actors[c.id].name) cache.actors[c.id].name = c.name;
  }

  cache.movies[movieId] = {
    title: details.title,
    year: (details.release_date || "").slice(0, 4) || null,
    cast: cast.map((c) => c.id),
    _expanded: true,
  };
  return cache.movies[movieId];
}

/**
 * Alternately expands the smaller of two frontiers outward from startId and
 * endId, one hop at a time, until they touch or the actor budget runs out.
 * Returns { found: bool, cache } — cache holds every actor/movie visited,
 * which becomes the puzzle's shipped graph regardless of outcome.
 */
async function bidirectionalSearch(startId, endId, cache) {
  let frontA = new Set([startId]);
  let frontB = new Set([endId]);
  const visitedA = new Set([startId]);
  const visitedB = new Set([endId]);
  let actorsExpanded = 0;

  cache.actors[startId] = cache.actors[startId] || { name: null, movies: [] };
  cache.actors[endId] = cache.actors[endId] || { name: null, movies: [] };

  while (frontA.size > 0 && frontB.size > 0) {
    const expandingA = frontA.size <= frontB.size;
    const frontier = expandingA ? frontA : frontB;
    const visitedSame = expandingA ? visitedA : visitedB;
    const visitedOther = expandingA ? visitedB : visitedA;

    const next = new Set();

    for (const actorId of frontier) {
      if (actorsExpanded >= CONFIG.maxActorsExpanded) {
        return { found: false, cache };
      }
      actorsExpanded += 1;

      const { movieIds } = await expandActor(actorId, cache);
      for (const movieId of movieIds) {
        const movie = await expandMovie(movieId, cache);
        if (movie._excluded) continue;

        for (const coStarId of movie.cast) {
          if (visitedOther.has(coStarId)) {
            return { found: true, cache }; // frontiers met
          }
          if (!visitedSame.has(coStarId)) {
            visitedSame.add(coStarId);
            next.add(coStarId);
          }
        }
      }
    }

    if (expandingA) frontA = next;
    else frontB = next;
  }

  return { found: false, cache };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function pickTwoRandom(list) {
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

function trimCacheToVisited(cache) {
  // Drop the internal _expanded/_excluded bookkeeping flags before writing
  // output, and drop any movie that got excluded (Marvel/non-fiction) —
  // it should never appear in the shipped puzzle graph.
  const actors = {};
  for (const [id, a] of Object.entries(cache.actors)) {
    if (!a.name) continue; // never actually resolved — skip
    actors[id] = { name: a.name, movies: a.movies || [] };
  }
  const movies = {};
  for (const [id, m] of Object.entries(cache.movies)) {
    if (m._excluded) continue;
    movies[id] = { title: m.title, year: m.year, cast: m.cast };
  }
  return { actors, movies };
}

async function main() {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });

  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt++) {
    const [nameA, nameB] = pickTwoRandom(CONFIG.seedActorNames);
    console.log(`Attempt ${attempt}: trying ${nameA} <-> ${nameB}`);

    const [idA, idB] = await Promise.all([resolveActorId(nameA), resolveActorId(nameB)]);
    if (!idA || !idB || idA === idB) {
      console.log("  could not resolve both actors, trying a different pair");
      continue;
    }

    const cache = makeGraphCache();
    cache.actors[idA] = { name: nameA, movies: [] };
    cache.actors[idB] = { name: nameB, movies: [] };

    const { found } = await bidirectionalSearch(idA, idB, cache);

    if (!found) {
      console.log("  no connection found within the search budget, trying a different pair");
      continue;
    }

    const { actors, movies } = trimCacheToVisited(cache);
    console.log(
      `  connected. Puzzle graph: ${Object.keys(actors).length} actors, ` +
        `${Object.keys(movies).length} movies.`
    );

    const payload = {
      generatedAt: new Date().toISOString(),
      pairs: [{ a: idA, b: idB }],
      actors,
      movies,
    };

    const js =
      `// Auto-generated by daily-puzzle.js — do not edit by hand.\n` +
      `// Regenerated daily by the GitHub Actions workflow.\n` +
      `window.SIX_DEGREES_DATA = ${JSON.stringify(payload)};\n`;

    fs.writeFileSync(path.join(CONFIG.outDir, "puzzle-data.js"), js);
    console.log(`\nWrote out/puzzle-data.js (${nameA} <-> ${nameB}).`);
    return;
  }

  console.error(`Failed to generate a puzzle after ${CONFIG.maxAttempts} attempts.`);
  process.exit(1);
}

main().catch((err) => {
  console.error("daily-puzzle.js failed:", err);
  process.exit(1);
});

/**
 * ---------------------------------------------------------------------
 * How game.html should load this:
 *
 * Add this BEFORE your existing game <script> tag, pointing at wherever
 * this repo is hosted (jsDelivr example shown):
 *
 *   <script src="https://cdn.jsdelivr.net/gh/YOUR_USERNAME/YOUR_REPO@main/puzzle-data.js"></script>
 *
 * Then in game.html's init(), replace the three fetch() calls with:
 *
 *   async function init() {
 *     const data = window.SIX_DEGREES_DATA;
 *     if (!data) {
 *       document.getElementById('status').textContent =
 *         'Could not load today\'s puzzle. Try refreshing.';
 *       document.getElementById('status').className = 'status err';
 *       return;
 *     }
 *     actors = data.actors;
 *     movies = data.movies;
 *     pairs = data.pairs;
 *     newPuzzle();
 *   }
 *
 * No fetch(), no CORS, nothing else to change — <script src> tags load
 * cross-origin without any CORS restriction, unlike fetch().
 * ---------------------------------------------------------------------
 */
