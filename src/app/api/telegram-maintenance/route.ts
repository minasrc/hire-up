import pg from 'pg';
import { handleTelegramMaintenance, telegramMaintenancePoolOptions } from '@/lib/telegram-maintenance';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';
let pool: pg.Pool | undefined;

export async function GET(request: Request) {
    return handleTelegramMaintenance(request, {
        secret: process.env.TELEGRAM_MAINTENANCE_SECRET,
        getPool() {
            const connectionString = process.env.TELEGRAM_MAINTENANCE_DATABASE_URL;
            if (!connectionString) return null;
            pool ??= new pg.Pool(telegramMaintenancePoolOptions(connectionString, process.env.TELEGRAM_MAINTENANCE_DATABASE_CA_CERT));
            return pool;
        },
    });
}
