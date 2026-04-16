'use strict';

// ── Config ────────────────────────────────────────────────────────────────────

const CORS_PROXY = 'https://corsproxy.io/?';

// Fallback if screener fetch fails entirely
const FALLBACK_TICKERS = [
    'INTC', 'PFE', 'NKE', 'DIS', 'BA', 'WBA', 'SNAP',
    'RIVN', 'F', 'DAL', 'ETSY', 'MU', 'MRNA', 'PARA', 'CCL'
];

const SCREENER_SIZE = 20;
const SCREENER_PREF_KEY = 'rebound-radar-screener';

const SCREENER_OPTIONS = [
    { id: '52wk_low',                 label: '52W Lows'    },
    { id: 'day_losers',               label: 'Day Losers'  },
    { id: 'most_actives',             label: 'Most Active' },
    { id: 'undervalued_large_caps',   label: 'Undervalued' },
    { id: 'growth_technology_stocks', label: 'Growth Tech' },
    { id: 'aggressive_small_caps',    label: 'Small Caps'  },
];

const CUSTOM_KEY    = 'rebound-radar-custom';
const FINNHUB_KEY        = 'rebound-radar-finnhub';
const ANALYST_CACHE_KEY  = 'rebound-radar-analyst-cache';
const ANALYST_TTL_MS     = 24 * 60 * 60 * 1000; // 24 hours
const PORTFOLIO_KEY = 'rebound-radar-portfolio';
const FIRED_KEY     = 'rebound-radar-fired';
const AUTO_REFRESH_MS = 5 * 60 * 1000;

// ── State ─────────────────────────────────────────────────────────────────────

let screenerTickers = [];              // fetched fresh on each load
let customTickers   = loadCustomTickers(); // user-added, persisted
let tickers         = [];              // working set = screener + custom (deduped)

let stockMap     = {};
let portfolio    = loadPortfolio();
let firedAlerts  = loadFiredAlerts();

let currentScreenerId = localStorage.getItem(SCREENER_PREF_KEY) || 'all';
let finnhubKey        = localStorage.getItem(FINNHUB_KEY) || '';
let currentFilter     = 'all';
let currentSort       = 'score';
let modalSymbol   = null;
let autoRefreshTimer   = null;
let countdownTimer     = null;
let countdownRemaining = 0;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    bindUI();
    renderPortfolioSection();
    loadAll();
    if (Object.keys(portfolio).length > 0) startAutoRefresh();
});

// ── UI Binding ────────────────────────────────────────────────────────────────

function bindUI() {
    document.getElementById('add-btn').addEventListener('click', handleAdd);
    document.getElementById('ticker-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleAdd();
    });
    document.getElementById('refresh-btn').addEventListener('click', () => loadAll(true));
    document.getElementById('sort-select').addEventListener('change', e => {
        currentSort = e.target.value;
        renderGrid();
    });
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderGrid();
        });
    });
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-cancel').addEventListener('click', closeModal);
    document.getElementById('modal-save').addEventListener('click', saveTrackEntry);
    document.getElementById('modal-remove').addEventListener('click', removeTrackEntry);
    document.getElementById('modal-overlay').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeModal();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });

    // Screener toggles
    document.querySelectorAll('.screener-toggle').forEach(btn => {
        btn.addEventListener('click', () => setScreener(btn.dataset.screener));
    });
    applyScreenerActive();

    // Settings panel
    document.getElementById('settings-btn').addEventListener('click', toggleSettings);
    document.getElementById('settings-save').addEventListener('click', saveSettings);
    document.getElementById('settings-clear').addEventListener('click', clearSettings);
    document.getElementById('finnhub-key').addEventListener('keydown', e => {
        if (e.key === 'Enter') saveSettings();
    });
    if (finnhubKey) document.getElementById('finnhub-key').value = finnhubKey;
    updateSettingsStatus();
}

// ── Screener ──────────────────────────────────────────────────────────────────

async function fetchScreenerTickers() {
    setScreenerStatus('loading');

    if (currentScreenerId === 'all') {
        // Fetch all screeners in parallel and merge (deduplicated)
        const allIds = SCREENER_OPTIONS.map(o => o.id);
        const results = await Promise.allSettled(allIds.map(id => fetchSingleScreener(id)));
        const seen = new Set();
        const merged = [];
        for (const r of results) {
            if (r.status === 'fulfilled') {
                for (const sym of r.value) {
                    if (!seen.has(sym)) { seen.add(sym); merged.push(sym); }
                }
            }
        }
        if (merged.length > 0) {
            setScreenerStatus('ok', 'All Screeners', merged.length);
            return merged;
        }
        setScreenerStatus('fallback');
        return [...FALLBACK_TICKERS];
    }

    // Single screener — fall back to 52wk_low if it fails
    const tryIds = currentScreenerId !== '52wk_low'
        ? [currentScreenerId, '52wk_low']
        : ['52wk_low'];

    for (const scrId of tryIds) {
        const syms = await fetchSingleScreener(scrId);
        if (syms.length > 0) {
            const option = SCREENER_OPTIONS.find(o => o.id === scrId);
            setScreenerStatus('ok', option?.label || scrId, syms.length);
            return syms;
        }
    }

    setScreenerStatus('fallback');
    return [...FALLBACK_TICKERS];
}

async function fetchSingleScreener(scrId) {
    try {
        const yahooUrl = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved` +
            `?formatted=false&scrIds=${scrId}&count=${SCREENER_SIZE}&region=US&lang=en-US`;
        const resp = await fetch(CORS_PROXY + encodeURIComponent(yahooUrl), {
            headers: { 'Accept': 'application/json' }
        });
        if (!resp.ok) return [];
        const json   = await resp.json();
        const quotes = json?.finance?.result?.[0]?.quotes;
        if (!Array.isArray(quotes)) return [];
        return quotes
            .map(q => q.symbol)
            .filter(s => s && /^[A-Z.]{1,5}$/.test(s))
            .slice(0, SCREENER_SIZE);
    } catch (_) {
        return [];
    }
}

function setScreener(id) {
    currentScreenerId = id;
    localStorage.setItem(SCREENER_PREF_KEY, id);
    applyScreenerActive();
    stockMap = {};
    loadAll();
}

function applyScreenerActive() {
    document.querySelectorAll('.screener-toggle').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.screener === currentScreenerId);
    });
}

function setScreenerStatus(state, scrId = '', count = 0) {
    const el = document.getElementById('screener-status');
    if (!el) return;
    if (state === 'loading') {
        el.textContent = 'Fetching screener…';
        el.className = 'screener-status loading';
    } else if (state === 'ok') {
        el.textContent = `${scrId} screener · ${count} stocks`;
        el.className = 'screener-status ok';
    } else {
        el.textContent = 'Default list (screener unavailable)';
        el.className = 'screener-status fallback';
    }
}

// ── Data Loading ──────────────────────────────────────────────────────────────

async function loadAll(forceRefresh = false) {
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('stock-grid').innerHTML = '';

    if (forceRefresh) stockMap = {};

    // 1. Fetch fresh screener list
    screenerTickers = await fetchScreenerTickers();

    // 2. Merge with user's custom tickers (deduplicated)
    tickers = [...new Set([...screenerTickers, ...customTickers])];

    // 3. Show skeleton cards
    tickers.forEach(sym => { if (!stockMap[sym]) stockMap[sym] = 'loading'; });
    renderGrid();
    updateStats();

    // 4. Fetch all stock data in parallel
    const results = await Promise.allSettled(tickers.map(sym => loadOne(sym)));

    const allFailed = results.every(r => r.status === 'rejected');
    document.getElementById('error-banner').classList.toggle('hidden', !allFailed || tickers.length === 0);

    document.getElementById('loading').classList.add('hidden');
    updateStats();
    renderGrid();
    renderPortfolioSection();
}

async function loadOne(symbol) {
    stockMap[symbol] = 'loading';
    updateCardInPlace(symbol);
    try {
        const data = await fetchStockData(symbol);
        stockMap[symbol] = data;
        checkAlerts(data);
        updateStats();
        updateCardInPlace(symbol);
        renderPortfolioSection();

        // Fetch analyst data from Finnhub independently (doesn't block card render)
        fetchAnalystData(symbol).then(analyst => {
            if (stockMap[symbol]?.price) {
                stockMap[symbol].analyst = analyst;
                updateCardInPlace(symbol);
            }
        });

        return data;
    } catch (err) {
        stockMap[symbol] = { error: err.message, symbol };
        updateCardInPlace(symbol);
        throw err;
    }
}

async function fetchStockData(symbol) {
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1y&interval=1d&includePrePost=false`;
    const resp = await fetch(CORS_PROXY + encodeURIComponent(chartUrl), { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const json = await resp.json();
    if (!json.chart?.result?.[0]) throw new Error('No chart data returned');

    const result = json.chart.result[0];
    const meta   = result.meta;
    const raw    = result.indicators.quote[0];

    const closes  = raw.close.filter(Boolean);
    const volumes = raw.volume.filter(Boolean);

    if (closes.length < 15) throw new Error('Insufficient history');

    const price     = meta.regularMarketPrice || closes[closes.length - 1];
    const prevClose = meta.chartPreviousClose  || meta.previousClose || closes[closes.length - 2];
    const dailyPct  = ((price - prevClose) / prevClose) * 100;

    const low52w  = meta.fiftyTwoWeekLow  || Math.min(...closes);
    const high52w = meta.fiftyTwoWeekHigh || Math.max(...closes);
    const range52 = high52w - low52w;

    const distFromLow = range52 > 0 ? (price - low52w) / range52 : 0;
    const pctFromLow  = ((price - low52w) / low52w) * 100;

    const recentVols = volumes.slice(-20);
    const avgVolume  = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
    const curVolume  = meta.regularMarketVolume || volumes[volumes.length - 1] || 0;
    const volRatio   = avgVolume > 0 ? curVolume / avgVolume : 1;

    const rsi = calculateRSI(closes, 14);

    const recent5     = closes.slice(-5);
    const recentRange = (Math.max(...recent5) - Math.min(...recent5)) / Math.min(...recent5);
    const stabilizing = recentRange < 0.03 && dailyPct > -1.5;

    const score   = calculateReboundScore({ rsi, pctFromLow, volRatio, stabilizing });
    const signals = buildSignals({ rsi, pctFromLow, volRatio, stabilizing, dailyPct });

    return {
        symbol,
        name: meta.shortName || meta.longName || symbol,
        price, prevClose, dailyPct,
        low52w, high52w, distFromLow, pctFromLow,
        rsi, avgVolume, curVolume, volRatio,
        score, signals, stabilizing,
        analyst: null, // populated separately by fetchAnalystData
    };
}

// ── Analytics ─────────────────────────────────────────────────────────────────

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;

    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = period + 1; i < closes.length; i++) {
        const d    = closes[i] - closes[i - 1];
        const gain = d > 0 ? d : 0;
        const loss = d < 0 ? Math.abs(d) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    return Math.round((100 - (100 / (1 + avgGain / avgLoss))) * 10) / 10;
}

function calculateReboundScore({ rsi, pctFromLow, volRatio, stabilizing }) {
    let rsiScore = 0;
    if      (rsi < 20) rsiScore = 40;
    else if (rsi < 25) rsiScore = 35;
    else if (rsi < 30) rsiScore = 30;
    else if (rsi < 35) rsiScore = 20;
    else if (rsi < 40) rsiScore = 12;
    else if (rsi < 45) rsiScore = 5;

    let proxScore = 0;
    if      (pctFromLow < 1)  proxScore = 40;
    else if (pctFromLow < 3)  proxScore = 35;
    else if (pctFromLow < 5)  proxScore = 30;
    else if (pctFromLow < 10) proxScore = 20;
    else if (pctFromLow < 15) proxScore = 12;
    else if (pctFromLow < 20) proxScore = 5;

    let volScore = 0;
    if      (volRatio > 3.0) volScore = 15;
    else if (volRatio > 2.0) volScore = 12;
    else if (volRatio > 1.5) volScore = 8;
    else if (volRatio > 1.2) volScore = 4;

    return Math.min(100, rsiScore + proxScore + volScore + (stabilizing ? 5 : 0));
}

function buildSignals({ rsi, pctFromLow, volRatio, stabilizing, dailyPct }) {
    const signals = [];

    if      (rsi < 25) signals.push({ label: 'Deeply Oversold', type: 'strong' });
    else if (rsi < 30) signals.push({ label: 'Oversold RSI',    type: 'strong' });
    else if (rsi < 40) signals.push({ label: 'RSI Low',         type: 'moderate' });

    if      (pctFromLow < 2)  signals.push({ label: 'At 52W Low',    type: 'strong' });
    else if (pctFromLow < 5)  signals.push({ label: 'Near 52W Low',  type: 'strong' });
    else if (pctFromLow < 10) signals.push({ label: '<10% from Low', type: 'moderate' });

    if      (volRatio > 2.5) signals.push({ label: 'Unusual Volume', type: 'strong' });
    else if (volRatio > 1.5) signals.push({ label: 'Volume Spike',   type: 'moderate' });

    if (stabilizing)    signals.push({ label: 'Stabilizing',    type: 'info' });
    if (dailyPct > 2)   signals.push({ label: 'Bouncing Today', type: 'info' });
    else if (dailyPct < -5) signals.push({ label: 'Heavy Sell-off', type: 'moderate' });

    return signals;
}

// ── Alert Checking ────────────────────────────────────────────────────────────

function checkAlerts(data) {
    const pos = portfolio[data.symbol];
    if (!pos) return;

    const today = new Date().toISOString().slice(0, 10);

    if (pos.targetPrice && data.price >= pos.targetPrice) {
        fire(data.symbol, `target-${today}`,
            `${data.symbol} hit your target price!`,
            `$${fmt2(data.price)} reached your target of $${fmt2(pos.targetPrice)}`);
    }

    if (pos.targetGainPct) {
        const goalPrice = pos.buyPrice * (1 + pos.targetGainPct / 100);
        if (data.price >= goalPrice) {
            const actualGain = ((data.price - pos.buyPrice) / pos.buyPrice) * 100;
            fire(data.symbol, `gain-${today}`,
                `${data.symbol} up ${fmt1(actualGain)}% — goal hit!`,
                `$${fmt2(data.price)} reached your +${pos.targetGainPct}% gain target`);
        }
    }

    if (pos.alertRSI) {
        if (data.rsi < 30 && !pos.rsiWasOversold) {
            pos.rsiWasOversold = true;
            savePortfolio();
        } else if (data.rsi >= 50 && pos.rsiWasOversold) {
            pos.rsiWasOversold = false;
            savePortfolio();
            fire(data.symbol, `rsi-${today}`,
                `${data.symbol} RSI momentum shift!`,
                `RSI now ${fmt1(data.rsi)} after being oversold — trend may be reversing`);
        }
    }

    if (pos.alert52W) {
        const pctBelow52WH = ((data.high52w - data.price) / data.high52w) * 100;
        if (pctBelow52WH < 5) {
            fire(data.symbol, `52wh-${today}`,
                `${data.symbol} approaching 52W high!`,
                `$${fmt2(data.price)} is within ${fmt1(pctBelow52WH)}% of the 52W high ($${fmt2(data.high52w)})`);
        }
    }
}

function fire(symbol, alertKey, title, body) {
    const id = `${symbol}-${alertKey}`;
    if (firedAlerts.has(id)) return;
    firedAlerts.add(id);
    saveFiredAlerts();

    showToast(title, body, 'alert');

    if (Notification.permission === 'granted') {
        new Notification('Rebound Radar: ' + title, { body, tag: id });
    }

    const card = document.getElementById(`card-${symbol}`);
    if (card) {
        card.classList.add('alerted');
        card.addEventListener('animationend', () => card.classList.remove('alerted'), { once: true });
    }
}

// ── Toast System ──────────────────────────────────────────────────────────────

function showToast(title, body, type = 'info') {
    const container = document.getElementById('toast-container');
    const toastId   = 'toast-' + Date.now();
    const toast     = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.id        = toastId;

    const icon = document.createElement('div');
    icon.className   = 'toast-icon';
    icon.textContent = ({ alert: '🔔', success: '✓', info: 'ℹ' })[type] || 'ℹ';

    const content  = document.createElement('div');
    content.className = 'toast-content';
    const titleEl  = document.createElement('strong');
    titleEl.textContent = title;
    const bodyEl   = document.createElement('p');
    bodyEl.textContent = body;
    content.appendChild(titleEl);
    content.appendChild(bodyEl);

    const close = document.createElement('button');
    close.className   = 'toast-close';
    close.textContent = '✕';
    close.addEventListener('click', () => toast.remove());

    toast.appendChild(icon);
    toast.appendChild(content);
    toast.appendChild(close);
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function openTrackModal(symbol) {
    modalSymbol = symbol;
    const data = stockMap[symbol];
    const pos  = portfolio[symbol];

    document.getElementById('modal-title').textContent    = pos ? `Edit Position — ${symbol}` : `Track Purchase — ${symbol}`;
    document.getElementById('modal-subtitle').textContent = (data && data !== 'loading' && !data.error) ? data.name : '';

    document.getElementById('f-buy-price').value    = pos?.buyPrice      ?? '';
    document.getElementById('f-shares').value       = pos?.shares        ?? '';
    document.getElementById('f-target-price').value = pos?.targetPrice   ?? '';
    document.getElementById('f-target-pct').value   = pos?.targetGainPct ?? '';
    document.getElementById('f-alert-rsi').checked  = pos?.alertRSI      ?? false;
    document.getElementById('f-alert-52w').checked  = pos?.alert52W      ?? false;

    document.getElementById('modal-remove').classList.toggle('hidden', !pos);
    document.getElementById('modal-overlay').classList.remove('hidden');
    setTimeout(() => document.getElementById('f-buy-price').focus(), 50);

    if (Notification.permission === 'default') Notification.requestPermission();
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    modalSymbol = null;
}

function saveTrackEntry() {
    const buyPrice = parseFloat(document.getElementById('f-buy-price').value);
    if (!buyPrice || buyPrice <= 0) {
        const el = document.getElementById('f-buy-price');
        el.style.borderColor = 'var(--red)';
        el.focus();
        setTimeout(() => el.style.borderColor = '', 1500);
        return;
    }

    const existing = portfolio[modalSymbol] || {};
    portfolio[modalSymbol] = {
        ...existing,
        buyPrice,
        shares:        parseFloat(document.getElementById('f-shares').value)       || null,
        targetPrice:   parseFloat(document.getElementById('f-target-price').value) || null,
        targetGainPct: parseFloat(document.getElementById('f-target-pct').value)   || null,
        alertRSI:      document.getElementById('f-alert-rsi').checked,
        alert52W:      document.getElementById('f-alert-52w').checked,
        buyDate:       existing.buyDate || new Date().toISOString().slice(0, 10),
        rsiWasOversold: existing.rsiWasOversold ?? false,
    };

    savePortfolio();
    const sym = modalSymbol;
    closeModal();
    renderGrid();
    renderPortfolioSection();
    startAutoRefresh();
    showToast(`${sym} position saved`, `Tracking buy @ $${fmt2(buyPrice)}`, 'success');
}

function removeTrackEntry() {
    const sym = modalSymbol;
    delete portfolio[sym];
    savePortfolio();
    closeModal();
    renderGrid();
    renderPortfolioSection();
    if (Object.keys(portfolio).length === 0) stopAutoRefresh();
    showToast(`${sym} removed`, 'Position no longer tracked', 'info');
}

// ── Portfolio Summary Section ─────────────────────────────────────────────────

function renderPortfolioSection() {
    const section = document.getElementById('portfolio-section');
    const keys    = Object.keys(portfolio);
    if (keys.length === 0) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');

    let totalInvested = 0, totalValue = 0, hasDollarTotals = false;

    const rows = keys.map(sym => {
        const pos  = portfolio[sym];
        const data = stockMap[sym];

        if (!data || data === 'loading') {
            return `<div class="portfolio-row loading-row"><span class="pr-sym">${escHtml(sym)}</span><span class="pr-muted">Loading…</span></div>`;
        }
        if (data.error) {
            return `<div class="portfolio-row loading-row"><span class="pr-sym">${escHtml(sym)}</span><span class="pr-muted">Failed to load</span><button class="pr-edit" data-sym="${escHtml(sym)}">Retry / Edit</button></div>`;
        }

        const pnlPct = ((data.price - pos.buyPrice) / pos.buyPrice) * 100;
        const isUp   = pnlPct >= 0;
        const sign   = isUp ? '+' : '';
        const targetText = buildTargetText(pos);

        if (pos.shares) {
            const invested = pos.buyPrice * pos.shares;
            const value    = data.price * pos.shares;
            const pnlUsd   = value - invested;
            totalInvested += invested;
            totalValue    += value;
            hasDollarTotals = true;
            return `<div class="portfolio-row" data-sym="${escHtml(sym)}">
                <div class="pr-left"><span class="pr-sym">${escHtml(sym)}</span><span class="pr-name">${escHtml(data.name)}</span></div>
                <div class="pr-mid"><span class="pr-label">Bought</span><span class="pr-val">$${fmt2(pos.buyPrice)} × ${pos.shares}</span></div>
                <div class="pr-mid"><span class="pr-label">Now</span><span class="pr-val">$${fmt2(data.price)}</span></div>
                <div class="pr-mid"><span class="pr-label">Value</span><span class="pr-val">$${fmt2(value)}</span></div>
                <div class="pr-pnl ${isUp ? 'up' : 'down'}">${sign}${fmt1(pnlPct)}%<span class="pr-pnl-dollar">${sign}$${fmt2(pnlUsd)}</span></div>
                ${targetText ? `<span class="pr-target">${escHtml(targetText)}</span>` : ''}
                <button class="pr-edit" data-sym="${escHtml(sym)}">Edit</button>
            </div>`;
        }

        return `<div class="portfolio-row" data-sym="${escHtml(sym)}">
            <div class="pr-left"><span class="pr-sym">${escHtml(sym)}</span><span class="pr-name">${escHtml(data.name)}</span></div>
            <div class="pr-mid"><span class="pr-label">Bought</span><span class="pr-val">$${fmt2(pos.buyPrice)}</span></div>
            <div class="pr-mid"><span class="pr-label">Now</span><span class="pr-val">$${fmt2(data.price)}</span></div>
            <div class="pr-pnl ${isUp ? 'up' : 'down'}">${sign}${fmt1(pnlPct)}%</div>
            ${targetText ? `<span class="pr-target">${escHtml(targetText)}</span>` : ''}
            <button class="pr-edit" data-sym="${escHtml(sym)}">Edit</button>
        </div>`;
    });

    document.getElementById('portfolio-rows').innerHTML = rows.join('');

    const totalsEl = document.getElementById('portfolio-totals');
    if (hasDollarTotals) {
        const totalPnl    = totalValue - totalInvested;
        const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
        const isUp        = totalPnl >= 0;
        document.getElementById('port-invested').textContent = `$${fmt2(totalInvested)}`;
        document.getElementById('port-value').textContent    = `$${fmt2(totalValue)}`;
        const pnlEl = document.getElementById('port-pnl');
        pnlEl.textContent = `${isUp ? '+' : ''}$${fmt2(totalPnl)} (${isUp ? '+' : ''}${fmt1(totalPnlPct)}%)`;
        pnlEl.className   = `port-pnl-val ${isUp ? 'up' : 'down'}`;
        totalsEl.classList.remove('hidden');
    } else {
        totalsEl.classList.add('hidden');
    }

    section.querySelectorAll('.pr-edit').forEach(btn => {
        btn.addEventListener('click', () => openTrackModal(btn.dataset.sym));
    });
}

function buildTargetText(pos) {
    const parts = [];
    if (pos.targetPrice)   parts.push(`Target $${fmt2(pos.targetPrice)}`);
    if (pos.targetGainPct) parts.push(`+${pos.targetGainPct}% goal`);
    if (pos.alertRSI)      parts.push('RSI alert');
    if (pos.alert52W)      parts.push('52W high alert');
    return parts.join(' · ');
}

// ── Auto Refresh ──────────────────────────────────────────────────────────────

function startAutoRefresh() {
    if (autoRefreshTimer) return;
    if (Object.keys(portfolio).length === 0) return;

    countdownRemaining = AUTO_REFRESH_MS / 1000;
    updateCountdown();
    countdownTimer   = setInterval(() => { countdownRemaining -= 1; updateCountdown(); }, 1000);
    autoRefreshTimer = setInterval(() => { loadAll(true); countdownRemaining = AUTO_REFRESH_MS / 1000; }, AUTO_REFRESH_MS);
    document.getElementById('refresh-countdown').classList.remove('hidden');
}

function stopAutoRefresh() {
    clearInterval(autoRefreshTimer);
    clearInterval(countdownTimer);
    autoRefreshTimer = countdownTimer = null;
    document.getElementById('refresh-countdown').classList.add('hidden');
}

function updateCountdown() {
    const m = Math.floor(countdownRemaining / 60);
    const s = countdownRemaining % 60;
    document.getElementById('refresh-countdown').textContent =
        `Auto-refresh in ${m}:${String(s).padStart(2, '0')}`;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderGrid() {
    const grid = document.getElementById('stock-grid');

    let entries = tickers.map(sym => ({ sym, data: stockMap[sym] }));

    if (currentFilter !== 'all') {
        entries = entries.filter(({ sym, data }) => {
            if (!data || data === 'loading' || data.error) return true;
            if (currentFilter === 'tracked')  return !!portfolio[sym];
            if (currentFilter === 'high')     return data.score >= 60;
            if (currentFilter === 'oversold') return data.rsi < 30;
            if (currentFilter === 'near-low') return data.pctFromLow < 5;
            return true;
        });
    }

    entries.sort((a, b) => {
        const aOk = a.data && a.data !== 'loading' && !a.data.error;
        const bOk = b.data && b.data !== 'loading' && !b.data.error;
        if (!aOk && !bOk) return 0;
        if (!aOk) return 1;
        if (!bOk) return -1;
        switch (currentSort) {
            case 'score':     return b.data.score      - a.data.score;
            case 'rsi':       return a.data.rsi        - b.data.rsi;
            case 'proximity': return a.data.pctFromLow - b.data.pctFromLow;
            case 'change':    return a.data.dailyPct   - b.data.dailyPct;
            case 'volume':    return b.data.volRatio   - a.data.volRatio;
            default:          return 0;
        }
    });

    grid.innerHTML = entries.map(({ sym, data }) => buildCard(sym, data)).join('');

    grid.querySelectorAll('.remove-btn').forEach(b => b.addEventListener('click', () => removeTicker(b.dataset.sym)));
    grid.querySelectorAll('.retry-btn').forEach(b => b.addEventListener('click', () => loadOne(b.dataset.sym)));
    grid.querySelectorAll('.track-btn').forEach(b => b.addEventListener('click', () => openTrackModal(b.dataset.sym)));

    const anyLoaded = entries.some(({ data }) => data && data !== 'loading' && !data.error);
    document.getElementById('empty-state').classList.toggle('hidden', anyLoaded || currentFilter === 'all');
}

function updateCardInPlace(symbol) {
    const existing = document.getElementById(`card-${symbol}`);
    if (!existing) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = buildCard(symbol, stockMap[symbol]);
    const newCard = wrap.firstElementChild;
    existing.replaceWith(newCard);
    newCard.querySelectorAll('.remove-btn').forEach(b => b.addEventListener('click', () => removeTicker(b.dataset.sym)));
    newCard.querySelectorAll('.retry-btn').forEach(b => b.addEventListener('click', () => loadOne(b.dataset.sym)));
    newCard.querySelectorAll('.track-btn').forEach(b => b.addEventListener('click', () => openTrackModal(b.dataset.sym)));
    newCard.querySelectorAll('.analyst-key-link').forEach(b => b.addEventListener('click', e => { e.preventDefault(); toggleSettings(); }));
}

function buildCard(symbol, data) {
    if (!data || data === 'loading') {
        return `<div class="stock-card loading-card" id="card-${symbol}">
            <div class="card-placeholder"><div class="spinner"></div><span>${escHtml(symbol)}</span></div>
        </div>`;
    }

    if (data.error) {
        return `<div class="stock-card error-card" id="card-${symbol}">
            <div class="card-top">
                <div class="card-ticker"><a class="ticker-symbol" href="https://finance.yahoo.com/quote/${escHtml(symbol)}" target="_blank" rel="noopener">${escHtml(symbol)}</a></div>
                <button class="remove-btn" data-sym="${escHtml(symbol)}" title="Remove">✕</button>
            </div>
            <div class="card-error-msg">
                <p>Failed to load data</p>
                <p style="font-size:10px;margin-top:4px;opacity:.6">${escHtml(data.error)}</p>
                <button class="retry-btn" data-sym="${escHtml(symbol)}">Retry</button>
            </div>
        </div>`;
    }

    const { name, price, dailyPct, low52w, high52w, distFromLow, pctFromLow,
            rsi, volRatio, curVolume, avgVolume, score, signals } = data;

    const pos       = portfolio[symbol];
    const isTracked = !!pos;
    const isCustom  = customTickers.includes(symbol);

    const scoreTier  = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
    const scoreLabel = score >= 70 ? 'High' : score >= 40 ? 'Moderate' : 'Low';

    const rsiClass = rsi < 30 ? 'oversold' : rsi > 70 ? 'overbought' : 'neutral';
    const rsiColor = rsi < 30 ? 'green' : rsi > 70 ? 'red' : 'accent';

    const changeClass = dailyPct >= 0 ? 'positive' : 'negative';
    const changeSign  = dailyPct >= 0 ? '+' : '';
    const volColor    = volRatio > 2.5 ? 'green' : volRatio > 1.5 ? 'yellow' : '';

    const badgeHTML = signals.map(s =>
        `<span class="badge ${s.type}">${escHtml(s.label)}</span>`
    ).join('');

    let pnlRow = '';
    if (pos) {
        const pnlPct = ((price - pos.buyPrice) / pos.buyPrice) * 100;
        const isUp   = pnlPct >= 0;
        const sign   = isUp ? '+' : '';
        let dollarPart = '';
        if (pos.shares) {
            const pnlUsd = (price - pos.buyPrice) * pos.shares;
            dollarPart = `<span class="pnl-dollar">${sign}$${fmt2(pnlUsd)}</span>`;
        }
        pnlRow = `<div class="card-pnl-row ${isUp ? 'up' : 'down'}">
            <span class="pnl-label">Bought @ $${fmt2(pos.buyPrice)}${pos.shares ? ` × ${pos.shares}` : ''}</span>
            <span class="pnl-pct">${sign}${fmt1(pnlPct)}%</span>
            ${dollarPart}
        </div>`;
    }

    const trackedBadge  = isTracked ? `<span class="tracked-badge">★ Tracked</span>` : '';
    // Small label differentiating screener-sourced vs user-added cards
    const sourceBadge   = isCustom && !screenerTickers.includes(symbol)
        ? `<span class="source-badge">Added</span>`
        : '';

    return `
    <div class="stock-card score-${scoreTier}${isTracked ? ' is-tracked' : ''}" id="card-${symbol}">
        <div class="card-top">
            <div class="card-ticker">
                <a class="ticker-symbol" href="https://finance.yahoo.com/quote/${escHtml(symbol)}" target="_blank" rel="noopener">${escHtml(symbol)}</a>
                <span class="ticker-name" title="${escHtml(name)}">${escHtml(name)}</span>
                ${trackedBadge}${sourceBadge}
            </div>
            <div class="card-score">
                <div class="score-circle ${scoreTier}">${Math.round(score)}</div>
                <span class="score-label">${scoreLabel}</span>
            </div>
        </div>

        <div class="card-price-row">
            <span class="price-main">$${fmt2(price)}</span>
            <span class="price-change ${changeClass}">${changeSign}${fmt2(dailyPct)}%</span>
        </div>

        ${pnlRow}

        <div class="metrics">
            <div class="metric">
                <div class="metric-label">RSI (14)</div>
                <div class="metric-value ${rsiColor}">${fmt1(rsi)}</div>
            </div>
            <div class="metric">
                <div class="metric-label">% from 52W Low</div>
                <div class="metric-value ${pctFromLow < 5 ? 'green' : pctFromLow < 10 ? 'yellow' : ''}">
                    +${fmt1(pctFromLow)}%
                </div>
            </div>
            <div class="metric">
                <div class="metric-label">52W Low</div>
                <div class="metric-value">$${fmt2(low52w)}</div>
            </div>
            <div class="metric">
                <div class="metric-label">52W High</div>
                <div class="metric-value">$${fmt2(high52w)}</div>
            </div>
        </div>

        <div class="progress-section">
            <div class="progress-row">
                <span class="progress-label">RSI</span>
                <span class="progress-val ${rsiColor}">${fmt1(rsi)}</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill rsi-fill ${rsiClass}" style="width:${Math.min(100,rsi)}%"></div>
            </div>
            <div class="progress-row">
                <span class="progress-label">52W Position (Low → High)</span>
                <span class="progress-val">${Math.round(distFromLow * 100)}%</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill position-fill" style="width:${Math.round(distFromLow * 100)}%"></div>
            </div>
        </div>

        ${badgeHTML ? `<div class="signals">${badgeHTML}</div>` : ''}

        ${buildAnalystHTML(data.analyst)}

        <div class="card-footer">
            <span class="vol-info">
                Vol: <span class="${volColor}">${formatVolume(curVolume)}</span>
                &nbsp;·&nbsp; Avg: ${formatVolume(avgVolume)}
                &nbsp;·&nbsp; <span class="${volColor}">${fmt1(volRatio)}×</span>
            </span>
            <div class="card-footer-actions">
                <button class="track-btn${isTracked ? ' is-tracked' : ''}" data-sym="${escHtml(symbol)}">
                    ${isTracked ? '★ Edit' : '☆ Track'}
                </button>
                <button class="remove-btn" data-sym="${escHtml(symbol)}" title="Remove ${escHtml(symbol)}">✕</button>
            </div>
        </div>
    </div>`;
}

// ── Finnhub Analyst Fetch ─────────────────────────────────────────────────────

function loadAnalystCache() {
    try { return JSON.parse(localStorage.getItem(ANALYST_CACHE_KEY) || '{}'); } catch (_) { return {}; }
}

function saveAnalystCache(cache) {
    try { localStorage.setItem(ANALYST_CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
}

async function fetchAnalystData(symbol) {
    if (!finnhubKey) return { noKey: true };

    // Return cached result if it's less than 24 hours old
    const cache  = loadAnalystCache();
    const cached = cache[symbol];
    if (cached && (Date.now() - cached.ts) < ANALYST_TTL_MS) {
        return cached.data;
    }

    try {
        const resp = await fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${finnhubKey}`);

        if (!resp.ok) {
            console.warn(`[analyst] Finnhub ${resp.status} for ${symbol}`);
            return { unavailable: true };
        }

        const recs   = await resp.json();
        const latest = Array.isArray(recs) ? recs[0] : null;
        if (!latest) return { noKey: false, unavailable: false, rating: null, numAnalysts: null };

        const sb = latest.strongBuy  || 0;
        const b  = latest.buy        || 0;
        const h  = latest.hold       || 0;
        const s  = latest.sell       || 0;
        const ss = latest.strongSell || 0;
        const numAnalysts = sb + b + h + s + ss;

        let rating = null;
        if (numAnalysts > 0) {
            const score = (sb * 5 + b * 4 + h * 3 + s * 2 + ss * 1) / numAnalysts;
            if      (score >= 4.5) rating = 'strongBuy';
            else if (score >= 3.5) rating = 'buy';
            else if (score >= 2.5) rating = 'hold';
            else if (score >= 1.5) rating = 'underperform';
            else                   rating = 'sell';
        }

        const result = { noKey: false, unavailable: false, rating, numAnalysts, breakdown: { sb, b, h, s, ss } };
        cache[symbol] = { data: result, ts: Date.now() };
        saveAnalystCache(cache);
        return result;
    } catch (err) {
        console.warn(`[analyst] Finnhub failed for ${symbol}:`, err);
        return { unavailable: true };
    }
}

// ── Settings ──────────────────────────────────────────────────────────────────

function toggleSettings() {
    document.getElementById('settings-panel').classList.toggle('hidden');
}

function saveSettings() {
    const val = document.getElementById('finnhub-key').value.trim();
    if (!val) return;
    finnhubKey = val;
    localStorage.setItem(FINNHUB_KEY, val);
    updateSettingsStatus();
    document.getElementById('settings-panel').classList.add('hidden');
    showToast('API key saved', 'Analyst data will load on next refresh', 'success');
    loadAll(true);
}

function clearSettings() {
    finnhubKey = '';
    localStorage.removeItem(FINNHUB_KEY);
    document.getElementById('finnhub-key').value = '';
    updateSettingsStatus();
    showToast('API key cleared', 'Analyst data disabled', 'info');
}

function updateSettingsStatus() {
    const el = document.getElementById('settings-status');
    if (!el) return;
    el.textContent = finnhubKey ? '✓ Key saved — analyst data enabled' : 'No key set — analyst data hidden';
    el.className   = `settings-status ${finnhubKey ? 'ok' : ''}`;
}

// ── Analyst Display ───────────────────────────────────────────────────────────

const RATING_META = {
    strongBuy:    { label: 'Strong Buy',   cls: 'strong-buy' },
    buy:          { label: 'Buy',          cls: 'buy'        },
    hold:         { label: 'Hold',         cls: 'hold'       },
    underperform: { label: 'Underperform', cls: 'sell'       },
    sell:         { label: 'Sell',         cls: 'sell'       },
};

function buildAnalystHTML(analyst) {
    const header = (countLabel = '') => `
        <div class="analyst-section">
            <div class="analyst-header">
                <span class="analyst-title">Analyst Consensus</span>
                ${countLabel}
            </div>`;

    // Still loading
    if (!analyst) {
        if (!finnhubKey) return ''; // no key, hide entirely
        return header() + `<p class="analyst-na">Loading…</p></div>`;
    }

    // No API key configured
    if (analyst.noKey) {
        return header() + `<p class="analyst-na"><a href="#" class="analyst-key-link">Add Finnhub key</a> for ratings &amp; targets</p></div>`;
    }

    // API returned but no data for this stock
    if (analyst.unavailable || (!analyst.rating && !analyst.targetMean && !analyst.numAnalysts)) {
        return header() + `<p class="analyst-na">No analyst coverage</p></div>`;
    }

    const meta = RATING_META[analyst.rating] || null;

    const ratingBadge = meta
        ? `<span class="analyst-badge ${meta.cls}">${meta.label}</span>`
        : '';

    const countLabel = analyst.numAnalysts
        ? `<span class="analyst-count">${analyst.numAnalysts} analyst${analyst.numAnalysts !== 1 ? 's' : ''}</span>`
        : '';

    // Breakdown bar (strongBuy + buy | hold | sell + strongSell)
    let breakdownBar = '';
    if (analyst.breakdown && analyst.numAnalysts > 0) {
        const { sb, b, h, s, ss } = analyst.breakdown;
        const total  = analyst.numAnalysts;
        const bullPct  = Math.round((sb + b)  / total * 100);
        const holdPct  = Math.round(h          / total * 100);
        const bearPct  = 100 - bullPct - holdPct;
        breakdownBar = `
        <div class="analyst-breakdown">
            <div class="breakdown-bar">
                <div class="bb-bull"  style="width:${bullPct}%"  title="Buy: ${sb+b}"></div>
                <div class="bb-hold"  style="width:${holdPct}%" title="Hold: ${h}"></div>
                <div class="bb-bear"  style="width:${bearPct}%"  title="Sell: ${s+ss}"></div>
            </div>
            <div class="breakdown-labels">
                <span class="green">${sb + b} Buy</span>
                <span class="muted">${h} Hold</span>
                <span class="red">${s + ss} Sell</span>
            </div>
        </div>`;
    }

    return header(countLabel) + `
        <div class="analyst-row">${ratingBadge}</div>
        ${breakdownBar}
    </div>`;
}

// ── Stats Bar ─────────────────────────────────────────────────────────────────

function updateStats() {
    const resolved = Object.values(stockMap).filter(d => d && d !== 'loading' && !d.error);
    document.getElementById('total-count').textContent      = tickers.length;
    document.getElementById('near-low-count').textContent   = resolved.filter(d => d.pctFromLow < 5).length;
    document.getElementById('oversold-count').textContent   = resolved.filter(d => d.rsi < 30).length;
    document.getElementById('high-score-count').textContent = resolved.filter(d => d.score >= 70).length;
    document.getElementById('last-updated').textContent     =
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Ticker Management ─────────────────────────────────────────────────────────

function handleAdd() {
    const input  = document.getElementById('ticker-input');
    const symbol = input.value.trim().toUpperCase().replace(/[^A-Z.]/g, '');
    if (!symbol) return;
    input.value = '';

    if (tickers.includes(symbol)) return;

    if (!customTickers.includes(symbol)) {
        customTickers.push(symbol);
        saveCustomTickers();
    }
    tickers.push(symbol);
    document.getElementById('error-banner').classList.add('hidden');
    stockMap[symbol] = 'loading';
    updateStats();
    renderGrid();
    loadOne(symbol);
}

function removeTicker(symbol) {
    tickers = tickers.filter(t => t !== symbol);
    delete stockMap[symbol];

    // Remove from custom list if it was user-added
    customTickers = customTickers.filter(t => t !== symbol);
    saveCustomTickers();

    if (portfolio[symbol]) {
        delete portfolio[symbol];
        savePortfolio();
    }
    updateStats();
    renderGrid();
    renderPortfolioSection();
}

// ── Persistence ───────────────────────────────────────────────────────────────

function loadCustomTickers() {
    try {
        const s = localStorage.getItem(CUSTOM_KEY);
        return s ? JSON.parse(s) : [];
    } catch (_) { return []; }
}

function saveCustomTickers() {
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(customTickers)); } catch (_) {}
}

function loadPortfolio() {
    try {
        const s = localStorage.getItem(PORTFOLIO_KEY);
        return s ? JSON.parse(s) : {};
    } catch (_) { return {}; }
}

function savePortfolio() {
    try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(portfolio)); } catch (_) {}
}

function loadFiredAlerts() {
    try {
        const s = localStorage.getItem(FIRED_KEY);
        return new Set(s ? JSON.parse(s) : []);
    } catch (_) { return new Set(); }
}

function saveFiredAlerts() {
    try { localStorage.setItem(FIRED_KEY, JSON.stringify([...firedAlerts].slice(-500))); } catch (_) {}
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt2(n) { return Number(n).toFixed(2); }
function fmt1(n) { return Number(n).toFixed(1); }

function formatVolume(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return String(Math.round(n));
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
