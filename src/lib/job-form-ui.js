// Keep display formatting separate from the decimal strings stored by the API.
export function compensationValue(value) {
    return String(value ?? '').trim().replace(/^[A-Za-z]{3}\s+/, '').replace(/[\s,\p{Sc}]/gu, '');
}

export function compensationDisplay(value) {
    const raw = compensationValue(value);
    if (!/^\d*(\.\d*)?$/.test(raw)) return raw;
    const [integer, fraction] = raw.split('.');
    return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        + (fraction !== undefined ? `.${fraction}` : '');
}

/** @returns {Record<string, string>} */
export function friendlyJobErrors(errors, fields = {}) {
    /** @type {Record<string, string>} */
    const result = {};
    for (const [path, reason] of Object.entries(errors ?? {})) {
        const field = path.split(/[\[.]/)[0];
        let message;
        if (field === 'locations' || field === 'remoteRegions') {
            const index = Number(path.match(/\[(\d+)\]/)?.[1]);
            const value = fields[field]?.[index];
            message = String(reason).includes('20') ? 'Choose up to 20 locations.'
                : String(reason).includes('duplicate') ? 'This location is already included.'
                : value ? `Choose a location from the suggestions for “${value}”.`
                : 'Choose a location from the suggestions.';
        } else if (field === 'compensationMin' || field === 'compensationMax') {
            message = String(reason).includes('greater than')
                ? `Maximum must be at least ${compensationDisplay(fields.compensationMin)}.`
                : 'Enter a positive amount or zero, with up to two decimal places.';
        } else if (field === 'currency') message = 'Choose a currency.';
        else if (field === 'payPeriod') message = 'Choose a pay period.';
        else if (field === 'title') message = 'Enter a job title of up to 200 characters.';
        else if (field === 'employmentType') message = 'Choose an employment type.';
        else if (field === 'workplaceMode') message = 'Choose how this role will be worked: onsite, hybrid or remote.';
        else if (field === 'clientId') message = 'Choose an active client.';
        else if (field === 'descriptionDocument') message = 'Check the description. Try removing the last pasted content or simplifying its formatting.';
        else if (field === 'bonuses') message = String(reason).includes('duplicate')
            ? 'Use each bonus type only once.'
            : 'Add a bonus type and details of up to 2,000 characters. You can include up to five bonuses.';
        else message = 'Check this entry and try again.';
        if (!result[field]) result[field] = message;
    }
    return result;
}

// A place can describe both the office and remote eligibility; show it once.
export function jobPreviewLocations(locations = [], remoteRegions = [], workplaceMode) {
    const values = workplaceMode === 'onsite' ? locations : [...locations, ...remoteRegions];
    const seen = new Set();
    return values.filter((value) => {
        const key = value.trim().toLocaleLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
