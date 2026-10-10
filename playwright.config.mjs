import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { assertNonproductionTestEnvironment } from './tests/support/nonproduction.js';

loadEnv({ path: '.env.local', quiet: true });
assertNonproductionTestEnvironment();
const serverMode = process.env.E2E_SERVER_MODE ?? 'development';
if (!['development', 'production'].includes(serverMode)) {
    throw new Error('E2E_SERVER_MODE must be development or production.');
}

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    workers: 2,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: 'http://127.0.0.1:3000',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: serverMode === 'production'
            ? 'npm run start -- --hostname 127.0.0.1'
            : 'npm run dev -- --hostname 127.0.0.1',
        url: 'http://127.0.0.1:3000/jobs',
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
            ...process.env,
            NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
            NEXTAUTH_URL: process.env.NEXTAUTH_URL || 'http://127.0.0.1:3000',
            NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET || 'local-playwright-secret',
        },
    },
    projects: [
        { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'mobile-chromium', use: { ...devices['Pixel 5'] } },
    ],
});
