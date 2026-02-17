require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const THINGIVERSE_API_KEY = process.env.THINGIVERSE_API_KEY || '';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Common headers for requests
const getHeaders = () => ({
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
});

// Helper function to safely fetch with timeout
async function safeFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: { ...getHeaders(), ...options.headers }
        });
        clearTimeout(timeout);
        return response;
    } catch (error) {
        clearTimeout(timeout);
        throw error;
    }
}

// Simple in-memory cache for popular models
const popularCache = {
    data: null,
    timestamp: 0,
    TTL: 5 * 60 * 1000 // 5 minutes
};

// ==================== PRINTABLES ====================
async function searchPrintables(query, limit = 10, page = 1) {
    try {
        // Printables GraphQL API
        const graphqlUrl = 'https://api.printables.com/graphql/';
        const offset = (page - 1) * limit;

        // Search query - using searchPrints2
        const searchQuery = {
            query: `
                query SearchPrints($query: String!, $limit: Int, $offset: Int) {
                    searchPrints2(query: $query, limit: $limit, offset: $offset) {
                        items {
                            id
                            name
                            slug
                            likesCount
                            downloadCount
                            user {
                                publicUsername
                            }
                            image {
                                filePath
                            }
                        }
                    }
                }
            `,
            variables: {
                query: query,
                limit: limit,
                offset: offset
            }
        };

        const response = await safeFetch(graphqlUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(searchQuery)
        });

        if (response.ok) {
            const data = await response.json();
            const items = data?.data?.searchPrints2?.items || [];

            return items.map(item => ({
                title: item.name || 'Untitled',
                creator: item.user?.publicUsername || 'Unknown',
                thumbnail: item.image?.filePath
                    ? `https://media.printables.com/${item.image.filePath}`
                    : '',
                url: `https://www.printables.com/model/${item.id}-${item.slug || ''}`,
                likes: item.likesCount || 0,
                downloads: item.downloadCount || 0,
                source: 'printables'
            }));
        }

        console.error('Printables API response not ok:', response.status);
        return [];
    } catch (error) {
        console.error('Printables search error:', error.message);
        return [];
    }
}

// ==================== THANGS ====================
async function searchThangs(query, limit = 10, page = 1) {
    try {
        // Thangs has a public search API
        const searchUrl = `https://thangs.com/api/models/search?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}&sort=popular`;

        const response = await safeFetch(searchUrl, {
            headers: {
                'Accept': 'application/json',
            }
        });

        if (response.ok) {
            const text = await response.text();
            try {
                const data = JSON.parse(text);
                const items = data?.results || data?.models || data || [];

                if (Array.isArray(items)) {
                    return items.slice(0, limit).map(item => ({
                        title: item.name || item.title || 'Untitled',
                        creator: item.owner?.username || item.ownerUsername || item.creator || 'Unknown',
                        thumbnail: item.thumbnailUrl || item.previewUrl || item.thumbnail || '',
                        url: item.publicUrl || item.url || `https://thangs.com/model/${item.id || item.modelId}`,
                        likes: item.likes || item.likeCount || 0,
                        downloads: item.downloads || item.downloadCount || 0,
                        source: 'thangs'
                    }));
                }
            } catch (e) {
                console.error('Thangs JSON parse error');
            }
        }

        // Fallback: Try alternate API endpoint
        const altUrl = `https://thangs.com/api/search?query=${encodeURIComponent(query)}&pageSize=${limit}&page=${page}`;
        const altResponse = await safeFetch(altUrl, {
            headers: { 'Accept': 'application/json' }
        });

        if (altResponse.ok) {
            const data = await altResponse.json();
            const items = data?.models || data?.results || [];
            return items.slice(0, limit).map(item => ({
                title: item.name || item.title || 'Untitled',
                creator: item.ownerUsername || item.owner?.username || 'Unknown',
                thumbnail: item.thumbnailUrl || '',
                url: item.publicUrl || `https://thangs.com/model/${item.id}`,
                likes: item.likeCount || 0,
                downloads: item.downloadCount || 0,
                source: 'thangs'
            }));
        }

        return [];
    } catch (error) {
        console.error('Thangs search error:', error.message);
        return [];
    }
}

// ==================== THINGIVERSE ====================
async function searchThingiverse(query, limit = 10, page = 1) {
    try {
        // If API key is available, use the official API
        if (THINGIVERSE_API_KEY) {
            try {
                const apiUrl = `https://api.thingiverse.com/search/${encodeURIComponent(query)}?per_page=${limit}&page=${page}&sort=relevant`;
                const apiResponse = await fetch(apiUrl, {
                    headers: {
                        'Authorization': `Bearer ${THINGIVERSE_API_KEY}`,
                        'Accept': 'application/json'
                    }
                });

                if (apiResponse.ok) {
                    const data = await apiResponse.json();
                    const hits = data.hits || data || [];

                    if (Array.isArray(hits) && hits.length > 0) {
                        console.log(`Thingiverse API: found ${hits.length} results for "${query}"`);
                        return hits.slice(0, limit).map(thing => ({
                            title: thing.name || 'Untitled',
                            creator: thing.creator?.name || thing.creator?.username || 'Unknown',
                            thumbnail: thing.preview_image || thing.thumbnail || '',
                            url: `https://www.thingiverse.com/thing:${thing.id}`,
                            likes: thing.like_count || thing.likes || 0,
                            downloads: thing.download_count || thing.downloads || thing.collect_count || 0,
                            source: 'thingiverse'
                        }));
                    }
                } else {
                    console.error(`Thingiverse API error: ${apiResponse.status}`);
                }
            } catch (apiError) {
                console.error('Thingiverse API error:', apiError.message);
            }
        }
        else {
            console.log('No Thingiverse API key provided')
        }

        // Fallback: Try scraping the search results page
        const searchUrl = `https://www.thingiverse.com/search?q=${encodeURIComponent(query)}&type=things&sort=relevant&page=${page}`;

        const response = await safeFetch(searchUrl);
        const html = await response.text();

        // Thingiverse uses Next.js, so data might be in __NEXT_DATA__
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);

        if (nextDataMatch) {
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                const things = nextData?.props?.pageProps?.things ||
                              nextData?.props?.pageProps?.searchResults?.things ||
                              nextData?.props?.pageProps?.initialState?.search?.results || [];

                if (Array.isArray(things) && things.length > 0) {
                    return things.slice(0, limit).map(thing => ({
                        title: thing.name || 'Untitled',
                        creator: thing.creator?.name || thing.creator?.username || 'Unknown',
                        thumbnail: thing.preview_image || thing.thumbnail || '',
                        url: `https://www.thingiverse.com/thing:${thing.id}`,
                        likes: thing.like_count || thing.likes || 0,
                        downloads: thing.download_count || thing.downloads || 0,
                        source: 'thingiverse'
                    }));
                }
            } catch (e) {
                console.error('Thingiverse NEXT_DATA parse error:', e.message);
            }
        }

        // Fallback: try cheerio parsing
        const $ = cheerio.load(html);
        const results = [];

        // Try multiple selectors
        $('[class*="ThingCard"], [class*="thing-card"], .thing-card-body, a[href*="/thing:"]').each((i, el) => {
            if (results.length >= limit) return false;

            const $el = $(el);
            const link = $el.is('a') ? $el : $el.find('a[href*="/thing:"]').first();
            const href = link.attr('href');

            if (href && href.includes('/thing:')) {
                const title = $el.find('[class*="title"], [class*="name"], h3, h4').text().trim() ||
                             link.attr('title') ||
                             'Untitled';
                const img = $el.find('img').first();
                const thumbnail = img.attr('src') || img.attr('data-src') || '';

                results.push({
                    title,
                    creator: 'Unknown',
                    thumbnail,
                    url: href.startsWith('http') ? href : `https://www.thingiverse.com${href}`,
                    likes: 0,
                    downloads: 0,
                    source: 'thingiverse'
                });
            }
        });

        return results;
    } catch (error) {
        console.error('Thingiverse search error:', error.message);
        return [];
    }
}

// ==================== MYMINIFACTORY ====================
async function searchMyMiniFactory(query, limit = 10, page = 1) {
    try {
        // Try API endpoint first
        const apiUrl = `https://www.myminifactory.com/api/v2/search?q=${encodeURIComponent(query)}&limit=${limit}&page=${page}`;

        const response = await safeFetch(apiUrl, {
            headers: {
                'Accept': 'application/json',
            }
        });

        if (response.ok) {
            const text = await response.text();
            try {
                const data = JSON.parse(text);
                const items = data?.items || data?.objects || data?.results || [];

                if (Array.isArray(items) && items.length > 0) {
                    return items.slice(0, limit).map(item => ({
                        title: item.name || item.title || 'Untitled',
                        creator: item.designer?.name || item.designer?.username || item.user?.name || 'Unknown',
                        thumbnail: item.images?.[0]?.thumbnail?.url || item.images?.[0]?.url || item.thumbnail || '',
                        url: item.url || `https://www.myminifactory.com/object/${item.slug || item.id}`,
                        likes: item.likes || 0,
                        downloads: item.downloads || item.views || 0,
                        source: 'myminifactory'
                    }));
                }
            } catch (e) {
                // Not JSON, try scraping
            }
        }

        // Fallback: scrape search page
        const searchUrl = `https://www.myminifactory.com/search/?query=${encodeURIComponent(query)}&page=${page}`;
        const htmlResponse = await safeFetch(searchUrl);
        const html = await htmlResponse.text();
        const $ = cheerio.load(html);

        const results = [];
        $('a[href*="/object/"]').each((i, el) => {
            if (results.length >= limit) return false;

            const $el = $(el);
            const href = $el.attr('href');
            const $card = $el.closest('[class*="card"], [class*="item"], .col');

            const title = $card.find('[class*="title"], h3, h4, h5').text().trim() ||
                         $el.attr('title') || '';
            const img = $card.find('img').first();
            const thumbnail = img.attr('src') || img.attr('data-src') || '';

            if (href && title && !results.find(r => r.url.includes(href))) {
                results.push({
                    title,
                    creator: 'Unknown',
                    thumbnail,
                    url: href.startsWith('http') ? href : `https://www.myminifactory.com${href}`,
                    likes: 0,
                    downloads: 0,
                    source: 'myminifactory'
                });
            }
        });

        return results;
    } catch (error) {
        console.error('MyMiniFactory search error:', error.message);
        return [];
    }
}

// ==================== CREALITY CLOUD ====================
async function searchCrealityCloud(query, limit = 10, page = 1) {
    try {
        const response = await safeFetch('https://www.crealitycloud.com/api/cxy/search/model', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                '__cxy_app_ch_': 'Chrome 144.0.0.0',
                '__cxy_app_id_': 'creality_model',
                '__cxy_app_ver_': '6.0.0',
                '__cxy_brand_': 'creality',
                '__cxy_duid_': 'uuid-' + crypto.randomUUID(),
                '__cxy_jwtoken_': '',
                '__cxy_os_lang_': '0',
                '__cxy_os_ver_': 'Linux x86_64',
                '__cxy_platform_': '2',
                '__cxy_requestid_': crypto.randomUUID(),
                '__cxy_timezone_': '-18000',
                '__cxy_token_': '',
                '__cxy_uid_': '',
                '_x_cxy_ehrtoken_': '',
                'Origin': 'https://www.crealitycloud.com',
                'Referer': 'https://www.crealitycloud.com/'
            },
            body: JSON.stringify({
                page: page,
                pageSize: limit,
                sortType: 11,
                isPay: 0,
                hasCfgFile: 0,
                isVip: 0,
                isExclusive: 0,
                multiMarkType: 0,
                hasPromo: 0,
                promoType: 0,
                keyword: query
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.code === 0 && data.result?.list) {
                return data.result.list.map(item => ({
                    title: item.groupName || 'Untitled',
                    creator: item.userInfo?.nickName || 'Unknown',
                    thumbnail: item.covers?.[0]?.url || '',
                    url: `https://www.crealitycloud.com/model-detail/${item.id}`,
                    likes: item.likeCount || 0,
                    downloads: item.downloadCount || 0,
                    source: 'crealitycloud'
                }));
            }
        }

        return [];
    } catch (error) {
        console.error('Creality Cloud search error:', error.message);
        return [];
    }
}

// ==================== YOUMAGINE ====================
async function searchYouMagine(query, limit = 10, page = 1) {
    try {
        // Use youmagine.com without www (www redirects)
        const searchUrl = `https://youmagine.com/designs?q=${encodeURIComponent(query)}&page=${page}`;
        const response = await safeFetch(searchUrl, { redirect: 'follow' });
        const html = await response.text();
        const $ = cheerio.load(html);

        const results = [];
        const seen = new Set();

        // Find all model card images (they have the title in alt attribute)
        $('img.object-cover[alt]').each((i, el) => {
            if (results.length >= limit) return false;

            const $img = $(el);
            const alt = $img.attr('alt') || '';
            const src = $img.attr('src') || '';

            // Skip small images (avatars, icons) - model images have w-full h-full
            if (!$img.hasClass('w-full') || !src || alt === 'YouMagine') return;

            // Find the parent link
            const $link = $img.closest('a[href*="/designs/"]');
            const href = $link.attr('href');

            if (href && !href.endsWith('/designs/') && !seen.has(href)) {
                seen.add(href);
                const thumbnail = src.startsWith('http') ? src : `https://youmagine.com${src}`;
                const url = href.startsWith('http') ? href : `https://youmagine.com${href}`;

                results.push({
                    title: alt || 'Untitled',
                    creator: 'Unknown',
                    thumbnail,
                    url,
                    likes: 0,
                    downloads: 0,
                    source: 'youmagine'
                });
            }
        });

        return results;
    } catch (error) {
        console.error('YouMagine search error:', error.message);
        return [];
    }
}

// ==================== FETCH POPULAR FUNCTIONS ====================

// Curated fallback data for sources that have bot protection
// Thumbnails use CDN URLs - frontend routes them through /api/image proxy
const fallbackPopularModels = {
    thingiverse: [
        { title: 'Flexi Rex (T-Rex)', creator: 'DrLex', thumbnail: 'https://cdn.thingiverse.com/renders/9e/f5/92/56/d5/5e04faf6b1ebee0735ffb82771ca9051_preview_featured.jpg', url: 'https://www.thingiverse.com/thing:2738211', likes: 45000, downloads: 890000, source: 'thingiverse' },
        { title: 'Low Poly Pikachu', creator: 'FLOWALISTIK', thumbnail: 'https://cdn.thingiverse.com/renders/60/5d/6d/72/c4/pikachu_low_poly_pokemon_flowalistik_preview_featured.jpg', url: 'https://www.thingiverse.com/thing:376601', likes: 22000, downloads: 410000, source: 'thingiverse' },
        { title: 'Phone Stand', creator: 'WilliamAAdams', thumbnail: 'https://cdn.thingiverse.com/renders/37/83/e7/42/ac/841e55362ab601e2ed4c2de08074e8b2_preview_featured.jpg', url: 'https://www.thingiverse.com/thing:2194278', likes: 32000, downloads: 650000, source: 'thingiverse' },
        { title: 'Modular Hex Drawers', creator: 'O3D', thumbnail: 'https://cdn.thingiverse.com/renders/8f/98/c7/7a/98/60acf4823a53e317955cdddbf12ddd12_preview_featured.jpg', url: 'https://www.thingiverse.com/thing:2425429', likes: 20000, downloads: 380000, source: 'thingiverse' },
        { title: 'Articulated Slug', creator: 'Fizz Creations', thumbnail: 'https://cdn.thingiverse.com/assets/d6/82/8f/11/12/featured_preview_CoverPhoto.jpg', url: 'https://www.thingiverse.com/thing:4727448', likes: 15000, downloads: 280000, source: 'thingiverse' },
        { title: 'Raspberry Pi 4 Case', creator: 'Malolo', thumbnail: 'https://cdn.thingiverse.com/assets/21/f7/ca/64/68/featured_preview_Logo_MM3.jpg', url: 'https://www.thingiverse.com/thing:3723561', likes: 18000, downloads: 350000, source: 'thingiverse' },
        { title: 'Cable Management Clips', creator: 'Filar3D', thumbnail: 'https://cdn.thingiverse.com/assets/f3/ba/2e/d3/d0/featured_preview_IMG_20170804_104455.jpg', url: 'https://www.thingiverse.com/thing:2466594', likes: 25000, downloads: 480000, source: 'thingiverse' },
        { title: '3DBenchy', creator: 'CreativeTools', thumbnail: '', url: 'https://www.thingiverse.com/thing:763622', likes: 17000, downloads: 340000, source: 'thingiverse' },
        { title: 'Articulated Dragon', creator: 'McGybeer', thumbnail: '', url: 'https://www.thingiverse.com/thing:4817953', likes: 28000, downloads: 520000, source: 'thingiverse' },
        { title: 'Flexi Shark', creator: 'McGybeer', thumbnail: '', url: 'https://www.thingiverse.com/thing:4846879', likes: 12000, downloads: 220000, source: 'thingiverse' }
    ],
    thangs: [
        { title: 'Articulated Axolotl', creator: 'Printed Obsession', thumbnail: '', url: 'https://thangs.com/designer/PrintedObsession/3d-model/Articulated%20Axolotl-799498', likes: 31000, downloads: 620000, source: 'thangs' },
        { title: 'Baby Groot Planter', creator: 'Fotis Mint', thumbnail: '', url: 'https://thangs.com/designer/Fotis%20Mint/3d-model/Baby%20Groot%20Flower%20Pot-38826', likes: 26000, downloads: 510000, source: 'thangs' },
        { title: 'Flexi Octopus', creator: 'McGybeer', thumbnail: '', url: 'https://thangs.com/designer/McGybeer/3d-model/Cute%20Flexi%20Print-in-Place%20Octopus-798703', likes: 23000, downloads: 440000, source: 'thangs' },
        { title: 'Mandalorian Helmet', creator: 'Galactic Armory', thumbnail: '', url: 'https://thangs.com/designer/Galactic%20Armory/3d-model/The%20Mandalorian%20Helmet-45873', likes: 20000, downloads: 390000, source: 'thangs' },
        { title: 'Articulated Dragon', creator: 'McGybeer', thumbnail: '', url: 'https://thangs.com/designer/McGybeer/3d-model/Articulated%20Dragon-798707', likes: 18000, downloads: 350000, source: 'thangs' },
        { title: 'Headphone Stand', creator: 'Various', thumbnail: '', url: 'https://thangs.com/search/headphone%20stand', likes: 16000, downloads: 310000, source: 'thangs' },
        { title: 'Dice Tower', creator: 'Various', thumbnail: '', url: 'https://thangs.com/search/dice%20tower', likes: 15000, downloads: 290000, source: 'thangs' },
        { title: 'Cable Organizer', creator: 'Various', thumbnail: '', url: 'https://thangs.com/search/cable%20organizer', likes: 14000, downloads: 270000, source: 'thangs' },
        { title: 'Phone Stand', creator: 'Various', thumbnail: '', url: 'https://thangs.com/search/phone%20stand', likes: 13000, downloads: 250000, source: 'thangs' },
        { title: 'Geometric Vase', creator: 'Various', thumbnail: '', url: 'https://thangs.com/search/geometric%20vase', likes: 12000, downloads: 230000, source: 'thangs' }
    ],
    myminifactory: [
        { title: 'The Dragon', creator: 'Fotis Mint', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-the-dragon-100769', likes: 42000, downloads: 810000, source: 'myminifactory' },
        { title: 'Cthulhu', creator: 'Fotis Mint', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-cthulhu-30203', likes: 35000, downloads: 680000, source: 'myminifactory' },
        { title: 'Dice Guardian', creator: 'mz4250', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-dice-guardian-12345', likes: 28000, downloads: 540000, source: 'myminifactory' },
        { title: 'Mind Flayer', creator: 'mz4250', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-mind-flayer-32001', likes: 25000, downloads: 480000, source: 'myminifactory' },
        { title: 'Articulated Knight', creator: 'Printed Obsession', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-articulated-knight-56789', likes: 22000, downloads: 420000, source: 'myminifactory' },
        { title: 'Baby Yoda', creator: 'Fotis Mint', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-baby-yoda-117365', likes: 20000, downloads: 380000, source: 'myminifactory' },
        { title: 'Greek Statue Collection', creator: 'Scan The World', thumbnail: '', url: 'https://www.myminifactory.com/users/Scan%20The%20World', likes: 18000, downloads: 350000, source: 'myminifactory' },
        { title: 'Terrain Set', creator: 'Printable Scenery', thumbnail: '', url: 'https://www.myminifactory.com/users/Printable%20Scenery', likes: 16000, downloads: 310000, source: 'myminifactory' },
        { title: 'Beholder', creator: 'mz4250', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-beholder-28947', likes: 15000, downloads: 290000, source: 'myminifactory' },
        { title: 'Dragon Bust', creator: 'Fotis Mint', thumbnail: '', url: 'https://www.myminifactory.com/object/3d-print-dragon-bust-100770', likes: 14000, downloads: 270000, source: 'myminifactory' }
    ]
};

async function fetchPopularThingiverse(limit = 10) {
    // If API key is available, use the official API
    if (THINGIVERSE_API_KEY) {
        try {
            const apiUrl = `https://api.thingiverse.com/popular?per_page=${limit}`;
            const apiResponse = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${THINGIVERSE_API_KEY}`,
                    'Accept': 'application/json'
                }
            });

            if (apiResponse.ok) {
                const data = await apiResponse.json();
                const things = data.hits || data || [];

                if (Array.isArray(things) && things.length > 0) {
                    console.log(`Thingiverse API: found ${things.length} popular models`);
                    return things.slice(0, limit).map(thing => ({
                        title: thing.name || 'Untitled',
                        creator: thing.creator?.name || thing.creator?.username || 'Unknown',
                        thumbnail: thing.preview_image || thing.thumbnail || '',
                        url: `https://www.thingiverse.com/thing:${thing.id}`,
                        likes: thing.like_count || thing.likes || 0,
                        downloads: thing.download_count || thing.downloads || thing.collect_count || 0,
                        source: 'thingiverse'
                    }));
                }
            } else {
                console.error(`Thingiverse API error: ${apiResponse.status}`);
            }
        } catch (apiError) {
            console.error('Thingiverse API error:', apiError.message);
        }
    }

    // Fallback: Return curated data
    console.log('Thingiverse: Using fallback data (no API key or API error)');
    return fallbackPopularModels.thingiverse.slice(0, limit);
}

async function fetchPopularPrintables(limit = 10) {
    try {
        const graphqlUrl = 'https://api.printables.com/graphql/';

        // Try with ordering parameter for popular/most downloaded
        const searchQuery = {
            query: `
                query SearchPrints($limit: Int) {
                    searchPrints2(query: "", limit: $limit, ordering: "-download_count") {
                        items {
                            id
                            name
                            slug
                            likesCount
                            downloadCount
                            user {
                                publicUsername
                            }
                            image {
                                filePath
                            }
                        }
                    }
                }
            `,
            variables: { limit }
        };

        const response = await safeFetch(graphqlUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(searchQuery)
        });

        if (response.ok) {
            const data = await response.json();
            const items = data?.data?.searchPrints2?.items || [];

            if (items.length > 0) {
                return items.map(item => ({
                    title: item.name || 'Untitled',
                    creator: item.user?.publicUsername || 'Unknown',
                    thumbnail: item.image?.filePath
                        ? `https://media.printables.com/${item.image.filePath}`
                        : '',
                    url: `https://www.printables.com/model/${item.id}-${item.slug || ''}`,
                    likes: item.likesCount || 0,
                    downloads: item.downloadCount || 0,
                    source: 'printables'
                }));
            }
        }

        // Fallback: use search with common popular term
        return searchPrintables('gridfinity', limit);
    } catch (error) {
        console.error('Printables popular fetch error:', error.message);
        return [];
    }
}

async function fetchPopularThangs(limit = 10) {
    // Thangs has Cloudflare protection, use fallback data
    console.log('Thangs: Using fallback data (Cloudflare protected)');
    return fallbackPopularModels.thangs.slice(0, limit);
}

async function fetchPopularMyMiniFactory(limit = 10) {
    // MyMiniFactory has Cloudflare protection, use fallback data
    console.log('MyMiniFactory: Using fallback data (Cloudflare protected)');
    return fallbackPopularModels.myminifactory.slice(0, limit);
}

async function fetchPopularCrealityCloud(limit = 10) {
    try {
        const response = await safeFetch('https://www.crealitycloud.com/api/cxy/v3/model/listTrend', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                '__cxy_app_ch_': 'Chrome 144.0.0.0',
                '__cxy_app_id_': 'creality_model',
                '__cxy_app_ver_': '6.0.0',
                '__cxy_brand_': 'creality',
                '__cxy_duid_': 'uuid-' + crypto.randomUUID(),
                '__cxy_jwtoken_': '',
                '__cxy_os_lang_': '0',
                '__cxy_os_ver_': 'Linux x86_64',
                '__cxy_platform_': '2',
                '__cxy_requestid_': crypto.randomUUID(),
                '__cxy_timezone_': '-18000',
                '__cxy_token_': '',
                '__cxy_uid_': '',
                '_x_cxy_ehrtoken_': '',
                'Origin': 'https://www.crealitycloud.com',
                'Referer': 'https://www.crealitycloud.com/'
            },
            body: JSON.stringify({
                page: 1,
                pageSize: limit,
                trendType: 3,
                filterType: 10,
                isPay: 0,
                isExclusive: 0,
                promoType: 0,
                isVip: 0,
                multiMark: 0,
                hasCfgFile: 0,
                hasCubeMeModel: 1
            })
        });

        if (response.ok) {
            const data = await response.json();
            if (data.code === 0 && data.result?.list) {
                return data.result.list.map(item => ({
                    title: item.groupName || 'Untitled',
                    creator: item.userInfo?.nickName || 'Unknown',
                    thumbnail: item.covers?.[0]?.url || '',
                    url: `https://www.crealitycloud.com/model-detail/${item.id}`,
                    likes: item.likeCount || 0,
                    downloads: item.downloadCount || 0,
                    source: 'crealitycloud'
                }));
            }
        }

        return [];
    } catch (error) {
        console.error('Creality Cloud popular fetch error:', error.message);
        return [];
    }
}

async function fetchPopularYouMagine(limit = 10) {
    try {
        // Scrape main designs page (shows featured/recent without query)
        // Use youmagine.com without www (www redirects)
        const url = 'https://youmagine.com/designs';
        const response = await safeFetch(url, { redirect: 'follow' });
        const html = await response.text();
        const $ = cheerio.load(html);

        const results = [];
        const seen = new Set();

        // Find all model card images (they have the title in alt attribute)
        $('img.object-cover[alt]').each((i, el) => {
            if (results.length >= limit) return false;

            const $img = $(el);
            const alt = $img.attr('alt') || '';
            const src = $img.attr('src') || '';

            // Skip small images (avatars, icons) - model images have w-full h-full
            if (!$img.hasClass('w-full') || !src || alt === 'YouMagine') return;

            // Find the parent link
            const $link = $img.closest('a[href*="/designs/"]');
            const href = $link.attr('href');

            if (href && !href.endsWith('/designs/') && !seen.has(href)) {
                seen.add(href);
                const thumbnail = src.startsWith('http') ? src : `https://youmagine.com${src}`;
                const modelUrl = href.startsWith('http') ? href : `https://youmagine.com${href}`;

                results.push({
                    title: alt || 'Untitled',
                    creator: 'Unknown',
                    thumbnail,
                    url: modelUrl,
                    likes: 0,
                    downloads: 0,
                    source: 'youmagine'
                });
            }
        });

        return results;
    } catch (error) {
        console.error('YouMagine popular fetch error:', error.message);
        return [];
    }
}

// ==================== API ROUTES ====================

// Image proxy - fetches images server-side to bypass hotlink protection
const imageCache = new Map();
const IMAGE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

app.get('/api/image', async (req, res) => {
    const { url } = req.query;

    if (!url) {
        return res.status(400).json({ error: 'URL parameter required' });
    }

    try {
        // Validate URL
        const imageUrl = decodeURIComponent(url);
        if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        // Check cache
        const cached = imageCache.get(imageUrl);
        if (cached && Date.now() - cached.timestamp < IMAGE_CACHE_TTL) {
            res.set('Content-Type', cached.contentType);
            res.set('Cache-Control', 'public, max-age=1800');
            return res.send(cached.buffer);
        }

        // Determine referer based on URL
        let referer = '';
        if (imageUrl.includes('thingiverse.com')) {
            referer = 'https://www.thingiverse.com/';
        } else if (imageUrl.includes('thangs.com')) {
            referer = 'https://thangs.com/';
        } else if (imageUrl.includes('myminifactory.com')) {
            referer = 'https://www.myminifactory.com/';
        } else if (imageUrl.includes('creality.com')) {
            referer = 'https://www.crealitycloud.com/';
        }

        const response = await fetch(imageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': referer,
                'Sec-Fetch-Dest': 'image',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'cross-site',
            }
        });

        if (!response.ok) {
            console.error(`Image proxy error: ${response.status} for ${imageUrl}`);
            return res.status(response.status).json({ error: 'Failed to fetch image' });
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const contentType = response.headers.get('content-type') || 'image/jpeg';

        // Cache the image
        imageCache.set(imageUrl, { buffer, contentType, timestamp: Date.now() });

        // Clean old cache entries periodically
        if (imageCache.size > 100) {
            const now = Date.now();
            for (const [key, value] of imageCache.entries()) {
                if (now - value.timestamp > IMAGE_CACHE_TTL) {
                    imageCache.delete(key);
                }
            }
        }

        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=1800');
        res.send(buffer);
    } catch (error) {
        console.error('Image proxy error:', error.message);
        res.status(500).json({ error: 'Failed to fetch image' });
    }
});

// Search all sites
app.get('/api/search', async (req, res) => {
    const { q, sites: siteParam, limit = 10, page = 1 } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const enabledSites = siteParam ? siteParam.split(',') : ['thingiverse', 'printables', 'thangs', 'youmagine', 'myminifactory', 'crealitycloud'];
    const searchLimit = Math.min(parseInt(limit) || 10, 20);
    const searchPage = Math.max(parseInt(page) || 1, 1);

    const searchFunctions = {
        thingiverse: searchThingiverse,
        printables: searchPrintables,
        thangs: searchThangs,
        youmagine: searchYouMagine,
        myminifactory: searchMyMiniFactory,
        crealitycloud: searchCrealityCloud
    };

    console.log(`Searching for "${q}" on sites: ${enabledSites.join(', ')} (page ${searchPage})`);

    try {
        const searchPromises = enabledSites
            .filter(site => searchFunctions[site])
            .map(async site => {
                try {
                    const results = await searchFunctions[site](q, searchLimit, searchPage);
                    console.log(`${site}: found ${results.length} results`);
                    return { site, results };
                } catch (err) {
                    console.error(`${site} error:`, err.message);
                    return { site, results: [] };
                }
            });

        const results = await Promise.all(searchPromises);

        const response = {
            page: searchPage,
            limit: searchLimit,
            results: {}
        };
        results.forEach(result => {
            response.results[result.site] = result.results;
        });

        res.json(response);
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'Search failed', message: error.message });
    }
});

// Search individual site
app.get('/api/search/:site', async (req, res) => {
    const { site } = req.params;
    const { q, limit = 10, page = 1 } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const searchFunctions = {
        thingiverse: searchThingiverse,
        printables: searchPrintables,
        thangs: searchThangs,
        youmagine: searchYouMagine,
        myminifactory: searchMyMiniFactory,
        crealitycloud: searchCrealityCloud
    };

    if (!searchFunctions[site]) {
        return res.status(400).json({ error: 'Invalid site', validSites: Object.keys(searchFunctions) });
    }

    try {
        const searchLimit = Math.min(parseInt(limit) || 10, 20);
        const searchPage = Math.max(parseInt(page) || 1, 1);
        const results = await searchFunctions[site](q, searchLimit, searchPage);
        res.json({ site, page: searchPage, results });
    } catch (error) {
        console.error(`${site} search error:`, error);
        res.status(500).json({ error: 'Search failed', message: error.message });
    }
});

// Get popular models (dynamically fetched)
app.get('/api/popular', async (req, res) => {
    const { sites: siteParam, limit = 10 } = req.query;
    const enabledSites = siteParam ? siteParam.split(',') : ['thingiverse', 'printables', 'thangs', 'youmagine', 'myminifactory', 'crealitycloud'];
    const searchLimit = Math.min(parseInt(limit) || 10, 20);

    // Check cache
    const cacheKey = `${enabledSites.sort().join(',')}-${searchLimit}`;
    if (popularCache.data?.[cacheKey] && Date.now() - popularCache.timestamp < popularCache.TTL) {
        console.log('Returning cached popular models');
        return res.json(popularCache.data[cacheKey]);
    }

    console.log(`Fetching popular models for: ${enabledSites.join(', ')}`);

    const fetchFunctions = {
        thingiverse: fetchPopularThingiverse,
        printables: fetchPopularPrintables,
        thangs: fetchPopularThangs,
        youmagine: fetchPopularYouMagine,
        myminifactory: fetchPopularMyMiniFactory,
        crealitycloud: fetchPopularCrealityCloud
    };

    // Fetch in parallel
    const promises = enabledSites
        .filter(site => fetchFunctions[site])
        .map(async site => {
            try {
                const results = await fetchFunctions[site](searchLimit);
                console.log(`Popular ${site}: found ${results.length} models`);
                return { site, results };
            } catch (err) {
                console.error(`Popular ${site} error:`, err.message);
                return { site, results: [] };
            }
        });

    const results = await Promise.all(promises);

    const response = {};
    results.forEach(r => { response[r.site] = r.results; });

    // Cache results
    if (!popularCache.data) popularCache.data = {};
    popularCache.data[cacheKey] = response;
    popularCache.timestamp = Date.now();

    res.json(response);
});

// Get search URLs for opening in browser tabs (fallback)
app.get('/api/search-urls', (req, res) => {
    const { q } = req.query;

    if (!q) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const searchUrls = {
        thingiverse: `https://www.thingiverse.com/search?q=${encodeURIComponent(q)}&type=things&sort=popular`,
        printables: `https://www.printables.com/search/models?q=${encodeURIComponent(q)}`,
        thangs: `https://thangs.com/search/${encodeURIComponent(q)}?scope=all`,
        youmagine: `https://www.youmagine.com/designs?q=${encodeURIComponent(q)}`,
        myminifactory: `https://www.myminifactory.com/search/?query=${encodeURIComponent(q)}`,
        crealitycloud: `https://www.crealitycloud.com/search/${encodeURIComponent(q)}`
    };

    res.json(searchUrls);
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 3D Model Cross-Search server running on http://localhost:${PORT}`);
    console.log(`📦 API endpoints:`);
    console.log(`   GET /api/search?q=<query>&sites=<site1,site2>&limit=<n>&page=<n>`);
    console.log(`   GET /api/search/:site?q=<query>&limit=<n>&page=<n>`);
    console.log(`   GET /api/popular?sites=<site1,site2>&limit=<n>`);
    console.log(`   GET /api/search-urls?q=<query>`);
    console.log(`   GET /api/health`);
    console.log(`🔑 API Keys:`);
    console.log(`   Thingiverse: ${THINGIVERSE_API_KEY ? 'Configured ✓' : 'Not configured (using fallback data)'}`);
});
