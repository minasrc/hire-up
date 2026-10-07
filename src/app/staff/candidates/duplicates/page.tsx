import { listCandidateDuplicateReviews } from '@/lib/duplicate-review-operations';
import { StaffAuthorizationError } from '@/lib/staff-authorization';
import { requireStaffVerified } from '@/lib/staff-gate.server';
import { DuplicateReviewsBrowser } from './reviews-browser';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Duplicate review · Agora staff' };

type ReviewStatus = 'pending' | 'same_person' | 'different_people';

export default async function DuplicateReviewsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string }>;
}) {
    const gate = await requireStaffVerified();
    const requested = (await searchParams).status;
    const status: ReviewStatus = requested === 'same_person'
        || requested === 'different_people' ? requested : 'pending';
    let reviews = null;
    try {
        const result = await listCandidateDuplicateReviews(
            gate.pool, gate.identity, gate.organizationId, { status });
        reviews = result?.reviews ?? [];
    } catch (error) {
        if (error instanceof StaffAuthorizationError && error.code === 'FORBIDDEN') {
            reviews = null;
        } else {
            throw error;
        }
    }
    if (reviews === null) {
        return (
            <section className="mx-auto w-full max-w-5xl">
                <h1 className="text-[26px] font-medium text-foreground">Duplicate review</h1>
                <p className="mt-4 text-sm text-muted-foreground">
                    This view requires candidate read and duplicate review permissions.
                </p>
            </section>
        );
    }
    return <DuplicateReviewsBrowser key={status} reviews={reviews} status={status} />;
}
