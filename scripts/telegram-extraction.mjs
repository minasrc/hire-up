import { main } from '../services/telegram-extraction-worker/cli.mjs';
import { verifyProxyModel, providerBaseUrl, providerTokenFile } from './telegram-proxy.mjs';

try {
    process.env.TELEGRAM_EXTRACTION_PROVIDER_BASE_URL = providerBaseUrl;
    process.env.TELEGRAM_EXTRACTION_PROVIDER_MODEL = await verifyProxyModel();
    process.env.TELEGRAM_EXTRACTION_PROVIDER_TOKEN_FILE = providerTokenFile;
    await main();
} catch (error) {
    console.error(error.code ?? 'EXTRACTION_START_FAILED');
    if (!error.code) console.error(error.message);
    process.exitCode = 1;
}
