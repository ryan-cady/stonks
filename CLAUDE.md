# Rebound Radar — Project Guide

## What This Is

A client-side SPA (no backend) that tracks stocks near 52-week lows with recovery potential. Everything runs in the browser; state is persisted to localStorage.

**Entry points:** `index.html` (markup), `main.js` (~1900 lines, all logic), `main.css` (all styles).

## Architecture

- **CORS proxy** — all external API calls go through `proxyFetch()` which tries `corsproxy.io` then `allorigins.win` as a fallback.
- **Data sources** — Yahoo Finance (prices/screeners), Finnhub (analyst ratings, optional), Alpha Vantage (fundamentals, optional), Unusual Whales (options flow, optional), SEC EDGAR (insider trades), Reddit WSB (hot posts), CNN Fear & Greed.
- **Caching layers** — stock price data: 5-min localStorage cache; analyst/insider/AV/UW: 24h/15m caches keyed by symbol; WSB posts: 30-min cache; CIK map: sessionStorage.
- **Rate limiting** — Alpha Vantage has a 13s queue (`drainAvQueue`) to stay under the 5 req/min free tier.
- **Screeners** — Yahoo Finance predefined screeners return symbol lists. WSB Radar is a special screener that fetches Reddit hot posts and extracts ticker mentions.
- **Insider / fundamentals / options flow** — only fetched for `customTickers` or `portfolio` entries to limit API calls.

## Key State

```
stockMap        { SYM: data | 'loading' | {error} }
portfolio       { SYM: { buyPrice, shares, targetPrice, ... } }
customTickers   string[]   (persisted, user-added)
screenerTickers string[]   (fetched fresh per load)
tickers         string[]   (screenerTickers + customTickers, deduped)
wsbMentions     { SYM: { mentions, posts[] } }
```

## Common Patterns

- Cards are rendered via `buildCard(sym, data)` → `grid.innerHTML`. Individual updates use `updateCardInPlace(sym)`.
- Optional card sections return `''` when data is absent — no special handling needed in `buildCard`.
- All API helpers follow: check cache → fetch → write cache → return. Cache TTLs are constants at the top of the file.
- `loadAll(forceRefresh)` is the main entry point. `forceRefresh=true` bypasses the stock cache and re-fetches from Yahoo Finance.

---

# Additional Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
