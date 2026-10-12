// Server database configuration only: never import this module into client code.
export function databaseTlsConnectionOptions(connectionString, caCertificate) {
    if (caCertificate === undefined || caCertificate === '') return { connectionString };
    // pg parses URL SSL settings after explicit options. Remove them so they
    // cannot replace the trusted CA or disable certificate/hostname checks.
    let url;
    try {
        url = new URL(connectionString);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
    } catch {
        // URL parser errors contain the input, including database credentials.
        // Do not attach the original exception as a cause.
        throw new Error('Invalid database URL.');
    }
    for (const key of [...url.searchParams.keys()]) {
        if (key.toLowerCase().startsWith('ssl') || key.toLowerCase() === 'uselibpqcompat') url.searchParams.delete(key);
    }
    return { connectionString: url.toString(), ssl: { ca: caCertificate, rejectUnauthorized: true } };
}
