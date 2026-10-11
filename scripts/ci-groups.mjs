// Logical suites stay independently selectable; compatible suites share setup.
export const GROUPS = {
    'database-checks': ['database-staff-authorization', 'database-privacy-foundation',
        'database-privacy-operations', 'database-client-jobs', 'database-staff-totp'],
    'staff-workflows': ['staff-workspace', 'duplicate-review', 'worker-pairing'],
    'telegram-workflows': ['telegram-intake', 'telegram-connection', 'telegram-history',
        'telegram-extraction', 'telegram-cv', 'telegram-retention'],
    'search-workflows': ['profile-search', 'cv-analysis', 'cv-search'],
};

export const RUNNERS = {
    quality: ['quality'],
    'browser-tests': ['browser-tests'],
    'database-foundation': ['database-foundation'],
    ...GROUPS,
};

export const COMMANDS = {
    'database-staff-authorization': ['test:db:staff'],
    'database-privacy-foundation': ['test:db:privacy'],
    'database-privacy-operations': ['test:db:privacy-operations'],
    'database-client-jobs': ['test:db:client-jobs'],
    'database-staff-totp': ['test:db:totp'],
    'staff-workspace': ['test:staff-workspace', 'test:db:candidate-upload'],
    'duplicate-review': ['test:duplicate-review'],
    'worker-pairing': ['test:worker-pairing'],
    'telegram-intake': ['test:telegram-intake'],
    'telegram-connection': ['test:telegram-connection'],
    'telegram-history': ['test:telegram-history'],
    'telegram-extraction': ['test:telegram-extraction'],
    'telegram-cv': ['test:telegram-cv'],
    'telegram-retention': ['test:telegram-retention'],
    'profile-search': ['test:profile-search'],
    'cv-analysis': ['test:cv-analysis'],
    'cv-search': ['test:cv-search'],
};

export function selectRunners(selection) {
    return Object.fromEntries(Object.entries(RUNNERS).map(([runner, suites]) =>
        [runner, suites.some(suite => selection[suite])]));
}

export function validateResults(results) {
    if (results.plan?.result !== 'success') throw new Error('CI selection failed');
    const selection = JSON.parse(results.plan.outputs.selection);
    const known = Object.values(RUNNERS).flat();
    if (!selection || Object.keys(selection).length !== known.length
        || known.some(suite => typeof selection[suite] !== 'boolean')) {
        throw new Error('Invalid CI selection');
    }
    for (const [runner, required] of Object.entries(selectRunners(selection))) {
        if (required && results[runner]?.result !== 'success') {
            throw new Error(`Required runner ${runner}: ${results[runner]?.result ?? 'missing'}`);
        }
    }
}
