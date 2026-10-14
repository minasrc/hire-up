const numberWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const experiencePattern = new RegExp(`\\b(?:(at least|at most|more than|less than|minimum|maximum|over|under|exactly)\\s+)?(\\d+(?:\\.\\d+)?|${numberWords.join('|')})\\s*(\\+)?\\s*(?:years?|yrs?)\\b`, 'i');
const ignored = new Set('a an the and with of in for who has have having is are to find show me candidate candidates experience experienced work working total professional exactly at least most minimum maximum over under more less than'.split(' '));

export function candidateSearchIntent(query) {
    const text = query.trim().toLowerCase();
    const match = text.match(experiencePattern);
    let experience = null;
    if (match) {
        const years = numberWords.includes(match[2]) ? numberWords.indexOf(match[2]) : Number(match[2]);
        const comparison = match[3] || ['at least', 'minimum'].includes(match[1]) ? 'gte'
            : ['at most', 'maximum'].includes(match[1]) ? 'lte'
            : ['more than', 'over'].includes(match[1]) ? 'gt'
            : ['less than', 'under'].includes(match[1]) ? 'lt' : 'eq';
        experience = { years, comparison };
    }
    const remaining = match ? text.replace(match[0], '') : text;
    const terms = [...new Set((remaining.match(/[\p{L}\p{N}+#.]+/gu) ?? [])
        .filter(term => !ignored.has(term))
        .map(term => term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term))];
    return { terms, experience };
}

// Cosine similarity is a relevance signal, not a guarantee that a profile matches.
// Compare against the best score for the whole query, including on later pages.
export function relevantCandidateResults(results, bestScore = null) {
    const scored = results.filter(row => row.sourceType === 'candidate' && Number.isFinite(row.score));
    const best = bestScore ?? Math.max(0, ...scored.map(row => row.score));
    return scored.filter(row => row.score >= Math.max(0.2, best * 0.9));
}
