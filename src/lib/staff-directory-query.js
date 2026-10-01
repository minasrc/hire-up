export const DIRECTORY_PAGE_SIZE = 50;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value) => typeof value === 'string' ? value : '';
const option = (value, values, fallback) => values.includes(value) ? value : fallback;
const page = (value) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) return 1;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= 1000000 ? number : 1;
};

// Treat URLs as untrusted input and share canonical defaults across all reads.
export function clientDirectoryQuery(input = {}) {
    return {
        query: text(input.q).trim().slice(0, 200),
        status: option(input.status, ['all', 'active', 'draft'], 'all'),
        page: page(input.page),
    };
}

export function jobDirectoryQuery(input = {}) {
    return {
        query: text(input.q).trim().slice(0, 200),
        clientId: uuid.test(text(input.client)) ? input.client : null,
        state: option(input.state,
            ['all', 'draft', 'published', 'listed', 'unlisted', 'withdrawn', 'archived'], 'all'),
        intake: option(input.intake, ['all', 'open', 'closed'], 'all'),
        mine: input.mine === '1' || input.mine === 'true' || input.owner === 'me',
        sortBy: option(input.sort, ['title', 'client', 'publication'], 'title'),
        sortDirection: input.dir === 'desc' ? 'desc' : 'asc',
        page: page(input.page),
    };
}
