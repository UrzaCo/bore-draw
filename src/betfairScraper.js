import {Action, Betfair, Bookie, State} from "./constants"
import {debug} from "./logger";
import {awaitPageLoad, awaitMultiElementLoad, normaliseLeague} from "./util";

const scrapeStateKey = 'scrapeState' + Bookie.BETFAIR;

(() => {
    if (location.href === Betfair.SOCCER_HOMEPAGE) {
        awaitPageLoad('.navigation-content', () => {
            const allLink = document.querySelector('a[data-nodeid=ALL_FOOTBALL]')
            if (allLink) {
                allLink.click()

                awaitLinkLoading('COMPETITION_REGION', processNextRegion)
            }
        })
    } else if (location.href.startsWith(Betfair.SOCCER_GAME_PAGE)) {
        const processPage = () => processGamePage(true)
        awaitMultiElementLoad('bf-mini-market-container', processPage, 500, 5)
    }


    /**
     * Betfair loads the left hand navigation via ajax. This function lets us wait until a given type
     * of link appears to have been fully loaded before proceeding with a required action
     *
     * @param type
     * @param callback
     * @param timeout
     */
    function awaitLinkLoading(type, callback, timeout = 0) {
        awaitMultiElementLoad(`a[link-type=${type}]`, callback, 500, 5)
    }

    /**
     * Process the next game based on the internal state tracking
     */
    function processNextGame() {
        chrome.storage.local.get(scrapeStateKey, storage => {
            const nextGameIndex = storage[scrapeStateKey].gameIndex || 0
            const games = document.querySelectorAll('a[link-type=EVENT]')

            if (games.item(nextGameIndex)) {
                games.item(nextGameIndex).click()
                awaitMultiElementLoad('bf-mini-market-container', processGamePage, 250, 10)
            } else {
                // Click back to the region, then process the next league
                debug("Moving on to the next league");

                chrome.storage.local.set({
                    [scrapeStateKey]: {
                        ...storage[scrapeStateKey],
                        leagueIndex: (storage[scrapeStateKey].leagueIndex || 0) + 1,
                        gameIndex: 0
                    }
                }, () => {
                    chrome.runtime.sendMessage({action: Action.SCRAPE_STATE_UPDATED, bookie: Bookie.BETFAIR})
                    awaitPageLoad('a[link-type=COMPETITION_REGION]', () => {
                        document.querySelector('a[link-type=COMPETITION_REGION]').click();
                        awaitLinkLoading('COMP', processNextLeague, 5)
                    })
                })
            }
        })
    }

    /**
     * Process the next league based on the internal state tracking
     */
    function processNextLeague() {
        chrome.storage.local.get(scrapeStateKey, storage => {
            const state = storage[scrapeStateKey];
            const nextLeagueIndex = state.leagueIndex || 0
            const leagues = document.querySelectorAll('a[link-type=COMP]')

            if (leagues.item(nextLeagueIndex)) {
                leagues.item(nextLeagueIndex).click()
                awaitLinkLoading('EVENT', processNextGame, 5)
            } else {
                chrome.storage.local.set({
                    [scrapeStateKey]: {
                        ...state,
                        regionIndex: (state.regionIndex || 0) + 1,
                        leagueIndex: 0,
                        gameIndex: 0,
                        stopped: Date.now(),
                        tabId: null,
                        state: State.INACTIVE
                    }
                }, () => {
                    chrome.runtime.sendMessage({action: Action.SCRAPE_STATE_UPDATED, bookie: Bookie.BETFAIR})
                    chrome.runtime.sendMessage({ action: Action.REMOVE_TAB })
                })
            }
        })
    }

    /**
     * Process the next region based on the internal state tracking
     */
    function processNextRegion() {
        chrome.storage.local.get(scrapeStateKey, storage => {
            const regionIndex = storage[scrapeStateKey].regionIndex || 0
            debug(`Processing region index: ${regionIndex}`)
            const regions = document.querySelectorAll('a[link-type=COMPETITION_REGION]')

            if (regions.item(regionIndex)) {
                debug("Clicking through to region: ", regions.item(regionIndex).innerText)
                regions.item(regionIndex).click()
                awaitLinkLoading('COMP', processNextLeague, 5)
            } else {
                debug("Final region processed. Returning to start");
                chrome.storage.local.set({
                    [scrapeStateKey]: {
                        regionIndex: 0,
                        leagueIndex: 0,
                        gameIndex: 0,
                        tabId: null
                    }
                }, () => {
                    chrome.runtime.sendMessage({action: Action.SCRAPE_STATE_UPDATED, bookie: Bookie.BETFAIR})
                    processNextRegion()
                })
            }
        })
    }

    function processGamePage(standalone = false) {
        debug("Processing game page")
        chrome.storage.local.get([scrapeStateKey, 'betfairData'] , storage => {
            let data = storage.betfairData || {}

            try {
                const marketStatus = document.querySelector('.market-status-label')?.innerText;

                if (marketStatus !== "In-Play") {
                    const league = normaliseLeague(document.querySelector('a[link-type=COMP]')?.innerText);
                    const teams = document.querySelector('span.title').innerText.split(' v ');
                    const matchTime = document.querySelector('.date')?.innerText;
                    const markets = document.querySelectorAll('bf-mini-market-container');
                    const correctScoreMarket = Array.from(markets).find(
                        market => market.querySelector('.market-name-label').innerText.toLowerCase() === 'correct score'
                    );

                    let scoreData = [];
                    if (!correctScoreMarket) {
                        debug("Correct score market not found")
                    } else {
                        Array.from(correctScoreMarket.querySelectorAll('.runner-line')).forEach(scoreLine => {
                            const score = scoreLine.querySelector('.runner-name').innerText;
                            const layOdds = parseFloat(scoreLine.querySelector('button.lay .bet-button-price').innerText);
                            const liquidity = parseFloat(scoreLine.querySelector('button.lay .bet-button-size').innerText.replace('$', ''));

                            scoreData.push({score, odds: layOdds, liquidity})
                        })
                    }

                    data[league] = data[league] || []
                    const game = {
                        league: league,
                        teamA: teams[0],
                        teamB: teams[1],
                        scores: scoreData,
                        url: location.href,
                        matchTime: matchTime ? Date.parse(matchTime + "2022") : null,
                        scrapeTime: Date.now()
                    }
                    const existingIndex = data[league].findIndex(item => item.url === game.url);
                    if (existingIndex >= 0) {
                        debug("Replacing existing game at ", existingIndex, ": ", game);
                        data[league][existingIndex] = game;
                    } else {
                        debug("Adding as new game: ", game);
                        data[league].push(game)
                    }

                    chrome.runtime.sendMessage({action: Action.SCRAPED_GAME, bookie: Bookie.BETFAIR, game})
                    chrome.runtime.sendMessage({action: Action.SCRAPE_STATE_UPDATED, bookie: Bookie.BETFAIR})
                }
            } catch (e) {
                console.error("Failed to collect game data: ", e)
            }

            // Click back to the league, then process the next game
            let storageData = { betfairData: data }
            if (!standalone) {
                storageData[scrapeStateKey] = { ...storage[scrapeStateKey], gameIndex: storage[scrapeStateKey].gameIndex + 1 }
            }

            chrome.storage.local.set(storageData, () => {
                if (standalone) {
                    chrome.runtime.sendMessage({ action: Action.REMOVE_TAB })
                } else {
                    chrome.runtime.sendMessage({action: Action.SCRAPE_STATE_UPDATED, bookie: Bookie.BETFAIR})
                    document.querySelector('a[link-type=COMP]').click();
                    awaitLinkLoading('EVENT', processNextGame)
                }
            })
        })
    }
})()
